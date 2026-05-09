import fs from 'fs';
import pLimit from 'p-limit';
import { config } from '../config';
import { logger } from '../utils/logger';
import { getDatabase, Episode } from '../database';
import { parseFeed } from '../rss';
import { downloadAudio } from '../audio';
import { transcribeAudio } from '../transcription';
import { analyzeContent } from '../analysis';
import { generateMarkdown, saveMarkdown, MarkdownInput } from '../markdown';

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
  const useDashScopeTranscription = config.transcriptionProvider === 'dashscope';

  try {
    let transcription: { text: string; language: string; duration?: number };

    if (useDashScopeTranscription) {
      // DashScope Paraformer: 直接传 URL，跳过下载/压缩/分割
      logger.info('Step 1/4: Skipping download (DashScope uses URL directly)');
      logger.info('Step 2/4: Transcribing audio via Paraformer');
      transcription = await transcribeAudio('', episode.audio_url);
      logMemory('after transcription');
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
