import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';

const execFileAsync = promisify(execFile);
const testDir = path.dirname(fileURLToPath(import.meta.url));
const cliPath = path.resolve(testDir, '../dist/index.js');

async function runCli(args, options = {}) {
  const { env = {}, input } = options;
  return execFileAsync('node', [cliPath, ...args], {
    env: {
      ...process.env,
      // Isolate tests from host machine auth/config
      RTRVR_CONFIG_DIR: env.RTRVR_CONFIG_DIR ?? path.join(os.tmpdir(), 'rtrvr-cli-test-config-' + process.pid),
      RTRVR_AUTH_TOKEN: '',
      RTRVR_API_KEY: '',
      RTRVR_KEYCHAIN_SERVICE: 'rtrvr-cli-test-noop',
      RTRVR_KEYCHAIN_ACCOUNT: 'test-noop',
      ...env,
    },
    input,
  });
}

test('help shows core commands', async () => {
  const { stdout } = await runCli(['--help']);
  assert.match(stdout, /run \[options\]/i);
  assert.match(stdout, /agent \[options\]/i);
  assert.match(stdout, /scrape \[options\]/i);
  assert.match(stdout, /skills/i);
});

test('legacy root-level raw shortcut command is removed', async () => {
  await assert.rejects(
    async () => runCli(['tool', 'planner']),
    /unknown command.*tool/i,
  );
});

test('raw tool command remains available under namespace', async () => {
  await assert.rejects(
    async () => runCli(['raw', 'tool', 'planner']),
    /No auth token configured/i,
  );
});

test('legacy target alias command is removed', async () => {
  await assert.rejects(
    async () => runCli(['target', 'get']),
    /unknown command.*target/i,
  );
});

test('skills templates json includes agent-api-first', async () => {
  const { stdout } = await runCli(['skills', 'templates', '--json']);
  const parsed = JSON.parse(stdout);
  assert.ok(Array.isArray(parsed));
  assert.ok(parsed.some((item) => item.id === 'agent-api-first'));
});

test('run rejects conflicting positional input and --input', async () => {
  await assert.rejects(
    async () => runCli(['run', 'positional text', '--input', 'inline text']),
    /Provide only one input source/i,
  );
});

test('run accepts --input-file and fails auth after parsing input', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rtrvr-cli-test-'));
  const inputPath = path.join(dir, 'input.txt');
  await writeFile(inputPath, 'hello from file\n', 'utf8');

  await assert.rejects(
    async () => runCli(['run', '--input-file', inputPath]),
    /No auth token configured/i,
  );
});

test('run rejects conflicting --cloud and --extension flags', async () => {
  await assert.rejects(
    async () => runCli(['run', '--input', 'hi', '--cloud', '--extension']),
    /Conflicting target flags --cloud and --extension/i,
  );
});

test('run accepts --cloud shortcut and reaches auth gate', async () => {
  await assert.rejects(
    async () => runCli(['run', '--input', 'hi', '--cloud']),
    /No auth token configured/i,
  );
});
