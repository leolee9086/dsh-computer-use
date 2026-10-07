// 验证真实提供者的静默往返变化：两遍相符不能替代源事务/可靠全树版本。
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WindowsComputer } from '../src/windows.js';
import { resolveHostConfig } from '../src/config.js';
import { createManagedRunner } from './win32-runner.mjs';

if (process.platform !== 'win32') throw new Error('This source-consistency fixture requires Windows');
const directory = await mkdtemp(join(tmpdir(), 'dsh-source-consistency-'));
const runner = await createManagedRunner();
const computer = new WindowsComputer(runner, { ...resolveHostConfig({}), semanticWorkerCount: 1 });
const signal = new AbortController().signal;
let child;
function lineReader(stream) {
  let buffer = ''; const queued = []; let pending;
  stream.setEncoding('utf8');
  stream.on('data', (text) => {
    buffer += text; let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end).trim(); buffer = buffer.slice(end + 1);
      if (pending) { const deliver = pending; pending = undefined; deliver(line); } else queued.push(line);
    }
  });
  return () => queued.length ? Promise.resolve(queued.shift()) : new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending = undefined; reject(new Error('source-consistency command timeout')); }, 10000);
    pending = (line) => { clearTimeout(timer); resolve(line); };
  });
}
async function gac(name) {
  const root = join(process.env.WINDIR ?? 'C:\\Windows', 'Microsoft.NET', 'assembly', 'GAC_MSIL', name);
  return (await readdir(root)).map((version) => join(root, version, `${name}.dll`)).find(existsSync);
}
function validSourcePair(source) {
  assert.ok((source.left === 'Pair left active') !== (source.right === 'Pair right active'),
    'a locked source export has exactly one active member');
  assert.match(source.source_instance, /^[0-9a-f]{32}$/); assert.match(source.source_epoch, /^\d+$/);
}
try {
  const compiler = join(process.env.WINDIR ?? 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
  const executable = join(directory, 'fixture.exe');
  const refs = await Promise.all(['UIAutomationClient', 'UIAutomationTypes', 'UIAutomationProvider', 'WindowsBase', 'Accessibility'].map(gac));
  await runner.run([compiler, '/nologo', '/noconfig', '/target:exe', `/out:${executable}`,
    '/r:System.dll', '/r:System.Core.dll', '/r:System.Windows.Forms.dll', '/r:System.Drawing.dll',
    ...refs.map((path) => `/r:${path}`), fileURLToPath(new URL('./windows-large-tree-fixture.cs', import.meta.url))]);
  child = runner.start([executable]); const nextLine = lineReader(child.stdout);
  const hwnd = await nextLine(); assert.match(hwnd, /^\d+$/);
  const command = async (value) => { child.stdin.write(`${value}\n`); return nextLine(); };
  assert.equal(await command('resize:32'), 'resized');
  for (const backend of ['uia', 'msaa']) {
    assert.equal(await command('pair_enable'), 'pair-enabled');
    const before = JSON.parse(await command('pair_export')); validSourcePair(before);
    const owner = `source-consistency-${backend}`;
    let page = await computer.semantics.call({ kind: 'acquire', backend, consistency: 'snapshot', hwnd, owner,
      maxNodes: 7, maxResults: 1, maxDepth: 20, maxBytes: 1000000,
      query: { name: 'Pair', match: 'contains', includeOffscreen: true } }, signal);
    let progressCalls = 0; let validated = page.validated_nodes;
    while (page.consistency.status !== 'frozen') {
      assert.equal(page.elements.length, 0); assert.equal(page.consistency.source_atomic, false);
      assert.equal(page.coverage.status, 'unknown'); assert.ok(page.next_cursor);
      assert.ok(++progressCalls < 32, 'small source completes within bounded capture segments');
      page = await computer.semantics.call({ kind: 'acquire', backend, consistency: 'snapshot', hwnd, owner,
        maxNodes: 7, maxResults: 1, maxBytes: 1000000, cursor: page.next_cursor,
        workerGeneration: page.worker_generation }, signal);
      validated += page.validated_nodes;
    }
    assert.ok(validated >= 33, 'every covered node was reread before publication');
    assert.equal(page.elements.length, 1); assert.ok(page.next_cursor); assert.equal(page.consistency.source_atomic, false);
    const resultId = page.result_id; const digest = page.consistency.sha256;
    const first = page.elements[0];
    const after = JSON.parse(await command('pair_export')); validSourcePair(after);
    assert.ok(after.left_reads >= 2 && after.right_reads >= 2);
    assert.equal(after.source_instance, before.source_instance);
    assert.ok(BigInt(after.source_epoch) > BigInt(before.source_epoch), 'reliable source version detects the silent round trips');
    // 在续页前再改变源状态；交付的第二行必须仍来自同一封存结果。
    assert.equal(await command('pair_step'), 'pair-stepped');
    page = await computer.semantics.call({ kind: 'acquire', backend, consistency: 'snapshot', hwnd, owner,
      maxNodes: 7, maxResults: 1, maxBytes: 1000000, cursor: page.next_cursor,
      workerGeneration: page.worker_generation }, signal);
    assert.equal(page.result_id, resultId); assert.equal(page.consistency.sha256, digest);
    assert.equal(page.consistency.source_atomic, false); assert.equal(page.native_calls, 0);
    assert.equal(page.coverage.status, 'complete'); assert.equal(page.next_cursor, null);
    assert.deepEqual([first.name, page.elements[0].name], ['Pair left active', 'Pair right active'],
      'matching passes accepted a pair that the source invariant never permits together');
    const exported = JSON.parse(await command('pair_export')); validSourcePair(exported);
    console.log(JSON.stringify({ backend, agreeing_passes: 'passed', impossible_source_pair: 'reproduced',
      result_pagination: 'immutable', source_atomic: false, frozen_continuation_native_calls: page.native_calls,
      covered_nodes: page.consistency.captured_nodes, source_epoch_before: before.source_epoch,
      source_epoch_after: after.source_epoch, cooperative_version_guard: 'would_reject',
      locked_pair_export: 'valid', production_atomic_adapter: 'unimplemented' }));
  }
} finally {
  await computer.dispose();
  if (child) { child.terminate(); await child.waitForExit(AbortSignal.timeout(3000)); }
  await runner.dispose(); await rm(directory, { recursive: true, force: true });
}
