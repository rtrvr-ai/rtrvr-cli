import assert from 'node:assert/strict';
import test from 'node:test';
import { RtrvrClient, HttpClient } from '../dist/index.js';

const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers });
for (const cloud of ['production', 'v3']) {
  for (const kind of ['agent', 'scrape']) {
    for (const status of [500, 503]) {
      test(`${cloud} ${kind}: retry after ${status} admits and bills once`, async () => {
        let posts = 0;
        const admissions = new Set();
        const calls = [];
        const client = new RtrvrClient({
          apiKey: 'rtrvr_retry_fake', retryPolicy: { maxAttempts: 3, baseDelayMs: 25 },
          fetchImpl: async (_url, init) => {
            const body = JSON.parse(init.body);
            const key = new Headers(init.headers).get('Idempotency-Key');
            calls.push({ body, key });
            // Both fake clouds bind Idempotency-Key when supplied. No key means a new paid admission.
            admissions.add(key ?? `paid-${++posts}`);
            return calls.length === 1 ? json({ message: 'reply lost after admission' }, status) : json({ status: 'success' });
          },
        });
        await (kind === 'agent' ? client.agentRun({ input: 'task' }) : client.scrapeRun({ urls: ['http://example.test'] }));
        assert.equal(admissions.size, 1, 'a retry must not create a second paid run');
        assert.ok(calls[0].body.trajectoryId);
        assert.equal(calls[0].key, calls[0].body.trajectoryId);
        assert.deepEqual(calls[1], calls[0]);
      });
    }
  }
}

test('caller trajectoryId owns Idempotency-Key without mutating request', async () => {
  const request = Object.freeze({ input: 'task', trajectoryId: 'chosen-run-123' });
  const client = new RtrvrClient({ apiKey: 'rtrvr_retry_fake', defaultHeaders: { 'idempotency-key': 'wrong' }, fetchImpl: async (_url, init) => {
    assert.equal(new Headers(init.headers).get('Idempotency-Key'), request.trajectoryId);
    assert.equal(JSON.parse(init.body).trajectoryId, request.trajectoryId);
    return json({ status: 'success' });
  } });
  await client.agentRun(request);
});

for (const status of [429, 503]) {
  for (const format of ['seconds', 'date']) {
    test(`Retry-After ${format} on ${status} is a minimum delay`, async () => {
      let calls = 0;
      const start = performance.now();
      const retryAt = Date.now() + 1600;
      const header = format === 'seconds' ? '1' : new Date(retryAt).toUTCString();
      const minimum = format === 'seconds' ? 1000 : Date.parse(header) - Date.now();
      const client = new HttpClient({ apiKey: 'rtrvr_retry_fake', timeoutMs: 4000, retryPolicy: { maxAttempts: 3, baseDelayMs: 25 }, fetchImpl: async () => {
        calls++;
        return calls === 1 ? json({}, status, { 'Retry-After': header }) : json({ ok: true });
      } });
      await client.requestJson({ url: 'http://localhost/agent' });
      assert.equal(calls, 2);
      assert.ok(performance.now() - start >= minimum - 20);
    });
  }
}

test('Retry-After beyond the request deadline never starts another request', async () => {
  let calls = 0;
  const client = new HttpClient({ apiKey: 'rtrvr_retry_fake', timeoutMs: 80, retryPolicy: { maxAttempts: 3, baseDelayMs: 25 }, fetchImpl: async () => { calls++; return json({}, 503, { 'Retry-After': '60' }); } });
  const start = performance.now();
  await assert.rejects(client.requestJson({ url: 'http://localhost/agent' }));
  assert.equal(calls, 1);
  assert.ok(performance.now() - start < 500);
});

test('caller abort interrupts backoff', async () => {
  const controller = new AbortController();
  let calls = 0;
  const client = new HttpClient({ apiKey: 'rtrvr_retry_fake', timeoutMs: 2000, retryPolicy: { maxAttempts: 3 }, fetchImpl: async () => { calls++; setTimeout(() => controller.abort(), 20); return json({}, 503, { 'Retry-After': '1' }); } });
  await assert.rejects(client.requestJson({ url: 'http://localhost/agent', signal: controller.signal }));
  assert.equal(calls, 1);
});
