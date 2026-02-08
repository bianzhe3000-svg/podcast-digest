import { logger } from './logger';

export interface RetryOptions {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs?: number;
  onRetry?: (error: Error, attempt: number) => void;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions
): Promise<T> {
  const { maxAttempts, baseDelayMs, maxDelayMs = 60000, onRetry } = options;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (attempt === maxAttempts) throw error;

      const jitter = Math.random() * baseDelayMs * 0.5;
      const delay = Math.min(baseDelayMs * Math.pow(2, attempt - 1) + jitter, maxDelayMs);

      logger.warn(`Retry attempt ${attempt}/${maxAttempts}, waiting ${Math.round(delay)}ms`, {
        error: (error as Error).message,
      });

      if (onRetry) onRetry(error as Error, attempt);
      await sleep(delay);
    }
  }

  throw new Error('Unreachable');
}
