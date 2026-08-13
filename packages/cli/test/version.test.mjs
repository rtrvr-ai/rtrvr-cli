import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import test from 'node:test';

const execFileAsync = promisify(execFile);

test('reported CLI version matches the published package manifest', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const { stdout, stderr } = await execFileAsync(process.execPath, [
    new URL('../dist/index.js', import.meta.url).pathname,
    '--version',
  ]);

  assert.equal(stderr, '');
  assert.equal(stdout.trim(), manifest.version);
});
