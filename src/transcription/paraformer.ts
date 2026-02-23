import axios from 'axios';
import fs from 'fs';
import path from 'path';
import FormData from 'form-data';
import { config } from '../config';
import { logger } from '../utils/logger';
import { TranscriptionResult } from './whisper';

const DASHSCOPE_ASR_URL = 'https://dashscope.aliyuncs.com/api/v1/services/audio/asr/transcription';
const DASHSCOPE_TASK_URL = 'https://dashscope.aliyuncs.com/api/v1/tasks';
const DASHSCOPE_UPLOAD_POLICY_URL = 'https://dashscope.aliyuncs.com/api/v1/uploads';

// 轮询配置
const POLL_INITIAL_INTERVAL_MS = 10000; // 前 5 次每 10 秒
const POLL_LATER_INTERVAL_MS = 30000;   // 之后每 30 秒
const POLL_INITIAL_COUNT = 5;
const POLL_MAX_TIMEOUT_MS = 30 * 60 * 1000; // 30 分钟

interface ParaformerSubmitResponse {
  output: {
    task_status: string;
    task_id: string;
  };
  request_id: string;
}

interface ParaformerTaskResponse {
  output: {
    task_id: string;
    task_status: 'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED';
    results?: {
      file_url: string;
      transcription_url: string;
      subtask_status: string;
    }[];
    message?: string;
    code?: string;
  };
  request_id: string;
}

interface ParaformerTranscript {
  file_url: string;
  properties?: {
    audio_format?: string;
    original_sampling_rate?: number;
    original_duration_in_milliseconds?: number;
  };
  transcripts: {
    channel_id: number;
    text: string;
    sentences?: {
      begin_time: number;
      end_time: number;
      text: string;
    }[];
  }[];
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 解析重定向链接，获取最终的真实 URL
 * 很多播客音频 URL 经过 podtrac/chartable 等追踪服务多次 302 重定向
 * Paraformer 可能无法跟随这些重定向，所以先解析出最终 URL
 */
async function resolveRedirects(url: string): Promise<string> {
  try {
    const response = await axios.head(url, {
      maxRedirects: 10,
      timeout: 15000,
      headers: {
        'User-Agent': 'PodcastDigest/2.0',
      },
      // axios 默认会跟随重定向，最终 response.request.res.responseUrl 就是最终 URL
    });

    // axios 跟随重定向后，最终 URL 在 response.request.res.responseUrl
    const finalUrl = (response.request as any)?.res?.responseUrl || url;

    if (finalUrl !== url) {
      logger.info('Resolved redirect URL', {
        original: url.substring(0, 80),
        final: finalUrl.substring(0, 120),
      });
    }

    return finalUrl;
  } catch (error) {
    // HEAD 请求失败时，尝试 GET 请求（某些 CDN 不支持 HEAD）
    try {
      const response = await axios.get(url, {
        maxRedirects: 10,
        timeout: 15000,
        headers: { 'User-Agent': 'PodcastDigest/2.0', 'Range': 'bytes=0-0' },
        responseType: 'stream',
      });
      const finalUrl = (response.request as any)?.res?.responseUrl || url;
      // 关闭流
      response.data.destroy();
      if (finalUrl !== url) {
        logger.info('Resolved redirect URL (via GET)', {
          original: url.substring(0, 80),
          final: finalUrl.substring(0, 120),
        });
      }
      return finalUrl;
    } catch {
      logger.warn('Failed to resolve redirects, using original URL', { url: url.substring(0, 80) });
      return url;
    }
  }
}

/**
 * 下载音频文件到本地，然后上传到 DashScope OSS 获取 oss:// URL
 */
async function downloadAndUploadToDashScope(audioUrl: string, apiKey: string): Promise<string> {
  const tempDir = config.storage.tempDir;
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }
  const tempPath = path.join(tempDir, `upload_${Date.now()}.mp3`);

  try {
    // Step 1: 下载音频到本地
    logger.info('Downloading audio for DashScope upload', { url: audioUrl.substring(0, 100) });
    const downloadResponse = await axios({
      method: 'get',
      url: audioUrl,
      responseType: 'stream',
      timeout: Math.max(config.processing.audioDownloadTimeout, 600000), // 至少 10 分钟
      maxRedirects: 10,
      headers: { 'User-Agent': 'PodcastDigest/2.0' },
    });

    const writer = fs.createWriteStream(tempPath);
    downloadResponse.data.pipe(writer);
    await new Promise<void>((resolve, reject) => {
      writer.on('finish', resolve);
      writer.on('error', reject);
      downloadResponse.data.on('error', reject);
    });

    const fileSize = fs.statSync(tempPath).size;
    logger.info('Audio downloaded for upload', { sizeMB: (fileSize / 1024 / 1024).toFixed(1) });

    // Step 2: 获取 DashScope 上传凭证
    logger.info('Getting DashScope upload policy');
    const policyResponse = await axios.get(DASHSCOPE_UPLOAD_POLICY_URL, {
      params: { action: 'getPolicy', model: config.dashscope.speechModel },
      headers: { 'Authorization': `Bearer ${apiKey}` },
      timeout: 15000,
    });

    const policy = policyResponse.data?.data;
    if (!policy?.policy || !policy?.signature || !policy?.upload_host || !policy?.upload_dir) {
      throw new Error(`Failed to get upload policy: ${JSON.stringify(policyResponse.data).substring(0, 300)}`);
    }

    // Step 3: 上传文件到 OSS
    const filename = path.basename(tempPath);
    const ossKey = `${policy.upload_dir}/${filename}`;

    const form = new FormData();
    form.append('OSSAccessKeyId', policy.oss_access_key_id);
    form.append('Signature', policy.signature);
    form.append('policy', policy.policy);
    form.append('key', ossKey);
    form.append('x-oss-object-acl', 'private');
    form.append('x-oss-forbid-overwrite', 'true');
    form.append('success_action_status', '200');
    form.append('file', fs.createReadStream(tempPath));

    logger.info('Uploading audio to DashScope OSS', { ossKey });
    await axios.post(policy.upload_host, form, {
      headers: form.getHeaders(),
      timeout: 600000, // 10 分钟，大音频文件上传需要更多时间
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
    });

    const ossUrl = `oss://${ossKey}`;
    logger.info('Audio uploaded to DashScope OSS', { ossUrl });
    return ossUrl;
  } finally {
    // 清理临时文件
    if (fs.existsSync(tempPath)) {
      try { fs.unlinkSync(tempPath); } catch {}
    }
  }
}

/**
 * 提交 Paraformer 转录任务并轮询结果
 */
async function submitAndPollParaformer(
  fileUrl: string,
  apiKey: string,
  model: string,
  useOssResolve: boolean = false
): Promise<TranscriptionResult> {
  const headers: Record<string, string> = {
    'Authorization': `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
    'X-DashScope-Async': 'enable',
  };
  if (useOssResolve) {
    headers['X-DashScope-OssResourceResolve'] = 'enable';
  }

  const submitResponse = await axios.post<ParaformerSubmitResponse>(
    DASHSCOPE_ASR_URL,
    {
      model,
      input: { file_urls: [fileUrl] },
      parameters: { language_hints: ['zh', 'en'] },
    },
    { headers, timeout: 30000 }
  );

  const taskId = submitResponse.data?.output?.task_id;
  if (!taskId) {
    throw new Error(`Paraformer submit failed: no task_id. Response: ${JSON.stringify(submitResponse.data).substring(0, 500)}`);
  }

  logger.info('Paraformer task submitted', { taskId, status: submitResponse.data.output.task_status, fileUrl: fileUrl.substring(0, 80) });

  // 轮询任务状态
  const startTime = Date.now();
  let pollCount = 0;

  while (true) {
    const elapsed = Date.now() - startTime;
    if (elapsed > POLL_MAX_TIMEOUT_MS) {
      throw new Error(`Paraformer task timed out after ${Math.round(elapsed / 60000)} minutes (taskId: ${taskId})`);
    }

    const interval = pollCount < POLL_INITIAL_COUNT ? POLL_INITIAL_INTERVAL_MS : POLL_LATER_INTERVAL_MS;
    await sleep(interval);
    pollCount++;

    try {
      const taskResponse = await axios.get<ParaformerTaskResponse>(
        `${DASHSCOPE_TASK_URL}/${taskId}`,
        { headers: { 'Authorization': `Bearer ${apiKey}` }, timeout: 15000 }
      );

      const status = taskResponse.data?.output?.task_status;
      logger.info(`Paraformer poll #${pollCount}`, { taskId, status, elapsed: `${Math.round(elapsed / 1000)}s` });

      if (status === 'SUCCEEDED') {
        return await extractTranscriptionResult(taskResponse.data, apiKey);
      }

      if (status === 'FAILED') {
        const msg = taskResponse.data?.output?.message || 'Unknown error';
        const code = taskResponse.data?.output?.code || '';
        throw new Error(`Paraformer task failed: ${code} ${msg} (taskId: ${taskId})`);
      }
    } catch (error) {
      if ((error as Error).message.includes('Paraformer task failed')) {
        throw error;
      }
      logger.warn(`Paraformer poll error (will retry)`, { taskId, error: (error as Error).message, pollCount });
    }
  }
}

/**
 * 使用阿里云百炼 Paraformer 进行录音文件转录
 * 1. 先尝试直接传 URL
 * 2. 如果 Paraformer 无法下载（FILE_DOWNLOAD_FAILED/FILE_403_FORBIDDEN），
 *    自动回退到下载→上传 DashScope OSS→用 oss:// URL 重新提交
 */
export async function transcribeWithParaformer(audioUrl: string): Promise<TranscriptionResult> {
  const apiKey = config.dashscope.apiKey;
  if (!apiKey) {
    throw new Error('DASHSCOPE_API_KEY is not configured');
  }

  // 解析重定向链接（podtrac/chartable/swap.fm 等追踪服务）
  const resolvedUrl = await resolveRedirects(audioUrl);
  const model = config.dashscope.speechModel;

  logger.info('Submitting Paraformer transcription task', { audioUrl: resolvedUrl.substring(0, 120), model });

  try {
    // 第一次尝试：直接传 URL
    return await submitAndPollParaformer(resolvedUrl, apiKey, model);
  } catch (error) {
    const errMsg = (error as Error).message;

    // 判断是否是文件下载失败错误
    if (errMsg.includes('FILE_DOWNLOAD_FAILED') || errMsg.includes('FILE_403_FORBIDDEN')) {
      logger.warn('Paraformer cannot download audio URL, falling back to upload mode', {
        originalUrl: audioUrl.substring(0, 80),
        error: errMsg,
      });

      // 回退：下载到本地 → 上传 DashScope OSS → 用 oss:// URL 重试
      const ossUrl = await downloadAndUploadToDashScope(audioUrl, apiKey);
      return await submitAndPollParaformer(ossUrl, apiKey, model, true);
    }

    // 其他错误直接抛出
    throw error;
  }
}

/**
 * 从 Paraformer 任务结果中提取转录文本
 */
async function extractTranscriptionResult(
  taskResponse: ParaformerTaskResponse,
  apiKey: string
): Promise<TranscriptionResult> {
  const results = taskResponse.output?.results;
  if (!results || results.length === 0) {
    throw new Error('Paraformer task succeeded but no results returned');
  }

  const firstResult = results[0];
  if (firstResult.subtask_status !== 'SUCCEEDED') {
    throw new Error(`Paraformer subtask failed: ${firstResult.subtask_status}`);
  }

  const transcriptionUrl = firstResult.transcription_url;
  if (!transcriptionUrl) {
    throw new Error('Paraformer: no transcription_url in result');
  }

  logger.info('Downloading Paraformer transcription result', { url: transcriptionUrl.substring(0, 100) });

  // 下载转录结果 JSON
  const transcriptResponse = await axios.get<ParaformerTranscript>(transcriptionUrl, {
    timeout: 30000,
    // transcription_url 是 OSS 公开链接，不需要认证
  });

  const transcriptData = transcriptResponse.data;

  // 拼接所有 channel 的文本
  const texts: string[] = [];
  let totalDurationMs = 0;

  if (transcriptData.transcripts && transcriptData.transcripts.length > 0) {
    for (const transcript of transcriptData.transcripts) {
      if (transcript.text) {
        texts.push(transcript.text);
      }
    }
  }

  // 从 properties 获取时长
  if (transcriptData.properties?.original_duration_in_milliseconds) {
    totalDurationMs = transcriptData.properties.original_duration_in_milliseconds;
  }

  const fullText = texts.join(' ').trim();
  const durationSeconds = Math.round(totalDurationMs / 1000);

  logger.info('Paraformer transcription complete', {
    textLength: fullText.length,
    durationSeconds,
    channels: transcriptData.transcripts?.length || 0,
  });

  return {
    text: fullText,
    language: 'zh',
    duration: durationSeconds,
  };
}
