import { Router, Request, Response } from 'express';
import { config } from '../config';
import { getDatabase } from '../database';
import { searchPodcasts, parseOPML, parseFeed, validateFeed } from '../rss';
import { processEpisode, refreshAndProcessPodcast, runFullPipeline } from '../pipeline/processor';
import { startScheduler, stopScheduler, getSchedulerStatus, triggerManualRun, triggerEmailDigest } from '../scheduler';
import { sendDailyDigest, testEmailConnection } from '../email';
import { listMarkdownFiles, listMarkdownFilesWithMeta, readMarkdown } from '../markdown';
import { exportToPdf } from '../markdown/pdf';
import { logger } from '../utils/logger';
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

      // 处理完成后立即发送邮件摘要（覆盖范围=最近48小时，确保今天重处理的都能被包含）
      if (succeeded > 0) {
        try {
          logger.info('Sending email digest after retry...');
          const emailResult = await sendDailyDigest(48);
          logger.info('Post-retry email sent', emailResult);
        } catch (emailError) {
          logger.error('Post-retry email failed', { error: (emailError as Error).message });
        }
      }
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

router.post('/email/send-digest', async (_req: Request, res: Response) => {
  try {
    const result = await sendDailyDigest(24);
    res.json({ success: true, data: result });
  } catch (error) {
    res.status(500).json({ success: false, error: (error as Error).message });
  }
});

// === Settings (non-sensitive) ===

router.get('/settings', (_req: Request, res: Response) => {
  res.json({
    success: true,
    data: {
      transcriptionProvider: config.transcriptionProvider,
      analysisProvider: config.analysisProvider,
      openaiModel: config.openai.model,
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

  // Test DNS resolution
  for (const host of ['api.openai.com', 'resend.com', 'google.com']) {
    try {
      const addrs = await new Promise<any[]>((resolve, reject) => {
        dns.resolve4(host, (err, addresses) => err ? reject(err) : resolve(addresses));
      });
      results[`dns_${host}`] = { ok: true, addresses: addrs };
    } catch (e: any) {
      results[`dns_${host}`] = { ok: false, error: e.message };
    }
  }

  // Test HTTP connectivity to OpenAI (raw fetch)
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    const resp = await fetch('https://api.openai.com/v1/models', {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${config.openai.apiKey}` },
      signal: controller.signal,
    });
    clearTimeout(timeout);
    results['openai_fetch'] = { ok: resp.ok, status: resp.status };
  } catch (e: any) {
    results['openai_fetch'] = { ok: false, error: e.message, cause: e.cause?.message };
  }

  // Test OpenAI SDK Chat call (the actual path that fails)
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

  // Test audio download (axios - same path as audio downloader)
  try {
    const axios = (await import('axios')).default;
    const testResp = await axios({
      method: 'get',
      url: 'https://api.openai.com/v1/models',
      timeout: 10000,
      headers: { 'Authorization': `Bearer ${config.openai.apiKey}` },
    });
    results['axios_test'] = { ok: true, status: testResp.status };
  } catch (e: any) {
    results['axios_test'] = { ok: false, error: e.message, code: e.code };
  }

  // Show config info
  results['config'] = {
    baseUrl: config.openai.baseUrl,
    model: config.openai.model,
    apiKeyPrefix: config.openai.apiKey ? config.openai.apiKey.substring(0, 8) + '...' : 'MISSING',
  };

  res.json({ success: true, data: results });
});

export default router;
