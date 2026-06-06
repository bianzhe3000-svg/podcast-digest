/**
 * Notion 集成：把每日 Podcast Digest 全文推送到 Notion 数据库
 *
 * 配置步骤（一次性）：
 *  1. 打开 https://www.notion.so/profile/integrations 创建 Internal Integration
 *  2. 复制 Token（通常 ntn_xxx 开头）
 *  3. 在目标 Notion 数据库右上角 ··· → 添加连接 → 选刚创建的集成
 *  4. 在 Railway 环境变量加 NOTION_API_KEY=<token>
 *  5. 可选：NOTION_DATABASE_ID=<dataSourceId>（默认值已在代码里）
 */
import { Client } from '@notionhq/client';
import { config } from '../config';
import { logger } from '../utils/logger';
import { getDatabase, Episode } from '../database';

// 默认数据库 ID（用户提供的 URL 中的 ID）
const DEFAULT_DB_ID = '3771cbd22f9c804fac3bd707096956ea';

const NOTION_TEXT_LIMIT = 1800; // Notion API 单个 rich_text 上限 2000，留余量
const NOTION_BLOCK_BATCH = 90;  // 单次 append 上限 100，留余量

function chunkText(text: string, maxLen: number = NOTION_TEXT_LIMIT): string[] {
  if (!text) return [];
  const chunks: string[] = [];
  let i = 0;
  while (i < text.length) {
    // 优先在句号/换行处切分
    let end = Math.min(i + maxLen, text.length);
    if (end < text.length) {
      const slice = text.slice(i, end);
      // 找最后一个句号/换行
      const last = Math.max(slice.lastIndexOf('。'), slice.lastIndexOf('！'), slice.lastIndexOf('？'), slice.lastIndexOf('\n'));
      if (last > maxLen * 0.5) end = i + last + 1;
    }
    chunks.push(text.slice(i, end).trim());
    i = end;
  }
  return chunks.filter(Boolean);
}

function paragraphBlock(text: string): any {
  return {
    object: 'block',
    type: 'paragraph',
    paragraph: { rich_text: [{ type: 'text', text: { content: text } }] },
  };
}
function headingBlock(level: 1 | 2 | 3, text: string): any {
  const key = level === 1 ? 'heading_1' : level === 2 ? 'heading_2' : 'heading_3';
  return {
    object: 'block',
    type: key,
    [key]: { rich_text: [{ type: 'text', text: { content: text } }] },
  };
}
function bulletBlock(text: string): any {
  return {
    object: 'block',
    type: 'bulleted_list_item',
    bulleted_list_item: { rich_text: [{ type: 'text', text: { content: text } }] },
  };
}
function bookmarkBlock(url: string, caption?: string): any {
  return {
    object: 'block',
    type: 'bookmark',
    bookmark: {
      url,
      caption: caption ? [{ type: 'text', text: { content: caption } }] : [],
    },
  };
}
function dividerBlock(): any {
  return { object: 'block', type: 'divider', divider: {} };
}
function calloutBlock(emoji: string, text: string): any {
  return {
    object: 'block',
    type: 'callout',
    callout: {
      icon: { type: 'emoji', emoji },
      rich_text: [{ type: 'text', text: { content: text } }],
    },
  };
}

/** 给一个 episode 构建所有 blocks */
function episodeBlocks(idx: number, ep: any): any[] {
  const blocks: any[] = [];
  const title = `${idx}. 【${ep.podcastName || ''}】${ep.title || ''}`;
  blocks.push(headingBlock(2, title));

  // 元数据
  const pubDate = (ep.publishedAt || '').slice(0, 10);
  const meta = [pubDate && `📅 ${pubDate}`, ep.durationSeconds && `⏱️ ${Math.round(ep.durationSeconds / 60)} 分钟`]
    .filter(Boolean).join(' · ');
  if (meta) blocks.push(paragraphBlock(meta));

  // 摘要
  if (ep.summary) {
    blocks.push(headingBlock(3, '📝 内容摘要'));
    for (const c of chunkText(ep.summary)) blocks.push(paragraphBlock(c));
  }

  // 要点
  if (ep.keyPoints && ep.keyPoints.length > 0) {
    blocks.push(headingBlock(3, '🎯 核心要点'));
    for (const kp of ep.keyPoints) {
      const txt = `${kp.title || ''}${kp.detail ? '：' + kp.detail : ''}`;
      // 单个 bullet 可能也超长
      const trimmed = txt.length > NOTION_TEXT_LIMIT ? txt.slice(0, NOTION_TEXT_LIMIT - 3) + '...' : txt;
      blocks.push(bulletBlock(trimmed));
    }
  }

  // 关键词
  if (ep.keywords && ep.keywords.length > 0) {
    blocks.push(headingBlock(3, '🔑 关键词'));
    const kwText = ep.keywords.map((k: any) => k.word || '').filter(Boolean).join(' · ');
    if (kwText) {
      for (const c of chunkText(kwText)) blocks.push(paragraphBlock(c));
    }
  }

  // 详细纪要
  if (ep.fullRecap) {
    blocks.push(headingBlock(3, '📖 详细纪要'));
    for (const c of chunkText(ep.fullRecap)) blocks.push(paragraphBlock(c));
  }

  blocks.push(dividerBlock());
  return blocks;
}

/**
 * 把指定日期的 digest 推送到 Notion
 * @param date YYYY-MM-DD 格式
 * @returns {ok, pageUrl, error?}
 */
export async function pushDigestToNotion(date: string): Promise<{
  ok: boolean;
  pageUrl?: string;
  pageId?: string;
  blockCount?: number;
  error?: string;
}> {
  const apiKey = process.env.NOTION_API_KEY;
  if (!apiKey) {
    return { ok: false, error: 'NOTION_API_KEY not configured' };
  }
  const dbId = process.env.NOTION_DATABASE_ID || DEFAULT_DB_ID;

  try {
    const db = getDatabase();
    const digest = db.getDailyDigest(date);
    if (!digest) {
      return { ok: false, error: `No digest found for date ${date}` };
    }

    const episodeIds: number[] = JSON.parse(digest.episode_ids || '[]');
    const episodes = episodeIds.map(id => {
      const ep = db.getEpisodeById(id);
      const analysis = db.getAnalysisResult(id);
      if (!ep || !analysis) return null;
      const podcast = db.getPodcastById(ep.podcast_id);
      let keyPoints: any[] = [];
      let keywords: any[] = [];
      try { keyPoints = JSON.parse(analysis.key_points || '[]'); } catch {}
      try { keywords = JSON.parse(analysis.arguments || '[]'); } catch {}
      return {
        id,
        title: ep.title,
        podcastName: podcast?.name || '',
        publishedAt: ep.published_at,
        durationSeconds: ep.duration_seconds,
        summary: analysis.summary,
        keyPoints,
        keywords,
        fullRecap: analysis.knowledge_points,
      };
    }).filter(Boolean) as any[];

    const baseUrl = process.env.RAILWAY_PUBLIC_DOMAIN
      ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
      : 'https://podcast-digest-production.up.railway.app';
    const audioUrl = digest.audio_filename ? `${baseUrl}/api/audio/${digest.audio_filename}` : null;

    const notion = new Client({ auth: apiKey });

    logger.info('Pushing digest to Notion', { date, episodeCount: episodes.length, dbId });

    // 1. 创建 page（仅标题）
    const pageTitle = `📰 Podcast Digest ${date} (${episodes.length}集)`;
    const page: any = await notion.pages.create({
      parent: { database_id: dbId } as any,
      properties: {
        '名称': { title: [{ type: 'text', text: { content: pageTitle } }] },
      } as any,
    });
    const pageId = page.id;
    const pageUrl = page.url;

    // 2. 构建所有 blocks
    const allBlocks: any[] = [];

    // 顶部：音频链接
    if (audioUrl) {
      allBlocks.push(calloutBlock('🎙️', '今日 30 分钟精华播报（点击下方链接收听）'));
      allBlocks.push(bookmarkBlock(audioUrl, '30 分钟 AI 编辑播报版'));
    }

    // 今日全览
    if (digest.summary) {
      allBlocks.push(headingBlock(1, '🌅 今日全览'));
      for (const c of chunkText(digest.summary)) allBlocks.push(paragraphBlock(c));
      allBlocks.push(dividerBlock());
    }

    // 剧集详情
    allBlocks.push(headingBlock(1, `🎧 剧集详情（${episodes.length} 集）`));
    let idx = 0;
    for (const ep of episodes) {
      idx++;
      const blocks = episodeBlocks(idx, ep);
      allBlocks.push(...blocks);
    }

    // 3. 分批追加 blocks（每批最多 90 个）
    let appended = 0;
    for (let i = 0; i < allBlocks.length; i += NOTION_BLOCK_BATCH) {
      const batch = allBlocks.slice(i, i + NOTION_BLOCK_BATCH);
      await notion.blocks.children.append({
        block_id: pageId,
        children: batch,
      });
      appended += batch.length;
      logger.info(`Notion blocks appended: ${appended}/${allBlocks.length}`);
    }

    logger.info('Notion digest pushed', { date, pageUrl, blockCount: allBlocks.length });
    return { ok: true, pageUrl, pageId, blockCount: allBlocks.length };
  } catch (err: any) {
    const msg = err?.body ? JSON.stringify(err.body) : (err as Error).message;
    logger.error('Failed to push to Notion', { date, error: msg });
    return { ok: false, error: msg };
  }
}
