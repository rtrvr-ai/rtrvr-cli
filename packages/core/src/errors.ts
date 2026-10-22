export class RtrvrError extends Error {
  public readonly status?: number;
  public readonly requestId?: string;
  public readonly code?: string;
  public readonly details?: unknown;
  public readonly retryAfterMs?: number;
  public readonly fields?: unknown;

  constructor(
    message: string,
    options?: {
      status?: number;
      requestId?: string;
      code?: string;
      details?: unknown;
      retryAfterMs?: number;
      fields?: unknown;
      cause?: unknown;
    },
  ) {
    super(message);
    this.name = 'RtrvrError';
    this.status = options?.status;
    this.requestId = options?.requestId;
    this.code = options?.code;
    this.details = options?.details;
    this.retryAfterMs = options?.retryAfterMs;
    this.fields = options?.fields;

    if (options?.cause) {
      (this as Error & { cause?: unknown }).cause = options.cause;
    }
  }
}

export function isNoDeviceError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const message = error.message.toLowerCase();
  return (
    message.includes('no online chrome extension') ||
    message.includes('device') && message.includes('not online') ||
    message.includes('device') && message.includes('not found')
  );
}

export function isUnknownToolError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const message = error.message.toLowerCase();
  return (
    message.includes('unknown tool') ||
    message.includes('tool not found') ||
    message.includes('invalid tool')
  );
}

export function isSupportedAuthToken(value: string): boolean {
  return value.startsWith('rtrvr_') || value.startsWith('mcp_at_');
}

export function formatRtrvrError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (!(error instanceof RtrvrError)) return message;
  const parts = [message];
  if (error.code) parts.push(`code: ${error.code}`);
  const cause = (error as Error & { cause?: unknown }).cause;
  if (cause instanceof RtrvrError && cause.code && cause.code !== error.code) parts.push(`serverCode: ${cause.code}`);
  if (error.fields !== undefined) parts.push(`fields: ${JSON.stringify(error.fields)}`);
  if (error.requestId) parts.push(`requestId: ${error.requestId}`);
  const detail = error.details && typeof error.details === 'object' ? error.details as Record<string, unknown> : {};
  if (typeof detail.trajectoryId === 'string') parts.push(`trajectoryId: ${detail.trajectoryId}`);
  const repair = detail.repair ?? errorRecord(detail.failure).repair;
  if (repair !== undefined) parts.push(`repair: ${JSON.stringify(repair)}`);
  const partial = detail.partialResult ?? errorRecord(detail.error).partialResult;
  if (partial !== undefined) parts.push(`partialResult: ${JSON.stringify(partial)}`);
  return parts.join(' | ');
}

export function serverRequestId(payload: unknown, header?: string): string | undefined {
  const root = errorRecord(payload);
  return header ?? errorString(root.requestId) ?? errorString(errorRecord(root.error).requestId) ?? errorString(errorRecord(root.metadata).requestId);
}

export function serverErrorFromPayload(payload: unknown, options: { status?: number; requestId?: string; retryAfterMs?: number; fallbackMessage?: string }): RtrvrError {
  const root = errorRecord(payload);
  const failure = errorRecord(root.error);
  const detail = errorRecord(root.details);
  const message = typeof payload === 'string' ? payload : errorString(root.message) ?? errorString(failure.message) ?? errorString(root.error) ?? options.fallbackMessage ?? (options.status === undefined ? 'Request failed.' : `HTTP ${options.status}`);
  const { fallbackMessage: _fallbackMessage, ...metadata } = options;
  return new RtrvrError(message, {
    ...metadata, requestId: serverRequestId(payload, options.requestId),
    code: errorString(root.code) ?? errorString(failure.code),
    fields: root.fields ?? failure.fields ?? detail.fields ?? errorRecord(failure.details).fields ?? root.field ?? failure.field,
    details: payload,
  });
}

function errorRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function errorString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
