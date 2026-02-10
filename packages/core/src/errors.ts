export class RtrvrError extends Error {
  public readonly status?: number;
  public readonly requestId?: string;
  public readonly code?: string;
  public readonly details?: unknown;

  constructor(
    message: string,
    options?: {
      status?: number;
      requestId?: string;
      code?: string;
      details?: unknown;
      cause?: unknown;
    },
  ) {
    super(message);
    this.name = 'RtrvrError';
    this.status = options?.status;
    this.requestId = options?.requestId;
    this.code = options?.code;
    this.details = options?.details;

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
