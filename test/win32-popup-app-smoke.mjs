// 系统声音应用的真实设备属性对话框：只选择查看对象、打开属性、读取、取消。
// 真正 ToolRuntime/WindowsComputer/官方 runner；新根必须是固定 Sound anchor 的实际 owned 窗口。
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, copyFile, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WindowsComputer } from '../src/windows.js';
import { apply as applyTools } from '../src/tool.js';
import { createManagedRunner } from './win32-runner.mjs';
if (process.platform !== 'win32') throw new Error('popup application acceptance requires Windows');
const root = fileURLToPath(new URL('../', import.meta.url));
const harnessRoot = process.env.DSH_HARNESS_ROOT ?? resolve(root, '..', 'deepseek-harness');
const requireHarness = createRequire(resolve(harnessRoot, 'package.json'));
const { register } = await import(pathToFileURL(requireHarness.resolve('tsx/esm/api')).href);
const loader = register({ namespace: 'popup-app-smoke', tsconfig: resolve(harnessRoot, 'tsconfig.json') });
const [{ Context }, { default: ToolRuntime }, { default: SystemPrompt }] = await Promise.all([
  loader.import('@deepseek-ai/cordis', import.meta.url), loader.import('@deepseek-ai/dsh-tools', import.meta.url), loader.import('@deepseek-ai/dsh-system-prompt', import.meta.url),
]);
const directory = await mkdtemp(join(tmpdir(), 'dsh-popup-app-')), helper = join(directory, 'dsh-screen.exe');
const source = process.env.DSH_POPUP_HELPER ?? resolve(root, 'native/target/release/dsh-screen.exe');
await copyFile(source, helper);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const helperSha256 = hash(await readFile(helper)); assert.equal(helperSha256, hash(await readFile(source)));
const runner = await createManagedRunner(), computer = new WindowsComputer(runner, { nativeHelperPath: helper });
const ctx = new Context(), agent = { options: {}, session: {} }, samples = { iterations: [] };
let appProcess, calls = 0;
const execute = (name, args) => ctx.tools.execute({ signal: new AbortController().signal, callId: `popup-app-${++calls}`, name, arguments: args, agent });
const json = async (name, args) => { const result = await execute(name, args); assert.equal(result.isError, false, JSON.stringify(result)); return JSON.parse(result.value); };
const flatten = tree => [tree, ...(tree.children ?? []).flatMap(flatten)];
const locator = element => [{ name: element.name, role: element.role, ...(element.automation_id ? { automation_id: element.automation_id } : {}) }];
try {
  await ctx.plugin(SystemPrompt); await ctx.plugin(ToolRuntime); ctx.provide('computer', computer);
  await ctx.plugin({ name: 'popup-app-probe', inject: ['tools', 'computer'], apply: scope => applyTools(scope, { observeApproval: 'allow', controlApproval: 'allow' }) });
  const oldWindows = await computer.listWindows();
  const system = join(process.env.WINDIR ?? 'C:\\Windows', 'System32');
  const command = [join(system, 'rundll32.exe'), 'shell32.dll,Control_RunDLL', join(system, 'mmsys.cpl')];
  appProcess = runner.start(command); appProcess.stdin.end(); samples.launch = { command };
  let app;
  const deadline = performance.now() + 10000;
  while (performance.now() < deadline) {
    const listing = await json('computer_windows', { operation: 'list' });
    app = listing.windows.find(window => window.application === 'rundll32' && window.title === '声音' && !oldWindows.some(old => old.id === window.native_id));
    if (app) break; await delay(100);
  }
  assert.ok(app, 'a newly launched actual Sound dialog must be observed'); samples.app = app;
  const fresh = async () => {
    const listing = await json('computer_windows', { operation: 'list' });
    const window = listing.windows.find(window => window.native_id === app.native_id && window.processId === app.processId && window.title === app.title);
    assert.ok(window, JSON.stringify(listing)); return { window_id: window.id, backend: 'uia', timeout_ms: 10000 };
  };
  const observed = await json('computer_accessibility', { window_id: (await fresh()).window_id, backend: 'uia' });
  samples.initial = observed;
  const rows = flatten(observed.tree);
  const devices = rows.filter(element => element.role === 'ListItem' && element.enabled && element.patterns?.includes('selection_item'));
  assert.ok(devices.length > 0);
  // 明确选择本次观察到的一个设备用于只读查看；完整名称/ID必须能唯一解析。
  const device = devices[0], deviceLocator = locator(device);
  assert.equal(devices.filter(element => element.name === device.name && element.automation_id === device.automation_id).length, 1);
  const properties = rows.filter(element => element.role === 'Button' && element.automation_id === '1003');
  assert.equal(properties.length, 1); const propertiesLocator = locator(properties[0]);
  samples.device = device;
  samples.selected = await json('computer_act', { ...await fresh(), locator: deviceLocator, operation: 'select',
    after: { locator: propertiesLocator, condition: { state: 'enabled' } } });
  assert.equal(samples.selected.execution_state, 'completed'); assert.equal(samples.selected.postcondition.fulfilled, true);
  const query = { relation: 'owned', class_name: '#32770' }, cancel = [{ role: 'Button', automation_id: '2', name: '取消' }];
  for (let iteration = 1; iteration <= 2; iteration++) {
    const base = await fresh();
    // 真实 Win32 模态属性的 UIA Invoke 曾阻塞至 worker 截止并返回 unknown，原失败证据单独保留。
    // 本次新 Sound 实例明确用观测到的 属性(P) 助记键；输入交付与新 owned 根确认分别核对。
    assert.match(properties[0].name, /\(P\)$/);
    const input = await execute('computer_key', { window_id: base.window_id, key: 'p', modifiers: ['alt'] });
    samples.iterations.push({ input }); assert.equal(input.isError, false, JSON.stringify(input));
    const opened = await json('computer_wait', { ...await fresh(), window_query: query, locator: cancel, condition: { state: 'present' } });
    samples.iterations.at(-1).opened = opened;
    assert.equal(opened.fulfilled, true, JSON.stringify(opened));
    const last = opened.last, popup = last.related.windows[0];
    assert.equal(last.related.coverage, 'complete'); assert.equal(last.related.windows.length, 1);
    assert.equal(popup.processId, app.processId); assert.ok(popup.ownerChain.includes(app.native_id)); assert.notEqual(popup.native_id, app.native_id);
    const contents = await json('computer_accessibility', { window_id: last.window_id, backend: 'uia' });
    samples.iterations.at(-1).contents = contents;
    assert.ok(flatten(contents.tree).some(element => element.role === 'TabItem'), 'actual device property pages must be read');
    const closed = await json('computer_act', { ...await fresh(), window_query: query, locator: cancel, operation: 'invoke',
      after: { window_query: query, locator: cancel, condition: { state: 'absent' } } });
    samples.iterations.at(-1).closed = closed;
    assert.equal(closed.execution_state, 'completed'); assert.equal(closed.postcondition.fulfilled, true); assert.equal(closed.postcondition.last.related.coverage, 'complete');
    const readback = await json('computer_locate', { ...await fresh(), locator: deviceLocator });
    assert.equal(readback.status, 'resolved'); assert.equal(readback.element.name, device.name);
    samples.iterations.at(-1).readback = readback;
  }
  // 两轮查看都 Cancel；主窗口也只 Cancel，不 Apply/OK。
  const quit = await json('computer_act', { ...await fresh(), locator: cancel, operation: 'invoke' });
  assert.equal(quit.execution_state, 'completed'); samples.quit = quit;
  await mkdir(resolve(root, '.local'), { recursive: true });
  await writeFile(resolve(root, '.local/popup-app-metrics.json'), JSON.stringify({ observedAt: new Date().toISOString(), runtime: { electron: process.versions.electron ?? null, node: process.versions.node, modules: process.versions.modules }, helperSha256, samples }, null, 2));
  console.log(JSON.stringify({ actualApplication: 'mmsys.cpl', propertyDialogs: samples.iterations.length, ownedRootVerified: true, closeAndReadbackVerified: true, helperSha256 }));
} catch (error) {
  await mkdir(resolve(root, '.local'), { recursive: true });
  await writeFile(resolve(root, '.local/popup-app-failure.json'), JSON.stringify({ error: String(error.stack), helperSha256, samples }, null, 2)); throw error;
} finally {
  if (appProcess) { appProcess.terminate(); await appProcess.done; }
  await ctx.fiber.dispose(); await runner.dispose(); await loader.unregister(); await rm(directory, { recursive: true, force: true });
}
