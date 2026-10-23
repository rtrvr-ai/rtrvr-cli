import { Buffer } from 'node:buffer';
import { DEFAULT_TIMEOUT_MS } from './constants.js';
import { createDeadline, retryAfterMs, wait, untilAborted } from './deadline.js';
import { RtrvrError, serverErrorFromPayload } from './errors.js';

export interface StreamExecutionEvent {
  id?: string;
  event: string;
  data: unknown;
  raw: string;
}

export interface StreamExecutionEventsOptions {
  baseUrl: string;
  token: string;
  trajectoryId: string;
  phase?: number;
  since?: number;
  includeOutput?: boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Retained for source compatibility. Startup retries now share the run deadline. */
  startupRetryMs?: number;
  fetchImpl?: typeof fetch;
  onEvent: (event: StreamExecutionEvent, signal: AbortSignal) => unknown;
}

// A physical UTF-8 frame buffer envelope, independent of the number of events in a run.
export const MAX_SSE_EVENT_BYTES = 1_048_576;
const RECONNECT_DELAY_MS = 600;

export async function streamExecutionEvents(options: StreamExecutionEventsOptions): Promise<StreamExecutionEvent> {
  const deadline = createDeadline(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, options.signal);
  let since = options.since ?? 0;
  const fetchImpl = options.fetchImpl ?? fetch;
  let includeOutput = Boolean(options.includeOutput);
  const deliver = (event: StreamExecutionEvent): void | Promise<void> => {
    const root = record(event.data);
    // Relay ready/status/done ids are connection-local. Only durable event ids advance since.
    const durable = !['ready', 'execution_status', 'done', 'heartbeat', 'stream_repair'].includes(event.event);
    const sequence = typeof root.sequence === 'number' ? root.sequence : event.id ? Number(event.id) : undefined;
    const sequenced = durable && sequence !== undefined && Number.isSafeInteger(sequence) && sequence >= 0;
    if (sequenced && sequence <= since && event.event !== 'workflow_complete') return;
    if (deadline.remaining() <= 0) throw new RtrvrError('Run deadline exceeded while delivering events.', { code: 'REQUEST_DEADLINE' });
    let pending: Promise<unknown> | undefined;
    try {
      const returned = options.onEvent(event, deadline.signal);
      if (returned && typeof (returned as PromiseLike<unknown>).then === 'function') pending = Promise.resolve(returned);
    } catch (cause) { throw new RtrvrError(`Event callback failed: ${cause instanceof Error ? cause.message : String(cause)}`, { code: 'EVENT_CALLBACK_FAILED', cause, details: { partialResult: event.data } }); }
    if (pending) {
      return untilAborted(pending, deadline.signal).then(() => {
        if (deadline.remaining() <= 0) throw new RtrvrError('Run deadline exceeded while delivering events.', { code: 'REQUEST_DEADLINE' });
        if (sequenced) since = Math.max(since, sequence);
      }, cause => {
        deadline.signal.throwIfAborted();
        throw new RtrvrError(`Event callback failed: ${cause instanceof Error ? cause.message : String(cause)}`, { code: 'EVENT_CALLBACK_FAILED', cause, details: { partialResult: event.data } });
      });
    }
    if (deadline.remaining() <= 0) throw new RtrvrError('Run deadline exceeded while delivering events.', { code: 'REQUEST_DEADLINE' });
    if (sequenced) since = Math.max(since, sequence);
  };
  try {
    while (true) {
      deadline.signal.throwIfAborted();
      let delay = RECONNECT_DELAY_MS;
      try {
        const base = options.baseUrl.endsWith('/') ? options.baseUrl.slice(0, -1) : options.baseUrl;
        const url = new URL(`${base}/cli/executions/${encodeURIComponent(options.trajectoryId)}/events`);
        url.searchParams.set('phase', String(options.phase ?? 1));
        url.searchParams.set('since', String(since));
        if (includeOutput) url.searchParams.set('includeOutput', '1');
        const response = await fetchImpl(url.toString(), {
          method: 'GET', headers: { Accept: 'text/event-stream', Authorization: `Bearer ${options.token}` }, signal: deadline.signal,
        });
        if (!response.ok) {
          if (![404, 409, 425, 429, 500, 502, 503, 504].includes(response.status)) {
            const payload = await readStreamError(response, deadline.signal, deadline.remaining);
            throw serverErrorFromPayload(payload, { status: response.status, requestId: response.headers.get('x-request-id') ?? undefined });
          }
          void response.body?.cancel().catch(() => undefined);
          if (response.status === 429 || response.status === 503) delay = Math.max(delay, retryAfterMs(response.headers.get('retry-after')) ?? 0);
        } else {
          if (!response.body || !response.headers.get('content-type')?.includes('text/event-stream')) {
            void response.body?.cancel().catch(() => undefined);
            throw new RtrvrError('Event stream response did not include an SSE body.', { code: 'INVALID_EVENT_STREAM' });
          }
          const terminal = await consumeEventStream(response.body, deliver, deadline.signal, deadline.remaining);
          if (terminal) return terminal;
        }
      } catch (error) {
        deadline.signal.throwIfAborted();
        if (error instanceof RtrvrError && error.code === 'SSE_EVENT_TOO_LARGE' && includeOutput) {
          includeOutput = false;
          const data = { code: error.code, ...record(error.details), trajectoryId: options.trajectoryId, since,
            partialResult: { trajectoryId: options.trajectoryId, since }, action: 'follow_without_output' };
          const pending = deliver({ event: 'stream_repair', data, raw: JSON.stringify(data) });
          if (pending) await pending;
        } else if (error instanceof RtrvrError) throw error;
        // A transport drop resumes the same durable run after a real-clock wait.
      }
      if (delay >= deadline.remaining()) throw new RtrvrError('Reconnect delay exceeds the run deadline.', { code: 'REQUEST_DEADLINE', details: { trajectoryId: options.trajectoryId, since } });
      await wait(delay, deadline.signal);
    }
  } finally {
    deadline.dispose();
  }
}

async function consumeEventStream(body: ReadableStream<Uint8Array>, onEvent: (event: StreamExecutionEvent) => void | Promise<void>, signal: AbortSignal, remaining: () => number): Promise<StreamExecutionEvent | undefined> {
  const reader = body.getReader();
  let frame: Buffer | undefined;
  let length = 0;
  let skipLf = false;
  const onAbort = () => void reader.cancel(signal.reason).catch(() => undefined);
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) return undefined;
      const bytes = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
      let offset = 0;
      let nextCr = bytes.indexOf(13);
      while (offset < value.byteLength) {
        if (remaining() <= 0) throw new RtrvrError('Run deadline exceeded while reading events.', { code: 'REQUEST_DEADLINE' });
        if (nextCr >= 0 && nextCr < offset) nextCr = bytes.indexOf(13, offset);
        if (skipLf && value[offset] === 10) { skipLf = false; offset++; continue; }
        skipLf = false;
        if (length === 0) {
          const blank = bytes.indexOf('\n\n', offset);
          const cr = nextCr;
          if (blank >= 0 && (cr < 0 || cr > blank)) {
            const required = blank + 2 - offset;
            if (required > MAX_SSE_EVENT_BYTES) throw oversizedEvent(required);
            const event = parseEventChunk(bytes.toString('utf8', offset, blank + 2));
            offset = blank + 2;
            if (event) {
              const pending = onEvent(event);
              if (pending) await pending;
              if (event.event === 'workflow_complete' || event.event === 'done') return event;
            }
            continue;
          }
        }
        frame ??= Buffer.allocUnsafe(MAX_SSE_EVENT_BYTES);
        const lf = bytes.indexOf(10, offset);
        const cr = nextCr;
        const boundary = lf < 0 ? cr : cr < 0 ? lf : Math.min(lf, cr);
        const end = boundary < 0 ? value.byteLength : boundary;
        const required = length + end - offset + (boundary < 0 ? 0 : 1);
        if (required > frame.byteLength) throw oversizedEvent(required);
        frame.set(value.subarray(offset, end), length);
        length += end - offset;
        if (boundary < 0) break;
        skipLf = value[boundary] === 13;
        frame[length++] = 10;
        offset = boundary + 1;
        if (length >= 2 && frame[length - 2] === 10) {
          const event = parseEventChunk(frame.toString('utf8', 0, length));
          length = 0;
          if (event) {
            const pending = onEvent(event);
            if (pending) await pending;
            if (event.event === 'workflow_complete' || event.event === 'done') return event;
          }
        }
      }
    }
  } finally {
    signal.removeEventListener('abort', onAbort);
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function parseEventChunk(chunk: string): StreamExecutionEvent | undefined {
  let event = 'message';
  let id: string | undefined;
  const data: string[] = [];
  for (const line of chunk.split('\n')) {
    if (!line || line.startsWith(':')) continue;
    const separator = line.indexOf(':');
    const field = separator < 0 ? line : line.slice(0, separator);
    let value = separator < 0 ? '' : line.slice(separator + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') event = value || 'message';
    else if (field === 'id' && !value.includes('\0')) id = value;
    else if (field === 'data') data.push(value);
  }
  if (data.length === 0) return undefined;
  const raw = data.join('\n');
  let parsed: unknown = raw;
  try { parsed = JSON.parse(raw); } catch { /* SSE data can also be plain text. */ }
  return { id, event, data: parsed, raw };
}

export function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function oversizedEvent(actualAtLeastBytes: number): RtrvrError {
  return new RtrvrError('Event stream sent an oversized or unterminated event.', {
    code: 'SSE_EVENT_TOO_LARGE', details: { ceilingBytes: MAX_SSE_EVENT_BYTES, actualAtLeastBytes, repair: { kind: 'wire_bytes', basis: 'normalized_utf8_frame_buffer', ceilingBytes: MAX_SSE_EVENT_BYTES, actualAtLeastBytes } },
  });
}

async function readStreamError(response: Response, signal: AbortSignal, remaining: () => number): Promise<unknown> {
  if (!response.body) return undefined;
  const reader = response.body.getReader();
  const bytes = Buffer.allocUnsafe(MAX_SSE_EVENT_BYTES);
  let used = 0;
  const abort = () => void reader.cancel(signal.reason).catch(() => undefined);
  signal.addEventListener('abort', abort, { once: true });
  try {
    while (true) {
      signal.throwIfAborted();
      if (remaining() <= 0) throw new RtrvrError('Run deadline exceeded while reading an error.', { code: 'REQUEST_DEADLINE' });
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      if (used + value.byteLength > bytes.byteLength) throw oversizedEvent(used + value.byteLength);
      bytes.set(value, used); used += value.byteLength;
    }
    const raw = bytes.toString('utf8', 0, used);
    try { return JSON.parse(raw); } catch { return raw; }
  } finally { signal.removeEventListener('abort', abort); void reader.cancel().catch(() => undefined); reader.releaseLock(); }
}
