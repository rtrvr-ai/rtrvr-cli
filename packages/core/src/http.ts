import { DEFAULT_TIMEOUT_MS } from './constants.js';
import { RtrvrError } from './errors.js';
import type { RetryPolicy } from './types.js';

export interface HttpClientOptions {
  apiKey: string;
  timeoutMs?: number;
  retryPolicy?: RetryPolicy;
  defaultHeaders?: Record<string, string>;
  fetchImpl?: typeof fetch;
}

export interface JsonRequestOptions {
  url: string;
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  signal?: AbortSignal;
  headers?: Record<string, string>;
}

export class HttpClient {
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly retryPolicy: {
    maxAttempts: number;
    baseDelayMs: number;
    maxDelayMs: number;
    retriableStatusCodes: number[];
  };
  private readonly defaultHeaders: Record<string, string>;
  private readonly fetchImpl: typeof fetch;

  constructor(options: HttpClientOptions) {
    this.apiKey = options.apiKey;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.retryPolicy = normalizeRetryPolicy(options.retryPolicy);
    this.defaultHeaders = options.defaultHeaders ?? {};
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async requestJson<T>(options: JsonRequestOptions): Promise<T> {
    let attempt = 0;

    while (attempt < this.retryPolicy.maxAttempts) {
      attempt += 1;

      try {
        return await this.requestOnce<T>(options, attempt);
      } catch (error) {
        if (!(error instanceof RtrvrError)) {
          throw error;
        }

        if (!shouldRetry(error, attempt, this.retryPolicy, options.signal)) {
          throw error;
        }

        await sleep(backoffDelayMs(attempt, this.retryPolicy));
      }
    }

    throw new RtrvrError('Request failed after retries were exhausted.');
  }

  private async requestOnce<T>(options: JsonRequestOptions, attempt: number): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error('Request timed out')), this.timeoutMs);
    const signal = options.signal ?? controller.signal;

    try {
      const response = await this.fetchImpl(options.url, {
        method: options.method ?? 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
          ...this.defaultHeaders,
          ...options.headers,
        },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal,
      });

      const requestId = response.headers.get('x-request-id') ?? undefined;
      const text = await response.text();

      const payload = text.length > 0
        ? parseJsonSafely(text)
        : undefined;

      if (!response.ok) {
        const message = extractErrorMessage(payload) ?? `HTTP ${response.status}`;
        throw new RtrvrError(message, {
          status: response.status,
          requestId,
          details: payload,
        });
      }

      return enrichPayloadMetadata(payload, requestId, attempt) as T;
    } catch (error) {
      if (error instanceof RtrvrError) {
        throw error;
      }

      throw new RtrvrError(
        error instanceof Error ? error.message : 'Unknown network error',
        { cause: error },
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}

function normalizeRetryPolicy(policy: RetryPolicy | undefined): {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  retriableStatusCodes: number[];
} {
  const maxAttempts = Math.max(1, Math.min(10, Math.floor(policy?.maxAttempts ?? 1)));
  const baseDelayMs = Math.max(25, Math.floor(policy?.baseDelayMs ?? 250));
  const maxDelayMs = Math.max(baseDelayMs, Math.floor(policy?.maxDelayMs ?? 4_000));
  const retriableStatusCodes = Array.isArray(policy?.retriableStatusCodes) && policy.retriableStatusCodes.length > 0
    ? policy.retriableStatusCodes
    : [408, 425, 429, 500, 502, 503, 504];

  return {
    maxAttempts,
    baseDelayMs,
    maxDelayMs,
    retriableStatusCodes,
  };
}

function shouldRetry(
  error: RtrvrError,
  attempt: number,
  policy: { maxAttempts: number; retriableStatusCodes: number[] },
  signal: AbortSignal | undefined,
): boolean {
  if (attempt >= policy.maxAttempts) {
    return false;
  }

  if (signal?.aborted) {
    return false;
  }

  if (error.status === undefined) {
    return true;
  }

  return policy.retriableStatusCodes.includes(error.status);
}

function backoffDelayMs(
  attempt: number,
  policy: { baseDelayMs: number; maxDelayMs: number },
): number {
  const exponential = Math.min(policy.maxDelayMs, policy.baseDelayMs * (2 ** (attempt - 1)));
  const jitter = Math.floor(Math.random() * Math.max(1, Math.floor(exponential * 0.2)));
  return Math.min(policy.maxDelayMs, exponential + jitter);
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function enrichPayloadMetadata(payload: unknown, requestId: string | undefined, attempt: number): unknown {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return payload;
  }

  const root = payload as Record<string, unknown>;
  const metadataRaw = root.metadata;
  const metadata = metadataRaw && typeof metadataRaw === 'object' && !Array.isArray(metadataRaw)
    ? { ...(metadataRaw as Record<string, unknown>) }
    : {};

  if (requestId && typeof metadata.requestId !== 'string') {
    metadata.requestId = requestId;
  }
  if (typeof metadata.attempt !== 'number') {
    metadata.attempt = attempt;
  }

  root.metadata = metadata;
  return root;
}

function parseJsonSafely(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return {
      raw: text,
    };
  }
}

function extractErrorMessage(payload: unknown): string | undefined {
  if (payload === null || payload === undefined) {
    return undefined;
  }

  if (typeof payload === 'string') {
    return payload;
  }

  if (typeof payload !== 'object') {
    return undefined;
  }

  const asRecord = payload as Record<string, unknown>;

  if (typeof asRecord.message === 'string') {
    return asRecord.message;
  }

  if (
    typeof asRecord.error === 'object' &&
    asRecord.error !== null &&
    typeof (asRecord.error as Record<string, unknown>).message === 'string'
  ) {
    return (asRecord.error as Record<string, string>).message;
  }

  if (typeof asRecord.error === 'string') {
    return asRecord.error;
  }

  return undefined;
}
