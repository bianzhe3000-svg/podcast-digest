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
import { config } from '../config';
import { logger } from '../utils/logger';

// 音色（Qwen3-TTS-Flash 内置）
const VOICE = 'Cherry';                   // 女声·阳光
const MAX_CHARS_PER_TTS = 2000;            // Qwen-TTS-Flash 单次推荐上限

// 音频持久化目录（与数据库同 Volume，不会随 Railway 重新部署丢失）
export const AUDIO_DIR = process.env.AUDIO_DIR
  || path.join(path.dirname(config.database.path), 'audio');

// ── 1. 生成单人播报脚本 ─────────────────────────────────────────────────────

async function generateScript(episodesInput: string, count: number): Promise<string> {
  const client = new OpenAI({
    apiKey: config.dashscope.apiKey,
    baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    timeout: 240000,
    maxRetries: 0,
  });
  const scriptModel = process.env.DASHSCOPE_SCRIPT_MODEL || 'qwen-plus';

  const prompt = `请基于以下${count}个播客剧集的内容，撰写一段约30分钟的中文播客播报文稿（单人主持口吻）。

${episodesInput}

写作要求：
- 自然流畅的口语化播报，像电台主持人朗读早间新闻精选
- 中文语速约220字/分钟，30分钟需要约6500字，请确保总字数在 6000-7000
- 开场约200字介绍今日内容概况
- 中间逐集展开，每集 300-500 字，覆盖核心观点、数据、亮点
- 衔接自然，可使用"接下来"、"另一边"、"值得一提的是"等过渡词
- 结尾约200字总结
- **直接输出正文**，不要任何标题、markdown、列表符号、说明文字
- 不要有 [A]:、[B]: 之类的标记，全篇连贯散文
- 标点正常使用，便于朗读断句`;

  const llmPromise = client.chat.completions.create({
    model: scriptModel,
    messages: [{ role: 'user', content: prompt }],
    max_tokens: 10000,
  }).then(r => r.choices[0]?.message?.content || '');

  const timeoutPromise = new Promise<string>((_, reject) =>
    setTimeout(() => reject(new Error('script LLM hard timeout 240s')), 240000)
  );

  return Promise.race([llmPromise, timeoutPromise]);
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
        timeout: 60000,
      }
    );
    const audioUrl: string | undefined =
      res.data?.output?.audio?.url ||
      res.data?.output?.audio_url ||
      res.data?.output?.results?.[0]?.audio?.url;
    if (!audioUrl) {
      throw new Error(`No audio URL in response: ${JSON.stringify(res.data).slice(0, 300)}`);
    }
    const dl = await axios.get(audioUrl, { responseType: 'arraybuffer', timeout: 60000 });
    return Buffer.from(dl.data);
  })();

  return Promise.race([
    callPromise,
    new Promise<Buffer>((_, reject) =>
      setTimeout(() => reject(new Error('TTS hard timeout 90s')), 90000)
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

  // 4-1. 生成脚本
  stage('script_generating');
  logger.info('Generating narration script', { episodeCount });
  const script = await generateScript(episodesInput, episodeCount);
  if (!script || script.length < 500) {
    throw new Error(`脚本太短或为空: length=${script?.length || 0}`);
  }
  stage(`script_done (${script.length} chars)`);
  logger.info(`Script generated: ${script.length} chars`);

  // 4-2. 切大块
  const chunks = chunkScript(script);
  stage(`tts_starting (${chunks.length} chunks, ${script.length} chars)`);
  logger.info(`Script chunked into ${chunks.length} chunks`);

  // 4-3. 串行 TTS 每块
  const buffers: Buffer[] = [];
  const startTs = Date.now();
  for (let i = 0; i < chunks.length; i++) {
    stage(`tts_chunk ${i + 1}/${chunks.length} (${chunks[i].length} chars)`);
    logger.info(`TTS chunk ${i + 1}/${chunks.length}, ${chunks[i].length} chars`);
    const buf = await synthesizeOnce(chunks[i]);
    buffers.push(buf);
  }
  const elapsedSec = Math.round((Date.now() - startTs) / 1000);
  const combined = Buffer.concat(buffers);
  logger.info(`TTS done: ${chunks.length} chunks, ${Math.round(combined.length / 1024)}KB, ${elapsedSec}s`);

  // 4-4. 保存到持久化 Volume
  fs.mkdirSync(AUDIO_DIR, { recursive: true });
  const filename = `digest-${dayjs().format('YYYY-MM-DD')}.mp3`;
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
