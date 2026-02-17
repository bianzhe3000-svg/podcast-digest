import nodemailer from 'nodemailer';
import dns from 'dns';
import { Resend } from 'resend';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';
import { config } from '../config';
import { logger } from '../utils/logger';
import { getDatabase, AnalysisResult, Episode, Podcast } from '../database';
import { readMarkdown } from '../markdown';
import { generateEpisodePdf } from '../markdown/pdf';

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
 * Build full HTML email with all 4 sections per episode
 */
function buildDigestHtml(episodes: DigestEpisode[], dateStr: string): string {
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
  .header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: #fff; padding: 32px; text-align: center; }
  .header h1 { margin: 0; font-size: 26px; letter-spacing: 1px; }
  .header .date { opacity: 0.9; margin-top: 8px; font-size: 15px; }
  .header .count { margin-top: 4px; font-size: 13px; opacity: 0.8; }

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

  .footer { padding: 24px 30px; background: #f8f9fa; text-align: center; font-size: 12px; color: #999; border-top: 1px solid #e8e8e8; }
</style>
</head>
<body>
<div class="container">
  <div class="header">
    <h1>🎧 Podcast Digest</h1>
    <div class="date">${dateStr}</div>
    <div class="count">过去24小时共处理 ${episodes.length} 个剧集</div>
  </div>`;

  // Table of contents
  html += `
  <div class="toc">
    <h2>📋 目录</h2>
    <ul>`;
  let epIndex = 0;
  for (const [podcastName, eps] of episodesByPodcast) {
    for (const ep of eps) {
      epIndex++;
      html += `\n      <li><a href="#ep-${epIndex}">${epIndex}. <strong>${escapeHtml(podcastName)}</strong> — ${escapeHtml(ep.episode.title)}</a></li>`;
    }
  }
  html += `
    </ul>
  </div>`;

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
      <div class="section-label">📝 内容核心摘要</div>
      <div class="section-content">${nl2br(ep.analysis.summary)}</div>`;

      // === Section 2: Key Points with expandable details ===
      if (keyPoints.length > 0) {
        html += `
      <div class="section-label">🎯 核心要点</div>
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
      <div class="section-label">🔑 核心关键词分析</div>
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
      <div class="section-label">📖 长版内容纪要</div>
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
    const episodes = getRecentCompletedEpisodes(sinceHours);

    if (episodes.length === 0) {
      logger.info('Email digest skipped: no new episodes in the last ' + sinceHours + ' hours');
      return { sent: false, episodeCount: 0, error: 'No new episodes' };
    }

    const dateStr = dayjs().tz('Asia/Shanghai').format('YYYY年MM月DD日');
    const html = buildDigestHtml(episodes, dateStr);
    const subject = `🎧 Podcast Digest - ${dateStr} (${episodes.length}篇新内容)`;
    const from = config.email.fromAddress || config.email.smtpUser || 'Podcast Digest <onboarding@resend.dev>';

    // Generate PDF attachments directly from analysis data
    const attachments: EmailAttachment[] = [];
    for (const ep of episodes) {
      try {
        let keyPoints: { title: string; detail: string }[] = [];
        let keywords: { word: string; context: string }[] = [];
        try { keyPoints = JSON.parse(ep.analysis.key_points || '[]'); } catch {}
        try { keywords = JSON.parse(ep.analysis.arguments || '[]'); } catch {}

        const pdfBuffer = await generateEpisodePdf({
          podcastName: ep.podcast.name,
          episodeTitle: ep.episode.title,
          publishedAt: ep.episode.published_at,
          durationSeconds: ep.episode.duration_seconds || undefined,
          summary: ep.analysis.summary || '',
          keyPoints,
          keywords,
          fullRecap: ep.analysis.knowledge_points || '',
        });

        const pubDate = dayjs(ep.episode.published_at).format('YYYY-MM-DD');
        const safePodcast = ep.podcast.name.replace(/[/\\?%*:|"<>]/g, '-').trim();
        attachments.push({
          filename: `${safePodcast}-${pubDate}.pdf`,
          content: pdfBuffer,
          contentType: 'application/pdf',
        });
      } catch (err) {
        logger.warn('Failed to generate PDF attachment, skipping', {
          episode: ep.episode.title,
          error: (err as Error).message,
        });
      }
    }

    logger.info('PDF attachments prepared', { count: attachments.length });

    await sendEmail({ from, to: config.email.toAddress, subject, html, attachments });

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
