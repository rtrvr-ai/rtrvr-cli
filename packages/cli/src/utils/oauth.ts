export interface CliOAuthStartResult {
  sessionId: string;
  verificationUrl?: string;
  pollUrl?: string;
  userCode?: string;
  intervalMs: number;
  expiresAt?: string;
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
}

export async function startCliOAuth(baseUrl: string): Promise<CliOAuthStartResult> {
  const normalized = trimTrailingSlash(baseUrl);
  const payload = await requestJson(`${normalized}/cli/auth/start`, {
    method: 'POST',
    body: {
      client: 'rtrvr-cli',
      platform: process.platform,
      arch: process.arch,
      nodeVersion: process.version,
    },
  });

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
    sessionId,
    verificationUrl:
      readString(payload, 'verificationUrl')
      ?? readString(payload, 'verification_url')
      ?? readString(payload, 'url'),
    pollUrl: readString(payload, 'pollUrl') ?? readString(payload, 'poll_url'),
    userCode: readString(payload, 'userCode') ?? readString(payload, 'user_code'),
    intervalMs: intervalMs > 0 ? intervalMs : 2000,
    expiresAt: readString(payload, 'expiresAt') ?? readString(payload, 'expires_at'),
    raw: payload,
  };
}

export async function pollCliOAuth(
  baseUrl: string,
  start: CliOAuthStartResult,
  options?: PollCliOAuthOptions,
): Promise<CliOAuthPollResult> {
  const normalized = trimTrailingSlash(baseUrl);
  const intervalMs = options?.intervalMs ?? start.intervalMs;
  const timeoutMs = options?.timeoutMs ?? 180_000;
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const endpoint = start.pollUrl
      ? absolutizePollUrl(normalized, start.pollUrl)
      : `${normalized}/cli/auth/poll?session_id=${encodeURIComponent(start.sessionId)}`;

    const payload = await requestJson(endpoint, { method: 'GET' });
    const result = normalizePollPayload(payload);

    if (result.status === 'approved' || result.status === 'denied' || result.status === 'expired') {
      return result;
    }

    await sleep(intervalMs);
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
  },
): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    method: options.method,
    headers: {
      Accept: 'application/json',
      ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });

  const text = await response.text();
  const payload = safeParseRecord(text);

  if (!response.ok) {
    const message = readString(payload, 'message')
      ?? readString(payload, 'error_description')
      ?? readString(payload, 'error')
      ?? `HTTP ${response.status}`;
    throw new Error(message);
  }

  return payload;
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

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
