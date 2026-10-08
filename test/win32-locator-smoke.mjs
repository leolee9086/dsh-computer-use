// 默认 WPF AutomationPeer + 真实 Cordis ToolRuntime + 生产 worker 的任务验收。
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WindowsComputer } from '../src/windows.js';
import { apply as applyTools } from '../src/tool.js';
import { createManagedRunner } from './win32-runner.mjs';

if (process.platform !== 'win32') throw new Error('Windows locator fixture requires Windows');
const harnessRoot = process.env.DSH_HARNESS_ROOT ?? fileURLToPath(new URL('../../deepseek-harness/', import.meta.url));
const requireHarness = createRequire(resolve(harnessRoot, 'package.json'));
const { register } = await import(pathToFileURL(requireHarness.resolve('tsx/esm/api')).href);
const loader = register({ namespace: 'native-locator-smoke', tsconfig: resolve(harnessRoot, 'tsconfig.json') });
const [{ Context }, { default: ToolRuntime }, { default: SystemPrompt }] = await Promise.all([
  loader.import('@deepseek-ai/cordis', import.meta.url), loader.import('@deepseek-ai/dsh-tools', import.meta.url), loader.import('@deepseek-ai/dsh-system-prompt', import.meta.url),
]);
const runner = await createManagedRunner(), computer = new WindowsComputer(runner, { semanticWorkerCount: 1 });
const directory = await mkdtemp(join(tmpdir(), 'dsh-locator-fixture-')), ctx = new Context();
const samples = {}; let child, nextLine;
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
    new Promise(done => pending.push(done)),
    new Promise((_done, reject) => { const timer = setTimeout(() => reject(new Error('fixture command deadline')), 10000); timer.unref(); }),
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
    ...refs.map(path => `/r:${path}`), fileURLToPath(new URL('./windows-locator-fixture.cs', import.meta.url))]);
  child = runner.start([executable]); nextLine = lines(child.stdout);
  const hwnd = await nextLine(); assert.match(hwnd, /^\d+$/);
  await ctx.plugin(SystemPrompt); await ctx.plugin(ToolRuntime); ctx.provide('computer', computer);
  await ctx.plugin({ name: 'locator-task-probe', inject: ['tools', 'computer'], apply: scope => applyTools(scope, { observeApproval: 'allow', controlApproval: 'allow' }) });
  const agent = { options: {}, session: {} }; let calls = 0;
  const execute = (name, args, signal = new AbortController().signal, currentAgent = agent) => ctx.tools.execute({
    signal, callId: `locator-${++calls}`, name, arguments: args, agent: currentAgent,
  });
  const json = async (name, args, signal) => {
    const result = await execute(name, args, signal);
    assert.equal(result.isError, false, JSON.stringify(result)); return JSON.parse(result.value);
  };
  const native = (await computer.listWindows()).find(w => w.id === hwnd); assert.ok(native);
  const listed = await json('computer_windows', { operation: 'list' });
  const owned = listed.windows.find(w => w.processId === native.processId && w.title === 'Computer locator fixture'); assert.ok(owned);
  const base = { window_id: owned.id, backend: 'uia', timeout_ms: 10000 };
  const right = [{ automation_id: 'right-panel', role: 'Group' }];
  const input = [...right, { automation_id: 'input', role: 'Edit', framework_id: 'WPF' }];
  const apply = [...right, { name: 'Apply', role: 'Button' }];
  const old = await json('computer_wait', { ...base, locator: input, condition: { state: 'disabled' } }); assert.equal(old.fulfilled, true);
  const ambiguous = await json('computer_locate', { ...base, locator: [{ name: 'Apply', role: 'Button' }] });
  assert.equal(ambiguous.status, 'ambiguous'); assert.equal(ambiguous.candidates.length, 2); assert.equal(ambiguous.coverage.status, 'partial');
  const nth = await json('computer_locate', { ...base, locator: [{ name: 'Apply', role: 'Button', nth: 1 }] }); assert.equal(nth.status, 'resolved');
  assert.equal(nth.coverage.reason, 'explicit_nth_prefix');
  const incomplete = await json('computer_locate', { ...base, locator: input, max_nodes: 1 }); assert.equal(incomplete.status, 'incomplete');
  const noFalseAbsence = await json('computer_wait', { ...base, timeout_ms: 250, locator: [{ name: 'Missing' }], max_nodes: 1, condition: { state: 'absent' } });
  assert.equal(noFalseAbsence.fulfilled, false);
  const absent = await json('computer_wait', { ...base, locator: [{ name: 'Missing' }], condition: { state: 'absent' } }); assert.equal(absent.fulfilled, true);
  assert.equal(await command('replace'), 'scheduled');
  const replaced = await json('computer_wait', { ...base, locator: input, poll_ms: 40, condition: { state: 'enabled' } });
  assert.equal(replaced.fulfilled, true); assert.notEqual(replaced.last.element.element_id, old.last.element.element_id); assert.ok(replaced.attempts > 1);
  const value = await json('computer_act', { ...base, locator: input, operation: 'set_value', value: 'updated', after: { condition: { state: 'value', value: 'updated' } } });
  assert.equal(value.execution_state, 'completed', JSON.stringify(value)); assert.equal(value.postcondition.fulfilled, true, JSON.stringify(value));
  assert.match(await command('state'), /value:updated$/);
  const action = await json('computer_act', { ...base, locator: apply, operation: 'invoke', after: { locator: [{ automation_id: 'status', name: 'Applied 1' }], condition: { state: 'present' } } });
  assert.equal(action.execution_state, 'completed'); assert.equal(action.postcondition.fulfilled, true);
  assert.match(await command('state'), /^actions:1;/);
  // 给真实 UIA 解析留出预算，再验证后置超时；300ms 可能在动作前已耗尽。
  const failedAfter = await json('computer_act', { ...base, timeout_ms: 1500, locator: apply, operation: 'invoke', after: { locator: [{ name: 'Never appears' }], condition: { state: 'present' } } });
  assert.equal(failedAfter.execution_state, 'completed', JSON.stringify(failedAfter)); assert.equal(failedAfter.postcondition.fulfilled, false);
  assert.match(await command('state'), /^actions:2;/, 'a postcondition timeout sends the action once');
  const timer = new AbortController(); setTimeout(() => timer.abort(new Error('fixture cancellation')), 100);
  const cancelled = await execute('computer_wait', { ...base, locator: [{ name: 'Never appears' }] }, timer.signal);
  assert.equal(cancelled.isError, true); assert.match(await command('state'), /^actions:2;/);
  const foreign = await execute('computer_locate', { ...base, locator: input }, undefined, { options: {}, session: {} }); assert.equal(foreign.isError, true);
  samples.locators = { ambiguous: true, nth: true, incomplete_not_absent: true, replacement_attempts: replaced.attempts, set_value_confirmed: true,
    action_count: 2, postcondition_timeout_ms: failedAfter.elapsed_ms, cancelled: true, session_bound: true };

  // 惰性树：展开动作一次，等真正加载的叶子，然后选择并按需读回状态。
  const root = [{ automation_id: 'lazy-tree' }, { automation_id: 'root' }];
  const leaf = [{ automation_id: 'lazy-tree' }, { automation_id: 'leaf' }];
  const expanded = await json('computer_act', { ...base, locator: root, operation: 'expand', after: { locator: leaf, condition: { state: 'present' } } });
  assert.equal(expanded.postcondition.fulfilled, true);
  const selected = await json('computer_act', { ...base, locator: leaf, operation: 'select', after: { condition: { state: 'selected', value: true } } });
  assert.equal(selected.postcondition.fulfilled, true); samples.lazy_tree = { expanded: true, delayed_leaf_selected: true };

  // 默认 WPF ItemContainer 与虚拟项：不导出600项，查找->实例化->重解->选择。
  const list = await json('computer_locate', { ...base, locator: [{ automation_id: 'virtual-list' }] }); assert.equal(list.status, 'resolved');
  assert.ok(list.element.patterns.includes('item_container'), JSON.stringify(list.element));
  const found = await json('computer_act', { ...base, locator: [{ automation_id: 'virtual-list' }], operation: 'find_item', value: 'Virtual item 579' });
  assert.equal(found.execution_state, 'completed', JSON.stringify(found));
  assert.equal(found.result.found, true, JSON.stringify(found)); const item = found.item.elements[0];
  if (item.patterns.includes('virtualized_item')) {
    const realized = await execute('computer_element', { snapshot_id: found.item.snapshot_id, element_id: item.element_id, operation: 'realize' });
    assert.equal(realized.isError, false, JSON.stringify(realized));
  }
  const virtualPath = [{ automation_id: 'virtual-list' }, { name: 'Virtual item 579', role: 'ListItem' }];
  const virtual = await json('computer_act', { ...base, locator: virtualPath, operation: 'select', after: { condition: { state: 'selected', value: true } } });
  assert.equal(virtual.postcondition.fulfilled, true); samples.virtual_item = { found: true, realized: true, selected: true };

  // Grid.GetItem 的返回结果必须经过生产 Save 与工具观测登记后才能动作。
  const grid = await json('computer_locate', { ...base, locator: [{ automation_id: 'records' }] });
  const cell = await json('computer_read', { snapshot_id: grid.snapshot_id, element_id: grid.element.element_id, row: 1, column: 0 });
  assert.ok(cell.cell_snapshot_id); assert.ok(cell.cell.native_token); assert.ok(cell.cell.patterns.includes('selection_item'), JSON.stringify(cell.cell));
  const cellAction = await execute('computer_element', { snapshot_id: cell.cell_snapshot_id, element_id: cell.cell.element_id, operation: 'select' });
  assert.equal(cellAction.isError, false, JSON.stringify(cellAction));
  const currentGrid = await json('computer_locate', { ...base, locator: [{ automation_id: 'records' }] });
  const currentCell = await json('computer_read', { snapshot_id: currentGrid.snapshot_id, element_id: currentGrid.element.element_id, row: 1, column: 0 });
  const cellRead = await json('computer_read', { snapshot_id: currentCell.cell_snapshot_id, element_id: currentCell.cell.element_id });
  assert.equal(cellRead.result.selected, true); samples.grid = { cell_reference_registered: true, cell_selected_and_read: true };

  // 执行期间允许人操作电脑：等待未启用目标时，另一个窗口获得焦点，
  // 原窗口被编辑并替换。同名控件不能让定位或 SetValue 跟随焦点漂移。
  assert.equal(await command('disable'), 'disabled');
  const concurrent = json('computer_act', { ...base, locator: input, operation: 'set_value', value: 'pinned target',
    after: { condition: { state: 'value', value: 'pinned target' } } });
  assert.equal(await command('interfere'), 'interfering');
  const concurrentResult = await concurrent;
  assert.equal(concurrentResult.execution_state, 'completed', JSON.stringify(concurrentResult));
  assert.equal(concurrentResult.postcondition.fulfilled, true, JSON.stringify(concurrentResult));
  assert.match(await command('state'), /^actions:2;generation:2;value:pinned target$/);
  const interferenceState = await command('interference-state');
  // 只要求确实观察到切窗；应用或人都可以再次改变最终前台，不能锁死这一状态。
  assert.match(interferenceState, /^other-actions:0;other-value:other manual;other-was-foreground:True;other-foreground:(True|False)$/);
  samples.concurrent_interaction = { focus_changed_during_wait: true, original_target_replaced: true, pinned_window_updated: true,
    other_window_untouched: true, other_window_foreground_at_completion: interferenceState.endsWith(':True') };
  assert.equal(await command('other-close'), 'other-closed');

  // 已观测引用在人的替换操作后不能调用旧对象；不按同名目标静默重绑定。
  const beforeReplacement = await json('computer_locate', { ...base, locator: input });
  assert.equal(await command('replace-now'), 'replaced');
  const staleInput = await execute('computer_element', { snapshot_id: beforeReplacement.snapshot_id,
    element_id: beforeReplacement.element.element_id, operation: 'set_value', value: 'stale write' });
  assert.equal(staleInput.isError, true, JSON.stringify(staleInput));
  assert.match(await command('state'), /^actions:2;generation:3;value:initial$/);

  // 真正 SetValue 已返回之后、后置读取之前再模拟人工编辑，确认失败不能重写人的值。
  const perform = computer.performAccessibility.bind(computer); let valueDispatches = 0;
  computer.performAccessibility = async (operation, signal) => {
    const result = await perform(operation, signal);
    if (operation.kind === 'set_value') { valueDispatches++; assert.equal(await command('manual-edit'), 'manually-edited'); }
    return result;
  };
  let overwritten;
  try { overwritten = await json('computer_act', { ...base, timeout_ms: 1500, locator: input, operation: 'set_value', value: 'automation value',
    after: { condition: { state: 'value', value: 'automation value' } } }); }
  finally { computer.performAccessibility = perform; }
  assert.equal(overwritten.execution_state, 'completed', JSON.stringify(overwritten)); assert.equal(overwritten.postcondition.fulfilled, false);
  assert.equal(valueDispatches, 1); assert.match(await command('state'), /^actions:2;generation:3;value:manual after action$/);
  samples.concurrent_interaction.stale_reference_rejected = true;
  samples.concurrent_interaction.manual_edit_after_dispatch_preserved = true;
  samples.concurrent_interaction.failed_confirmation_does_not_replay = true;

  // 已列窗口的标题也属于固定身份；变化后旧引用不能直接控制，即使 HWND/PID 未变。
  const beforeTitleChange = await json('computer_locate', { ...base, locator: input });
  assert.equal(await command('rename-window'), 'window-renamed');
  const renamedWindow = await execute('computer_element', { snapshot_id: beforeTitleChange.snapshot_id,
    element_id: beforeTitleChange.element.element_id, operation: 'set_value', value: 'wrong title write' });
  assert.equal(renamedWindow.isError, true, JSON.stringify(renamedWindow));
  assert.match(await command('state'), /^actions:2;generation:3;value:manual after action$/);
  assert.equal(await command('restore-window'), 'window-restored');
  samples.concurrent_interaction.window_title_change_rejected = true;

  // 另一个 HWND 的弹窗：动作后重列窗口取得新证据，再定位其中的控件。
  assert.equal(await command('popup'), 'popup-enabled');
  const opened = await json('computer_act', { ...base, locator: apply, operation: 'invoke', after: { locator: [{ name: 'Applied 3' }], condition: { state: 'present' } } });
  assert.equal(opened.postcondition.fulfilled, true);
  const popupList = await json('computer_windows', { operation: 'list' });
  const popup = popupList.windows.find(w => w.title === 'Computer locator popup' && w.processId === native.processId); assert.ok(popup);
  const confirm = await json('computer_act', { ...base, window_id: popup.id, locator: [{ automation_id: 'confirm' }], operation: 'invoke' });
  assert.equal(confirm.execution_state, 'completed');
  const closed = await json('computer_windows', { operation: 'list' }); assert.equal(closed.windows.some(w => w.title === 'Computer locator popup'), false);
  assert.match(await command('state'), /^actions:4;/); samples.popup = { separate_hwnd_observed: true, confirmed_once: true, closed_verified: true };
  console.log(JSON.stringify({ native_locator_tasks: 'passed', samples }, null, 2));
} finally {
  await mkdir(new URL('../.local/', import.meta.url), { recursive: true });
  await writeFile(new URL('../.local/locator-smoke-metrics.json', import.meta.url), JSON.stringify(samples, null, 2));
  await ctx.fiber.dispose(); await computer.dispose();
  if (child) { child.terminate(); await child.waitForExit(AbortSignal.timeout(3000)); }
  await runner.dispose(); loader.unregister(); await rm(directory, { recursive: true, force: true });
}
