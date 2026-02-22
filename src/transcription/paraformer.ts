import axios from 'axios';
import { config } from '../config';
import { logger } from '../utils/logger';
import { TranscriptionResult } from './whisper';

const DASHSCOPE_ASR_URL = 'https://dashscope.aliyuncs.com/api/v1/services/audio/asr/transcription';
const DASHSCOPE_TASK_URL = 'https://dashscope.aliyuncs.com/api/v1/tasks';

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
 * 使用阿里云百炼 Paraformer 进行录音文件转录
 * 直接传入播客音频 URL，无需下载/压缩/分割
 */
export async function transcribeWithParaformer(audioUrl: string): Promise<TranscriptionResult> {
  const apiKey = config.dashscope.apiKey;
  if (!apiKey) {
    throw new Error('DASHSCOPE_API_KEY is not configured');
  }

  const model = config.dashscope.speechModel;
  logger.info('Submitting Paraformer transcription task', { audioUrl: audioUrl.substring(0, 120), model });

  // Step 1: 提交异步转录任务
  const submitResponse = await axios.post<ParaformerSubmitResponse>(
    DASHSCOPE_ASR_URL,
    {
      model,
      input: {
        file_urls: [audioUrl],
      },
      parameters: {
        language_hints: ['zh', 'en'],
      },
    },
    {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'X-DashScope-Async': 'enable',
      },
      timeout: 30000,
    }
  );

  const taskId = submitResponse.data?.output?.task_id;
  if (!taskId) {
    throw new Error(`Paraformer submit failed: no task_id in response. Response: ${JSON.stringify(submitResponse.data).substring(0, 500)}`);
  }

  logger.info('Paraformer task submitted', { taskId, status: submitResponse.data.output.task_status });

  // Step 2: 轮询任务状态
  const startTime = Date.now();
  let pollCount = 0;

  while (true) {
    const elapsed = Date.now() - startTime;
    if (elapsed > POLL_MAX_TIMEOUT_MS) {
      throw new Error(`Paraformer task timed out after ${Math.round(elapsed / 60000)} minutes (taskId: ${taskId})`);
    }

    // 动态轮询间隔
    const interval = pollCount < POLL_INITIAL_COUNT ? POLL_INITIAL_INTERVAL_MS : POLL_LATER_INTERVAL_MS;
    await sleep(interval);
    pollCount++;

    try {
      const taskResponse = await axios.get<ParaformerTaskResponse>(
        `${DASHSCOPE_TASK_URL}/${taskId}`,
        {
          headers: {
            'Authorization': `Bearer ${apiKey}`,
          },
          timeout: 15000,
        }
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

      // PENDING or RUNNING - continue polling
    } catch (error) {
      if ((error as Error).message.includes('Paraformer task failed')) {
        throw error;
      }
      // 网络临时错误，继续轮询
      logger.warn(`Paraformer poll error (will retry)`, {
        taskId,
        error: (error as Error).message,
        pollCount,
      });
    }
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
