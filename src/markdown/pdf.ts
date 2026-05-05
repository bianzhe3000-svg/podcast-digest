import fs from 'fs';
import path from 'path';
import PDFDocument from 'pdfkit';
import { logger } from '../utils/logger';
import { config } from '../config';

interface FontInfo {
  path: string;
  isTTC: boolean;
  postscriptName?: string;
}

/** 查找可用的中文字体 */
function findChineseFont(): FontInfo | null {
  const candidates: FontInfo[] = [
    { path: '/Library/Fonts/Arial Unicode.ttf', isTTC: false },
    { path: '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc', isTTC: true, postscriptName: 'NotoSansCJKsc-Regular' },
    { path: '/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc', isTTC: true, postscriptName: 'NotoSansCJKsc-Regular' },
    { path: '/usr/share/fonts/noto-cjk/NotoSansCJK-Regular.ttc', isTTC: true, postscriptName: 'NotoSansCJKsc-Regular' },
    { path: '/System/Library/Fonts/STHeiti Medium.ttc', isTTC: true, postscriptName: 'STHeitiSC-Medium' },
    { path: '/System/Library/Fonts/PingFang.ttc', isTTC: true, postscriptName: 'PingFangSC-Regular' },
    { path: '/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc', isTTC: true, postscriptName: 'WenQuanYiZenHei' },
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate.path)) {
      return candidate;
    }
  }
  return null;
}

export interface PdfEpisodeData {
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

// ============================================================
// PDF 辅助函数
// ============================================================

function registerFonts(doc: InstanceType<typeof PDFDocument>, chineseFont: FontInfo | null) {
  if (chineseFont) {
    if (chineseFont.isTTC && chineseFont.postscriptName) {
      doc.registerFont('Chinese', chineseFont.path, chineseFont.postscriptName);
      doc.registerFont('ChineseBold', chineseFont.path, chineseFont.postscriptName);
    } else {
      doc.registerFont('Chinese', chineseFont.path);
      doc.registerFont('ChineseBold', chineseFont.path);
    }
  }
}

function getFontNames(chineseFont: FontInfo | null) {
  return {
    fontName: chineseFont ? 'Chinese' : 'Helvetica',
    fontBold: chineseFont ? 'ChineseBold' : 'Helvetica-Bold',
  };
}

function checkPageBreak(doc: InstanceType<typeof PDFDocument>, requiredSpace: number): void {
  const bottomMargin = doc.page.height - 50;
  if (doc.y + requiredSpace > bottomMargin) {
    doc.addPage();
  }
}

/** 渲染单集的四个内容章节（不含标题头，供 digest 和单集 PDF 复用） */
function renderEpisodeSections(
  doc: InstanceType<typeof PDFDocument>,
  data: PdfEpisodeData,
  fontName: string,
  fontBold: string,
  pageWidth: number,
  destPrefix: string,
) {
  let y: number;

  const sectionHeader = (icon: string, title: string, destName: string) => {
    checkPageBreak(doc, 60);
    y = doc.y;
    doc.addNamedDestination(destName);
    doc.font(fontBold).fontSize(13).fillColor('#667eea');
    doc.text(`${icon} ${title}`, 50, y, { width: pageWidth });
    y = doc.y + 2;
    doc.moveTo(50, y).lineTo(50 + pageWidth, y).strokeColor('#e8edf5').lineWidth(1).stroke();
    y += 8;
    doc.fillColor('#333333');
    doc.y = y;
  };

  // Summary
  sectionHeader('📝', '内容核心摘要', `${destPrefix}-summary`);
  doc.font(fontName).fontSize(10.5);
  doc.text(data.summary || '（暂无摘要）', 50, doc.y, { width: pageWidth, lineGap: 4 });
  doc.y += 12;

  // Key Points
  if (data.keyPoints && data.keyPoints.length > 0) {
    sectionHeader('🎯', '核心要点', `${destPrefix}-keypoints`);
    for (const kp of data.keyPoints) {
      checkPageBreak(doc, 40);
      const startY = doc.y;
      doc.font(fontBold).fontSize(10.5).fillColor('#333333');
      doc.text(`▸ ${kp.title || ''}`, 56, doc.y, { width: pageWidth - 10 });
      if (kp.detail) {
        doc.font(fontName).fontSize(9.5).fillColor('#555555');
        doc.text(kp.detail, 60, doc.y + 2, { width: pageWidth - 16, lineGap: 3 });
      }
      const endY = doc.y;
      doc.rect(50, startY - 2, 3, endY - startY + 6).fill('#667eea');
      doc.fillColor('#333333');
      doc.y = endY + 10;
    }
  }

  // Keywords
  if (data.keywords && data.keywords.length > 0) {
    sectionHeader('🔑', '核心关键词分析', `${destPrefix}-keywords`);
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

  // Full Recap
  if (data.fullRecap) {
    sectionHeader('📖', '长版内容纪要', `${destPrefix}-recap`);
    doc.font(fontName).fontSize(10).fillColor('#444444');
    doc.text(data.fullRecap, 50, doc.y, { width: pageWidth, lineGap: 4 });
    doc.y += 12;
  }
}

// ============================================================
// 单集 PDF（保持兼容，供 exportToPdf 使用）
// ============================================================

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

  registerFonts(doc, chineseFont);
  const { fontName, fontBold } = getFontNames(chineseFont);
  const pageWidth = doc.page.width - 100;

  // Header
  doc.rect(0, 0, doc.page.width, 100).fill('#667eea');
  doc.fill('#ffffff').font(fontBold).fontSize(20)
    .text('🎧 Podcast Digest', 50, 30, { width: pageWidth, align: 'center' });
  doc.font(fontName).fontSize(11)
    .text(data.podcastName, 50, 60, { width: pageWidth, align: 'center' });

  doc.fill('#333333');
  doc.y = 120;

  // Episode Title
  doc.font(fontBold).fontSize(16);
  doc.text(data.episodeTitle, 50, doc.y, { width: pageWidth });
  doc.y += 8;

  // Meta
  const pubDate = data.publishedAt ? data.publishedAt.substring(0, 10) : '';
  let meta = `📅 ${pubDate}`;
  if (data.durationSeconds && data.durationSeconds > 0) {
    const h = Math.floor(data.durationSeconds / 3600);
    const m = Math.floor((data.durationSeconds % 3600) / 60);
    meta += `  ·  ⏱️ ${h > 0 ? h + '小时' : ''}${m}分钟`;
  }
  doc.font(fontName).fontSize(9).fillColor('#999999');
  doc.text(meta, 50, doc.y, { width: pageWidth });
  doc.y += 16;
  doc.fillColor('#333333');

  // Mini TOC
  const tocSections: { title: string; dest: string }[] = [
    { title: '1. 📝 内容核心摘要', dest: 'ep0-summary' },
  ];
  if (data.keyPoints?.length) tocSections.push({ title: '2. 🎯 核心要点', dest: 'ep0-keypoints' });
  if (data.keywords?.length) tocSections.push({ title: `${tocSections.length + 1}. 🔑 核心关键词分析`, dest: 'ep0-keywords' });
  if (data.fullRecap) tocSections.push({ title: `${tocSections.length + 1}. 📖 长版内容纪要`, dest: 'ep0-recap' });

  doc.font(fontBold).fontSize(12).fillColor('#555555');
  doc.text('📋 目录', 50, doc.y, { width: pageWidth });
  doc.y += 4;
  doc.moveTo(50, doc.y).lineTo(50 + pageWidth, doc.y).strokeColor('#e8e8e8').lineWidth(0.5).stroke();
  doc.y += 6;
  for (const sec of tocSections) {
    doc.font(fontName).fontSize(10.5).fillColor('#667eea');
    doc.text(sec.title, 60, doc.y, { width: pageWidth - 20, goTo: sec.dest, underline: false } as any);
    doc.y += 2;
  }
  doc.fillColor('#333333');
  doc.y += 12;

  renderEpisodeSections(doc, data, fontName, fontBold, pageWidth, 'ep0');

  // Footer
  checkPageBreak(doc, 40);
  doc.y += 10;
  doc.moveTo(50, doc.y).lineTo(50 + pageWidth, doc.y).strokeColor('#e8e8e8').lineWidth(0.5).stroke();
  doc.y += 8;
  doc.font(fontName).fontSize(8).fillColor('#999999');
  doc.text('此文档由 Podcast Digest 自动生成', 50, doc.y, { width: pageWidth, align: 'center' });

  doc.end();
  return pdfReady;
}

// ============================================================
// 每日汇总 PDF（一个文件包含所有剧集 + 全局目录）
// ============================================================

export async function generateDigestPdf(episodes: PdfEpisodeData[], dateStr: string, dailySummary?: string): Promise<Buffer> {
  const chineseFont = findChineseFont();

  const doc = new PDFDocument({
    size: 'A4',
    margins: { top: 50, bottom: 50, left: 50, right: 50 },
    info: {
      Title: `Podcast Digest - ${dateStr}`,
      Author: 'Podcast Digest',
      Subject: `${dateStr} 播客内容总结 (${episodes.length}篇)`,
    },
  });

  const chunks: Buffer[] = [];
  doc.on('data', (chunk: Buffer) => chunks.push(chunk));
  const pdfReady = new Promise<Buffer>((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  registerFonts(doc, chineseFont);
  const { fontName, fontBold } = getFontNames(chineseFont);
  const pageWidth = doc.page.width - 100;

  // ============ 封面 Header ============
  doc.rect(0, 0, doc.page.width, 110).fill('#667eea');
  doc.fill('#ffffff').font(fontBold).fontSize(24)
    .text('🎧 Podcast Digest', 50, 25, { width: pageWidth, align: 'center' });
  doc.font(fontName).fontSize(14)
    .text(dateStr, 50, 58, { width: pageWidth, align: 'center' });
  doc.fontSize(11)
    .text(`共 ${episodes.length} 个剧集`, 50, 80, { width: pageWidth, align: 'center' });

  doc.fill('#333333');
  doc.y = 130;

  // ============ 全局目录 ============
  doc.font(fontBold).fontSize(14).fillColor('#333333');
  doc.text('📋 目录', 50, doc.y, { width: pageWidth });
  doc.y += 4;
  doc.moveTo(50, doc.y).lineTo(50 + pageWidth, doc.y).strokeColor('#667eea').lineWidth(1).stroke();
  doc.y += 10;

  for (let i = 0; i < episodes.length; i++) {
    const ep = episodes[i];
    const destName = `ep-${i}`;
    const pubDate = ep.publishedAt ? ep.publishedAt.substring(0, 10) : '';

    checkPageBreak(doc, 30);

    // 播客名 + 剧集标题（可点击跳转）
    doc.font(fontBold).fontSize(10.5).fillColor('#667eea');
    doc.text(`${i + 1}. ${ep.episodeTitle}`, 55, doc.y, {
      width: pageWidth - 15,
      goTo: destName,
      underline: false,
    } as any);

    // 播客名 + 日期（辅助信息）
    doc.font(fontName).fontSize(8.5).fillColor('#999999');
    doc.text(`${ep.podcastName}  ·  ${pubDate}`, 65, doc.y + 1, { width: pageWidth - 25 });
    doc.y += 6;
  }

  doc.fillColor('#333333');

  // ============ 今日全览摘要页 ============
  if (dailySummary) {
    doc.addPage();

    // 橙色顶部色条
    doc.rect(0, 0, doc.page.width, 80).fill('#f5a623');
    doc.fill('#ffffff').font(fontBold).fontSize(20)
      .text('🌅 今日全览', 50, 22, { width: pageWidth, align: 'center' });
    doc.font(fontName).fontSize(12)
      .text(dateStr, 50, 52, { width: pageWidth, align: 'center' });

    doc.fill('#333333');
    doc.y = 100;

    // 左侧橙色竖线装饰
    const summaryStartY = doc.y;
    doc.font(fontName).fontSize(11).fillColor('#3a2a00');
    doc.text(dailySummary, 60, doc.y, { width: pageWidth - 10, lineGap: 5 });
    const summaryEndY = doc.y;
    doc.rect(50, summaryStartY - 2, 4, summaryEndY - summaryStartY + 8).fill('#f5a623');
  }

  // ============ 逐集内容 ============
  for (let i = 0; i < episodes.length; i++) {
    const ep = episodes[i];
    const destName = `ep-${i}`;

    // 每集开始新页
    doc.addPage();

    // 剧集锚点
    doc.addNamedDestination(destName);

    // 剧集标题区域（带背景色条）
    doc.rect(0, 50, doc.page.width, 60).fill('#f0f2ff');
    doc.font(fontBold).fontSize(15).fillColor('#333333');
    doc.text(`${i + 1}. ${ep.episodeTitle}`, 50, 60, { width: pageWidth });
    const titleEndY = doc.y;

    // Meta 信息
    const pubDate = ep.publishedAt ? ep.publishedAt.substring(0, 10) : '';
    let meta = `🎙️ ${ep.podcastName}  ·  📅 ${pubDate}`;
    if (ep.durationSeconds && ep.durationSeconds > 0) {
      const h = Math.floor(ep.durationSeconds / 3600);
      const m = Math.floor((ep.durationSeconds % 3600) / 60);
      meta += `  ·  ⏱️ ${h > 0 ? h + '小时' : ''}${m}分钟`;
    }
    const metaY = Math.max(titleEndY, 95) + 8;
    doc.font(fontName).fontSize(9).fillColor('#999999');
    doc.text(meta, 50, metaY, { width: pageWidth });
    doc.y += 16;
    doc.fillColor('#333333');

    // 该集的四个章节
    renderEpisodeSections(doc, ep, fontName, fontBold, pageWidth, `ep-${i}`);
  }

  // ============ 尾页 Footer ============
  checkPageBreak(doc, 50);
  doc.y += 16;
  doc.moveTo(50, doc.y).lineTo(50 + pageWidth, doc.y).strokeColor('#e8e8e8').lineWidth(0.5).stroke();
  doc.y += 10;
  doc.font(fontName).fontSize(9).fillColor('#999999');
  doc.text('此文档由 Podcast Digest 自动生成', 50, doc.y, { width: pageWidth, align: 'center' });

  doc.end();
  return pdfReady;
}

// ============================================================
// Markdown 解析（供 exportToPdf 使用）
// ============================================================

async function generatePdfFromMarkdown(mdContent: string): Promise<Buffer> {
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
    if (line.startsWith('# ') && !episodeTitle) {
      episodeTitle = line.replace(/^#\s+/, '').trim();
      continue;
    }
    if (line.startsWith('> **播客**:')) {
      podcastName = line.replace(/^>\s*\*\*播客\*\*:\s*/, '').trim();
      continue;
    }
    if (line.startsWith('> **日期**:')) {
      publishedAt = line.replace(/^>\s*\*\*日期\*\*:\s*/, '').trim();
      continue;
    }
    if (line.startsWith('## ')) {
      flushSection();
      if (line.includes('摘要')) currentSection = 'summary';
      else if (line.includes('要点')) currentSection = 'keypoints';
      else if (line.includes('关键词')) currentSection = 'keywords';
      else if (line.includes('纪要')) currentSection = 'recap';
      else currentSection = '';
      continue;
    }
    if (currentSection === 'keypoints' && line.startsWith('### ')) {
      if (currentKpTitle) keyPoints.push({ title: currentKpTitle, detail: currentKpDetail.trim() });
      currentKpTitle = line.replace(/^###\s+/, '').trim();
      currentKpDetail = '';
      inDetails = false;
      continue;
    }
    if (line.trim() === '<details>') { inDetails = true; continue; }
    if (line.trim() === '</details>') { inDetails = false; continue; }
    if (line.trim().startsWith('<summary>')) continue;
    if (currentSection === 'keywords' && line.startsWith('**') && line.endsWith('**')) {
      if (currentKwWord) keywords.push({ word: currentKwWord, context: currentKwContext.trim() });
      currentKwWord = line.replace(/\*\*/g, '').trim();
      currentKwContext = '';
      continue;
    }
    if (line.trim() === '---' || line.trim() === '') {
      if (currentSection === 'summary') buffer.push('');
      else if (currentSection === 'recap') buffer.push('');
      else if (currentSection === 'keypoints' && inDetails) currentKpDetail += '\n';
      else if (currentSection === 'keywords' && currentKwWord) currentKwContext += '\n';
      continue;
    }
    if (line.startsWith('*本文档由')) continue;
    if (currentSection === 'summary') buffer.push(line);
    else if (currentSection === 'keypoints') currentKpDetail += line + '\n';
    else if (currentSection === 'keywords') currentKwContext += line + '\n';
    else if (currentSection === 'recap') buffer.push(line);
  }

  flushSection();

  function flushSection() {
    if (currentSection === 'summary') { summary = buffer.join('\n').trim(); buffer = []; }
    else if (currentSection === 'recap') { fullRecap = buffer.join('\n').trim(); buffer = []; }
    else if (currentSection === 'keypoints' && currentKpTitle) {
      keyPoints.push({ title: currentKpTitle, detail: currentKpDetail.trim() });
      currentKpTitle = ''; currentKpDetail = '';
    } else if (currentSection === 'keywords' && currentKwWord) {
      keywords.push({ word: currentKwWord, context: currentKwContext.trim() });
      currentKwWord = ''; currentKwContext = '';
    }
  }

  return generateEpisodePdf({ podcastName, episodeTitle, publishedAt, summary, keyPoints, keywords, fullRecap });
}
