// 对真实提供者验证固定结果集；不把两遍相符当成来源在某一瞬间的原子事务。
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WindowsComputer } from '../src/windows.js';
import { resolveHostConfig } from '../src/config.js';
import { flattenAccessibilityTree } from '../src/semantics.js';
import { createManagedRunner } from './win32-runner.mjs';

if (process.platform !== 'win32') throw new Error('This snapshot fixture requires Windows');
// 新检出也能记录度量，不依赖开发机器上已经存在的本地检查点目录。
await mkdir(new URL('../.local/', import.meta.url), { recursive: true });
const directory = await mkdtemp(join(tmpdir(), 'dsh-snapshot-fixture-'));
const runner = await createManagedRunner();
const computer = new WindowsComputer(runner, { ...resolveHostConfig({}), semanticWorkerCount: 1 });
const signal = new AbortController().signal;
const owner = 'frozen-snapshot-test';
const samples = [];
let child;
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
async function gac(name) {
  const root = join(process.env.WINDIR ?? 'C:\\Windows', 'Microsoft.NET', 'assembly', 'GAC_MSIL', name);
  return (await readdir(root)).map((version) => join(root, version, `${name}.dll`)).find(existsSync);
}
let hwnd, nextLine;
async function command(value) { child.stdin.write(`${value}\n`); return nextLine(); }
async function snapshot(backend = 'uia', options = {}) {
  const started = performance.now();
  let tree = await computer.accessibilitySnapshot(hwnd, signal, { backend, owner, maxNodes: 333, maxDepth: 20, ...options });
  let attempts = 0;
  let nativeCalls = tree.acquisition.native_calls;
  while (tree.acquisition.consistency.status !== 'frozen') {
    assert.equal(flattenAccessibilityTree(tree).filter((row) => row.element_id).length, 0, 'unvalidated capture publishes no elements');
    assert.ok(tree.acquisition.next_cursor); assert.equal(tree.acquisition.coverage.status, 'unknown');
    assert.ok(++attempts < 6, 'capture resumes within bounded attempts');
    tree = await computer.accessibilitySnapshot(hwnd, signal, { backend, owner, cursor: tree.acquisition.next_cursor, workerGeneration: tree.acquisition.worker_generation, maxNodes: 333 });
    nativeCalls += tree.acquisition.native_calls;
  }
  samples.push({ backend, first_page_ms: Math.round(performance.now() - started), tool_calls: attempts + 1, consistency: tree.acquisition.consistency, native_calls: nativeCalls });
  return tree;
}
async function collectPages(tree, backend) {
  const first = tree.acquisition; const rows = flattenAccessibilityTree(tree).filter((row) => row.element_id);
  let pages = 1;
  while (tree.acquisition.next_cursor) {
    tree = await computer.accessibilitySnapshot(hwnd, signal, { backend, owner, maxNodes: 333,
      cursor: tree.acquisition.next_cursor, workerGeneration: tree.acquisition.worker_generation });
    assert.equal(tree.acquisition.result_id, first.result_id);
    assert.equal(tree.acquisition.consistency.sha256, first.consistency.sha256);
    assert.equal(tree.acquisition.consistency.status, 'frozen');
    assert.equal(tree.acquisition.native_calls, 0, 'frozen page must not call the provider');
    assert.equal(tree.acquisition.visited_nodes, 0); assert.equal(tree.acquisition.validated_nodes, 0);
    rows.push(...flattenAccessibilityTree(tree).filter((row) => row.element_id)); pages++;
  }
  assert.equal(new Set(rows.map((row) => row.element_id)).size, rows.length, 'every captured identity appears exactly once');
  assert.equal(tree.acquisition.coverage.status, 'complete');
  return { rows, pages };
}
async function raw(cursor, backend = 'uia', query) {
  return computer.semantics.call({ kind: 'acquire', backend, consistency: 'snapshot', hwnd, owner,
    maxNodes: 17, maxDepth: 2, maxBytes: 1000000, cursor: cursor?.next_cursor,
    workerGeneration: cursor?.worker_generation, ...(query ? { query } : {}) }, signal);
}
async function changedCapture(change, backend = 'uia', query) {
  let page = await raw(undefined, backend, query);
  page = await raw(page, backend);
  assert.equal(page.elements.length, 0); assert.ok(page.next_cursor);
  // 改已读取且在第八个锚点之外的节点；不能靠首次/小前缀检查偶然通过。
  assert.equal(await command(change), change.startsWith('rename') ? 'renamed' : 'mutated');
  let failed;
  for (let attempt = 0; attempt < 80; attempt++) {
    const previous = page;
    try { page = await raw(page, backend); }
    catch (error) { failed = previous; assert.match(error.message, /snapshot_changed|cursor_stale/); break; }
    assert.equal(page.elements.length, 0, 'changed generation must never publish before validation');
  }
  assert.ok(failed, `${change} invalidates unpublished capture`);
  await assert.rejects(() => raw(failed, backend), /cursor_stale/, 'failed generation is discarded');
}
try {
  const compiler = join(process.env.WINDIR ?? 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
  const executable = join(directory, 'fixture.exe');
  const refs = await Promise.all(['UIAutomationClient', 'UIAutomationTypes', 'UIAutomationProvider', 'WindowsBase', 'Accessibility'].map(gac));
  await runner.run([compiler, '/nologo', '/noconfig', '/target:exe', `/out:${executable}`,
    '/r:System.dll', '/r:System.Core.dll', '/r:System.Windows.Forms.dll', '/r:System.Drawing.dll',
    ...refs.map((path) => `/r:${path}`), fileURLToPath(new URL('./windows-large-tree-fixture.cs', import.meta.url))]);
  child = runner.start([executable]); nextLine = lineReader(child.stdout); hwnd = await nextLine(); assert.match(hwnd, /^\d+$/);

  const first = await snapshot();
  assert.equal(first.acquisition.consistency.source_atomic, false);
  assert.match(first.acquisition.consistency.sha256, /^[0-9a-f]{64}$/);
  assert.equal(await command('rename:9999:Renamed tail'), 'renamed');
  for (const change of ['reorder_silent', 'insert_silent', 'remove_silent']) assert.equal(await command(change), 'mutated');
  assert.equal(await command('reset_stats'), 'stats-reset');
  const uia = await collectPages(first, 'uia');
  assert.ok(uia.rows.length >= 10013);
  const tail = uia.rows.find((row) => row.name === 'Item 9999'); assert.ok(tail, 'late page retains captured name');
  assert.deepEqual(JSON.parse(await command('stats')), { property_reads: 0, pattern_reads: 0, navigations: 0, runtime_ids: 0 });
  await assert.rejects(() => computer.performAccessibility({ kind: 'invoke', owner, element: tail }, signal), /stale_target/, 'frozen data cannot silently authorize the renamed target');

  const legacyFirst = await snapshot('msaa');
  assert.equal(await command('rename_legacy:9999:Renamed legacy tail'), 'renamed');
  assert.equal(await command('reorder_legacy_silent'), 'mutated');
  const msaa = await collectPages(legacyFirst, 'msaa');
  assert.equal(msaa.rows.length, 10001); assert.ok(msaa.rows.find((row) => row.name === 'Legacy item 9999'));

  assert.equal(await command('resize:160'), 'resized');
  await changedCapture('rename:12:First silent rename');
  await changedCapture('rename_event:12:Event rename');
  await changedCapture('reorder_silent');
  // 第24个节点须先进入采集日志，再删除/插入，才能验证越过前缀的改变。
  let prefix = await raw(); prefix = await raw(prefix);
  assert.equal(await command('insert_silent'), 'mutated');
  let invalidated = false;
  for (let attempt = 0; attempt < 80; attempt++) {
    try { prefix = await raw(prefix); }
    catch (error) { assert.match(error.message, /snapshot_changed/); invalidated = true; break; }
  }
  assert.ok(invalidated);
  await changedCapture('remove_silent');
  await changedCapture('rename_legacy:12:Silent legacy rename', 'msaa');
  await changedCapture('reorder_legacy_silent', 'msaa');
  await changedCapture('rename:12:Now matches', 'uia', { name: 'Now matches', match: 'exact', includeOffscreen: true });

  const updated = await snapshot('uia', { query: { name: 'Now matches', match: 'exact', includeOffscreen: true } });
  assert.equal(updated.acquisition.elements.length, 1); assert.equal(updated.acquisition.elements[0].name, 'Now matches');
  const bytePage = await computer.semantics.call({ kind: 'acquire', backend: 'uia', consistency: 'snapshot', hwnd, owner,
    maxNodes: 20000, maxDepth: 2, maxBytes: 4096 }, signal);
  assert.equal(bytePage.consistency.status, 'frozen'); assert.ok(bytePage.elements.length > 0 && bytePage.next_cursor);
  assert.ok(Buffer.byteLength(JSON.stringify(bytePage)) <= 4096, 'fixed-page byte budget includes consistency metadata');
  console.log(JSON.stringify({ uia_nodes: uia.rows.length, uia_pages: uia.pages, msaa_nodes: msaa.rows.length, msaa_pages: msaa.pages,
    fixed_pages: 'passed', silent_changes: 'passed', unpublished_changes: 'passed', query_misses_validated: 'passed', source_atomic: false, samples }, null, 2));
} finally {
  await writeFile(new URL('../.local/semantic-snapshot-metrics.json', import.meta.url), JSON.stringify(samples, null, 2));
  await computer.dispose();
  if (child) { child.terminate(); await child.waitForExit(AbortSignal.timeout(3000)); }
  await runner.dispose(); await rm(directory, { recursive: true, force: true });
}
