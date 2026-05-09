import fs from 'fs';
import path from 'path';
import pLimit from 'p-limit';
import { config } from '../config';
import { logger } from '../utils/logger';
import { getDatabase, Episode } from '../database';
import { parseFeed } from '../rss';
import { downloadAudio, preprocessForAsr, TEMP_ASR_DIR, hasFFmpeg } from '../audio';
import { transcribeAudio } from '../transcription';
import { analyzeContent } from '../analysis';
import { generateMarkdown, saveMarkdown, MarkdownInput } from '../markdown';

// ASR 预处理参数（环境变量可覆盖）：
// 设 ASR_SPEED_FACTOR=1.0 完全关闭预处理，恢复直接传 RSS URL
// 默认 2.0x：节省 50%+ ASR 时长成本，准确率小幅下降可接受
const ASR_SPEED_FACTOR = parseFloat(process.env.ASR_SPEED_FACTOR || '2.0');
const ASR_SKIP_INTRO_SEC = parseInt(process.env.ASR_SKIP_INTRO_SEC || '60', 10);
const ASR_SKIP_OUTRO_SEC = parseInt(process.env.ASR_SKIP_OUTRO_SEC || '30', 10);

export interface ProcessingResult {
  status: 'success' | 'failed' | 'skipped';
  episodeId: number;
  episodeTitle: string;
  markdownPath?: string;
  error?: string;
  durationMs: number;
}

export async function processEpisode(
  podcastName: string,
  episode: Episode
): Promise<ProcessingResult> {
  const startTime = Date.now();
  const db = getDatabase();

  // Check if already processed
  const existing = db.getAnalysisResult(episode.id);
  if (existing) {
    return {
      status: 'skipped',
      episodeId: episode.id,
      episodeTitle: episode.title,
      durationMs: Date.now() - startTime,
    };
  }

  if (!episode.audio_url) {
    return {
      status: 'failed',
      episodeId: episode.id,
      episodeTitle: episode.title,
      error: 'No audio URL',
      durationMs: Date.now() - startTime,
    };
  }

  db.updateEpisodeStatus(episode.id, 'processing');
  logger.info(`Processing episode: ${episode.title}`, { episodeId: episode.id });

  let audioPath: string | null = null;
  let preprocessedPath: string | null = null;  // ASR 预处理后的文件，转录完后清理
  const useDashScopeTranscription = config.transcriptionProvider === 'dashscope';

  try {
    let transcription: { text: string; language: string; duration?: number };

    if (useDashScopeTranscription) {
      const shouldPreprocess = ASR_SPEED_FACTOR > 1.0 && hasFFmpeg();

      if (shouldPreprocess) {
        logger.info(`Step 1/4: Downloading + preprocessing audio (speed=${ASR_SPEED_FACTOR}x, skipIntro=${ASR_SKIP_INTRO_SEC}s, skipOutro=${ASR_SKIP_OUTRO_SEC}s, silence-removed)`);
        audioPath = await downloadAudio(episode.audio_url, config.storage.tempDir);
        logMemory('after download');

        preprocessedPath = preprocessForAsr(audioPath, TEMP_ASR_DIR, {
          speedFactor: ASR_SPEED_FACTOR,
          skipIntroSec: ASR_SKIP_INTRO_SEC,
          skipOutroSec: ASR_SKIP_OUTRO_SEC,
        });

        // 自托管 URL 给 Paraformer
        const baseUrl = process.env.RAILWAY_PUBLIC_DOMAIN
          ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
          : 'https://podcast-digest-production.up.railway.app';
        const filename = path.basename(preprocessedPath);
        const preprocessedUrl = `${baseUrl}/api/temp-audio/${filename}`;

        logger.info('Step 2/4: Transcribing preprocessed audio via Paraformer', { url: preprocessedUrl });
        transcription = await transcribeAudio('', preprocessedUrl);
        logMemory('after transcription');
      } else {
        // 关闭预处理：直接走 RSS URL
        logger.info('Step 1/4: Skipping preprocessing (DashScope uses URL directly)');
        logger.info('Step 2/4: Transcribing audio via Paraformer');
        transcription = await transcribeAudio('', episode.audio_url);
        logMemory('after transcription');
      }
    } else {
      // OpenAI Whisper: 需要先下载再转录
      logger.info('Step 1/4: Downloading audio');
      audioPath = await downloadAudio(episode.audio_url, config.storage.tempDir);
      logMemory('after download');

      logger.info('Step 2/4: Transcribing audio via Whisper');
      transcription = await transcribeAudio(audioPath);
      logMemory('after transcription');
    }

    if (!transcription.text || transcription.text.length < 50) {
      throw new Error('Transcription result too short or empty');
    }

    // Step 3: Analyze content
    logger.info('Step 3/4: Analyzing content');
    const analysis = await analyzeContent(transcription.text, episode.title, podcastName);
    logMemory('after analysis');

    // Step 4: Generate Markdown
    logger.info('Step 4/4: Generating Markdown');
    const markdownInput: MarkdownInput = {
      podcastName,
      episodeTitle: episode.title,
      publishedAt: episode.published_at,
      durationSeconds: episode.duration_seconds || undefined,
      audioUrl: episode.audio_url,
      analysis,
    };
    const markdown = generateMarkdown(markdownInput);
    const mdPath = saveMarkdown(markdown, podcastName, episode.published_at, config.storage.summariesDir);

    // Save to database
    // key_points: keyPoints (objects with title+detail)
    // arguments: keywords (repurposed column)
    // knowledge_points: fullRecap (repurposed column)
    db.saveAnalysisResult({
      episode_id: episode.id,
      summary: analysis.summary,
      key_points: JSON.stringify(analysis.keyPoints),
      arguments: JSON.stringify(analysis.keywords),
      knowledge_points: analysis.fullRecap,
      transcript: transcription.text,
      markdown_path: mdPath,
    });
    db.updateEpisodeStatus(episode.id, 'completed');

    const durationMs = Date.now() - startTime;
    logger.info(`Episode processed successfully`, {
      episodeId: episode.id,
      title: episode.title,
      durationMs,
      markdownPath: mdPath,
    });

    return {
      status: 'success',
      episodeId: episode.id,
      episodeTitle: episode.title,
      markdownPath: mdPath,
      durationMs,
    };
  } catch (error) {
    db.updateEpisodeStatus(episode.id, 'failed');
    const durationMs = Date.now() - startTime;
    logger.error(`Episode processing failed`, {
      episodeId: episode.id,
      title: episode.title,
      error: (error as Error).message,
      durationMs,
    });

    return {
      status: 'failed',
      episodeId: episode.id,
      episodeTitle: episode.title,
      error: (error as Error).message,
      durationMs,
    };
  } finally {
    // Cleanup downloaded audio
    if (audioPath && fs.existsSync(audioPath)) {
      try { fs.unlinkSync(audioPath); } catch {}
    }
    // Cleanup ASR-preprocessed audio (Paraformer 已转录完成)
    if (preprocessedPath && fs.existsSync(preprocessedPath)) {
      try { fs.unlinkSync(preprocessedPath); } catch {}
    }
  }
}

export async function refreshAndProcessPodcast(
  podcastId: number,
  options: { useTimeWindow?: boolean; limit?: number } = {}
): Promise<ProcessingResult[]> {
  const { useTimeWindow = false, limit: episodeLimit = 5 } = options;
  const db = getDatabase();
  const podcast = db.getPodcastById(podcastId);
  if (!podcast) throw new Error(`Podcast not found: ${podcastId}`);

  logger.info(`Refreshing podcast: ${podcast.name}`, { rssUrl: podcast.rss_url });

  // Parse feed and add new episodes
  const feed = await parseFeed(podcast.rss_url);
  let newCount = 0;
  for (const ep of feed.episodes) {
    const added = db.addEpisode({
      podcast_id: podcast.id,
      guid: ep.guid,
      title: ep.title,
      description: ep.description,
      audio_url: ep.audioUrl,
      audio_format: ep.audioFormat,
      duration_seconds: ep.durationSeconds,
      published_at: ep.publishedAt,
      file_size: ep.fileSize,
    });
    if (added) newCount++;
  }
  logger.info(`Feed refreshed: ${newCount} new episodes`, { podcastId });

  // Get episodes to process:
  // - Manual trigger: all pending episodes (most recent N)
  // - Scheduled task: only episodes within the time window (last 24h)
  const episodes = useTimeWindow
    ? db.getNewEpisodes(podcast.id, config.processing.updateWindowHours)
    : db.getPendingEpisodesByPodcast(podcast.id, episodeLimit);

  logger.info(`Found ${episodes.length} episodes to process`, {
    podcastId, useTimeWindow, count: episodes.length,
  });

  const results: ProcessingResult[] = [];
  for (const episode of episodes) {
    const result = await processEpisode(podcast.name, episode);
    results.push(result);
  }

  return results;
}

export async function runFullPipeline(): Promise<{
  taskLogId: number;
  results: ProcessingResult[];
}> {
  const db = getDatabase();
  const taskLogId = db.createTaskLog('full_pipeline');

  logger.info('Starting full pipeline');

  const podcasts = db.getActivePodcasts();
  const limit = pLimit(config.processing.maxConcurrentFeeds);
  const allResults: ProcessingResult[] = [];

  try {
    // Refresh all feeds concurrently
    const refreshPromises = podcasts.map(podcast =>
      limit(async () => {
        try {
          const results = await refreshAndProcessPodcast(podcast.id, { useTimeWindow: true });
          return results;
        } catch (error) {
          logger.error(`Pipeline failed for podcast: ${podcast.name}`, {
            error: (error as Error).message,
          });
          return [];
        }
      })
    );

    const resultArrays = await Promise.all(refreshPromises);
    for (const results of resultArrays) {
      allResults.push(...results);
    }

    const succeeded = allResults.filter(r => r.status === 'success').length;
    const failed = allResults.filter(r => r.status === 'failed').length;

    // Collect error details from failed episodes for debugging
    const failedDetails = allResults
      .filter(r => r.status === 'failed' && r.error)
      .map(r => `[${r.episodeTitle}] ${r.error}`)
      .join('\n');

    db.updateTaskLog(taskLogId, {
      status: failed > 0 && succeeded === 0 ? 'failed' : 'completed',
      total_episodes: allResults.length,
      processed_episodes: succeeded,
      failed_episodes: failed,
      error_details: failedDetails || undefined,
    });

    logger.info('Full pipeline completed', {
      total: allResults.length,
      succeeded,
      failed,
      skipped: allResults.filter(r => r.status === 'skipped').length,
    });
  } catch (error) {
    db.updateTaskLog(taskLogId, {
      status: 'failed',
      error_details: (error as Error).message,
    });
    throw error;
  }

  return { taskLogId, results: allResults };
}

function logMemory(context: string): void {
  const usage = process.memoryUsage();
  logger.debug(`Memory ${context}`, {
    heapUsedMB: Math.round(usage.heapUsed / 1024 / 1024),
    heapTotalMB: Math.round(usage.heapTotal / 1024 / 1024),
    rssMB: Math.round(usage.rss / 1024 / 1024),
  });
}
