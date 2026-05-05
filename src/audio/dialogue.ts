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

// 两位主持人的声音（Qwen3-TTS-Flash 内置音色）
const VOICE_A = 'Cherry'; // 女声·阳光（主持人甲）
const VOICE_B = 'Ethan';  // 男声·温暖（主持人乙）

// 音频存储路径：放在数据库同一个目录下（确保使用 Railway Volume 持久化）
// 优先使用环境变量 AUDIO_DIR，否则放在数据库目录的 audio 子目录
export const AUDIO_DIR = process.env.AUDIO_DIR
  || path.join(path.dirname(config.database.path), 'audio');

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

  const prompt = `请基于以下${count}个播客剧集的内容，创作一段约30分钟的中文播客对话脚本（两位主持人）。

${episodesInput}

输出格式规则（严格遵守，每行一句台词）：
[A]: 主持人甲的台词
[B]: 主持人乙的台词

内容要求：
- 对话自然流畅，像真实播客主持人深度讨论
- 深入覆盖每个剧集的重要观点、有趣细节和亮点
- 中文语速约220字/分钟，30分钟需要约6600字脚本，请确保总字数在6000-7000字
- 每个剧集至少用 3-5 轮对话深入展开
- 主持人之间有互动、追问、补充，不是单纯转述
- 开头介绍今日内容概况（约200字），结尾总结（约200字）
- 每行台词控制在 40-80 字（便于TTS合成与节奏感）
- 总行数控制在 100-150 行
- 直接输出对话，不要任何其他说明文字`;

  const response = await client.chat.completions.create({
    model: config.dashscope.textModel,
    messages: [{ role: 'user', content: prompt }],
    max_tokens: 12000,
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

/**
 * 把连续同说话人的多行合并成一个"轮次"，每个轮次 = 1 次 TTS 调用
 * 单个轮次的文本上限 ~800 字（Qwen-TTS 接受范围内）；超长则切分
 */
function groupIntoTurns(lines: DialogueLine[]): DialogueLine[] {
  const MAX_CHARS_PER_TURN = 800;
  const turns: DialogueLine[] = [];
  let current: DialogueLine | null = null;

  for (const line of lines) {
    if (!current || current.speaker !== line.speaker) {
      // 切换说话人或第一行：新建轮次
      if (current) turns.push(current);
      current = { speaker: line.speaker, text: line.text };
    } else if (current.text.length + line.text.length + 1 <= MAX_CHARS_PER_TURN) {
      // 同说话人 + 不超长：合并到当前轮次
      current.text = current.text + '。' + line.text;
    } else {
      // 同说话人但当前轮次已接近上限：新起一个轮次
      turns.push(current);
      current = { speaker: line.speaker, text: line.text };
    }
  }
  if (current) turns.push(current);
  return turns;
}

// ── 3. 单行 TTS 合成（CosyVoice-v2）────────────────────────────────────────

async function synthesize(text: string, voice: string, attempt = 1): Promise<Buffer> {
  try {
    // Qwen3-TTS-Flash：通过 multimodal-generation/generation endpoint，返回 audio URL
    const res = await axios.post(
      'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation',
      {
        model: 'qwen3-tts-flash',
        input: {
          text,
          voice,            // Cherry / Ethan / Serena / Chelsie / Moon / 等
          language_type: 'Chinese',
        },
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

    // 下载音频文件
    const dl = await axios.get(audioUrl, { responseType: 'arraybuffer', timeout: 30000 });
    return Buffer.from(dl.data);
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
          : JSON.stringify(err.response.data);
        errMsg = `${status} ${txt.slice(0, 300)}`;
      } catch {}
    }
    throw new Error(`Qwen-TTS ${status || 'network'}: ${errMsg}`);
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
  episodeCount: number,
  onStage?: (stage: string) => void
): Promise<string | null> {
  const stage = (s: string) => onStage?.(s);
  try {
    // 4-1. 生成脚本
    stage('script_generating');
    logger.info('Generating dialogue script', { episodeCount });
    const script = await generateScript(episodesInput, dateStr, episodeCount);
    if (!script) throw new Error('Empty dialogue script');
    stage(`script_done (${script.length} chars)`);

    const lines = parseScript(script);
    if (lines.length === 0) throw new Error('No dialogue lines parsed');

    // 把连续同说话人合并成轮次：100+ 行降到 ~30 轮次 → API 调用减少 5 倍
    const turns = groupIntoTurns(lines);
    const totalChars = turns.reduce((s, t) => s + t.text.length, 0);
    logger.info(`Dialogue: ${lines.length} lines → ${turns.length} speaker turns, ${totalChars} chars total`);
    stage(`tts_starting (${turns.length} turns, ${totalChars} chars)`);

    // 4-2. 串行合成轮次（每轮 1 次 TTS 调用），早期失败熔断
    const buffers: Buffer[] = [];
    let successCount = 0;
    let failCount = 0;
    let consecutiveFailures = 0;
    let lastError = '';
    const startTs = Date.now();

    for (let i = 0; i < turns.length; i++) {
      const turn = turns[i];
      const voice = turn.speaker === 'A' ? VOICE_A : VOICE_B;
      try {
        const buf = await synthesize(turn.text, voice);
        buffers.push(buf);
        successCount++;
        consecutiveFailures = 0;
      } catch (err) {
        failCount++;
        consecutiveFailures++;
        lastError = (err as Error).message;
        logger.warn(`TTS turn ${i + 1}/${turns.length} failed`, { error: lastError, chars: turn.text.length, speaker: turn.speaker });
        // 熔断：前 5 轮全部失败就放弃，不要白白等完所有调用
        if (i < 5 && consecutiveFailures >= 5) {
          throw new Error(`TTS circuit-broken: first ${consecutiveFailures} turns all failed. Last error: ${lastError}`);
        }
      }
      // 进度日志（每 5 轮一次）
      if ((i + 1) % 5 === 0) {
        const elapsed = Math.round((Date.now() - startTs) / 1000);
        logger.info(`TTS progress ${i + 1}/${turns.length} (ok=${successCount}, fail=${failCount}, ${elapsed}s elapsed)`);
        stage(`tts_progress ${i + 1}/${turns.length} ok=${successCount}`);
      }
    }

    const combined = Buffer.concat(buffers);
    const elapsedSec = Math.round((Date.now() - startTs) / 1000);
    logger.info(`TTS done: ${successCount}/${turns.length} ok, ${failCount} failed, ${Math.round(combined.length / 1024)}KB, ${elapsedSec}s`);
    if (combined.length === 0) {
      throw new Error(`All ${turns.length} TTS turns failed. Last error: ${lastError}`);
    }

    // 4-3. 保存文件
    fs.mkdirSync(AUDIO_DIR, { recursive: true });
    const filename = `digest-${dayjs().format('YYYY-MM-DD')}.mp3`;
    const filePath = path.join(AUDIO_DIR, filename);
    fs.writeFileSync(filePath, combined);

    const durationMin = Math.round(combined.length / (32000 / 8) / 60); // 估算时长（32kbps）
    logger.info('Daily dialogue audio ready', { filename, sizeKB: Math.round(combined.length / 1024), durationMin });

    // 4-4. 清理 30 天前的旧音频文件，避免 Volume 被填满
    try {
      const KEEP_DAYS = 30;
      const cutoff = Date.now() - KEEP_DAYS * 24 * 3600 * 1000;
      const files = fs.readdirSync(AUDIO_DIR);
      let removed = 0;
      for (const f of files) {
        if (!f.startsWith('digest-') || !f.endsWith('.mp3')) continue;
        const fp = path.join(AUDIO_DIR, f);
        const st = fs.statSync(fp);
        if (st.mtimeMs < cutoff) {
          fs.unlinkSync(fp);
          removed++;
        }
      }
      if (removed > 0) logger.info(`Audio rotation: removed ${removed} files older than ${KEEP_DAYS} days`);
    } catch (e) {
      logger.warn('Audio rotation failed', { error: (e as Error).message });
    }

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
