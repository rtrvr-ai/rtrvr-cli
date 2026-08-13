import { createHash, randomBytes } from 'node:crypto';

export interface CliOAuthStartResult {
  protocolVersion: 1 | 2;
  sessionId: string;
  verificationUrl?: string;
  pollUrl?: string;
  userCode?: string;
  intervalMs: number;
  expiresAt?: string;
  codeVerifier?: string;
  raw: Record<string, unknown>;
}

export interface CliOAuthPollResult {
  status: 'pending' | 'approved' | 'denied' | 'expired';
  apiKey?: string;
  token?: string;
  profile?: unknown;
  raw: Record<string, unknown>;
}

export interface PollCliOAuthOptions {
  intervalMs?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}

const MIN_POLL_INTERVAL_MS = 1_000;
const MAX_POLL_INTERVAL_MS = 10_000;
const MAX_OAUTH_TIMEOUT_MS = 10 * 60_000;
const REQUEST_TIMEOUT_MS = 10_000;

class OAuthHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'OAuthHttpError';
  }
}

function randomBase64Url(byteLength: number): string {
  return randomBytes(byteLength).toString('base64url');
}

async function pkceChallenge(verifier: string): Promise<string> {
  return createHash('sha256').update(verifier).digest('base64url');
}

export async function startCliOAuth(baseUrl: string): Promise<CliOAuthStartResult> {
  const normalized = trimTrailingSlash(baseUrl);
  const codeVerifier = randomBase64Url(32);
  const clientInfo = {
    client: 'rtrvr-cli',
    platform: process.platform,
    arch: process.arch,
    nodeVersion: process.version,
  };
  let payload: Record<string, unknown>;
  let protocolVersion: 1 | 2 = 2;

  try {
    payload = await requestJson(`${normalized}/cli/auth/v2/start`, {
      method: 'POST',
      body: {
        ...clientInfo,
        codeChallenge: await pkceChallenge(codeVerifier),
      },
    });
  } catch (error) {
    if (!(error instanceof OAuthHttpError) || ![404, 405, 501].includes(error.status)) {
      throw error;
    }
    protocolVersion = 1;
    payload = await requestJson(`${normalized}/cli/auth/start`, {
      method: 'POST',
      body: clientInfo,
    });
  }

  const sessionId =
    readString(payload, 'sessionId')
    ?? readString(payload, 'session_id')
    ?? readString(payload, 'id');

  if (!sessionId) {
    throw new Error('OAuth bootstrap response missing session ID.');
  }

  const intervalMs = readNumber(payload, 'intervalMs')
    ?? readNumber(payload, 'interval_ms')
    ?? 2000;

  return {
    protocolVersion,
    sessionId,
    verificationUrl:
      readString(payload, 'verificationUrl')
      ?? readString(payload, 'verification_url')
      ?? readString(payload, 'url'),
    pollUrl:
      readString(payload, protocolVersion === 2 ? 'statusUrl' : 'pollUrl')
      ?? readString(payload, protocolVersion === 2 ? 'status_url' : 'poll_url'),
    userCode: readString(payload, 'userCode') ?? readString(payload, 'user_code'),
    intervalMs: clamp(intervalMs, MIN_POLL_INTERVAL_MS, MAX_POLL_INTERVAL_MS),
    expiresAt: readString(payload, 'expiresAt') ?? readString(payload, 'expires_at'),
    ...(protocolVersion === 2 ? { codeVerifier } : {}),
    raw: payload,
  };
}

export async function pollCliOAuth(
  baseUrl: string,
  start: CliOAuthStartResult,
  options?: PollCliOAuthOptions,
): Promise<CliOAuthPollResult> {
  const normalized = trimTrailingSlash(baseUrl);
  let intervalMs = clamp(options?.intervalMs ?? start.intervalMs, MIN_POLL_INTERVAL_MS, MAX_POLL_INTERVAL_MS);
  const timeoutMs = clamp(options?.timeoutMs ?? 180_000, 1_000, MAX_OAUTH_TIMEOUT_MS);
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    if (options?.signal?.aborted) throw options.signal.reason ?? new Error('OAuth login cancelled.');
    const endpoint = start.pollUrl
      ? absolutizePollUrl(normalized, start.pollUrl)
      : start.protocolVersion === 2
        ? `${normalized}/cli/auth/v2/status`
        : `${normalized}/cli/auth/poll`;
    const statusUrl = new URL(endpoint);
    statusUrl.searchParams.set('session_id', start.sessionId);

    let payload: Record<string, unknown>;
    let retryAfterMs: number | undefined;
    try {
      const response = await requestJsonWithMetadata(statusUrl.toString(), {
        method: 'GET',
        signal: options?.signal,
      });
      payload = response.payload;
      retryAfterMs = response.retryAfterMs;
    } catch (error) {
      if (error instanceof OAuthHttpError && [429, 503].includes(error.status)) {
        const waitMs = clamp(error.retryAfterMs ?? intervalMs, MIN_POLL_INTERVAL_MS, MAX_POLL_INTERVAL_MS);
        await sleep(waitMs, options?.signal);
        continue;
      }
      throw error;
    }
    const result = normalizePollPayload(payload);

    if (result.status === 'approved') {
      if (start.protocolVersion === 1) return result;
      if (!start.codeVerifier) throw new Error('OAuth exchange verifier is missing.');
      const exchanged = await requestJson(`${normalized}/cli/auth/v2/exchange`, {
        method: 'POST',
        body: { sessionId: start.sessionId, codeVerifier: start.codeVerifier },
        signal: options?.signal,
      }) as Record<string, unknown>;
      return normalizePollPayload(exchanged);
    }
    if (result.status === 'denied' || result.status === 'expired') return result;

    if (retryAfterMs) intervalMs = clamp(retryAfterMs, MIN_POLL_INTERVAL_MS, MAX_POLL_INTERVAL_MS);
    const jittered = Math.round(intervalMs * (0.9 + Math.random() * 0.2));
    await sleep(jittered, options?.signal);
  }

  return {
    status: 'expired',
    raw: {
      message: `Timed out waiting for OAuth login after ${timeoutMs}ms.`,
    },
  };
}

function normalizePollPayload(payload: Record<string, unknown>): CliOAuthPollResult {
  const statusRaw =
    readString(payload, 'status')
    ?? (readBoolean(payload, 'approved') ? 'approved' : undefined)
    ?? (readBoolean(payload, 'done') ? 'approved' : undefined)
    ?? 'pending';

  const lower = statusRaw.toLowerCase();
  let status: CliOAuthPollResult['status'] = 'pending';
  if (lower === 'approved' || lower === 'complete' || lower === 'completed' || lower === 'success') {
    status = 'approved';
  } else if (lower === 'denied' || lower === 'rejected' || lower === 'failed') {
    status = 'denied';
  } else if (lower === 'expired' || lower === 'timeout' || lower === 'timed_out') {
    status = 'expired';
  }

  const apiKey =
    readString(payload, 'apiKey')
    ?? readString(payload, 'api_key')
    ?? readString(payload, 'key');
  const token =
    readString(payload, 'token')
    ?? readString(payload, 'accessToken')
    ?? readString(payload, 'access_token');
  const profile = (payload.profile ?? payload.user) as unknown;

  return {
    status,
    apiKey,
    token,
    profile,
    raw: payload,
  };
}

async function requestJson(
  url: string,
  options: {
    method: 'GET' | 'POST';
    body?: unknown;
    signal?: AbortSignal;
  },
): Promise<Record<string, unknown>> {
  return (await requestJsonWithMetadata(url, options)).payload;
}

async function requestJsonWithMetadata(
  url: string,
  options: {
    method: 'GET' | 'POST';
    body?: unknown;
    signal?: AbortSignal;
  },
): Promise<{ payload: Record<string, unknown>; retryAfterMs?: number }> {
  const request = createDeadlineController(options.signal, REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: options.method,
      headers: {
        Accept: 'application/json',
        ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: request.signal,
    });

    const text = await response.text();
    const payload = safeParseRecord(text);
    const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'));

    if (!response.ok) {
      const message = readString(payload, 'message')
        ?? readString(payload, 'error_description')
        ?? readString(payload, 'error')
        ?? `HTTP ${response.status}`;
      throw new OAuthHttpError(message, response.status, retryAfterMs);
    }

    return { payload, ...(retryAfterMs === undefined ? {} : { retryAfterMs }) };
  } finally {
    request.dispose();
  }
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1_000);
  const dateMs = Date.parse(value);
  return Number.isFinite(dateMs) ? Math.max(0, dateMs - Date.now()) : undefined;
}

function createDeadlineController(parent: AbortSignal | undefined, timeoutMs: number): {
  signal: AbortSignal;
  dispose: () => void;
} {
  const controller = new AbortController();
  const onAbort = () => controller.abort(parent?.reason ?? new Error('OAuth login cancelled.'));
  if (parent?.aborted) onAbort();
  else parent?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error('OAuth request timed out.')), timeoutMs);
  timer.unref?.();
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      parent?.removeEventListener('abort', onAbort);
    },
  };
}

function safeParseRecord(value: string): Record<string, unknown> {
  if (!value.trim()) {
    return {};
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Fall through.
  }

  return { raw: value };
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function readNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readBoolean(record: Record<string, unknown>, key: string): boolean | undefined {
  const value = record[key];
  return typeof value === 'boolean' ? value : undefined;
}

function trimTrailingSlash(value: string): string {
  return value.endsWith('/') ? value.slice(0, -1) : value;
}

function absolutizePollUrl(baseUrl: string, pollUrl: string): string {
  if (pollUrl.startsWith('http://') || pollUrl.startsWith('https://')) {
    return pollUrl;
  }

  if (pollUrl.startsWith('/')) {
    return `${baseUrl}${pollUrl}`;
  }

  return `${baseUrl}/${pollUrl}`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason ?? new Error('OAuth login cancelled.')); return; }
    const cleanup = () => signal?.removeEventListener('abort', onAbort);
    const onAbort = () => {
      clearTimeout(timer);
      cleanup();
      reject(signal?.reason ?? new Error('OAuth login cancelled.'));
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
