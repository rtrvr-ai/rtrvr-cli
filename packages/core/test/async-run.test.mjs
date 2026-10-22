import assert from 'node:assert/strict';
import test from 'node:test';
const core = await import(process.env.RTRVR_TEST_CORE_URL ?? '../dist/index.js');
const { RtrvrClient } = core;
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const sse = (text) => new Response(text, { headers: { 'content-type': 'text/event-stream' } });
const frame = (event, data, id = '') => `event: ${event}\n${id ? `id: ${id}\n` : ''}data: ${JSON.stringify(data)}\n\n`;

for (const cloud of ['production', 'v3']) {
  for (const kind of ['agent', 'scrape']) {
    test(`${cloud} ${kind}: advisory Prefer preserves the HTTP 200 result`, async () => {
      const final = { status: 'success', output: [{ text: 'unchanged final' }], partialResult: { retained: true } };
      const client = new RtrvrClient({ apiKey: 'rtrvr_async_fake', fetchImpl: async (_url, init) => {
        assert.equal(new Headers(init.headers).get('Prefer'), 'respond-async');
        return json(final);
      } });
      const result = await (kind === 'agent' ? client.agentRun({ input: 'task' }) : client.scrapeRun({ urls: ['http://example.test'] }));
      const { metadata, ...body } = result;
      assert.deepEqual(body, final);
    });
  }
}

test('202 follows the MCP relay, resumes EOF and a dropped socket, then reads the complete result', async () => {
  const calls = [], seen = [];
  let streams = 0;
  const final = { status: 'success', output: [{ text: 'full final result' }], partialResult: { retained: true } };
  const client = new RtrvrClient({ apiKey: 'rtrvr_async_fake', cloudBaseUrl: 'http://localhost:1234', mcpBaseUrl: 'http://localhost:1235/mcp', timeoutMs: 6000,
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init });
      if (init.method === 'POST') return json({ trajectoryId: 'async-run-123', statusUrl: '/agent/async-run-123', status: 'running' }, 202);
      if (String(url).includes('/events')) {
        streams++;
        const since = new URL(url).searchParams.get('since');
        if (streams === 1) { assert.equal(since, '0'); return sse(frame('tool_start', { sequence: 1, data: {} }, '1')); }
        if (streams === 2) {
          assert.equal(since, '1');
          let read = false;
          return new Response(new ReadableStream({ pull(c) {
            if (!read) { read = true; c.enqueue(new TextEncoder().encode(frame('tool_complete', { sequence: 2, data: {} }, '2'))); }
            else c.error(new Error('socket dropped'));
          } }), { headers: { 'content-type': 'text/event-stream' } });
        }
        assert.equal(since, '2');
        return sse(frame('workflow_complete', { data: { status: 'success', output: [{ text: 'clipped preview' }] } }, '3'));
      }
      assert.equal(String(url), 'http://localhost:1234/agent/async-run-123/response');
      return json(final);
    },
  });
  const result = await client.agentRun({ input: 'task', trajectoryId: 'async-run-123', onEvent: (event) => { if (event.id) seen.push(event.id); } });
  assert.deepEqual(result.output, final.output);
  assert.deepEqual(result.partialResult, final.partialResult);
  assert.equal(calls.filter(c => c.init.method === 'POST').length, 1);
  assert.deepEqual(seen, ['1', '2', '3']);
  assert.equal(streams, 3);
});

test('abort acknowledges cancel on a separate bounded request', async () => {
  const abort = new AbortController(); let cancelled = false, posts = 0;
  const client = new RtrvrClient({ apiKey: 'rtrvr_async_fake', cloudBaseUrl: 'http://localhost', timeoutMs: 2000, fetchImpl: async (url, init) => {
    if (String(url).endsWith('/agent/cancel')) { assert.equal(JSON.parse(init.body).trajectoryId, 'cancel-run-123'); await new Promise(r => setTimeout(r, 25)); cancelled = true; return json({ ok: true }); }
    if (init.method === 'POST') { posts++; setTimeout(() => abort.abort(new Error('user cancelled')), 20); return json({ trajectoryId: 'cancel-run-123' }, 202); }
    return new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true }));
  } });
  await assert.rejects(client.agentRun({ input: 'task', trajectoryId: 'cancel-run-123', signal: abort.signal }), /user cancelled/);
  assert.equal(cancelled, true);
  assert.equal(posts, 1);
});

test('default client wait covers the maximum 45 minute run window', () => {
  assert.ok(core.DEFAULT_TIMEOUT_MS >= 45 * 60 * 1000);
});

for (const end of ['eof', 'drop', 'retry-after']) {
  test(`event follower stops at the caller deadline after ${end}`, async () => {
    assert.equal(typeof core.streamExecutionEvents, 'function');
    let calls = 0;
    const start = performance.now();
    await assert.rejects(core.streamExecutionEvents({ baseUrl: 'http://localhost/mcp', token: 'rtrvr_async_fake', trajectoryId: 'run-123', timeoutMs: 80, onEvent() {}, fetchImpl: async () => {
      calls++;
      if (end === 'drop') throw new Error('socket dropped');
      return end === 'retry-after' ? new Response('', { status: 429, headers: { 'Retry-After': '60' } }) : sse('');
    } }));
    assert.equal(calls, 1);
    assert.ok(performance.now() - start < 600);
  });
}

test('synthetic ready and status ids do not advance the durable resume cursor', async () => {
  assert.equal(typeof core.streamExecutionEvents, 'function');
  let calls = 0;
  await core.streamExecutionEvents({ baseUrl: 'http://localhost/mcp', token: 'rtrvr_async_fake', trajectoryId: 'run-123', timeoutMs: 2000, onEvent() {}, fetchImpl: async (url) => {
    calls++;
    if (calls === 1) return sse(frame('ready', {}, '999') + frame('execution_status', { status: 'executing', sequence: 0 }, '1000'));
    assert.equal(new URL(url).searchParams.get('since'), '0');
    return sse(frame('done', { status: 'success' }));
  } });
});

test('SSE parses CRLF across chunks and releases the stream at a terminal event', async () => {
  assert.equal(typeof core.streamExecutionEvents, 'function');
  const seen = []; let cancelled = false;
  const bytes = new TextEncoder().encode('event: tool_start\r\nid: 1\r\ndata: {"text":"雪"}\r\n\r\nevent: done\r\ndata: {"status":"success"}\r\n\r\n');
  let offset = 0;
  await core.streamExecutionEvents({ baseUrl: 'http://localhost/mcp', token: 'rtrvr_async_fake', trajectoryId: 'run-123', timeoutMs: 1000, onEvent: e => seen.push(e), fetchImpl: async () => new Response(new ReadableStream({ pull(c) { if (offset < bytes.length) c.enqueue(bytes.slice(offset, ++offset)); }, cancel() { cancelled = true; } }), { headers: { 'content-type': 'text/event-stream' } }) });
  assert.deepEqual(seen.map(e => e.event), ['tool_start', 'done']);
  assert.equal(seen[0].data.text, '雪');
  assert.equal(cancelled, true);
});

test('202 follows the returned server run id', async () => {
  const client = new RtrvrClient({ apiKey: 'rtrvr_async_fake', cloudBaseUrl: 'http://localhost', mcpBaseUrl: 'http://localhost/mcp', timeoutMs: 1000, fetchImpl: async (url, init) => {
    if (init.method === 'POST') return json({ runId: 'server-run-123' }, 202);
    assert.ok(String(url).includes('server-run-123'));
    if (String(url).includes('/events')) return sse(frame('done', { status: 'success' }));
    return json({ status: 'success', output: ['server result'] });
  } });
  assert.deepEqual((await client.agentRun({ input: 'task' })).output, ['server result']);
});

for (const bytes of [1_048_575, 1_048_576, 1_048_577]) {
  test(`SSE physical event envelope at ${bytes} bytes`, async () => {
    const prefix = 'event: tool_progress\ndata: {"text":"'; const suffix = '"}\n\n';
    const input = prefix + 'x'.repeat(bytes - prefix.length - suffix.length) + suffix + frame('done', { status: 'success' });
    let seen = 0;
    const follow = core.streamExecutionEvents({ baseUrl: 'http://localhost/mcp', token: 'rtrvr_async_fake', trajectoryId: 'run-123', timeoutMs: 1000, onEvent: () => seen++, fetchImpl: async () => sse(input) });
    if (bytes > 1_048_576) {
      await assert.rejects(follow, error => error.code === 'SSE_EVENT_TOO_LARGE' && error.details.ceilingBytes === 1_048_576);
      assert.equal(seen, 0);
    } else { await follow; assert.equal(seen, 2); }
  });
}

test('UTF-8 event bytes cannot bypass the physical envelope', async () => {
  await assert.rejects(core.streamExecutionEvents({ baseUrl: 'http://localhost/mcp', token: 'rtrvr_async_fake', trajectoryId: 'run-123', timeoutMs: 1000, onEvent() {}, fetchImpl: async () => sse(frame('tool_progress', { text: '雪'.repeat(400000) })) }), error => error.code === 'SSE_EVENT_TOO_LARGE');
});

test('wall clock jumps do not extend the monotonic stream deadline', async () => {
  const original = Date.now; let calls = 0;
  const start = performance.now();
  try {
    await assert.rejects(core.streamExecutionEvents({ baseUrl: 'http://localhost/mcp', token: 'rtrvr_async_fake', trajectoryId: 'run-123', timeoutMs: 80, onEvent() {}, fetchImpl: async (_url, init) => {
      calls++; Date.now = () => original() - 86400000;
      return new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true }));
    } }));
  } finally { Date.now = original; }
  assert.equal(calls, 1); assert.ok(performance.now() - start < 600);
});

test('abort during auto routing stops the device probe before admission', async () => {
  const controller = new AbortController(); let posts = 0;
  const client = new RtrvrClient({ apiKey: 'rtrvr_async_fake', timeoutMs: 1000, fetchImpl: async (_url, init) => {
    posts++; assert.equal(JSON.parse(init.body).tool, 'list_devices');
    setTimeout(() => controller.abort(new Error('route cancelled')), 20);
    return new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true }));
  } });
  await assert.rejects(client.run({ input: 'task', signal: controller.signal }), /route cancelled/);
  assert.equal(posts, 1);
});

test('extension scrape retains its progress observer', async () => {
  let seen = 0;
  const client = new RtrvrClient({ apiKey: 'rtrvr_async_fake', timeoutMs: 1000, fetchImpl: async (_url, init) => {
    if (init.method === 'GET') return sse(frame('workflow_complete', { data: { status: 'success' } }, '1'));
    await new Promise(resolve => setTimeout(resolve, 20));
    return json({ success: true, data: { status: 'success' } });
  } });
  const result = await client.scrape({ urls: ['http://example.test'], target: 'extension', trajectoryId: 'extension-run-123', onEvent: () => seen++ });
  assert.equal(result.metadata.selectedMode, 'extension'); assert.equal(seen, 1);
});

test('unacknowledged cancel ends within the ten second physical wait envelope', async () => {
  const controller = new AbortController(); let cancelRequests = 0;
  const client = new RtrvrClient({ apiKey: 'rtrvr_async_fake', timeoutMs: 1000, fetchImpl: async (url, init) => {
    if (String(url).endsWith('/cancel')) cancelRequests++;
    else if (init.method === 'POST') { setTimeout(() => controller.abort(), 20); return json({ trajectoryId: 'cancel-run-123' }, 202); }
    return new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true }));
  } });
  const start = performance.now();
  await assert.rejects(client.agentRun({ input: 'task', trajectoryId: 'cancel-run-123', signal: controller.signal }), error => error.code === 'CANCEL_UNCONFIRMED');
  assert.equal(cancelRequests, 1); assert.ok(performance.now() - start >= 9900); assert.ok(performance.now() - start < 12000);
});
