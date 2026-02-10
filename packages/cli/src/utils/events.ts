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

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Accept: 'text/event-stream',
        Authorization: `Bearer ${options.token}`,
      },
      signal: options.signal,
    });

    if (!response.ok) {
      if (
        (response.status === 404 || response.status === 425 || response.status === 409)
        && Date.now() < startupDeadline
      ) {
        await sleep(600);
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

    await consumeEventStream(response.body, options.onEvent, options.signal);
    return;
  }
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

  while (true) {
    if (signal?.aborted) {
      return;
    }

    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    buffer = flushBuffer(buffer, onEvent);
  }

  buffer += decoder.decode();
  flushBuffer(buffer, onEvent);
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

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
