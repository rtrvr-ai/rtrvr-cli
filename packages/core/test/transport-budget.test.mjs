import assert from 'node:assert/strict';
import test from 'node:test';
const { HttpClient } = await import(process.env.RTRVR_TEST_CORE_URL ?? '../dist/index.js');

test('retry serializes the request body once even if the caller mutates it', async () => {
  const body = { options: { value: 'original' } }; const received = [];
  const client = new HttpClient({ apiKey: 'rtrvr_budget_fake', retryPolicy: { maxAttempts: 3, baseDelayMs: 25 }, fetchImpl: async (_url, init) => {
    received.push(init.body); body.options.value = 'changed during admission';
    return new Response('{}', { status: received.length === 1 ? 503 : 200 });
  } });
  await client.requestJson({ url: 'http://localhost/agent', body });
  assert.equal(received.length, 2); assert.equal(received[1], received[0]);
});

test('encoding cannot start a request after its deadline was spent', async t => {
  let now = 0, calls = 0;
  t.mock.method(performance, 'now', () => now);
  const client = new HttpClient({ apiKey: 'rtrvr_budget_fake', timeoutMs: 100, fetchImpl: async () => { calls++; return new Response('{}'); } });
  await assert.rejects(client.requestJson({ url: 'http://localhost/agent', body: { toJSON() { now = 200; return { value: 'encoded' }; } } }), error => error.code === 'REQUEST_DEADLINE');
  assert.equal(calls, 0);
});

test('an unencodable body fails before admission with a typed diagnostic', async () => {
  const body = {}; body.circular = body; let calls = 0;
  const client = new HttpClient({ apiKey: 'rtrvr_budget_fake', retryPolicy: { maxAttempts: 3 }, fetchImpl: async () => { calls++; return new Response('{}'); } });
  await assert.rejects(client.requestJson({ url: 'http://localhost/agent', body }), error => error.code === 'INVALID_REQUEST_BODY');
  assert.equal(calls, 0);
});

test('a zero wait budget never starts admission', async () => {
  let calls = 0;
  const client = new HttpClient({ apiKey: 'rtrvr_budget_fake', timeoutMs: 0, fetchImpl: async () => { calls++; return new Response('{}'); } });
  await assert.rejects(client.requestJson({ url: 'http://localhost/agent' }), error => error.code === 'REQUEST_DEADLINE');
  assert.equal(calls, 0);
});
