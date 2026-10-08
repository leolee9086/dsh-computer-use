// 合同和失败边界用纯数据测；Windows 捕获/OCR 与工具审批在真机 ToolRuntime 另验。
import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { visualScope, colorOptions, ocrOptions, visualQuery, validateColorResult, validateOcrResult,
  validateOcrStatus, visualCondition, waitForVisual } from '../src/visual.js';

const region = { x: -100, y: 50, width: 4, height: 2 };
const colorRequest = () => ({ capture: { region: { ...region }, captureMode: 'screen' },
  ...colorOptions({ rgb: [12, 23, 34], max_samples: 2 }) });
const colorResult = () => ({ searched: { ...region }, windowBounds: null, captureMode: 'screen',
  coverage: 'complete', status: 'found', found: true, elapsedMs: 1,
  rgb: [12, 23, 34], tolerance: 0, direction: 'row_major', totalPixels: 8, visitedPixels: 8, matchingPixels: 2,
  samples: [{ x: -99, y: 50, rgb: [12, 23, 34] }, { x: -98, y: 51, rgb: [12, 23, 34] }] });
function changed(value, mutate) { const clone = structuredClone(value); mutate(clone); return clone; }
const ocrRequest = () => ({ capture: { region: { x: -100, y: 50, width: 101, height: 41 }, captureMode: 'screen' },
  ...ocrOptions({ scale: 1.5 }) });
function ocrResult() {
  const searched = ocrRequest().capture.region;
  const bounds = { x: -100 + 30 * 101 / 152, y: 50 + 10 * 41 / 62, width: 40 * 101 / 152, height: 20 * 41 / 62 };
  return { engine: 'windows_media_ocr', language: 'en-US', confidenceAvailable: false, confidenceReason: 'engine_does_not_expose_score',
    searched, windowBounds: null, captureMode: 'screen', coverage: 'complete', status: 'recognized', elapsedMs: 5,
    imageWidth: 152, imageHeight: 62, resizeFilter: 'lanczos3',
    words: [{ text: 'Ready', bounds, imageBounds: { x: 30, y: 10, width: 40, height: 20 }, lineIndex: 0, confidence: null }],
    lines: [{ text: 'Ready', bounds: { ...bounds }, wordStart: 0, wordCount: 1, lineIndex: 0, confidence: null }] };
}
const partialZero = { coverage: 'partial', matchingPixels: 0, samples: [] };
const waitQuery = { kind: 'color', rgb: [12, 23, 34] };

test('scope requires a complete bounded region and an explicit window for PrintWindow', () => {
  assert.deepEqual(visualScope({ region }), { region, captureMode: 'screen' });
  for (const args of [{}, { region: { ...region, width: 0 } }, { region: { ...region, x: 1.2 } },
    { region: { ...region, width: 4001, height: 4000 } }, { region, capture_mode: 'print_window' }, { region, window_id: 'w' }]) {
    assert.throws(() => visualScope(args));
  }
  assert.equal(visualScope({ region: { ...region, x: 0, y: 0 }, window_id: 'w', capture_mode: 'print_window' }).captureMode, 'print_window');
});
test('invalid color and OCR thresholds are rejected before observation', () => {
  for (const args of [{ rgb: [1, 2] }, { rgb: [1, 2, 256] }, { rgb: [1, 2, 3], max_samples: 33 }, { rgb: [1, 2, 3], direction: 'column' }]) assert.throws(() => colorOptions(args));
  for (const args of [{ min_confidence: 0 }, { min_confidence: 0.9 }, { scale: NaN }, { scale: 4.1 }, { language: ' ' }, { max_words: 0 }]) assert.throws(() => ocrOptions(args));
  assert.throws(() => visualQuery({ kind: 'text', text: 'Ready', case_sensitive: 'yes' }));
  assert.throws(() => visualQuery({ kind: 'color', rgb: [1, 2, 3], min_pixels: 0 }));
});
test('color counts and samples remain independent and verify all channel tolerances', () => {
  const request = colorRequest(), result = colorResult();
  assert.equal(validateColorResult(result, request), result);
  assert.throws(() => validateColorResult(changed(result, r => { r.samples[0].rgb[2]++; }), request), /tolerance/);
  assert.throws(() => validateColorResult(changed(result, r => { r.matchingPixels = 1; }), request), /sample count/);
  assert.throws(() => validateColorResult(changed(result, r => { r.visitedPixels = 7; }), request), /coverage/);
  const many = { ...result, matchingPixels: 8 };
  assert.equal(validateColorResult(many, request).samples.length, 2);
});
test('signed window-relative mapping accepts moved windows and rejects substituted origins', () => {
  const request = colorRequest(); request.capture.region = { ...region, x: 10, y: 8 }; request.capture.window = { handle: '1', processId: 2, title: 'fixture' };
  const result = colorResult(); result.windowBounds = { x: -110, y: 42, width: 200, height: 90 };
  assert.equal(validateColorResult(result, request), result);
  const moved = changed(result, r => { r.windowBounds.x -= 200; r.searched.x -= 200; r.samples.forEach(s => { s.x -= 200; }); });
  assert.equal(validateColorResult(moved, request), moved);
  assert.throws(() => validateColorResult(changed(result, r => { r.searched.x++; }), request), /window-relative/);
  assert.throws(() => validateColorResult(changed(result, r => { r.windowBounds.width = 12; }), request), /window-relative/);
});
test('color samples must lie in the visited prefix and follow both scan directions', () => {
  const request = colorRequest(), result = colorResult();
  assert.throws(() => validateColorResult(changed(result, r => r.samples.reverse()), request), /order/);
  const reverse = { ...result, direction: 'reverse_row_major', samples: [...result.samples].reverse() };
  assert.equal(validateColorResult(reverse, { ...request, direction: 'reverse_row_major' }), reverse);
  const partial = { ...result, coverage: 'partial', status: 'incomplete', stopReason: 'pixel_limit', visitedPixels: 2, matchingPixels: 1, samples: [result.samples[0]] };
  assert.equal(validateColorResult(partial, { ...request, maxPixels: 2 }), partial);
  assert.throws(() => validateColorResult({ ...partial, samples: [result.samples[1]] }, { ...request, maxPixels: 2 }), /prefix/);
});
test('OCR bbox uses actual rounded image sizes and rejects manufactured scores', () => {
  const request = ocrRequest(), result = ocrResult();
  assert.equal(validateOcrResult(result, request), result);
  assert.throws(() => validateOcrResult(changed(result, r => { r.words[0].bounds.x = -80; }), request), /mapping/);
  assert.throws(() => validateOcrResult(changed(result, r => { r.words[0].confidence = 1; }), request), /confidence/);
  assert.throws(() => validateOcrResult(changed(result, r => { r.imageWidth = 151; }), request), /dimensions/);
});
test('complete OCR accounts for every word and line union; partial tails stay explicit', () => {
  const request = ocrRequest(), result = ocrResult();
  assert.throws(() => validateOcrResult({ ...result, lines: [] }, request), /accounted/);
  assert.throws(() => validateOcrResult(changed(result, r => { r.lines[0].lineIndex = 1; }), request), /outside/);
  assert.throws(() => validateOcrResult(changed(result, r => { r.lines[0].bounds.width++; }), request), /contradicts/);
  const partial = { ...result, coverage: 'partial', status: 'incomplete', stopReason: 'word_limit', lines: [] };
  assert.equal(validateOcrResult(partial, request), partial);
  assert.throws(() => validateOcrResult(result, { ...request, maxChars: 9 }), /character/);
  assert.equal(validateOcrResult(result, { ...request, maxChars: 10 }), result);
});
test('OCR status exposes installed tags and unavailability of scores without invented defaults', () => {
  const result = { engine: 'windows_media_ocr', languages: ['en-US'], maxImageDimension: 2600, confidenceAvailable: false, confidenceReason: 'engine_does_not_expose_score' };
  assert.equal(validateOcrStatus(result), result);
  assert.throws(() => validateOcrStatus({ ...result, confidenceAvailable: true }));
  assert.throws(() => validateOcrStatus({ ...result, languages: ['en-US', 'en-US'] }));
});
test('partial output proves known presence but cannot prove absence or synthesize a line', () => {
  assert.equal(visualCondition(waitQuery, partialZero, 'absent').fulfilled, false);
  assert.equal(visualCondition(waitQuery, { ...partialZero, matchingPixels: 4 }, 'present').fulfilled, true);
  assert.equal(visualCondition({ ...waitQuery, min_pixels: 5 }, { ...partialZero, matchingPixels: 4 }, 'present').fulfilled, false);
  const partial = { ...ocrResult(), coverage: 'partial', lines: [] };
  assert.equal(visualCondition({ kind: 'text', text: 'Ready', level: 'word', match: 'exact' }, partial).fulfilled, true);
  assert.equal(visualCondition({ kind: 'text', text: 'Ready', level: 'line' }, partial, 'absent').fulfilled, false);
  assert.equal(visualCondition({ kind: 'text', text: 'ready', case_sensitive: false, match: 'exact' }, ocrResult()).fulfilled, true);
});
test('visual wait resamples under decreasing shared budgets until condition', async () => {
  const budgets = [];
  const result = await waitForVisual({ query: waitQuery, timeoutMs: 1000, pollMs: 20, sample: async remaining => {
    budgets.push(remaining); return { coverage: 'complete', matchingPixels: budgets.length === 1 ? 0 : 1, samples: [] };
  } });
  assert.equal(result.fulfilled, true); assert.equal(result.attempts, 2); assert.ok(budgets[1] < budgets[0]);
});
test('source error stops waiting after one attempt and never becomes absence', async () => {
  let calls = 0;
  const result = await waitForVisual({ query: waitQuery, state: 'absent', timeoutMs: 1000, pollMs: 20, sample: async () => {
    calls++; throw Object.assign(new Error('target lost foreground'), { code: 'SOURCE_CHANGED' });
  } });
  assert.equal(calls, 1); assert.equal(result.reason, 'error'); assert.equal(result.fulfilled, false); assert.equal(result.error.code, 'SOURCE_CHANGED');
});
test('partial zero remains unfulfilled through a bounded timeout', async () => {
  const result = await waitForVisual({ query: waitQuery, state: 'absent', timeoutMs: 100, pollMs: 20, sample: async () => partialZero });
  assert.equal(result.reason, 'timeout'); assert.equal(result.fulfilled, false); assert.ok(result.elapsed_ms < 1000);
});
test('hard deadline returns and aborts a sample that ignores cancellation', async () => {
  let sampleSignal;
  const result = await waitForVisual({ query: waitQuery, timeoutMs: 100, pollMs: 20, sample: (_remaining, signal) => {
    sampleSignal = signal; return new Promise(() => {});
  } });
  assert.equal(result.reason, 'timeout'); assert.equal(result.attempts, 1); assert.equal(sampleSignal.aborted, true); assert.ok(result.elapsed_ms < 1000);
});
test('external cancellation remains cancellation during an in-flight observation', async () => {
  const controller = new AbortController(), cancelled = new Error('caller cancelled');
  const pending = waitForVisual({ query: waitQuery, timeoutMs: 1000, pollMs: 20, signal: controller.signal, sample: () => new Promise(() => {}) });
  await delay(10); controller.abort(cancelled); await assert.rejects(pending, error => error === cancelled);
});
