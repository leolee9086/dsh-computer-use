// 真实 Windows 32/64 位 ListView、Cordis ToolRuntime、官方 ManagedRunner；没有服务 mock。
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, copyFile, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WindowsComputer } from '../src/windows.js';
import { apply as applyTools } from '../src/tool.js';
import { createManagedRunner } from './win32-runner.mjs';
if (process.platform !== 'win32') throw new Error('ListView smoke requires Windows');
const root = fileURLToPath(new URL('../', import.meta.url));
const harnessRoot = process.env.DSH_HARNESS_ROOT ?? resolve(root, '..', 'deepseek-harness');
const requireHarness = createRequire(resolve(harnessRoot, 'package.json'));
const { register } = await import(pathToFileURL(requireHarness.resolve('tsx/esm/api')).href);
const loader = register({ namespace: 'listview-task-smoke', tsconfig: resolve(harnessRoot, 'tsconfig.json') });
const [{ Context }, { default: ToolRuntime }, { default: SystemPrompt }] = await Promise.all([
  loader.import('@deepseek-ai/cordis', import.meta.url), loader.import('@deepseek-ai/dsh-tools', import.meta.url), loader.import('@deepseek-ai/dsh-system-prompt', import.meta.url),
]);
const directory = await mkdtemp(join(tmpdir(), 'dsh-listview-task-'));
const helper = join(directory, 'dsh-screen.exe');
const source = process.env.DSH_LISTVIEW_HELPER ?? resolve(root, 'native/target/release/dsh-screen.exe');
await copyFile(source, helper);
const hash = data => createHash('sha256').update(data).digest('hex');
const helperHash = hash(await readFile(helper)); assert.equal(helperHash, hash(await readFile(source)));
const runner = await createManagedRunner(), computer = new WindowsComputer(runner, { nativeHelperPath: helper });
const ctx = new Context(), samples = {}, active = new Set();
let calls = 0;
function lines(stream) {
  let buffer = ''; const queue = [], pending = [];
  stream.setEncoding('utf8'); stream.on('data', chunk => {
    buffer += chunk; let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const text = buffer.slice(0, end).trim(); buffer = buffer.slice(end + 1);
      if (pending.length) pending.shift()(text); else queue.push(text);
    }
  });
  return () => queue.length ? Promise.resolve(queue.shift()) : Promise.race([
    new Promise(done => pending.push(done)), new Promise((_done, reject) => { const timer = setTimeout(() => reject(new Error('ListView fixture line deadline')), 10000); timer.unref(); }),
  ]);
}
const execute = (name, args, signal = new AbortController().signal) => ctx.tools.execute({ signal, callId: `listview-${++calls}`, name, arguments: args, agent });
const json = async (name, args, signal) => { const out = await execute(name, args, signal); assert.equal(out.isError, false, JSON.stringify(out)); return JSON.parse(out.value); };
const agent = { options: {}, session: {} };
async function fixture(executable) {
  const process = runner.start([executable]), next = lines(process.stdout); active.add(process);
  const hwnd = await next(); assert.match(hwnd, /^\d+$/);
  const command = async text => { process.stdin.write(`${text}\n`); return next(); };
  const info = await command('info'); const pid = Number(info.match(/;pid:(\d+);/)[1]);
  samples['fixture-ready'] = { hwnd, pid, info };
  return { process, hwnd, pid, next, command, async close() { await command('close'); assert.equal((await process.done).exitCode, 0); active.delete(process); } };
}
async function directoryFor(current) {
  const listing = await json('computer_windows', { operation: 'list' });
  const candidates = listing.windows.filter(w => w.processId === current.pid || w.title.startsWith('DSH Standard ListView Fixture'));
  samples['fixture-directory'] = { bits: current.bits, pid: current.pid, hwnd: current.hwnd, candidates };
  const window = candidates.find(w => w.title === `DSH Standard ListView Fixture ${current.bits}`);
  assert.ok(window, `fixture listed through ToolRuntime: ${JSON.stringify(samples['fixture-directory'])}`);
  const listed = await json('computer_windows', { operation: 'children', window_id: window.id });
  assert.equal(listed.truncated, false);
  assert.ok(listed.windows.some(w => w.className === 'Static' && w.title === 'Zero area helper' && w.bounds.width === 0 && w.bounds.height === 0), 'zero-area HWND remains in the directory');
  const managed = listed.windows.find(w => w.className.startsWith('WindowsForms10.SysListView32.') && w.bounds.width === 550);
  const native = listed.windows.find(w => w.className === 'SysListView32');
  const owner = listed.windows.find(w => w.className.startsWith('WindowsForms10.SysListView32.') && w.bounds.width === 200);
  const panel = listed.windows.find(w => w.className.startsWith('WindowsForms10.Window.') && w.bounds.width === 180);
  assert.ok(managed && native && owner && panel, JSON.stringify(listed));
  return { window, listed, managed, native, owner, panel };
}
const read = (record, options = {}, signal) => json('computer_read_control', { child_window_id: record.id, columns: [2, 0], ...options }, signal);
async function collect(key, current, record, options) {
  const before = await current.command('state'), started = performance.now();
  const result = await read(record, options);
  const after = await current.command('state'); assert.match(after, /;inputs:0;/);
  samples[key] = { surface: 'native standard ListView', child_window_id: record.id, options, result, before, after, wallMs: Math.round(performance.now() - started) };
  return result;
}
try {
  await ctx.plugin(SystemPrompt); await ctx.plugin(ToolRuntime); ctx.provide('computer', computer);
  await ctx.plugin({ name: 'listview-task-probe', inject: ['tools', 'computer'], apply: scope => applyTools(scope, { observeApproval: 'allow', controlApproval: 'deny' }) });
  const compiler = join(process.env.WINDIR ?? 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
  const executables = {};
  for (const bits of [64, 32]) {
    const executable = join(directory, `fixture-${bits}.exe`); executables[bits] = executable;
    await runner.run([compiler, '/nologo', '/noconfig', '/target:exe', `/platform:${bits === 64 ? 'x64' : 'x86'}`, `/out:${executable}`,
      '/r:System.dll', '/r:System.Core.dll', '/r:System.Drawing.dll', '/r:System.Windows.Forms.dll', resolve(root, 'test/windows-listview-fixture.cs')]);
  }
  for (const bits of [64, 32]) {
    const current = await fixture(executables[bits]); current.bits = bits;
    let observed = await directoryFor(current);
    const denied = await execute('computer_key', { window_id: observed.window.id, keys: ['space'] }); assert.equal(denied.isError, true);
    samples[`${bits}-control-denied`] = denied;
    const full = await collect(`${bits}-managed-columns`, current, observed.managed, {});
    assert.equal(full.coverage, 'complete'); assert.equal(full.targetBits, bits); assert.equal(full.rowCount, 6); assert.equal(full.columnCount, 3);
    assert.equal(full.selectedCount, 2); assert.equal(full.focusedRow, 3); assert.equal(full.nextRow, 6);
    assert.deepEqual(full.rows[0].cells.map(cell => [cell.column, cell.text]), [[2, 'tail 0'], [0, 'managed 0']]);
    assert.deepEqual(full.rows.filter(row => row.selected).map(row => row.index), [1, 3]);
    const unicode = await collect(`${bits}-unicode`, current, observed.managed, { columns: [1], start_row: 2, max_rows: 1 });
    assert.equal(unicode.rows[0].cells[0].text, '中文🙂');
    const unicodePrefix = await collect(`${bits}-unicode-budget-boundary`, current, observed.managed, { columns: [1], start_row: 2, max_rows: 1, max_cell_chars: 3 });
    assert.equal(unicodePrefix.stopReason, 'cell_text_limit'); assert.equal(unicodePrefix.rows[0].cells[0].text, '中文');
    assert.equal(unicodePrefix.rows[0].cells[0].complete, false); assert.equal(unicodePrefix.charsRead, 2); assert.equal(unicodePrefix.nextRow, 2);
    const native = await collect(`${bits}-native-class`, current, observed.native, { columns: [1, 0] });
    assert.equal(native.coverage, 'complete'); assert.equal(native.targetBits, bits); assert.equal(native.selectedCount, 1); assert.equal(native.focusedRow, 2);
    assert.deepEqual(native.rows[0].cells.map(cell => cell.text), ['native-0-1', '原生行 0']);
    const page = await collect(`${bits}-row-budget`, current, observed.managed, { start_row: 2, max_rows: 2 });
    assert.equal(page.stopReason, 'row_limit'); assert.equal(page.coverage, 'partial'); assert.equal(page.nextRow, 4); assert.deepEqual(page.rows.map(row => row.index), [2, 3]);
    const cells = await collect(`${bits}-cell-budget`, current, observed.managed, { max_cells: 3 });
    assert.equal(cells.stopReason, 'cell_limit'); assert.equal(cells.cellsRead, 3); assert.equal(cells.nextRow, 1); assert.equal(cells.rows[1].complete, false);
    const text = await collect(`${bits}-cell-text-budget`, current, observed.managed, { columns: [2], start_row: 4, max_rows: 1, max_cell_chars: 20 });
    assert.equal(text.stopReason, 'cell_text_limit'); assert.equal(text.rows[0].cells[0].text, 'L'.repeat(20)); assert.equal(text.rows[0].cells[0].complete, false);
    const chars = await collect(`${bits}-total-character-budget`, current, observed.managed, { columns: [0], max_chars: 10 });
    assert.equal(chars.stopReason, 'character_limit'); assert.equal(chars.charsRead, 10); assert.equal(chars.nextRow, 1);
    await current.command('disable'); observed = await directoryFor(current); assert.equal(observed.managed.enabled, false);
    assert.equal((await collect(`${bits}-disabled-read`, current, observed.managed, {})).coverage, 'complete');
    await current.command('enable'); observed = await directoryFor(current);
    for (const [label, target, pattern] of [['unknown-class', observed.panel, /unsupported_standard_control/], ['owner-data', observed.owner, /unsupported_owner_data/]]) {
      const output = await execute('computer_read_control', { child_window_id: target.id, columns: [0] }); assert.equal(output.isError, true); assert.match(JSON.stringify(output), pattern);
      samples[`${bits}-${label}`] = { child_window_id: target.id, output };
    }
    const invalid = await read(observed.managed, { columns: [9] }); assert.equal(invalid.stopReason, 'source_error'); assert.equal(invalid.cellsRead, 0); assert.match(invalid.error, /column/);
    samples[`${bits}-invalid-column`] = invalid;
    const cover = await current.command('cover');
    // 后台启动的 Form.Activate 可能被 Windows 前台锁拒绝；先用新原生身份建立前台。
    const coverNative = (await computer.listWindows()).find(window => window.id === cover);
    assert.ok(coverNative, 'cover must be genuinely visible'); await computer.focusWindow(coverNative);
    samples[`${bits}-cover-setup`] = { surface: 'native desktop', nativeWindow: coverNative };
    observed = await directoryFor(current);
    const background = await collect(`${bits}-background`, current, observed.managed, {}); assert.equal(background.coverage, 'complete');
    assert.match(samples[`${bits}-background`].after, new RegExp(`foreground:${cover}$`));
    if (bits === 64) {
      await current.command('hang-count:700');
      const hanging = read(observed.managed, { message_timeout_ms: 80 }); assert.equal(await current.next(), 'scalar-entered');
      const scalar = await hanging; assert.equal(scalar.stopReason, 'source_error'); assert.equal(scalar.rowCount, null); assert.equal(scalar.remoteBufferQuarantined, false);
      assert.equal(await current.next(), 'scalar-completed'); samples['scalar-timeout'] = scalar;
      assert.equal((await collect('scalar-recovery', current, observed.managed, {})).coverage, 'complete');
      const old = observed.managed; await current.command('replace');
      const stale = await execute('computer_read_control', { child_window_id: old.id, columns: [0] }); assert.equal(stale.isError, true); samples['replaced-child-rejected'] = stale;
      observed = await directoryFor(current);
    }
    await current.command('delay:1:800');
    const pending = read(observed.managed, { message_timeout_ms: 80 }); const entered = await current.next(); assert.match(entered, /^text-entered:/);
    const partial = await pending;
    assert.equal(partial.stopReason, 'source_error'); assert.equal(partial.coverage, 'partial'); assert.equal(partial.nextRow, 1); assert.equal(partial.cellsRead, 2);
    assert.equal(partial.failedRow, 1); assert.equal(partial.failedColumn, 2); assert.equal(partial.remoteBufferQuarantined, true); assert.match(partial.error, /source_callback_timeout/);
    assert.equal(await current.next(), 'text-completed-safe:true');
    const before = await current.command('state');
    const retries = [];
    for (let attempt = 0; attempt < 3; attempt++) { const stopped = await read(observed.managed); assert.equal(stopped.stopReason, 'source_error'); assert.match(stopped.error, /remote_buffer_busy_or_quarantined/); assert.equal(stopped.cellsRead, 0); retries.push(stopped); }
    const after = await current.command('state');
    assert.equal(after.match(/textMessages:(\d+)/)[1], before.match(/textMessages:(\d+)/)[1]);
    assert.equal(after.match(/handles:(\d+)/)[1], before.match(/handles:(\d+)/)[1]);
    samples[`${bits}-late-callback-quarantine`] = { child_window_id: observed.managed.id, entered, partial, retries, before, after };
    await current.close();
  }
  // 真实 ReplyMessage 会提前触发回调；来源尚未写入的结果必须拒绝并保留缓冲。
  // 分别覆盖错误长度和看似正常的空串长度，后者会击穿零初始化的旧实现。
  for (const replyValue of [777, 0]) {
    const current = await fixture(executables[64]); current.bits = 64;
    const observed = await directoryFor(current); await current.command(`delay:0:80:reply:${replyValue}`);
    const pending = read(observed.managed, { message_timeout_ms: 500 }); const entered = await current.next(); assert.match(entered, /^text-entered:/);
    const result = await pending;
    assert.equal(result.stopReason, 'source_error'); assert.equal(result.coverage, 'partial'); assert.equal(result.cellsRead, 0);
    assert.equal(result.remoteBufferQuarantined, true); assert.match(result.error, /source_text_reply_incomplete/);
    assert.equal(await current.next(), 'text-completed-safe:true');
    const refused = await read(observed.managed); assert.match(refused.error, /remote_buffer_busy_or_quarantined/); assert.equal(refused.cellsRead, 0);
    samples[`early-reply-${replyValue}-quarantined`] = { child_window_id: observed.managed.id, entered, result, refused, state: await current.command('state') };
    await current.close();
  }
  for (const mode of ['cancel', 'total-deadline']) {
    const current = await fixture(executables[64]); current.bits = 64;
    const observed = await directoryFor(current); await current.command('delay:0:1300');
    const abort = new AbortController(); const started = performance.now();
    const pending = execute('computer_read_control', { child_window_id: observed.managed.id, columns: [0], message_timeout_ms: 1000, timeout_ms: mode === 'cancel' ? 10000 : 350 }, abort.signal);
    const entered = await current.next(); assert.match(entered, /^text-entered:/);
    if (mode === 'cancel') abort.abort(new Error('test cancels after target entered pointer message'));
    const result = await pending; const wallMs = Math.round(performance.now() - started);
    if (mode === 'cancel') assert.equal(result.isError, true);
    else { assert.ok(wallMs < 1200, `hard deadline exceeded: ${wallMs}`); assert.ok(result.isError || JSON.parse(result.value).stopReason === 'source_error'); }
    assert.equal(await current.next(), 'text-completed-safe:true');
    const refused = await read(observed.managed); assert.match(refused.error, /remote_buffer_busy_or_quarantined/); assert.equal(refused.cellsRead, 0);
    samples[mode] = { child_window_id: observed.managed.id, entered, result, wallMs, refused, state: await current.command('state') };
    await current.close();
  }
  await mkdir(resolve(root, '.local'), { recursive: true });
  await writeFile(resolve(root, '.local/listview-smoke-metrics.json'), JSON.stringify({ observedAt: new Date().toISOString(), runtime: { electron: process.versions.electron ?? null, node: process.versions.node, modules: process.versions.modules }, helperSha256: helperHash, samples }, null, 2));
  console.log(JSON.stringify({ helperSha256: helperHash, sampleKeys: Object.keys(samples), cases: Object.keys(samples).length, runtime: process.versions.electron ?? 'node' }));
} catch (error) {
  await mkdir(resolve(root, '.local'), { recursive: true });
  await writeFile(resolve(root, '.local/listview-smoke-failure.json'), JSON.stringify({ error: String(error.stack), samples }, null, 2)); throw error;
} finally {
  for (const process of active) { process.terminate(); await process.done; }
  await ctx.fiber.dispose(); await runner.dispose(); await loader.unregister(); await rm(directory, { recursive: true, force: true });
}
