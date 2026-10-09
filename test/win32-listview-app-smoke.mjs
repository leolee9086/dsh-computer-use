// 真实 Explorer 桌面 owner-data 拒绝和系统声音 ListView 验收。
// UIA 独立逐字核对消息文本；只关闭本测试启动的声音进程，不修改设备设置。
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
if (process.platform !== 'win32') throw new Error('Explorer ListView acceptance requires Windows');
const root = fileURLToPath(new URL('../', import.meta.url));
const harnessRoot = process.env.DSH_HARNESS_ROOT ?? resolve(root, '..', 'deepseek-harness');
const requireHarness = createRequire(resolve(harnessRoot, 'package.json'));
const { register } = await import(pathToFileURL(requireHarness.resolve('tsx/esm/api')).href);
const loader = register({ namespace: 'listview-app-smoke', tsconfig: resolve(harnessRoot, 'tsconfig.json') });
const [{ Context }, { default: ToolRuntime }, { default: SystemPrompt }] = await Promise.all([
  loader.import('@deepseek-ai/cordis', import.meta.url), loader.import('@deepseek-ai/dsh-tools', import.meta.url), loader.import('@deepseek-ai/dsh-system-prompt', import.meta.url),
]);
const directory = await mkdtemp(join(tmpdir(), 'dsh-listview-app-'));
const helper = join(directory, 'dsh-screen.exe');
const source = process.env.DSH_LISTVIEW_HELPER ?? resolve(root, 'native/target/release/dsh-screen.exe');
await copyFile(source, helper);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const helperHash = hash(await readFile(helper)); assert.equal(helperHash, hash(await readFile(source)));
const runner = await createManagedRunner(), computer = new WindowsComputer(runner, { nativeHelperPath: helper });
const ctx = new Context(), agent = { options: {}, session: {} }, samples = {};
let launchedApp;
let calls = 0;
const execute = (name, args) => ctx.tools.execute({ signal: new AbortController().signal, callId: `listview-app-${++calls}`, name, arguments: args, agent });
const json = async (name, args) => { const result = await execute(name, args); assert.equal(result.isError, false, JSON.stringify(result)); return JSON.parse(result.value); };
const flatten = tree => [tree, ...(tree.children ?? []).flatMap(flatten)];
const identity = record => ({ id: record.id, processId: record.processId, title: record.title });
try {
  await ctx.plugin(SystemPrompt); await ctx.plugin(ToolRuntime); ctx.provide('computer', computer);
  await ctx.plugin({ name: 'listview-app-probe', inject: ['tools', 'computer'], apply: scope => applyTools(scope, { observeApproval: 'allow', controlApproval: 'deny' }) });
  const before = await computer.listWindows();
  samples.foregroundBefore = before.filter(window => window.focused).map(identity);
  // Program Manager 是本次机器真正的 Explorer 顶层窗口，身份必须来自同一次新目录。
  const desktop = (await json('computer_windows', { operation: 'list' })).windows.find(window => window.application === 'explorer' && window.title === 'Program Manager');
  assert.ok(desktop, 'the actual Explorer desktop must be listed'); samples.desktop = desktop;
  const children = await json('computer_windows', { operation: 'children', window_id: desktop.id, max_nodes: 512 });
  samples.directory = children; assert.equal(children.truncated, false);
  const list = children.windows.find(window => window.className === 'SysListView32' && window.visible);
  assert.ok(list, 'actual desktop must expose a standard ListView');
  const desktopOutput = await execute('computer_read_control', { child_window_id: list.id, columns: [0] });
  samples.desktopOwnerData = desktopOutput; assert.equal(desktopOutput.isError, true); assert.match(JSON.stringify(desktopOutput), /unsupported_owner_data/);
  // 打开系统自带的声音对话框，使用当前进程权限；这是实际 mmsys 应用而非夹具。
  // 只创建这一临时查看窗口，不提升权限，也不修改设备/系统设置。
  const systemDirectory = join(process.env.WINDIR ?? 'C:\\Windows', 'System32');
  const command = [join(systemDirectory, 'rundll32.exe'), 'shell32.dll,Control_RunDLL', join(systemDirectory, 'mmsys.cpl')];
  launchedApp = runner.start(command); launchedApp.stdin.end(); samples.launch = { command };
  let app;
  const readyDeadline = performance.now() + 10000;
  while (performance.now() < readyDeadline) {
    const listing = await json('computer_windows', { operation: 'list' });
    app = listing.windows.find(window => window.application === 'rundll32' && window.title === '声音');
    if (app) break;
    await delay(100);
  }
  assert.ok(app, 'the actual Sound dialog must become visible'); samples.app = app;
  samples.foregroundBefore = (await computer.listWindows()).filter(window => window.focused).map(identity);
  const appChildren = await json('computer_windows', { operation: 'children', window_id: app.id, max_nodes: 512 });
  samples.appDirectory = appChildren; assert.equal(appChildren.truncated, false);
  const appList = appChildren.windows.find(window => window.className === 'SysListView32' && window.visible);
  assert.ok(appList);
  const request = { columns: [0], max_rows: 512, max_chars: 262144, timeout_ms: 10000 };
  const result = await json('computer_read_control', { child_window_id: appList.id, ...request });
  samples.listView = result; assert.ok(result.rowCount > 0, JSON.stringify(result)); assert.equal(result.coverage, 'complete'); assert.equal(result.remoteBufferQuarantined, false);
  const semantic = await json('computer_accessibility', { window_id: app.id, backend: 'uia' });
  samples.semantic = semantic;
  const names = new Set(flatten(semantic.tree).map(element => element.name));
  const missing = result.rows.map(row => row.cells[0].text).filter(text => !names.has(text));
  assert.deepEqual(missing, [], 'standard message text must agree with actual UIA names');
  const freshApp = (await json('computer_windows', { operation: 'list' })).windows.find(window => window.application === app.application && window.title === app.title && window.processId === app.processId);
  assert.ok(freshApp); const freshChildren = await json('computer_windows', { operation: 'children', window_id: freshApp.id, max_nodes: 512 });
  const freshList = freshChildren.windows.find(window => window.className === 'SysListView32' && window.visible);
  assert.ok(freshList);
  const afterRead = await json('computer_read_control', { child_window_id: freshList.id, ...request });
  samples.afterRead = afterRead;
  assert.deepEqual(afterRead.rows, result.rows); assert.equal(afterRead.selectedCount, result.selectedCount); assert.equal(afterRead.focusedRow, result.focusedRow);
  samples.foregroundAfter = (await computer.listWindows()).filter(window => window.focused).map(identity);
  assert.deepEqual(samples.foregroundAfter, samples.foregroundBefore, 'read-only acceptance must preserve the real foreground window');
  await mkdir(resolve(root, '.local'), { recursive: true });
  await writeFile(resolve(root, '.local/listview-app-metrics.json'), JSON.stringify({ observedAt: new Date().toISOString(), runtime: { electron: process.versions.electron ?? null, node: process.versions.node, modules: process.versions.modules }, helperSha256: helperHash, samples }, null, 2));
  console.log(JSON.stringify({ actualApplication: app.application, rowCount: result.rowCount, uiaNamesMatched: result.rows.length, selectedCount: result.selectedCount, focusedRow: result.focusedRow, foregroundPreserved: true, helperSha256: helperHash }));
} catch (error) {
  await mkdir(resolve(root, '.local'), { recursive: true });
  await writeFile(resolve(root, '.local/listview-app-uia-failure.json'), JSON.stringify({ error: String(error.stack), helperSha256: helperHash, samples }, null, 2)); throw error;
} finally {
  if (launchedApp) { launchedApp.terminate(); await launchedApp.done; }
  await ctx.fiber.dispose(); await runner.dispose(); await loader.unregister(); await rm(directory, { recursive: true, force: true });
}
