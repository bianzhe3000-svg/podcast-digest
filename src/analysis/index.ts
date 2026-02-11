import OpenAI from 'openai';
import { config } from '../config';
import { logger } from '../utils/logger';
import { withRetry } from '../utils/retry';
import { ANALYSIS_SYSTEM_PROMPT, buildAnalysisPrompt, buildChunkSummaryPrompt, buildMergeAnalysisPrompt } from './prompts';

export interface KeyPoint {
  title: string;
  detail: string;
}

export interface Keyword {
  word: string;
  context: string;
}

// Legacy types kept for DB backward compat
export interface MainArgument {
  title: string;
  summary: string;
  details: string;
  relatedQuotes: string[];
}

export interface KnowledgePoint {
  term: string;
  explanation: string;
  context: string;
}

export interface KnowledgeCategory {
  category: string;
  points: KnowledgePoint[];
}

export interface AnalysisOutput {
  summary: string;
  keyPoints: KeyPoint[];
  keywords: Keyword[];
  fullRecap: string;
  // Legacy fields kept for DB compat
  mainArguments: MainArgument[];
  knowledgePoints: KnowledgeCategory[];
}

// 单次分析的最大字符数（约 1 万字符，安全范围内）
const SINGLE_ANALYSIS_MAX_CHARS = 10000;
// 分段时每段的最大字符数（8000 字符 ≈ 1.2-1.6 万 token，兼容各种模型和代理）
const CHUNK_MAX_CHARS = 8000;

let openaiClient: OpenAI | null = null;

function getClient(): OpenAI {
  if (!openaiClient) {
    openaiClient = new OpenAI({
      apiKey: config.openai.apiKey,
      baseURL: config.openai.baseUrl,
      timeout: 300000,
    });
  }
  return openaiClient;
}

export async function analyzeContent(
  transcript: string,
  episodeTitle: string,
  podcastName: string
): Promise<AnalysisOutput> {
  logger.info('Starting content analysis', {
    provider: config.analysisProvider,
    textLength: transcript.length,
    title: episodeTitle,
  });

  if (config.analysisProvider === 'openai') {
    // 短文本：直接单次分析
    if (transcript.length <= SINGLE_ANALYSIS_MAX_CHARS) {
      logger.info('Using single-pass analysis', { textLength: transcript.length });
      return analyzeWithOpenAI(transcript, episodeTitle, podcastName);
    }
    // 长文本：分段摘要 + 合并分析
    const estimatedChunks = Math.ceil(transcript.length / CHUNK_MAX_CHARS);
    logger.info('Using chunked analysis for long transcript', {
      textLength: transcript.length,
      estimatedChunks,
    });
    return analyzeWithChunks(transcript, episodeTitle, podcastName);
  }

  throw new Error(`Unsupported analysis provider: ${config.analysisProvider}`);
}

/** 单次直接分析（短文本） */
async function analyzeWithOpenAI(
  transcript: string,
  episodeTitle: string,
  podcastName: string
): Promise<AnalysisOutput> {
  const client = getClient();

  const userPrompt = buildAnalysisPrompt(transcript, episodeTitle, podcastName, {
    summaryMinLength: config.analysis.summaryMinLength,
    summaryMaxLength: config.analysis.summaryMaxLength,
    keyPointsCount: config.analysis.keyPointsCount,
  });

  const response = await withRetry(
    async () => {
      const result = await client.chat.completions.create({
        model: config.openai.model,
        messages: [
          { role: 'system', content: ANALYSIS_SYSTEM_PROMPT },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0.3,
        max_completion_tokens: 65536,
        response_format: { type: 'json_object' },
      } as any);

      const content = result.choices[0]?.message?.content;
      const finishReason = result.choices[0]?.finish_reason;
      logger.info('Single-pass API response', { finishReason, contentLength: content?.length || 0 });

      if (!content || content.length < 10) {
        throw new Error(`Empty or too short response from API (finish_reason: ${finishReason}, length: ${content?.length || 0})`);
      }
      return result;
    },
    { maxAttempts: 3, baseDelayMs: 10000 }
  );

  const content = response.choices[0]?.message?.content || '{}';
  return normalizeAnalysisResult(content);
}

/** 分段分析（长文本）：先对每段提取摘要，再合并生成最终分析 */
async function analyzeWithChunks(
  transcript: string,
  episodeTitle: string,
  podcastName: string
): Promise<AnalysisOutput> {
  const client = getClient();
  const chunks = splitIntoChunks(transcript, CHUNK_MAX_CHARS);
  logger.info(`Split transcript into ${chunks.length} chunks`, {
    chunkSizes: chunks.map(c => c.length),
  });

  // Phase 1: 对每段生成摘要
  const chunkSummaries: string[] = [];
  for (let i = 0; i < chunks.length; i++) {
    logger.info(`Analyzing chunk ${i + 1}/${chunks.length}`, {
      chunkLength: chunks[i].length,
      chunkPreview: chunks[i].substring(0, 100),
    });

    const chunkPrompt = buildChunkSummaryPrompt(chunks[i], i + 1, chunks.length, episodeTitle, podcastName);
    logger.info(`Chunk ${i + 1} prompt length: ${chunkPrompt.length}`);

    const response = await withRetry(
      async () => {
        const result = await client.chat.completions.create({
          model: config.openai.model,
          messages: [
            { role: 'system', content: ANALYSIS_SYSTEM_PROMPT },
            { role: 'user', content: chunkPrompt },
          ],
          temperature: 0.3,
          max_completion_tokens: 32000,
        } as any);

        const content = result.choices?.[0]?.message?.content;
        const finishReason = result.choices?.[0]?.finish_reason;
        const choicesCount = result.choices?.length || 0;
        const usageInfo = (result as any).usage;
        logger.info(`Chunk ${i + 1} API response`, {
          finishReason,
          choicesCount,
          contentLength: content?.length || 0,
          contentPreview: content?.substring(0, 200) || '(empty)',
          usage: usageInfo ? JSON.stringify(usageInfo) : 'N/A',
          model: (result as any).model || 'unknown',
        });

        // 如果返回空内容，抛错触发重试
        if (!content || content.trim().length < 50) {
          logger.error(`Chunk ${i + 1} empty response debug`, {
            fullResponse: JSON.stringify(result).substring(0, 1000),
          });
          throw new Error(`Chunk ${i + 1} returned empty/short response (finish_reason: ${finishReason}, length: ${content?.length || 0})`);
        }

        return result;
      },
      { maxAttempts: 3, baseDelayMs: 15000 }
    );

    const summary = response.choices[0]?.message?.content || '';
    chunkSummaries.push(summary);
    logger.info(`Chunk ${i + 1} summary generated`, { summaryLength: summary.length });
  }

  // 验证所有分段摘要都有内容
  const emptySummaries = chunkSummaries.filter(s => s.trim().length < 50);
  if (emptySummaries.length > 0) {
    logger.error('Some chunk summaries are empty after retries', {
      totalChunks: chunks.length,
      emptyCount: emptySummaries.length,
    });
    throw new Error(`${emptySummaries.length} out of ${chunks.length} chunk summaries are empty`);
  }

  // Phase 2: 合并所有分段摘要，生成最终结构化分析
  const mergedText = chunkSummaries.map((s, i) => `=== 第${i + 1}部分（共${chunks.length}部分）===\n${s}`).join('\n\n');
  logger.info('Generating final merged analysis', {
    mergedTextLength: mergedText.length,
    chunkSummaryLengths: chunkSummaries.map(s => s.length),
  });

  const mergePrompt = buildMergeAnalysisPrompt(mergedText, episodeTitle, podcastName, {
    summaryMinLength: config.analysis.summaryMinLength,
    summaryMaxLength: config.analysis.summaryMaxLength,
    keyPointsCount: config.analysis.keyPointsCount,
  });

  const finalResponse = await withRetry(
    async () => {
      const result = await client.chat.completions.create({
        model: config.openai.model,
        messages: [
          { role: 'system', content: ANALYSIS_SYSTEM_PROMPT },
          { role: 'user', content: mergePrompt },
        ],
        temperature: 0.3,
        max_completion_tokens: 65536,
        response_format: { type: 'json_object' },
      } as any);

      const content = result.choices[0]?.message?.content;
      const finishReason = result.choices[0]?.finish_reason;
      logger.info('Merge API response', { finishReason, contentLength: content?.length || 0 });

      if (!content || content.length < 10) {
        throw new Error(`Merge response empty (finish_reason: ${finishReason}, length: ${content?.length || 0})`);
      }
      return result;
    },
    { maxAttempts: 3, baseDelayMs: 15000 }
  );

  const content = finalResponse.choices[0]?.message?.content || '{}';
  return normalizeAnalysisResult(content);
}

/** 按段落边界将文本分成多个 chunk */
function splitIntoChunks(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) return [text];

  const chunks: string[] = [];
  let start = 0;

  while (start < text.length) {
    let end = start + maxChars;

    if (end >= text.length) {
      chunks.push(text.substring(start));
      break;
    }

    // 尝试在段落边界（换行符）处断开
    const lastNewline = text.lastIndexOf('\n', end);
    if (lastNewline > start + maxChars * 0.7) {
      end = lastNewline + 1;
    } else {
      // 退而求其次：在句号处断开
      const lastPeriod = Math.max(
        text.lastIndexOf('。', end),
        text.lastIndexOf('. ', end),
        text.lastIndexOf('！', end),
        text.lastIndexOf('？', end)
      );
      if (lastPeriod > start + maxChars * 0.7) {
        end = lastPeriod + 1;
      }
    }

    chunks.push(text.substring(start, end));
    start = end;
  }

  return chunks;
}

function normalizeAnalysisResult(jsonStr: string): AnalysisOutput {
  try {
    const data = JSON.parse(jsonStr);

    const summary = typeof data.summary === 'string' ? data.summary : '分析结果不可用';

    const keyPoints: KeyPoint[] = Array.isArray(data.keyPoints)
      ? data.keyPoints.map((p: any) => {
          if (typeof p === 'string') return { title: p, detail: '' };
          return { title: p.title || '', detail: p.detail || '' };
        })
      : [];

    const keywords: Keyword[] = Array.isArray(data.keywords)
      ? data.keywords.map((k: any) => ({
          word: k.word || k.term || '',
          context: k.context || k.explanation || '',
        }))
      : [];

    const fullRecap = typeof data.fullRecap === 'string' ? data.fullRecap : '';

    const mainArguments: MainArgument[] = Array.isArray(data.mainArguments)
      ? data.mainArguments.map((arg: any) => ({
          title: arg.title || '',
          summary: arg.summary || '',
          details: arg.details || '',
          relatedQuotes: Array.isArray(arg.relatedQuotes) ? arg.relatedQuotes : [],
        }))
      : [];

    const knowledgePoints: KnowledgeCategory[] = Array.isArray(data.knowledgePoints)
      ? data.knowledgePoints.map((cat: any) => ({
          category: cat.category || '其他',
          points: Array.isArray(cat.points)
            ? cat.points.map((p: any) => ({
                term: p.term || '',
                explanation: p.explanation || '',
                context: p.context || '',
              }))
            : [],
        }))
      : [];

    return { summary, keyPoints, keywords, fullRecap, mainArguments, knowledgePoints };
  } catch (error) {
    logger.error('Failed to parse analysis result', { error: (error as Error).message, raw: jsonStr.substring(0, 500) });
    return {
      summary: '分析结果解析失败',
      keyPoints: [],
      keywords: [],
      fullRecap: '',
      mainArguments: [],
      knowledgePoints: [],
    };
  }
}
