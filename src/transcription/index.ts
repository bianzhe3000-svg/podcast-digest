import fs from 'fs';
import { config } from '../config';
import { logger } from '../utils/logger';
import { prepareAudioForUpload } from '../audio';
import { transcribeChunkWithWhisper, TranscriptionResult } from './whisper';
import { transcribeWithParaformer } from './paraformer';

export type { TranscriptionResult } from './whisper';

/**
 * 转录音频文件
 * @param audioFilePath 本地音频文件路径（OpenAI Whisper 模式使用）
 * @param audioUrl 远程音频 URL（DashScope Paraformer 模式使用）
 */
export async function transcribeAudio(
  audioFilePath: string,
  audioUrl?: string
): Promise<TranscriptionResult> {
  logger.info('Starting transcription', {
    path: audioFilePath,
    audioUrl: audioUrl?.substring(0, 80),
    provider: config.transcriptionProvider,
  });

  // DashScope Paraformer: 直接传 URL，无需下载/压缩/分割
  if (config.transcriptionProvider === 'dashscope') {
    if (!audioUrl) {
      throw new Error('DashScope transcription requires audio URL but none provided');
    }
    return transcribeWithParaformer(audioUrl);
  }

  // OpenAI Whisper: 本地文件 → 压缩 → 分割 → 逐段转录
  if (config.transcriptionProvider === 'openai') {
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

      const result = await transcribeChunkWithWhisper(chunks[i]);
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

  throw new Error(`Unsupported transcription provider: ${config.transcriptionProvider}`);
}
