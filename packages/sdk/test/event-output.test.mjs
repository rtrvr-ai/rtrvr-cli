import assert from 'node:assert/strict';
import test from 'node:test';
import { createRtrvrClient } from '../dist/index.js';

for (const method of ['run', 'agent.run', 'agent.cloud', 'scrape.run', 'scrape.route']) {
  test(`SDK ${method} can follow status without streaming output`, async () => {
    const requests = [], queries = [];
    const sdk = createRtrvrClient({ apiKey: 'rtrvr_status_fake', defaultTarget: 'cloud', timeoutMs: 1000, fetchImpl: async (url, init) => {
      if (init.method === 'POST') { requests.push(JSON.parse(init.body)); return new Response(JSON.stringify({ trajectoryId: 'status-only-run-123' }), { status: 202 }); }
      if (String(url).includes('/events')) { queries.push(new URL(url)); return new Response('event: done\ndata: {"status":"success"}\n\n', { headers: { 'content-type': 'text/event-stream' } }); }
      return new Response('{"status":"success","output":["full final output"]}');
    } });
    const invoke = method.split('.').reduce((owner, key) => owner[key], sdk);
    const result = await invoke({ input: 'task', urls: ['http://example.test'], trajectoryId: 'status-only-run-123', includeEventOutput: false, onEvent() {} });
    assert.equal(queries.length, 1); assert.equal(queries[0].searchParams.has('includeOutput'), false);
    assert.equal(Object.hasOwn(requests[0], 'includeEventOutput'), false);
    assert.deepEqual((result.data ?? result).output, ['full final output']);
  });
}
