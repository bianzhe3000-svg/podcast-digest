import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { config } from '../config';
import { logger } from '../utils/logger';

/**
 * 临时 ASR 音频目录（与数据库同 Volume，重新部署不丢失）
 * 仅在调用 speedUpAndCompress 时按需创建
 */
function getTempAsrDir(): string {
  return process.env.TEMP_ASR_DIR
    || path.join(path.dirname(config.database.path), 'temp-asr');
}
export const TEMP_ASR_DIR = getTempAsrDir();

/** ASR 预处理统计（最近 20 次，供 /api/debug/asr-stats 查询） */
export interface AsrStats {
  timestamp: string;
  episodeTitle?: string;
  inputDurSec: number;
  outputDurSec: number;
  durReductionPct: number;
  inputMB: number;
  outputMB: number;
  sizeReductionPct: number;
  speedFactor: number;
  oldCostCny: number;     // 旧方案（按原始时长）成本
  newCostCny: number;     // 新方案（按预处理后时长）成本
  savedCny: number;
}
const PARAFORMER_RATE_CNY_PER_SEC = 0.00015;
export const recentAsrStats: AsrStats[] = [];
function pushStat(s: AsrStats) {
  recentAsrStats.unshift(s);
  if (recentAsrStats.length > 20) recentAsrStats.length = 20;
}

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
 * ASR 预处理：广告剪除 + 静音裁剪 + 加速 + 压缩
 * 用于发给 Paraformer 之前减少计费时长。
 *
 * 处理链：
 *   1. 跳过开头 N 秒（默认 60s，多数播客开头是广告/片头）
 *   2. 截掉结尾 M 秒（默认 30s，多数播客结尾是广告/片尾）
 *   3. silenceremove 去掉对话中 ≥2 秒的静音
 *   4. atempo 加速（默认 1.5x）
 *   5. 压缩到 32kbps mono 16kHz mp3
 *
 * @returns 预处理后文件的本地路径
 */
export function preprocessForAsr(
  inputPath: string,
  outputDir: string,
  options: {
    speedFactor?: number;       // 加速倍率（默认 1.5）
    skipIntroSec?: number;      // 跳过开头秒数（默认 60）
    skipOutroSec?: number;      // 截掉结尾秒数（默认 30）
    silenceThresholdDb?: number; // 静音阈值（默认 -40 dB）
    silenceMinDurSec?: number;  // 最小静音时长（默认 2 秒）
  } = {}
): string {
  const {
    speedFactor = 1.5,
    skipIntroSec = 60,
    skipOutroSec = 30,
    silenceThresholdDb = -40,
    silenceMinDurSec = 2,
  } = options;

  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const inputSize = fs.statSync(inputPath).size;
  const inputDur = getAudioDuration(inputPath);

  // 安全检查：太短的音频不要乱裁，否则可能没内容了
  const usableSkipIntro = inputDur > skipIntroSec * 4 ? skipIntroSec : 0;
  const usableSkipOutro = inputDur > (usableSkipIntro + skipOutroSec) * 2 ? skipOutroSec : 0;
  const usableDur = inputDur - usableSkipIntro - usableSkipOutro;

  // ffmpeg atempo 仅支持 0.5-2.0；>2.0 链式
  const atempoFilter = speedFactor <= 2.0
    ? `atempo=${speedFactor}`
    : `atempo=2.0,atempo=${speedFactor / 2.0}`;

  // 滤镜链：先去静音，再加速
  const filterChain = [
    `silenceremove=stop_periods=-1:stop_duration=${silenceMinDurSec}:stop_threshold=${silenceThresholdDb}dB`,
    atempoFilter,
  ].join(',');

  const filename = `asr_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.mp3`;
  const outputPath = path.join(outputDir, filename);

  logger.info('ASR preprocessing audio', {
    speedFactor,
    inputDurSec: Math.round(inputDur),
    skipIntroSec: usableSkipIntro,
    skipOutroSec: usableSkipOutro,
    inputMB: (inputSize / 1024 / 1024).toFixed(1),
  });

  // -ss 在 -i 之前是 fast seek（不解码），在之后是 accurate seek
  // 我们用 -ss <secs> -t <usableDur> 切窗口
  const args = [
    `-ss ${usableSkipIntro}`,
    `-t ${usableDur}`,
    `-i "${inputPath}"`,
    `-af "${filterChain}"`,
    '-acodec libmp3lame',
    '-ab 32k',
    '-ar 16000',
    '-ac 1',
    `"${outputPath}"`,
    '-y',
    '-loglevel error',
  ].join(' ');

  execSync(`ffmpeg ${args}`, { timeout: 600000 });

  const outputSize = fs.statSync(outputPath).size;
  const outputDur = getAudioDuration(outputPath);
  const durReduction = inputDur > 0 ? Math.round((1 - outputDur / inputDur) * 100) : 0;
  const sizeReduction = Math.round((1 - outputSize / inputSize) * 100);
  const oldCost = inputDur * PARAFORMER_RATE_CNY_PER_SEC;
  const newCost = outputDur * PARAFORMER_RATE_CNY_PER_SEC;

  logger.info('ASR preprocessing done', {
    inputDurSec: Math.round(inputDur),
    outputDurSec: Math.round(outputDur),
    durReduction: `${durReduction}%`,
    inputMB: (inputSize / 1024 / 1024).toFixed(1),
    outputMB: (outputSize / 1024 / 1024).toFixed(1),
    sizeReduction: `${sizeReduction}%`,
    asrCostReduction: `~${durReduction}%`,
  });

  pushStat({
    timestamp: new Date().toISOString(),
    inputDurSec: Math.round(inputDur),
    outputDurSec: Math.round(outputDur),
    durReductionPct: durReduction,
    inputMB: parseFloat((inputSize / 1024 / 1024).toFixed(2)),
    outputMB: parseFloat((outputSize / 1024 / 1024).toFixed(2)),
    sizeReductionPct: sizeReduction,
    speedFactor,
    oldCostCny: parseFloat(oldCost.toFixed(4)),
    newCostCny: parseFloat(newCost.toFixed(4)),
    savedCny: parseFloat((oldCost - newCost).toFixed(4)),
  });

  return outputPath;
}

/**
 * 清理 TEMP_ASR_DIR 中超过指定时间的文件（兜底，正常每集完成后会清理）
 */
export function cleanupTempAsrFiles(maxAgeMinutes: number = 60): number {
  const dir = TEMP_ASR_DIR;
  if (!fs.existsSync(dir)) return 0;
  const cutoff = Date.now() - maxAgeMinutes * 60 * 1000;
  let removed = 0;
  for (const f of fs.readdirSync(dir)) {
    const fp = path.join(dir, f);
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
