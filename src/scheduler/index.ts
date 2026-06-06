import cron from 'node-cron';
import { config } from '../config';
import { logger } from '../utils/logger';
import { runFullPipeline } from '../pipeline/processor';
import { sendDailyDigest, generateAndSaveDigest } from '../email';
import { pushDigestToNotion } from '../notion';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import tz from 'dayjs/plugin/timezone';
dayjs.extend(utc);
dayjs.extend(tz);

let scheduledTask: cron.ScheduledTask | null = null;
let emailTask: cron.ScheduledTask | null = null;
let digestGenTask: cron.ScheduledTask | null = null;
let isRunning = false;
let lastRunTime: string | null = null;
let lastRunStatus: string | null = null;
let lastEmailTime: string | null = null;
let lastEmailStatus: string | null = null;

export function startScheduler(): void {
  if (scheduledTask) {
    logger.warn('Scheduler already running');
    return;
  }

  const cronExpr = config.scheduler.cron;
  if (!cron.validate(cronExpr)) {
    logger.error('Invalid cron expression', { cron: cronExpr });
    throw new Error(`Invalid cron expression: ${cronExpr}`);
  }

  scheduledTask = cron.schedule(cronExpr, async () => {
    await executeScheduledTask();
  }, {
    timezone: config.scheduler.timezone,
  });

  logger.info('Scheduler started', {
    cron: cronExpr,
    timezone: config.scheduler.timezone,
  });

  // Start digest generation scheduler (7am Beijing, 1h before email)
  startDigestGenScheduler();

  // Start email digest scheduler
  startEmailScheduler();
}

export function startDigestGenScheduler(): void {
  if (digestGenTask) {
    digestGenTask.stop();
    digestGenTask = null;
  }

  // 默认 7am Beijing time（邮件之前 1 小时预生成）
  const digestCron = process.env.DIGEST_GEN_CRON || '0 7 * * *';
  if (!cron.validate(digestCron)) {
    logger.error('Invalid digest gen cron', { cron: digestCron });
    return;
  }

  digestGenTask = cron.schedule(digestCron, async () => {
    try {
      logger.info('Digest pre-generation task started (1h before email)');
      const result = await generateAndSaveDigest(24);
      logger.info('Digest pre-generation done', {
        ok: result.ok,
        episodes: result.episodeCount,
        audio: result.audioGenerated,
        audioErr: result.audioError,
      });
    } catch (err) {
      logger.error('Digest pre-generation failed', { error: (err as Error).message });
    }
  }, {
    timezone: config.email.scheduleTimezone,
  });

  logger.info('Digest gen scheduler started', { cron: digestCron, timezone: config.email.scheduleTimezone });
}

export function startEmailScheduler(): void {
  if (emailTask) {
    emailTask.stop();
    emailTask = null;
  }

  if (!config.email.enabled) {
    logger.info('Email digest scheduler not started: email not enabled');
    return;
  }

  const emailCron = config.email.scheduleCron;
  if (!cron.validate(emailCron)) {
    logger.error('Invalid email cron expression', { cron: emailCron });
    return;
  }

  emailTask = cron.schedule(emailCron, async () => {
    await executeEmailDigest();
  }, {
    timezone: config.email.scheduleTimezone,
  });

  logger.info('Email digest scheduler started', {
    cron: emailCron,
    timezone: config.email.scheduleTimezone,
  });
}

export function stopScheduler(): void {
  if (scheduledTask) {
    scheduledTask.stop();
    scheduledTask = null;
    logger.info('Scheduler stopped');
  }
  if (emailTask) {
    emailTask.stop();
    emailTask = null;
    logger.info('Email scheduler stopped');
  }
  if (digestGenTask) {
    digestGenTask.stop();
    digestGenTask = null;
    logger.info('Digest gen scheduler stopped');
  }
}

export async function triggerManualRun(): Promise<void> {
  await executeScheduledTask();
}

export async function triggerEmailDigest(): Promise<{ sent: boolean; episodeCount: number; error?: string }> {
  return executeEmailDigest();
}

export function getSchedulerStatus(): {
  running: boolean;
  taskRunning: boolean;
  cron: string;
  timezone: string;
  lastRunTime: string | null;
  lastRunStatus: string | null;
  emailSchedulerRunning: boolean;
  emailCron: string;
  emailEnabled: boolean;
  lastEmailTime: string | null;
  lastEmailStatus: string | null;
} {
  return {
    running: scheduledTask !== null,
    taskRunning: isRunning,
    cron: config.scheduler.cron,
    timezone: config.scheduler.timezone,
    lastRunTime,
    lastRunStatus,
    emailSchedulerRunning: emailTask !== null,
    emailCron: config.email.scheduleCron,
    emailEnabled: config.email.enabled,
    lastEmailTime,
    lastEmailStatus,
  };
}

async function executeScheduledTask(): Promise<void> {
  if (isRunning) {
    logger.warn('Scheduled task already running, skipping');
    return;
  }

  isRunning = true;
  lastRunTime = new Date().toISOString();

  try {
    logger.info('Scheduled task started');
    const { results } = await runFullPipeline();

    const succeeded = results.filter(r => r.status === 'success').length;
    const failed = results.filter(r => r.status === 'failed').length;

    lastRunStatus = failed > 0 ? `completed with errors (${succeeded} ok, ${failed} failed)` : `success (${succeeded} processed)`;
    logger.info('Scheduled task completed', { status: lastRunStatus });
  } catch (error) {
    lastRunStatus = `failed: ${(error as Error).message}`;
    logger.error('Scheduled task failed', { error: (error as Error).message });
  } finally {
    isRunning = false;
  }
}

async function executeEmailDigest(): Promise<{ sent: boolean; episodeCount: number; error?: string }> {
  lastEmailTime = new Date().toISOString();

  try {
    logger.info('Email digest task started');
    const result = await sendDailyDigest(24);

    if (result.sent) {
      lastEmailStatus = `sent (${result.episodeCount} episodes)`;
    } else {
      lastEmailStatus = result.error || 'not sent';
    }

    logger.info('Email digest task completed', { status: lastEmailStatus });

    // 同步推送到 Notion（独立失败不影响邮件结果）
    if (result.sent && process.env.NOTION_API_KEY) {
      try {
        const today = dayjs().tz('Asia/Shanghai').format('YYYY-MM-DD');
        const notionResult = await pushDigestToNotion(today);
        if (notionResult.ok) {
          logger.info('Notion digest pushed', { date: today, pageUrl: notionResult.pageUrl, blocks: notionResult.blockCount });
        } else {
          logger.warn('Notion push failed', { date: today, error: notionResult.error });
        }
      } catch (err) {
        logger.warn('Notion push exception', { error: (err as Error).message });
      }
    }

    return result;
  } catch (error) {
    lastEmailStatus = `failed: ${(error as Error).message}`;
    logger.error('Email digest task failed', { error: (error as Error).message });
    return { sent: false, episodeCount: 0, error: (error as Error).message };
  }
}
