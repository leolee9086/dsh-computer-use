// OCR、找色和视觉等待均为纯观测。visual_id 仅标识结果，不能当截图/元素动作凭据。
import { randomUUID } from 'node:crypto';
import { VISUAL_SCOPE_SCHEMA, COLOR_OPTIONS_SCHEMA, OCR_OPTIONS_SCHEMA, integer, visualScope,
  colorOptions, ocrOptions, visualQuery, waitForVisual } from './visual.js';

const TIMEOUT = { type: 'integer', minimum: 1, maximum: 120000, description: 'Total budget including native startup/capture/recognition; default 10000 ms.' };
const QUERY_SCHEMA = { oneOf: [
  { type: 'object', additionalProperties: false, required: ['kind', 'rgb'], properties: {
    kind: { type: 'string', enum: ['color'] }, ...COLOR_OPTIONS_SCHEMA,
    min_pixels: { type: 'integer', minimum: 1, maximum: 16000000, description: 'Minimum matching pixel count, default 1. Samples do not limit the count.' },
  } },
  { type: 'object', additionalProperties: false, required: ['kind', 'text'], properties: {
    kind: { type: 'string', enum: ['text'] }, ...OCR_OPTIONS_SCHEMA, text: { type: 'string', minLength: 1, maxLength: 16000 },
    match: { type: 'string', enum: ['exact', 'contains'], description: 'Default contains.' },
    level: { type: 'string', enum: ['word', 'line'], description: 'Default line; truncated lines are not synthesized from a prefix.' },
    case_sensitive: { type: 'boolean', description: 'Default true.' },
  } },
] };
function object(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('arguments must be an object');
  return raw;
}

export function registerVisualTools({ register, textTool, provider, window }) {
  const capable = (kind) => {
    const driver = provider();
    if (driver.capabilities[kind] !== true) throw new Error(`${kind} is unsupported on this computer backend`);
    return driver;
  };
  const prepare = (args, exec) => {
    const capture = visualScope(args);
    if (args.window_id !== undefined) {
      // 固定当前会话已列出的身份；后续轮询每次在原生侧重读边界，绝不暗中提窗。
      const target = window(args.window_id, exec).nativeWindow;
      capture.window = { handle: target.id, processId: target.processId, title: target.title };
    }
    return capture;
  };
  const report = (result, args) => result === undefined ? undefined : ({ ...result,
    visual_id: `visual-${randomUUID()}`, observed_at: new Date().toISOString(),
    observation_domain: 'visual', coordinate_space: 'desktop_native_pixels',
    ...(args.window_id === undefined ? {} : { window_id: args.window_id }),
  });

  register(textTool('computer_find_color',
    'Scan every RGB pixel in a required bounded region, with inclusive per-channel tolerance and explicit sample order. Returns matching pixel count independently of samples, complete/partial coverage and absolute native coordinates. Pure observation; does not focus a window or provide click credentials.',
    { type: 'object', additionalProperties: false, required: ['region', 'rgb'], properties: {
      ...VISUAL_SCOPE_SCHEMA, ...COLOR_OPTIONS_SCHEMA, timeout_ms: TIMEOUT,
    } }, async (raw, exec) => {
      const args = object(raw), options = colorOptions(args), budgetMs = integer(args.timeout_ms ?? 10000, 'timeout_ms', 1, 120000);
      const driver = capable('colorSearch'), capture = prepare(args, exec);
      return JSON.stringify(report(await driver.findColor({ capture, ...options, budgetMs }, exec.signal), args));
    }));

  register(textTool('computer_ocr',
    'Windows OCR operation:status reports installed languages, dimension limit and confidence availability. operation:read requires region and returns words/lines with absolute and OCR image bboxes, explicit scale mapping and complete/partial output. No confidence scores are exposed by this engine; min_confidence is rejected. Pure observation; no window focus or click credentials.',
    { type: 'object', additionalProperties: false, required: ['operation'], properties: {
      operation: { type: 'string', enum: ['status', 'read'] }, ...VISUAL_SCOPE_SCHEMA, ...OCR_OPTIONS_SCHEMA, timeout_ms: TIMEOUT,
    } }, async (raw, exec) => {
      const args = object(raw), budgetMs = integer(args.timeout_ms ?? 10000, 'timeout_ms', 1, 120000);
      const driver = capable('ocr');
      if (args.operation === 'status') {
        if (Object.keys(args).some(key => !['operation', 'timeout_ms'].includes(key))) throw new Error('OCR status accepts only operation and timeout_ms');
        return JSON.stringify(await driver.ocrStatus(exec.signal, budgetMs));
      }
      if (args.operation !== 'read') throw new Error('OCR operation must be status or read');
      const options = ocrOptions(args), capture = prepare(args, exec);
      return JSON.stringify(report(await driver.recognizeText({ capture, ...options, budgetMs }, exec.signal), args));
    }));

  register(textTool('computer_wait_visual',
    'Wait for a color pixel count or recognized OCR word/line to be present/absent in a required bounded region. Every attempt recaptures the fixed source identity under one deadline. Partial output can prove a known hit; absence requires complete coverage. OCR absence means no recognized match, not proof the screen has no text. Capture/source errors stop waiting; no input is sent.',
    { type: 'object', additionalProperties: false, required: ['region', 'query'], properties: {
      ...VISUAL_SCOPE_SCHEMA, query: QUERY_SCHEMA,
      state: { type: 'string', enum: ['present', 'absent'], description: 'Default present.' },
      timeout_ms: { ...TIMEOUT, minimum: 100 }, poll_ms: { type: 'integer', minimum: 20, maximum: 1000, description: 'Default 100 ms between completed samples.' },
    } }, async (raw, exec) => {
      const args = object(raw), query = visualQuery(args.query);
      const timeoutMs = integer(args.timeout_ms ?? 10000, 'timeout_ms', 100, 120000), pollMs = integer(args.poll_ms ?? 100, 'poll_ms', 20, 1000);
      const state = args.state ?? 'present';
      if (!['present', 'absent'].includes(state)) throw new Error('visual state must be present or absent');
      const driver = capable('visualWait');
      capable(query.kind === 'color' ? 'colorSearch' : 'ocr');
      const capture = prepare(args, exec), options = query.kind === 'color' ? colorOptions(args.query) : ocrOptions(args.query);
      const sample = (remaining, signal) => driver[query.kind === 'color' ? 'findColor' : 'recognizeText']({ capture, ...options, budgetMs: remaining }, signal);
      const result = await waitForVisual({ sample, query, state, timeoutMs, pollMs, signal: exec.signal });
      return JSON.stringify({ ...result, last: report(result.last, args) });
    }));
}
