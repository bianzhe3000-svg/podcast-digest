import path from 'path';
import { logger } from '../utils/logger';
import { config } from '../config';

export async function exportToPdf(markdownPath: string): Promise<string> {
  if (!config.pdf.enabled) {
    throw new Error('PDF export is disabled');
  }

  const pdfPath = markdownPath.replace(/\.md$/, '.pdf');

  try {
    const { mdToPdf } = await import('md-to-pdf');

    await mdToPdf(
      { path: markdownPath },
      {
        dest: pdfPath,
        css: `
          body {
            font-family: "PingFang SC", "Noto Sans SC", "Microsoft YaHei", sans-serif;
            font-size: 14px;
            line-height: 1.8;
            color: #333;
          }
          h1 { font-size: 24px; border-bottom: 2px solid #333; padding-bottom: 8px; }
          h2 { font-size: 20px; margin-top: 24px; color: #1a1a1a; }
          h3 { font-size: 16px; margin-top: 16px; }
          blockquote { border-left: 4px solid #ddd; margin-left: 0; padding-left: 16px; color: #666; }
          details { margin: 8px 0; padding: 8px; background: #f9f9f9; border-radius: 4px; }
          summary { cursor: pointer; font-weight: bold; }
          code { background: #f4f4f4; padding: 2px 4px; border-radius: 3px; }
        `,
        pdf_options: {
          format: 'A4',
          margin: { top: '20mm', bottom: '20mm', left: '15mm', right: '15mm' },
          printBackground: true,
        },
      }
    );

    logger.info('PDF exported', { path: pdfPath });
    return pdfPath;
  } catch (error) {
    logger.error('PDF export failed', { error: (error as Error).message, path: markdownPath });
    throw error;
  }
}
