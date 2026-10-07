// 真实 UIA/MSAA 查询提前封存已验证前缀；尾部阻塞不能拖住已找到的目标。
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WindowsComputer } from '../src/windows.js';
import { resolveHostConfig } from '../src/config.js';
import { createManagedRunner } from './win32-runner.mjs';

if (process.platform !== 'win32') throw new Error('This match-limit fixture requires Windows');
if (process.env.DSH_EXPECT_ELECTRON === '1') assert.ok(process.versions.electron);
const directory = await mkdtemp(join(tmpdir(), 'dsh-match-limit-fixture-'));
const runner = await createManagedRunner();
const computer = new WindowsComputer(runner, { ...resolveHostConfig({}), semanticWorkerCount: 1 });
const owner = 'semantic-match-limit-fixture';
const samples = [];
let child, hwnd, nextLine;
function lineReader(stream) {
  let buffer = ''; const waiting = []; const queued = [];
  stream.setEncoding('utf8');
  stream.on('data', text => {
    buffer += text; let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end).trim(); buffer = buffer.slice(end + 1);
      if (waiting.length) waiting.shift()(line); else queued.push(line);
    }
  });
  return () => queued.length ? Promise.resolve(queued.shift()) : Promise.race([
    new Promise(resolveLine => waiting.push(resolveLine)),
    new Promise((_resolve, reject) => { const timer = setTimeout(() => reject(new Error('fixture command timeout')), 10000); timer.unref(); }),
  ]);
}
async function command(value) { child.stdin.write(`${value}\n`); return nextLine(); }
async function gac(name) {
  const root = join(process.env.WINDIR ?? 'C:\\Windows', 'Microsoft.NET', 'assembly', 'GAC_MSIL', name);
  return (await readdir(root)).map(version => join(root, version, `${name}.dll`)).find(existsSync);
}
async function observe(backend, query, options = {}) {
  return (await computer.accessibilitySnapshot(hwnd, undefined, { backend, owner, query,
    maxNodes: 300, maxDepth: 20, timeoutMs: 10000, ...options })).acquisition;
}
function assertPrefix(page, count) {
  assert.equal(page.consistency.status, 'frozen'); assert.equal(page.consistency.source_atomic, false);
  assert.equal(page.consistency.retained_rows, count);
  assert.equal(page.coverage.source_status, 'partial'); assert.equal(page.coverage.source_reason, 'match_limit');
}
try {
  const compiler = join(process.env.WINDIR ?? 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
  const executable = join(directory, 'fixture.exe');
  const refs = await Promise.all(['UIAutomationClient', 'UIAutomationTypes', 'UIAutomationProvider', 'WindowsBase', 'Accessibility'].map(gac));
  await runner.run([compiler, '/nologo', '/noconfig', '/target:exe', `/out:${executable}`,
    '/r:System.dll', '/r:System.Core.dll', '/r:System.Windows.Forms.dll', '/r:System.Drawing.dll',
    ...refs.map(path => `/r:${path}`), fileURLToPath(new URL('./windows-large-tree-fixture.cs', import.meta.url))]);
  child = runner.start([executable]); nextLine = lineReader(child.stdout);
  hwnd = await nextLine(); assert.match(hwnd, /^\d+$/);

  // 第1项和第9998项均阻塞60秒。只查第0项必须不进入任何未覆盖的尾部getter。
  assert.equal(await command('block'), 'blocked-enabled');
  assert.equal(await command('delay:1:60000'), 'delay-set');
  const early = new Map();
  for (const backend of ['uia', 'msaa']) {
    const name = backend === 'uia' ? 'Item 0' : 'Legacy item 0';
    const start = performance.now();
    const page = await observe(backend, { name, match: 'exact', includeOffscreen: true, maxMatches: 1 }, { timeoutMs: 5000 });
    assertPrefix(page, 1); assert.deepEqual(page.elements.map(row => row.name), [name]);
    assert.equal(page.next_cursor, null); assert.equal(page.coverage.reason, 'match_limit');
    assert.equal(page.visited_nodes, page.validated_nodes); assert.ok(page.consistency.captured_nodes < 20);
    early.set(backend, { elapsed_ms: Math.round(performance.now() - start), covered_nodes: page.consistency.captured_nodes });
  }
  assert.equal(await command('unblock'), 'blocked-disabled');
  assert.equal(await command('delay:-2:0'), 'delay-set');
  assert.equal(await command('resize:128'), 'resized');

  for (const backend of ['uia', 'msaa']) {
    const label = backend === 'uia' ? 'Item' : 'Legacy item';
    const rename = backend === 'uia' ? 'rename' : 'rename_legacy';
    const reorder = backend === 'uia' ? 'reorder_silent' : 'reorder_legacy_silent';
    const query = { name: `${label} 2`, match: 'contains', includeOffscreen: true };
    const full = await observe(backend, query);
    assert.equal(full.coverage.status, 'complete'); assert.ok(full.elements.length > 3);
    const missing = await observe(backend, { name: 'Nonexistent bounded target', match: 'exact', maxMatches: 1, includeOffscreen: true });
    assert.equal(missing.coverage.status, 'complete'); assert.equal(missing.elements.length, 0);
    assert.equal(missing.consistency.captured_nodes, full.consistency.captured_nodes);
    const limitedQuery = { ...query, maxMatches: 3 };
    const first = await observe(backend, limitedQuery, { maxResults: 1 });
    assertPrefix(first, 3); assert.equal(first.coverage.reason, 'page_limit');
    assert.ok(first.consistency.captured_nodes < full.consistency.captured_nodes / 2);
    assert.equal(first.visited_nodes, first.validated_nodes, 'every covered miss and hit is reread before publishing');
    assert.ok(first.elements[0].patterns.includes('invoke')); assert.ok(first.elements[0].bounds);
    const cursor = { cursor: first.next_cursor, workerGeneration: first.worker_generation };
    // 即使绕开JS包装层，原生续页也不能改变匹配上限；被拒后原游标仍有效。
    await assert.rejects(computer.semantics.call({ kind: 'acquire', backend, owner, consistency: 'snapshot',
      query: { ...query, maxMatches: 4 }, ...cursor }), /cursor query maxMatches changed/);
    assert.equal(await command(`${rename}:20:Changed frozen match`), 'renamed');
    assert.equal(await command(reorder), 'mutated');
    assert.equal(await command('reset_stats'), 'stats-reset');
    const names = first.elements.map(row => row.name); let page = first; let pages = 1;
    while (page.next_cursor) {
      // 原生续页可省略查询：它读同一代次，不能把无查询误作解除上限。
      page = await observe(backend, undefined, { cursor: page.next_cursor, workerGeneration: page.worker_generation, maxResults: 1 });
      assertPrefix(page, 3); assert.equal(page.result_id, first.result_id); assert.equal(page.consistency.sha256, first.consistency.sha256);
      assert.equal(page.native_calls, 0); assert.equal(page.visited_nodes, 0); assert.equal(page.validated_nodes, 0);
      names.push(...page.elements.map(row => row.name)); pages++;
    }
    assert.equal(pages, 3); assert.deepEqual(names, [2, 20, 21].map(index => `${label} ${index}`));
    assert.equal(page.coverage.status, 'partial'); assert.equal(page.coverage.reason, 'match_limit');
    assert.deepEqual(JSON.parse(await command('stats')), { property_reads: 0, pattern_reads: 0, navigations: 0, runtime_ids: 0 });
    assert.equal(await command(reorder), 'mutated');
    assert.equal(await command(`${rename}:20:${label} 20`), 'renamed');
    const target = first.elements[0]; const before = Number((await command('count')).slice(6));
    await computer.performAccessibility({ kind: 'invoke', owner, element: target });
    assert.equal(await command(`${rename}:2:Changed action identity`), 'renamed');
    await assert.rejects(computer.performAccessibility({ kind: 'invoke', owner, element: target }), /stale_target/);
    assert.equal(await command('count'), `count:${before + 1}`);
    assert.equal(await command(`${rename}:2:${label} 2`), 'renamed');

    // 未发布的前缀变更仍丢弃代次：未命中项成为命中项或顺序改变都不能绕过复读。
    const request = { kind: 'acquire', hwnd, backend, owner, consistency: 'snapshot', query: limitedQuery,
      maxDepth: 20, maxNodes: 22, maxBytes: 1000000, maxResults: 1 };
    for (const change of [`${rename}:12:${label} 20000`, reorder]) {
      const pending = await computer.semantics.call(request);
      assert.equal(pending.elements.length, 0); assert.equal(pending.consistency.status, 'collecting'); assert.ok(pending.next_cursor);
      assert.equal(await command(change), change === reorder ? 'mutated' : 'renamed');
      const continuation = { ...request, cursor: pending.next_cursor, workerGeneration: pending.worker_generation, maxNodes: 300 };
      await assert.rejects(computer.semantics.call(continuation), error => error.code === 'COMPUTER_SNAPSHOT_CHANGED');
      await assert.rejects(computer.semantics.call(continuation), /cursor_stale/);
      assert.equal(await command(change === reorder ? reorder : `${rename}:12:${label} 12`), change === reorder ? 'mutated' : 'renamed');
    }
    for (const maxMatches of [0, -1, 20001, 1.5, '3', null]) {
      await assert.rejects(computer.semantics.call({ ...request, query: { ...query, maxMatches } }), /maxMatches must be 1\.\.20000/);
    }
    await assert.rejects(computer.semantics.call({ ...request, consistency: 'live' }), /maxMatches requires snapshot consistency/);
    samples.push({ backend, early_with_blocked_tail: early.get(backend), full_covered_nodes: full.consistency.captured_nodes,
      prefix_covered_nodes: first.consistency.captured_nodes, prefix_visited: first.visited_nodes, prefix_validated: first.validated_nodes,
      matched_rows: 3, pages, continuation_native_calls: 0, covered_miss_and_reorder_discarded: true, actions_executed: 1 });
  }
  console.log(JSON.stringify({ match_limit: 'passed', missing_query_full_coverage: 'passed', samples }, null, 2));
} finally {
  await mkdir(new URL('../.local/', import.meta.url), { recursive: true });
  await writeFile(new URL('../.local/semantic-match-limit-metrics.json', import.meta.url), JSON.stringify(samples, null, 2));
  await computer.dispose();
  if (child) { child.terminate(); await child.waitForExit(AbortSignal.timeout(3000)); }
  await runner.dispose(); await rm(directory, { recursive: true, force: true });
}
