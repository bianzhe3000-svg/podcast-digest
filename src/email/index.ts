import nodemailer from 'nodemailer';
import dns from 'dns';
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { Resend } from 'resend';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';
import { config } from '../config';
import { logger } from '../utils/logger';
import { getDatabase, AnalysisResult, Episode, Podcast } from '../database';
import { readMarkdown } from '../markdown';
import { generateDigestPdf, PdfEpisodeData } from '../markdown/pdf';
import { generateDailyDialogue, estimateAudioDuration, getAudioDurationMin, AUDIO_DIR } from '../audio/dialogue';

dayjs.extend(utc);
dayjs.extend(timezone);

// Force Node.js to prefer IPv4 globally (fixes cloud platform IPv6 issues)
dns.setDefaultResultOrder('ipv4first');

interface DigestEpisode {
  podcast: Podcast;
  episode: Episode;
  analysis: AnalysisResult;
  markdownContent: string | null;
}

interface EmailAttachment {
  filename: string;
  content: Buffer;
  contentType?: string;
}

/**
 * Send email via configured provider (resend or smtp)
 */
async function sendEmail(options: { from: string; to: string; subject: string; html: string; attachments?: EmailAttachment[] }): Promise<void> {
  const provider = config.email.provider;
  logger.info(`Sending email via ${provider}`, { to: options.to, subject: options.subject.substring(0, 60), attachments: options.attachments?.length || 0 });

  if (provider === 'resend') {
    if (!config.email.resendApiKey) throw new Error('RESEND_API_KEY not configured');
    const resend = new Resend(config.email.resendApiKey);
    const result = await resend.emails.send({
      from: options.from,
      to: [options.to],
      subject: options.subject,
      html: options.html,
      attachments: options.attachments?.map(a => ({
        filename: a.filename,
        content: a.content,
        contentType: a.contentType || 'application/pdf',
      })),
    });
    if (result.error) {
      throw new Error(`Resend error: ${result.error.message}`);
    }
    logger.info('Email sent via Resend', { id: result.data?.id });
  } else {
    // SMTP
    const useSecure = config.email.smtpPort === 465 ? true : config.email.smtpSecure;
    const transporter = nodemailer.createTransport({
      host: config.email.smtpHost,
      port: config.email.smtpPort,
      secure: useSecure,
      auth: {
        user: config.email.smtpUser,
        pass: config.email.smtpPass,
      },
      family: 4,
      connectionTimeout: 30000,
      greetingTimeout: 30000,
      socketTimeout: 30000,
    } as any);
    await transporter.sendMail({
      ...options,
      attachments: options.attachments?.map(a => ({
        filename: a.filename,
        content: a.content,
        contentType: a.contentType || 'application/pdf',
      })),
    });
    logger.info('Email sent via SMTP');
  }
}

/**
 * 调用 DashScope 生成当日所有剧集的综合摘要（不超过3000字）
 */
async function generateDailySummary(episodes: DigestEpisode[], dateStr: string): Promise<string> {
  if (episodes.length === 0) return '';

  // 构建每集的简要输入（截断避免超 token）
  const episodeInputs = episodes.map((ep, i) => {
    let keyPoints: { title: string; detail: string }[] = [];
    try { keyPoints = JSON.parse(ep.analysis.key_points || '[]'); } catch {}
    const kpText = keyPoints.slice(0, 4).map(kp => `  · ${kp.title}`).join('\n');
    const summary = (ep.analysis.summary || '').substring(0, 350);
    return `【${i + 1}】${ep.podcast.name}：${ep.episode.title}\n摘要：${summary}\n要点：\n${kpText}`;
  }).join('\n\n---\n\n');

  const prompt = `你是专业播客内容编辑。以下是${dateStr}更新的${episodes.length}个播客剧集内容：\n\n${episodeInputs}\n\n请将以上所有剧集的精华整合成一篇**3500-4000字（绝不超过4000字）**的当日总结。要求：\n1. 按话题/领域归类梳理，不要逐集罗列\n2. 突出最有价值的观点、数据和洞见\n3. 语言流畅，适合快速阅读\n4. 用中文撰写，直接输出正文，不加额外标题\n5. 必须涵盖以上 ${episodes.length} 个剧集的核心内容，不要遗漏任何一集的关键观点`;

  // 用 qwen-plus 快速非推理模型，axios 直连 DashScope 兼容 endpoint（避免 OpenAI SDK 偶发 hang）
  const summaryModel = process.env.DASHSCOPE_SUMMARY_MODEL || 'qwen-plus';

  for (let attempt = 1; attempt <= 2; attempt++) {
    const ac = new AbortController();
    const abortTimer = setTimeout(() => ac.abort(), 150000);
    try {
      logger.info(`Generating daily summary (attempt ${attempt})`, { model: summaryModel, episodes: episodes.length });

      const apiPromise = axios.post(
        'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
        {
          model: summaryModel,
          messages: [{ role: 'user', content: prompt }],
          max_tokens: 6000,
        },
        {
          headers: {
            Authorization: `Bearer ${config.dashscope.apiKey}`,
            'Content-Type': 'application/json',
          },
          timeout: 150000,
          signal: ac.signal,
        }
      ).then(r => r.data?.choices?.[0]?.message?.content || '');

      // 双重保险：绝对超时 170s
      const hardTimeout = new Promise<string>((_, reject) =>
        setTimeout(() => reject(new Error('summary ABSOLUTE TIMEOUT 170s')), 170000)
      );

      const text = await Promise.race([apiPromise, hardTimeout]);
      if (text && text.length > 100) {
        logger.info('Daily summary generated', { length: text.length, attempt });
        return text;
      }
      logger.warn(`Summary attempt ${attempt} too short (${text.length} chars)`);
    } catch (err) {
      const msg = (err as Error).message;
      logger.warn(`Summary attempt ${attempt} failed`, { error: msg });
    } finally {
      clearTimeout(abortTimer);
      try { ac.abort(); } catch {}
    }
  }
  logger.warn('All summary attempts failed, returning empty');
  return '';
}

/**
 * Get all episodes completed in the last N hours with their analysis
 */
function getRecentCompletedEpisodes(sinceHours: number = 24): DigestEpisode[] {
  const db = getDatabase();
  const rows = db.getCompletedEpisodesSince(sinceHours);

  const digestEpisodes: DigestEpisode[] = [];

  for (const row of rows) {
    const podcast = db.getPodcastById(row.podcast_id);
    if (!podcast) continue;

    const analysis = db.getAnalysisResult(row.id);
    if (!analysis) continue;

    let markdownContent: string | null = null;
    if (analysis.markdown_path) {
      const parts = analysis.markdown_path.split('/');
      if (parts.length >= 2) {
        const podcastDir = parts[parts.length - 2];
        const filename = parts[parts.length - 1];
        markdownContent = readMarkdown(config.storage.summariesDir, podcastDir, filename);
      }
    }

    digestEpisodes.push({ podcast, episode: row, analysis, markdownContent });
  }

  return digestEpisodes;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Convert newlines to <br> for HTML display */
function nl2br(text: string): string {
  return escapeHtml(text).replace(/\n/g, '<br>');
}

/**
 * 按播客名分组并排序剧集（播客名字母序，组内按发布时间降序）
 * 返回扁平的排序后数组，邮件和 PDF 共用同一排序
 */
function sortEpisodesByPodcast(episodes: DigestEpisode[]): DigestEpisode[] {
  const grouped = new Map<string, DigestEpisode[]>();
  for (const ep of episodes) {
    const key = ep.podcast.name;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push(ep);
  }
  // 播客名字母序
  const sortedKeys = [...grouped.keys()].sort((a, b) => a.localeCompare(b));
  const sorted: DigestEpisode[] = [];
  for (const key of sortedKeys) {
    const eps = grouped.get(key)!;
    // 组内按发布时间降序
    eps.sort((a, b) => (b.episode.published_at || '').localeCompare(a.episode.published_at || ''));
    sorted.push(...eps);
  }
  return sorted;
}

/**
 * Build full HTML email with all 4 sections per episode
 */
function buildDigestHtml(episodes: DigestEpisode[], dateStr: string, dailySummary?: string, audioUrl?: string, audioDurationMin?: number): string {
  // episodes 已经在外部统一排好序
  const episodesByPodcast = new Map<string, DigestEpisode[]>();
  for (const ep of episodes) {
    const key = ep.podcast.name;
    if (!episodesByPodcast.has(key)) episodesByPodcast.set(key, []);
    episodesByPodcast.get(key)!.push(ep);
  }

  let html = `
<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; margin: 0; padding: 0; background: #f0f2f5; color: #333; line-height: 1.6; }
  .container { max-width: 780px; margin: 0 auto; background: #fff; }

  .toc { padding: 20px 30px; background: #f8f9fa; border-bottom: 1px solid #e8e8e8; }
  .toc h2 { font-size: 16px; margin: 0 0 10px 0; color: #555; }
  .toc ul { margin: 0; padding: 0 0 0 20px; }
  .toc li { margin: 5px 0; font-size: 14px; color: #444; }
  .toc a { color: #667eea; text-decoration: none; }
  .toc a:hover { text-decoration: underline; }

  .podcast-section { padding: 0 30px; }
  .podcast-header { padding: 24px 0 12px 0; border-bottom: 3px solid #667eea; margin-top: 24px; }
  .podcast-header h2 { margin: 0; font-size: 20px; color: #667eea; }

  .episode { padding: 24px 0; border-bottom: 1px solid #eee; }
  .episode:last-child { border-bottom: none; }
  .episode-title { margin: 0 0 8px 0; font-size: 18px; color: #1a1a1a; }
  .episode-meta { font-size: 12px; color: #999; margin-bottom: 16px; }

  .section-label { font-size: 15px; font-weight: 700; color: #667eea; margin: 20px 0 8px 0; padding-bottom: 4px; border-bottom: 1px solid #e8edf5; }
  .section-content { font-size: 14px; line-height: 1.8; color: #444; margin-bottom: 8px; }

  /* Key points */
  .key-points { margin: 8px 0 16px 0; }
  .kp-item { margin: 8px 0; border-left: 3px solid #667eea; background: #f8f9fb; border-radius: 0 6px 6px 0; overflow: hidden; }
  .kp-item summary { padding: 10px 14px; font-size: 14px; font-weight: 600; color: #333; cursor: pointer; list-style: none; }
  .kp-item summary::-webkit-details-marker { display: none; }
  .kp-item summary::before { content: "▶ "; font-size: 11px; color: #667eea; }
  .kp-item[open] summary::before { content: "▼ "; }
  .kp-detail { padding: 0 14px 14px 14px; font-size: 13px; line-height: 1.8; color: #555; border-top: 1px solid #e8e8e8; }

  /* Keywords */
  .keywords-list { margin: 8px 0 16px 0; }
  .kw-item { margin: 10px 0; padding: 10px 14px; background: #f8f9fb; border-radius: 6px; }
  .kw-word { font-size: 14px; font-weight: 700; color: #667eea; margin-bottom: 4px; }
  .kw-context { font-size: 13px; line-height: 1.7; color: #555; }

  /* Full recap */
  .full-recap { font-size: 14px; line-height: 1.9; color: #444; margin: 8px 0 16px 0; text-align: justify; }

  .divider { height: 1px; background: #e8e8e8; margin: 8px 0; }

  /* Daily overview summary */
  .daily-overview { padding: 24px 30px; background: linear-gradient(135deg, #fff8f0 0%, #fff3e8 100%); border-left: 4px solid #f5a623; border-top: 1px solid #fde0b8; border-bottom: 1px solid #fde0b8; }
  .daily-overview h2 { margin: 0 0 14px 0; font-size: 17px; color: #c47a1a; }
  .daily-overview .overview-content { font-size: 14px; line-height: 1.9; color: #4a3a20; text-align: justify; white-space: pre-wrap; }

  .footer { padding: 24px 30px; background: #f8f9fa; text-align: center; font-size: 12px; color: #999; border-top: 1px solid #e8e8e8; }
</style>
</head>
<body style="margin:0;padding:0;background:#f0f2f5;color:#333;line-height:1.6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;">
<div style="max-width:780px;margin:0 auto;background:#fff;">
  <div style="background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);background-color:#5a4dd1;color:#ffffff;padding:32px;text-align:center;">
    <h1 style="margin:0;font-size:26px;color:#ffffff;letter-spacing:1px;">🎧 Podcast Digest</h1>
    <div style="margin-top:8px;font-size:15px;color:#ffffff;opacity:0.95;">${dateStr}</div>
    <div style="margin-top:4px;font-size:13px;color:#ffffff;opacity:0.85;">过去24小时共处理 ${episodes.length} 个剧集</div>
  </div>
${audioUrl ? `  <div style="padding:24px 30px;background:linear-gradient(135deg,#1a1a2e 0%,#16213e 100%);background-color:#1a1a2e;color:#ffffff;text-align:center;">
    <div style="font-size:13px;color:#ffd966;font-weight:600;letter-spacing:1px;margin-bottom:8px;">⭐ 今日 30 分钟精华播报</div>
    <h2 style="margin:0 0 8px 0;font-size:20px;color:#ffffff;letter-spacing:0.5px;">🎙️ 一键收听今日播客速览</h2>
    <div style="font-size:13px;color:#a8b2cf;margin-bottom:16px;">约 ${audioDurationMin || 30} 分钟 &nbsp;·&nbsp; AI 智能编辑播报</div>
    <a href="${escapeHtml(audioUrl)}" style="display:inline-block;padding:14px 36px;background:linear-gradient(135deg,#667eea,#764ba2);background-color:#667eea;color:#ffffff;text-decoration:none;border-radius:30px;font-size:16px;font-weight:600;letter-spacing:0.5px;">▶ 点击收听 30 分钟精华</a>
    <div style="margin-top:12px;font-size:11px;color:#7a86a8;">链接长期有效 · 也可在 <a href="https://podcast-digest-production.up.railway.app/" style="color:#a8b2cf;text-decoration:underline;">WebUI</a> 收听</div>
  </div>` : ''}`;

  // Table of contents
  html += `
  <div class="toc">
    <h2>📋 目录</h2>
    <ul>`;
  let epIndex = 0;
  for (const [podcastName, eps] of episodesByPodcast) {
    for (const ep of eps) {
      epIndex++;
      html += `
      <li style="margin:6px 0;">
        <a href="#ep-${epIndex}" style="color:#667eea;text-decoration:underline;font-size:14px;">${epIndex}. <strong>${escapeHtml(podcastName)}</strong> — ${escapeHtml(ep.episode.title)}</a>
        <div style="margin:3px 0 0 16px;font-size:12px;line-height:1.8;">
          <a href="#ep-${epIndex}-summary" style="color:#888;text-decoration:none;margin-right:10px;">📝 摘要</a>
          <a href="#ep-${epIndex}-keypoints" style="color:#888;text-decoration:none;margin-right:10px;">🎯 要点</a>
          <a href="#ep-${epIndex}-keywords" style="color:#888;text-decoration:none;margin-right:10px;">🔑 关键词</a>
          <a href="#ep-${epIndex}-recap" style="color:#888;text-decoration:none;">📖 纪要</a>
        </div>
      </li>`;
    }
  }
  html += `
    </ul>
  </div>`;

  // Daily overview summary
  if (dailySummary) {
    html += `
  <div class="daily-overview">
    <h2>🌅 今日全览</h2>
    <div class="overview-content">${nl2br(dailySummary)}</div>
  </div>`;
  }

  // Full episode details
  epIndex = 0;
  for (const [podcastName, eps] of episodesByPodcast) {
    html += `
  <div class="podcast-section">
    <div class="podcast-header">
      <h2>🎙️ ${escapeHtml(podcastName)}</h2>
    </div>`;

    for (const ep of eps) {
      epIndex++;
      const pubDate = dayjs(ep.episode.published_at).format('YYYY-MM-DD');
      const duration = ep.episode.duration_seconds
        ? `${Math.floor(ep.episode.duration_seconds / 60)} 分钟`
        : '';

      // Parse structured data from DB columns
      let keyPoints: { title: string; detail: string }[] = [];
      let keywords: { word: string; context: string }[] = [];
      let fullRecap = '';
      try { keyPoints = JSON.parse(ep.analysis.key_points || '[]'); } catch {}
      try { keywords = JSON.parse(ep.analysis.arguments || '[]'); } catch {}
      fullRecap = ep.analysis.knowledge_points || '';

      html += `
    <div class="episode" id="ep-${epIndex}">
      <h3 class="episode-title">${epIndex}. ${escapeHtml(ep.episode.title)}</h3>
      <div class="episode-meta">📅 ${pubDate}${duration ? ` &nbsp;·&nbsp; ⏱️ ${duration}` : ''}${ep.episode.audio_url ? ` &nbsp;·&nbsp; <a href="${escapeHtml(ep.episode.audio_url)}" style="color:#667eea;">收听原始音频</a>` : ''}</div>`;

      // === Section 1: Summary ===
      html += `
      <div class="section-label" id="ep-${epIndex}-summary">📝 内容核心摘要</div>
      <div class="section-content">${nl2br(ep.analysis.summary)}</div>`;

      // === Section 2: Key Points with expandable details ===
      if (keyPoints.length > 0) {
        html += `
      <div class="section-label" id="ep-${epIndex}-keypoints">🎯 核心要点</div>
      <div class="key-points">`;
        for (const kp of keyPoints) {
          html += `
        <details class="kp-item">
          <summary>${escapeHtml(kp.title || '')}</summary>
          <div class="kp-detail">${nl2br(kp.detail || '')}</div>
        </details>`;
        }
        html += `
      </div>`;
      }

      // === Section 3: Keywords with context ===
      if (keywords.length > 0) {
        html += `
      <div class="section-label" id="ep-${epIndex}-keywords">🔑 核心关键词分析</div>
      <div class="keywords-list">`;
        for (const kw of keywords) {
          html += `
        <div class="kw-item">
          <div class="kw-word">${escapeHtml(kw.word || '')}</div>
          <div class="kw-context">${nl2br(kw.context || '')}</div>
        </div>`;
        }
        html += `
      </div>`;
      }

      // === Section 4: Full recap ===
      if (fullRecap) {
        html += `
      <div class="section-label" id="ep-${epIndex}-recap">📖 长版内容纪要</div>
      <div class="full-recap">${nl2br(fullRecap)}</div>`;
      }

      html += `
    </div>`;
    }

    html += `
  </div>`;
  }

  html += `
  <div class="footer">
    <p>此邮件由 <strong>Podcast Digest</strong> 自动生成</p>
    <p>生成时间: ${dayjs().tz('Asia/Shanghai').format('YYYY-MM-DD HH:mm:ss')} (北京时间)</p>
  </div>
</div>
</body>
</html>`;

  return html;
}

/**
 * 生成并保存每日摘要（不发邮件），供 WebUI 调用
 * 返回包含摘要文本、音频文件名、剧集 ID 列表的对象
 *
 * 可选 onStage 回调：每进入新阶段调用一次（用于在 task_log 中记录进度）
 */
/**
 * 重新生成指定日期的 digest（用已存的 episode_ids，不依赖时间窗口）
 * 用于补救某天生成失败（summary/audio 为空）的情况
 */
export async function regenerateDigestForDate(
  date: string,
  onStage?: (stage: string) => void
): Promise<{ ok: boolean; episodeCount: number; summary?: string; audioFilename?: string | null; audioGenerated?: boolean; error?: string }> {
  const stage = (s: string) => { logger.info(`[regen ${date}] ${s}`); onStage?.(s); };
  try {
    const db = getDatabase();
    const digest = db.getDailyDigest(date);
    if (!digest) return { ok: false, episodeCount: 0, error: `无 ${date} 的 digest 记录` };
    const episodeIds: number[] = JSON.parse(digest.episode_ids || '[]');
    if (episodeIds.length === 0) return { ok: false, episodeCount: 0, error: `${date} 没有关联剧集` };

    // 按已存 episode_ids 重建 DigestEpisode[]
    const raw: DigestEpisode[] = [];
    for (const id of episodeIds) {
      const ep = db.getEpisodeById(id);
      if (!ep) continue;
      const podcast = db.getPodcastById(ep.podcast_id);
      const analysis = db.getAnalysisResult(id);
      if (!podcast || !analysis) continue;
      raw.push({ podcast, episode: ep, analysis, markdownContent: null });
    }
    if (raw.length === 0) return { ok: false, episodeCount: 0, error: `${date} 剧集分析数据缺失` };

    const episodes = sortEpisodesByPodcast(raw);
    const dateStr = dayjs(date).format('YYYY年MM月DD日');

    stage(`summary_generating (${episodes.length} episodes)`);
    const dailySummary = await generateDailySummary(episodes, dateStr);
    stage(`summary_done (${dailySummary.length} chars)`);

    const episodesInput = episodes.map((ep, i) => {
      let keyPoints: { title: string; detail: string }[] = [];
      try { keyPoints = JSON.parse(ep.analysis.key_points || '[]'); } catch {}
      const kpText = keyPoints.map(kp => `  · ${kp.title}：${kp.detail || ''}`.slice(0, 120)).join('\n');
      const summary = (ep.analysis.summary || '').slice(0, 600);
      const recap = (ep.analysis.knowledge_points || '').slice(0, 300);
      return `【${i + 1}】${ep.podcast.name}：${ep.episode.title}\n摘要：${summary}\n要点：\n${kpText}${recap ? `\n补充：${recap}` : ''}`;
    }).join('\n\n---\n\n');

    let audioFilename: string | null = null;
    let audioGenerated = false;
    try {
      stage('audio_generating');
      audioFilename = await generateDailyDialogue(episodesInput, dateStr, episodes.length, onStage, date);
      audioGenerated = !!audioFilename;
      stage(audioGenerated ? 'audio_done' : 'audio_failed');
    } catch (err) {
      logger.warn('regen audio failed', { date, error: (err as Error).message });
      stage(`audio_error: ${(err as Error).message.slice(0, 120)}`);
    }

    db.saveDailyDigest(date, dailySummary || '', audioFilename, episodeIds);
    stage('saved');
    return { ok: true, episodeCount: episodes.length, summary: dailySummary, audioFilename, audioGenerated };
  } catch (err) {
    return { ok: false, episodeCount: 0, error: (err as Error).message };
  }
}

export async function generateAndSaveDigest(
  sinceHours: number = 24,
  onStage?: (stage: string) => void
): Promise<{
  ok: boolean;
  episodeCount: number;
  date: string;
  summary?: string;
  audioFilename?: string | null;
  audioGenerated?: boolean;
  audioError?: string;
  error?: string;
}> {
  const today = dayjs().tz('Asia/Shanghai').format('YYYY-MM-DD');
  const stage = (s: string) => { logger.info(`[digest stage] ${s}`); onStage?.(s); };
  try {
    stage('fetching_episodes');
    const rawEpisodes = getRecentCompletedEpisodes(sinceHours);
    if (rawEpisodes.length === 0) {
      return { ok: false, episodeCount: 0, date: today, error: `过去 ${sinceHours} 小时没有已完成的剧集` };
    }
    const episodes = sortEpisodesByPodcast(rawEpisodes);
    const dateStr = dayjs().tz('Asia/Shanghai').format('YYYY年MM月DD日');

    stage(`summary_generating (${episodes.length} episodes)`);
    const dailySummary = await generateDailySummary(episodes, dateStr);
    stage(`summary_done (${dailySummary.length} chars)`);

    // 音频
    const episodesInput = episodes.map((ep, i) => {
      let keyPoints: { title: string; detail: string }[] = [];
      try { keyPoints = JSON.parse(ep.analysis.key_points || '[]'); } catch {}
      const kpText = keyPoints.map(kp => `  · ${kp.title}：${kp.detail || ''}`.slice(0, 120)).join('\n');
      const summary = (ep.analysis.summary || '').slice(0, 600);
      const recap = (ep.analysis.knowledge_points || '').slice(0, 300);
      return `【${i + 1}】${ep.podcast.name}：${ep.episode.title}\n摘要：${summary}\n要点：\n${kpText}${recap ? `\n补充：${recap}` : ''}`;
    }).join('\n\n---\n\n');

    let audioFilename: string | null = null;
    let audioGenerated = false;
    let audioError: string | undefined;
    try {
      stage('audio_generating');
      audioFilename = await generateDailyDialogue(episodesInput, dateStr, episodes.length, onStage);
      audioGenerated = !!audioFilename;
      stage(audioGenerated ? 'audio_done' : 'audio_failed');
    } catch (err) {
      audioError = (err as Error).message;
      logger.warn('Audio generation failed', { error: audioError });
      stage(`audio_error: ${audioError.slice(0, 200)}`);
    }

    // 保存到数据库
    stage('saving_to_db');
    const db = getDatabase();
    const episodeIds = episodes.map(ep => ep.episode.id);
    db.saveDailyDigest(today, dailySummary || '', audioFilename, episodeIds);
    logger.info('Digest saved to DB', { date: today, episodes: episodeIds.length, audio: audioGenerated });
    stage('completed');

    return {
      ok: true,
      episodeCount: episodes.length,
      date: today,
      summary: dailySummary,
      audioFilename,
      audioGenerated,
      audioError,
    };
  } catch (err) {
    stage(`error: ${(err as Error).message.slice(0, 80)}`);
    return { ok: false, episodeCount: 0, date: today, error: (err as Error).message };
  }
}

/**
 * Send daily digest email
 */
export async function sendDailyDigest(sinceHours: number = 24): Promise<{
  sent: boolean;
  episodeCount: number;
  error?: string;
}> {
  if (!config.email.enabled) {
    logger.info('Email digest skipped: email not enabled');
    return { sent: false, episodeCount: 0, error: 'Email not enabled' };
  }

  // Check provider-specific credentials
  const provider = config.email.provider;
  if (provider === 'resend' && !config.email.resendApiKey) {
    return { sent: false, episodeCount: 0, error: 'RESEND_API_KEY not configured' };
  }
  if (provider === 'smtp' && (!config.email.smtpUser || !config.email.smtpPass)) {
    return { sent: false, episodeCount: 0, error: 'SMTP credentials not configured' };
  }

  if (!config.email.toAddress) {
    logger.warn('Email digest skipped: no recipient address');
    return { sent: false, episodeCount: 0, error: 'No recipient address' };
  }

  try {
    const rawEpisodes = getRecentCompletedEpisodes(sinceHours);

    if (rawEpisodes.length === 0) {
      logger.info('Email digest skipped: no new episodes in the last ' + sinceHours + ' hours');
      return { sent: false, episodeCount: 0, error: 'No new episodes' };
    }

    // 统一排序：播客名字母序 > 组内发布时间降序，邮件和 PDF 共用同一顺序
    const episodes = sortEpisodesByPodcast(rawEpisodes);

    const dateStr = dayjs().tz('Asia/Shanghai').format('YYYY年MM月DD日');

    // 优先复用今日已生成的 digest（来自 generateAndSaveDigest 或先前调用）
    // 这样邮件 cron 不需要重新跑一次 30 分钟的音频生成流程
    const today = dayjs().tz('Asia/Shanghai').format('YYYY-MM-DD');
    const db = getDatabase();
    const existingDigest = db.getDailyDigest(today);

    let dailySummary = '';
    let audioUrl: string | undefined;
    let audioDurationMin: number | undefined;
    let needsGenerate = true;

    if (existingDigest && existingDigest.summary && existingDigest.audio_filename) {
      const audioPath = path.join(AUDIO_DIR, existingDigest.audio_filename);
      if (fs.existsSync(audioPath)) {
        dailySummary = existingDigest.summary;
        const baseUrl = process.env.RAILWAY_PUBLIC_DOMAIN
          ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
          : 'https://podcast-digest-production.up.railway.app';
        audioUrl = `${baseUrl}/api/audio/${existingDigest.audio_filename}`;
        // 用 ffprobe 取真实时长
        audioDurationMin = await getAudioDurationMin(existingDigest.audio_filename);
        needsGenerate = false;
        logger.info('Email reusing existing digest from DB', { date: today, audio: audioUrl, durationMin: audioDurationMin, summaryChars: dailySummary.length });
      } else {
        logger.warn('Existing digest record found but audio file missing on disk, regenerating');
      }
    }

    if (needsGenerate) {
      // 没有现成 digest，调 generateAndSaveDigest（会处理摘要+音频生成+保存）
      logger.info('No usable digest found, calling generateAndSaveDigest');
      const result = await generateAndSaveDigest(sinceHours);
      if (result.ok) {
        dailySummary = result.summary || '';
        if (result.audioFilename) {
          const baseUrl = process.env.RAILWAY_PUBLIC_DOMAIN
            ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
            : 'https://podcast-digest-production.up.railway.app';
          audioUrl = `${baseUrl}/api/audio/${result.audioFilename}`;
          audioDurationMin = await getAudioDurationMin(result.audioFilename);
        }
      } else {
        logger.warn('generateAndSaveDigest failed, sending email with what we have', { error: result.error });
      }
    }

    const html = buildDigestHtml(episodes, dateStr, dailySummary, audioUrl, audioDurationMin);
    const subject = `🎧 Podcast Digest - ${dateStr} (${episodes.length}篇新内容)`;
    const from = config.email.fromAddress || config.email.smtpUser || 'Podcast Digest <onboarding@resend.dev>';

    // Generate single digest PDF containing all episodes (same order as email HTML)
    const attachments: EmailAttachment[] = [];
    try {
      const pdfEpisodes: PdfEpisodeData[] = episodes.map(ep => {
        let keyPoints: { title: string; detail: string }[] = [];
        let keywords: { word: string; context: string }[] = [];
        try { keyPoints = JSON.parse(ep.analysis.key_points || '[]'); } catch {}
        try { keywords = JSON.parse(ep.analysis.arguments || '[]'); } catch {}

        return {
          podcastName: ep.podcast.name,
          episodeTitle: ep.episode.title,
          publishedAt: ep.episode.published_at,
          durationSeconds: ep.episode.duration_seconds || undefined,
          summary: ep.analysis.summary || '',
          keyPoints,
          keywords,
          fullRecap: ep.analysis.knowledge_points || '',
        };
      });

      const pdfBuffer = await generateDigestPdf(pdfEpisodes, dateStr, dailySummary);
      attachments.push({
        filename: `Podcast-Digest-${dayjs().tz('Asia/Shanghai').format('YYYY-MM-DD')}.pdf`,
        content: pdfBuffer,
        contentType: 'application/pdf',
      });
      logger.info('Digest PDF prepared', { size: pdfBuffer.length, episodes: pdfEpisodes.length });
    } catch (err) {
      logger.warn('Failed to generate digest PDF, sending email without attachment', {
        error: (err as Error).message,
      });
    }

    await sendEmail({ from, to: config.email.toAddress, subject, html, attachments });

    // Persist digest to DB for WebUI display
    try {
      const db = getDatabase();
      const today = dayjs().tz('Asia/Shanghai').format('YYYY-MM-DD');
      const episodeIds = episodes.map(ep => ep.episode.id);
      const audioFilename = audioUrl ? audioUrl.split('/').pop() || null : null;
      db.saveDailyDigest(today, dailySummary || '', audioFilename, episodeIds);
      logger.info('Daily digest saved to DB', { date: today, episodes: episodeIds.length });
    } catch (err) {
      logger.warn('Failed to save digest to DB', { error: (err as Error).message });
    }

    logger.info('Daily digest email sent', {
      provider,
      to: config.email.toAddress,
      episodeCount: episodes.length,
      pdfAttachments: attachments.length,
    });

    return { sent: true, episodeCount: episodes.length };
  } catch (error) {
    const msg = (error as Error).message;
    logger.error('Failed to send digest email', { error: msg });
    return { sent: false, episodeCount: 0, error: msg };
  }
}

/**
 * Test email connection
 */
export async function testEmailConnection(): Promise<{ success: boolean; error?: string }> {
  const provider = config.email.provider;

  try {
    if (provider === 'resend') {
      if (!config.email.resendApiKey) return { success: false, error: 'RESEND_API_KEY not configured' };
      // Resend doesn't have a verify endpoint, send a test via the API
      const resend = new Resend(config.email.resendApiKey);
      // Just verify API key by listing domains
      await resend.domains.list();
      return { success: true };
    } else {
      if (!config.email.smtpUser || !config.email.smtpPass) {
        return { success: false, error: 'SMTP credentials not configured' };
      }
      const transporter = nodemailer.createTransport({
        host: config.email.smtpHost,
        port: config.email.smtpPort,
        secure: config.email.smtpPort === 465,
        auth: { user: config.email.smtpUser, pass: config.email.smtpPass },
        family: 4,
        connectionTimeout: 30000,
      } as any);
      await transporter.verify();
      return { success: true };
    }
  } catch (error) {
    return { success: false, error: (error as Error).message };
  }
}
