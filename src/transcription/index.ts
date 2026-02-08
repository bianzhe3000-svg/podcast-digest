import fs from 'fs';
import { config } from '../config';
import { logger } from '../utils/logger';
import { prepareAudioForUpload } from '../audio';
import { transcribeChunkWithWhisper, TranscriptionResult } from './whisper';

export type { TranscriptionResult } from './whisper';

export async function transcribeAudio(audioFilePath: string): Promise<TranscriptionResult> {
  logger.info('Starting transcription', { path: audioFilePath, provider: config.transcriptionProvider });

  const chunks = await prepareAudioForUpload(
    audioFilePath,
    config.storage.tempDir,
    config.processing.audioMaxChunkSizeMB
  );

  logger.info(`Audio prepared: ${chunks.length} chunk(s)`);

  const results: string[] = [];
  let totalDuration = 0;

  for (let i = 0; i < chunks.length; i++) {
    logger.info(`Transcribing chunk ${i + 1}/${chunks.length}`);

    let result: TranscriptionResult;
    if (config.transcriptionProvider === 'openai') {
      result = await transcribeChunkWithWhisper(chunks[i]);
    } else {
      throw new Error(`Unsupported transcription provider: ${config.transcriptionProvider}`);
    }

    results.push(result.text);
    totalDuration += result.duration || 0;

    // Clean up temporary chunk files
    if (chunks[i] !== audioFilePath) {
      try { fs.unlinkSync(chunks[i]); } catch {}
    }
  }

  const fullText = results.join(' ').trim();
  logger.info('Transcription complete', {
    textLength: fullText.length,
    totalDuration,
    chunks: chunks.length,
  });

  return {
    text: fullText,
    language: 'zh',
    duration: totalDuration,
  };
}
