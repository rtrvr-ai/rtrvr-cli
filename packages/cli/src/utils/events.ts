export interface StreamExecutionEventsOptions {
  baseUrl: string;
  token: string;
  trajectoryId: string;
  phase?: number;
  since?: number;
  includeOutput?: boolean;
  signal?: AbortSignal;
  startupRetryMs?: number;
  onEvent: (event: StreamExecutionEvent) => void;
}

export interface StreamExecutionEvent {
  id?: string;
  event: string;
  data: unknown;
  raw: string;
}

const MAX_SSE_BUFFER_CHARS = 1_048_576;
const SSE_CONNECT_TIMEOUT_MS = 15_000;

export async function streamExecutionEvents(options: StreamExecutionEventsOptions): Promise<void> {
  const startupDeadline = Date.now() + (options.startupRetryMs ?? 20_000);
  const phase = options.phase ?? 1;
  const since = options.since ?? 0;
  const includeOutput = Boolean(options.includeOutput);
  const url = buildEventsUrl(options.baseUrl, options.trajectoryId, phase, since, includeOutput);

  while (true) {
    if (options.signal?.aborted) {
      return;
    }

    const request = createStreamController(options.signal);
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'GET',
        headers: {
          Accept: 'text/event-stream',
          Authorization: `Bearer ${options.token}`,
        },
        signal: request.signal,
      });
      request.clearConnectDeadline();
    } catch (error) {
      request.dispose();
      throw error;
    }

    try {
      if (!response.ok) {
        if (
          (response.status === 404 || response.status === 425 || response.status === 409)
          && Date.now() < startupDeadline
        ) {
          await sleep(600, options.signal);
          continue;
        }

        const body = await response.text();
        throw new Error(
          `Event stream failed (${response.status}): ${body || response.statusText || 'unknown error'}`,
        );
      }

      if (!response.body) {
        throw new Error('Event stream response did not include a readable body.');
      }

      await consumeEventStream(response.body, options.onEvent, request.signal);
      return;
    } finally {
      request.dispose();
    }
  }
}

function createStreamController(parent?: AbortSignal): {
  signal: AbortSignal;
  clearConnectDeadline: () => void;
  dispose: () => void;
} {
  const controller = new AbortController();
  const onAbort = () => controller.abort(parent?.reason ?? new Error('Event stream cancelled.'));
  if (parent?.aborted) onAbort();
  else parent?.addEventListener('abort', onAbort, { once: true });
  const deadline = setTimeout(
    () => controller.abort(new Error('Event stream connection timed out.')),
    SSE_CONNECT_TIMEOUT_MS,
  );
  deadline.unref?.();
  let deadlineCleared = false;
  const clearConnectDeadline = () => {
    if (deadlineCleared) return;
    deadlineCleared = true;
    clearTimeout(deadline);
  };
  return {
    signal: controller.signal,
    clearConnectDeadline,
    dispose: () => {
      clearConnectDeadline();
      parent?.removeEventListener('abort', onAbort);
    },
  };
}

function buildEventsUrl(
  baseUrl: string,
  trajectoryId: string,
  phase: number,
  since: number,
  includeOutput: boolean,
): string {
  const normalized = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
  const url = new URL(`${normalized}/cli/executions/${encodeURIComponent(trajectoryId)}/events`);
  url.searchParams.set('phase', String(phase));
  url.searchParams.set('since', String(since));
  if (includeOutput) {
    url.searchParams.set('includeOutput', '1');
  }
  return url.toString();
}

async function consumeEventStream(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: StreamExecutionEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const onAbort = () => void reader.cancel(signal?.reason).catch(() => undefined);
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    while (true) {
      if (signal?.aborted) {
        return;
      }

      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      if (buffer.length > MAX_SSE_BUFFER_CHARS) {
        await reader.cancel('SSE event exceeded the bounded buffer size.').catch(() => undefined);
        throw new Error('Event stream sent an oversized or unterminated event.');
      }
      buffer = flushBuffer(buffer, onEvent);
    }

    buffer += decoder.decode();
    flushBuffer(buffer, onEvent);
  } finally {
    signal?.removeEventListener('abort', onAbort);
    reader.releaseLock();
  }
}

function flushBuffer(
  input: string,
  onEvent: (event: StreamExecutionEvent) => void,
): string {
  const normalized = input.replace(/\r\n/g, '\n');
  let remaining = normalized;

  while (true) {
    const boundary = remaining.indexOf('\n\n');
    if (boundary === -1) {
      break;
    }

    const rawChunk = remaining.slice(0, boundary);
    remaining = remaining.slice(boundary + 2);

    const event = parseEventChunk(rawChunk);
    if (event) {
      onEvent(event);
    }
  }

  return remaining;
}

function parseEventChunk(chunk: string): StreamExecutionEvent | null {
  if (!chunk.trim()) {
    return null;
  }

  let eventName = 'message';
  let id: string | undefined;
  const dataLines: string[] = [];

  for (const line of chunk.split('\n')) {
    if (!line || line.startsWith(':')) {
      continue;
    }

    const separator = line.indexOf(':');
    if (separator === -1) {
      continue;
    }

    const field = line.slice(0, separator);
    let value = line.slice(separator + 1);
    if (value.startsWith(' ')) {
      value = value.slice(1);
    }

    if (field === 'event') {
      eventName = value || 'message';
    } else if (field === 'id') {
      id = value;
    } else if (field === 'data') {
      dataLines.push(value);
    }
  }

  if (dataLines.length === 0) {
    return null;
  }

  const raw = dataLines.join('\n');
  let parsed: unknown = raw;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Keep raw string payload.
  }

  return {
    id,
    event: eventName,
    data: parsed,
    raw,
  };
}

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason ?? new Error('Event stream cancelled.')); return; }
    const cleanup = () => signal?.removeEventListener('abort', onAbort);
    const onAbort = () => {
      clearTimeout(timer);
      cleanup();
      reject(signal?.reason ?? new Error('Event stream cancelled.'));
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
