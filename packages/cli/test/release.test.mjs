import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
for (const file of ['../../../package.json', '../../core/package.json', '../../sdk/package.json', '../package.json']) {
  test(`0.3.0 release version: ${file}`, async () => {
    const manifest = JSON.parse(await readFile(new URL(file, import.meta.url), 'utf8'));
    assert.equal(manifest.version, '0.3.0');
  });
}
