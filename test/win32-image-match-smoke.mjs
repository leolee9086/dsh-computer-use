// 原生像素 + 真实 Cordis ToolRuntime/官方 subprocess + 应用 MouseUp 回读。
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, rm, copyFile, readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WindowsComputer } from '../src/windows.js';
import { apply as applyTools } from '../src/tool.js';
import { createManagedRunner } from './win32-runner.mjs';

if (process.platform !== 'win32') throw new Error('Image coverage fixture requires Windows');
const harnessRoot = process.env.DSH_HARNESS_ROOT ?? fileURLToPath(new URL('../../deepseek-harness/', import.meta.url));
const requireHarness = createRequire(resolve(harnessRoot, 'package.json'));
const { register } = await import(pathToFileURL(requireHarness.resolve('tsx/esm/api')).href);
const loader = register({ namespace: 'image-coverage-smoke', tsconfig: resolve(harnessRoot, 'tsconfig.json') });
const [{ Context }, { default: ToolRuntime }, { default: SystemPrompt }] = await Promise.all([
  loader.import('@deepseek-ai/cordis', import.meta.url), loader.import('@deepseek-ai/dsh-tools', import.meta.url), loader.import('@deepseek-ai/dsh-system-prompt', import.meta.url),
]);
const directory = await mkdtemp(join(tmpdir(), 'dsh-image-coverage-'));
// 开发盘的 Low 文件标签不能代表正式 helper 能力；相同字节复制到中等完整性临时目录。
const helper = join(directory, 'dsh-screen.exe');
const source = process.env.DSH_IMAGE_HELPER ?? fileURLToPath(new URL('../native/release/dsh-screen.exe', import.meta.url));
await copyFile(source, helper);
const sha256 = data => createHash('sha256').update(data).digest('hex');
const helperHash = sha256(await readFile(helper));
assert.equal(helperHash, sha256(await readFile(source)));
const runner = await createManagedRunner();
const computer = new WindowsComputer(runner, { nativeHelperPath: helper, actionDelayMs: 20 });
const ctx = new Context(), samples = {};
let child, nextLine;
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
    new Promise((_done, reject) => { const timer = setTimeout(() => reject(new Error('image fixture command deadline')), 10000); timer.unref(); }),
  ]);
}
async function command(text) { child.stdin.write(`${text}\n`); return nextLine(); }
try {
  const compiler = join(process.env.WINDIR ?? 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
  const executable = join(directory, 'fixture.exe'), template = join(directory, 'template.png');
  await runner.run([compiler, '/nologo', '/noconfig', '/target:exe', `/out:${executable}`, '/r:System.dll', '/r:System.Core.dll', '/r:System.Drawing.dll', '/r:System.Windows.Forms.dll',
    fileURLToPath(new URL('./windows-image-match-fixture.cs', import.meta.url))]);
  child = runner.start([executable, template]); nextLine = lines(child.stdout);
  const hwnd = await nextLine(); assert.match(hwnd, /^\d+$/);
  await ctx.plugin(SystemPrompt); await ctx.plugin(ToolRuntime); ctx.provide('computer', computer);
  await ctx.plugin({ name: 'image-coverage-task-probe', inject: ['tools', 'computer'], apply: scope => applyTools(scope, { observeApproval: 'allow', controlApproval: 'allow' }) });
  const agent = { options: {}, session: {} }; let calls = 0;
  const execute = (name, args) => ctx.tools.execute({ signal: new AbortController().signal, callId: `image-${++calls}`, name, arguments: args, agent });
  const text = async (name, args) => {
    const output = await execute(name, args); assert.equal(output.isError, false, JSON.stringify(output)); return output.value;
  };
  const json = async (name, args) => JSON.parse(await text(name, args));
  const listed = async () => {
    const native = (await computer.listWindows()).find(window => window.id === hwnd); assert.ok(native);
    assert.deepEqual([native.bounds.width, native.bounds.height], [600, 360]);
    const current = (await json('computer_windows', { operation: 'list' })).windows.find(window => window.processId === native.processId && window.title === native.title);
    assert.ok(current); return { current, native };
  };
  const state = async (expected = 0) => {
    const response = await command('state'); assert.match(response, new RegExp(`;clicks:${expected};`)); return response;
  };
  const base = { template, threshold: 1, tolerance: 0, timeout_ms: 10000 };
  const find = async (mode, options = {}) => {
    assert.equal(await command(mode), `painted:${mode}`);
    const { current, native } = await listed();
    const result = await json('computer_find_image', { ...base, window_id: current.id, ...options });
    const after = await state();
    samples[`${mode}${options.max_positions ? `-${options.max_positions}` : ''}`] = { surface: 'native pixel window', window_id: current.id, result, after };
    return { result, native };
  };
  const refused = async (options = {}) => {
    // 每次提窗之后重新列窗口；点击后读真正的事件计数，不凭工具返回推断没有输入。
    const { current } = await listed();
    const response = await text('computer_click_image', { ...base, window_id: current.id, ...options });
    assert.match(response, /^未点击：/); const after = await state();
    return { window_id: current.id, response, after };
  };

  const two = (await find('two')).result;
  assert.equal(two.coverage, 'complete'); assert.equal(two.matchCount, 2);
  samples.two.refusal = await refused();

  const crowded = await find('crowded');
  assert.equal(crowded.result.coverage, 'complete'); assert.equal(crowded.result.matchCount, 2);
  assert.ok(crowded.result.matches.some(spot => spot.x === crowded.native.bounds.x + 520 && spot.y === crowded.native.bounds.y + 300));
  samples.crowded.refusal = await refused();
  // 可选的旧产物只用于直接协议反例，不经过新宿主的严格覆盖校验。
  if (process.env.DSH_IMAGE_PREVIOUS_HELPER) {
    const previous = join(directory, 'previous.exe'); await copyFile(process.env.DSH_IMAGE_PREVIOUS_HELPER, previous);
    const { native } = await listed();
    const old = await runner.runJson([previous, 'find-image'], { stdin: Buffer.from(JSON.stringify({
      templatePng: (await readFile(template)).toString('base64'), threshold: 1, tolerance: 0,
      focus: { handle: native.id, processId: native.processId, title: native.title },
    })).toString('base64') });
    samples.previous = { hash: sha256(await readFile(previous)), result: old, after: await state() };
    assert.equal(old.matchCount, 1, 'fixture must reproduce the old false unique result');
    assert.equal(old.coverage, undefined);
  }

  const tail = await find('tail');
  assert.equal(tail.result.coverage, 'complete'); assert.equal(tail.result.matchCount, 1);
  assert.deepEqual([tail.result.x, tail.result.y], [tail.native.bounds.x + 576, tail.native.bounds.y + 336]);
  assert.equal(tail.result.visitedPositions, 577 * 337);

  const none = (await find('none')).result;
  assert.equal(none.coverage, 'complete'); assert.equal(none.status, 'not_found'); assert.equal(none.found, false);
  samples.none.refusal = await refused();

  const zero = (await find('two', { max_positions: 1 })).result;
  assert.equal(zero.coverage, 'partial'); assert.equal(zero.status, 'incomplete'); assert.equal(zero.matchCount, 0);
  assert.equal(zero.stopReason, 'position_limit'); assert.equal(zero.visitedPositions, 1);
  samples['two-1'].refusal = await refused({ max_positions: 1 });
  const prefix = 40 * 577 + 40 + 1;
  const one = (await find('two', { max_positions: prefix })).result;
  assert.equal(one.coverage, 'partial'); assert.equal(one.status, 'incomplete'); assert.equal(one.matchCount, 1);
  assert.equal(one.visitedPositions, prefix); assert.equal(one.stopReason, 'position_limit');
  samples[`two-${prefix}`].refusal = await refused({ max_positions: prefix });

  const unique = (await find('unique')).result;
  assert.equal(unique.coverage, 'complete'); assert.equal(unique.matchCount, 1);
  const { current } = await listed();
  const clicked = await text('computer_click_image', { ...base, window_id: current.id }); assert.match(clicked, /^已点击/);
  const after = await state(1); assert.match(after, /;last:212,172$/);
  samples.unique.click = { window_id: current.id, response: clicked, after };
  // 新鲜窗口证据与应用状态在动作之后一起留存。
  samples.finalWindow = (await listed()).current;
  const metrics = { runtime: { electron: process.versions.electron ?? null, node: process.versions.node, modules: process.versions.modules },
    helperHash, samples, scope: 'controlled pixel fixture; grayscale at native scale, not general application identity' };
  await mkdir(new URL('../.local/', import.meta.url), { recursive: true });
  await writeFile(new URL('../.local/image-match-smoke-metrics.json', import.meta.url), JSON.stringify(metrics, null, 2) + '\n');
  console.log(JSON.stringify(metrics, null, 2));
} finally {
  await computer.dispose(); await ctx.fiber.dispose();
  if (child) { child.terminate(); await child.done; }
  await runner.dispose(); loader.unregister();
  await rm(directory, { recursive: true, force: true });
}
