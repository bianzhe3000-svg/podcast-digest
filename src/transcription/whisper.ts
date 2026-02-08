import OpenAI from 'openai';
import fs from 'fs';
import { config } from '../config';
import { logger } from '../utils/logger';
import { withRetry } from '../utils/retry';

export interface TranscriptionResult {
  text: string;
  language: string;
  duration?: number;
}

let openaiClient: OpenAI | null = null;

function getClient(): OpenAI {
  if (!openaiClient) {
    openaiClient = new OpenAI({
      apiKey: config.openai.apiKey,
      baseURL: config.openai.baseUrl,
      timeout: 300000,
    });
  }
  return openaiClient;
}

export async function transcribeChunkWithWhisper(audioFilePath: string): Promise<TranscriptionResult> {
  const client = getClient();
  const fileSize = fs.statSync(audioFilePath).size;

  logger.info('Transcribing chunk with Whisper', {
    path: audioFilePath,
    sizeMB: (fileSize / 1024 / 1024).toFixed(1),
  });

  const response = await withRetry(
    async () => {
      const result = await client.audio.transcriptions.create({
        file: fs.createReadStream(audioFilePath),
        model: config.openai.whisperModel,
        response_format: 'verbose_json',
        language: 'zh',
      });
      return result;
    },
    { maxAttempts: 3, baseDelayMs: 10000 }
  );

  const text = (response as any).text || '';
  const duration = (response as any).duration || 0;

  logger.info('Chunk transcription complete', {
    textLength: text.length,
    duration,
  });

  return {
    text,
    language: 'zh',
    duration,
  };
}
