import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { config } from '../config';
import { logger } from '../utils/logger';

// 持久化 Volume 上的临时音频目录（用于 Paraformer URL 的临时托管）
// 1 小时自动清理
export const TEMP_ASR_DIR = process.env.TEMP_ASR_DIR
  || path.join(path.dirname(config.database.path), 'temp-asr');

export function hasFFmpeg(): boolean {
  try {
    execSync('ffmpeg -version', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export function getAudioDuration(filePath: string): number {
  try {
    const output = execSync(
      `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${filePath}"`,
      { encoding: 'utf-8' }
    );
    return parseFloat(output.trim()) || 0;
  } catch (error) {
    logger.warn('Failed to get audio duration', { path: filePath, error: (error as Error).message });
    return 0;
  }
}

export function compressAudio(inputPath: string, outputDir: string): string {
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const outputPath = path.join(outputDir, `compressed_${Date.now()}.mp3`);

  logger.info('Compressing audio', { input: inputPath });

  execSync(
    `ffmpeg -i "${inputPath}" -acodec libmp3lame -ab 32k -ar 16000 -ac 1 "${outputPath}" -y -loglevel error`,
    { timeout: 600000 }
  );

  const inputSize = fs.statSync(inputPath).size;
  const outputSize = fs.statSync(outputPath).size;
  const reduction = Math.round((1 - outputSize / inputSize) * 100);

  logger.info('Audio compressed', {
    inputMB: (inputSize / 1024 / 1024).toFixed(1),
    outputMB: (outputSize / 1024 / 1024).toFixed(1),
    reduction: `${reduction}%`,
  });

  return outputPath;
}

export function splitAudio(inputPath: string, outputDir: string, maxSizeMB: number): string[] {
  const fileSize = fs.statSync(inputPath).size;
  const maxBytes = maxSizeMB * 1024 * 1024;

  if (fileSize <= maxBytes) return [inputPath];

  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const duration = getAudioDuration(inputPath);
  if (duration <= 0) {
    logger.warn('Cannot determine audio duration for splitting, returning as-is');
    return [inputPath];
  }

  const numChunks = Math.ceil(fileSize / maxBytes);
  const chunkDuration = Math.floor(duration / numChunks);

  logger.info('Splitting audio', { fileSize: fileSize, chunks: numChunks, chunkDuration });

  const chunks: string[] = [];
  for (let i = 0; i < numChunks; i++) {
    const start = i * chunkDuration;
    const outputPath = path.join(outputDir, `chunk_${i}_${Date.now()}.mp3`);

    execSync(
      `ffmpeg -i "${inputPath}" -ss ${start} -t ${chunkDuration} -acodec libmp3lame -ab 32k -ar 16000 -ac 1 "${outputPath}" -y -loglevel error`,
      { timeout: 300000 }
    );

    if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > 0) {
      chunks.push(outputPath);
    }
  }

  logger.info(`Audio split into ${chunks.length} chunks`);
  return chunks;
}

/**
 * 加速 + 压缩音频，用于 ASR 转录前的预处理（降低 Paraformer 计费时长）
 * @param inputPath 输入音频文件路径
 * @param outputDir 输出目录（建议 TEMP_ASR_DIR）
 * @param speedFactor 加速倍率（1.5 = 1.5 倍速，通常 1.5x 不影响识别准确率）
 * @returns 加速后文件的本地路径
 */
export function speedUpAndCompress(
  inputPath: string,
  outputDir: string,
  speedFactor: number = 1.5
): string {
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  // ffmpeg atempo 仅支持 0.5-2.0；如果需要 >2.0，可链式 atempo=2.0,atempo=1.5 实现 3.0x
  const atempoFilter = speedFactor <= 2.0
    ? `atempo=${speedFactor}`
    : `atempo=2.0,atempo=${speedFactor / 2.0}`;

  const filename = `asr_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.mp3`;
  const outputPath = path.join(outputDir, filename);

  const inputSize = fs.statSync(inputPath).size;
  const inputDur = getAudioDuration(inputPath);

  logger.info('Speeding up audio for ASR', {
    speedFactor,
    inputDurationSec: Math.round(inputDur),
    inputMB: (inputSize / 1024 / 1024).toFixed(1),
  });

  execSync(
    `ffmpeg -i "${inputPath}" -filter:a "${atempoFilter}" -acodec libmp3lame -ab 32k -ar 16000 -ac 1 "${outputPath}" -y -loglevel error`,
    { timeout: 600000 }
  );

  const outputSize = fs.statSync(outputPath).size;
  const outputDur = getAudioDuration(outputPath);
  const sizeReduction = Math.round((1 - outputSize / inputSize) * 100);
  const durReduction = inputDur > 0 ? Math.round((1 - outputDur / inputDur) * 100) : 0;

  logger.info('Audio sped up + compressed', {
    speedFactor,
    inputDurationSec: Math.round(inputDur),
    outputDurationSec: Math.round(outputDur),
    durationReduction: `${durReduction}%`,
    inputMB: (inputSize / 1024 / 1024).toFixed(1),
    outputMB: (outputSize / 1024 / 1024).toFixed(1),
    sizeReduction: `${sizeReduction}%`,
    asrCostReduction: `~${durReduction}%`,
  });

  return outputPath;
}

/**
 * 清理 TEMP_ASR_DIR 中超过指定时间的文件
 * @param maxAgeMinutes 文件最大保留时长（分钟）
 */
export function cleanupTempAsrFiles(maxAgeMinutes: number = 60): number {
  if (!fs.existsSync(TEMP_ASR_DIR)) return 0;
  const cutoff = Date.now() - maxAgeMinutes * 60 * 1000;
  let removed = 0;
  for (const f of fs.readdirSync(TEMP_ASR_DIR)) {
    const fp = path.join(TEMP_ASR_DIR, f);
    try {
      if (fs.statSync(fp).mtimeMs < cutoff) {
        fs.unlinkSync(fp);
        removed++;
      }
    } catch {}
  }
  return removed;
}

export async function prepareAudioForUpload(
  inputPath: string,
  tempDir: string,
  maxChunkMB: number
): Promise<string[]> {
  if (!hasFFmpeg()) {
    logger.warn('ffmpeg not found, uploading raw audio');
    return [inputPath];
  }

  const compressed = compressAudio(inputPath, tempDir);
  const chunks = splitAudio(compressed, tempDir, maxChunkMB);

  // Clean up compressed file if it was split
  if (chunks.length > 1 && chunks[0] !== compressed) {
    try { fs.unlinkSync(compressed); } catch {}
  }

  return chunks;
}
