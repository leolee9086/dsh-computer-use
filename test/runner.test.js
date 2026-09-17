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

function runnerRecordingStdin(seen) {
  return new ManagedRunner({
    subprocess: {
      spawn(spec) {
        seen.push(spec.stdio.stdin);
        return {
          done: Promise.resolve({ exitCode: 0, signal: null }),
          collected: {
            stdout: { readFrom() { return { text: '{}', nextOffset: 2, lossy: false }; } },
            stderr: { readFrom() { return { text: '', nextOffset: 0, lossy: false }; } },
          },
        };
      },
    },
  }, config);
}

// 批式 stdin 必须用 { data }：DSH 的 SubprocessStdinMode 是
// 'ignore' | 'pipe' | { data: string }，实现执行 stdin.end(stdinMode.data)。
// 写成 { text } 时 data 为 undefined，管道立刻关闭、子进程读到空输入，
// 于是原生 helper 的 payload（截图 region / display_id / scale）被静默丢弃。
test('ManagedRunner sends batch stdin as { data } and defaults to ignore', async () => {
  const seen = [];
  const runner = runnerRecordingStdin(seen);

  await runner.runJson(['helper'], { stdin: 'eyJtYXhEaW1lbnNpb24iOjE5MjB9' });
  assert.deepEqual(seen[0], { data: 'eyJtYXhEaW1lbnNpb24iOjE5MjB9' });

  await runner.runJson(['helper']);
  assert.equal(seen[1], 'ignore');
});
