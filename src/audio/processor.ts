import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { logger } from '../utils/logger';

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
