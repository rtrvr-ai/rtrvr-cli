import assert from 'node:assert/strict';
import test from 'node:test';
const { streamExecutionEvents } = await import(process.env.RTRVR_TEST_CORE_URL ?? '../dist/index.js');
const frame = (event, id) => `event: ${event}\nid: ${id}\ndata: {"sequence":${id}}\n\n`;
const fetchImpl = async () => new Response(frame('tool_start', 1) + frame('tool_complete', 2) + frame('done', 3), { headers: { 'content-type': 'text/event-stream' } });
const options = { baseUrl: 'http://localhost/mcp', token: 'rtrvr_delivery_fake', trajectoryId: 'delivery-run-123', timeoutMs: 1000, fetchImpl };

test('event delivery awaits each asynchronous observer without queuing history', async () => {
  let inFlight = 0, maximum = 0; const seen = [];
  await streamExecutionEvents({ ...options, onEvent: async event => {
    inFlight++; maximum = Math.max(maximum, inFlight);
    await new Promise(resolve => setTimeout(resolve, 10)); seen.push(event.id); inFlight--;
  } });
  assert.equal(maximum, 1); assert.deepEqual(seen, ['1', '2', '3']); assert.equal(inFlight, 0);
});

test('a stalled observer stops at the run deadline and receives its abort signal', async () => {
  let calls = 0, aborted = false;
  const start = performance.now();
  await assert.rejects(streamExecutionEvents({ ...options, timeoutMs: 80, onEvent: (_event, signal) => {
    calls++;
    return new Promise(() => signal?.addEventListener('abort', () => { aborted = true; }, { once: true }));
  } }), error => error.code === 'REQUEST_DEADLINE');
  assert.equal(calls, 1); assert.equal(aborted, true); assert.ok(performance.now() - start < 600);
});

test('an asynchronous observer failure is delivered as a typed error', async () => {
  await assert.rejects(streamExecutionEvents({ ...options, onEvent: async () => { throw new Error('sink unavailable'); } }), error => error.code === 'EVENT_CALLBACK_FAILED');
});

test('an unreadable observer promise is a typed callback failure', async () => {
  await assert.rejects(streamExecutionEvents({ ...options, onEvent: () => ({ get then() { throw new Error('unreadable thenable'); } }) }), error => error.code === 'EVENT_CALLBACK_FAILED');
});
