import OpenAI from 'openai';
import { config } from '../config';
import { logger } from '../utils/logger';
import { withRetry } from '../utils/retry';
import { ANALYSIS_SYSTEM_PROMPT, buildAnalysisPrompt } from './prompts';

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
    return analyzeWithOpenAI(transcript, episodeTitle, podcastName);
  }

  throw new Error(`Unsupported analysis provider: ${config.analysisProvider}`);
}

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
      return client.chat.completions.create({
        model: config.openai.model,
        messages: [
          { role: 'system', content: ANALYSIS_SYSTEM_PROMPT },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0.3,
        max_completion_tokens: 16000,
        response_format: { type: 'json_object' },
      } as any);
    },
    { maxAttempts: 3, baseDelayMs: 10000 }
  );

  const content = response.choices[0]?.message?.content || '{}';
  logger.info('Analysis response received', { contentLength: content.length });

  return normalizeAnalysisResult(content);
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
    logger.error('Failed to parse analysis result', { error: (error as Error).message });
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
