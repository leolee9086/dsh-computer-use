// 将真实 ToolRuntime、WindowsComputer 和原生工作进程接在一起。
// 只操作自建窗口；检查工具输出、固定续页及控制证据，不把封存当成源事务。
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WindowsComputer } from '../src/windows.js';
import { resolveHostConfig } from '../src/config.js';
import { apply as applyTools } from '../src/tool.js';
import { flattenAccessibilityTree } from '../src/semantics.js';
import { createManagedRunner } from './win32-runner.mjs';

if (process.platform !== 'win32') throw new Error('This native ToolRuntime fixture requires Windows');
if (process.env.DSH_EXPECT_ELECTRON === '1') assert.ok(process.versions.electron, 'run in the actual Electron executable');
// 与已有 ToolRuntime 回归使用同一个宿主 checkout，读取它的源码和依赖。
const harnessRoot = process.env.DSH_HARNESS_ROOT ?? fileURLToPath(new URL('../../deepseek-harness/', import.meta.url));
const requireHarness = createRequire(resolve(harnessRoot, 'package.json'));
const { register } = await import(pathToFileURL(requireHarness.resolve('tsx/esm/api')).href);
// 与现有 ToolRuntime integration 一样使用宿主 workspace 的 source aliases。
// 不把该 checkout 中尚未重建的 lib 文件当成当前宿主源码；加载器只作用于此 namespace。
const runtimeLoader = register({ namespace: 'native-tool-runtime-smoke', tsconfig: resolve(harnessRoot, 'tsconfig.json') });
const [{ Context }, { default: ToolRuntime }, { default: SystemPrompt }] = await Promise.all([
  runtimeLoader.import('@deepseek-ai/cordis', import.meta.url),
  runtimeLoader.import('@deepseek-ai/dsh-tools', import.meta.url),
  runtimeLoader.import('@deepseek-ai/dsh-system-prompt', import.meta.url),
]);
const runner = await createManagedRunner();
const computer = new WindowsComputer(runner, { ...resolveHostConfig({}), semanticWorkerCount: 1 });
const directory = await mkdtemp(join(tmpdir(), 'dsh-semantic-tool-runtime-'));
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
function rows(page) { return flattenAccessibilityTree(page.tree).filter(row => row.element_id); }

try {
  const compiler = join(process.env.WINDIR ?? 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
  const executable = join(directory, 'fixture.exe');
  const refs = await Promise.all(['UIAutomationClient', 'UIAutomationTypes', 'UIAutomationProvider', 'WindowsBase', 'Accessibility'].map(gac));
  await runner.run([compiler, '/nologo', '/noconfig', '/target:exe', `/out:${executable}`,
    '/r:System.dll', '/r:System.Core.dll', '/r:System.Windows.Forms.dll', '/r:System.Drawing.dll',
    ...refs.map(path => `/r:${path}`), fileURLToPath(new URL('./windows-large-tree-fixture.cs', import.meta.url))]);
  child = runner.start([executable]); nextLine = lineReader(child.stdout);
  hwnd = await nextLine(); assert.match(hwnd, /^\d+$/);
  assert.equal(await command('resize:1600'), 'resized');

  for (const backend of ['uia', 'msaa']) {
    const ctx = new Context();
    try {
      await ctx.plugin(SystemPrompt); await ctx.plugin(ToolRuntime);
      ctx.provide('computer', computer);
      await ctx.plugin({ name: `native-${backend}-tool-runtime-probe`, inject: ['tools', 'computer'],
        apply: scope => applyTools(scope, { observeApproval: 'allow', controlApproval: 'allow' }) });
      const agent = { options: {}, session: {} }; let calls = 0;
      const execute = (name, args, currentAgent = agent) => ctx.tools.execute({
        signal: new AbortController().signal, callId: `native-${backend}-${++calls}`, name, arguments: args, agent: currentAgent,
      });
      const json = async (name, args) => {
        const result = await execute(name, args);
        assert.equal(result.isError, false, JSON.stringify(result));
        return JSON.parse(result.value);
      };
      // SubprocessHandle 不暴露 PID；用自建进程输出的 HWND 查原生身份。
      // 工具的 id 已转换为会话证据，不能拿它与原始 HWND 比较。
      const fixtureWindow = (await computer.listWindows()).find(window => window.id === hwnd);
      assert.ok(fixtureWindow && Number.isInteger(fixtureWindow.processId), 'native enumeration identifies the owned HWND');
      const listed = (await json('computer_windows', { operation: 'list' })).windows;
      const ownedWindows = listed.filter(window => window.processId === fixtureWindow.processId && window.title === fixtureWindow.title);
      assert.equal(ownedWindows.length, 1, 'tool window enumeration retains the independently verified native identity');
      const owned = ownedWindows[0];
      const base = { window_id: owned.id, backend, max_depth: 20 };
      const label = backend === 'uia' ? 'Item' : 'Legacy item';
      const rename = backend === 'uia' ? 'rename' : 'rename_legacy';
      const query = name => ({ ...base, source: 'native', name, match: 'exact', include_offscreen: true, timeout_ms: 10000 });
      // 先启动工作进程。小分段的短调用交付真正的未完成采集游标。
      await json('computer_find', query(`${label} 0`));
      const pending = await json('computer_accessibility', { ...base, max_nodes: 1, timeout_ms: 1000 });
      assert.notEqual(pending.consistency.status, 'frozen');
      assert.equal(rows(pending).length, 0); assert.equal(pending.coverage.status, 'unknown');
      assert.ok(pending.next_cursor); assert.ok(pending.visited_nodes > 40, 'silent change affects an already-read node outside the anchor prefix');
      assert.equal(await command(`${rename}:12:Changed pending ${backend}`), 'renamed');
      const resume = { snapshot_id: pending.snapshot_id, cursor: pending.next_cursor, max_nodes: 127, timeout_ms: 10000 };
      const changed = await execute('computer_accessibility', resume);
      assert.equal(changed.isError, true); assert.match(changed.error?.message ?? '', /snapshot_changed/);
      const discarded = await execute('computer_accessibility', resume);
      assert.equal(discarded.isError, true); assert.match(discarded.error?.message ?? '', /cursor_stale/);
      assert.equal(await command(`${rename}:12:${label} 12`), 'renamed');

      let first = await json('computer_accessibility', { ...base, max_nodes: 127, timeout_ms: 10000 });
      let captureCalls = 1;
      while (first.consistency.status !== 'frozen') {
        assert.equal(rows(first).length, 0); assert.ok(++captureCalls <= 5);
        first = await json('computer_accessibility', { snapshot_id: first.snapshot_id, cursor: first.next_cursor, max_nodes: 127, timeout_ms: 10000 });
      }
      assert.equal(first.coverage.source_status, 'complete', 'the frozen result covers the requested source scope');
      assert.equal(first.coverage.status, 'partial'); assert.equal(first.coverage.reason, 'page_limit');
      assert.equal(first.consistency.source_atomic, false);
      assert.equal(first.result_id, first.consistency.result_id); assert.match(first.consistency.sha256, /^[0-9a-f]{64}$/);
      assert.ok(first.next_cursor);
      const captured = rows(first); const target = captured.find(row => row.name === `${label} 0`);
      assert.ok(target); assert.ok(target.patterns.includes('invoke'));
      const before = Number((await command('count')).slice(6));
      const invoked = await execute('computer_element', { snapshot_id: first.snapshot_id, element_id: target.element_id, operation: 'invoke' });
      assert.equal(invoked.isError, false, JSON.stringify(invoked));
      assert.equal(await command('count'), `count:${before + 1}`);
      const consumed = await execute('computer_element', { snapshot_id: first.snapshot_id, element_id: target.element_id, operation: 'invoke' });
      assert.equal(consumed.isError, true);
      // 相同源句柄对另一 agent 无效，不能借历史页或原生引用越过会话边界。
      const outsider = await execute('computer_accessibility', { snapshot_id: first.snapshot_id, cursor: first.next_cursor }, { options: {}, session: {} });
      assert.equal(outsider.isError, true);
      assert.equal(await command(`${rename}:1599:Renamed sealed tail ${backend}`), 'renamed');
      assert.equal(await command(backend === 'uia' ? 'reorder_silent' : 'reorder_legacy_silent'), 'mutated');
      if (backend === 'uia') {
        for (const change of ['insert_silent', 'remove_silent']) assert.equal(await command(change), 'mutated');
      }
      assert.equal(await command('reset_stats'), 'stats-reset');
      let page = first; let pages = 1;
      while (page.next_cursor) {
        page = await json('computer_accessibility', { snapshot_id: page.snapshot_id, cursor: page.next_cursor, max_nodes: 127 });
        assert.equal(page.result_id, first.result_id); assert.equal(page.consistency.sha256, first.consistency.sha256);
        assert.equal(page.consistency.status, 'frozen'); assert.equal(page.native_calls, 0);
        assert.equal(page.visited_nodes, 0); assert.equal(page.validated_nodes, 0); assert.equal(page.capture_restarts, 0);
        const pageRows = rows(page); captured.push(...pageRows); pages++;
        const actionable = pageRows.find(row => row.patterns?.includes('invoke'));
        if (actionable) {
          const historyAction = await execute('computer_element', { snapshot_id: page.snapshot_id, element_id: actionable.element_id, operation: 'invoke' });
          assert.equal(historyAction.isError, true, 'reading frozen history does not restore consumed control evidence');
        }
      }
      assert.equal(page.coverage.status, 'complete', 'all rows have been delivered only after the last page');
      assert.ok(pages > 8, 'exercise real default observation eviction as the page chain advances');
      assert.equal(captured.length, first.consistency.captured_nodes);
      assert.equal(new Set(captured.map(row => row.element_id)).size, captured.length);
      assert.ok(captured.find(row => row.name === `${label} 1599`), 'late page preserves its captured name');
      assert.equal(captured.some(row => row.name === `Renamed sealed tail ${backend}`), false);
      assert.deepEqual(JSON.parse(await command('stats')), { property_reads: 0, pattern_reads: 0, navigations: 0, runtime_ids: 0 });
      assert.equal(await command('count'), `count:${before + 1}`, 'all consumed/history invocations have zero side effects');

      // 新观测仍交由原生实时身份复核，拒绝已经改名的控件。
      const found = await json('computer_find', query(`${label} 100`));
      assert.equal(found.matches.length, 1); assert.ok(found.matches[0].patterns.includes('invoke'));
      assert.equal(await command(`${rename}:100:Renamed live target ${backend}`), 'renamed');
      const stale = await execute('computer_element', { snapshot_id: found.snapshot_id, element_id: found.matches[0].element_id, operation: 'invoke' });
      assert.equal(stale.isError, true); assert.match(stale.error?.message ?? '', /stale_target/);
      assert.equal(await command('count'), `count:${before + 1}`);
      // 还原前面的交换，确保第13项的getter改动的是已经读过的第12项。
      assert.equal(await command(backend === 'uia' ? 'reorder_silent' : 'reorder_legacy_silent'), 'mutated');
      assert.equal(await command(`mutation:${backend}:once`), 'mutation-enabled');
      const recovered = await json('computer_find', { ...query('Mutation target'), match: 'contains' });
      assert.equal(recovered.capture_restarts, 1); assert.equal(recovered.consistency.status, 'frozen');
      assert.deepEqual(recovered.matches.map(row => row.name), ['Mutation target 1']);
      assert.equal(await command('mutation_stats'), 'mutations:1');
      assert.equal(await command('mutation:disable'), 'mutation-disabled');
      samples.push({ backend, captured_nodes: captured.length, pages, capture_calls: captureCalls,
        pending_nodes: pending.visited_nodes, discarded_capture: true, continuation_native_calls: 0,
        consumed_history_actions: 'rejected', live_identity: 'rejected renamed target', capture_restarts: recovered.capture_restarts });
    } finally { await ctx.fiber.dispose(); }
  }
  console.log(JSON.stringify({ runtime: { node: process.versions.node, electron: process.versions.electron },
    tool_runtime: 'real', native_provider: 'real', fixed_pagination: 'passed', samples }, null, 2));
} finally {
  await mkdir(new URL('../.local/', import.meta.url), { recursive: true });
  await writeFile(new URL('../.local/semantic-tool-runtime-metrics.json', import.meta.url), JSON.stringify(samples, null, 2));
  await computer.dispose();
  if (child) { child.terminate(); await child.waitForExit(AbortSignal.timeout(3000)); }
  await runner.dispose(); await rm(directory, { recursive: true, force: true });
  await runtimeLoader.unregister();
}
