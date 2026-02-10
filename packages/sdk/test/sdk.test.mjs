import assert from 'node:assert/strict';
import test from 'node:test';

import { createRtrvrClient } from '../dist/index.js';

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'content-type': 'application/json',
      'x-request-id': 'req_test_123',
    },
  });
}

test('sdk run uses unified routing and returns metadata', async () => {
  const client = createRtrvrClient({
    apiKey: 'rtrvr_test_key',
    cloudBaseUrl: 'https://api.test.rtrvr.ai',
    mcpBaseUrl: 'https://mcp.test.rtrvr.ai',
    defaultTarget: 'cloud',
    fetchImpl: async (url) => {
      if (String(url) !== 'https://api.test.rtrvr.ai/agent') {
        throw new Error(`Unexpected URL: ${String(url)}`);
      }
      return jsonResponse({ ok: true });
    },
  });

  const result = await client.run({
    input: 'hello world',
  });

  assert.equal(result.metadata.selectedMode, 'cloud');
  assert.equal(result.metadata.requestId, 'req_test_123');
  assert.deepEqual(result.data.ok, true);
});

test('sdk tools.act maps to act_on_tab', async () => {
  const calls = [];
  const client = createRtrvrClient({
    apiKey: 'rtrvr_test_key',
    cloudBaseUrl: 'https://api.test.rtrvr.ai',
    mcpBaseUrl: 'https://mcp.test.rtrvr.ai',
    fetchImpl: async (url, init) => {
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      calls.push({ url: String(url), body });
      return jsonResponse({ success: true, data: { ok: true } });
    },
  });

  const result = await client.tools.act({ user_input: 'click submit' }, 'device-1');

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://mcp.test.rtrvr.ai');
  assert.equal(calls[0].body.tool, 'act_on_tab');
  assert.equal(calls[0].body.deviceId, 'device-1');
  assert.deepEqual(result, { ok: true });
});
