// 区域视觉观测的公共合同。字框/像素属于这次观测，不产生截图或语义元素动作凭据。
import { setTimeout as delay } from 'node:timers/promises';

export const REGION_SCHEMA = { type: 'object', additionalProperties: false, required: ['x', 'y', 'width', 'height'], properties: {
  x: { type: 'integer' }, y: { type: 'integer' }, width: { type: 'integer', minimum: 1 }, height: { type: 'integer', minimum: 1 },
} };
export const VISUAL_SCOPE_SCHEMA = {
  region: { ...REGION_SCHEMA, description: 'Required bounded region. With window_id, native pixels relative to the whole window top-left; otherwise virtual-desktop pixels. Must fit the actual source without clipping.' },
  window_id: { type: 'string', description: 'Recent session window_id. Identity is checked; this tool does not focus or restore it.' },
  capture_mode: { type: 'string', enum: ['screen', 'print_window'], description: 'Default screen. A named screen window must already be foreground. print_window requires window_id and reads application-rendered pixels; rendering support varies.' },
};
export const COLOR_OPTIONS_SCHEMA = {
  rgb: { type: 'array', minItems: 3, maxItems: 3, items: { type: 'integer', minimum: 0, maximum: 255 } },
  tolerance: { type: 'integer', minimum: 0, maximum: 255, description: 'Inclusive per-channel RGB difference, default 0.' },
  direction: { type: 'string', enum: ['row_major', 'reverse_row_major'], description: 'Sample order; both modes scan every pixel unless a budget stops them.' },
  max_pixels: { type: 'integer', minimum: 1, maximum: 100000000 },
  max_samples: { type: 'integer', minimum: 1, maximum: 32 },
};
export const OCR_OPTIONS_SCHEMA = {
  language: { type: 'string', description: 'Installed Windows OCR language tag; omit to use the OS profile language. Query operation:status for installed tags.' },
  scale: { type: 'number', minimum: 1, maximum: 4, description: 'Explicit OCR enlargement with Lanczos3; bbox mapping uses actual rounded image dimensions.' },
  max_words: { type: 'integer', minimum: 1, maximum: 2000 },
  max_chars: { type: 'integer', minimum: 1, maximum: 64000 },
  min_confidence: { type: 'number', minimum: 0, maximum: 1, description: 'Windows OCR exposes no score, so this request is rejected, including zero. No invented confidence or silent threshold bypass.' },
};
export function integer(value, label, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${label} must be an integer in ${min}..${max}`);
  return value;
}
function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value;
}
export function visualScope(args) {
  const region = object(args.region, 'region');
  const result = {
    x: integer(region.x, 'region.x', -2147483648, 2147483647), y: integer(region.y, 'region.y', -2147483648, 2147483647),
    width: integer(region.width, 'region.width', 1, 16000000), height: integer(region.height, 'region.height', 1, 16000000),
  };
  if (result.width * result.height > 16000000) throw new Error('region must not exceed 16000000 pixels');
  const captureMode = args.capture_mode ?? 'screen';
  if (!['screen', 'print_window'].includes(captureMode)) throw new Error('invalid capture_mode');
  if (args.window_id !== undefined && (typeof args.window_id !== 'string' || !args.window_id.trim())) throw new Error('window_id must be nonblank');
  if (captureMode === 'print_window' && args.window_id === undefined) throw new Error('print_window requires window_id');
  if (args.window_id !== undefined && (result.x < 0 || result.y < 0)) throw new Error('window-relative region origin must be nonnegative');
  return { region: result, captureMode };
}
export function colorOptions(args) {
  if (!Array.isArray(args.rgb) || args.rgb.length !== 3) throw new Error('rgb requires three integer channels');
  const direction = args.direction ?? 'row_major';
  if (!['row_major', 'reverse_row_major'].includes(direction)) throw new Error('invalid direction');
  return { rgb: args.rgb.map((c, i) => integer(c, `rgb[${i}]`, 0, 255)),
    tolerance: integer(args.tolerance ?? 0, 'tolerance', 0, 255), direction,
    maxPixels: integer(args.max_pixels ?? 16000000, 'max_pixels', 1, 100000000),
    maxSamples: integer(args.max_samples ?? 8, 'max_samples', 1, 32) };
}
export function ocrOptions(args) {
  if (args.min_confidence !== undefined) throw new Error('Windows OCR does not expose confidence; min_confidence is unsupported');
  const scale = args.scale ?? 1;
  if (!Number.isFinite(scale) || scale < 1 || scale > 4) throw new Error('OCR scale must be 1..4');
  if (args.language !== undefined && (typeof args.language !== 'string' || !args.language.trim() || args.language.length > 85)) throw new Error('invalid OCR language tag');
  return { scale, ...(args.language === undefined ? {} : { language: args.language }),
    maxWords: integer(args.max_words ?? 500, 'max_words', 1, 2000), maxChars: integer(args.max_chars ?? 16000, 'max_chars', 1, 64000) };
}
function common(result, request, reasons) {
  object(result, 'visual result');
  const region = result.searched;
  object(region, 'searched');
  for (const key of ['x', 'y', 'width', 'height']) integer(region[key], `searched.${key}`, key === 'x' || key === 'y' ? -2147483648 : 1, 2147483647);
  const requested = request.capture.region;
  if (region.width !== requested.width || region.height !== requested.height) throw new Error('visual result region size changed');
  if (request.capture.window) {
    const window = object(result.windowBounds, 'windowBounds');
    for (const key of ['x', 'y', 'width', 'height']) integer(window[key], `windowBounds.${key}`, key === 'x' || key === 'y' ? -2147483648 : 1, 2147483647);
    if (requested.x < 0 || requested.y < 0 || requested.x + requested.width > window.width || requested.y + requested.height > window.height
      || region.x !== window.x + requested.x || region.y !== window.y + requested.y) throw new Error('visual result window-relative region changed');
  } else if (result.windowBounds !== null || region.x !== requested.x || region.y !== requested.y) {
    throw new Error('visual result desktop region changed');
  }
  if (result.captureMode !== request.capture.captureMode) throw new Error('visual result capture mode changed');
  const complete = result.coverage === 'complete';
  if (!complete && result.coverage !== 'partial') throw new Error('visual result coverage is invalid');
  if (complete ? result.stopReason !== undefined : !reasons.includes(result.stopReason)) throw new Error('visual result stop reason contradicts coverage');
  integer(result.elapsedMs, 'elapsedMs', 0, Number.MAX_SAFE_INTEGER);
  return complete;
}
function inBounds(bounds, container) {
  object(bounds, 'bbox');
  if (![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite)
    || bounds.width <= 0 || bounds.height <= 0 || bounds.x < container.x - 0.02 || bounds.y < container.y - 0.02
    || bounds.x + bounds.width > container.x + container.width + 0.02 || bounds.y + bounds.height > container.y + container.height + 0.02) throw new Error('visual bbox is outside its source');
}
export function validateColorResult(result, request) {
  const complete = common(result, request, ['timeout', 'pixel_limit']);
  const total = result.searched.width * result.searched.height;
  integer(result.visitedPixels, 'visitedPixels', 0, total);
  integer(result.matchingPixels, 'matchingPixels', 0, result.visitedPixels);
  if (result.totalPixels !== total || (complete && result.visitedPixels !== total) || (!complete && result.visitedPixels >= total)
    || result.visitedPixels > request.maxPixels || (result.stopReason === 'pixel_limit' && result.visitedPixels !== request.maxPixels)) throw new Error('color result pixel coverage is inconsistent');
  if (result.found !== (result.matchingPixels > 0) || result.status !== (complete ? result.found ? 'found' : 'not_found' : 'incomplete')) throw new Error('color result status is inconsistent');
  if (result.tolerance !== request.tolerance || result.direction !== request.direction || JSON.stringify(result.rgb) !== JSON.stringify(request.rgb)) throw new Error('color result options changed');
  if (!Array.isArray(result.samples) || result.samples.length !== Math.min(result.matchingPixels, request.maxSamples)) throw new Error('color sample count is invalid');
  const seen = new Set();
  let previous = request.direction === 'row_major' ? -1 : total;
  for (const sample of result.samples) {
    integer(sample.x, 'sample.x', result.searched.x, result.searched.x + result.searched.width - 1);
    integer(sample.y, 'sample.y', result.searched.y, result.searched.y + result.searched.height - 1);
    if (!Array.isArray(sample.rgb) || sample.rgb.length !== 3 || sample.rgb.some((v, c) => !Number.isInteger(v) || v < 0 || v > 255 || Math.abs(v - request.rgb[c]) > request.tolerance)) throw new Error('color sample violates tolerance');
    const key = `${sample.x},${sample.y}`;
    if (seen.has(key)) throw new Error('duplicate color sample');
    seen.add(key);
    const index = (sample.y - result.searched.y) * result.searched.width + sample.x - result.searched.x;
    if (request.direction === 'row_major' ? index <= previous || index >= result.visitedPixels : index >= previous || index < total - result.visitedPixels) throw new Error('color sample order or visited prefix is inconsistent');
    previous = index;
  }
  return result;
}
export function validateOcrResult(result, request) {
  const complete = common(result, request, ['timeout', 'word_limit', 'character_limit']);
  if (result.engine !== 'windows_media_ocr' || result.confidenceAvailable !== false || result.confidenceReason !== 'engine_does_not_expose_score'
    || typeof result.language !== 'string' || !result.language || result.resizeFilter !== 'lanczos3') throw new Error('OCR engine metadata is inconsistent');
  if (result.status !== (complete ? 'recognized' : 'incomplete') || result.imageWidth !== Math.round(result.searched.width * request.scale)
    || result.imageHeight !== Math.round(result.searched.height * request.scale)) throw new Error('OCR dimensions/status are inconsistent');
  if (!Array.isArray(result.words) || !Array.isArray(result.lines) || result.words.length > request.maxWords) throw new Error('OCR word/line output is invalid');
  let chars = 0;
  for (const word of result.words) {
    if (typeof word.text !== 'string' || word.confidence !== null) throw new Error('OCR word text/confidence is invalid');
    chars += [...word.text].length;
    integer(word.lineIndex, 'lineIndex', 0, Number.MAX_SAFE_INTEGER);
    inBounds(word.bounds, result.searched);
    inBounds(word.imageBounds, { x: 0, y: 0, width: result.imageWidth, height: result.imageHeight });
    const expected = { x: result.searched.x + word.imageBounds.x * result.searched.width / result.imageWidth,
      y: result.searched.y + word.imageBounds.y * result.searched.height / result.imageHeight,
      width: word.imageBounds.width * result.searched.width / result.imageWidth,
      height: word.imageBounds.height * result.searched.height / result.imageHeight };
    if (Object.keys(expected).some(k => Math.abs(expected[k] - word.bounds[k]) > 0.02)) throw new Error('OCR word bbox mapping changed');
  }
  let cursor = 0, previousLine = -1;
  for (const line of result.lines) {
    if (typeof line.text !== 'string' || line.confidence !== null) throw new Error('OCR line text/confidence is invalid');
    chars += [...line.text].length;
    inBounds(line.bounds, result.searched);
    integer(line.lineIndex, 'lineIndex', 0, Number.MAX_SAFE_INTEGER);
    integer(line.wordStart, 'wordStart', 0, result.words.length);
    integer(line.wordCount, 'wordCount', 1, result.words.length);
    const group = result.words.slice(line.wordStart, line.wordStart + line.wordCount);
    if (line.wordStart !== cursor || line.lineIndex <= previousLine || group.length !== line.wordCount || group.some(w => w.lineIndex !== line.lineIndex)) throw new Error('OCR line points outside its words');
    const union = { x: Math.min(...group.map(w => w.bounds.x)), y: Math.min(...group.map(w => w.bounds.y)) };
    union.width = Math.max(...group.map(w => w.bounds.x + w.bounds.width)) - union.x;
    union.height = Math.max(...group.map(w => w.bounds.y + w.bounds.height)) - union.y;
    if (Object.keys(union).some(k => Math.abs(union[k] - line.bounds[k]) > 0.02)) throw new Error('OCR line bbox contradicts its words');
    cursor += line.wordCount;
    previousLine = line.lineIndex;
  }
  // 截断可保留最后一行的已知 words，但未输出完整 line；完整结果必须覆盖全部字。
  const tail = result.words.slice(cursor);
  if (complete ? tail.length > 0 : tail.some(w => w.lineIndex <= previousLine || w.lineIndex !== tail[0].lineIndex)) throw new Error('OCR words are not accounted for by lines');
  if (chars > request.maxChars) throw new Error('OCR character budget exceeded');
  return result;
}
export function validateOcrStatus(result) {
  object(result, 'OCR status');
  if (result.engine !== 'windows_media_ocr' || result.confidenceAvailable !== false || result.confidenceReason !== 'engine_does_not_expose_score'
    || !Array.isArray(result.languages) || result.languages.some(tag => typeof tag !== 'string' || !tag.trim())
    || new Set(result.languages).size !== result.languages.length) throw new Error('OCR status metadata is inconsistent');
  integer(result.maxImageDimension, 'maxImageDimension', 1, 2147483647);
  return result;
}
export function visualQuery(raw) {
  object(raw, 'query');
  if (raw.kind === 'color') return { ...raw, ...colorOptions(raw), min_pixels: integer(raw.min_pixels ?? 1, 'min_pixels', 1, 16000000) };
  if (raw.kind !== 'text' || typeof raw.text !== 'string' || !raw.text || [...raw.text].length > 16000) throw new Error('text query requires 1..16000 characters');
  const match = raw.match ?? 'contains', level = raw.level ?? 'line', sensitive = raw.case_sensitive ?? true;
  if (!['exact', 'contains'].includes(match) || !['word', 'line'].includes(level) || typeof sensitive !== 'boolean') throw new Error('invalid text matching options');
  return { ...raw, ...ocrOptions(raw), match, level, case_sensitive: sensitive };
}
export function visualCondition(query, result, state = 'present') {
  if (!['present', 'absent'].includes(state)) throw new Error('visual state must be present or absent');
  let matches, count;
  if (query.kind === 'color') {
    count = result.matchingPixels;
    matches = result.samples;
  } else {
    if (query.kind !== 'text' || typeof query.text !== 'string' || !query.text) throw new Error('text query requires nonempty text');
    if (!['exact', 'contains'].includes(query.match ?? 'contains') || !['word', 'line'].includes(query.level ?? 'line')) throw new Error('invalid text matching options');
    const normalize = value => query.case_sensitive === false ? value.toLocaleLowerCase() : value;
    const wanted = normalize(query.text);
    matches = (query.level === 'word' ? result.words : result.lines).filter(row => query.match === 'exact' ? normalize(row.text) === wanted : normalize(row.text).includes(wanted));
    count = matches.length;
  }
  const minimum = integer(query.min_pixels ?? 1, 'min_pixels', 1, 16000000);
  const present = count >= (query.kind === 'color' ? minimum : 1);
  // 一个已知命中能证明出现；只有完整区域和完整输出才能支持“这次没识别到”。
  return { fulfilled: state === 'present' ? present : !present && result.coverage === 'complete', matches,
    interpretation: query.kind === 'text' ? 'recognized_text_only' : 'matching_pixel_count' };
}

export async function waitForVisual({ sample, query, state = 'present', timeoutMs, pollMs, signal }) {
  integer(timeoutMs, 'timeout_ms', 100, 120000);
  integer(pollMs, 'poll_ms', 20, 1000);
  query = visualQuery(query);
  if (!['present', 'absent'].includes(state)) throw new Error('visual state must be present or absent');
  signal?.throwIfAborted();
  const started = performance.now(), deadline = started + timeoutMs;
  const controller = new AbortController(), timeout = new Error('visual wait deadline');
  const timer = setTimeout(() => controller.abort(timeout), timeoutMs);
  const abort = () => controller.abort(signal.reason);
  signal?.addEventListener('abort', abort, { once: true });
  // 等待自身也服从截止，不能被一个未及时响应 signal 的采样阻塞；原生 runner 同时终止进程。
  let rejectAbort;
  const stopped = new Promise((_, reject) => { rejectAbort = () => reject(controller.signal.reason); });
  controller.signal.addEventListener('abort', rejectAbort, { once: true });
  let attempts = 0, last, evaluation;
  try {
    while (performance.now() < deadline) {
      signal?.throwIfAborted();
      const remaining = Math.max(1, Math.floor(deadline - performance.now()));
      attempts++;
      last = await Promise.race([sample(remaining, controller.signal), stopped]);
      signal?.throwIfAborted();
      evaluation = visualCondition(query, last, state);
      if (performance.now() >= deadline) break;
      if (evaluation.fulfilled) return { fulfilled: true, reason: 'condition', attempts, last, evaluation, elapsed_ms: Math.round(performance.now() - started) };
      await delay(Math.min(pollMs, Math.max(1, deadline - performance.now())), undefined, { signal: controller.signal });
    }
    return { fulfilled: false, reason: 'timeout', attempts, last, evaluation, elapsed_ms: Math.round(performance.now() - started) };
  } catch (error) {
    signal?.throwIfAborted();
    const reason = controller.signal.reason === timeout || performance.now() >= deadline ? 'timeout' : 'error';
    return { fulfilled: false, reason, attempts, last, evaluation,
      ...(reason === 'error' ? { error: { code: error.code ?? 'COMPUTER_OPERATION_FAILED', message: error.message } } : {}),
      elapsed_ms: Math.round(performance.now() - started) };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    controller.signal.removeEventListener('abort', rejectAbort);
  }
}
