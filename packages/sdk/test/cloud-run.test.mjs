import assert from 'node:assert/strict';
import test from 'node:test';
const { createRtrvrClient } = await import(process.env.RTRVR_TEST_SDK_URL ?? '../dist/index.js');

for (const method of ['run', 'agent.run', 'agent.cloud', 'scrape.run', 'scrape.route']) {
  test(`SDK ${method} keeps run identity across retries`, async () => {
    const calls = [];
    const sdk = createRtrvrClient({ apiKey: 'rtrvr_sdk_fake', defaultTarget: 'cloud', retryPolicy: { maxAttempts: 3, baseDelayMs: 25 }, fetchImpl: async (_url, init) => {
      calls.push({ key: new Headers(init.headers).get('Idempotency-Key'), prefer: new Headers(init.headers).get('Prefer'), body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ status: 'success' }), { status: calls.length === 1 ? 503 : 200 });
    } });
    const invoke = method.split('.').reduce((owner, key) => owner[key], sdk);
    await invoke({ input: 'task', urls: ['http://example.test'] });
    assert.equal(calls.length, 2);
    assert.ok(calls[0].body.trajectoryId);
    assert.equal(calls[0].key, calls[0].body.trajectoryId);
    assert.equal(calls[0].prefer, 'respond-async');
    assert.deepEqual(calls[1], calls[0]);
  });
}
