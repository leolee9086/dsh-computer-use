import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { runElectronSmoke } from '../scripts/electron-smoke-runner.mjs';

// 用真实子进程复现提前退出和晚到异常，避免只stub spawnSync来重复实现。
test('native smoke runner requires completion even when the outer process reports exit zero', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-smoke-completion-'));
  const options = { expectElectron: false, reportOutput: false, timeoutMs: 10000 };
  try {
    const completed = join(directory, 'completed.mjs');
    await writeFile(completed, 'await Promise.resolve(); console.log("owned test finished");\n');
    assert.equal(runElectronSmoke(process.execPath, completed, options).status, 0);
    const early = join(directory, 'early.mjs');
    await writeFile(early, 'process.exit(0);\n');
    assert.throws(() => runElectronSmoke(process.execPath, early, options), /without its completion marker/);
    const loadFailure = join(directory, 'load-failure.mjs');
    await writeFile(loadFailure, 'await import("./missing-owned-fixture.mjs");\n');
    assert.throws(() => runElectronSmoke(process.execPath, loadFailure, options), /failed in Electron/);
    const late = join(directory, 'late.mjs');
    await writeFile(late, 'process.on("uncaughtException", () => { process.exitCode = 0; }); setTimeout(() => { throw new Error("owned late failure"); }, 5);\n');
    assert.throws(() => runElectronSmoke(process.execPath, late, options), /runtime failure despite exit 0/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
