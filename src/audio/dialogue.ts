/**
 * 每日播客精华音频生成（极简版）
 * 1. 用 LLM 生成 ~6000 字的播报脚本（单人朗读，自然旁白风格）
 * 2. 按句号切成 3-5 个 ~2000 字的大块
 * 3. 每块调用一次 Qwen-TTS-Flash
 * 4. 拼接 MP3 保存到 Volume
 */

import OpenAI from 'openai';
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';
import { config } from '../config';
import { logger } from '../utils/logger';

dayjs.extend(utc);
dayjs.extend(timezone);

// 音色（Qwen3-TTS-Flash 内置）
const VOICE = 'Cherry';                   // 女声·阳光
const MAX_CHARS_PER_TTS = 1000;            // 实测 ~1000 字内 60s 完成，保守值

// 音频持久化目录（与数据库同 Volume，不会随 Railway 重新部署丢失）
export const AUDIO_DIR = process.env.AUDIO_DIR
  || path.join(path.dirname(config.database.path), 'audio');

// ── 1. 生成单人播报脚本 ─────────────────────────────────────────────────────

async function generateScript(episodesInput: string, count: number, onStage?: (s: string) => void): Promise<string> {
  const scriptModel = process.env.DASHSCOPE_SCRIPT_MODEL || 'qwen-plus';

  // 把剧集分成前后两半，分两次 LLM 调用各生成 ~6500 字（避免 qwen-plus 8K token 输出上限）
  const halfBoundary = Math.ceil(count / 2);
  // episodesInput 用 '---' 分隔，按这个切
  const segments = episodesInput.split(/\n\n---\n\n/);
  const part1Episodes = segments.slice(0, halfBoundary).join('\n\n---\n\n');
  const part2Episodes = segments.slice(halfBoundary).join('\n\n---\n\n');

  const buildPrompt = (part: 'first' | 'second', episodes: string, partCount: number) => {
    if (part === 'first') {
      return `请基于以下 ${partCount} 个播客剧集的内容，撰写**中文播客播报文稿的前半部分**（单人主持口吻）。

${episodes}

【硬性要求】
- **本段总字数 6500-7500 字**
- 必须涵盖以上 ${partCount} 个剧集的内容，每集独立成段，约 ${Math.floor(6500 / partCount)} 字
- 包含开场白（约200字介绍今日内容概况），不要写结尾（后半部分会续写）
- 像电台主持人朗读早间新闻精选，自然流畅
- 使用过渡词："接下来"、"另一方面"、"值得一提的是"
- **直接输出正文**，不要任何标题、markdown、列表符号
- 不要 [A]:、[B]: 标记，连贯散文
- 标点正常便于朗读

请开始撰写前半部分：`;
    } else {
      return `请基于以下 ${partCount} 个播客剧集的内容，续写**中文播客播报文稿的后半部分**（单人主持口吻，承接前半部分）。

${episodes}

【硬性要求】
- **本段总字数 6500-7500 字**
- 必须涵盖以上 ${partCount} 个剧集的内容，每集独立成段，约 ${Math.floor(6500 / partCount)} 字
- 开头用过渡句承接前半（如"接下来我们看……"），不要重复开场介绍
- 包含结尾（约200字总结今日全天精华+鼓励性结束语）
- 像电台主持人朗读早间新闻精选，自然流畅
- **直接输出正文**，不要任何标题、markdown、列表符号
- 不要 [A]:、[B]: 标记，连贯散文
- 标点正常便于朗读

请开始撰写后半部分：`;
    }
  };

  const callOnce = async (prompt: string, label: string): Promise<string> => {
    logger.info(`Generating script ${label} with ${scriptModel}`);
    const ac = new AbortController();
    const abortTimer = setTimeout(() => ac.abort(), 200000);

    const apiPromise = axios.post(
      'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
      {
        model: scriptModel,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 8000,
      },
      {
        headers: {
          Authorization: `Bearer ${config.dashscope.apiKey}`,
          'Content-Type': 'application/json',
        },
        timeout: 200000,
        signal: ac.signal,
      }
    ).then(r => r.data?.choices?.[0]?.message?.content || '');

    // 双重保险：Promise.race 绝对超时 220s（即使 axios+abort 都失效）
    const hardTimeout = new Promise<string>((_, reject) =>
      setTimeout(() => reject(new Error(`script ${label} ABSOLUTE TIMEOUT 220s`)), 220000)
    );

    try {
      return await Promise.race([apiPromise, hardTimeout]);
    } finally {
      clearTimeout(abortTimer);
      // 强制 abort，防止 leaked promise 占连接
      try { ac.abort(); } catch {}
    }
  };

  onStage?.('script_part1_generating');
  const part1 = await callOnce(buildPrompt('first', part1Episodes, halfBoundary), 'part1');
  onStage?.(`script_part1_done (${part1.length} chars)`);

  onStage?.('script_part2_generating');
  const part2 = await callOnce(buildPrompt('second', part2Episodes, count - halfBoundary), 'part2');
  onStage?.(`script_part2_done (${part2.length} chars)`);

  const combined = part1 + '\n\n' + part2;
  logger.info(`Script combined: ${part1.length} + ${part2.length} = ${combined.length} chars`);
  return combined;
}

// ── 2. 按句号切成大块 ────────────────────────────────────────────────────────

function chunkScript(script: string, maxChars: number = MAX_CHARS_PER_TTS): string[] {
  // 按"句号/问号/感叹号"切句，再贪心合并到 maxChars
  const sentences = script
    .replace(/\s+/g, ' ')                          // 折叠空白
    .split(/(?<=[。！？!?])/)                       // 句号后切分
    .map(s => s.trim())
    .filter(Boolean);

  const chunks: string[] = [];
  let current = '';
  for (const s of sentences) {
    if (current.length + s.length <= maxChars) {
      current += s;
    } else {
      if (current) chunks.push(current);
      // 单句超长（极少见）：硬切
      if (s.length > maxChars) {
        for (let i = 0; i < s.length; i += maxChars) {
          chunks.push(s.slice(i, i + maxChars));
        }
        current = '';
      } else {
        current = s;
      }
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

// ── 3. 单次 TTS 调用 ────────────────────────────────────────────────────────

async function synthesizeOnce(text: string, voice: string = VOICE): Promise<Buffer> {
  const callPromise = (async () => {
    // 合成本身可能需要 60-120 秒（处理时间 ∝ 文本长度），正常语速朗读
    const res = await axios.post(
      'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation',
      {
        model: 'qwen3-tts-flash',
        input: { text, voice, language_type: 'Chinese' },
      },
      {
        headers: {
          Authorization: `Bearer ${config.dashscope.apiKey}`,
          'Content-Type': 'application/json',
        },
        timeout: 240000,  // 4 分钟，匹配外层 Promise.race
      }
    );
    const audioUrl: string | undefined =
      res.data?.output?.audio?.url ||
      res.data?.output?.audio_url ||
      res.data?.output?.results?.[0]?.audio?.url;
    if (!audioUrl) {
      throw new Error(`No audio URL in response: ${JSON.stringify(res.data).slice(0, 300)}`);
    }
    // 下载可能是几 MB 音频，给充足时间
    const dl = await axios.get(audioUrl, { responseType: 'arraybuffer', timeout: 60000 });
    return Buffer.from(dl.data);
  })();

  return Promise.race([
    callPromise,
    new Promise<Buffer>((_, reject) =>
      setTimeout(() => reject(new Error('TTS hard timeout 240s')), 240000)
    ),
  ]);
}

/** 单次 TTS 测试（供 /api/debug/test-tts 使用） */
export async function testTts(
  text = '你好，这是语音合成测试。',
  voice?: string
): Promise<{ ok: boolean; sizeBytes?: number; error?: string }> {
  try {
    const buf = await synthesizeOnce(text, voice || VOICE);
    return { ok: true, sizeBytes: buf.length };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

// ── 4. 主入口 ───────────────────────────────────────────────────────────────

/**
 * 生成当日播客精华音频，返回文件名（异常会抛出，不再吞）
 */
export async function generateDailyDialogue(
  episodesInput: string,
  _dateStr: string,
  episodeCount: number,
  onStage?: (stage: string) => void
): Promise<string | null> {
  const stage = (s: string) => onStage?.(s);

  // 4-1. 生成脚本（分两段：每段 ~6500 字，合计 ~13000 字 = 30 分钟音频）
  stage('script_generating');
  logger.info('Generating narration script (2-part)', { episodeCount });
  const script = await generateScript(episodesInput, episodeCount, onStage);
  if (!script || script.length < 5000) {
    throw new Error(`脚本太短: length=${script?.length || 0}`);
  }
  stage(`script_done (${script.length} chars)`);
  logger.info(`Script generated: ${script.length} chars`);

  // 4-2. 切大块
  const chunks = chunkScript(script);
  stage(`tts_starting (${chunks.length} chunks, ${script.length} chars)`);
  logger.info(`Script chunked into ${chunks.length} chunks`);

  // 4-3. 串行 TTS 每块（单块失败跳过 + 重试 1 次，避免一块拖死全部）
  const buffers: Buffer[] = [];
  const startTs = Date.now();
  let okCount = 0;
  let failCount = 0;

  for (let i = 0; i < chunks.length; i++) {
    stage(`tts_chunk ${i + 1}/${chunks.length} (${chunks[i].length} chars)`);
    logger.info(`TTS chunk ${i + 1}/${chunks.length}, ${chunks[i].length} chars`);

    let chunkOk = false;
    for (let attempt = 1; attempt <= 2 && !chunkOk; attempt++) {
      try {
        const buf = await synthesizeOnce(chunks[i]);
        buffers.push(buf);
        chunkOk = true;
        okCount++;
      } catch (err) {
        const msg = (err as Error).message;
        if (attempt === 1) {
          logger.warn(`TTS chunk ${i + 1} attempt 1 failed: ${msg.slice(0, 100)}; retrying`);
          await new Promise(r => setTimeout(r, 2000));
        } else {
          logger.warn(`TTS chunk ${i + 1} BOTH attempts failed; skipping`);
          failCount++;
        }
      }
    }
  }

  const elapsedSec = Math.round((Date.now() - startTs) / 1000);
  const combined = Buffer.concat(buffers);
  logger.info(`TTS done: ${okCount}/${chunks.length} chunks ok (${failCount} skipped), ${Math.round(combined.length / 1024)}KB, ${elapsedSec}s`);

  if (combined.length === 0) {
    throw new Error(`All ${chunks.length} TTS chunks failed`);
  }
  // 至少 50% 成功才接受（防止音频过于残缺）
  if (okCount < chunks.length / 2) {
    throw new Error(`Too many TTS failures: only ${okCount}/${chunks.length} succeeded`);
  }

  // 4-4. 保存到持久化 Volume（使用 Asia/Shanghai 时区命名）
  fs.mkdirSync(AUDIO_DIR, { recursive: true });
  const filename = `digest-${dayjs().tz('Asia/Shanghai').format('YYYY-MM-DD')}.mp3`;
  const filePath = path.join(AUDIO_DIR, filename);
  fs.writeFileSync(filePath, combined);
  logger.info('Audio saved', { filename, sizeKB: Math.round(combined.length / 1024) });

  // 4-5. 清理 30 天前的旧文件
  try {
    const cutoff = Date.now() - 30 * 24 * 3600 * 1000;
    let removed = 0;
    for (const f of fs.readdirSync(AUDIO_DIR)) {
      if (!f.startsWith('digest-') || !f.endsWith('.mp3')) continue;
      const fp = path.join(AUDIO_DIR, f);
      if (fs.statSync(fp).mtimeMs < cutoff) {
        fs.unlinkSync(fp);
        removed++;
      }
    }
    if (removed > 0) logger.info(`Audio rotation: removed ${removed} old files`);
  } catch (e) {
    logger.warn('Audio rotation failed', { error: (e as Error).message });
  }

  return filename;
}

/** 估算音频时长（分钟） */
export function estimateAudioDuration(filename: string): number {
  try {
    const filePath = path.join(AUDIO_DIR, filename);
    const size = fs.statSync(filePath).size;
    return Math.max(1, Math.round(size / (64000 / 8) / 60));
  } catch {
    return 30;
  }
}
