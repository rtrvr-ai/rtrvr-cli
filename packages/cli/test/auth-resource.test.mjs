import assert from 'node:assert/strict';
import test from 'node:test';

import { streamExecutionEvents } from '../../../.tmp/cli-utils-test/events.js';
import { pollCliOAuth, startCliOAuth } from '../../../.tmp/cli-utils-test/oauth.js';

function jsonResponse(status, payload, headers = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

test('CLI login prefers v2 and falls back to the unchanged v1 bootstrap', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    if (String(url).endsWith('/cli/auth/v2/start')) return jsonResponse(404, { error: 'Not found' });
    return jsonResponse(200, {
      sessionId: 'legacy-session',
      pollUrl: '/cli/auth/poll',
      intervalMs: 10,
    });
  };

  const started = await startCliOAuth('https://cli.example.test');
  assert.equal(started.protocolVersion, 1);
  assert.equal(started.codeVerifier, undefined);
  assert.equal(started.intervalMs, 1_000);
  assert.deepEqual(calls.map((url) => new URL(url).pathname), [
    '/cli/auth/v2/start',
    '/cli/auth/start',
  ]);
});

test('CLI poll keeps one request in flight and stops immediately after approval', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  let inFlight = 0;
  let maxInFlight = 0;
  let statusCalls = 0;
  let exchangeCalls = 0;
  globalThis.fetch = async (url) => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 5));
    inFlight -= 1;
    if (String(url).includes('/status')) {
      statusCalls += 1;
      return jsonResponse(200, { status: 'approved' });
    }
    exchangeCalls += 1;
    return jsonResponse(200, { status: 'approved', apiKey: 'rtrvr_once' });
  };

  const result = await pollCliOAuth('https://cli.example.test', {
    protocolVersion: 2,
    sessionId: 'v2-session',
    pollUrl: '/cli/auth/v2/status',
    intervalMs: 1_000,
    codeVerifier: 'verifier',
    raw: {},
  });
  assert.equal(result.apiKey, 'rtrvr_once');
  assert.equal(maxInFlight, 1);
  assert.equal(statusCalls, 1);
  assert.equal(exchangeCalls, 1);
});

test('unterminated SSE input fails at the one MiB buffer cap', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(`data: ${'x'.repeat(1_048_576)}`));
    },
  }), { status: 200, headers: { 'content-type': 'text/event-stream' } });

  await assert.rejects(
    streamExecutionEvents({
      baseUrl: 'https://cli.example.test',
      token: 'test-token',
      trajectoryId: 'trajectory',
      onEvent: () => assert.fail('oversized event must never be delivered'),
    }),
    /oversized or unterminated event/,
  );
});
