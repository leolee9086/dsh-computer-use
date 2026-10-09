// 真实系统应用验收：新启动系统信息只读树、PowerShell Out-GridView 自有数据。
// 应用结构先从实际 provider 取得；probe 可展开自有分支观察结构，不作为任务通过。
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { WindowsComputer } from '../src/windows.js';
import { apply as applyTools } from '../src/tool.js';
import { createManagedRunner } from './win32-runner.mjs';

if (process.platform !== 'win32') throw new Error('data application acceptance requires Windows');
const root = fileURLToPath(new URL('../', import.meta.url));
const harnessRoot = process.env.DSH_HARNESS_ROOT ?? resolve(root, '..', 'deepseek-harness');
const requireHarness = createRequire(resolve(harnessRoot, 'package.json'));
const { register } = await import(pathToFileURL(requireHarness.resolve('tsx/esm/api')).href);
const loader = register({ namespace: 'data-app-smoke', tsconfig: resolve(harnessRoot, 'tsconfig.json') });
const [{ Context }, { default: ToolRuntime }, { default: SystemPrompt }] = await Promise.all([
  loader.import('@deepseek-ai/cordis', import.meta.url), loader.import('@deepseek-ai/dsh-tools', import.meta.url), loader.import('@deepseek-ai/dsh-system-prompt', import.meta.url),
]);
const mode = process.env.DSH_DATA_APP_MODE ?? 'grid';
if (!['tree', 'grid'].includes(mode)) throw new Error('invalid DSH_DATA_APP_MODE');
const probe = process.env.DSH_DATA_APP_PROBE === '1';
const runner = await createManagedRunner(), computer = new WindowsComputer(runner, { semanticWorkerCount: 1 });
const ctx = new Context(), agent = { options: {}, session: {} };
const evidence = { observedAt: new Date().toISOString(), actualApplication: mode === 'tree' ? 'msinfo32.exe' : 'Out-GridView',
  probeOnly: probe, accepted: false, runtime: { electron: process.versions.electron, node: process.versions.node, abi: process.versions.modules }, calls: [], samples: {} };
let child, failure, calls = 0;
const execute = async (name, args, signal = new AbortController().signal) => {
  const started = performance.now();
  const result = await ctx.tools.execute({ signal, callId: `data-app-${++calls}`, name, arguments: args, agent });
  evidence.calls.push({ name, arguments: args, elapsed_ms: Math.round(performance.now() - started),
    result: result.isError ? result : ['computer_element', 'computer_key', 'computer_type'].includes(name) ? { summary: result.value } : JSON.parse(result.value) });
  return result;
};
const json = async (name, args, signal) => { const result = await execute(name, args, signal); assert.equal(result.isError, false, JSON.stringify(result)); return JSON.parse(result.value); };
const flatten = tree => [tree, ...(tree.children ?? []).flatMap(flatten)];
try {
  await ctx.plugin(SystemPrompt); await ctx.plugin(ToolRuntime); ctx.provide('computer', computer);
  await ctx.plugin({ name: 'data-app-probe', inject: ['tools', 'computer'], apply: scope => applyTools(scope, { observeApproval: 'allow', controlApproval: 'allow' }) });
  const initial = await computer.listWindows();
  const system = join(process.env.WINDIR ?? 'C:\\Windows', 'System32');
  const title = 'Computer data application 600 rows';
  const command = mode === 'tree' ? [join(system, 'msinfo32.exe')]
    : [join(system, 'WindowsPowerShell', 'v1.0', 'powershell.exe'), '-NoLogo', '-NoProfile', '-Command',
      `0..599 | ForEach-Object { [pscustomobject]@{ Index = $_; Value = ('Application row ' + $_) } } | Out-GridView -Title '${title}' -Wait`];
  evidence.samples.launch = { command };
  const launchedAt = performance.now();
  child = runner.start(command); child.stdin.end(); evidence.samples.launch.pid = child.pid;
  // 启动失败与窗口发现失败分开记录，不从窗口列表缺失推断权限问题。
  child.done.then(outcome => { evidence.samples.launch.exit = { ...outcome, elapsed_ms: Math.round(performance.now() - launchedAt) }; },
    error => { evidence.samples.launch.error = { message: error.message }; });
  let app; const deadline = performance.now() + 12000;
  while (performance.now() < deadline) {
    if (evidence.samples.launch.error) throw new Error(`owned application could not start: ${evidence.samples.launch.error.message}`);
    const listing = await json('computer_windows', { operation: 'list' });
    const candidates = listing.windows.filter(window => !initial.some(old => old.id === window.native_id)
      && (mode === 'tree' ? window.application === 'msinfo32' : window.title === title));
    assert.ok(candidates.length <= 1, 'new application window must be unique');
    if (candidates.length === 1) { app = candidates[0]; break; }
    await delay(100);
  }
  assert.ok(app, 'a new owned application window must be observed'); evidence.samples.app = app;
  const fresh = async signal => {
    const listing = await json('computer_windows', { operation: 'list' }, signal);
    const current = listing.windows.find(window => window.native_id === app.native_id && window.processId === app.processId && window.title === app.title);
    assert.ok(current, 'owned application identity changed or closed');
    return { window_id: current.id, backend: 'uia', timeout_ms: 12000, poll_ms: 100 };
  };
  // 启动期间 Out-GridView 会继续构建行。仅重取明确未开始的只读采集错误，
  // 不将来源变化当作控件缺失；所有尝试和错误都留在证据中。
  const observeDeadline = performance.now() + 12000, observeSignal = AbortSignal.timeout(12000);
  let observed, observeAttempts = 0;
  while (performance.now() < observeDeadline) {
    const current = await fresh(observeSignal), remaining = Math.floor(observeDeadline - performance.now());
    if (remaining < 100) break;
    observeAttempts++;
    const result = await execute('computer_accessibility', { window_id: current.window_id, backend: 'uia',
      consistency: 'live', max_nodes: 80, max_depth: 5, timeout_ms: remaining }, observeSignal);
    if (!result.isError) { observed = JSON.parse(result.value); break; }
    assert.match(result.error.message, /(?:snapshot_changed:|cursor_stale: structure changed).*\(execution_state: not_started\)/);
    await delay(Math.min(100, Math.max(0, observeDeadline - performance.now())), undefined, { signal: observeSignal });
  }
  assert.ok(observed, 'owned application did not yield a bounded read-only overview');
  evidence.samples.initial = observed; evidence.samples.overviewAttempts = observeAttempts;
  const rows = flatten(observed.tree);
  if (probe) {
    if (mode === 'grid') {
      const located = await json('computer_wait', { ...await fresh(), locator: [
        { automation_id: 'ManagementList', role: 'Pane', scope: 'children' }, { automation_id: 'InnerList', role: 'DataGrid' }],
        condition: { state: 'stable', stable_ms: 200 } });
      assert.equal(located.fulfilled, true, JSON.stringify(located));
      const grid = located.last;
      const state = await json('computer_read', { snapshot_id: grid.snapshot_id, element_id: grid.element.element_id });
      const cell = await json('computer_read', { snapshot_id: grid.snapshot_id, element_id: grid.element.element_id, row: 579, column: 1 });
      const cellState = await json('computer_read', { snapshot_id: cell.cell_snapshot_id, element_id: cell.cell.element_id });
      evidence.samples.gridProbe = { state, cell, cellState };
    } else {
      const branchPath = [{ automation_id: '201', role: 'Tree', class_name: 'SysTreeView32' },
        { name: '系统摘要', role: 'TreeItem', scope: 'children' }, { name: '组件', role: 'TreeItem', scope: 'children' }];
      const expanded = await json('computer_act', { ...await fresh(), locator: branchPath, operation: 'expand', after: { condition: { state: 'expanded' } } });
      assert.equal(expanded.execution_state, 'completed', JSON.stringify(expanded)); assert.equal(expanded.postcondition.fulfilled, true);
      const branch = expanded.postcondition.last;
      const subtree = await json('computer_accessibility', { ...await fresh(), snapshot_id: branch.snapshot_id, root_element_id: branch.element.element_id,
        consistency: 'live', max_nodes: 40, max_depth: 2 });
      evidence.samples.treeProbe = { expanded, subtree };
    }
    console.log(JSON.stringify({ actual_application_probe: evidence.actualApplication,
      window: app, coverage: observed.coverage, overview_attempts: observeAttempts,
      controls: rows.filter(row => ['Pane', 'Edit', 'DataGrid', 'Tree', 'TreeItem'].includes(row.role)).slice(0, 20)
        .map(({ element_id, name, role, automation_id, class_name, patterns, bounds, offscreen }) =>
          ({ element_id, name, role, automation_id, class_name, patterns, bounds, offscreen })),
      grid: evidence.samples.gridProbe,
      tree_children: evidence.samples.treeProbe?.subtree.tree.children?.map(({ name, role, patterns }) => ({ name, role, patterns })) }, null, 2));
  } else if (mode === 'grid') {
    // 精确路径来自前面的真实观察；行的定位条件来自本测试自己输入的数据。
    const management = [{ automation_id: 'ManagementList', role: 'Pane', scope: 'children' }];
    const gridPath = [...management, { automation_id: 'InnerList', role: 'DataGrid', scope: 'children' }];
    const searchPath = [...management, { automation_id: 'PART_SearchBox', role: 'Edit', scope: 'children' }];
    const currentGrid = async (signal, deadline = performance.now() + 12000) => {
      const current = await fresh(signal), remaining = Math.floor(deadline - performance.now());
      assert.ok(remaining >= 100, 'grid observation deadline reached');
      const found = await json('computer_wait', { ...current, timeout_ms: remaining, locator: gridPath,
        condition: { state: 'stable', stable_ms: 200 } }, signal);
      assert.equal(found.fulfilled, true, JSON.stringify(found)); return found.last;
    };
    const initialGrid = await currentGrid();
    const initialState = await json('computer_read', { snapshot_id: initialGrid.snapshot_id, element_id: initialGrid.element.element_id });
    assert.deepEqual(initialState.result.grid, { rows: 600, columns: 2 });
    assert.equal(initialState.result.scroll.vertical, 0);
    assert.ok(initialState.result.scroll.vertical_view < 50, '579 and 480 must be beyond the initial viewport');
    const rounds = [];
    for (const index of [579, 480]) {
      const started = performance.now(), grid = await currentGrid();
      const cell = await json('computer_read', { snapshot_id: grid.snapshot_id, element_id: grid.element.element_id, row: index, column: 1 });
      assert.equal(cell.cell.name, `Application row ${index}`); assert.ok(cell.cell.native_token); assert.ok(cell.cell_snapshot_id);
      const cellState = await json('computer_read', { snapshot_id: cell.cell_snapshot_id, element_id: cell.cell.element_id });
      assert.equal(cellState.result.name, `Application row ${index}`);
      // Grid.GetItem 实际会滚动 ListView；选择的是重新定位的 DataItem，不能对 Text 单元格猜 Select 模式。
      const rowPath = [...gridPath, { role: 'DataItem', name: `Index=${index}; Value=Application row ${index};`, match: 'contains', scope: 'children' }];
      const selected = await json('computer_act', { ...await fresh(), locator: rowPath, operation: 'select',
        after: { condition: { state: 'selected', value: true } } });
      assert.equal(selected.execution_state, 'completed', JSON.stringify(selected)); assert.equal(selected.postcondition.fulfilled, true);
      const row = selected.postcondition.last;
      const rowState = await json('computer_read', { snapshot_id: row.snapshot_id, element_id: row.element.element_id });
      assert.equal(rowState.result.selected, true);
      const again = await currentGrid();
      const selection = await json('computer_read', { snapshot_id: again.snapshot_id, element_id: again.element.element_id });
      assert.deepEqual(selection.result.selected_elements, [row.element.element_id]);
      rounds.push({ index, cell_snapshot_id: cell.cell_snapshot_id, cell_name: cellState.result.name,
        selected_element_id: row.element.element_id, confirmed: true, elapsed_ms: Math.round(performance.now() - started) });
    }
    evidence.samples.grid = { initial: initialState.result, rounds };
    // ValuePattern 写入一次后，以实际 Text 值与 Grid 行数/单元格内容共同确认筛选。
    const filtered = await json('computer_act', { ...await fresh(), locator: searchPath, operation: 'set_value', value: 'Application row 579',
      after: { condition: { state: 'value', value: 'Application row 579' } } });
    assert.equal(filtered.execution_state, 'completed', JSON.stringify(filtered)); assert.equal(filtered.postcondition.fulfilled, true);
    // 定位、读取、轮询和最后的 cell 读取共用总截止；不能每轮重新给满12秒。
    const filterStarted = performance.now(), filterDeadline = filterStarted + 12000, filterSignal = AbortSignal.timeout(12000);
    let filteredState;
    while (performance.now() < filterDeadline) {
      const grid = await currentGrid(filterSignal, filterDeadline);
      filteredState = await json('computer_read', { snapshot_id: grid.snapshot_id, element_id: grid.element.element_id }, filterSignal);
      if (filteredState.result.grid.rows === 1) break;
      await delay(Math.min(100, Math.max(0, filterDeadline - performance.now())), undefined, { signal: filterSignal });
    }
    assert.equal(filteredState?.result.grid.rows, 1, 'application must actually filter to the requested row');
    const grid = await currentGrid(filterSignal, filterDeadline);
    const onlyCell = await json('computer_read', { snapshot_id: grid.snapshot_id, element_id: grid.element.element_id, row: 0, column: 1 }, filterSignal);
    assert.equal(onlyCell.cell.name, 'Application row 579');
    evidence.samples.filter = { value_confirmed: true, rows: 1, cell_name: onlyCell.cell.name,
      elapsed_ms: Math.round(performance.now() - filterStarted), timeout_ms: 12000 };
    evidence.accepted = true; console.log(JSON.stringify({ actual_application: evidence.actualApplication, accepted: true, samples: evidence.samples.grid.rounds, filter: evidence.samples.filter }, null, 2));
  } else {
    // 这条路径和中文名称来自实际系统信息 provider 探查；只改新窗口的导航状态。
    const treePath = [{ automation_id: '201', role: 'Tree', class_name: 'SysTreeView32' }];
    const rootPath = [...treePath, { name: '系统摘要', role: 'TreeItem', scope: 'children' }];
    const branchPath = [...rootPath, { name: '组件', role: 'TreeItem', scope: 'children' }];
    const locate = async locator => {
      const found = await json('computer_wait', { ...await fresh(), locator, condition: { state: 'present' } });
      assert.equal(found.fulfilled, true, JSON.stringify(found)); return found.last;
    };
    const readPath = async locator => {
      const found = await locate(locator);
      return json('computer_read', { snapshot_id: found.snapshot_id, element_id: found.element.element_id });
    };
    const unrelated = ['硬件资源', '软件环境'];
    for (const name of unrelated) assert.equal((await readPath([...rootPath, { name, role: 'TreeItem', scope: 'children' }])).result.expand_state, 'Collapsed');
    const rounds = [];
    for (const name of ['显示', '声音设备']) {
      // 上一轮展开状态可能保留，先收拢组件和根，且分别确认；不把准备动作记作工作流步骤。
      for (const locator of [branchPath, rootPath]) {
        const collapsed = await json('computer_act', { ...await fresh(), locator, operation: 'collapse', after: { condition: { state: 'collapsed' } } });
        assert.equal(collapsed.execution_state, 'completed', JSON.stringify(collapsed)); assert.equal(collapsed.postcondition.fulfilled, true);
      }
      assert.equal((await readPath(rootPath)).result.expand_state, 'Collapsed');
      const started = performance.now();
      const selected = await json('computer_tree', { ...await fresh(), locator: treePath,
        path: [{ name: '系统摘要' }, { name: '组件' }, { name }] });
      if (selected.status !== 'selected') {
        evidence.samples.treeFailure = selected;
        try { evidence.samples.treeFailureOverview = await json('computer_accessibility', { ...await fresh(), consistency: 'live', max_nodes: 50, max_depth: 4 }); }
        catch (error) { evidence.samples.treeFailureDiagnostic = { message: error.message }; }
      }
      assert.equal(selected.status, 'selected', JSON.stringify(selected)); assert.equal(selected.confirmed, true); assert.equal(selected.selection_state, 'completed');
      assert.deepEqual(selected.actions.map(({ stage, operation, execution_state }) => ({ stage, operation, execution_state })),
        [{ stage: 0, operation: 'expand', execution_state: 'completed' }, { stage: 1, operation: 'expand', execution_state: 'completed' },
          { stage: 2, operation: 'select', execution_state: 'completed' }]);
      // 独立于 workflow 内部确认，再定位目标和树读取 SelectionItem/Selection。
      const target = await locate([...branchPath, { name, role: 'TreeItem', scope: 'children' }]);
      const targetState = await json('computer_read', { snapshot_id: target.snapshot_id, element_id: target.element.element_id });
      assert.equal(targetState.result.selected, true);
      const treeState = await readPath(treePath);
      assert.deepEqual(treeState.result.selected_elements, [target.element.element_id]);
      for (const other of unrelated) assert.equal((await readPath([...rootPath, { name: other, role: 'TreeItem', scope: 'children' }])).result.expand_state, 'Collapsed');
      rounds.push({ path: ['系统摘要', '组件', name], initial_root_collapsed: true, actions: selected.actions,
        selected_element_id: target.element.element_id, independent_selection_confirmed: true, unrelated_branches_collapsed: true,
        workflow_elapsed_ms: selected.elapsed_ms, elapsed_ms: Math.round(performance.now() - started) });
    }
    evidence.samples.tree = { rounds }; evidence.accepted = true;
    console.log(JSON.stringify({ actual_application: evidence.actualApplication, accepted: true, rounds }, null, 2));
  }
} catch (error) { failure = error; evidence.failure = { message: error.message, stack: error.stack }; throw error; }
finally {
  try {
    try {
      await ctx.fiber.dispose(); await computer.dispose();
      if (child) {
        child.terminate();
        assert.equal(await child.waitForExit(AbortSignal.timeout(3000)), true, 'owned application did not exit during cleanup');
        await child.done;
        evidence.samples.launch.stderr = child.collected.stderr.readFrom(0);
      }
    } finally { await runner.dispose(); loader.unregister(); }
  } catch (error) {
    evidence.accepted = false;
    evidence.cleanupFailure = { message: error.message, stack: error.stack }; failure ??= error; throw error;
  } finally {
    await mkdir(resolve(root, '.local'), { recursive: true });
    const file = failure ? `data-app-${mode}-failure-${evidence.observedAt.replace(/[^0-9]/g, '')}.json` : `data-app-${mode}-${probe ? 'probe' : 'metrics'}.json`;
    await writeFile(resolve(root, '.local', file), JSON.stringify(evidence, null, 2));
    if (failure) console.error(JSON.stringify({ application_failure: evidence.failure, launch: evidence.samples.launch, cleanup_failure: evidence.cleanupFailure }));
  }
}
