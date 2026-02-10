import fs from 'fs';
import path from 'path';
import dayjs from 'dayjs';
import { logger } from '../utils/logger';
import { AnalysisOutput, KeyPoint, Keyword } from '../analysis';

export interface MarkdownInput {
  podcastName: string;
  episodeTitle: string;
  publishedAt: string;
  durationSeconds?: number;
  audioUrl?: string;
  analysis: AnalysisOutput;
}

export function generateMarkdown(input: MarkdownInput): string {
  const date = dayjs(input.publishedAt).format('YYYY-MM-DD');
  const duration = formatDuration(input.durationSeconds || 0);

  const sections: string[] = [];

  // Header
  sections.push(`# ${input.episodeTitle}`);
  sections.push('');
  sections.push(`> **播客**: ${input.podcastName}`);
  sections.push(`> **日期**: ${date}`);
  if (duration) sections.push(`> **时长**: ${duration}`);
  if (input.audioUrl) sections.push(`> **音频**: [收听原始音频](${input.audioUrl})`);
  sections.push('');
  sections.push('---');
  sections.push('');

  // 1. Summary (~800 chars)
  sections.push('## 📝 内容核心摘要');
  sections.push('');
  sections.push(input.analysis.summary);
  sections.push('');

  // 2. Key Points with expandable details
  if (input.analysis.keyPoints.length > 0) {
    sections.push('## 🎯 核心要点');
    sections.push('');
    for (const point of input.analysis.keyPoints) {
      sections.push(formatKeyPoint(point));
    }
  }

  // 3. Keywords with context
  if (input.analysis.keywords.length > 0) {
    sections.push('## 🔑 核心关键词分析');
    sections.push('');
    for (const kw of input.analysis.keywords) {
      sections.push(formatKeyword(kw));
    }
  }

  // 4. Full recap (3000-5000 chars)
  if (input.analysis.fullRecap) {
    sections.push('## 📖 长版内容纪要');
    sections.push('');
    sections.push(input.analysis.fullRecap);
    sections.push('');
  }

  // Footer
  sections.push('---');
  sections.push('');
  sections.push(`*本文档由 Podcast Digest 自动生成于 ${dayjs().format('YYYY-MM-DD HH:mm:ss')}*`);
  sections.push('');

  return sections.join('\n');
}

function formatKeyPoint(point: KeyPoint): string {
  const lines: string[] = [];
  lines.push(`### ${point.title}`);
  lines.push('');

  if (point.detail) {
    lines.push('<details>');
    lines.push('<summary>点击展开详细内容</summary>');
    lines.push('');
    lines.push(point.detail);
    lines.push('');
    lines.push('</details>');
    lines.push('');
  }

  return lines.join('\n');
}

function formatKeyword(kw: Keyword): string {
  const lines: string[] = [];
  lines.push(`**${kw.word}**`);
  lines.push('');
  lines.push(kw.context);
  lines.push('');
  return lines.join('\n');
}

function formatDuration(seconds: number): string {
  if (seconds <= 0) return '';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}小时${m}分钟`;
  return `${m}分钟`;
}

export function saveMarkdown(
  content: string,
  podcastName: string,
  publishedAt: string,
  summariesDir: string
): string {
  const safeName = podcastName.replace(/[/\\?%*:|"<>]/g, '-').trim();
  const date = dayjs(publishedAt).format('YYYY-MM-DD');
  const dirPath = path.join(summariesDir, safeName);

  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }

  const filename = `${date}-podcast-summary.md`;
  const filePath = path.join(dirPath, filename);

  // Handle duplicate names
  let finalPath = filePath;
  let counter = 1;
  while (fs.existsSync(finalPath)) {
    finalPath = path.join(dirPath, `${date}-podcast-summary-${counter}.md`);
    counter++;
  }

  fs.writeFileSync(finalPath, content, 'utf-8');
  logger.info('Markdown saved', { path: finalPath });
  return finalPath;
}

export function listMarkdownFiles(summariesDir: string): { podcast: string; files: string[] }[] {
  if (!fs.existsSync(summariesDir)) return [];

  const result: { podcast: string; files: string[] }[] = [];
  const entries = fs.readdirSync(summariesDir, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.isDirectory()) {
      const podcastDir = path.join(summariesDir, entry.name);
      const files = fs.readdirSync(podcastDir)
        .filter(f => f.endsWith('.md'))
        .sort()
        .reverse();
      if (files.length > 0) {
        result.push({ podcast: entry.name, files });
      }
    }
  }

  return result;
}

export interface MarkdownFileMeta {
  podcast: string;
  filename: string;
  title: string;
  date: string;
}

/** 扫描文件系统获取所有 markdown 文件及元数据（从文件头部解析标题） */
export function listMarkdownFilesWithMeta(summariesDir: string): MarkdownFileMeta[] {
  if (!fs.existsSync(summariesDir)) return [];

  const results: MarkdownFileMeta[] = [];
  const entries = fs.readdirSync(summariesDir, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const podcastDir = path.join(summariesDir, entry.name);
    const files = fs.readdirSync(podcastDir).filter(f => f.endsWith('.md'));

    for (const file of files) {
      // 从文件名提取日期 (格式: YYYY-MM-DD-podcast-summary.md)
      const dateMatch = file.match(/^(\d{4}-\d{2}-\d{2})/);
      const date = dateMatch ? dateMatch[1] : '';

      // 从文件第一行 # 标题 解析标题
      let title = file;
      try {
        const content = fs.readFileSync(path.join(podcastDir, file), 'utf-8');
        const firstLine = content.split('\n').find(l => l.startsWith('# '));
        if (firstLine) {
          title = firstLine.replace(/^#\s+/, '').trim();
        }
      } catch { /* fallback to filename */ }

      results.push({ podcast: entry.name, filename: file, title, date });
    }
  }

  return results;
}

export function readMarkdown(summariesDir: string, podcast: string, filename: string): string | null {
  const filePath = path.join(summariesDir, podcast, filename);
  if (!fs.existsSync(filePath)) return null;
  return fs.readFileSync(filePath, 'utf-8');
}
