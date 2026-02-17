import fs from 'fs';
import path from 'path';
import PDFDocument from 'pdfkit';
import { logger } from '../utils/logger';
import { config } from '../config';

interface FontInfo {
  path: string;
  /** 是否为 TTC (TrueType Collection)，需要用 postscriptName 选择 */
  isTTC: boolean;
  /** TTC 中的字体名称 */
  postscriptName?: string;
}

/** 查找可用的中文字体 */
function findChineseFont(): FontInfo | null {
  const candidates: FontInfo[] = [
    // 单独 TTF/OTF（优先，最兼容）
    { path: '/Library/Fonts/Arial Unicode.ttf', isTTC: false },
    // Docker (Debian/Ubuntu) - fonts-noto-cjk (OTF 版本)
    { path: '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc', isTTC: true, postscriptName: 'NotoSansCJKsc-Regular' },
    { path: '/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc', isTTC: true, postscriptName: 'NotoSansCJKsc-Regular' },
    { path: '/usr/share/fonts/noto-cjk/NotoSansCJK-Regular.ttc', isTTC: true, postscriptName: 'NotoSansCJKsc-Regular' },
    // macOS
    { path: '/System/Library/Fonts/STHeiti Medium.ttc', isTTC: true, postscriptName: 'STHeitiSC-Medium' },
    { path: '/System/Library/Fonts/PingFang.ttc', isTTC: true, postscriptName: 'PingFangSC-Regular' },
    // Linux - WenQuanYi
    { path: '/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc', isTTC: true, postscriptName: 'WenQuanYiZenHei' },
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate.path)) {
      return candidate;
    }
  }
  return null;
}

interface PdfEpisodeData {
  podcastName: string;
  episodeTitle: string;
  publishedAt: string;
  durationSeconds?: number;
  summary: string;
  keyPoints: { title: string; detail: string }[];
  keywords: { word: string; context: string }[];
  fullRecap: string;
}

/**
 * 从 markdown 文件路径生成 PDF（保持原有接口兼容）
 */
export async function exportToPdf(markdownPath: string): Promise<string> {
  if (!config.pdf.enabled) {
    throw new Error('PDF export is disabled');
  }

  const pdfPath = markdownPath.replace(/\.md$/, '.pdf');

  try {
    const mdContent = fs.readFileSync(markdownPath, 'utf-8');
    const pdfBuffer = await generatePdfFromMarkdown(mdContent);
    fs.writeFileSync(pdfPath, pdfBuffer);
    logger.info('PDF exported', { path: pdfPath });
    return pdfPath;
  } catch (error) {
    logger.error('PDF export failed', { error: (error as Error).message, path: markdownPath });
    throw error;
  }
}

/**
 * 从分析数据直接生成 PDF Buffer（供邮件附件使用）
 */
export async function generateEpisodePdf(data: PdfEpisodeData): Promise<Buffer> {
  const chineseFont = findChineseFont();

  const doc = new PDFDocument({
    size: 'A4',
    margins: { top: 50, bottom: 50, left: 50, right: 50 },
    info: {
      Title: data.episodeTitle,
      Author: 'Podcast Digest',
      Subject: `${data.podcastName} - ${data.episodeTitle}`,
    },
  });

  const chunks: Buffer[] = [];
  doc.on('data', (chunk: Buffer) => chunks.push(chunk));

  const pdfReady = new Promise<Buffer>((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  // 注册中文字体
  if (chineseFont) {
    if (chineseFont.isTTC && chineseFont.postscriptName) {
      // TTC 字体需要通过 postscriptName 指定具体字体
      doc.registerFont('Chinese', chineseFont.path, chineseFont.postscriptName);
      doc.registerFont('ChineseBold', chineseFont.path, chineseFont.postscriptName);
    } else {
      doc.registerFont('Chinese', chineseFont.path);
      doc.registerFont('ChineseBold', chineseFont.path);
    }
  }

  const fontName = chineseFont ? 'Chinese' : 'Helvetica';
  const fontBold = chineseFont ? 'ChineseBold' : 'Helvetica-Bold';
  const pageWidth = doc.page.width - 100; // 50px margins on each side

  // === Header ===
  doc.rect(0, 0, doc.page.width, 100).fill('#667eea');
  doc.fill('#ffffff')
    .font(fontBold).fontSize(20)
    .text('🎧 Podcast Digest', 50, 30, { width: pageWidth, align: 'center' });
  doc.font(fontName).fontSize(11)
    .text(data.podcastName, 50, 60, { width: pageWidth, align: 'center' });

  doc.fill('#333333');
  let y = 120;

  // === Episode Title ===
  doc.font(fontBold).fontSize(16);
  doc.text(data.episodeTitle, 50, y, { width: pageWidth });
  y = doc.y + 8;

  // === Meta ===
  const pubDate = data.publishedAt ? data.publishedAt.substring(0, 10) : '';
  let meta = `📅 ${pubDate}`;
  if (data.durationSeconds && data.durationSeconds > 0) {
    const h = Math.floor(data.durationSeconds / 3600);
    const m = Math.floor((data.durationSeconds % 3600) / 60);
    meta += `  ·  ⏱️ ${h > 0 ? h + '小时' : ''}${m}分钟`;
  }
  doc.font(fontName).fontSize(9).fillColor('#999999');
  doc.text(meta, 50, y, { width: pageWidth });
  y = doc.y + 16;
  doc.fillColor('#333333');

  // === Helper: Section Header ===
  const sectionHeader = (icon: string, title: string) => {
    checkPageBreak(doc, 60);
    y = doc.y;
    doc.font(fontBold).fontSize(13).fillColor('#667eea');
    doc.text(`${icon} ${title}`, 50, y, { width: pageWidth });
    y = doc.y + 2;
    doc.moveTo(50, y).lineTo(50 + pageWidth, y).strokeColor('#e8edf5').lineWidth(1).stroke();
    y += 8;
    doc.fillColor('#333333');
    doc.y = y;
  };

  // === Section 1: Summary ===
  sectionHeader('📝', '内容核心摘要');
  doc.font(fontName).fontSize(10.5);
  doc.text(data.summary || '（暂无摘要）', 50, doc.y, { width: pageWidth, lineGap: 4 });
  doc.y += 12;

  // === Section 2: Key Points ===
  if (data.keyPoints && data.keyPoints.length > 0) {
    sectionHeader('🎯', '核心要点');
    for (const kp of data.keyPoints) {
      checkPageBreak(doc, 40);
      // Draw left border
      const startY = doc.y;
      doc.font(fontBold).fontSize(10.5).fillColor('#333333');
      doc.text(`▸ ${kp.title || ''}`, 56, doc.y, { width: pageWidth - 10 });

      if (kp.detail) {
        doc.font(fontName).fontSize(9.5).fillColor('#555555');
        doc.text(kp.detail, 60, doc.y + 2, { width: pageWidth - 16, lineGap: 3 });
      }
      const endY = doc.y;

      // Left accent bar
      doc.rect(50, startY - 2, 3, endY - startY + 6).fill('#667eea');
      doc.fillColor('#333333');
      doc.y = endY + 10;
    }
  }

  // === Section 3: Keywords ===
  if (data.keywords && data.keywords.length > 0) {
    sectionHeader('🔑', '核心关键词分析');
    for (const kw of data.keywords) {
      checkPageBreak(doc, 40);
      doc.font(fontBold).fontSize(10.5).fillColor('#667eea');
      doc.text(kw.word || '', 50, doc.y, { width: pageWidth });
      doc.font(fontName).fontSize(9.5).fillColor('#555555');
      doc.text(kw.context || '', 50, doc.y + 2, { width: pageWidth, lineGap: 3 });
      doc.fillColor('#333333');
      doc.y += 8;
    }
  }

  // === Section 4: Full Recap ===
  if (data.fullRecap) {
    sectionHeader('📖', '长版内容纪要');
    doc.font(fontName).fontSize(10).fillColor('#444444');
    doc.text(data.fullRecap, 50, doc.y, { width: pageWidth, lineGap: 4 });
    doc.y += 12;
  }

  // === Footer ===
  checkPageBreak(doc, 40);
  doc.y += 10;
  doc.moveTo(50, doc.y).lineTo(50 + pageWidth, doc.y).strokeColor('#e8e8e8').lineWidth(0.5).stroke();
  doc.y += 8;
  doc.font(fontName).fontSize(8).fillColor('#999999');
  doc.text('此文档由 Podcast Digest 自动生成', 50, doc.y, { width: pageWidth, align: 'center' });

  doc.end();

  return pdfReady;
}

/** 检查是否需要分页 */
function checkPageBreak(doc: InstanceType<typeof PDFDocument>, requiredSpace: number): void {
  const bottomMargin = doc.page.height - 50;
  if (doc.y + requiredSpace > bottomMargin) {
    doc.addPage();
  }
}

/**
 * 从 markdown 纯文本解析出结构化数据，生成 PDF buffer
 * 这是 exportToPdf 内部使用的辅助函数
 */
async function generatePdfFromMarkdown(mdContent: string): Promise<Buffer> {
  // 简单解析 markdown 结构
  const lines = mdContent.split('\n');

  let episodeTitle = '';
  let podcastName = '';
  let publishedAt = '';
  let summary = '';
  let fullRecap = '';
  const keyPoints: { title: string; detail: string }[] = [];
  const keywords: { word: string; context: string }[] = [];

  let currentSection = '';
  let currentKpTitle = '';
  let currentKpDetail = '';
  let currentKwWord = '';
  let currentKwContext = '';
  let inDetails = false;
  let buffer: string[] = [];

  for (const line of lines) {
    // Title
    if (line.startsWith('# ') && !episodeTitle) {
      episodeTitle = line.replace(/^#\s+/, '').trim();
      continue;
    }

    // Meta
    if (line.startsWith('> **播客**:')) {
      podcastName = line.replace(/^>\s*\*\*播客\*\*:\s*/, '').trim();
      continue;
    }
    if (line.startsWith('> **日期**:')) {
      publishedAt = line.replace(/^>\s*\*\*日期\*\*:\s*/, '').trim();
      continue;
    }

    // Section headers
    if (line.startsWith('## ')) {
      // Save previous section content
      flushSection();

      if (line.includes('摘要')) currentSection = 'summary';
      else if (line.includes('要点')) currentSection = 'keypoints';
      else if (line.includes('关键词')) currentSection = 'keywords';
      else if (line.includes('纪要')) currentSection = 'recap';
      else currentSection = '';
      continue;
    }

    // Key point titles (### headings inside keypoints section)
    if (currentSection === 'keypoints' && line.startsWith('### ')) {
      if (currentKpTitle) {
        keyPoints.push({ title: currentKpTitle, detail: currentKpDetail.trim() });
      }
      currentKpTitle = line.replace(/^###\s+/, '').trim();
      currentKpDetail = '';
      inDetails = false;
      continue;
    }

    // Details tags
    if (line.trim() === '<details>') { inDetails = true; continue; }
    if (line.trim() === '</details>') { inDetails = false; continue; }
    if (line.trim().startsWith('<summary>')) continue;

    // Keyword bold titles
    if (currentSection === 'keywords' && line.startsWith('**') && line.endsWith('**')) {
      if (currentKwWord) {
        keywords.push({ word: currentKwWord, context: currentKwContext.trim() });
      }
      currentKwWord = line.replace(/\*\*/g, '').trim();
      currentKwContext = '';
      continue;
    }

    // Skip separators and empty meta
    if (line.trim() === '---' || line.trim() === '') {
      if (currentSection === 'summary') buffer.push('');
      else if (currentSection === 'recap') buffer.push('');
      else if (currentSection === 'keypoints' && inDetails) currentKpDetail += '\n';
      else if (currentSection === 'keywords' && currentKwWord) currentKwContext += '\n';
      continue;
    }

    // Skip auto-generated footer
    if (line.startsWith('*本文档由')) continue;

    // Content collection
    if (currentSection === 'summary') {
      buffer.push(line);
    } else if (currentSection === 'keypoints') {
      currentKpDetail += line + '\n';
    } else if (currentSection === 'keywords') {
      currentKwContext += line + '\n';
    } else if (currentSection === 'recap') {
      buffer.push(line);
    }
  }

  // Flush last section
  flushSection();

  function flushSection() {
    if (currentSection === 'summary') {
      summary = buffer.join('\n').trim();
      buffer = [];
    } else if (currentSection === 'recap') {
      fullRecap = buffer.join('\n').trim();
      buffer = [];
    } else if (currentSection === 'keypoints' && currentKpTitle) {
      keyPoints.push({ title: currentKpTitle, detail: currentKpDetail.trim() });
      currentKpTitle = '';
      currentKpDetail = '';
    } else if (currentSection === 'keywords' && currentKwWord) {
      keywords.push({ word: currentKwWord, context: currentKwContext.trim() });
      currentKwWord = '';
      currentKwContext = '';
    }
  }

  return generateEpisodePdf({
    podcastName,
    episodeTitle,
    publishedAt,
    summary,
    keyPoints,
    keywords,
    fullRecap,
  });
}
