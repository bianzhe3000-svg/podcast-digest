/**
 * Notion 集成：把 Podcast Digest 全文推送到 Notion 数据库
 *
 * 配置（一次性）：
 *  1. https://www.notion.so/profile/integrations 创建 Internal Integration，复制 Token
 *  2. 目标数据库 ··· → 添加连接 → 选该集成
 *  3. Railway 环境变量加 NOTION_API_KEY=<token>
 *  4. 可选 NOTION_DATABASE_ID（默认值已内置）
 */
import { Client } from '@notionhq/client';
import { logger } from '../utils/logger';
import { getDatabase } from '../database';

const DEFAULT_DB_ID = '3771cbd22f9c804fac3bd707096956ea';
const NOTION_TEXT_LIMIT = 1800;  // 单 rich_text 上限 2000，留余量
const NOTION_BLOCK_BATCH = 90;   // 单次 append 上限 100，留余量

// ── 通用 episode 结构 ───────────────────────────────────────────────────────
interface DigestEp {
  id: number;
  title: string;
  podcastName: string;
  publishedAt: string;
  durationSeconds: number | null;
  summary: string;
  keyPoints: { title: string; detail: string }[];
  keywords: { word: string; context?: string }[];
  fullRecap: string;
}

// ── 文本切分 ────────────────────────────────────────────────────────────────
function chunkText(text: string, maxLen = NOTION_TEXT_LIMIT): string[] {
  if (!text) return [];
  const chunks: string[] = [];
  let i = 0;
  while (i < text.length) {
    let end = Math.min(i + maxLen, text.length);
    if (end < text.length) {
      const slice = text.slice(i, end);
      const last = Math.max(slice.lastIndexOf('。'), slice.lastIndexOf('！'), slice.lastIndexOf('？'), slice.lastIndexOf('\n'));
      if (last > maxLen * 0.5) end = i + last + 1;
    }
    chunks.push(text.slice(i, end).trim());
    i = end;
  }
  return chunks.filter(Boolean);
}

// ── block 构造器 ────────────────────────────────────────────────────────────
const para = (t: string): any => ({ object: 'block', type: 'paragraph', paragraph: { rich_text: [{ type: 'text', text: { content: t } }] } });
const boldPara = (t: string): any => ({ object: 'block', type: 'paragraph', paragraph: { rich_text: [{ type: 'text', text: { content: t }, annotations: { bold: true } }] } });
const h = (lvl: 1 | 2 | 3, t: string): any => {
  const k = lvl === 1 ? 'heading_1' : lvl === 2 ? 'heading_2' : 'heading_3';
  return { object: 'block', type: k, [k]: { rich_text: [{ type: 'text', text: { content: t } }] } };
};
const bullet = (t: string): any => ({ object: 'block', type: 'bulleted_list_item', bulleted_list_item: { rich_text: [{ type: 'text', text: { content: t } }] } });
const bookmark = (url: string, cap?: string): any => ({ object: 'block', type: 'bookmark', bookmark: { url, caption: cap ? [{ type: 'text', text: { content: cap } }] : [] } });
const divider = (): any => ({ object: 'block', type: 'divider', divider: {} });
const callout = (emoji: string, t: string): any => ({ object: 'block', type: 'callout', callout: { icon: { type: 'emoji', emoji }, rich_text: [{ type: 'text', text: { content: t } }] } });
const tocBlock = (): any => ({ object: 'block', type: 'table_of_contents', table_of_contents: { color: 'default' } });

// 一集的所有 block。剧集标题用 heading_2（进目录），小节标签用加粗段落（不进目录，保持目录干净）
function episodeBlocks(idx: number, ep: DigestEp): any[] {
  const blocks: any[] = [];
  blocks.push(h(2, `${idx}. 【${ep.podcastName || ''}】${ep.title || ''}`));

  const pubDate = (ep.publishedAt || '').slice(0, 10);
  const meta = [pubDate && `📅 ${pubDate}`, ep.durationSeconds && `⏱️ ${Math.round(ep.durationSeconds / 60)} 分钟`].filter(Boolean).join('  ·  ');
  if (meta) blocks.push(para(meta));

  if (ep.summary) {
    blocks.push(boldPara('📝 内容摘要'));
    for (const c of chunkText(ep.summary)) blocks.push(para(c));
  }
  if (ep.keyPoints?.length) {
    blocks.push(boldPara('🎯 核心要点'));
    for (const kp of ep.keyPoints) {
      const txt = `${kp.title || ''}${kp.detail ? '：' + kp.detail : ''}`;
      blocks.push(bullet(txt.length > NOTION_TEXT_LIMIT ? txt.slice(0, NOTION_TEXT_LIMIT - 3) + '...' : txt));
    }
  }
  if (ep.keywords?.length) {
    blocks.push(boldPara('🔑 关键词'));
    const kwText = ep.keywords.map(k => k.word || '').filter(Boolean).join('  ·  ');
    for (const c of chunkText(kwText)) blocks.push(para(c));
  }
  if (ep.fullRecap) {
    blocks.push(boldPara('📖 详细纪要'));
    for (const c of chunkText(ep.fullRecap)) blocks.push(para(c));
  }
  blocks.push(divider());
  return blocks;
}

// ── 从 DB 取一集的完整结构 ──────────────────────────────────────────────────
function loadEpisode(id: number): DigestEp | null {
  const db = getDatabase();
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
}

// ── 核心：创建一个 Notion 页面（目录 + 内容） ───────────────────────────────
async function createDigestPage(
  notion: Client,
  dbId: string,
  opts: { title: string; overview?: string; audioUrl?: string | null; episodes: DigestEp[] }
): Promise<{ pageUrl: string; pageId: string; blockCount: number }> {
  const page: any = await notion.pages.create({
    parent: { database_id: dbId } as any,
    properties: { '名称': { title: [{ type: 'text', text: { content: opts.title } }] } } as any,
  });

  const allBlocks: any[] = [];

  // 1. 目录（点击任意标题跳转）
  allBlocks.push(callout('🧭', '目录（点击下方任意标题可跳转到对应剧集）'));
  allBlocks.push(tocBlock());
  allBlocks.push(divider());

  // 2. 音频
  if (opts.audioUrl) {
    allBlocks.push(callout('🎙️', '今日 30 分钟精华播报'));
    allBlocks.push(bookmark(opts.audioUrl, '30 分钟 AI 编辑播报版'));
  }

  // 3. 今日全览
  if (opts.overview) {
    allBlocks.push(h(1, '🌅 今日全览'));
    for (const c of chunkText(opts.overview)) allBlocks.push(para(c));
    allBlocks.push(divider());
  }

  // 4. 剧集详情
  allBlocks.push(h(1, `🎧 剧集详情（${opts.episodes.length} 集）`));
  let idx = 0;
  for (const ep of opts.episodes) {
    idx++;
    allBlocks.push(...episodeBlocks(idx, ep));
  }

  // 5. 分批 append
  for (let i = 0; i < allBlocks.length; i += NOTION_BLOCK_BATCH) {
    const batch = allBlocks.slice(i, i + NOTION_BLOCK_BATCH);
    await notion.blocks.children.append({ block_id: page.id, children: batch });
    // 轻微节流，避免 Notion 限流（~3 req/s）
    await new Promise(r => setTimeout(r, 350));
  }

  return { pageUrl: page.url, pageId: page.id, blockCount: allBlocks.length };
}

// ── 公开：推送某天的 digest ─────────────────────────────────────────────────
export async function pushDigestToNotion(date: string): Promise<{
  ok: boolean; pageUrl?: string; pageId?: string; blockCount?: number; error?: string;
}> {
  const apiKey = process.env.NOTION_API_KEY;
  if (!apiKey) return { ok: false, error: 'NOTION_API_KEY not configured' };
  const dbId = process.env.NOTION_DATABASE_ID || DEFAULT_DB_ID;

  try {
    const db = getDatabase();
    const digest = db.getDailyDigest(date);
    if (!digest) return { ok: false, error: `No digest for date ${date}` };

    const episodeIds: number[] = JSON.parse(digest.episode_ids || '[]');
    const episodes = episodeIds.map(loadEpisode).filter(Boolean) as DigestEp[];

    const baseUrl = process.env.RAILWAY_PUBLIC_DOMAIN
      ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
      : 'https://podcast-digest-production.up.railway.app';
    const audioUrl = digest.audio_filename ? `${baseUrl}/api/audio/${digest.audio_filename}` : null;

    const notion = new Client({ auth: apiKey });
    logger.info('Pushing daily digest to Notion', { date, episodeCount: episodes.length });

    const r = await createDigestPage(notion, dbId, {
      title: `📰 Podcast Digest ${date} (${episodes.length}集)`,
      overview: digest.summary || undefined,
      audioUrl,
      episodes,
    });
    logger.info('Notion daily digest pushed', { date, ...r });
    return { ok: true, ...r };
  } catch (err: any) {
    const msg = err?.body ? JSON.stringify(err.body) : (err as Error).message;
    logger.error('Notion push failed', { date, error: msg });
    return { ok: false, error: msg };
  }
}

// ── 公开：批量推送历史剧集（按发布日期分组，每天一个页面） ──────────────────
export async function pushHistoricalToNotion(
  sinceDays: number,
  onProgress?: (msg: string) => void
): Promise<{ ok: boolean; daysPushed: number; episodesPushed: number; pages: string[]; error?: string }> {
  const apiKey = process.env.NOTION_API_KEY;
  if (!apiKey) return { ok: false, daysPushed: 0, episodesPushed: 0, pages: [], error: 'NOTION_API_KEY not configured' };
  const dbId = process.env.NOTION_DATABASE_ID || DEFAULT_DB_ID;

  try {
    const db = getDatabase();
    const sinceHours = sinceDays * 24;
    const rows = db.getCompletedEpisodesSince(sinceHours);
    onProgress?.(`找到 ${rows.length} 集已完成剧集（过去 ${sinceDays} 天）`);

    // 按发布日期分组
    const byDate = new Map<string, DigestEp[]>();
    for (const row of rows) {
      const ep = loadEpisode(row.id);
      if (!ep) continue;
      const d = (ep.publishedAt || '').slice(0, 10) || 'unknown';
      if (!byDate.has(d)) byDate.set(d, []);
      byDate.get(d)!.push(ep);
    }

    // 日期降序
    const dates = [...byDate.keys()].sort((a, b) => b.localeCompare(a));
    onProgress?.(`分为 ${dates.length} 个日期，开始逐日推送...`);

    const notion = new Client({ auth: apiKey });
    const pages: string[] = [];
    let episodesPushed = 0;

    for (let i = 0; i < dates.length; i++) {
      const date = dates[i];
      const eps = byDate.get(date)!;
      // 组内按播客名排序
      eps.sort((a, b) => a.podcastName.localeCompare(b.podcastName));
      try {
        const r = await createDigestPage(notion, dbId, {
          title: `📚 Podcast Digest ${date} (${eps.length}集)`,
          episodes: eps,
        });
        pages.push(r.pageUrl);
        episodesPushed += eps.length;
        onProgress?.(`[${i + 1}/${dates.length}] ${date} 推送成功（${eps.length} 集）`);
      } catch (err: any) {
        const msg = err?.body ? JSON.stringify(err.body) : (err as Error).message;
        logger.warn('Notion historical day push failed', { date, error: msg });
        onProgress?.(`[${i + 1}/${dates.length}] ${date} 失败：${msg.slice(0, 80)}`);
      }
      // 日期之间停顿，避免限流
      await new Promise(r => setTimeout(r, 500));
    }

    return { ok: true, daysPushed: pages.length, episodesPushed, pages };
  } catch (err: any) {
    const msg = err?.body ? JSON.stringify(err.body) : (err as Error).message;
    logger.error('Notion historical push failed', { error: msg });
    return { ok: false, daysPushed: 0, episodesPushed: 0, pages: [], error: msg };
  }
}
