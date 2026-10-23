import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import http from 'node:http';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
const execute = promisify(execFile);
const cli = new URL('../dist/index.js', import.meta.url).pathname;
const json = (res, value, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
const frame = (event, data, id) => `event: ${event}\n${id ? `id: ${id}\n` : ''}data: ${JSON.stringify(data)}\n\n`;
async function fake(t, handler) {
  const server = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    await handler(req, res, raw ? JSON.parse(raw) : undefined);
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const cfg = await mkdtemp(path.join(process.env.RTRVR_CONFIG_DIR ?? os.tmpdir(), 'cloud-test-'));
  await writeFile(path.join(cfg, 'config.json'), JSON.stringify({ retryMaxAttempts: 3, retryBaseDelayMs: 25, authStorage: 'config' }));
  return { base, env: { ...process.env, RTRVR_CONFIG_DIR: cfg, RTRVR_API_KEY: 'rtrvr_cli_fake', RTRVR_AUTH_TOKEN: '', RTRVR_CLOUD_BASE_URL: base, RTRVR_MCP_BASE_URL: `${base}/mcp`, RTRVR_CONTROL_BASE_URL: `${base}/ctl` } };
}
for (const cloud of ['production', 'v3']) {
  for (const command of ['run', 'agent', 'scrape']) {
    for (const stream of [false, true]) {
      test(`${cloud} ${command} ${stream ? 'stream' : 'no-stream'} retries one paid admission`, async t => {
        const admissions = new Set(); let posts = 0;
        const server = await fake(t, async (req, res, body) => {
          if (req.method === 'POST') {
            posts++;
            assert.equal(req.headers['prefer'], 'respond-async');
            assert.equal(req.headers['idempotency-key'], body.trajectoryId);
            assert.ok(body.trajectoryId);
            admissions.add(req.headers['idempotency-key'] ?? `paid-${posts}`);
            if (posts === 1) return json(res, { message: 'lost reply after admission' }, command === 'scrape' ? 503 : 500);
            if (cloud === 'production') return json(res, { status: 'success', output: ['complete final'] });
            return json(res, { trajectoryId: body.trajectoryId, statusUrl: `/agent/${body.trajectoryId}` }, 202);
          }
          if (req.url.includes('/events')) {
            res.writeHead(200, { 'content-type': 'text/event-stream' });
            return res.end(frame('workflow_complete', { data: { status: 'success', output: ['preview'] } }, '1'));
          }
          return json(res, { status: 'success', output: ['complete final'] });
        });
        const args = [command, '--cloud', '--json'];
        if (command !== 'scrape') args.push('task');
        args.push('-u', 'http://example.test'); if (!stream) args.push('--no-stream');
        const result = await execute(process.execPath, [cli, ...args], { env: server.env, timeout: 8000 });
        assert.equal(posts, 2); assert.equal(admissions.size, 1);
        assert.deepEqual(JSON.parse(result.stdout).data.output, ['complete final']);
      });
    }
  }
}

test('CLI dropped stream resumes every durable event without posting another run', async t => {
  let posts = 0, streams = 0;
  const server = await fake(t, async (req, res, body) => {
    if (req.method === 'POST') { posts++; return json(res, { trajectoryId: body.trajectoryId }, 202); }
    if (req.url.includes('/events')) {
      streams++; const since = new URL(req.url, 'http://localhost').searchParams.get('since');
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      if (streams === 1) { assert.equal(since, '0'); return res.end(frame('tool_start', { sequence: 1, data: { toolName: 'browser.open' } }, '1')); }
      if (streams === 2) { assert.equal(since, '1'); res.write(frame('tool_complete', { sequence: 2, data: { toolName: 'browser.open' } }, '2')); setTimeout(() => res.destroy(), 20); return; }
      assert.equal(since, '2'); return res.end(frame('workflow_complete', { data: { status: 'success' } }, '3'));
    }
    json(res, { status: 'success', output: ['resumed final'] });
  });
  const result = await execute(process.execPath, [cli, 'run', '--cloud', '--json', 'task'], { env: server.env, timeout: 8000 });
  const ids = result.stderr.trim().split('\n').filter(Boolean).map(line => JSON.parse(line).stream.id);
  assert.deepEqual(ids, ['1', '2', '3']); assert.equal(posts, 1); assert.equal(streams, 3);
  assert.deepEqual(JSON.parse(result.stdout).data.output, ['resumed final']);
});

for (const command of ['run', 'scrape']) {
  test(`Ctrl-C ${command} waits for cancellation acknowledgement`, async t => {
    let child; let acknowledged = false; let executionId;
    const server = await fake(t, async (req, res, body) => {
      if (req.url.endsWith('/cancel')) {
        assert.equal(req.url, command === 'scrape' ? '/scrape/cancel' : '/agent/cancel');
        assert.equal(body.trajectoryId, executionId);
        await new Promise(resolve => setTimeout(resolve, 50)); acknowledged = true; return json(res, { ok: true });
      }
      if (req.method === 'POST') { executionId = body.trajectoryId; return json(res, { trajectoryId: executionId }, 202); }
      res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(': keepalive\n\n');
      child.kill('SIGINT');
    });
    const args = [cli, command, '--cloud', '--no-stream', '--json']; if (command === 'run') args.push('task'); else args.push('-u', 'http://example.test');
    child = spawn(process.execPath, args, { env: server.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 8000); t.after(() => clearTimeout(timer));
    const [code, signal] = await new Promise(resolve => child.once('exit', (...result) => resolve(result)));
    assert.equal(signal, null); assert.equal(code, 130); assert.equal(acknowledged, true); assert.ok(stderr.includes('Ctrl-C'));
  });
}

for (const status of ['error', 'failed', 'cancelled', 'partial']) {
  test(`CLI final ${status} exits nonzero and preserves output`, async t => {
    const server = await fake(t, async (_req, res) => json(res, { status, ...(status === 'partial' ? { run: { state: 'failed' } } : {}), output: ['retained partial answer'] }));
    await assert.rejects(execute(process.execPath, [cli, 'run', '--cloud', '--no-stream', '--json', 'task'], { env: server.env, timeout: 8000 }), error => {
      assert.equal(error.code, 1); assert.deepEqual(JSON.parse(error.stdout).data.output, ['retained partial answer']); return true;
    });
  });
}
