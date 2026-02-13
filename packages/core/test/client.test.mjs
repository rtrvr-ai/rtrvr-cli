import assert from 'node:assert/strict';
import test from 'node:test';

import { RtrvrClient, isSupportedAuthToken } from '../dist/index.js';

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'content-type': 'application/json',
    },
  });
}

test('isSupportedAuthToken accepts both RTRVR token formats', () => {
  assert.equal(isSupportedAuthToken('rtrvr_abc123'), true);
  assert.equal(isSupportedAuthToken('mcp_at_abc123'), true);
  assert.equal(isSupportedAuthToken('bearer_abc123'), false);
});

test('cloud routes reject mcp_at tokens with a clear error', async () => {
  const client = new RtrvrClient({
    apiKey: 'mcp_at_test_key',
    cloudBaseUrl: 'https://api.test.rtrvr.ai',
    mcpBaseUrl: 'https://mcp.test.rtrvr.ai',
    fetchImpl: async () => jsonResponse({ ok: true }),
  });

  await assert.rejects(
    async () => client.run({ input: 'cloud request', target: 'cloud' }),
    /requires an rtrvr_ API key/i,
  );
});

test('mcp_at tokens continue to work for MCP tool calls', async () => {
  const calls = [];

  const client = new RtrvrClient({
    apiKey: 'mcp_at_test_key',
    cloudBaseUrl: 'https://api.test.rtrvr.ai',
    mcpBaseUrl: 'https://mcp.test.rtrvr.ai',
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined });
      return jsonResponse({ success: true, data: { ok: true } });
    },
  });

  const result = await client.toolRun({
    tool: 'get_current_credits',
    params: {},
  });

  assert.deepEqual(result, { ok: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://mcp.test.rtrvr.ai');
});

test('run defaults to cloud /agent when auto target and no extension devices are online', async () => {
  const calls = [];

  const client = new RtrvrClient({
    apiKey: 'rtrvr_test_key',
    cloudBaseUrl: 'https://api.test.rtrvr.ai',
    mcpBaseUrl: 'https://mcp.test.rtrvr.ai',
    defaultTarget: 'auto',
    preferExtensionByDefault: false,
    fetchImpl: async (url, init) => {
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url: String(url), body });

      // list_devices returns no online devices
      if (String(url) === 'https://mcp.test.rtrvr.ai' && body?.tool === 'list_devices') {
        return jsonResponse({
          success: true,
          data: { online: false, deviceCount: 0, devices: [] },
        });
      }

      if (String(url).endsWith('/agent')) {
        return jsonResponse({ ok: true, path: 'agent' });
      }

      throw new Error(`Unexpected call to ${String(url)} (tool: ${body?.tool})`);
    },
  });

  const result = await client.run({
    input: 'Find latest release notes',
  });

  assert.equal(result.metadata.selectedMode, 'cloud');
  assert.equal(result.metadata.fallbackApplied, false);
  assert.equal(result.data?.ok, true);
  assert.equal(result.data?.path, 'agent');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].body.tool, 'list_devices');
  assert.equal(calls[1].url, 'https://api.test.rtrvr.ai/agent');
});

test('run prefers extension planner when extension is online in auto mode', async () => {
  const calls = [];

  const client = new RtrvrClient({
    apiKey: 'rtrvr_test_key',
    cloudBaseUrl: 'https://api.test.rtrvr.ai',
    mcpBaseUrl: 'https://mcp.test.rtrvr.ai',
    defaultTarget: 'auto',
    preferExtensionByDefault: true,
    fetchImpl: async (url, init) => {
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url: String(url), body });

      if (String(url) !== 'https://mcp.test.rtrvr.ai') {
        throw new Error(`Unexpected URL ${String(url)}`);
      }

      if (body?.tool === 'list_devices') {
        return jsonResponse({
          success: true,
          data: {
            online: true,
            deviceCount: 1,
            devices: [{ deviceId: 'device-1' }],
          },
        });
      }

      if (body?.tool === 'planner') {
        return jsonResponse({
          success: true,
          data: {
            completed: true,
            output: { text: 'ok' },
          },
        });
      }

      throw new Error(`Unexpected tool call ${body?.tool || 'unknown'}`);
    },
  });

  const result = await client.run({
    input: 'Use local session for checkout flow',
    urls: ['https://example.com'],
  });

  assert.equal(result.metadata.selectedMode, 'extension');
  assert.equal(result.metadata.fallbackApplied, false);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].body.tool, 'list_devices');
  assert.equal(calls[1].body.tool, 'planner');
});

test('run in auto mode with explicit deviceId uses extension planner directly', async () => {
  const calls = [];

  const client = new RtrvrClient({
    apiKey: 'rtrvr_test_key',
    cloudBaseUrl: 'https://api.test.rtrvr.ai',
    mcpBaseUrl: 'https://mcp.test.rtrvr.ai',
    defaultTarget: 'auto',
    preferExtensionByDefault: false,
    fetchImpl: async (url, init) => {
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url: String(url), body });

      if (String(url) !== 'https://mcp.test.rtrvr.ai') {
        throw new Error(`Unexpected URL ${String(url)}`);
      }

      if (body?.tool !== 'planner') {
        throw new Error(`Unexpected tool call ${body?.tool || 'unknown'}`);
      }

      return jsonResponse({
        success: true,
        data: {
          completed: true,
          output: { text: 'ok' },
        },
      });
    },
  });

  const result = await client.run({
    input: 'run locally on a specific extension',
    deviceId: 'device-42',
  });

  assert.equal(result.metadata.selectedMode, 'extension');
  assert.equal(result.metadata.fallbackApplied, false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.tool, 'planner');
  assert.equal(calls[0].body.deviceId, 'device-42');
});

test('scrape in extension mode surfaces backend tool errors without compatibility fallback', async () => {
  const client = new RtrvrClient({
    apiKey: 'rtrvr_test_key',
    cloudBaseUrl: 'https://api.test.rtrvr.ai',
    mcpBaseUrl: 'https://mcp.test.rtrvr.ai',
    fetchImpl: async (url, init) => {
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      if (String(url) !== 'https://mcp.test.rtrvr.ai') {
        throw new Error(`Unexpected URL ${String(url)}`);
      }
      if (body?.tool !== 'scrape') {
        throw new Error(`Unexpected tool call ${body?.tool || 'unknown'}`);
      }
      return jsonResponse(
        {
          success: false,
          error: { message: 'Unknown tool: scrape' },
        },
        400,
      );
    },
  });

  await assert.rejects(
    async () => client.scrape({
      urls: ['https://example.com'],
      target: 'extension',
    }),
    /Unknown tool: scrape/i,
  );
});

test('scrape in extension mode reports cloud selection when backend resolves scrape alias to cloud_scrape', async () => {
  const client = new RtrvrClient({
    apiKey: 'rtrvr_test_key',
    cloudBaseUrl: 'https://api.test.rtrvr.ai',
    mcpBaseUrl: 'https://mcp.test.rtrvr.ai',
    fetchImpl: async (url, init) => {
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      if (String(url) !== 'https://mcp.test.rtrvr.ai') {
        throw new Error(`Unexpected URL ${String(url)}`);
      }
      if (body?.tool !== 'scrape') {
        throw new Error(`Unexpected tool call ${body?.tool || 'unknown'}`);
      }
      return jsonResponse({
        success: true,
        data: {
          tabs: [{ url: 'https://example.com' }],
        },
        metadata: {
          tool: 'cloud_scrape',
        },
      });
    },
  });

  const result = await client.scrape({
    urls: ['https://example.com'],
    target: 'extension',
  });

  assert.equal(result.metadata.selectedMode, 'cloud');
  assert.equal(result.metadata.fallbackApplied, true);
  assert.match(result.metadata.fallbackReason || '', /cloud_scrape/i);
});

test('scrape with explicit deviceId in auto mode requires extension session and does not silently use cloud', async () => {
  const calls = [];

  const client = new RtrvrClient({
    apiKey: 'rtrvr_test_key',
    cloudBaseUrl: 'https://api.test.rtrvr.ai',
    mcpBaseUrl: 'https://mcp.test.rtrvr.ai',
    defaultTarget: 'auto',
    preferExtensionByDefault: false,
    fetchImpl: async (url, init) => {
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url: String(url), body });

      if (String(url) !== 'https://mcp.test.rtrvr.ai') {
        throw new Error(`Unexpected URL ${String(url)}`);
      }

      if (body?.tool !== 'scrape') {
        throw new Error(`Unexpected tool call ${body?.tool || 'unknown'}`);
      }

      // Simulate backend aliasing to cloud_scrape despite explicit local device requirement.
      return jsonResponse({
        success: true,
        data: {
          tabs: [{ url: 'https://example.com' }],
        },
        metadata: {
          tool: 'cloud_scrape',
        },
      });
    },
  });

  await assert.rejects(
    async () => client.scrape({
      urls: ['https://example.com'],
      deviceId: 'device-42',
      target: 'auto',
    }),
    /local browser session is required/i,
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.tool, 'scrape');
  assert.equal(calls[0].body.deviceId, 'device-42');
});

test('retries transient cloud failures and surfaces attempt metadata', async () => {
  let attempts = 0;

  const client = new RtrvrClient({
    apiKey: 'rtrvr_test_key',
    cloudBaseUrl: 'https://api.test.rtrvr.ai',
    mcpBaseUrl: 'https://mcp.test.rtrvr.ai',
    retryPolicy: {
      maxAttempts: 3,
      baseDelayMs: 1,
      maxDelayMs: 2,
    },
    fetchImpl: async (url) => {
      if (String(url) !== 'https://api.test.rtrvr.ai/agent') {
        throw new Error(`Unexpected URL ${String(url)}`);
      }

      attempts += 1;
      if (attempts < 3) {
        return jsonResponse({ error: { message: 'transient' } }, 503);
      }

      return jsonResponse({ ok: true });
    },
  });

  const result = await client.run({
    input: 'retry test',
    target: 'cloud',
  });

  assert.equal(attempts, 3);
  assert.equal(result.metadata.selectedMode, 'cloud');
  assert.equal(result.metadata.attempt, 3);
});
