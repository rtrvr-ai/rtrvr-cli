import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import test from 'node:test';
import { Writable } from 'node:stream';
const output = await import(process.env.RTRVR_TEST_OUTPUT_URL ?? './.dist/output.js');

test('progress output waits for a slow writable instead of queuing more events', async t => {
  assert.equal(typeof output.writeProgress, 'function');
  let complete;
  const sink = new Writable({ highWaterMark: 1, write(_chunk, _encoding, callback) { complete = callback; } });
  t.after(() => sink.destroy());
  const pending = output.writeProgress(sink, 'progress', new AbortController().signal);
  let settled = false; Promise.resolve(pending).then(() => { settled = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false); assert.equal(sink.writableLength, 8);
  complete(); await pending; assert.equal(sink.listenerCount('drain'), 0);
});

test('aborting a stalled progress writable removes its drain listener', async t => {
  assert.equal(typeof output.writeProgress, 'function');
  const controller = new AbortController();
  const sink = new Writable({ highWaterMark: 1, write() {} }); t.after(() => sink.destroy());
  const pending = output.writeProgress(sink, 'progress', controller.signal);
  controller.abort();
  await assert.rejects(pending, error => error.code === 'ABORT_ERR');
  assert.equal(sink.listenerCount('drain'), 0);
});

test('a writable that accepts progress needs no pending drain wait', () => {
  assert.equal(typeof output.writeProgress, 'function');
  let value;
  const sink = new Writable({ write(chunk, _encoding, callback) { value = chunk.toString(); callback(); } });
  assert.equal(output.writeProgress(sink, 'progress', new AbortController().signal), undefined);
  assert.equal(value, 'progress'); assert.equal(sink.listenerCount('drain'), 0); sink.destroy();
});

test('an interrupted command exits even when stdout is blocked', async t => {
  assert.equal(typeof output.exitAfterAbort, 'function');
  const moduleUrl = new URL('./.dist/output.js', import.meta.url).href;
  const script = `import { exitAfterAbort } from ${JSON.stringify(moduleUrl)}; process.stdout.write('x'.repeat(4 * 1024 * 1024)); exitAfterAbort(130);`;
  // The reporter preload makes pipes synchronous. This child is an application, not a test reporter.
  const applicationEnv = { ...process.env };
  delete applicationEnv.NODE_OPTIONS;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { env: applicationEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stderr.resume();
  const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
  t.after(() => { clearTimeout(timer); child.stdout.destroy(); child.stderr.destroy(); });
  const [code, signal] = await new Promise(resolve => child.once('exit', (...result) => resolve(result)));
  assert.equal(signal, null); assert.equal(code, 130);
});
