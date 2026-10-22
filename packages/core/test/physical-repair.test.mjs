import assert from 'node:assert/strict';
import test from 'node:test';
import { RtrvrClient, streamExecutionEvents } from '../dist/index.js';
const frame = (event, data, id) => `event: ${event}\nid: ${id}\ndata: ${JSON.stringify(data)}\n\n`;
const sse = text => new Response(text, { headers: { 'content-type': 'text/event-stream' } });
const oversized = frame('tool_progress', { sequence: 2, data: { output: 'x'.repeat(1_048_577) } }, '2');

test('an oversized progress frame repairs to status-only resume without losing events', async () => {
  const events = []; let calls = 0;
  const terminal = await streamExecutionEvents({ baseUrl: 'http://localhost/mcp', token: 'rtrvr_repair_fake', trajectoryId: 'repair-run-123', includeOutput: true, timeoutMs: 3000, onEvent: event => events.push(event), fetchImpl: async url => {
    calls++; const parsed = new URL(url);
    if (calls === 1) {
      assert.equal(parsed.searchParams.get('includeOutput'), '1'); assert.equal(parsed.searchParams.get('since'), '0');
      return sse(frame('tool_start', { sequence: 1, data: {} }, '1') + oversized);
    }
    assert.equal(parsed.searchParams.get('includeOutput'), null); assert.equal(parsed.searchParams.get('since'), '1');
    return sse(frame('tool_progress', { sequence: 2, data: {} }, '2') + frame('workflow_complete', { data: { status: 'success' } }, '3'));
  } });
  assert.equal(terminal.event, 'workflow_complete'); assert.equal(calls, 2);
  assert.deepEqual(events.filter(e => e.id).map(e => e.id), ['1', '2', '3']);
  const repair = events.find(e => e.event === 'stream_repair').data;
  assert.equal(repair.code, 'SSE_EVENT_TOO_LARGE'); assert.equal(repair.repair.kind, 'wire_bytes');
  assert.ok(repair.repair.actualAtLeastBytes > repair.repair.ceilingBytes); assert.equal(repair.since, 1);
});

test('physical progress repair retains a full failed final result and its partial', async () => {
  let admissions = 0, streams = 0;
  const final = { status: 'error', output: [{ text: 'x'.repeat(4 * 1024 * 1024) }], partialResult: { retained: true } };
  const client = new RtrvrClient({ apiKey: 'rtrvr_repair_fake', cloudBaseUrl: 'http://localhost', timeoutMs: 3000, fetchImpl: async (url, init) => {
    if (init.method === 'POST') { admissions++; return new Response(JSON.stringify({ trajectoryId: 'repair-run-123' }), { status: 202 }); }
    if (String(url).includes('/events')) {
      streams++;
      return streams === 1 ? sse(oversized) : sse(frame('done', { status: 'error' }, '3'));
    }
    return new Response(JSON.stringify(final));
  } });
  const result = await client.agentRun({ input: 'task', trajectoryId: 'repair-run-123' });
  assert.equal(admissions, 1); assert.equal(streams, 2); assert.equal(result.status, 'error');
  assert.deepEqual(result.partialResult, { retained: true }); assert.equal(result.output[0].text.length, 4 * 1024 * 1024);
});
