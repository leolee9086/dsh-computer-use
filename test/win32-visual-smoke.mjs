// 真实 Electron、Cordis ToolRuntime、官方 ManagedRunner 与自绘 WinForms 任务。
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

if (process.platform !== 'win32') throw new Error('Visual fixture requires Windows');
const harnessRoot = process.env.DSH_HARNESS_ROOT ?? fileURLToPath(new URL('../../deepseek-harness/', import.meta.url));
const requireHarness = createRequire(resolve(harnessRoot, 'package.json'));
const { register } = await import(pathToFileURL(requireHarness.resolve('tsx/esm/api')).href);
const loader = register({ namespace: 'visual-task-smoke', tsconfig: resolve(harnessRoot, 'tsconfig.json') });
const [{ Context }, { default: ToolRuntime }, { default: SystemPrompt }] = await Promise.all([
  loader.import('@deepseek-ai/cordis', import.meta.url), loader.import('@deepseek-ai/dsh-tools', import.meta.url), loader.import('@deepseek-ai/dsh-system-prompt', import.meta.url),
]);
const directory = await mkdtemp(join(tmpdir(), 'dsh-visual-task-'));
const helper = join(directory, 'dsh-screen.exe');
const source = process.env.DSH_VISUAL_HELPER ?? fileURLToPath(new URL('../native/target/release/dsh-screen.exe', import.meta.url));
await copyFile(source, helper);
const hash = data => createHash('sha256').update(data).digest('hex');
const helperHash = hash(await readFile(helper)); assert.equal(helperHash, hash(await readFile(source)));
const runner = await createManagedRunner(), computer = new WindowsComputer(runner, { nativeHelperPath: helper, actionDelayMs: 20 });
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
    new Promise((_done, reject) => { const timer = setTimeout(() => reject(new Error('visual fixture command deadline')), 10000); timer.unref(); }),
  ]);
}
async function command(text) { child.stdin.write(`${text}\n`); return nextLine(); }
try {
  const compiler = join(process.env.WINDIR ?? 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
  const executable = join(directory, 'fixture.exe');
  await runner.run([compiler, '/nologo', '/noconfig', '/target:exe', `/out:${executable}`, '/r:System.dll', '/r:System.Core.dll', '/r:System.Drawing.dll', '/r:System.Windows.Forms.dll',
    fileURLToPath(new URL('./windows-visual-fixture.cs', import.meta.url))]);
  child = runner.start([executable]); nextLine = lines(child.stdout);
  const hwnd = await nextLine(); assert.match(hwnd, /^\d+$/);
  await ctx.plugin(SystemPrompt); await ctx.plugin(ToolRuntime); ctx.provide('computer', computer);
  // 控制明确拒绝：新工具必须经官方审批合同识别为观测。提窗前置由 fresh native list + driver 建立。
  await ctx.plugin({ name: 'visual-task-probe', inject: ['tools', 'computer'], apply: scope => applyTools(scope, { observeApproval: 'allow', controlApproval: 'deny' }) });
  const agent = { options: {}, session: {} }; let calls = 0;
  const execute = (name, args) => ctx.tools.execute({ signal: new AbortController().signal, callId: `visual-${++calls}`, name, arguments: args, agent });
  const json = async (name, args) => {
    const output = await execute(name, args); assert.equal(output.isError, false, JSON.stringify(output)); return JSON.parse(output.value);
  };
  const listed = async () => {
    const native = (await computer.listWindows()).find(window => window.id === hwnd); assert.ok(native);
    assert.deepEqual([native.bounds.width, native.bounds.height], [760, 420]);
    const current = (await json('computer_windows', { operation: 'list' })).windows.find(window => window.processId === native.processId && window.title === native.title);
    assert.ok(current); return { native, current };
  };
  const focus = async () => { const fresh = await listed(); await computer.focusWindow(fresh.native); return listed(); };
  const state = async () => { const value = await command('state'); assert.match(value, /;clicks:0;/); return value; };
  const collect = async (key, name, options, target) => {
    target ??= await listed();
    const args = { window_id: target.current.id, ...options };
    const result = await json(name, args);
    samples[key] = { surface: 'native WinForms raster', window_id: target.current.id, nativeWindow: target.native, args, result, after: await state() };
    return result;
  };
  const rejected = async (key, name, options, pattern) => {
    const target = await listed(), args = { window_id: target.current.id, ...options };
    const result = await execute(name, args); assert.equal(result.isError, true); assert.match(JSON.stringify(result), pattern);
    samples[key] = { window_id: target.current.id, args, result, after: await state() };
  };
  const textRegion = { x: 10, y: 10, width: 520, height: 120 }, colorRegion = { x: 20, y: 170, width: 130, height: 35 };
  const color = { region: colorRegion, rgb: [40, 120, 200], tolerance: 0, max_samples: 2, timeout_ms: 10000 };
  const ocr = { operation: 'read', region: textRegion, language: 'en-US', timeout_ms: 10000 };
  samples.ocrStatus = await json('computer_ocr', { operation: 'status' });
  assert.ok(samples.ocrStatus.languages.includes('en-US')); assert.equal(samples.ocrStatus.confidenceAvailable, false);
  await focus();
  const pixels = await collect('color-forward', 'computer_find_color', color);
  assert.equal(pixels.coverage, 'complete'); assert.equal(pixels.matchingPixels, 480); assert.equal(pixels.samples.length, 2);
  assert.deepEqual([pixels.samples[0].x, pixels.samples[0].y], [110, 260]);
  const reverse = await collect('color-reverse', 'computer_find_color', { ...color, direction: 'reverse_row_major' });
  assert.equal(reverse.matchingPixels, 480); assert.deepEqual([reverse.samples[0].x, reverse.samples[0].y], [159, 271]);
  const tolerant = await collect('color-tolerance', 'computer_find_color', { ...color, tolerance: 2 });
  assert.equal(tolerant.matchingPixels, 720);
  const zero = await collect('color-partial-zero', 'computer_find_color', { ...color, max_pixels: 1 });
  assert.equal(zero.coverage, 'partial'); assert.equal(zero.matchingPixels, 0); assert.equal(zero.stopReason, 'pixel_limit');
  const prefix = await collect('color-partial-hit', 'computer_find_color', { ...color, max_pixels: 1311 });
  assert.equal(prefix.coverage, 'partial'); assert.equal(prefix.matchingPixels, 1);
  const present = await collect('color-prefix-present', 'computer_wait_visual', { region: colorRegion, query: { kind: 'color', rgb: color.rgb, max_pixels: 1311 }, timeout_ms: 2000 });
  assert.equal(present.fulfilled, true); assert.equal(present.last.coverage, 'partial');
  const incompleteAbsence = await collect('color-partial-not-absence', 'computer_wait_visual', { region: colorRegion, query: { kind: 'color', rgb: color.rgb, max_pixels: 1 }, state: 'absent', timeout_ms: 600, poll_ms: 50 });
  assert.equal(incompleteAbsence.reason, 'timeout'); assert.equal(incompleteAbsence.fulfilled, false);

  const words = await collect('ocr-native', 'computer_ocr', ocr);
  assert.equal(words.coverage, 'complete'); assert.match(words.lines.map(line => line.text).join('\n'), /ALPHA READY/);
  assert.ok(words.lines.some(line => line.text === 'STATUS WAIT')); assert.ok(!words.words.some(word => /OUTSIDE|SECRET/.test(word.text)));
  assert.ok(words.words.every(word => word.confidence === null));
  const enlarged = await collect('ocr-rounded-scale', 'computer_ocr', { ...ocr, region: { ...textRegion, width: 521, height: 121 }, scale: 1.5 });
  assert.deepEqual([enlarged.imageWidth, enlarged.imageHeight], [782, 182]); assert.match(enlarged.lines.map(line => line.text).join('\n'), /ALPHA READY/);
  const limited = await collect('ocr-word-limit', 'computer_ocr', { ...ocr, max_words: 1 });
  assert.equal(limited.coverage, 'partial'); assert.equal(limited.stopReason, 'word_limit'); assert.equal(limited.words.length, 1); assert.equal(limited.lines.length, 0);
  const chars = await collect('ocr-character-limit', 'computer_ocr', { ...ocr, max_chars: 6 });
  assert.equal(chars.coverage, 'partial'); assert.equal(chars.stopReason, 'character_limit'); assert.equal(chars.words.length, 1);
  const partialOcrAbsent = await collect('ocr-partial-not-absence', 'computer_wait_visual', { region: textRegion,
    query: { kind: 'text', language: 'en-US', text: 'OUTSIDE', max_chars: 1 }, state: 'absent', timeout_ms: 1500, poll_ms: 50 });
  assert.equal(partialOcrAbsent.reason, 'timeout'); assert.equal(partialOcrAbsent.fulfilled, false);
  await rejected('ocr-score-rejected', 'computer_ocr', { ...ocr, min_confidence: 0 }, /confidence.*unsupported/);
  await rejected('ocr-language-rejected', 'computer_ocr', { ...ocr, language: 'fr-FR' }, /没有 OCR 语言/);
  await rejected('region-escape-rejected', 'computer_find_color', { ...color, region: { x: 750, y: 170, width: 130, height: 35 } }, /超出当前窗口/);
  await rejected('control-policy-denied', 'computer_click', { screenshot_id: pixels.visual_id, x: 1, y: 1 }, /denies desktop control/);

  await command('later');
  const changedColor = await collect('color-timed-change', 'computer_wait_visual', { region: colorRegion,
    query: { kind: 'color', rgb: [25, 180, 80], min_pixels: 480 }, timeout_ms: 5000, poll_ms: 50 });
  assert.equal(changedColor.fulfilled, true); assert.equal(changedColor.last.matchingPixels, 480); assert.ok(changedColor.attempts > 1);
  await command('reset'); await focus(); await command('later');
  const changedText = await collect('ocr-timed-change', 'computer_wait_visual', { region: textRegion,
    query: { kind: 'text', language: 'en-US', text: 'ALPHA DONE', match: 'exact', level: 'line' }, timeout_ms: 5000, poll_ms: 50 });
  assert.equal(changedText.fulfilled, true); assert.ok(changedText.evaluation.matches.some(line => line.text === 'ALPHA DONE'));
  const missing = await collect('ocr-never-appears', 'computer_wait_visual', { region: textRegion,
    query: { kind: 'text', language: 'en-US', text: 'NEVER APPEARS' }, timeout_ms: 1200, poll_ms: 50 });
  assert.equal(missing.reason, 'timeout'); assert.equal(missing.fulfilled, false); assert.ok(missing.elapsed_ms < 2200);

  await command('reset'); await focus(); await command('later-lost');
  const lost = await collect('foreground-loss', 'computer_wait_visual', { region: colorRegion,
    query: { kind: 'color', rgb: [1, 2, 3] }, timeout_ms: 5000, poll_ms: 50 });
  assert.equal(lost.reason, 'error'); assert.match(lost.error.message, /不在前台|焦点或边界已变/);
  const coveredState = await state(), coverHandle = coveredState.match(/;cover:(\d+)/)[1];
  const coverNative = (await computer.listWindows()).find(window => window.id === coverHandle); assert.ok(coverNative); await computer.focusWindow(coverNative);
  assert.match(await state(), new RegExp(`;foreground:${coverHandle};`));
  const backgroundColor = await collect('covered-color', 'computer_find_color', { ...color, capture_mode: 'print_window' });
  assert.equal(backgroundColor.matchingPixels, 480); assert.match(await state(), new RegExp(`;foreground:${coverHandle};`));
  const backgroundOcr = await collect('covered-ocr', 'computer_ocr', { ...ocr, capture_mode: 'print_window' });
  assert.match(backgroundOcr.lines.map(line => line.text).join('\n'), /ALPHA READY/); assert.match(await state(), new RegExp(`;foreground:${coverHandle};`));
  await command('reset'); const beforeMove = await focus(); await command('move');
  const moved = await collect('moved-window-region', 'computer_find_color', color, beforeMove);
  assert.deepEqual([moved.windowBounds.x, moved.windowBounds.y, moved.searched.x, moved.searched.y], [140, 100, 160, 270]);
  assert.deepEqual([moved.samples[0].x, moved.samples[0].y], [170, 280]);
  samples.finalWindow = (await listed()).current; samples.finalState = await state();
  const metrics = { runtime: { electron: process.versions.electron ?? null, node: process.versions.node, modules: process.versions.modules }, helperHash, samples,
    scope: 'controlled raster fixture with actual Windows OCR; control policy denied; not an application task benchmark or OCR confidence support' };
  await mkdir(new URL('../.local/', import.meta.url), { recursive: true });
  await writeFile(new URL('../.local/visual-smoke-metrics.json', import.meta.url), JSON.stringify(metrics, null, 2) + '\n');
  console.log(JSON.stringify({ helperHash, runtime: metrics.runtime, tasks: Object.keys(samples), finalState: samples.finalState }));
} catch (error) {
  await mkdir(new URL('../.local/', import.meta.url), { recursive: true });
  await writeFile(new URL('../.local/visual-smoke-failure.json', import.meta.url), JSON.stringify({ helperHash, samples, error: String(error) }, null, 2) + '\n');
  throw error;
} finally {
  await computer.dispose(); await ctx.fiber.dispose();
  if (child) { child.terminate(); await child.done; }
  await runner.dispose(); loader.unregister();
  await rm(directory, { recursive: true, force: true });
}
