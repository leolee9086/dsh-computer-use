// 实际系统声音应用：同节点 OR/NOT/regex -> 一次选择 -> 独立读回 -> Cancel 并确认关闭。
// 每次动作重新列自己的新窗口；证据仅保留这个实例，不保存整机窗口目录。
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WindowsComputer } from '../src/windows.js';
import { apply as applyTools } from '../src/tool.js';
import { createManagedRunner } from './win32-runner.mjs';

if (process.platform !== 'win32') throw new Error('locator application acceptance requires Windows');
const root = fileURLToPath(new URL('../', import.meta.url));
const harnessRoot = process.env.DSH_HARNESS_ROOT ?? resolve(root, '..', 'deepseek-harness');
const requireHarness = createRequire(resolve(harnessRoot, 'package.json'));
const { register } = await import(pathToFileURL(requireHarness.resolve('tsx/esm/api')).href);
const loader = register({ namespace: 'locator-app-smoke', tsconfig: resolve(harnessRoot, 'tsconfig.json') });
const [{ Context }, { default: ToolRuntime }, { default: SystemPrompt }] = await Promise.all([
  loader.import('@deepseek-ai/cordis', import.meta.url), loader.import('@deepseek-ai/dsh-tools', import.meta.url), loader.import('@deepseek-ai/dsh-system-prompt', import.meta.url),
]);
const runner = await createManagedRunner(), computer = new WindowsComputer(runner, { semanticWorkerCount: 1 });
const ctx = new Context(), agent = { options: {}, session: {} };
const evidence = { observedAt: new Date().toISOString(), fullAcceptance: false, actualApplication: 'mmsys.cpl',
  runtime: { electron: process.versions.electron, node: process.versions.node, abi: process.versions.modules }, sources: {}, observations: [], samples: {} };
let appProcess, app, calls = 0, completed = false;
const execute = (name, args) => ctx.tools.execute({ signal: new AbortController().signal, callId: `locator-app-${++calls}`, name, arguments: args, agent });
const json = async (name, args) => {
  const result = await execute(name, args); assert.equal(result.isError, false, JSON.stringify(result));
  return JSON.parse(result.value);
};
const flatten = tree => [tree, ...(tree.children ?? []).flatMap(flatten)];
// .NET 也支持这些转义；用 \A/\z 对整个实际名称做边界匹配，而非 JS 的 ^/$。
const literalRegex = value => `\\A${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\z`;
const directory = async () => {
  const listing = await json('computer_windows', { operation: 'list' });
  if (app) evidence.observations.push({ surface: 'native-windows', callId: `locator-app-${calls}`,
    windows: listing.windows.filter(window => window.native_id === app.native_id && window.processId === app.processId) });
  return listing.windows;
};
const fresh = async () => {
  const window = (await directory()).find(window => window.native_id === app.native_id && window.processId === app.processId && window.title === app.title);
  assert.ok(window, 'the fixed new Sound instance must still exist');
  return { window_id: window.id, backend: 'uia', timeout_ms: 10000 };
};
try {
  for (const source of ['src/locator.js', 'src/windows-semantic-locator.cs', 'test/win32-locator-app-smoke.mjs']) {
    evidence.sources[source] = createHash('sha256').update(await readFile(resolve(root, source))).digest('hex');
  }
  await ctx.plugin(SystemPrompt); await ctx.plugin(ToolRuntime); ctx.provide('computer', computer);
  await ctx.plugin({ name: 'locator-app-probe', inject: ['tools', 'computer'], apply: scope => applyTools(scope, { observeApproval: 'allow', controlApproval: 'allow' }) });
  const oldWindows = await computer.listWindows();
  const system = join(process.env.WINDIR ?? 'C:\\Windows', 'System32');
  appProcess = runner.start([join(system, 'rundll32.exe'), 'shell32.dll,Control_RunDLL', join(system, 'mmsys.cpl')]); appProcess.stdin.end();
  const deadline = performance.now() + 10000;
  while (performance.now() < deadline) {
    app = (await directory()).find(window => window.application === 'rundll32' && window.title === '声音' && !oldWindows.some(old => old.id === window.native_id));
    if (app) break; await delay(100);
  }
  assert.ok(app, 'a newly launched actual Sound dialog must be observed'); evidence.app = app;
  const observed = await json('computer_accessibility', { window_id: (await fresh()).window_id, backend: 'uia' });
  evidence.samples.initial = observed;
  const rows = flatten(observed.tree);
  const devices = rows.filter(element => element.role === 'ListItem' && element.enabled && element.patterns?.includes('selection_item'));
  const unique = devices.filter(device => devices.filter(other => other.name === device.name).length === 1);
  assert.ok(unique.length >= 2, 'actual acceptance requires two distinct uniquely named device rows');
  const [first, second] = unique;
  const either = [{ role: 'ListItem', where: { any: [{ name: first.name }, { name: second.name }] } }];
  const ambiguous = await json('computer_locate', { ...await fresh(), locator: either });
  assert.equal(ambiguous.status, 'ambiguous'); assert.equal(ambiguous.candidates.length, 2);
  assert.equal(new Set(ambiguous.candidates.map(element => element.element_id)).size, 2);
  assert.deepEqual(new Set(ambiguous.candidates.map(element => element.name)), new Set([first.name, second.name]));
  evidence.samples.ambiguous = ambiguous;
  const overlap = [{ role: 'ListItem', where: { any: [{ name: first.name }, { name: literalRegex(first.name), match: 'regex' }] } }];
  const overlapping = await json('computer_locate', { ...await fresh(), locator: overlap });
  assert.equal(overlapping.status, 'resolved'); assert.equal(overlapping.element.name, first.name);
  assert.equal(overlapping.trace.at(-1).matches, 1); assert.equal(overlapping.coverage.status, 'complete');
  evidence.samples.overlap = overlapping;
  const target = [{ role: 'ListItem', where: { all: [either[0].where, { not: { name: second.name } }] } }];
  const excluded = await json('computer_locate', { ...await fresh(), locator: target });
  assert.equal(excluded.status, 'resolved'); assert.equal(excluded.element.name, first.name);
  assert.equal(excluded.trace.at(-1).matches, 1); evidence.samples.not = excluded;
  const selectionBase = await fresh();
  evidence.samples.selectEvidence = { surface: 'native-windows', window_id: selectionBase.window_id, callId: `locator-app-${calls}` };
  const selected = await json('computer_act', { ...selectionBase, locator: target, operation: 'select',
    after: { condition: { state: 'selected', value: true } } });
  assert.equal(selected.execution_state, 'completed'); assert.equal(selected.postcondition.fulfilled, true);
  evidence.samples.selected = selected;
  // 动作之后重新观察并取得新元素引用，再独立读取 SelectionItem，不沿用动作前的 snapshot。
  const readback = await json('computer_locate', { ...await fresh(), locator: overlap });
  assert.equal(readback.status, 'resolved'); assert.equal(readback.element.name, first.name);
  const state = await json('computer_read', { snapshot_id: readback.snapshot_id, element_id: readback.element.element_id });
  assert.equal(state.result.selected, true);
  evidence.samples.readback = { locator: readback, state };
  const cancels = rows.filter(element => element.role === 'Button' && element.automation_id === '2' && element.name === '取消');
  assert.equal(cancels.length, 1);
  const quitBase = await fresh();
  evidence.samples.cancelEvidence = { surface: 'native-windows', window_id: quitBase.window_id, callId: `locator-app-${calls}` };
  const quit = await json('computer_act', { ...quitBase, locator: [{ role: 'Button', automation_id: '2', name: '取消' }], operation: 'invoke' });
  assert.equal(quit.execution_state, 'completed'); evidence.samples.quit = quit;
  const closeDeadline = performance.now() + 5000;
  let closed = false;
  while (performance.now() < closeDeadline) {
    closed = !(await directory()).some(window => window.native_id === app.native_id && window.processId === app.processId);
    if (closed) break; await delay(100);
  }
  assert.equal(closed, true, 'Cancel must actually close this new Sound instance');
  evidence.samples.closed = true; completed = true;
} catch (error) {
  evidence.failure = { message: error.message, stack: error.stack }; throw error;
} finally {
  await ctx.fiber.dispose(); await computer.dispose();
  if (appProcess) { appProcess.terminate(); assert.equal(await appProcess.waitForExit(AbortSignal.timeout(3000)), true, 'own launch process exit must be observed'); }
  await runner.dispose(); loader.unregister();
  // 通过与否在清理后落盘；外层 Electron 还要独立核对 after-cleanup 完成标记。
  evidence.fullAcceptance = completed;
  await mkdir(resolve(root, '.local'), { recursive: true });
  const name = completed ? 'locator-0.5.15-app-metrics.json' : `locator-0.5.15-app-failure-${evidence.observedAt.replace(/[^0-9]/g, '')}.json`;
  await writeFile(resolve(root, '.local', name), JSON.stringify(evidence, null, 2));
}
console.log(JSON.stringify({ actualApplication: evidence.actualApplication, fullAcceptance: evidence.fullAcceptance,
  overlapping_or_one_match: true, separate_nodes_ambiguous: true, not_excluded_other_node: true,
  selected_and_independently_read: true, own_window_closed: true, selectEvidence: evidence.samples.selectEvidence, cancelEvidence: evidence.samples.cancelEvidence }));
