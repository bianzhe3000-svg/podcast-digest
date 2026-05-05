import { Router, Request, Response } from 'express';
import { config } from '../config';
import { getDatabase } from '../database';
import { searchPodcasts, parseOPML, parseFeed, validateFeed } from '../rss';
import { processEpisode, refreshAndProcessPodcast, runFullPipeline } from '../pipeline/processor';
import { startScheduler, stopScheduler, getSchedulerStatus, triggerManualRun, triggerEmailDigest } from '../scheduler';
import { sendDailyDigest, testEmailConnection, generateAndSaveDigest } from '../email';
import { testTts } from '../audio/dialogue';
import { listMarkdownFiles, listMarkdownFilesWithMeta, readMarkdown } from '../markdown';
import { exportToPdf } from '../markdown/pdf';
import { logger } from '../utils/logger';
import { AUDIO_DIR } from '../audio/dialogue';
import OpenAI from 'openai';
import path from 'path';
import fs from 'fs';

const router = Router();

// Helper for Express 5 param types
function param(req: Request, name: string): string {
  const val = req.params[name];
  return Array.isArray(val) ? val[0] : val || '';
}

// === Podcasts ===

router.get('/podcasts', (_req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const podcasts = db.getAllPodcasts();
    res.json({ success: true, data: podcasts });
  } catch (error) {
    res.status(500).json({ success: false, error: (error as Error).message });
  }
});

router.post('/podcasts', async (req: Request, res: Response) => {
  try {
    const { rssUrl, name } = req.body;
    if (!rssUrl) {
      res.status(400).json({ success: false, error: 'RSS URL is required' });
      return;
    }

    const db = getDatabase();
    const existing = db.getPodcastByUrl(rssUrl);
    if (existing) {
      res.status(409).json({ success: false, error: '该播客已存在' });
      return;
    }

    // Parse feed to get metadata
    const feed = await parseFeed(rssUrl);
    const podcast = db.addPodcast({
      name: name || feed.title,
      rss_url: rssUrl,
      description: feed.description,
      author: feed.author,
      image_url: feed.imageUrl,
      language: feed.language,
      category: feed.category,
    });

    // Add episodes
    let episodeCount = 0;
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
      if (added) episodeCount++;
    }

    res.json({ success: true, data: { ...podcast, episodeCount } });
  } catch (error) {
    logger.error('Add podcast failed', { error: (error as Error).message });
    res.status(500).json({ success: false, error: (error as Error).message });
  }
});

router.put('/podcasts/:id', (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const id = parseInt(param(req, 'id'), 10);
    db.updatePodcast(id, req.body);
    const podcast = db.getPodcastById(id);
    res.json({ success: true, data: podcast });
  } catch (error) {
    res.status(500).json({ success: false, error: (error as Error).message });
  }
});

router.delete('/podcasts/:id', (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    db.deletePodcast(parseInt(param(req, 'id'), 10));
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: (error as Error).message });
  }
});

router.get('/podcasts/search', async (req: Request, res: Response) => {
  try {
    const query = String(req.query.q || '');
    if (!query) {
      res.status(400).json({ success: false, error: 'Query parameter q is required' });
      return;
    }
    const results = await searchPodcasts(query);
    res.json({ success: true, data: results });
  } catch (error) {
    res.status(500).json({ success: false, error: (error as Error).message });
  }
});

router.post('/podcasts/validate', async (req: Request, res: Response) => {
  try {
    const { rssUrl } = req.body;
    if (!rssUrl) {
      res.status(400).json({ success: false, error: 'RSS URL is required' });
      return;
    }
    const result = await validateFeed(rssUrl);
    res.json({ success: true, data: result });
  } catch (error) {
    res.status(500).json({ success: false, error: (error as Error).message });
  }
});

router.post('/podcasts/import-opml', (req: Request, res: Response) => {
  try {
    const { content } = req.body;
    if (!content) {
      res.status(400).json({ success: false, error: 'OPML content is required' });
      return;
    }
    const feeds = parseOPML(content);
    res.json({ success: true, data: feeds });
  } catch (error) {
    res.status(500).json({ success: false, error: (error as Error).message });
  }
});

// === Episodes ===

router.get('/podcasts/:id/episodes', (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const podcastId = parseInt(param(req, 'id'), 10);
    const limit = parseInt(String(req.query.limit || ''), 10) ||50;
    const episodes = db.getEpisodesByPodcast(podcastId, limit);
    res.json({ success: true, data: episodes });
  } catch (error) {
    res.status(500).json({ success: false, error: (error as Error).message });
  }
});

router.post('/podcasts/:id/refresh', async (req: Request, res: Response) => {
  try {
    const podcastId = parseInt(param(req, 'id'), 10);
    const db = getDatabase();
    const podcast = db.getPodcastById(podcastId);
    if (!podcast) {
      res.status(404).json({ success: false, error: 'Podcast not found' });
      return;
    }

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

    res.json({ success: true, data: { newEpisodes: newCount, totalEpisodes: feed.episodes.length } });
  } catch (error) {
    res.status(500).json({ success: false, error: (error as Error).message });
  }
});

router.post('/podcasts/:id/process', (req: Request, res: Response) => {
  try {
    const podcastId = parseInt(param(req, 'id'), 10);
    const db = getDatabase();
    const podcast = db.getPodcastById(podcastId);
    if (!podcast) {
      res.status(404).json({ success: false, error: 'Podcast not found' });
      return;
    }

    // Start processing in background, return immediately
    const taskLogId = db.createTaskLog(`process_podcast_${podcast.name}`);
    res.json({ success: true, data: { message: '处理任务已启动', taskLogId, podcastName: podcast.name } });

    // Run async in background
    refreshAndProcessPodcast(podcastId).then(results => {
      const succeeded = results.filter(r => r.status === 'success').length;
      const failed = results.filter(r => r.status === 'failed').length;
      db.updateTaskLog(taskLogId, {
        status: failed > 0 && succeeded === 0 ? 'failed' : 'completed',
        total_episodes: results.length,
        processed_episodes: succeeded,
        failed_episodes: failed,
      });
      logger.info(`Background processing done for ${podcast.name}`, { succeeded, failed });
    }).catch(error => {
      db.updateTaskLog(taskLogId, {
        status: 'failed',
        error_details: (error as Error).message,
      });
      logger.error(`Background processing failed for ${podcast.name}`, { error: (error as Error).message });
    });
  } catch (error) {
    res.status(500).json({ success: false, error: (error as Error).message });
  }
});

// === Episode Analysis ===

router.get('/episodes/:id/analysis', (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const episodeId = parseInt(param(req, 'id'), 10);
    const result = db.getAnalysisResult(episodeId);
    if (!result) {
      res.status(404).json({ success: false, error: 'Analysis not found' });
      return;
    }
    res.json({
      success: true,
      data: {
        ...result,
        key_points: JSON.parse(result.key_points),
        arguments: JSON.parse(result.arguments),
        knowledge_points: JSON.parse(result.knowledge_points),
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, error: (error as Error).message });
  }
});

// === Reprocess Episode ===

router.post('/episodes/:id/reprocess', (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const episodeId = parseInt(param(req, 'id'), 10);
    const episode = db.getEpisodeById(episodeId);
    if (!episode) {
      res.status(404).json({ success: false, error: 'Episode not found' });
      return;
    }

    const podcast = db.getPodcastById(episode.podcast_id);
    if (!podcast) {
      res.status(404).json({ success: false, error: 'Podcast not found' });
      return;
    }

    // 删除旧的分析结果，重置状态为 pending
    db.deleteAnalysisResult(episodeId);
    db.updateEpisodeStatus(episodeId, 'pending');

    // 创建任务日志
    const taskLogId = db.createTaskLog(`reprocess_${episode.title}`);

    res.json({ success: true, data: { message: `正在重新处理: ${episode.title}`, taskLogId } });

    // 后台异步处理
    processEpisode(podcast.name, episode).then(result => {
      db.updateTaskLog(taskLogId, {
        status: result.status === 'success' ? 'completed' : 'failed',
        total_episodes: 1,
        processed_episodes: result.status === 'success' ? 1 : 0,
        failed_episodes: result.status === 'failed' ? 1 : 0,
        error_details: result.error || undefined,
      });
      logger.info(`Reprocess done: ${episode.title}`, { status: result.status, taskLogId });
    }).catch(error => {
      db.updateTaskLog(taskLogId, {
        status: 'failed',
        total_episodes: 1,
        processed_episodes: 0,
        failed_episodes: 1,
        error_details: (error as Error).message,
      });
      logger.error(`Reprocess failed: ${episode.title}`, { error: (error as Error).message, taskLogId });
    });
  } catch (error) {
    res.status(500).json({ success: false, error: (error as Error).message });
  }
});

// === Pipeline ===

router.post('/pipeline/run', (_req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const taskLogId = db.createTaskLog('full_pipeline_manual');
    res.json({ success: true, data: { message: '全量处理任务已启动，请在日志页面查看进度', taskLogId } });

    // Run in background
    runFullPipeline().then(({ results }) => {
      const succeeded = results.filter(r => r.status === 'success').length;
      const failed = results.filter(r => r.status === 'failed').length;
      logger.info(`Manual full pipeline done`, { succeeded, failed });
    }).catch(error => {
      logger.error(`Manual full pipeline failed`, { error: (error as Error).message });
    });
  } catch (error) {
    res.status(500).json({ success: false, error: (error as Error).message });
  }
});

// === Failed Episodes Info ===

router.get('/pipeline/failed', (_req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const failedEpisodes = db.getFailedEpisodes();
    res.json({
      success: true,
      data: {
        count: failedEpisodes.length,
        episodes: failedEpisodes.map(ep => ({
          id: ep.id,
          title: ep.title,
          podcast: ep.podcast_name,
          audioUrl: ep.audio_url,
          publishedAt: ep.published_at,
        })),
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, error: (error as Error).message });
  }
});

// === Process Pending Episodes (catch-up) ===

router.get('/pipeline/pending', (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const sinceHours = parseInt(String(req.query.hours || ''), 10) || 168; // 默认 7 天
    const episodes = db.getPendingEpisodesSince(sinceHours);
    res.json({
      success: true,
      data: {
        count: episodes.length,
        sinceHours,
        episodes: episodes.slice(0, 50).map(ep => ({
          id: ep.id,
          title: ep.title,
          podcast: ep.podcast_name,
          publishedAt: ep.published_at,
        })),
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, error: (error as Error).message });
  }
});

router.post('/pipeline/process-pending', (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const sinceHours = parseInt(String(req.query.hours || req.body?.hours || ''), 10) || 168;
    const episodes = db.getPendingEpisodesSince(sinceHours);

    if (episodes.length === 0) {
      res.json({ success: true, data: { message: '没有待处理的剧集', count: 0 } });
      return;
    }

    const taskLogId = db.createTaskLog('process_pending_catchup');
    logger.info(`Starting catch-up processing: ${episodes.length} pending episodes from last ${sinceHours}h`);

    res.json({
      success: true,
      data: { message: `开始补处理 ${episodes.length} 个剧集（过去 ${sinceHours} 小时）`, count: episodes.length, taskLogId },
    });

    // 后台逐集处理
    (async () => {
      const results: { status: string; title: string; error?: string }[] = [];
      for (const ep of episodes) {
        try {
          const freshEp = db.getEpisodeById(ep.id);
          if (!freshEp || freshEp.status !== 'pending') continue;
          const result = await processEpisode(ep.podcast_name, freshEp);
          results.push({ status: result.status, title: result.episodeTitle, error: result.error });
          logger.info(`Catch-up result: ${result.episodeTitle} => ${result.status}`);
        } catch (error) {
          results.push({ status: 'failed', title: ep.title, error: (error as Error).message });
          logger.error(`Catch-up failed: ${ep.title}`, { error: (error as Error).message });
        }
      }

      const succeeded = results.filter(r => r.status === 'success').length;
      const failed = results.filter(r => r.status === 'failed').length;

      const failedDetails = results
        .filter(r => r.status === 'failed' && r.error)
        .map(r => `[${r.title}] ${r.error}`)
        .join('\n');

      db.updateTaskLog(taskLogId, {
        status: failed > 0 && succeeded === 0 ? 'failed' : 'completed',
        total_episodes: results.length,
        processed_episodes: succeeded,
        failed_episodes: failed,
        error_details: failedDetails || undefined,
      });

      logger.info(`Catch-up completed: ${succeeded} ok, ${failed} failed out of ${results.length}`);
    })();
  } catch (error) {
    res.status(500).json({ success: false, error: (error as Error).message });
  }
});

// === Retry Failed Episodes ===

router.post('/pipeline/retry-failed', (_req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const failedEpisodes = db.getFailedEpisodes();
    if (failedEpisodes.length === 0) {
      res.json({ success: true, data: { message: '没有失败的剧集需要重试', count: 0 } });
      return;
    }

    // 重置所有失败剧集为 pending
    const resetCount = db.resetFailedEpisodes();
    const taskLogId = db.createTaskLog('retry_failed_episodes');
    logger.info(`Reset ${resetCount} failed episodes to pending, starting reprocess`);

    res.json({
      success: true,
      data: { message: `已重置 ${resetCount} 个失败剧集，开始重新处理`, count: resetCount, taskLogId },
    });

    // 后台逐集处理，处理完成后自动发邮件
    (async () => {
      const results: { status: string; title: string; error?: string }[] = [];
      // 重新查询 pending 剧集（刚被重置的那些）
      for (const ep of failedEpisodes) {
        try {
          const freshEp = db.getEpisodeById(ep.id);
          if (!freshEp) continue;
          const result = await processEpisode(ep.podcast_name, freshEp);
          results.push({ status: result.status, title: result.episodeTitle, error: result.error });
          logger.info(`Retry result: ${result.episodeTitle} => ${result.status}`);
        } catch (error) {
          results.push({ status: 'failed', title: ep.title, error: (error as Error).message });
          logger.error(`Retry failed: ${ep.title}`, { error: (error as Error).message });
        }
      }

      const succeeded = results.filter(r => r.status === 'success').length;
      const failed = results.filter(r => r.status === 'failed').length;

      const failedDetails = results
        .filter(r => r.status === 'failed' && r.error)
        .map(r => `[${r.title}] ${r.error}`)
        .join('\n');

      db.updateTaskLog(taskLogId, {
        status: failed > 0 && succeeded === 0 ? 'failed' : 'completed',
        total_episodes: results.length,
        processed_episodes: succeeded,
        failed_episodes: failed,
        error_details: failedDetails || undefined,
      });

      logger.info(`Retry completed: ${succeeded} ok, ${failed} failed out of ${results.length}`);
      // 不再自动发邮件，避免与每天 8:00 定时邮件重复
      // 如需立即发送，请手动调用 POST /api/email/send-digest
    })();
  } catch (error) {
    res.status(500).json({ success: false, error: (error as Error).message });
  }
});

// === Scheduler ===

router.get('/scheduler/status', (_req: Request, res: Response) => {
  res.json({ success: true, data: getSchedulerStatus() });
});

router.post('/scheduler/start', (_req: Request, res: Response) => {
  try {
    startScheduler();
    res.json({ success: true, data: getSchedulerStatus() });
  } catch (error) {
    res.status(500).json({ success: false, error: (error as Error).message });
  }
});

router.post('/scheduler/stop', (_req: Request, res: Response) => {
  stopScheduler();
  res.json({ success: true, data: getSchedulerStatus() });
});

router.post('/scheduler/trigger', async (_req: Request, res: Response) => {
  try {
    await triggerManualRun();
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: (error as Error).message });
  }
});

// === Documents ===

router.get('/documents', (_req: Request, res: Response) => {
  try {
    const db = getDatabase();
    // 从数据库获取已完成剧集的元数据
    const dbEpisodes = db.getCompletedEpisodesWithDocs();

    // 建立 markdown_path -> 数据库元数据 的映射
    const dbMap = new Map<string, { episodeId: number; title: string; date: string }>();
    for (const ep of dbEpisodes) {
      if (ep.markdown_path) {
        const parts = ep.markdown_path.split('/');
        const filename = parts[parts.length - 1];
        const podcast = parts[parts.length - 2];
        const key = `${podcast}/${filename}`;
        dbMap.set(key, {
          episodeId: ep.episode_id,
          title: ep.episode_title,
          date: ep.published_at ? ep.published_at.substring(0, 10) : ''
        });
      }
    }

    // 从文件系统扫描所有 markdown 文件（含 fallback 标题解析）
    const fileMetas = listMarkdownFilesWithMeta(config.storage.summariesDir);

    // 合并：优先用数据库标题，fallback 用文件解析的标题
    const grouped: Record<string, { episodeId: number | null; title: string; date: string; filename: string }[]> = {};
    for (const fm of fileMetas) {
      const key = `${fm.podcast}/${fm.filename}`;
      const dbMeta = dbMap.get(key);
      const title = dbMeta?.title || fm.title;
      const date = dbMeta?.date || fm.date;
      let episodeId: number | null = dbMeta?.episodeId || null;

      // 如果没有通过 analysis_results 匹配到，尝试通过播客名+日期反查
      if (!episodeId && fm.date) {
        const found = db.findEpisodeByPodcastAndDate(fm.podcast, fm.date);
        if (found) episodeId = found.episode_id;
      }

      if (!grouped[fm.podcast]) grouped[fm.podcast] = [];
      grouped[fm.podcast].push({ episodeId, title, date, filename: fm.filename });
    }

    // 转换为数组格式，每个播客内按日期降序
    const result = Object.entries(grouped).map(([podcast, episodes]) => ({
      podcast,
      episodes: episodes.sort((a, b) => b.date.localeCompare(a.date))
    })).sort((a, b) => a.podcast.localeCompare(b.podcast));

    res.json({ success: true, data: result });
  } catch (error) {
    res.status(500).json({ success: false, error: (error as Error).message });
  }
});

router.get('/documents/:podcast/:filename', (req: Request, res: Response) => {
  try {
    const podcast = param(req, 'podcast');
    const filename = param(req, 'filename');
    const content = readMarkdown(config.storage.summariesDir, podcast, filename);
    if (!content) {
      res.status(404).json({ success: false, error: 'Document not found' });
      return;
    }
    res.json({ success: true, data: { content, podcast, filename } });
  } catch (error) {
    res.status(500).json({ success: false, error: (error as Error).message });
  }
});

router.post('/documents/:podcast/:filename/pdf', async (req: Request, res: Response) => {
  try {
    const podcast = param(req, 'podcast');
    const filename = param(req, 'filename');
    const mdPath = path.join(config.storage.summariesDir, podcast, filename);
    const pdfPath = await exportToPdf(mdPath);
    res.download(pdfPath);
  } catch (error) {
    res.status(500).json({ success: false, error: (error as Error).message });
  }
});

// === Logs ===

router.get('/logs', (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const limit = parseInt(String(req.query.limit || ''), 10) ||50;
    const logs = db.getTaskLogs(limit);
    res.json({ success: true, data: logs });
  } catch (error) {
    res.status(500).json({ success: false, error: (error as Error).message });
  }
});

// === Stats ===

router.get('/stats', (_req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const stats = db.getStats();
    const mem = process.memoryUsage();
    res.json({
      success: true,
      data: {
        ...stats,
        memory: {
          heapUsedMB: Math.round(mem.heapUsed / 1024 / 1024),
          heapTotalMB: Math.round(mem.heapTotal / 1024 / 1024),
          rssMB: Math.round(mem.rss / 1024 / 1024),
        },
        uptime: Math.round(process.uptime()),
        scheduler: getSchedulerStatus(),
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, error: (error as Error).message });
  }
});

// === Email ===

router.post('/email/test-connection', async (_req: Request, res: Response) => {
  try {
    const result = await testEmailConnection();
    res.json({ success: true, data: result });
  } catch (error) {
    res.status(500).json({ success: false, error: (error as Error).message });
  }
});

router.post('/email/send-digest', (req: Request, res: Response) => {
  // 支持自定义时间窗口，默认24小时
  const sinceHours = parseInt(String(req.query.hours || req.body?.hours || ''), 10) || 24;

  // 立即返回，避免 Railway 代理 30s 超时（生成摘要+PDF 耗时较长）
  res.json({ success: true, data: { message: '邮件发送任务已启动（后台处理）', sinceHours } });

  // 后台异步执行
  sendDailyDigest(sinceHours).then(result => {
    logger.info('send-digest completed', result);
  }).catch(err => {
    logger.error('send-digest failed', { error: (err as Error).message });
  });
});

// === Daily Digest WebUI API ===

// 立即生成今日摘要（供 WebUI 按钮调用，独立于邮件发送）
// 后台运行，立即返回 taskId
router.post('/digest/generate', (req: Request, res: Response) => {
  const sinceHours = parseInt(String(req.query.hours || req.body?.hours || ''), 10) || 24;
  const db = getDatabase();
  const taskLogId = db.createTaskLog(`generate_digest_${sinceHours}h`);
  res.json({ success: true, data: { message: `已开始生成（窗口 ${sinceHours} 小时）`, taskLogId } });

  generateAndSaveDigest(sinceHours).then(result => {
    db.updateTaskLog(taskLogId, {
      status: result.ok ? 'completed' : 'failed',
      total_episodes: result.episodeCount,
      processed_episodes: result.episodeCount,
      error_details: result.error || result.audioError,
    });
    logger.info('Digest generation done', { ok: result.ok, episodes: result.episodeCount, audio: result.audioGenerated, audioErr: result.audioError });
  }).catch(err => {
    db.updateTaskLog(taskLogId, { status: 'failed', error_details: (err as Error).message });
    logger.error('Digest generation failed', { error: (err as Error).message });
  });
});

// TTS 单次测试，用于诊断音频生成是否可用
router.get('/debug/test-tts', async (_req: Request, res: Response) => {
  const result = await testTts();
  res.json({ success: true, data: result });
});

// 列出所有播客（用于 chat 页面的下拉选择）
router.get('/podcasts/with-episodes', (_req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const podcasts = db.getActivePodcasts();
    res.json({ success: true, data: podcasts.map(p => ({ id: p.id, name: p.name })) });
  } catch (err) {
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

// 列出某播客的所有剧集（用于剧集级 chat 选择）
router.get('/podcasts/:id/analyzed-episodes', (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const podcastId = parseInt(param(req, 'id'), 10);
    const eps = db.getAnalyzedEpisodesByPodcast(podcastId, 100);
    res.json({ success: true, data: eps });
  } catch (err) {
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

// 列出所有已生成的每日摘要
router.get('/digest/list', (_req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const list = db.listDailyDigests(30);
    res.json({ success: true, data: list });
  } catch (err) {
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

// 获取某天的摘要详情（含剧集列表）
router.get('/digest/:date', (req: Request, res: Response) => {
  try {
    const date = String(req.params.date).replace(/[^0-9\-]/g, '');
    const db = getDatabase();
    const digest = db.getDailyDigest(date);
    if (!digest) {
      res.status(404).json({ success: false, error: 'No digest for this date' });
      return;
    }

    const episodeIds: number[] = JSON.parse(digest.episode_ids || '[]');
    const episodes = episodeIds.map(id => {
      const ep = db.getEpisodeById(id);
      if (!ep) return null;
      const podcast = db.getPodcastById(ep.podcast_id);
      const analysis = db.getAnalysisResult(id);
      if (!analysis) return null;
      let keyPoints: { title: string; detail: string }[] = [];
      let keywords: { word: string; context: string }[] = [];
      try { keyPoints = JSON.parse(analysis.key_points || '[]'); } catch {}
      try { keywords = JSON.parse(analysis.arguments || '[]'); } catch {}
      return {
        id,
        title: ep.title,
        podcastName: podcast?.name || '',
        publishedAt: ep.published_at,
        durationSeconds: ep.duration_seconds,
        audioUrl: ep.audio_url,
        summary: analysis.summary,
        keyPoints,
        keywords,
        fullRecap: analysis.knowledge_points,
      };
    }).filter(Boolean);

    const baseUrl = process.env.RAILWAY_PUBLIC_DOMAIN
      ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
      : 'https://podcast-digest-production.up.railway.app';

    const audioUrl = digest.audio_filename
      ? `${baseUrl}/api/audio/${digest.audio_filename}`
      : null;

    // 验证音频文件是否还在磁盘上
    const audioExists = digest.audio_filename
      ? fs.existsSync(path.join(AUDIO_DIR, digest.audio_filename))
      : false;

    res.json({
      success: true,
      data: {
        date,
        summary: digest.summary,
        audioUrl: audioExists ? audioUrl : null,
        audioFilename: audioExists ? digest.audio_filename : null,
        episodeCount: episodes.length,
        episodes,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

// 每日摘要 Q&A 对话
router.post('/digest/chat', async (req: Request, res: Response) => {
  try {
    const { date, message, history = [] } = req.body as {
      date: string;
      message: string;
      history: { role: 'user' | 'assistant'; content: string }[];
    };

    if (!date || !message) {
      res.status(400).json({ success: false, error: 'date and message required' });
      return;
    }

    const db = getDatabase();
    const digest = db.getDailyDigest(date.replace(/[^0-9\-]/g, ''));
    if (!digest) {
      res.status(404).json({ success: false, error: 'No digest for this date' });
      return;
    }

    // 构建上下文（今日全览 + 每集摘要）
    const episodeIds: number[] = JSON.parse(digest.episode_ids || '[]');
    let context = `以下是 ${date} 当日播客摘要内容，供你回答用户问题：\n\n`;
    if (digest.summary) context += `【今日全览】\n${digest.summary}\n\n`;

    let charCount = context.length;
    for (const id of episodeIds) {
      const ep = db.getEpisodeById(id);
      const analysis = db.getAnalysisResult(id);
      if (!ep || !analysis) continue;
      const podcast = db.getPodcastById(ep.podcast_id);
      let keyPoints: { title: string; detail: string }[] = [];
      try { keyPoints = JSON.parse(analysis.key_points || '[]'); } catch {}
      const kpText = keyPoints.map(kp => `  · ${kp.title}：${kp.detail || ''}`).join('\n');
      const epContext = `【${podcast?.name || ''}：${ep.title}】\n${analysis.summary}\n要点：\n${kpText}\n${analysis.knowledge_points ? '详情：' + analysis.knowledge_points.slice(0, 400) : ''}\n\n`;

      if (charCount + epContext.length > 12000) break; // 防止超 token
      context += epContext;
      charCount += epContext.length;
    }

    const client = new OpenAI({
      apiKey: config.dashscope.apiKey,
      baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      timeout: 60000,
    });

    const messages: { role: 'system' | 'user' | 'assistant'; content: string }[] = [
      { role: 'system', content: `你是播客内容助手，根据以下内容回答用户问题。回答要准确、简洁、有见地。\n\n${context}` },
      ...history.slice(-10), // 最近10条历史
      { role: 'user', content: message },
    ];

    const completion = await client.chat.completions.create({
      model: config.dashscope.textModel,
      messages,
      max_tokens: 1000,
    });

    const reply = completion.choices[0]?.message?.content || '抱歉，无法生成回答。';
    res.json({ success: true, data: { reply } });
  } catch (err) {
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

// === Universal Chat (Q&A + Search) ===
//
// scope:
//   'global'   - 全局搜索：用关键词在所有已分析剧集中检索后再回答（带引用）
//   'podcast'  - 单播客作用域：scopeId = podcast_id
//   'episode'  - 单剧集作用域：scopeId = episode_id
//   'date'     - 单日作用域：scopeId = YYYY-MM-DD（沿用 daily_digests）
router.post('/chat', async (req: Request, res: Response) => {
  try {
    const { scope, scopeId, message, history = [] } = req.body as {
      scope: 'global' | 'podcast' | 'episode' | 'date';
      scopeId?: number | string;
      message: string;
      history: { role: 'user' | 'assistant'; content: string }[];
    };

    if (!scope || !message) {
      res.status(400).json({ success: false, error: 'scope and message required' });
      return;
    }

    const db = getDatabase();
    let context = '';
    const citations: Array<{ episodeId: number; podcastName: string; episodeTitle: string; publishedAt: string }> = [];

    if (scope === 'episode') {
      const epId = parseInt(String(scopeId), 10);
      const ep = db.getEpisodeFullAnalysis(epId);
      if (!ep) { res.status(404).json({ success: false, error: 'Episode not found' }); return; }
      let kpText = '';
      let kwText = '';
      try {
        const kp: Array<{title:string;detail:string}> = JSON.parse(ep.key_points || '[]');
        kpText = kp.map(k => `· ${k.title}：${k.detail || ''}`).join('\n');
      } catch {}
      try {
        const kw: Array<{word:string;context:string}> = JSON.parse(ep.arguments || '[]');
        kwText = kw.map(k => `· ${k.word}：${k.context || ''}`).join('\n');
      } catch {}
      context = `这是一集播客的完整内容：\n\n【${ep.podcast_name}：${ep.episode_title}】\n发布时间：${ep.published_at}\n\n摘要：\n${ep.summary}\n\n核心要点：\n${kpText}\n\n关键词：\n${kwText}\n\n详细纪要：\n${(ep.knowledge_points || '').slice(0, 4000)}\n\n基于以上内容回答用户问题，准确、简洁、有见地。`;
      citations.push({ episodeId: epId, podcastName: ep.podcast_name, episodeTitle: ep.episode_title, publishedAt: ep.published_at });
    } else if (scope === 'podcast') {
      const podcastId = parseInt(String(scopeId), 10);
      const podcast = db.getPodcastById(podcastId);
      if (!podcast) { res.status(404).json({ success: false, error: 'Podcast not found' }); return; }
      const eps = db.getAnalyzedEpisodesByPodcast(podcastId, 30);
      context = `以下是播客【${podcast.name}】最近 ${eps.length} 集的内容：\n\n`;
      let charCount = context.length;
      for (const ep of eps) {
        let kpText = '';
        try {
          const kp: Array<{title:string;detail:string}> = JSON.parse(ep.key_points || '[]');
          kpText = kp.slice(0, 5).map(k => `  · ${k.title}`).join('\n');
        } catch {}
        const summary = (ep.summary || '').slice(0, 400);
        const block = `【${ep.episode_title}】(${ep.published_at?.slice(0,10) || ''})\n${summary}\n要点：\n${kpText}\n\n`;
        if (charCount + block.length > 14000) break;
        context += block;
        charCount += block.length;
        citations.push({ episodeId: ep.episode_id, podcastName: podcast.name, episodeTitle: ep.episode_title, publishedAt: ep.published_at });
      }
      context += `\n基于以上内容回答用户问题，可在回答中明确引用具体剧集名。`;
    } else if (scope === 'date') {
      const date = String(scopeId).replace(/[^0-9\-]/g, '');
      const digest = db.getDailyDigest(date);
      if (!digest) { res.status(404).json({ success: false, error: 'No digest for this date' }); return; }
      const episodeIds: number[] = JSON.parse(digest.episode_ids || '[]');
      context = `以下是 ${date} 当日播客摘要内容：\n\n`;
      if (digest.summary) context += `【今日全览】\n${digest.summary}\n\n`;
      let charCount = context.length;
      for (const id of episodeIds) {
        const ep = db.getEpisodeById(id);
        const a = db.getAnalysisResult(id);
        if (!ep || !a) continue;
        const podcast = db.getPodcastById(ep.podcast_id);
        let kpText = '';
        try {
          const kp: Array<{title:string;detail:string}> = JSON.parse(a.key_points || '[]');
          kpText = kp.map(k => `  · ${k.title}：${k.detail || ''}`).join('\n');
        } catch {}
        const block = `【${podcast?.name || ''}：${ep.title}】\n${a.summary}\n要点：\n${kpText}\n\n`;
        if (charCount + block.length > 12000) break;
        context += block;
        charCount += block.length;
        citations.push({ episodeId: id, podcastName: podcast?.name || '', episodeTitle: ep.title, publishedAt: ep.published_at });
      }
    } else {
      // === scope === 'global' ===
      // 1) 用 LLM 从用户问题中提炼搜索关键词（中文 1-3 个）
      const keywordExtractor = new OpenAI({
        apiKey: config.dashscope.apiKey,
        baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        timeout: 30000,
      });
      let keywords: string[] = [];
      try {
        const kwResp = await keywordExtractor.chat.completions.create({
          model: config.dashscope.textModel,
          messages: [
            { role: 'system', content: '从用户问题中提取 1-3 个最具检索价值的中文/英文关键词，用空格分隔，只输出关键词本身，不要任何解释。例如用户问"AI agents 最近的进展"，输出"AI Agents 进展"。' },
            { role: 'user', content: message },
          ],
          max_tokens: 60,
        });
        const kwText = kwResp.choices[0]?.message?.content || '';
        keywords = kwText.split(/\s+/).map(s => s.trim()).filter(s => s.length >= 2).slice(0, 3);
      } catch {}
      if (keywords.length === 0) keywords = [message.slice(0, 20)];

      // 2) 在 SQLite 中搜索匹配剧集（每个关键词检索一批，去重）
      const seen = new Set<number>();
      const candidates: ReturnType<typeof db.searchEpisodesByKeyword> = [];
      for (const kw of keywords) {
        const rows = db.searchEpisodesByKeyword(kw, 15);
        for (const r of rows) {
          if (!seen.has(r.episode_id)) {
            seen.add(r.episode_id);
            candidates.push(r);
          }
          if (candidates.length >= 25) break;
        }
        if (candidates.length >= 25) break;
      }

      if (candidates.length === 0) {
        res.json({ success: true, data: {
          reply: `在所有已处理的剧集中没有找到与「${keywords.join('、')}」相关的内容。可以尝试其他关键词，例如更通用的话题词。`,
          citations: [], keywords,
        }});
        return;
      }

      // 3) 构建上下文（每集精简到 ~500 字以内）
      context = `用户在播客内容库中搜索"${message}"（自动提取关键词：${keywords.join('、')}）。\n\n以下是检索到的 ${candidates.length} 个最相关剧集，按发布时间倒序：\n\n`;
      let charCount = context.length;
      for (const c of candidates) {
        let kpText = '';
        try {
          const kp: Array<{title:string;detail:string}> = JSON.parse(c.key_points || '[]');
          kpText = kp.slice(0, 4).map(k => `  · ${k.title}`).join('\n');
        } catch {}
        const summary = (c.summary || '').slice(0, 400);
        const block = `[剧集 #${c.episode_id}]【${c.podcast_name}：${c.episode_title}】(${c.published_at?.slice(0,10) || ''})\n${summary}\n要点：\n${kpText}\n\n`;
        if (charCount + block.length > 14000) break;
        context += block;
        charCount += block.length;
        citations.push({ episodeId: c.episode_id, podcastName: c.podcast_name, episodeTitle: c.episode_title, publishedAt: c.published_at });
      }
      context += `\n基于以上检索结果回答用户问题。要求：\n1. 准确、简洁，引用具体剧集名（用「播客名：剧集名」格式）\n2. 如果是搜索意图（用户找内容），列出 3-5 个最相关剧集并简述每集亮点\n3. 如果是问答意图，综合多集信息给出深度回答\n4. 引用时使用格式：「《播客名：剧集名》提到..."`;
    }

    // 调用 Qwen 生成回答
    const client = new OpenAI({
      apiKey: config.dashscope.apiKey,
      baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      timeout: 90000,
    });

    const messages: { role: 'system' | 'user' | 'assistant'; content: string }[] = [
      { role: 'system', content: `你是播客内容智能助手，由 Qwen3.6 驱动。\n\n${context}` },
      ...history.slice(-10),
      { role: 'user', content: message },
    ];

    const completion = await client.chat.completions.create({
      model: config.dashscope.textModel,
      messages,
      max_tokens: 1500,
    });

    const reply = completion.choices[0]?.message?.content || '抱歉，无法生成回答。';
    res.json({ success: true, data: { reply, citations, scope } });
  } catch (err) {
    logger.error('Chat failed', { error: (err as Error).message });
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

// === Email send-digest preview & flexible window ===
router.get('/email/digest-preview', (_req: Request, res: Response) => {
  try {
    const db = getDatabase();
    res.json({ success: true, data: db.countCompletedSinceWindows() });
  } catch (err) {
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

// === Audio file serving ===
// 供邮件中的"点击收听"链接使用，文件保存在 /tmp/podcast-audio/
router.get('/audio/:filename', (req: Request, res: Response) => {
  // 过滤非法字符，只允许 字母数字-_.
  const filename = String(req.params.filename).replace(/[^a-zA-Z0-9\-_.]/g, '');
  const filePath = path.join(AUDIO_DIR, filename);
  if (!fs.existsSync(filePath)) {
    res.status(404).json({ error: 'Audio file not found' });
    return;
  }
  const stat = fs.statSync(filePath);
  res.setHeader('Content-Type', 'audio/mpeg');
  res.setHeader('Content-Length', stat.size);
  res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
  res.setHeader('Accept-Ranges', 'bytes');
  fs.createReadStream(filePath).pipe(res);
});

// === Settings (non-sensitive) ===

router.get('/settings', (_req: Request, res: Response) => {
  res.json({
    success: true,
    data: {
      transcriptionProvider: config.transcriptionProvider,
      analysisProvider: config.analysisProvider,
      openaiModel: config.openai.model,
      dashscopeSpeechModel: config.dashscope.speechModel,
      dashscopeTextModel: config.dashscope.textModel,
      schedulerCron: config.scheduler.cron,
      schedulerTimezone: config.scheduler.timezone,
      maxConcurrentFeeds: config.processing.maxConcurrentFeeds,
      updateWindowHours: config.processing.updateWindowHours,
      pdfEnabled: config.pdf.enabled,
      emailEnabled: config.email.enabled,
      emailTo: config.email.toAddress,
      emailCron: config.email.scheduleCron,
      emailSmtpConfigured: !!(config.email.smtpUser && config.email.smtpPass),
    },
  });
});

// === Network Diagnostics ===
router.get('/debug/network', async (_req: Request, res: Response) => {
  const dns = await import('dns');
  const OpenAI = (await import('openai')).default;
  const results: Record<string, any> = {};

  // DNS resolution for relevant hosts
  const dnsHosts = ['dashscope.aliyuncs.com', 'api.openai.com', 'resend.com', 'google.com'];
  for (const host of dnsHosts) {
    try {
      const addrs = await new Promise<any[]>((resolve, reject) => {
        dns.resolve4(host, (err, addresses) => err ? reject(err) : resolve(addresses));
      });
      results[`dns_${host}`] = { ok: true, addresses: addrs };
    } catch (e: any) {
      results[`dns_${host}`] = { ok: false, error: e.message };
    }
  }

  // Test DashScope Chat API (Qwen via OpenAI-compatible endpoint)
  if (config.dashscope.apiKey) {
    try {
      const dsClient = new OpenAI({
        apiKey: config.dashscope.apiKey,
        baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        timeout: 30000,
      });
      const chatResult = await dsClient.chat.completions.create({
        model: config.dashscope.textModel,
        messages: [{ role: 'user', content: 'Say "ok" and nothing else.' }],
        max_tokens: 16,
      });
      const reply = chatResult.choices[0]?.message?.content || '';
      results['dashscope_chat'] = { ok: true, reply, model: (chatResult as any).model };
    } catch (e: any) {
      results['dashscope_chat'] = {
        ok: false,
        error: e.message,
        type: e.constructor?.name,
        status: e.status,
      };
    }
  } else {
    results['dashscope_chat'] = { ok: false, error: 'DASHSCOPE_API_KEY not configured' };
  }

  // Test OpenAI SDK Chat call (if configured)
  if (config.openai.apiKey) {
    try {
      const client = new OpenAI({
        apiKey: config.openai.apiKey,
        baseURL: config.openai.baseUrl,
        timeout: 30000,
      });
      const chatResult = await client.chat.completions.create({
        model: config.openai.model,
        messages: [{ role: 'user', content: 'Say "ok" and nothing else.' }],
        max_completion_tokens: 16,
      });
      const reply = chatResult.choices[0]?.message?.content || '';
      results['openai_sdk_chat'] = { ok: true, reply, model: (chatResult as any).model };
    } catch (e: any) {
      results['openai_sdk_chat'] = {
        ok: false,
        error: e.message,
        type: e.constructor?.name,
        status: e.status,
        cause: e.cause?.message,
      };
    }
  } else {
    results['openai_sdk_chat'] = { skipped: true, reason: 'OPENAI_API_KEY not configured' };
  }

  // Show config info
  results['config'] = {
    transcriptionProvider: config.transcriptionProvider,
    analysisProvider: config.analysisProvider,
    dashscope: {
      speechModel: config.dashscope.speechModel,
      textModel: config.dashscope.textModel,
      apiKeyPrefix: config.dashscope.apiKey ? config.dashscope.apiKey.substring(0, 8) + '...' : 'MISSING',
    },
    openai: {
      baseUrl: config.openai.baseUrl,
      model: config.openai.model,
      apiKeyPrefix: config.openai.apiKey ? config.openai.apiKey.substring(0, 8) + '...' : 'NOT SET',
    },
  };

  res.json({ success: true, data: results });
});

/**
 * 诊断端点：测试从 Railway 服务器下载指定音频 URL
 * GET /api/debug/test-download?url=xxx
 */
router.get('/debug/test-download', async (req: Request, res: Response) => {
  const axios = (await import('axios')).default;
  const testUrl = String(req.query.url || '');
  if (!testUrl) {
    res.json({ success: false, error: 'Missing url parameter' });
    return;
  }

  const results: Record<string, any> = { originalUrl: testUrl };

  // Step 1: 解析重定向
  try {
    const headResp = await axios.head(testUrl, {
      maxRedirects: 10,
      timeout: 15000,
      headers: { 'User-Agent': 'PodcastDigest/2.0' },
    });
    const finalUrl = (headResp.request as any)?.res?.responseUrl || testUrl;
    results.redirect = { ok: true, finalUrl, status: headResp.status, contentType: headResp.headers['content-type'] };
  } catch (e: any) {
    results.redirect = { ok: false, error: e.message, code: e.code, status: e.response?.status };
    // 尝试 GET
    try {
      const getResp = await axios.get(testUrl, {
        maxRedirects: 10, timeout: 15000,
        headers: { 'User-Agent': 'PodcastDigest/2.0', 'Range': 'bytes=0-0' },
        responseType: 'stream',
      });
      const finalUrl = (getResp.request as any)?.res?.responseUrl || testUrl;
      getResp.data.destroy();
      results.redirect_get = { ok: true, finalUrl, status: getResp.status };
    } catch (e2: any) {
      results.redirect_get = { ok: false, error: e2.message, code: e2.code, status: e2.response?.status };
    }
  }

  // Step 2: 尝试下载前 1KB
  try {
    const dlResp = await axios.get(results.redirect?.finalUrl || testUrl, {
      maxRedirects: 10, timeout: 15000,
      headers: { 'User-Agent': 'PodcastDigest/2.0', 'Range': 'bytes=0-1023' },
      responseType: 'arraybuffer',
    });
    results.download = {
      ok: true,
      status: dlResp.status,
      bytesReceived: dlResp.data.byteLength,
      contentType: dlResp.headers['content-type'],
      contentLength: dlResp.headers['content-length'],
    };
  } catch (e: any) {
    results.download = { ok: false, error: e.message, code: e.code, status: e.response?.status };
  }

  res.json({ success: true, data: results });
});

export default router;
