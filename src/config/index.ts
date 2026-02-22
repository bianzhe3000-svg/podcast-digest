import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';

dotenv.config();

export type ProviderType = 'openai' | 'dashscope';

function env(key: string, defaultValue: string): string {
  return process.env[key] || defaultValue;
}

function envInt(key: string, defaultValue: number): number {
  const val = process.env[key];
  return val ? parseInt(val, 10) : defaultValue;
}

function envBool(key: string, defaultValue: boolean): boolean {
  const val = process.env[key];
  if (!val) return defaultValue;
  return val.toLowerCase() === 'true' || val === '1';
}

export const config = {
  transcriptionProvider: env('TRANSCRIPTION_PROVIDER', 'dashscope') as ProviderType,
  analysisProvider: env('ANALYSIS_PROVIDER', 'dashscope') as ProviderType,

  openai: {
    apiKey: env('OPENAI_API_KEY', ''),
    model: env('OPENAI_MODEL', 'gpt-4o'),
    whisperModel: env('OPENAI_WHISPER_MODEL', 'whisper-1'),
    baseUrl: env('OPENAI_BASE_URL', 'https://api.openai.com/v1'),
  },

  dashscope: {
    apiKey: env('DASHSCOPE_API_KEY', ''),
    baseUrl: env('DASHSCOPE_BASE_URL', 'https://dashscope.aliyuncs.com'),
    speechModel: env('DASHSCOPE_SPEECH_MODEL', 'paraformer-v2'),
    textModel: env('DASHSCOPE_TEXT_MODEL', 'qwen-plus'),
  },

  database: {
    path: env('DATABASE_PATH', './data/podcast-digest.db'),
  },

  storage: {
    summariesDir: env('SUMMARIES_DIR', './summaries'),
    tempDir: env('TEMP_DIR', './tmp'),
  },

  processing: {
    maxConcurrentFeeds: envInt('MAX_CONCURRENT_FEEDS', 5),
    updateWindowHours: envInt('UPDATE_WINDOW_HOURS', 24),
    maxRetryAttempts: envInt('MAX_RETRY_ATTEMPTS', 3),
    audioDownloadTimeout: envInt('AUDIO_DOWNLOAD_TIMEOUT', 300000),
    audioMaxChunkSizeMB: envInt('AUDIO_MAX_CHUNK_SIZE_MB', 25),
  },

  scheduler: {
    cron: env('SCHEDULER_CRON', '0 2 * * *'),
    timezone: env('SCHEDULER_TIMEZONE', 'Asia/Shanghai'),
    enabled: envBool('SCHEDULER_ENABLED', true),
  },

  api: {
    port: envInt('API_PORT', 3000),
    host: env('API_HOST', '0.0.0.0'),
  },

  logging: {
    level: env('LOG_LEVEL', 'info'),
    file: env('LOG_FILE', './logs/podcast-digest.log'),
  },

  analysis: {
    summaryMinLength: envInt('SUMMARY_MIN_LENGTH', 1000),
    summaryMaxLength: envInt('SUMMARY_MAX_LENGTH', 2000),
    keyPointsCount: envInt('KEY_POINTS_COUNT', 8),
    language: env('ANALYSIS_LANGUAGE', 'zh-CN'),
  },

  pdf: {
    enabled: envBool('PDF_EXPORT_ENABLED', true),
  },

  email: {
    enabled: envBool('EMAIL_ENABLED', false),
    // Provider: 'smtp' or 'resend'
    provider: env('EMAIL_PROVIDER', 'smtp') as 'smtp' | 'resend',
    // SMTP settings
    smtpHost: env('EMAIL_SMTP_HOST', 'smtp.gmail.com'),
    smtpPort: envInt('EMAIL_SMTP_PORT', 465),
    smtpSecure: envBool('EMAIL_SMTP_SECURE', true),
    smtpUser: env('EMAIL_SMTP_USER', ''),
    smtpPass: env('EMAIL_SMTP_PASS', ''),
    // Resend settings
    resendApiKey: env('RESEND_API_KEY', ''),
    // Common
    fromAddress: env('EMAIL_FROM', ''),
    toAddress: env('EMAIL_TO', ''),
    scheduleCron: env('EMAIL_SCHEDULE_CRON', '0 8 * * *'), // default: 8:00 Beijing time
    scheduleTimezone: env('EMAIL_SCHEDULE_TIMEZONE', 'Asia/Shanghai'),
  },
};

export function ensureDirectories(): void {
  const dirs = [
    path.dirname(config.database.path),
    config.storage.summariesDir,
    config.storage.tempDir,
    path.dirname(config.logging.file),
  ];
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }
}
