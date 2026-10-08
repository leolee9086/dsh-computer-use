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
  let expectedClicks = 0;
  const state = async (expected = expectedClicks) => {
    const response = await command('state'); assert.match(response, new RegExp(`;clicks:${expected};`)); return response;
  };
  const base = { template, threshold: 1, tolerance: 0, timeout_ms: 10000 };
  const find = async (mode, options = {}, sampleName) => {
    assert.equal(await command(mode), `painted:${mode}`);
    const { current, native } = await listed();
    const result = await json('computer_find_image', { ...base, window_id: current.id, ...options });
    const after = await state();
    samples[sampleName ?? `${mode}${options.max_positions ? `-${options.max_positions}` : ''}`] = {
      surface: 'native pixel window', window_id: current.id, nativeWindow: native, options, result, after,
    };
    return { result, native };
  };
  const refused = async (options = {}) => {
    // 每次提窗之后重新列窗口；点击后读真正的事件计数，不凭工具返回推断没有输入。
    const { current } = await listed();
    const response = await text('computer_click_image', { ...base, window_id: current.id, ...options });
    assert.match(response, /^未点击：/); const after = await state();
    return { window_id: current.id, response, after, freshWindow: (await listed()).current };
  };
  const accepted = async (options, clientPoint) => {
    const { current } = await listed();
    const response = await text('computer_click_image', { ...base, window_id: current.id, ...options });
    assert.match(response, /^已点击/); expectedClicks++;
    const after = await state(); assert.ok(after.endsWith(`;last:${clientPoint.join(',')}`));
    return { surface: 'native pixel window', window_id: current.id, response, after, freshWindow: (await listed()).current };
  };
  const invalid = async (options, message) => {
    const { current } = await listed();
    const output = await execute('computer_click_image', { ...base, window_id: current.id, ...options });
    assert.equal(output.isError, true); assert.match(JSON.stringify(output), message);
    return { window_id: current.id, output, after: await state(), freshWindow: (await listed()).current };
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
  samples.unique.click = await accepted({}, [212, 172]);

  const rgbTemplate = join(directory, 'rgb.png'), alphaTemplate = join(directory, 'alpha.png');
  const rgbOptions = { template: rgbTemplate, color_mode: 'rgb' };
  const grayColors = (await find('rgb', { template: rgbTemplate }, 'rgb-as-gray')).result;
  assert.equal(grayColors.coverage, 'complete'); assert.equal(grayColors.matchCount, 2);
  samples['rgb-as-gray'].refusal = await refused({ template: rgbTemplate });
  const color = await find('rgb', rgbOptions, 'rgb-exact');
  assert.equal(color.result.coverage, 'complete'); assert.equal(color.result.matchCount, 1);
  assert.equal(color.result.colorMode, 'rgb'); assert.equal(color.result.activePixelCount, 576);
  assert.deepEqual([color.result.x, color.result.y], [color.native.bounds.x + 200, color.native.bounds.y + 160]);
  const colorPrefix = 160 * 577 + 200 + 1;
  const rgbPartial = (await find('rgb', { ...rgbOptions, max_positions: colorPrefix }, 'rgb-partial')).result;
  assert.equal(rgbPartial.coverage, 'partial'); assert.equal(rgbPartial.matchCount, 1);
  samples['rgb-partial'].refusal = await refused({ ...rgbOptions, max_positions: colorPrefix });
  // 48px 源模板显式缩成 24px，同一真实画面证明降尺度也确实生效。
  const down = (await find('rgb', { template: join(directory, 'scaled-rgb.png'), color_mode: 'rgb', template_scale: 0.5 }, 'rgb-downscaled')).result;
  assert.equal(down.matchCount, 1); assert.equal(down.coverage, 'complete');
  assert.deepEqual([down.sourceTemplateWidth, down.templateWidth, down.templateScale, down.scale], [48, 24, 0.5, 1]);
  samples['rgb-exact'].click = await accepted(rgbOptions, [212, 172]);

  const alphaOptions = { template: alphaTemplate, color_mode: 'rgb', mask_mode: 'alpha', alpha_min: 128 };
  const unmasked = (await find('alpha', { template: alphaTemplate, color_mode: 'rgb' }, 'alpha-without-mask')).result;
  assert.equal(unmasked.coverage, 'complete'); assert.equal(unmasked.matchCount, 0);
  samples['alpha-without-mask'].refusal = await refused({ template: alphaTemplate, color_mode: 'rgb' });
  const blended = (await find('alpha', { ...alphaOptions, alpha_min: 1 }, 'alpha-cutoff-one')).result;
  assert.equal(blended.coverage, 'complete'); assert.equal(blended.matchCount, 0); assert.equal(blended.activePixelCount, 196);
  const alpha = await find('alpha', alphaOptions, 'alpha-exact');
  samples.alphaPixels = await command('inspect-alpha');
  assert.equal(alpha.result.coverage, 'complete'); assert.equal(alpha.result.matchCount, 1); assert.equal(alpha.result.activePixelCount, 144);
  assert.deepEqual([alpha.result.x, alpha.result.y], [alpha.native.bounds.x + 300, alpha.native.bounds.y + 100]);
  samples['alpha-exact'].click = await accepted(alphaOptions, [312, 112]);
  samples['transparent-refusal'] = await invalid({ ...alphaOptions, template: join(directory, 'transparent.png') }, /没有参与像素/);
  samples['flat-visible-refusal'] = await invalid({ ...alphaOptions, template: join(directory, 'flat-alpha.png') }, /几乎是纯色/);

  const wrongSize = (await find('scaled', rgbOptions, 'scaled-at-one')).result;
  assert.equal(wrongSize.coverage, 'complete'); assert.equal(wrongSize.matchCount, 0);
  samples['scaled-at-one'].refusal = await refused(rgbOptions);
  const scaledOptions = { ...rgbOptions, template_scale: 2 };
  const scaled = await find('scaled', scaledOptions, 'scaled-rgb');
  assert.equal(scaled.result.coverage, 'complete'); assert.equal(scaled.result.matchCount, 1);
  assert.deepEqual([scaled.result.sourceTemplateWidth, scaled.result.templateWidth, scaled.result.templateScale, scaled.result.scale], [24, 48, 2, 1]);
  assert.equal(scaled.result.visitedPositions, 553 * 313); assert.equal(scaled.result.activePixelCount, 2304);
  assert.deepEqual([scaled.result.x, scaled.result.y], [scaled.native.bounds.x + 240, scaled.native.bounds.y + 180]);
  samples['scaled-rgb'].click = await accepted(scaledOptions, [264, 204]);

  const combinedOptions = { ...alphaOptions, template_scale: 2 };
  const combinedPrefix = 220 * 553 + 380 + 1;
  const combinedPartial = (await find('alpha-scaled', { ...combinedOptions, max_positions: combinedPrefix }, 'alpha-scaled-partial')).result;
  assert.equal(combinedPartial.coverage, 'partial'); assert.equal(combinedPartial.matchCount, 1); assert.equal(combinedPartial.activePixelCount, 576);
  samples['alpha-scaled-partial'].refusal = await refused({ ...combinedOptions, max_positions: combinedPrefix });
  const combined = await find('alpha-scaled', combinedOptions, 'alpha-scaled-exact');
  assert.equal(combined.result.coverage, 'complete'); assert.equal(combined.result.matchCount, 1); assert.equal(combined.result.activePixelCount, 576);
  assert.deepEqual([combined.result.x, combined.result.y], [combined.native.bounds.x + 380, combined.native.bounds.y + 220]);
  samples['alpha-scaled-exact'].click = await accepted(combinedOptions, [404, 244]);
  // 新鲜窗口证据与应用状态在动作之后一起留存。
  samples.finalWindow = (await listed()).current;
  assert.equal(expectedClicks, 5);
  const metrics = { runtime: { electron: process.versions.electron ?? null, node: process.versions.node, modules: process.versions.modules },
    helperHash, samples, scope: 'controlled native pixel fixture: gray/RGB, alpha exclusion, explicit nearest resize; not general application identity or a task success benchmark' };
  await mkdir(new URL('../.local/', import.meta.url), { recursive: true });
  await writeFile(new URL('../.local/image-modes-smoke-metrics.json', import.meta.url), JSON.stringify(metrics, null, 2) + '\n');
  console.log(JSON.stringify(metrics, null, 2));
} catch (error) {
  // 失败也保存已经发生的真实输入/像素证据，后续修复不靠重跑猜历史。
  await mkdir(new URL('../.local/', import.meta.url), { recursive: true });
  await writeFile(new URL('../.local/image-modes-failure.json', import.meta.url), JSON.stringify({ helperHash, samples, error: String(error) }, null, 2) + '\n');
  console.error(JSON.stringify({ lastSample: samples['alpha-exact'], alphaPixels: samples.alphaPixels }));
  throw error;
} finally {
  await computer.dispose(); await ctx.fiber.dispose();
  if (child) { child.terminate(); await child.done; }
  await runner.dispose(); loader.unregister();
  await rm(directory, { recursive: true, force: true });
}
