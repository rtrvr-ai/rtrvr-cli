import assert from 'node:assert/strict';
import test from 'node:test';
const output = await import(process.env.RTRVR_TEST_OUTPUT_URL ?? './.dist/output.js');
const cases = [
  ['production error', { data: { status: 'error', output: ['partial answer'] } }, 1],
  ['v3 failed', { data: { status: 'failed' } }, 1],
  ['cancelled', { data: { status: 'cancelled' } }, 1],
  ['raw failed', { status: 'failed' }, 1],
  ['partial with failed run', { data: { status: 'partial', run: { state: 'failed' }, output: ['retained'] } }, 1],
  ['partial with cancelled run', { data: { status: 'partial', run: { state: 'cancelled' } } }, 1],
  ['terminal result failed', { data: { terminalResult: { status: 'failed' } } }, 1],
  ['success', { data: { status: 'success' } }, 0],
  ['completed', { data: { status: 'completed' } }, 0],
  ['requires input', { data: { status: 'requires_input' } }, 0],
  ['waiting user', { data: { status: 'waiting_user' } }, 0],
  ['partial result', { data: { status: 'partial', output: ['retained'] } }, 0],
  ['unrelated metadata', { metadata: { status: 'failed' }, data: { status: 'success' } }, 0],
  ['no status', { data: { output: ['retained'] } }, 0],
];
for (const [name, value, expected] of cases) test(`final run exit status: ${name}`, () => {
  const original = structuredClone(value);
  assert.equal(typeof output.finalRunExitCode, 'function');
  assert.equal(output.finalRunExitCode(value), expected);
  assert.deepEqual(value, original, 'partial output is never changed to set the exit status');
});
