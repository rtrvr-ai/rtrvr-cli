import assert from 'node:assert/strict';
import test from 'node:test';
const core = await import(process.env.RTRVR_TEST_CORE_URL ?? '../dist/index.js');
const { RtrvrClient, HttpClient } = core;

for (const shape of ['flat', 'nested', 'details']) {
  test(`server ${shape} errors preserve code, offending fields and body requestId`, async () => {
    const detail = { code: 'COMPAT_UNSUPPORTED_FIELD', message: 'Remove unsupported fields.', fields: ['options.invalid'], requestId: 'req_body_123' };
    const payload = shape === 'flat' ? detail : shape === 'nested' ? { error: detail } : { code: detail.code, message: detail.message, details: { fields: detail.fields }, requestId: detail.requestId };
    const client = new HttpClient({ apiKey: 'rtrvr_error_fake', fetchImpl: async () => new Response(JSON.stringify(payload), { status: 400 }) });
    await assert.rejects(client.requestJson({ url: 'http://localhost/agent' }), error => {
      assert.equal(error.code, detail.code);
      assert.equal(error.requestId, detail.requestId);
      assert.deepEqual(error.fields, detail.fields);
      assert.deepEqual(error.details, payload);
      assert.equal(typeof core.formatRtrvrError, 'function');
      const text = core.formatRtrvrError(error);
      assert.ok(text.includes(detail.code)); assert.ok(text.includes('options.invalid')); assert.ok(text.includes(detail.requestId));
      return true;
    });
  });
}

for (const method of ['agentRun', 'scrapeRun', 'scrape']) {
  test(`${method} keeps routing and execution controls off the cloud wire`, async () => {
    const signal = new AbortController().signal;
    const routing = { target: 'cloud', preferExtension: true, requireLocalSession: false, deviceId: 'local-only', includeEventOutput: false, signal };
    const client = new RtrvrClient({ apiKey: 'rtrvr_error_fake', fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      for (const key of [...Object.keys(routing), 'onEvent']) assert.equal(Object.hasOwn(body, key), false, `${key} leaked`);
      assert.equal(body.authToken, 'fake-google-token');
      assert.deepEqual(body.settings, { retained: true });
      return new Response('{"status":"success"}');
    } });
    await client[method]({ input: 'task', urls: ['http://example.test'], authToken: 'fake-google-token', settings: { retained: true }, ...routing });
  });
}

test('event relay errors use the server code and request id', async () => {
  const payload = { error: { code: 'TOKEN_EXPIRED', message: 'Sign in again.', fields: ['Authorization'] } };
  await assert.rejects(core.streamExecutionEvents({ baseUrl: 'http://localhost/mcp', token: 'rtrvr_error_fake', trajectoryId: 'run-123', timeoutMs: 1000, onEvent() {}, fetchImpl: async () => new Response(JSON.stringify(payload), { status: 401, headers: { 'x-request-id': 'relay-req-123' } }) }), error => error.code === 'TOKEN_EXPIRED' && error.requestId === 'relay-req-123' && error.fields[0] === 'Authorization');
});

test('failed final read preserves the streamed partial result', async () => {
  const partial = { status: 'error', output: ['retained useful answer'] };
  const client = new RtrvrClient({ apiKey: 'rtrvr_error_fake', timeoutMs: 1000, fetchImpl: async (url, init) => {
    if (init.method === 'POST') return new Response(JSON.stringify({ trajectoryId: 'run-123' }), { status: 202 });
    if (String(url).includes('/events')) return new Response(`event: workflow_complete\ndata: ${JSON.stringify({ data: partial })}\n\n`, { headers: { 'content-type': 'text/event-stream' } });
    return new Response(JSON.stringify({ code: 'RESULT_UNAVAILABLE', message: 'Final response unavailable.' }), { status: 503 });
  } });
  await assert.rejects(client.agentRun({ input: 'task', trajectoryId: 'run-123' }), error => {
    assert.equal(error.code, 'RESULT_UNAVAILABLE'); assert.deepEqual(error.details.partialResult, partial);
    assert.ok(core.formatRtrvrError(error).includes('retained useful answer'));
    assert.ok(core.formatRtrvrError(error).includes('run-123')); return true;
  });
});

test('deadline refusal retains the last server diagnostic and partial', async () => {
  const client = new HttpClient({ apiKey: 'rtrvr_error_fake', timeoutMs: 80, retryPolicy: { maxAttempts: 3 }, fetchImpl: async () => new Response(JSON.stringify({ code: 'NO_CAPACITY', fields: ['capacity'], requestId: 'capacity-req-123', partialResult: { retained: true } }), { status: 503, headers: { 'Retry-After': '60' } }) });
  await assert.rejects(client.requestJson({ url: 'http://localhost/agent' }), error => {
    const text = core.formatRtrvrError(error);
    assert.equal(error.code, 'REQUEST_DEADLINE'); assert.ok(text.includes('NO_CAPACITY'));
    assert.ok(text.includes('capacity-req-123')); assert.ok(text.includes('retained')); return true;
  });
});

for (const shape of ['nested', 'flat', 'string']) {
  test(`MCP ${shape} logical failures preserve server diagnostics`, async () => {
    const problem = { code: 'TOOL_INPUT_INVALID', message: 'The selector is invalid.', fields: ['selector'] };
    const payload = shape === 'nested' ? { success: false, error: problem } : shape === 'flat' ? { success: false, ...problem } : { success: false, error: problem.message, code: problem.code, fields: problem.fields };
    const client = new RtrvrClient({ apiKey: 'rtrvr_error_fake', fetchImpl: async () => new Response(JSON.stringify(payload), { headers: { 'x-request-id': 'mcp-req-123' } }) });
    await assert.rejects(client.toolRun({ tool: 'act_on_tab' }), error => {
      assert.equal(error.code, problem.code); assert.equal(error.message, problem.message);
      assert.deepEqual(error.fields, ['selector']); assert.equal(error.requestId, 'mcp-req-123');
      assert.equal(error.status, undefined); return true;
    });
  });
}
