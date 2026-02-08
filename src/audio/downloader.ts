import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { config } from '../config';
import { logger } from '../utils/logger';
import { withRetry } from '../utils/retry';

export async function downloadAudio(audioUrl: string, outputDir: string): Promise<string> {
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const urlPath = new URL(audioUrl).pathname;
  const ext = path.extname(urlPath) || '.mp3';
  const filename = `download_${Date.now()}${ext}`;
  const outputPath = path.join(outputDir, filename);

  logger.info('Downloading audio', { url: audioUrl.substring(0, 100), output: outputPath });

  await withRetry(
    async () => {
      const response = await axios({
        method: 'get',
        url: audioUrl,
        responseType: 'stream',
        timeout: config.processing.audioDownloadTimeout,
        headers: {
          'User-Agent': 'PodcastDigest/2.0',
        },
      });

      const writer = fs.createWriteStream(outputPath);
      const totalBytes = parseInt(response.headers['content-length'] || '0', 10);
      let downloadedBytes = 0;

      response.data.on('data', (chunk: Buffer) => {
        downloadedBytes += chunk.length;
        if (totalBytes > 0 && downloadedBytes % (5 * 1024 * 1024) < chunk.length) {
          const pct = Math.round(downloadedBytes / totalBytes * 100);
          logger.info(`Download progress: ${pct}%`, { bytes: downloadedBytes, total: totalBytes });
        }
      });

      response.data.pipe(writer);

      await new Promise<void>((resolve, reject) => {
        writer.on('finish', resolve);
        writer.on('error', reject);
        response.data.on('error', reject);
      });
    },
    { maxAttempts: 3, baseDelayMs: 5000 }
  );

  const stats = fs.statSync(outputPath);
  logger.info('Audio downloaded', { path: outputPath, sizeMB: (stats.size / 1024 / 1024).toFixed(1) });
  return outputPath;
}
