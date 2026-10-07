// 本测试启动并回收自己的真实提供者窗口，不在现有工作模型上操作。
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WindowsComputer } from '../src/windows.js';
import { resolveHostConfig } from '../src/config.js';
import { flattenAccessibilityTree } from '../src/semantics.js';
import { createManagedRunner } from './win32-runner.mjs';

if (process.platform !== 'win32') throw new Error('This controlled UIA/MSAA fixture requires Windows');
const directory = await mkdtemp(join(tmpdir(), 'dsh-semantic-fixture-'));
const runner = await createManagedRunner();
const config = { ...resolveHostConfig({}), semanticWorkerCount: 1 };
const computer = new WindowsComputer(runner, config);
const fixtures = [];
const metrics = [];
const comparisons = [];
const signal = new AbortController().signal;
const owner = 'large-tree-native-test';
async function gac(name) {
  const path = join(process.env.WINDIR ?? 'C:\\Windows', 'Microsoft.NET', 'assembly', 'GAC_MSIL', name);
  const file = (await readdir(path)).map((version) => join(path, version, `${name}.dll`)).find(existsSync);
  assert.ok(file, `${name} assembly`); return file;
}
function lines(stream) {
  let buffer = ''; const waiting = []; const queued = [];
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    buffer += chunk; let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end).trim(); buffer = buffer.slice(end + 1);
      if (waiting.length > 0) waiting.shift()(line); else queued.push(line);
    }
  });
  return async () => queued.length > 0 ? queued.shift() : Promise.race([
    new Promise((resolve) => waiting.push(resolve)),
    new Promise((_resolve, reject) => { const timer = setTimeout(() => reject(new Error('fixture response timeout')), 10000); timer.unref(); }),
  ]);
}
async function fixture(executable) {
  const child = runner.start([executable]); const next = lines(child.stdout);
  fixtures.push(child);
  const hwnd = await next(); assert.match(hwnd, /^\d+$/);
  return { hwnd, pid: child.pid, async command(value) { child.stdin.write(`${value}\n`); return next(); } };
}
async function acquire(window, options) {
  const started = performance.now();
  const tree = await computer.accessibilitySnapshot(window.hwnd, signal, { owner, consistency: 'live', ...options });
  const page = tree.acquisition;
  metrics.push({ backend: page.backend, scope: options?.scope ?? 'subtree', query: options?.query,
    elapsed_ms: Math.round(performance.now() - started), native_elapsed_ms: page.elapsed_ms, host_timing: page.host_timing,
    visited: page.visited_nodes, returned: page.returned_nodes, native_calls: page.native_calls,
    bytes: Buffer.byteLength(JSON.stringify(page)), coverage: page.coverage });
  return { tree, page, rows: flattenAccessibilityTree(tree) };
}
try {
  const compiler = join(process.env.WINDIR ?? 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
  const executable = join(directory, 'fixture.exe');
  const refs = await Promise.all(['UIAutomationClient', 'UIAutomationTypes', 'UIAutomationProvider', 'WindowsBase', 'Accessibility'].map(gac));
  const compiled = await runner.run([compiler, '/nologo', '/noconfig', '/target:exe', `/out:${executable}`,
    '/r:System.dll', '/r:System.Core.dll', '/r:System.Windows.Forms.dll', '/r:System.Drawing.dll',
    ...refs.map((path) => `/r:${path}`), fileURLToPath(new URL('./windows-large-tree-fixture.cs', import.meta.url))]);
  if (compiled.trim()) console.log(compiled.trim());
  const window = await fixture(executable);
  // 同一提供者对照旧桥的有界获取；不让旧桥运行故意阻塞的场景。
  const baselineExe = join(directory, 'legacy-baseline.exe');
  await runner.run([compiler, '/nologo', '/noconfig', '/target:exe', '/main:LegacyBaseline', `/out:${baselineExe}`,
    '/r:System.dll', '/r:System.Core.dll', '/r:System.Web.Extensions.dll', '/r:Microsoft.CSharp.dll', ...refs.map((path) => `/r:${path}`),
    fileURLToPath(new URL('./windows-legacy-baseline.cs', import.meta.url)), fileURLToPath(new URL('../src/windows-uia.cs', import.meta.url))]);
  const baselineChild = runner.start([baselineExe]); fixtures.push(baselineChild);
  const baselineLine = lines(baselineChild.stdout);
  const legacyBridge = async (payload) => { baselineChild.stdin.write(`${JSON.stringify(payload)}\n`); return JSON.parse(await baselineLine()); };
  for (const mode of ['legacy_first', 'legacy_warm', 'worker_first', 'worker_warm']) {
    assert.equal(await window.command('reset_stats'), 'stats-reset');
    const started = performance.now();
    const acquired = mode.startsWith('legacy')
      ? await legacyBridge({ kind: 'accessibility', hwnd: window.hwnd, maxNodes: 300, maxDepth: 6 })
      : (await acquire(window, { backend: 'uia', maxNodes: 300, maxDepth: 6 })).tree;
    const elapsed = Math.round(performance.now() - started);
    comparisons.push({ mode, nodes: flattenAccessibilityTree(acquired).length, elapsed_ms: elapsed,
      response_bytes: Buffer.byteLength(JSON.stringify(acquired.acquisition ?? acquired)),
      host_timing: acquired.acquisition?.host_timing, provider: JSON.parse(await window.command('stats')) });
  }
  const bytePage = await computer.semantics.call({ kind: 'acquire', owner, backend: 'uia', consistency: 'live', hwnd: window.hwnd,
    maxNodes: 300, maxDepth: 6, maxBytes: 4096 }, signal);
  assert.equal(bytePage.coverage.reason, 'byte_limit');
  assert.ok(bytePage.next_cursor && bytePage.elements.length > 0);
  assert.ok(Buffer.byteLength(JSON.stringify(bytePage)) <= 4096, 'byte budget includes identities and parent IDs');
  let result = await acquire(window, { maxNodes: 137, maxDepth: 20, backend: 'uia' });
  const seen = new Set(); let tail, deep, root, count = 0, pages = 0;
  while (true) {
    pages++;
    for (const row of result.rows) {
      assert.equal(seen.has(row.element_id), false, 'continuation must not replay previous pages');
      seen.add(row.element_id); count++;
      if (row.name === 'UIA large-tree root') root = row;
      if (row.name === 'Item 9999') tail = row;
      if (row.name === 'Deep target') deep = row;
    }
    if (!result.page.next_cursor) break;
    assert.equal(result.page.coverage.status, 'partial');
    result = await acquire(window, { backend: 'uia', cursor: result.page.next_cursor, workerGeneration: result.page.worker_generation, maxNodes: 137 });
    assert.ok(pages < 500, 'bounded continuation progress');
  }
  assert.ok(count >= 10013, `${count} real UIA nodes`);
  assert.ok(tail && deep && root, 'late, deep and root targets');
  assert.equal(result.page.coverage.status, 'complete');
  assert.ok(tail.offscreen); assert.ok(tail.patterns.includes('invoke'));
  assert.equal(await window.command('reset_stats'), 'stats-reset');
  const actionAt = performance.now();
  assert.deepEqual(await computer.performAccessibility({ kind: 'invoke', element: tail, owner }, signal), { ok: true });
  comparisons.push({ mode: 'late_reference_action', elapsed_ms: Math.round(performance.now() - actionAt), provider: JSON.parse(await window.command('stats')) });
  assert.equal(await window.command('count'), 'count:1', 'offscreen Invoke is dispatched once');

  // 子树相对深度与显式虚拟化：按容器定位不实现所有项目，realize 由调用方指定。
  const located = await computer.performAccessibility({ kind: 'find_item', element: root, owner, property: 'name', value: 'Item 9999' }, signal);
  assert.equal(located.found, true); assert.ok(located.element.patterns.includes('virtualized_item'));
  await computer.performAccessibility({ kind: 'realize', element: located.element, owner }, signal);
  assert.equal(await window.command('count'), 'count:2');
  const subtree = await acquire(window, { backend: 'uia', root: deep, maxNodes: 10, maxDepth: 0 });
  assert.equal(subtree.rows[0].name, 'Deep target'); assert.equal(subtree.page.coverage.status, 'complete');

  // 精确原生条件和深度截断：结果只回命中；非命中深分支也不能报完整。
  let search = await acquire(window, { backend: 'uia', query: { name: 'Deep target', match: 'exact', includeOffscreen: true }, maxNodes: 20000, maxDepth: 6 });
  while (search.page.next_cursor) search = await acquire(window, { backend: 'uia', cursor: search.page.next_cursor, workerGeneration: search.page.worker_generation, maxNodes: 20000 });
  assert.equal(search.rows.length, 0); assert.equal(search.page.coverage.reason, 'depth_limit');
  search = await acquire(window, { backend: 'uia', query: { automationId: 'item-9999', match: 'exact', includeOffscreen: true }, maxNodes: 20000, maxDepth: 20 });
  const hits = [...search.rows];
  while (search.page.next_cursor) { search = await acquire(window, { backend: 'uia', cursor: search.page.next_cursor, workerGeneration: search.page.worker_generation, maxNodes: 20000 }); hits.push(...search.rows); }
  assert.equal(hits.length, 1); assert.equal(hits[0].name, 'Item 9999');

  let legacy = await acquire(window, { backend: 'msaa', maxNodes: 211, maxDepth: 2 });
  let legacyCount = 0; let legacyTail; const legacySeen = new Set();
  while (true) {
    for (const row of legacy.rows) { assert.ok(!legacySeen.has(row.element_id)); legacySeen.add(row.element_id); legacyCount++; if (row.name === 'Legacy item 9999') legacyTail = row; }
    if (!legacy.page.next_cursor) break;
    legacy = await acquire(window, { backend: 'msaa', cursor: legacy.page.next_cursor, workerGeneration: legacy.page.worker_generation, maxNodes: 211 });
  }
  assert.ok(legacyCount >= 10001, `${legacyCount} real MSAA nodes`); assert.ok(legacyTail);
  await computer.performAccessibility({ kind: 'invoke', element: legacyTail, owner }, signal);
  assert.equal(await window.command('count'), 'count:3');

  const legacyBefore = await acquire(window, { backend: 'msaa', maxNodes: 10 });
  assert.equal(await window.command('change_legacy'), 'legacy-changed');
  await assert.rejects(() => acquire(window, { backend: 'msaa', cursor: legacyBefore.page.next_cursor, workerGeneration: legacyBefore.page.worker_generation }), /cursor_stale/);
  await assert.rejects(() => computer.performAccessibility({ kind: 'invoke', element: legacyTail, owner }, signal), /stale_target/);

  const before = await acquire(window, { backend: 'uia', maxNodes: 10 });
  assert.equal(await window.command('change'), 'changed');
  await assert.rejects(() => acquire(window, { backend: 'uia', cursor: before.page.next_cursor, workerGeneration: before.page.worker_generation }), /cursor_stale/);
  await assert.rejects(() => computer.performAccessibility({ kind: 'invoke', element: tail, owner }, signal), /stale_target/);

  // 卡住提供者调用时，核验工作进程已退出、旧代次无效，随后新窗口仍能使用。
  const current = await acquire(window, { backend: 'uia', maxNodes: 3 });
  const currentRoot = current.rows.find((row) => row.name === 'UIA large-tree root');
  const blocked = await computer.performAccessibility({ kind: 'find_item', element: currentRoot, owner, property: 'name', value: 'Item 9998' }, signal);
  assert.equal(blocked.found, true);
  assert.equal(await window.command('block'), 'blocked-enabled');
  const blockStart = performance.now();
  await assert.rejects(() => computer.semantics.call({ kind: 'act', owner, token: blocked.element.native_token,
    workerGeneration: blocked.element.worker_generation, action: { kind: 'read' } }, signal, 500), (error) => {
    assert.match(error.message, /deadline/); return true;
  });
  assert.ok(performance.now() - blockStart < 5000, 'deadline terminates worker within bounded grace');
  await assert.rejects(() => computer.performAccessibility({ kind: 'invoke', element: hits[0], owner }, signal), /stale_target/);
  const replacement = await fixture(executable);
  const recovered = await acquire(replacement, { backend: 'uia', maxNodes: 3 });
  assert.ok(recovered.rows.length > 0, 'native observation recovers after killed worker');
  const newRoot = recovered.rows.find((row) => row.name === 'UIA large-tree root');
  const actionItem = await computer.performAccessibility({ kind: 'find_item', element: newRoot, owner, property: 'name', value: 'Item 9999' }, signal);
  assert.equal(await replacement.command('block_action'), 'action-block-enabled');
  await assert.rejects(() => computer.semantics.call({ kind: 'act', owner, token: actionItem.element.native_token,
    workerGeneration: actionItem.element.worker_generation, action: { kind: 'invoke' } }, signal, 500), (error) => {
    assert.equal(error.executionState, 'unknown'); assert.match(error.message, /deadline/); return true;
  });
  assert.equal(await replacement.command('count'), 'count:1', 'timed-out Invoke is not automatically repeated');
  const legacyReplacement = await fixture(executable);
  let legacySearch = await acquire(legacyReplacement, { backend: 'msaa', maxNodes: 20000, query: { name: 'Legacy item 9998', match: 'exact', includeOffscreen: true }, maxDepth: 2 });
  const blockedRows = [...legacySearch.rows];
  while (legacySearch.page.next_cursor) {
    legacySearch = await acquire(legacyReplacement, { backend: 'msaa', cursor: legacySearch.page.next_cursor, workerGeneration: legacySearch.page.worker_generation, maxNodes: 20000 }); blockedRows.push(...legacySearch.rows);
  }
  assert.equal(blockedRows.length, 1);
  assert.equal(await legacyReplacement.command('block'), 'blocked-enabled');
  await assert.rejects(() => computer.semantics.call({ kind: 'act', owner, token: blockedRows[0].native_token,
    workerGeneration: blockedRows[0].worker_generation, action: { kind: 'read' } }, signal, 500), /deadline/);
  const finalReplacement = await fixture(executable);
  assert.ok((await acquire(finalReplacement, { backend: 'msaa', maxNodes: 3 })).rows.length > 0, 'MSAA recovers after a blocked provider');
  console.log(JSON.stringify({ uia_nodes: count, uia_pages: pages, msaa_nodes: legacyCount, offscreen_invoke: 'passed', subtree: 'passed', virtualization: 'passed', cursor_expiry: 'passed', deadline_recovery: 'passed', samples: metrics.length }, null, 2));
} finally {
  await writeFile(new URL('../.local/semantic-large-tree-metrics.json', import.meta.url), JSON.stringify({ comparisons, pages: metrics }, null, 2));
  await computer.dispose();
  for (const child of fixtures) child.terminate();
  await Promise.allSettled(fixtures.map((child) => child.waitForExit(AbortSignal.timeout(3000))));
  await runner.dispose();
  await rm(directory, { recursive: true, force: true });
}
