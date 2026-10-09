// 真实 WPF 默认 peers + Cordis ToolRuntime + 当前生产 Windows worker。
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WindowsComputer } from '../src/windows.js';
import { apply as applyTools } from '../src/tool.js';
import { createManagedRunner } from './win32-runner.mjs';

if (process.platform !== 'win32') throw new Error('Windows data fixture requires Windows');
const harnessRoot = process.env.DSH_HARNESS_ROOT ?? fileURLToPath(new URL('../../deepseek-harness/', import.meta.url));
const requireHarness = createRequire(resolve(harnessRoot, 'package.json'));
const { register } = await import(pathToFileURL(requireHarness.resolve('tsx/esm/api')).href);
const loader = register({ namespace: 'native-data-smoke', tsconfig: resolve(harnessRoot, 'tsconfig.json') });
const [{ Context }, { default: ToolRuntime }, { default: SystemPrompt }] = await Promise.all([
  loader.import('@deepseek-ai/cordis', import.meta.url), loader.import('@deepseek-ai/dsh-tools', import.meta.url), loader.import('@deepseek-ai/dsh-system-prompt', import.meta.url),
]);
const modes = process.env.DSH_DATA_MODES?.split(',') ?? ['tree', 'virtual', 'grid', 'scroll'];
if (!modes.length || new Set(modes).size !== modes.length || modes.some(mode => !['tree', 'virtual', 'grid', 'scroll'].includes(mode))) throw new Error('invalid DSH_DATA_MODES');
const runner = await createManagedRunner(), computer = new WindowsComputer(runner, { semanticWorkerCount: 1 });
const directory = await mkdtemp(join(tmpdir(), 'dsh-data-fixture-')), ctx = new Context();
const evidence = { observedAt: new Date().toISOString(), fullAcceptance: modes.length === 4, modes,
  runtime: { electron: process.versions.electron, node: process.versions.node, abi: process.versions.modules }, calls: [], samples: {} };
let child, nextLine, failure;
function lines(stream) {
  let buffer = ''; const queued = [], pending = [];
  stream.setEncoding('utf8'); stream.on('data', chunk => {
    buffer += chunk; let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end).trim(); buffer = buffer.slice(end + 1);
      if (pending.length) pending.shift()(line); else queued.push(line);
    }
  });
  return () => queued.length ? Promise.resolve(queued.shift()) : Promise.race([
    new Promise(done => pending.push(done)), new Promise((_done, reject) => { const timer = setTimeout(() => reject(new Error('fixture command deadline')), 10000); timer.unref(); }),
  ]);
}
async function command(text) { child.stdin.write(`${text}\n`); return nextLine(); }
async function gac(name) {
  for (const architecture of ['GAC_MSIL', 'GAC_64', 'GAC_32']) {
    const root = join(process.env.WINDIR ?? 'C:\\Windows', 'Microsoft.NET', 'assembly', architecture, name);
    if (!existsSync(root)) continue;
    const file = (await readdir(root)).map(version => join(root, version, `${name}.dll`)).find(existsSync);
    if (file) return file;
  }
  throw new Error(`Windows .NET assembly ${name} unavailable`);
}
try {
  const compiler = join(process.env.WINDIR ?? 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
  const executable = join(directory, 'fixture.exe');
  const refs = await Promise.all(['PresentationFramework', 'PresentationCore', 'WindowsBase', 'UIAutomationClient', 'UIAutomationTypes'].map(gac));
  await runner.run([compiler, '/nologo', '/noconfig', '/target:exe', `/out:${executable}`, '/r:System.dll', '/r:System.Core.dll', '/r:System.Xaml.dll',
    ...refs.map(path => `/r:${path}`), fileURLToPath(new URL('./windows-data-fixture.cs', import.meta.url))]);
  child = runner.start([executable]); nextLine = lines(child.stdout);
  const hwnd = await nextLine(); assert.match(hwnd, /^\d+$/);
  await ctx.plugin(SystemPrompt); await ctx.plugin(ToolRuntime); ctx.provide('computer', computer);
  await ctx.plugin({ name: 'data-task-probe', inject: ['tools', 'computer'], apply: scope => applyTools(scope, { observeApproval: 'allow', controlApproval: 'allow' }) });
  const agent = { options: {}, session: {} }; let calls = 0;
  const execute = async (name, args, signal = new AbortController().signal, currentAgent = agent) => {
    const started = performance.now();
    const result = await ctx.tools.execute({ signal, callId: `data-${++calls}`, name, arguments: args, agent: currentAgent });
    evidence.calls.push({ name, arguments: args, elapsed_ms: Math.round(performance.now() - started),
      result: result.isError ? result : name === 'computer_element' ? { summary: result.value } : JSON.parse(result.value) }); return result;
  };
  const json = async (name, args, signal) => {
    const result = await execute(name, args, signal); assert.equal(result.isError, false, JSON.stringify(result)); return JSON.parse(result.value);
  };
  const native = (await computer.listWindows()).find(w => w.id === hwnd); assert.ok(native);
  const listed = await json('computer_windows', { operation: 'list' });
  const owned = listed.windows.find(w => w.processId === native.processId && w.title === 'Computer data tasks fixture'); assert.ok(owned);
  const base = { window_id: owned.id, backend: 'uia', timeout_ms: 10000, poll_ms: 40 };
  await json('computer_accessibility', { window_id: owned.id, backend: 'uia', max_nodes: 80, max_depth: 4 });

  if (modes.includes('tree')) {
    const path = [{ automation_id: 'root' }, { automation_id: 'branch' }, { automation_id: 'leaf' }];
    const args = { ...base, locator: [{ automation_id: 'task-tree', scope: 'children' }], path }; const rounds = [];
    for (let round = 0; round < 2; round++) {
      assert.equal(await command('tree normal'), 'tree-ready');
      const result = await json('computer_tree', args);
      assert.equal(result.status, 'selected', JSON.stringify(result)); assert.equal(result.confirmed, true);
      assert.equal(result.selection_state, 'completed'); assert.deepEqual(result.actions.map(action => action.operation), ['expand', 'expand', 'select']);
      assert.ok(result.actions.every(action => action.execution_state === 'completed'));
      assert.equal(await command('tree-state'), 'root:1;branch:1;other:0;replacements:0;selections:1;selected:True');
      rounds.push({ elapsed_ms: result.elapsed_ms, actions: result.actions, snapshot_id: result.last.snapshot_id });
    }
    assert.equal(await command('tree missing'), 'tree-ready');
    const missing = await json('computer_tree', { ...args, timeout_ms: 1800 });
    assert.equal(missing.status, 'timeout', JSON.stringify(missing)); assert.equal(missing.selection_state, 'not_started');
    assert.equal(await command('tree-state'), 'root:1;branch:1;other:0;replacements:0;selections:0;selected:False');
    assert.ok(missing.elapsed_ms < 2800, JSON.stringify(missing));
    assert.equal(await command('tree replace'), 'tree-ready');
    const replacement = await json('computer_tree', args);
    assert.equal(replacement.status, 'ancestor_changed', JSON.stringify(replacement)); assert.equal(replacement.selection_state, 'not_started');
    assert.equal(await command('tree-state'), 'root:1;branch:1;other:0;replacements:1;selections:0;selected:False');
    evidence.samples.tree = { rounds, missing: { status: missing.status, elapsed_ms: missing.elapsed_ms }, replacement: replacement.status };
  }

  if (modes.includes('virtual')) {
    const rounds = [];
    for (const index of [579, 480]) {
      const container = [{ automation_id: 'virtual-list' }];
      const found = await json('computer_act', { ...base, locator: container, operation: 'find_item', value: `Virtual item ${index}` });
      assert.equal(found.execution_state, 'completed', JSON.stringify(found)); assert.equal(found.result.found, true);
      const item = found.item.elements[0]; let realized = false;
      if (item.patterns.includes('virtualized_item')) {
        const realization = await execute('computer_element', { snapshot_id: found.item.snapshot_id, element_id: item.element_id, operation: 'realize' });
        assert.equal(realization.isError, false, JSON.stringify(realization)); realized = true;
      }
      const selected = await json('computer_act', { ...base, locator: [...container, { name: `Virtual item ${index}`, role: 'ListItem' }], operation: 'select',
        after: { condition: { state: 'selected', value: true } } });
      assert.equal(selected.postcondition.fulfilled, true, JSON.stringify(selected));
      assert.equal(await command('virtual-state'), `selected:Virtual item ${index}`);
      rounds.push({ index, realized, found_snapshot_id: found.item.snapshot_id, elapsed_ms: selected.elapsed_ms });
    }
    evidence.samples.virtual = rounds;
  }

  if (modes.includes('grid')) {
    assert.equal(await command('grid-state'), 'selected:none;realized579:False', 'target row must not exist on the first screen');
    const currentGridReference = async (timeoutMs = base.timeout_ms, signal) => {
      const observed = await json('computer_wait', { ...base, timeout_ms: timeoutMs,
        locator: [{ automation_id: 'records', scope: 'children' }], condition: { state: 'present' } }, signal);
      assert.equal(observed.fulfilled, true, JSON.stringify(observed)); return observed.last;
    };
    const currentCellReference = async index => {
      const started = performance.now(), deadline = started + base.timeout_ms, signal = AbortSignal.timeout(base.timeout_ms);
      let attempts = 0;
      while (performance.now() < deadline) {
        const remaining = Math.floor(deadline - performance.now()); if (remaining < 100) break;
        const grid = await currentGridReference(remaining, signal); attempts++;
        const acquired = await execute('computer_read', { snapshot_id: grid.snapshot_id, element_id: grid.element.element_id, row: index, column: 0 }, signal);
        let checked = acquired, cell;
        if (!acquired.isError) {
          cell = JSON.parse(acquired.value);
          assert.equal(cell.cell.name, `Row ${index}`);
          checked = await execute('computer_read', { snapshot_id: cell.cell_snapshot_id, element_id: cell.cell.element_id }, signal);
        }
        if (!checked.isError) return { ...cell, acquisition_attempts: attempts };
        // 只重取明确 not_started 的只读结构变化；选择动作在循环外仅发送一次。
        assert.match(checked.error.message, /stale_target: tree structure changed \(execution_state: not_started\)/);
        await delay(Math.min(base.poll_ms, Math.max(0, deadline - performance.now())), undefined, { signal });
      }
      throw new Error(`Grid cell ${index} did not yield a current readable reference within the deadline`);
    };
    const rounds = [];
    for (const index of [579, 480]) {
      const grid = await currentGridReference();
      assert.equal(grid.status, 'resolved'); assert.ok(grid.element.patterns.includes('grid'));
      const cell = await json('computer_read', { snapshot_id: grid.snapshot_id, element_id: grid.element.element_id, row: index, column: 0 });
      assert.ok(cell.cell_snapshot_id); assert.ok(cell.cell.native_token);
      if (cell.cell.patterns.includes('virtualized_item')) {
        const realized = await execute('computer_element', { snapshot_id: cell.cell_snapshot_id, element_id: cell.cell.element_id, operation: 'realize' });
        assert.equal(realized.isError, false, JSON.stringify(realized));
      }
      // GetItem/Realize 后等待实际 Grid 几何稳定，再取得并确认当前 cell 可读。
      // 稳定几何不保证树事务；后续选择仍走严格的窗口/结构/身份/附着检查。
      const stable = await json('computer_wait', { ...base, locator: [{ automation_id: 'records', scope: 'children' }],
        condition: { state: 'stable', stable_ms: 200 } });
      assert.equal(stable.fulfilled, true, JSON.stringify(stable));
      const current = await currentCellReference(index);
      const selected = await execute('computer_element', { snapshot_id: current.cell_snapshot_id, element_id: current.cell.element_id, operation: 'select' });
      assert.equal(selected.isError, false, JSON.stringify(selected));
      const again = await currentGridReference();
      const read = await json('computer_read', { snapshot_id: again.snapshot_id, element_id: again.element.element_id, row: index, column: 0 });
      const state = await json('computer_read', { snapshot_id: read.cell_snapshot_id, element_id: read.cell.element_id });
      assert.equal(state.result.selected, true); assert.match(await command('grid-state'), new RegExp(`^selected:Row ${index};`));
      rounds.push({ index, cell_snapshot_id: current.cell_snapshot_id, selected: true,
        acquisition_attempts: current.acquisition_attempts, container_visited_nodes: grid.visited_nodes });
    }
    evidence.samples.grid = rounds;
  }

  if (modes.includes('scroll')) {
    const containerPath = [{ automation_id: 'scroll-items', scope: 'children' }];
    const container = await json('computer_locate', { ...base, locator: containerPath });
    assert.equal(container.status, 'resolved', JSON.stringify(container));
    assert.ok(container.element.patterns.includes('scroll')); assert.equal(container.element.patterns.includes('item_container'), false);
    const rounds = [];
    for (let round = 0; round < 2; round++) {
      assert.equal(await command('scroll-reset'), 'scroll-reset');
      const found = await json('computer_scroll_find', { ...base, locator: containerPath, item: [{ name: 'Scroll item 17', role: 'Button' }],
        max_scrolls: 10, page_wait_ms: 800 });
      assert.equal(found.status, 'found', JSON.stringify(found)); assert.ok(found.scrolls > 0); assert.ok(found.scrolls <= 10);
      assert.equal(found.global_absence_proven, false); assert.ok(found.pages.every(page => (page.visited_nodes ?? 0) <= 512));
      const invoked = await execute('computer_element', { snapshot_id: found.last.snapshot_id, element_id: found.last.element.element_id, operation: 'invoke' });
      assert.equal(invoked.isError, false, JSON.stringify(invoked));
      // 等待真正的 Click 状态；不重发 Invoke，也不把 provider 返回当作业务完成。
      const clicked = await json('computer_wait', { ...base,
        locator: [{ automation_id: 'scroll-status', name: `Scroll actions ${round + 1}`, scope: 'children' }], condition: { state: 'present' } });
      assert.equal(clicked.fulfilled, true, JSON.stringify(clicked));
      const businessState = await command('scroll-state');
      assert.match(businessState, new RegExp(`^actions:${round + 1};offset:`));
      rounds.push({ scrolls: found.scrolls, elapsed_ms: found.elapsed_ms, pages: found.pages,
        confirmation_snapshot_id: clicked.last.snapshot_id, confirmation_ms: clicked.elapsed_ms, business_state: businessState });
    }
    assert.equal(await command('scroll-reset'), 'scroll-reset');
    const limited = await json('computer_scroll_find', { ...base, locator: containerPath, item: [{ name: 'Scroll item 79', role: 'Button' }], max_scrolls: 1, page_wait_ms: 2000 });
    assert.equal(limited.status, 'scroll_limit', JSON.stringify(limited)); assert.equal(limited.global_absence_proven, false); assert.equal(limited.scrolls, 1);
    const unsupported = await json('computer_scroll_find', { ...base, locator: [{ automation_id: 'no-scroll', scope: 'children' }], item: [{ name: 'Missing' }] });
    assert.equal(unsupported.status, 'unsupported', JSON.stringify(unsupported)); assert.equal(unsupported.actions.length, 0);
    const incomplete = await json('computer_scroll_find', { ...base, locator: containerPath, item: [{ name: 'Missing' }], max_nodes: 1 });
    assert.ok(['incomplete', 'timeout'].includes(incomplete.status), JSON.stringify(incomplete)); assert.equal(incomplete.actions.length, 0);
    const controller = new AbortController(), cancelledAt = performance.now();
    const timer = setTimeout(() => controller.abort(new Error('cancel bounded data search')), 200);
    let cancelled;
    try { cancelled = await execute('computer_scroll_find', { ...base, locator: containerPath,
      item: [{ name: 'Missing' }], max_nodes: 1 }, controller.signal); }
    finally { clearTimeout(timer); }
    assert.equal(cancelled.isError, true, JSON.stringify(cancelled)); assert.match(cancelled.error.message, /aborted/);
    const cancellationMs = Math.round(performance.now() - cancelledAt); assert.ok(cancellationMs < 1800);
    assert.match(await command('scroll-state'), /^actions:2;offset:/);
    evidence.samples.scroll = { rounds, limited: limited.status, unsupported: unsupported.status, incomplete: incomplete.status,
      cancellation_ms: cancellationMs, cancellation: cancelled.error.message };
  }
  console.log(JSON.stringify({ native_data_tasks: 'passed', fullAcceptance: evidence.fullAcceptance, samples: evidence.samples }, null, 2));
} catch (error) { failure = error; evidence.failure = { message: error.message, stack: error.stack }; throw error; }
finally {
  await mkdir(new URL('../.local/', import.meta.url), { recursive: true });
  const metrics = failure ? `data-smoke-failure-${evidence.observedAt.replace(/[^0-9]/g, '')}.json` : evidence.fullAcceptance ? 'data-smoke-metrics.json' : `data-smoke-${modes.join('-')}-metrics.json`;
  await writeFile(new URL(`../.local/${metrics}`, import.meta.url), JSON.stringify(evidence, null, 2));
  await ctx.fiber.dispose(); await computer.dispose();
  if (child) { child.terminate(); await child.waitForExit(AbortSignal.timeout(3000)); }
  await runner.dispose(); loader.unregister(); await rm(directory, { recursive: true, force: true });
}
