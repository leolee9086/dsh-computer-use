// 真实提供者在采集内改变已读的查询未命中项，验证重采及按需缓存，不伪造COM。
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WindowsComputer } from '../src/windows.js';
import { resolveHostConfig } from '../src/config.js';
import { createManagedRunner } from './win32-runner.mjs';

if (process.platform !== 'win32') throw new Error('This recovery fixture requires Windows');
const directory = await mkdtemp(join(tmpdir(), 'dsh-recovery-fixture-'));
const runner = await createManagedRunner();
const computer = new WindowsComputer(runner, { ...resolveHostConfig({}), semanticWorkerCount: 1 });
const owner = 'semantic-recovery-fixture';
const samples = [];
let child, hwnd, nextLine;
function lineReader(stream) {
  let buffer = ''; const waiting = []; const queued = [];
  stream.setEncoding('utf8');
  stream.on('data', (text) => {
    buffer += text; let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end).trim(); buffer = buffer.slice(end + 1);
      if (waiting.length) waiting.shift()(line); else queued.push(line);
    }
  });
  return () => queued.length ? Promise.resolve(queued.shift()) : Promise.race([
    new Promise((resolve) => waiting.push(resolve)),
    new Promise((_resolve, reject) => { const timer = setTimeout(() => reject(new Error('fixture command timeout')), 10000); timer.unref(); }),
  ]);
}
async function command(value) { child.stdin.write(`${value}\n`); return nextLine(); }
async function gac(name) {
  const root = join(process.env.WINDIR ?? 'C:\\Windows', 'Microsoft.NET', 'assembly', 'GAC_MSIL', name);
  return (await readdir(root)).map((version) => join(root, version, `${name}.dll`)).find(existsSync);
}
async function observe(backend, query, options = {}) {
  const tree = await computer.accessibilitySnapshot(hwnd, undefined, { backend, owner, query,
    maxNodes: 32, maxDepth: 20, timeoutMs: 10000, ...options });
  assert.equal(tree.acquisition.consistency.status, 'frozen');
  assert.equal(tree.acquisition.coverage.status, 'complete');
  return tree.acquisition;
}
const query = { name: 'Mutation target', match: 'contains', includeOffscreen: true };
try {
  const compiler = join(process.env.WINDIR ?? 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
  const executable = join(directory, 'fixture.exe');
  const refs = await Promise.all(['UIAutomationClient', 'UIAutomationTypes', 'UIAutomationProvider', 'WindowsBase', 'Accessibility'].map(gac));
  await runner.run([compiler, '/nologo', '/noconfig', '/target:exe', `/out:${executable}`,
    '/r:System.dll', '/r:System.Core.dll', '/r:System.Windows.Forms.dll', '/r:System.Drawing.dll',
    ...refs.map((path) => `/r:${path}`), fileURLToPath(new URL('./windows-large-tree-fixture.cs', import.meta.url))]);
  child = runner.start([executable]); nextLine = lineReader(child.stdout);
  hwnd = await nextLine(); assert.match(hwnd, /^\d+$/);
  assert.equal(await command('resize:128'), 'resized');

  for (const backend of ['uia', 'msaa']) {
    assert.equal(await command(`mutation:${backend}:once`), 'mutation-enabled');
    const recovered = await observe(backend, query);
    assert.equal(recovered.capture_restarts, 1, 'the changed unpublished capture is discarded and retried exactly once');
    assert.deepEqual(recovered.elements.map((row) => row.name), ['Mutation target 1']);
    assert.ok(recovered.elements[0].patterns.includes('invoke'), 'matched summaries keep their supported actions');
    assert.equal(await command('mutation_stats'), 'mutations:1');

    assert.equal(await command(`mutation:${backend}:always`), 'mutation-enabled');
    const started = performance.now();
    await assert.rejects(observe(backend, query), (error) => {
      assert.equal(error.code, 'COMPUTER_SNAPSHOT_CHANGED'); assert.equal(error.executionState, 'not_started');
      assert.equal(error.observedWindow.handle, hwnd); assert.ok(error.observedWindow.processId > 0); return true;
    });
    assert.equal(await command('mutation_stats'), 'mutations:3', 'three attempts cannot become an unlimited native read loop');
    const persistentMs = Math.round(performance.now() - started);
    assert.equal(await command('mutation:disable'), 'mutation-disabled');
    const healthy = await observe(backend, query); assert.equal(healthy.capture_restarts, 0);

    // 给调用方交付采集游标后即固定代次；变化时不暗换一个新结果。
    const request = { kind: 'acquire', hwnd, backend, owner, consistency: 'snapshot', query,
      maxDepth: 20, maxNodes: 17, maxBytes: 1000000 };
    let pending = await computer.semantics.call(request);
    pending = await computer.semantics.call({ ...request, cursor: pending.next_cursor, workerGeneration: pending.worker_generation });
    assert.ok(pending.next_cursor); assert.equal(pending.elements.length, 0);
    assert.equal(await command(backend === 'uia' ? 'rename:12:Changed after cursor' : 'rename_legacy:12:Changed after cursor'), 'renamed');
    let failed;
    for (let step = 0; step < 50; step++) {
      const prior = pending;
      try { pending = await computer.accessibilitySnapshot(hwnd, undefined, { backend, owner,
        cursor: pending.next_cursor, workerGeneration: pending.worker_generation, maxNodes: 17, timeoutMs: 10000 }).then((tree) => tree.acquisition); }
      catch (error) { assert.equal(error.code, 'COMPUTER_SNAPSHOT_CHANGED'); failed = prior; break; }
      assert.equal(pending.elements.length, 0);
    }
    assert.ok(failed, 'the caller-owned capture cursor rejects a changed generation');
    await assert.rejects(computer.semantics.call({ ...request, cursor: failed.next_cursor, workerGeneration: failed.worker_generation }), /cursor_stale/);

    assert.equal(await command('reset_stats'), 'stats-reset');
    const summaryPage = await observe(backend, undefined, { maxNodes: 300 });
    const summaryStats = JSON.parse(await command('stats'));
    assert.equal(await command('reset_stats'), 'stats-reset');
    const hitName = backend === 'uia' ? 'Item 100' : 'Legacy item 100';
    const targetPage = await observe(backend, { name: hitName, match: 'exact', includeOffscreen: true });
    assert.equal(targetPage.elements.length, 1);
    const target = targetPage.elements[0]; assert.equal(target.name, hitName);
    assert.ok(target.patterns.includes('invoke')); assert.ok(target.bounds);
    const stats = JSON.parse(await command('stats'));
    assert.equal(targetPage.consistency.captured_nodes, summaryPage.consistency.captured_nodes, 'query optimization still covers and verifies every node in the scope');
    if (backend === 'uia') {
      assert.ok(stats.pattern_reads <= 72, 'only the matched summaries request pattern availability');
      assert.ok(summaryStats.pattern_reads > stats.pattern_reads * 10, 'query misses do not pay whole-summary pattern costs');
    } else assert.ok(targetPage.native_calls < summaryPage.native_calls, 'MSAA misses skip location/default-action getters');
    const before = Number((await command('count')).slice(6));
    await computer.performAccessibility({ kind: 'invoke', owner, element: target });
    assert.equal(await command('count'), `count:${before + 1}`);
    assert.equal(await command(backend === 'uia' ? 'rename:100:Renamed action target' : 'rename_legacy:100:Renamed action target'), 'renamed');
    await assert.rejects(computer.performAccessibility({ kind: 'invoke', owner, element: target }), /stale_target/);
    assert.equal(await command('count'), `count:${before + 1}`, 'a renamed target cannot execute a second action');
    samples.push({ backend, recovered_restarts: recovered.capture_restarts, persistent_attempts: 3, persistent_ms: persistentMs,
      query_covered: targetPage.consistency.captured_nodes, query_native_calls: targetPage.native_calls, query_provider_reads: stats,
      summary_covered: summaryPage.consistency.captured_nodes, summary_native_calls: summaryPage.native_calls, summary_provider_reads: summaryStats,
      fixed_cursor_rejects_change: true, actions_executed: 1 });
  }
  console.log(JSON.stringify({ recovery: 'passed', bounded_changes: 'passed', fixed_cursor: 'passed', live_action_identity: 'passed', samples }, null, 2));
} finally {
  await mkdir(new URL('../.local/', import.meta.url), { recursive: true });
  await writeFile(new URL('../.local/semantic-recovery-metrics.json', import.meta.url), JSON.stringify(samples, null, 2));
  await computer.dispose();
  if (child) { child.terminate(); await child.waitForExit(AbortSignal.timeout(3000)); }
  await runner.dispose(); await rm(directory, { recursive: true, force: true });
}
