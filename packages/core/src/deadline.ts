import { RtrvrError } from './errors.js';

// One monotonic deadline owns the request, its retries and its event follower.
export function createDeadline(timeoutMs: number, parent?: AbortSignal): {
  signal: AbortSignal;
  remaining: () => number;
  dispose: () => void;
} {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
    throw new RtrvrError('timeoutMs must be a non-negative finite duration.', { code: 'INVALID_TIMEOUT' });
  }
  const end = performance.now() + timeoutMs;
  const controller = new AbortController();
  const onAbort = () => controller.abort(parent?.reason);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const remaining = () => Math.max(0, end - performance.now());
  const arm = () => {
    const ms = remaining();
    if (ms <= 0) controller.abort(new RtrvrError('Request deadline exceeded.', { code: 'REQUEST_DEADLINE' }));
    else timer = setTimeout(arm, Math.min(ms, 2_147_483_647));
  };
  if (parent?.aborted) onAbort();
  else { parent?.addEventListener('abort', onAbort, { once: true }); arm(); }
  return { signal: controller.signal, remaining, dispose: () => {
    clearTimeout(timer);
    parent?.removeEventListener('abort', onAbort);
  } };
}

export function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    if (!Number.isFinite(ms) || ms < 0) { reject(new RtrvrError('Retry delay must be a non-negative finite duration.', { code: 'INVALID_RETRY_DELAY' })); return; }
    const end = performance.now() + ms;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    const onAbort = () => { clearTimeout(timer); cleanup(); reject(signal.reason); };
    const arm = () => {
      const remaining = Math.max(0, end - performance.now());
      if (remaining === 0) { cleanup(); resolve(); }
      else timer = setTimeout(arm, Math.min(remaining, 2_147_483_647));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    arm();
  });
}

export function retryAfterMs(value: string | null): number | undefined {
  if (value === null || value.trim() === '') return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}
