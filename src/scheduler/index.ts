import cron from 'node-cron';
import { config } from '../config';
import { logger } from '../utils/logger';
import { runFullPipeline } from '../pipeline/processor';
import { sendDailyDigest } from '../email';

let scheduledTask: cron.ScheduledTask | null = null;
let emailTask: cron.ScheduledTask | null = null;
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

  // Start email digest scheduler
  startEmailScheduler();
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
    return result;
  } catch (error) {
    lastEmailStatus = `failed: ${(error as Error).message}`;
    logger.error('Email digest task failed', { error: (error as Error).message });
    return { sent: false, episodeCount: 0, error: (error as Error).message };
  }
}
