// 四类真实 GUI 经生产 WindowsComputer/ToolRuntime/官方 runner；只用夹具 stdout 核对业务计数。
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { copyFile, mkdtemp, readdir, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WindowsComputer } from '../src/windows.js';
import { apply as applyTools } from '../src/tool.js';
import { createManagedRunner } from './win32-runner.mjs';
if (process.platform !== 'win32') throw new Error('popup acceptance requires Windows');
const root = fileURLToPath(new URL('../', import.meta.url));
const harnessRoot = process.env.DSH_HARNESS_ROOT ?? resolve(root, '..', 'deepseek-harness');
const requireHarness = createRequire(resolve(harnessRoot, 'package.json'));
const { register } = await import(pathToFileURL(requireHarness.resolve('tsx/esm/api')).href);
const loader = register({ namespace: 'popup-smoke', tsconfig: resolve(harnessRoot, 'tsconfig.json') });
const [{ Context }, { default: ToolRuntime }, { default: SystemPrompt }] = await Promise.all([
  loader.import('@deepseek-ai/cordis', import.meta.url), loader.import('@deepseek-ai/dsh-tools', import.meta.url), loader.import('@deepseek-ai/dsh-system-prompt', import.meta.url),
]);
const directory = await mkdtemp(join(tmpdir(), 'dsh-popup-')), helper = join(directory, 'dsh-screen.exe');
const source = process.env.DSH_POPUP_HELPER ?? resolve(root, 'native/target/release/dsh-screen.exe');
await copyFile(source, helper);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const helperSha256 = sha256(await readFile(helper)); assert.equal(helperSha256, sha256(await readFile(source)));
const runner = await createManagedRunner(), computer = new WindowsComputer(runner, { nativeHelperPath: helper });
const ctx = new Context(), agent = { options: {}, session: {} }, samples = {};
const allModes = ['native', 'forms', 'wpf', 'external'];
// 可隔离某一真实 provider 排错；最终验收仍须不设筛选、完整跑四类。
const modes = process.env.DSH_POPUP_MODES === undefined ? allModes : process.env.DSH_POPUP_MODES.split(',');
assert.ok(modes.length > 0 && modes.every(mode => allModes.includes(mode)) && new Set(modes).size === modes.length, 'DSH_POPUP_MODES must contain distinct known modes');
const fullAcceptance = modes.length === allModes.length;
let fixture, nextLine, calls = 0;
function lines(stream) {
  let buffer = ''; const queued = [], pending = [];
  stream.setEncoding('utf8'); stream.on('data', chunk => {
    buffer += chunk; let end;
    while ((end = buffer.indexOf('\n')) >= 0) { const line = buffer.slice(0, end).trim(); buffer = buffer.slice(end + 1);
      if (pending.length) pending.shift()(line); else queued.push(line); }
  });
  return () => queued.length ? Promise.resolve(queued.shift()) : Promise.race([new Promise(done => pending.push(done)),
    new Promise((_done, reject) => { const timer = setTimeout(() => reject(new Error('popup fixture response deadline')), 10000); timer.unref(); })]);
}
async function command(text) { fixture.stdin.write(`${text}\n`); return JSON.parse(await nextLine()); }
const execute = (name, args, signal = new AbortController().signal) => ctx.tools.execute({ signal, callId: `popup-${++calls}`, name, arguments: args, agent });
const json = async (name, args, signal) => { const result = await execute(name, args, signal); assert.equal(result.isError, false, JSON.stringify(result)); return JSON.parse(result.value); };
async function gac(name) {
  for (const architecture of ['GAC_MSIL', 'GAC_64', 'GAC_32']) {
    const path = join(process.env.WINDIR ?? 'C:\\Windows', 'Microsoft.NET', 'assembly', architecture, name);
    if (!existsSync(path)) continue;
    const result = (await readdir(path)).map(version => join(path, version, `${name}.dll`)).find(existsSync);
    if (result) return result;
  }
  throw new Error(`assembly ${name} unavailable`);
}
try {
  const compiler = join(process.env.WINDIR ?? 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
  const executable = join(directory, 'fixture.exe');
  const refs = await Promise.all(['PresentationFramework', 'PresentationCore', 'WindowsBase', 'UIAutomationClient', 'UIAutomationTypes'].map(gac));
  await runner.run([compiler, '/nologo', '/noconfig', '/target:exe', `/out:${executable}`, '/r:System.dll', '/r:System.Core.dll', '/r:System.Xaml.dll', '/r:System.Drawing.dll', '/r:System.Windows.Forms.dll', '/r:System.Web.Extensions.dll',
    ...refs.map(path => `/r:${path}`), resolve(root, 'test/windows-popup-fixture.cs')]);
  await ctx.plugin(SystemPrompt); await ctx.plugin(ToolRuntime); ctx.provide('computer', computer);
  await ctx.plugin({ name: 'popup-probe', inject: ['tools', 'computer'], apply: scope => applyTools(scope, { observeApproval: 'allow', controlApproval: 'allow' }) });
  for (const mode of modes) {
    const title = `Computer popup ${mode} ${Date.now()}`;
    fixture = runner.start([executable, mode, title]); nextLine = lines(fixture.stdout);
    const ready = JSON.parse(await nextLine()); samples[mode] = { ready, iterations: [] };
    const fresh = async () => {
      const listing = await json('computer_windows', { operation: 'list' });
      const window = listing.windows.find(window => window.native_id === ready.hwnd && window.processId === ready.pid && window.title === title);
      assert.ok(window, JSON.stringify(listing)); return { window_id: window.id, backend: 'uia', timeout_ms: 10000 };
    };
    samples[mode].initial = await json('computer_accessibility', { window_id: (await fresh()).window_id, backend: 'uia' });
    const query = mode === 'external' ? { relation: 'owned', title: `${title} dialog` } : { relation: 'same_thread', title: '', ...(mode === 'native' ? { class_name: '#32768' } : {}) };
    const item = [{ name: { native: 'Run native item', forms: 'Run forms item', wpf: 'Run WPF item', external: 'Confirm external' }[mode], ...(mode === 'wpf' ? { role: 'Button', automation_id: 'popup-item' } : {}) }];
    for (let iteration = 1; iteration <= 2; iteration++) {
      // Win32 菜单循环需要宿主位于前台；先用真实已列窗口聚焦，再重新观测。
      const focused = await execute('computer_windows', { operation: 'focus', window_id: (await fresh()).window_id });
      assert.equal(focused.isError, false, JSON.stringify(focused));
      const base = await fresh();
      const open = await json('computer_act', { ...base, locator: [{ name: 'Open menu', role: 'Button' }], operation: 'invoke',
        after: { window_query: query, locator: item, condition: { state: 'present' } } });
      samples[mode].iterations.push({ open, stateAfterOpen: await command('state') });
      assert.equal(open.execution_state, 'completed', JSON.stringify(open));
      let resolution = open.postcondition;
      if (mode === 'forms' && iteration === 1) {
        // 真正 ToolStripDropDown 还会创建独立 SysShadow；保留歧义证据后按观测到的完整类名细化。
        const related = resolution.last?.related;
        assert.equal(related?.coverage, 'complete', JSON.stringify(open));
        const controls = related.windows.filter(window => /^WindowsForms/.test(window.className));
        assert.equal(controls.length, 1, JSON.stringify(related));
        query.class_name = controls[0].className;
        resolution = await json('computer_wait', { ...await fresh(), window_query: query, locator: item, condition: { state: 'present' } });
        samples[mode].iterations.at(-1).refined = resolution;
      }
      assert.equal(resolution?.fulfilled, true, JSON.stringify(resolution));
      const last = resolution.last;
      assert.equal(last.related.coverage, 'complete'); assert.equal(last.related.windows.length, 1); assert.match(last.window_id, /^window-/);
      const popup = last.related.windows[0];
      if (mode === 'external') { assert.notEqual(popup.processId, ready.pid); assert.ok(popup.ownerChain.includes(ready.hwnd)); }
      else { assert.equal(popup.title, ''); assert.equal(popup.threadId, (await computer.listWindows()).find(window => window.id === ready.hwnd).threadId); }
      if (mode === 'native') assert.equal(popup.className, '#32768');
      if (mode === 'forms') assert.match(popup.className, /^WindowsForms/);
      if (mode === 'wpf') assert.match(popup.className, /^HwndWrapper/);
      const actionBase = await fresh();
      // Win32 菜单使用明确的 MSAA accDoDefaultAction；不在 UIA 失败后重放同一次动作。
      const action = await json('computer_act', { ...actionBase, backend: mode === 'native' ? 'msaa' : 'uia', window_query: query, locator: item, operation: 'invoke',
        after: { window_id: actionBase.window_id, locator: [{ name: `${mode} ${iteration}`, role: 'Text' }], condition: { state: 'present' } } });
      samples[mode].iterations.at(-1).action = action;
      // 失败也先落下业务计数，不能用 Invoke 返回值替代实际应用结果。
      const state = await command('state'); samples[mode].iterations.at(-1).state = state;
      samples[mode].iterations.at(-1).foregroundAfterAction = (await computer.listWindows()).filter(window => window.focused);
      assert.equal(action.execution_state, 'completed', JSON.stringify(action)); assert.equal(action.postcondition?.fulfilled, true, JSON.stringify(action));
      assert.equal(state.opens, iteration); assert.equal(mode === 'external' ? state.externalActions : state.actions, iteration);
      if (mode === 'native') {
        assert.equal(state.nativeCommands, iteration);
        assert.equal(state.nativeMenu.starts, iteration); assert.equal(state.nativeMenu.returns, iteration);
        assert.equal(state.nativeMenu.enters, iteration); assert.equal(state.nativeMenu.exits, iteration);
        assert.equal(state.nativeMenu.foregroundAtTrack, ready.hwnd);
      }
      const closed = await json('computer_wait', { ...await fresh(), window_query: query, locator: item, condition: { state: 'absent' } });
      assert.equal(closed.fulfilled, true); assert.equal(closed.last.coverage.status, 'complete');
      // 已关闭新根的旧语义凭据不能再控制菜单项。
      const replay = await execute('computer_element', { snapshot_id: last.snapshot_id, element_id: last.element.element_id, operation: 'invoke' });
      assert.equal(replay.isError, true); assert.deepEqual(await command('state'), state);
    }
    if (mode === 'forms' || mode === 'wpf') {
      assert.equal(await command('disable-next'), 'disabled');
      const opened = await json('computer_act', { ...await fresh(), locator: [{ name: 'Open menu', role: 'Button' }], operation: 'invoke',
        after: { window_query: query, locator: item, condition: { state: 'disabled' } } });
      assert.equal(opened.postcondition.fulfilled, true);
      assert.equal(await command('replace'), 'scheduled');
      const replaced = await json('computer_wait', { ...await fresh(), window_query: query, locator: item, condition: { state: 'enabled' }, poll_ms: 40 });
      samples[mode].replacement = { opened, replaced }; assert.equal(replaced.fulfilled, true); assert.ok(replaced.attempts > 1);
      assert.notEqual(replaced.last.element.element_id, opened.postcondition.last.element.element_id);
      const base = await fresh();
      const action = await json('computer_act', { ...base, window_query: query, locator: item, operation: 'invoke',
        after: { window_id: base.window_id, locator: [{ name: `${mode} 3` }], condition: { state: 'present' } } });
      assert.equal(action.postcondition.fulfilled, true); const state = await command('state');
      assert.equal(state.opens, 3); assert.equal(state.actions, 3); assert.equal(state.replacements, 1);
    }
    if (mode === 'forms') {
      assert.equal(await command('duplicates'), 'duplicates-open');
      const duplicateQuery = { relation: 'owned', title: `${title} duplicate` };
      const ambiguous = await json('computer_locate', { ...await fresh(), window_query: duplicateQuery, locator: [{ name: 'Wrong item' }] });
      assert.equal(ambiguous.status, 'ambiguous'); assert.equal(ambiguous.related.windows.length, 2); samples.forms.ambiguous = ambiguous;
      const before = await command('state');
      const denied = await execute('computer_act', { ...await fresh(), window_query: duplicateQuery, locator: [{ name: 'Wrong item' }], operation: 'invoke' });
      assert.equal(denied.isError, true); assert.deepEqual(await command('state'), before);
      assert.equal(await command('duplicates-close'), 'duplicates-closed');
      const partial = await json('computer_wait', { ...await fresh(), timeout_ms: 500, window_query: { relation: 'owned', max_windows: 1 }, locator: [{ name: 'Missing' }], condition: { state: 'absent' } });
      assert.equal(partial.fulfilled, false); assert.equal(partial.last.coverage.status, 'partial'); samples.forms.partial = partial;
      // 先取得固定 anchor，再启动取消计时，确保取消针对已经开始的等待。
      const cancelBase = await fresh(), cancellation = new AbortController();
      const timer = setTimeout(() => cancellation.abort(new Error('popup cancellation')), 100);
      try { const cancelled = await execute('computer_wait', { ...cancelBase, window_query: { relation: 'owned', max_windows: 1 }, locator: [{ name: 'Missing' }] }, cancellation.signal);
        assert.equal(cancelled.isError, true); samples.forms.cancelled = cancelled; }
      finally { clearTimeout(timer); }
      const stale = await fresh(); assert.equal(await command('rename'), 'renamed');
      const failed = await execute('computer_wait', { ...stale, window_query: { relation: 'owned' }, locator: [{ name: 'Missing' }], condition: { state: 'absent' } });
      assert.equal(failed.isError, true); samples.forms.sourceError = failed;
      assert.equal(await command('restore-title'), 'restored'); assert.deepEqual(await command('state'), before);
    }
    assert.equal(await command('quit'), 'quitting'); await fixture.done; fixture = undefined;
  }
  await mkdir(resolve(root, '.local'), { recursive: true });
  await writeFile(resolve(root, fullAcceptance ? '.local/popup-smoke-metrics.json' : `.local/popup-smoke-${modes.join('-')}-metrics.json`), JSON.stringify({ observedAt: new Date().toISOString(), fullAcceptance, runtime: { electron: process.versions.electron ?? null, node: process.versions.node, modules: process.versions.modules }, helperSha256, samples }, null, 2));
  console.log(JSON.stringify({ popupModes: Object.keys(samples), fullAcceptance, twoIterationsEach: true, replacement: modes.filter(mode => mode === 'forms' || mode === 'wpf'), ambiguity: modes.includes('forms'), partialNotAbsent: modes.includes('forms'), sourceErrorNotAbsent: modes.includes('forms'), helperSha256 }));
} catch (error) {
  await mkdir(resolve(root, '.local'), { recursive: true });
  await writeFile(resolve(root, '.local/popup-smoke-failure.json'), JSON.stringify({ error: String(error.stack), helperSha256, samples }, null, 2)); throw error;
} finally {
  if (fixture) { fixture.terminate(); await fixture.done; }
  await ctx.fiber.dispose(); await runner.dispose(); await loader.unregister(); await rm(directory, { recursive: true, force: true });
}
