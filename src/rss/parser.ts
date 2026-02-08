import Parser from 'rss-parser';
import { logger } from '../utils/logger';
import { withRetry } from '../utils/retry';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const parser: any = new (Parser as any)({
  customFields: {
    item: [
      ['itunes:duration', 'itunesDuration'],
      ['itunes:summary', 'itunesSummary'],
      ['itunes:image', 'itunesImage'],
    ],
    feed: [
      ['itunes:author', 'itunesAuthor'],
      ['itunes:image', 'itunesImage'],
      ['itunes:category', 'itunesCategory'],
    ],
  },
  timeout: 15000,
});

export interface ParsedFeed {
  title: string;
  description: string;
  author: string;
  imageUrl: string;
  language: string;
  category: string;
  episodes: ParsedEpisode[];
}

export interface ParsedEpisode {
  guid: string;
  title: string;
  description: string;
  audioUrl: string;
  audioFormat: string;
  durationSeconds: number;
  publishedAt: string;
  fileSize: number;
}

export async function parseFeed(feedUrl: string): Promise<ParsedFeed> {
  const feed: any = await withRetry(
    () => parser.parseURL(feedUrl),
    { maxAttempts: 3, baseDelayMs: 3000 }
  );

  const episodes: ParsedEpisode[] = (feed.items || []).map((item: any) => {
    const enclosure = item.enclosure;
    const audioUrl = enclosure?.url || '';
    const audioFormat = extractAudioFormat(enclosure?.type || audioUrl);

    return {
      guid: item.guid || item.link || item.title || '',
      title: item.title || '',
      description: item.contentSnippet || item.content || (item as any).itunesSummary || '',
      audioUrl,
      audioFormat,
      durationSeconds: parseDuration((item as any).itunesDuration),
      publishedAt: item.pubDate ? new Date(item.pubDate).toISOString() : new Date().toISOString(),
      fileSize: enclosure?.length ? parseInt(String(enclosure.length), 10) : 0,
    };
  });

  const itunesImage = (feed as any).itunesImage;
  const imageUrl = typeof itunesImage === 'string'
    ? itunesImage
    : itunesImage?.href || itunesImage?.['$']?.href || feed.image?.url || '';

  return {
    title: feed.title || '',
    description: feed.description || '',
    author: (feed as any).itunesAuthor || feed.creator || '',
    imageUrl,
    language: feed.language || 'zh-CN',
    category: extractCategory((feed as any).itunesCategory),
    episodes,
  };
}

export async function validateFeed(feedUrl: string): Promise<{
  valid: boolean;
  title?: string;
  episodeCount?: number;
  hasAudio?: boolean;
  error?: string;
}> {
  try {
    const feed = await parseFeed(feedUrl);
    const hasAudio = feed.episodes.some(e => e.audioUrl && isAudioUrl(e.audioUrl));
    return {
      valid: true,
      title: feed.title,
      episodeCount: feed.episodes.length,
      hasAudio,
    };
  } catch (error) {
    return {
      valid: false,
      error: (error as Error).message,
    };
  }
}

function extractAudioFormat(typeOrUrl: string): string {
  if (typeOrUrl.includes('mp3') || typeOrUrl.includes('mpeg')) return 'mp3';
  if (typeOrUrl.includes('m4a') || typeOrUrl.includes('mp4')) return 'm4a';
  if (typeOrUrl.includes('wav')) return 'wav';
  if (typeOrUrl.includes('ogg')) return 'ogg';
  return 'mp3';
}

function isAudioUrl(url: string): boolean {
  const audioExtensions = ['.mp3', '.m4a', '.wav', '.ogg', '.aac', '.flac'];
  const lowerUrl = url.toLowerCase().split('?')[0];
  return audioExtensions.some(ext => lowerUrl.endsWith(ext)) || url.includes('audio');
}

function parseDuration(duration: any): number {
  if (!duration) return 0;
  if (typeof duration === 'number') return duration;
  const str = String(duration);
  const parts = str.split(':').map(Number);
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 1) return parts[0];
  return 0;
}

function extractCategory(cat: any): string {
  if (!cat) return '';
  if (typeof cat === 'string') return cat;
  if (cat?.['$']?.text) return cat['$'].text;
  if (Array.isArray(cat)) return cat.map(c => extractCategory(c)).filter(Boolean).join(', ');
  return '';
}
