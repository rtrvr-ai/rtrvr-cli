import assert from 'node:assert/strict';
import test from 'node:test';
const { HttpClient } = await import(process.env.RTRVR_TEST_CORE_URL ?? '../dist/index.js');

test('Retry-After longer than one platform timer is re-armed without an early retry', async t => {
  const day = 24 * 60 * 60 * 1000;
  const platformMaximum = 2_147_483_647;
  let now = 0, nextTimer = 0, requests = 0;
  const timers = new Map();
  t.mock.method(performance, 'now', () => now);
  t.mock.method(globalThis, 'setTimeout', (callback, ms) => {
    assert.ok(ms <= platformMaximum, 'no timer exceeds the Node platform envelope');
    const id = ++nextTimer; timers.set(id, { at: now + ms, callback }); return id;
  });
  t.mock.method(globalThis, 'clearTimeout', id => timers.delete(id));
  const flush = () => new Promise(resolve => setImmediate(resolve));
  const advance = async ms => {
    now += ms;
    for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.callback(); }
    await flush();
  };
  const client = new HttpClient({ apiKey: 'rtrvr_timer_fake', timeoutMs: 40 * day, retryPolicy: { maxAttempts: 3 }, fetchImpl: async () => {
    requests++;
    return new Response('{}', requests === 1 ? { status: 503, headers: { 'Retry-After': String(30 * day / 1000) } } : {});
  } });
  const result = client.requestJson({ url: 'http://localhost/agent' });
  await flush(); assert.equal(requests, 1);
  await advance(platformMaximum); assert.equal(requests, 1, 'a truncated timer must never admit an early retry');
  await advance(30 * day - platformMaximum); await result; assert.equal(requests, 2);
  assert.equal(timers.size, 0);
});
