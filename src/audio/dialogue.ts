/**
 * 每日播客对话音频生成
 * 1. 用 Qwen 生成双主持人对话脚本
 * 2. 逐行用 CosyVoice TTS 合成（A/B 两个声音）
 * 3. 拼接 MP3 保存到本地，供 /api/audio/:filename 路由提供下载
 */

import OpenAI from 'openai';
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import dayjs from 'dayjs';
import { config } from '../config';
import { logger } from '../utils/logger';

// 两位主持人的声音（CosyVoice-v1 内置音色）
const VOICE_A = 'longxiaochun'; // 女声·温暖（主持人甲）
const VOICE_B = 'longshu';      // 男声·专业（主持人乙）

export const AUDIO_DIR = '/tmp/podcast-audio';

interface DialogueLine {
  speaker: 'A' | 'B';
  text: string;
}

// ── 1. 生成对话脚本 ─────────────────────────────────────────────────────────

async function generateScript(episodesInput: string, dateStr: string, count: number): Promise<string> {
  const client = new OpenAI({
    apiKey: config.dashscope.apiKey,
    baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    timeout: 90000,
  });

  const prompt = `请基于以下${count}个播客剧集的内容，创作一段约15分钟的中文播客对话脚本（两位主持人）。

${episodesInput}

输出格式规则（严格遵守，每行一句台词）：
[A]: 主持人甲的台词
[B]: 主持人乙的台词

内容要求：
- 对话自然流畅，像真实播客主持人深度讨论
- 覆盖今日每个剧集的重要观点和亮点
- 中文语速约220字/分钟，15分钟需要约3300字脚本，请确保总字数在3000-3500字
- 每个剧集2-3轮对话简明展开，避免冗长
- 主持人之间有互动、追问、补充
- 开头介绍今日内容概况（约150字），结尾总结（约100字）
- 每行台词不超过80字（便于TTS合成）
- 直接输出对话，不要任何其他说明文字`;

  const response = await client.chat.completions.create({
    model: config.dashscope.textModel,
    messages: [{ role: 'user', content: prompt }],
    max_tokens: 6000,
  });

  return response.choices[0]?.message?.content || '';
}

// ── 2. 解析脚本为逐行结构 ───────────────────────────────────────────────────

function parseScript(script: string): DialogueLine[] {
  return script
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.startsWith('[A]:') || l.startsWith('[B]:'))
    .map(l => {
      const speaker = l.startsWith('[A]:') ? 'A' : 'B';
      const text = l.slice(4).trim();
      return { speaker: speaker as 'A' | 'B', text };
    })
    .filter(l => l.text.length > 0);
}

// ── 3. 单行 TTS 合成（CosyVoice-v2）────────────────────────────────────────

async function synthesize(text: string, voice: string, attempt = 1): Promise<Buffer> {
  try {
    // 使用 DashScope CosyVoice 异步 TTS API
    // 1. 创建任务（需要 task_group/task/function 字段）
    const submitRes = await axios.post(
      'https://dashscope.aliyuncs.com/api/v1/services/audio/tts',
      {
        model: 'cosyvoice-v1',
        task_group: 'audio',
        task: 'tts',
        function: 'SpeechSynthesizer',
        input: { text },
        parameters: { voice, format: 'mp3', sample_rate: 22050, volume: 50, rate: 1.0, pitch: 1.0 },
      },
      {
        headers: {
          Authorization: `Bearer ${config.dashscope.apiKey}`,
          'Content-Type': 'application/json',
          'X-DashScope-Async': 'enable',
        },
        timeout: 30000,
      }
    );

    const taskId = submitRes.data?.output?.task_id;
    if (!taskId) {
      throw new Error(`Submit failed: ${JSON.stringify(submitRes.data).slice(0, 200)}`);
    }

    // 2. 轮询任务状态
    const maxPoll = 30;  // 最多 60 秒
    let audioUrl: string | undefined;
    for (let i = 0; i < maxPoll; i++) {
      await new Promise(r => setTimeout(r, 2000));
      const pollRes = await axios.get(
        `https://dashscope.aliyuncs.com/api/v1/tasks/${taskId}`,
        {
          headers: { Authorization: `Bearer ${config.dashscope.apiKey}` },
          timeout: 15000,
        }
      );
      const status = pollRes.data?.output?.task_status;
      if (status === 'SUCCEEDED') {
        audioUrl = pollRes.data?.output?.audio_url || pollRes.data?.output?.results?.[0]?.audio_url;
        if (!audioUrl) throw new Error(`SUCCEEDED but no audio_url: ${JSON.stringify(pollRes.data).slice(0, 200)}`);
        break;
      }
      if (status === 'FAILED' || status === 'CANCELED') {
        throw new Error(`Task ${status}: ${JSON.stringify(pollRes.data?.output).slice(0, 200)}`);
      }
    }
    if (!audioUrl) throw new Error('TTS task timeout (60s)');

    // 3. 下载音频文件
    const dlRes = await axios.get(audioUrl, { responseType: 'arraybuffer', timeout: 30000 });
    return Buffer.from(dlRes.data);
  } catch (err: any) {
    const status = err.response?.status;
    if ((status === 429 || (status >= 500 && status < 600)) && attempt < 3) {
      const delay = 1500 * Math.pow(2, attempt - 1);
      logger.warn(`TTS retry ${attempt + 1}/3 after ${delay}ms (status=${status})`);
      await new Promise(r => setTimeout(r, delay));
      return synthesize(text, voice, attempt + 1);
    }
    let errMsg = err.message;
    if (err.response?.data) {
      try {
        const txt = typeof err.response.data === 'string'
          ? err.response.data
          : Buffer.isBuffer(err.response.data)
            ? Buffer.from(err.response.data).toString('utf-8')
            : JSON.stringify(err.response.data);
        errMsg = `${status} ${txt.slice(0, 300)}`;
      } catch {}
    }
    throw new Error(`TTS ${status || 'network'}: ${errMsg}`);
  }
}

/** 单次测试 TTS，供 /api/debug/test-tts 使用 */
export async function testTts(text = '你好，这是 CosyVoice 语音合成测试。'): Promise<{ ok: boolean; sizeBytes?: number; error?: string }> {
  try {
    const buf = await synthesize(text, VOICE_A);
    return { ok: true, sizeBytes: buf.length };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

// ── 4. 主入口 ───────────────────────────────────────────────────────────────

/**
 * 生成当日播客对话音频，返回文件名（null 表示失败）
 */
export async function generateDailyDialogue(
  episodesInput: string,
  dateStr: string,
  episodeCount: number
): Promise<string | null> {
  try {
    // 4-1. 生成脚本
    logger.info('Generating dialogue script', { episodeCount });
    const script = await generateScript(episodesInput, dateStr, episodeCount);
    if (!script) throw new Error('Empty dialogue script');

    const lines = parseScript(script);
    logger.info(`Dialogue parsed: ${lines.length} lines`);
    if (lines.length === 0) throw new Error('No dialogue lines parsed');

    // 4-2. 并发合成（每批3条，避免限流）
    const BATCH = 3;
    const buffers: Buffer[] = [];

    for (let i = 0; i < lines.length; i += BATCH) {
      const batch = lines.slice(i, i + BATCH);
      const results = await Promise.all(
        batch.map((line, j) => {
          const voice = line.speaker === 'A' ? VOICE_A : VOICE_B;
          logger.info(`TTS ${i + j + 1}/${lines.length} [${line.speaker}]`);
          return synthesize(line.text, voice).catch(err => {
            logger.warn(`TTS failed line ${i + j + 1}`, { error: err.message });
            return Buffer.alloc(0); // 跳过失败行
          });
        })
      );
      buffers.push(...results);
    }

    const combined = Buffer.concat(buffers.filter(b => b.length > 0));
    if (combined.length === 0) throw new Error('All TTS segments failed');

    // 4-3. 保存文件
    fs.mkdirSync(AUDIO_DIR, { recursive: true });
    const filename = `digest-${dayjs().format('YYYY-MM-DD')}.mp3`;
    const filePath = path.join(AUDIO_DIR, filename);
    fs.writeFileSync(filePath, combined);

    const durationMin = Math.round(combined.length / (32000 / 8) / 60); // 估算时长（32kbps）
    logger.info('Daily dialogue audio ready', { filename, sizeKB: Math.round(combined.length / 1024), durationMin });

    return filename;
  } catch (err) {
    logger.error('generateDailyDialogue failed', { error: (err as Error).message });
    return null;
  }
}

/**
 * 估算音频时长（分钟）
 */
export function estimateAudioDuration(filename: string): number {
  try {
    const filePath = path.join(AUDIO_DIR, filename);
    const size = fs.statSync(filePath).size;
    return Math.max(1, Math.round(size / (64000 / 8) / 60)); // 估算按64kbps
  } catch {
    return 5; // 默认5分钟
  }
}
