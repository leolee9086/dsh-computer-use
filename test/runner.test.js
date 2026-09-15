import assert from 'node:assert/strict';
import test from 'node:test';
import { ManagedRunner } from '../src/runner.js';

const config = Object.freeze({
  commandTimeoutMs: 1_000,
  graceMs: 100,
  maxAccessibilityBytes: 1_024,
});

function runnerWithOutput({ stdout, stdoutLossy = false, stderr = '' }) {
  return new ManagedRunner({
    subprocess: {
      spawn() {
        return {
          done: Promise.resolve({ exitCode: 0, signal: null }),
          collected: {
            stdout: { readFrom() { return { text: stdout, nextOffset: stdout.length, lossy: stdoutLossy }; } },
            stderr: { readFrom() { return { text: stderr, nextOffset: stderr.length, lossy: false }; } },
          },
        };
      },
    },
  }, config);
}

test('ManagedRunner parses complete helper JSON', async () => {
  const runner = runnerWithOutput({ stdout: '{"ok":true}' });
  assert.deepEqual(await runner.runJson(['helper']), { ok: true });
});

test('ManagedRunner rejects a lossy helper response before JSON parsing', async () => {
  const runner = runnerWithOutput({ stdout: '{"ok":true}', stdoutLossy: true });
  await assert.rejects(() => runner.runJson(['helper'], { stdoutMaxBytes: 8 }), /exceeded its 8-byte stdout limit/);
});
