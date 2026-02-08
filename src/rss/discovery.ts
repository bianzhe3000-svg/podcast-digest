import axios from 'axios';
import { XMLParser } from 'fast-xml-parser';
import { logger } from '../utils/logger';
import { withRetry } from '../utils/retry';

export interface PodcastSearchResult {
  name: string;
  author: string;
  feedUrl: string;
  artworkUrl: string;
  genre: string;
}

export async function searchPodcasts(query: string, limit = 10): Promise<PodcastSearchResult[]> {
  try {
    const response = await withRetry(
      () => axios.get('https://itunes.apple.com/search', {
        params: {
          term: query,
          media: 'podcast',
          limit,
          country: 'CN',
        },
        timeout: 10000,
      }),
      { maxAttempts: 3, baseDelayMs: 2000 }
    );

    const results = response.data.results || [];
    return results.map((item: any) => ({
      name: item.collectionName || item.trackName || '',
      author: item.artistName || '',
      feedUrl: item.feedUrl || '',
      artworkUrl: item.artworkUrl600 || item.artworkUrl100 || '',
      genre: item.primaryGenreName || '',
    })).filter((r: PodcastSearchResult) => r.feedUrl);
  } catch (error) {
    logger.error('Podcast search failed', { query, error: (error as Error).message });
    throw error;
  }
}

export function parseOPML(opmlContent: string): { name: string; feedUrl: string }[] {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
  });

  try {
    const parsed = parser.parse(opmlContent);
    const results: { name: string; feedUrl: string }[] = [];

    function extractOutlines(node: any): void {
      if (!node) return;
      const items = Array.isArray(node) ? node : [node];
      for (const item of items) {
        const xmlUrl = item['@_xmlUrl'] || item['@_xmlurl'];
        if (xmlUrl) {
          results.push({
            name: item['@_text'] || item['@_title'] || 'Unknown',
            feedUrl: xmlUrl,
          });
        }
        if (item.outline) {
          extractOutlines(item.outline);
        }
      }
    }

    const body = parsed?.opml?.body;
    if (body?.outline) {
      extractOutlines(body.outline);
    }

    logger.info(`Parsed OPML: found ${results.length} feeds`);
    return results;
  } catch (error) {
    logger.error('OPML parse failed', { error: (error as Error).message });
    throw new Error('Invalid OPML format');
  }
}

export function fuzzyMatch(query: string, candidates: string[]): string[] {
  const q = query.toLowerCase();
  return candidates
    .map(c => ({
      text: c,
      score: calculateScore(q, c.toLowerCase()),
    }))
    .filter(r => r.score > 0.3)
    .sort((a, b) => b.score - a.score)
    .map(r => r.text);
}

function calculateScore(query: string, candidate: string): number {
  if (candidate === query) return 1;
  if (candidate.includes(query)) return 0.8;
  if (query.includes(candidate)) return 0.6;

  let matches = 0;
  let qi = 0;
  for (let ci = 0; ci < candidate.length && qi < query.length; ci++) {
    if (candidate[ci] === query[qi]) {
      matches++;
      qi++;
    }
  }
  return qi === query.length ? matches / candidate.length * 0.5 : matches / query.length * 0.3;
}
