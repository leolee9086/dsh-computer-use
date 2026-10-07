import { createHash, randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { flattenAccessibilityTree } from './semantics.js';
import { acquisitionArgs, queryArgs, SEMANTIC_ACQUISITION_SCHEMA } from './semantic-query.js';
import { NARRATOR_COMMANDS, narratorAction } from './narrator.js';
import { INPUT_STEPS_SCHEMA, MODIFIERS, inputSequenceArgs, keyOptions } from './input-actions.js';
import { accessibilityElementById, findAccessibilityElements } from './semantics.js';
import { ELEMENT_OPERATIONS, PATTERN_BY_OPERATION, SEMANTIC_PARAMETERS, semanticActionArgs, textRangeArgs } from './accessibility-actions.js';

const OBSERVATION_TOOLS = new Set([
  'computer_accessibility',
  'computer_find',
  'computer_find_image',
  'computer_read',
  'computer_screenshot',
  'computer_status',
]);

const TOOL_NAMES = new Set([
  ...OBSERVATION_TOOLS,
  'computer_click',
  'computer_click_image',
  'computer_drag',
  'computer_element',
  'computer_key',
  'computer_input',
  'computer_move',
  'computer_narrator',
  'computer_window_input',
  'computer_scroll',
  'computer_type',
  'computer_windows',
]);

/**
 * `computer_click_image` 的默认相似度门槛。
 * 比 `computer_find_image` 的 0.9 更严：find 只是"我看它像"，错了无非白看一眼；
 * click 是"我按下去了"，错了就是点错东西 —— 而且它点的是算法算出来的那个位置。
 */
const CLICK_IMAGE_THRESHOLD = 0.95;

const DEFAULTS = Object.freeze({
  observeApproval: 'ask',
  controlApproval: 'ask',
  maxObservationAgeMs: 120_000,
  maxObservationsPerAgent: 8,
  maxSemanticSnapshots: 8,
  maxSemanticMatches: 20,
});

function configEnum(raw, key, fallback) {
  const value = raw[key] ?? fallback;
  if (!['allow', 'ask', 'deny'].includes(value)) {
    throw new Error(`dsh-computer-use/tool: ${key} must be allow, ask, or deny`);
  }
  return value;
}

function positiveInteger(raw, key, fallback) {
  const value = raw[key] ?? fallback;
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`dsh-computer-use/tool: ${key} must be a positive integer`);
  }
  return value;
}

function resolveConfig(raw = {}) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('dsh-computer-use/tool: config must be an object');
  }
  return Object.freeze({
    observeApproval: configEnum(raw, 'observeApproval', DEFAULTS.observeApproval),
    controlApproval: configEnum(raw, 'controlApproval', DEFAULTS.controlApproval),
    maxObservationAgeMs: positiveInteger(raw, 'maxObservationAgeMs', DEFAULTS.maxObservationAgeMs),
    maxObservationsPerAgent: positiveInteger(raw, 'maxObservationsPerAgent', DEFAULTS.maxObservationsPerAgent),
    maxSemanticSnapshots: positiveInteger(raw, 'maxSemanticSnapshots', DEFAULTS.maxSemanticSnapshots),
    maxSemanticMatches: positiveInteger(raw, 'maxSemanticMatches', DEFAULTS.maxSemanticMatches),
  });
}

function object(args) {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) throw new Error('arguments must be an object');
  return args;
}

function requiredString(args, key) {
  const value = args[key];
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${key} must be a non-empty string`);
  return value;
}

function optionalNonBlankString(args, key) {
  const value = args[key];
  if (value === undefined || value === '') return undefined;
  if (typeof value !== 'string') throw new Error(`${key} must be a string`);
  return value;
}

function finiteNumber(args, key) {
  const value = args[key];
  if (!Number.isFinite(value)) throw new Error(`${key} must be a finite number`);
  return value;
}

function optionalInteger(args, key, fallback) {
  const value = args[key] ?? fallback;
  if (!Number.isInteger(value)) throw new Error(`${key} must be an integer`);
  return value;
}

/**
 * Optional finite number. Returns undefined when absent so callers can distinguish
 * "not requested" from an explicit value — needed because a region may be specified
 * fully or not at all, and `0` is a perfectly valid coordinate or offset.
 */
function optionalFiniteNumber(args, key) {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${key} must be a finite number`);
  return value;
}

/**
 * Read an optional capture region from tool arguments.
 *
 * Rules that keep this from producing silently-wrong images:
 * - all four of x/y/width/height must be present together, or none of them
 * - width/height must be >= 1 (a zero-area crop is always a mistake)
 * - x/y may be negative: the virtual desktop can extend left of / above the primary display
 */
function optionalRegion(args) {
  const x = optionalFiniteNumber(args, 'x');
  const y = optionalFiniteNumber(args, 'y');
  const width = optionalFiniteNumber(args, 'width');
  const height = optionalFiniteNumber(args, 'height');
  const given = [x, y, width, height].filter((value) => value !== undefined).length;
  if (given === 0) return undefined;
  if (given !== 4) throw new Error('a capture region needs x, y, width and height together');
  if (width < 1 || height < 1) throw new Error('capture region width and height must be at least 1 pixel');
  return { x, y, width, height };
}

function enumValue(args, key, allowed, fallback) {
  const value = args[key] ?? fallback;
  if (!allowed.includes(value)) throw new Error(`${key} must be one of ${allowed.join(', ')}`);
  return value;
}

function arrayOfStrings(args, key) {
  const value = args[key] ?? [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new Error(`${key} must be an array of strings`);
  }
  return value;
}

function describeJson(value) {
  return JSON.stringify(value, null, 2);
}

function computer(ctx) {
  const value = ctx.get('computer');
  if (value === undefined) throw new Error('computer provider is not mounted in the host composition');
  return value;
}

async function assertImageCapableRoute(ctx, exec) {
  const routed = exec.agent?.session.requestHeader?.()?.config;
  const provider = routed?.provider ?? exec.agent?.options?.provider;
  const model = routed?.model ?? exec.agent?.options?.model;
  const llm = ctx.get('llm');
  if (provider === undefined || model === undefined || llm === undefined) {
    throw new Error('cannot capture a desktop screenshot because the current model route could not be resolved');
  }
  const active = await llm.resolveModelInfo(provider, model, exec.signal);
  if (active.inputModalities === undefined || !active.inputModalities.includes('image')) {
    throw new Error(`cannot capture a desktop screenshot because model '${model}' does not declare image input`);
  }
}

function agentState(states, exec) {
  if (exec.agent === undefined || exec.agent === null || typeof exec.agent !== 'object') {
    throw new Error('computer-use tools require an agent session');
  }
  let value = states.get(exec.agent);
  if (value === undefined) {
    value = { owner: randomUUID(), observations: new Map(), semanticSnapshots: new Map(), windowLists: new Map(), childWindowLists: new Map() };
    states.set(exec.agent, value);
  }
  return value;
}

/** Convert a coordinate measured on a persisted model image into native desktop pixels. */
export function mapScreenshotPoint(observation, x, y) {
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('coordinates must be finite numbers');
  if (x < 0 || y < 0 || x >= observation.image.width || y >= observation.image.height) {
    throw new Error(`coordinates (${x}, ${y}) fall outside screenshot ${observation.image.width}x${observation.image.height}`);
  }
  const mapAxis = (sourceStart, sourceSize, imageSize, coordinate) => (
    Math.min(sourceStart + sourceSize - 1, Math.max(
      sourceStart,
      Math.round(sourceStart + (coordinate / imageSize) * sourceSize),
    ))
  );
  return {
    x: mapAxis(observation.sourceBounds.x, observation.sourceBounds.width, observation.image.width, x),
    y: mapAxis(observation.sourceBounds.y, observation.sourceBounds.height, observation.image.height, y),
  };
}

function freshObservation(states, exec, screenshotId, config, readFrozen = false) {
  const record = agentState(states, exec).observations.get(screenshotId);
  if (record === undefined) throw new Error(`screenshot '${screenshotId}' is unavailable in this session; capture a new screenshot`);
  if (!readFrozen && record.consumedAt !== undefined) {
    throw new Error(`screenshot '${screenshotId}' was consumed by an action affecting its layout; capture the relevant surface again`);
  }
  const age = Date.now() - record.capturedAt;
  if (age > config.maxObservationAgeMs) {
    throw new Error(`screenshot '${screenshotId}' is ${age}ms old; capture a new screenshot before controlling the desktop`);
  }
  return record;
}

function freshSemanticSnapshot(states, exec, snapshotId, config, readFrozen = false) {
  const record = agentState(states, exec).semanticSnapshots.get(snapshotId);
  if (record === undefined) throw new Error(`accessibility snapshot '${snapshotId}' is unavailable in this session; capture a new semantic snapshot`);
  if (!(readFrozen && record.consistency?.status === 'frozen') && record.consumedAt !== undefined) {
    throw new Error(`accessibility snapshot '${snapshotId}' was consumed by an action affecting its state; observe the relevant branch again`);
  }
  const age = Date.now() - record.capturedAt;
  if (age > config.maxObservationAgeMs) {
    throw new Error(`accessibility snapshot '${snapshotId}' is ${age}ms old; capture a new semantic snapshot before controlling the desktop`);
  }
  return record;
}

function freshWindow(states, exec, windowId, config) {
  const state = agentState(states, exec);
  for (const list of state.windowLists.values()) {
    const window = list.windows.get(windowId);
    if (window === undefined) continue;
    const age = Date.now() - list.capturedAt;
    if (age > config.maxObservationAgeMs) {
      throw new Error(`window '${windowId}' is ${age}ms old; list native windows again before focusing one`);
    }
    return window;
  }
  throw new Error(`window '${windowId}' is unavailable in this session; list native windows before focusing one`);
}

/** A semantic observation can stand on its own, or retain its exact image binding. */
function semanticEvidence(states, exec, args, config) {
  const snapshotId = requiredString(args, 'snapshot_id');
  const snapshot = freshSemanticSnapshot(states, exec, snapshotId, config);
  const screenshotId = optionalNonBlankString(args, 'screenshot_id');
  if (snapshot.screenshotId !== undefined) {
    const screenshot = freshObservation(states, exec, screenshotId ?? snapshot.screenshotId, config);
    if ((screenshotId ?? snapshot.screenshotId) !== snapshot.screenshotId || screenshot.contentHash !== snapshot.screenshotHash) {
      throw new Error(`semantic snapshot '${snapshotId}' is not bound to screenshot '${screenshotId}'; capture accessibility immediately after that screenshot`);
    }
  } else if (screenshotId !== undefined) {
    throw new Error('this semantic snapshot has no screenshot binding; omit screenshot_id');
  }
  return { snapshotId, snapshot };
}

const KEYBOARD_EVIDENCE_SCHEMA = {
  screenshot_id: { type: 'string' }, snapshot_id: { type: 'string' }, window_id: { type: 'string' },
};
function keyboardEvidence(states, exec, args, config) {
  const ids = ['screenshot_id', 'snapshot_id', 'window_id'].filter((key) => args[key] !== undefined && args[key] !== '');
  if (ids.length === 0) throw new Error('keyboard input requires screenshot_id, snapshot_id or window_id');
  let observation;
  const targets = [];
  if (ids.includes('screenshot_id')) {
    observation = freshObservation(states, exec, requiredString(args, 'screenshot_id'), config);
    if (observation.captureMode === 'print-window') throw new Error('background screenshots only support targeted window input or semantic actions; capture in foreground before native input');
    if (observation.focus !== undefined) targets.push(observation.focus);
  }
  if (ids.includes('snapshot_id')) {
    const { snapshot } = semanticEvidence(states, exec, args, config);
    if (snapshot.focus === undefined) throw new Error('semantic keyboard input needs a window-bound snapshot; observe accessibility with window_id');
    targets.push(snapshot.focus);
  }
  if (ids.includes('window_id')) {
    const record = freshWindow(states, exec, requiredString(args, 'window_id'), config);
    targets.push({ handle: record.nativeWindow.id, processId: record.nativeWindow.processId, title: record.nativeWindow.title });
  }
  const focus = targets[0];
  if (targets.some((target) => target.handle !== focus.handle || target.processId !== focus.processId || target.title !== focus.title)) throw new Error('keyboard evidence refers to different windows');
  return { observation, focus, evidence: ids.map((key) => args[key]).join(', ') };
}
function foregroundObservation(states, exec, screenshotId, config) {
  const observation = freshObservation(states, exec, screenshotId, config);
  if (observation.captureMode === 'print-window') throw new Error('background screenshots cannot ground global pointer input; use computer_window_input or a foreground capture');
  return observation;
}

function consumeAllObservations(states, exec, focus, semanticChanged = true, foregroundChanged = false) {
  const state = agentState(states, exec);
  const consumedAt = Date.now();
  // 身份名册与布局/状态分开：动作不能无故消费窗口或子窗口身份。
  const relevant = (record) => focus === undefined || record.focus === undefined || record.focus.handle === focus.handle;
  for (const observation of state.observations.values()) if (relevant(observation) || foregroundChanged && observation.captureMode !== 'print-window') observation.consumedAt = consumedAt;
  if (semanticChanged) for (const snapshot of state.semanticSnapshots.values()) if (relevant(snapshot)) snapshot.consumedAt = consumedAt;
}

function rememberBounded(map, id, value, limit) {
  map.set(id, value);
  while (map.size > limit) map.delete(map.keys().next().value);
}

function contentHash(data) {
  return createHash('sha256').update(data).digest('hex');
}

function observationText(value) {
  const xScale = value.source_bounds.width / value.image.width;
  const yScale = value.source_bounds.height / value.image.height;
  // 明确区分前台像素与 PrintWindow 渲染：后台图像不能授权全局指针输入。
  const raised = value.window === undefined
    ? ''
    : `${value.capture_mode === 'print-window' ? 'Captured in background with PrintWindow' : 'Raised for this capture'}: "${value.window.title}" (${value.window.id}).\n`;
  return `<computer-screenshot id="${value.screenshot_id}">
${raised}${value.image.mediaType} attachment: ${value.image.width}x${value.image.height} px; SHA-256: ${value.content_hash}.
Native source bounds: x=${value.source_bounds.x}, y=${value.source_bounds.y}, width=${value.source_bounds.width}, height=${value.source_bounds.height}.
${value.capture_mode === 'print-window'
    ? 'Background image: use semantic controls or valid observed child HWND client coordinates; this image cannot authorize global pointer input.'
    : 'Use image coordinates with this exact screenshot id for click, drag, or scroll.'} Coordinate scale: x=${xScale.toFixed(4)}, y=${yScale.toFixed(4)}.
</computer-screenshot>`;
}

function screenshotSchema() {
  const schema = {
    type: 'object',
    additionalProperties: false,
    required: ['screenshot_id', 'captured_at', 'content_hash', 'source_bounds'],
    properties: {
      screenshot_id: { type: 'string' },
      captured_at: { type: 'number' },
      content_hash: { type: 'string' },
      capture_mode: { type: 'string' },
      source_bounds: {
        type: 'object',
        additionalProperties: false,
        required: ['x', 'y', 'width', 'height'],
        properties: { x: { type: 'number' }, y: { type: 'number' }, width: { type: 'number' }, height: { type: 'number' } },
      },
      file: { type: 'object', additionalProperties: false, required: ['path', 'mediaType', 'bytes', 'width', 'height'], properties: { path: { type: 'string' }, mediaType: { type: 'string' }, bytes: { type: 'number' }, width: { type: 'number' }, height: { type: 'number' } } },
      image: {
        type: 'object',
        additionalProperties: false,
        required: ['attachmentId', 'mediaType', 'bytes', 'width', 'height'],
        properties: {
          attachmentId: { type: 'string' }, mediaType: { type: 'string' }, bytes: { type: 'number' }, width: { type: 'number' }, height: { type: 'number' }, name: { type: 'string' },
          originalDimensions: {
            type: 'object',
            additionalProperties: false,
            required: ['width', 'height'],
            properties: { width: { type: 'number' }, height: { type: 'number' } },
          },
        },
      },
      window: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'title'],
        properties: { id: { type: 'string' }, title: { type: 'string' }, application: { type: 'string' } },
      },
    },
  };
  // DSH 输出 schema 使用自己的 JSON Schema 子集，oneOf 必须是独立分支，
  // 不能与 type/properties 并列。每支明确排除另一种输出，保留可靠的形态校验。
  return { oneOf: ['image', 'file'].map((kind) => {
    const properties = { ...schema.properties };
    delete properties[kind === 'image' ? 'file' : 'image'];
    return { ...schema, properties, required: [...schema.required, kind] };
  }) };
}

function textTool(name, description, parameters, execute) {
  return {
    name,
    description,
    parameters,
    output: {
      schema: { type: 'string' },
      render(_args, value) { return [{ type: 'text', text: value }]; },
    },
    execute,
  };
}

function imageTool(name, description, parameters, execute) {
  return {
    name,
    description,
    parameters,
    output: {
      schema: screenshotSchema(),
      render(_args, value) {
        if (value.file !== undefined) return [{ type: 'text', text: describeJson(value) }];
        return [
          { type: 'text', text: observationText(value) },
          { type: 'image', attachment: value.image },
        ];
      },
    },
    execute,
  };
}

function isObservationExecution(exec) {
  if (exec.name === 'computer_narrator') return exec.arguments?.operation === 'status';
  if (OBSERVATION_TOOLS.has(exec.name)) {
    // 指名窗口的截图会先把该窗口提到前台，那是有后果的控制动作，按控制类审批。
    // 不带 window_id 的截图仍然是纯观测。
    if (exec.name === 'computer_screenshot'
      && exec.arguments !== null
      && typeof exec.arguments === 'object'
      && !Array.isArray(exec.arguments)
      && exec.arguments.window_id !== undefined && exec.arguments.background !== true) return false;
    return true;
  }
  return exec.name === 'computer_windows'
    && exec.arguments !== null
    && typeof exec.arguments === 'object'
    && !Array.isArray(exec.arguments)
    && ['list', 'children'].includes(exec.arguments.operation);
}

function policyDecision(policy, description) {
  if (policy === 'allow') return undefined;
  if (policy === 'deny') return { kind: 'deny', reason: `dsh-computer-use configuration denies ${description}` };
  return { kind: 'ask', reason: `Allow ${description}?` };
}

function configuredPolicyForExecution(config, exec) {
  return isObservationExecution(exec) ? config.observeApproval : config.controlApproval;
}

function inheritsFullAccess(ctx, exec) {
  if (exec.agent === undefined || typeof ctx.get !== 'function') return false;
  const session = exec.agent.session;
  if (session === null || typeof session !== 'object') return false;
  const permissionPresets = ctx.get('permissionPresets');
  if (permissionPresets === undefined
    || typeof permissionPresets.current !== 'function'
    || typeof permissionPresets.resolve !== 'function') return false;
  try {
    // current() 接收 Session 对象(内部经 sessionProjections 折叠权限状态)。
    const preset = permissionPresets.current(session);
    const spec = permissionPresets.resolve(preset);
    return spec !== null && typeof spec === 'object'
      && spec.sandbox === 'danger-full-access'
      && spec.approval === 'never';
  } catch {
    // An unavailable optional permission service cannot grant desktop access.
    return false;
  }
}

function policyDecisionForExecution(ctx, config, exec) {
  const observation = isObservationExecution(exec);
  const configured = configuredPolicyForExecution(config, exec);
  const policy = configured === 'ask' && inheritsFullAccess(ctx, exec) ? 'allow' : configured;
  return policyDecision(policy, observation ? 'desktop observation' : 'desktop control');
}

async function enforceLocalPolicy(ctx, config, pipelineAsks, exec) {
  const decision = policyDecisionForExecution(ctx, config, exec);
  if (decision === undefined) return;
  if (decision.kind === 'deny') throw new Error(decision.reason);
  if (pipelineAsks.has(exec)) return;
  const approval = ctx.get('approval');
  if (approval === undefined) throw new Error(`tool "${exec.name}" requires approval, but no approval channel is available`);
  if (exec.agent === undefined) throw new Error(`tool "${exec.name}" requires approval, but the call has no agent to route it through`);
  const outcome = await approval.request({
    agent: exec.agent,
    toolName: exec.name,
    callId: exec.callId,
    reason: decision.reason,
    signal: exec.signal,
  });
  switch (outcome) {
    case 'allowed-once': return;
    case 'rejected': throw new Error(`the user rejected tool "${exec.name}"`);
    case 'cancelled': throw new Error(`approval for tool "${exec.name}" was cancelled`);
    case 'unavailable': throw new Error(`tool "${exec.name}" requires approval, but no approval channel is available`);
    default: throw new Error(`tool "${exec.name}" received an invalid approval outcome`);
  }
}

export const name = 'dsh-computer-use-tool';
export const inject = ['tools', 'computer'];

export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig);
  const observations = new WeakMap();
  const pipelineAsks = new WeakSet();
  // 参数验证发生在进入 control 之前。提供者明确未开始的失败保留观测；
  // 已执行、部分执行或结果未知才使受影响的布局/状态失效。
  const control = async (exec, operation, focus, semanticChanged = true, foregroundChanged = false) => {
    try {
      const result = await operation();
      consumeAllObservations(observations, exec, focus, semanticChanged, foregroundChanged);
      return result;
    } catch (error) {
      if (error.executionState !== 'not_started') consumeAllObservations(observations, exec, focus, semanticChanged, foregroundChanged);
      throw error;
    }
  };
  const performInput = (action, exec) => control(exec, () => computer(ctx).perform(action, exec.signal), action.focus, action.kind !== 'move', action.focus !== undefined);
  // 观测按页面建索引；原生续页只保留后端游标，不在模型输出拼接总树。
  const acquireSemantic = async (args, exec, query) => {
    const state = agentState(observations, exec);
    const previousId = optionalNonBlankString(args, 'snapshot_id');
    const cursor = optionalNonBlankString(args, 'cursor');
    // 只读续页可以阅读已被动作影响的历史封存结果；动作证据仍走默认严格检查。
    const previous = previousId === undefined ? undefined : freshSemanticSnapshot(observations, exec, previousId, config, cursor !== undefined);
    const readFrozen = cursor !== undefined && previous?.consistency?.status === 'frozen';
    const rootId = optionalNonBlankString(args, 'root_element_id');
    if ((cursor !== undefined || rootId !== undefined) && previous === undefined) throw new Error('cursor/root_element_id requires its snapshot_id');
    if (cursor !== undefined && (previous.nextCursor !== cursor || rootId !== undefined)) throw new Error('cursor must be the next_cursor of that page; omit root_element_id');
    const root = rootId === undefined ? undefined : accessibilityElementById(previous.tree, rootId);
    if (rootId !== undefined && root === undefined) throw new Error('root_element_id is not in the specified observation');
    const screenshotId = optionalNonBlankString(args, 'screenshot_id') ?? previous?.screenshotId;
    const screenshot = screenshotId === undefined ? undefined : freshObservation(observations, exec, screenshotId, config, readFrozen);
    const windowId = optionalNonBlankString(args, 'window_id');
    const window = windowId === undefined ? undefined : freshWindow(observations, exec, windowId, config);
    const backend = enumValue(args, 'backend', ['native', 'uia', 'msaa'], previous?.backend ?? 'native');
    if ((rootId !== undefined || cursor !== undefined) && backend !== previous.backend && !(backend === 'native' && previous.backend === 'uia')) throw new Error('subtree/cursor backend changed');
    const focus = window === undefined ? previous?.focus ?? screenshot?.focus : {
      handle: window.nativeWindow.id, processId: window.nativeWindow.processId, title: window.nativeWindow.title,
    };
    if (focus !== undefined && screenshot?.focus !== undefined && focus.handle !== screenshot.focus.handle) throw new Error('window and screenshot refer to different windows');
    if (previous?.focus !== undefined && focus?.handle !== previous.focus.handle) throw new Error('subtree/cursor window changed');
    const provider = computer(ctx);
    if ((root !== undefined || cursor !== undefined || query !== undefined) && provider.capabilities.semanticPaging !== true) throw new Error('native semantic paging/query is unsupported on this backend');
    const options = acquisitionArgs(args);
    if (options.consistency !== undefined && provider.capabilities.semanticSnapshots !== true) throw new Error('semantic consistency selection is unsupported on this backend');
    options.consistency ??= cursor === undefined ? (provider.capabilities.semanticSnapshots ? 'snapshot' : undefined) : previous.consistencyMode;
    if (cursor !== undefined) {
      for (const [parameter, stored] of [['scope', 'scope'], ['maxDepth', 'maxDepth'], ['detail', 'detail'], ['consistency', 'consistencyMode']]) {
        if (options[parameter] !== undefined && options[parameter] !== previous[stored]) throw new Error(`cursor ${parameter} changed; start a new observation`);
      }
      if (screenshotId !== previous.screenshotId) throw new Error('cursor screenshot binding changed');
      query ??= previous.query;
    }
    const signature = cursor === undefined ? JSON.stringify({ backend, root: root?.element_id, query, scope: options.scope ?? 'subtree', depth: options.maxDepth, consistency: options.consistency }) : previous.signature;
    if (cursor !== undefined && query !== undefined && JSON.stringify(query) !== JSON.stringify(previous.query)) throw new Error('cursor query changed; start a new query');
    const tree = await provider.accessibilitySnapshot(focus?.handle, exec.signal, { ...options, backend, owner: state.owner, root, cursor,
      signature, workerGeneration: cursor === undefined ? undefined : previous.workerGeneration,
      query: cursor === undefined ? query : previous.query, maxResults: query === undefined ? undefined : config.maxSemanticMatches,
      window: window?.nativeWindow ?? (focus === undefined ? undefined : { id: focus.handle, processId: focus.processId, title: focus.title }),
    });
    const metadata = tree.acquisition;
    if (readFrozen && (metadata?.result_id !== previous.resultId || metadata?.consistency?.sha256 !== previous.consistency.sha256 || metadata?.consistency?.status !== 'frozen')) {
      throw new Error('cursor result changed; discard the inconsistent page and start a new observation');
    }
    const actualFocus = focus ?? metadata?.window;
    const snapshotId = `semantic-${randomUUID()}`;
    const capturedAt = metadata?.consistency?.capture_finished_at ?? Date.now();
    flattenAccessibilityTree(tree);
    const snapshot = { capturedAt, focus: actualFocus, backend: metadata?.backend ?? tree.backend ?? backend, tree,
      consistency: metadata?.consistency ?? { mode: 'live', status: 'unverified', source_atomic: false },
      consistencyMode: options.consistency, resultId: metadata?.result_id,
      ...(readFrozen && previous.consumedAt !== undefined ? { consumedAt: previous.consumedAt } : {}),
      ...(screenshot === undefined ? {} : { screenshotId, screenshotHash: screenshot.contentHash }),
      coverage: metadata?.coverage ?? { status: 'unknown', reason: 'backend_does_not_report_coverage' },
      nextCursor: metadata?.next_cursor, workerGeneration: metadata?.worker_generation, signature, query: cursor === undefined ? query : previous.query,
      scope: cursor === undefined ? options.scope ?? 'subtree' : previous.scope,
      maxDepth: cursor === undefined ? metadata?.coverage?.max_depth ?? options.maxDepth : previous.maxDepth,
      detail: cursor === undefined ? options.detail ?? 'summary' : previous.detail,
    };
    rememberBounded(state.semanticSnapshots, snapshotId, snapshot, config.maxSemanticSnapshots);
    return { snapshot_id: snapshotId, captured_at: capturedAt, backend: snapshot.backend,
      ...(screenshot === undefined ? {} : { screenshot_id: screenshotId, screenshot_hash: screenshot.contentHash }),
      coverage: snapshot.coverage, consistency: snapshot.consistency, result_id: snapshot.resultId, next_cursor: snapshot.nextCursor,
      ...(metadata === undefined ? {} : { visited_nodes: metadata.visited_nodes, validated_nodes: metadata.validated_nodes, returned_nodes: metadata.returned_nodes, elapsed_ms: metadata.elapsed_ms, native_calls: metadata.native_calls, host_timing: metadata.host_timing }),
      ...(query === undefined ? { tree } : { matches: flattenAccessibilityTree(tree) }),
    };
  };
  const registerTool = (tools, definition) => tools.register({
    ...definition,
    async execute(rawArgs, exec) {
      await enforceLocalPolicy(ctx, config, pipelineAsks, exec);
      return definition.execute(rawArgs, exec);
    },
  });

  ctx.on('tools/pre-execute', async (exec, next) => {
    if (!TOOL_NAMES.has(exec.name)) return next();
    const localDecision = policyDecisionForExecution(ctx, config, exec);
    if (localDecision?.kind === 'deny') return localDecision;
    if (localDecision?.kind === 'ask') pipelineAsks.add(exec);
    const downstream = await next();
    if (downstream.kind !== 'allow') return downstream;
    return localDecision ?? downstream;
  });

  ctx.tools.guard((exec) => {
    if (!TOOL_NAMES.has(exec.name)) return undefined;
    const decision = policyDecisionForExecution(ctx, config, exec);
    return decision?.kind === 'deny' ? decision.reason : undefined;
  });

  // 文件采集无需附件或模型服务，工具始终注册；图像投送才解析附件服务。
  {
    const nested = ctx;
    registerTool(ctx.tools, imageTool(
      'computer_screenshot',
      'Capture the desktop, a display, one region, or one named native window as a model-visible image. '
      + 'Passing window_id alone raises that window and captures it in a single step; that form counts as desktop control. '
      + 'Windows background:true instead uses PrintWindow without raising/restoring; rendering depends on the application. '
      + 'Foreground image output supports coordinate actions. output:file saves metadata without image delivery.',
      {
        type: 'object',
        additionalProperties: false,
        properties: {
          display_id: { type: 'string', description: 'Optional display id from computer_status. Omit for the whole virtual desktop.' },
          x: { type: 'number', description: 'Optional capture region left edge, in virtual-desktop pixels (may be negative). Give x, y, width and height together.' },
          y: { type: 'number', description: 'Optional capture region top edge, in virtual-desktop pixels (may be negative).' },
          width: { type: 'number', description: 'Optional capture region width in pixels (>= 1).' },
          height: { type: 'number', description: 'Optional capture region height in pixels (>= 1).' },
          scale: { type: 'number', description: 'Optional zoom factor applied after cropping (1 = native pixels, 2 = magnified 2x). Useful for reading small text; the image is still capped by the configured max dimension.' },
          window_id: { type: 'string', description: 'Optional window_id from computer_windows. Raises that window to the foreground and captures the bounds it actually has at that moment, in one step — use it to capture a specific window even when it is covered. Give it alone (no x/y/width/height and no display_id).' },
          background: { type: 'boolean', description: 'Windows only, requires window_id. Render with PrintWindow without raising or restoring the window. GPU/protected/minimized windows may not render. Global pointer input cannot use this image; use semantic actions or computer_window_input.' },
          output: { type: 'string', enum: ['image', 'file'], description: 'Default image delivers an attachment. file requires save_to and returns PNG metadata without image delivery.' },
          save_to: { type: 'string', description: 'Optional file path to also write the captured PNG to. Use it to keep a template for computer_find_image: these are the original PNG bytes, not the re-encoded copy attached for viewing, so matching against it keeps full fidelity.' },
        },
      },
      async (rawArgs, exec) => {
        const args = object(rawArgs);
        const displayId = optionalNonBlankString(args, 'display_id');
        const region = optionalRegion(args);
        const scale = optionalFiniteNumber(args, 'scale');
        const windowId = optionalNonBlankString(args, 'window_id');
        const saveTo = optionalNonBlankString(args, 'save_to');
        if (args.background !== undefined && typeof args.background !== 'boolean') throw new Error('background must be boolean');
        if (args.background === true && windowId === undefined) throw new Error('background requires window_id');
        if (args.background === true && computer(nested).capabilities.backgroundCapture !== true) throw new Error('background capture is unsupported on this platform');
        if (scale !== undefined && scale <= 0) throw new Error('scale must be greater than 0');
        if (windowId !== undefined && (region !== undefined || displayId !== undefined)) {
          throw new Error('window_id captures that window on its own; drop x, y, width, height and display_id');
        }
        const output = enumValue(args, 'output', ['image', 'file'], 'image');
        if (output === 'file' && saveTo === undefined) throw new Error('output:file requires save_to');
        const attachments = output === 'image' ? nested.get('attachments') : undefined;
        if (output === 'image') {
          if (attachments === undefined) throw new Error('image output requires an attachment service');
          await assertImageCapableRoute(nested, exec);
        }
        // Pass explicit nulls rather than undefined: the backend payload crosses a JSON
        // boundary, and null is the unambiguous "not requested" marker there.
        let capture;
        let capturedWindow;
        // 指名窗口时一并记住它的原生身份：键盘类动作要先把它抢回前台再注入，
        // 否则按键会落到「动作自己 spawn 出来的控制台窗口」上（那个窗口会抢走前台）。
        let capturedFocus;
        if (windowId === undefined) {
          capture = await computer(nested).screenshot({
            displayId,
            region: region ?? null,
            scale: scale ?? null,
            saveTo: saveTo ?? null,
          }, exec.signal);
        } else {
          const record = freshWindow(observations, exec, windowId, config);
          capture = await computer(nested).captureWindow(
            record.nativeWindow,
            { scale: scale ?? null, saveTo: saveTo ?? null, background: args.background === true },
            exec.signal,
          );
          // 前台捕获提窗；后台捕获保持已有观测，可与语义/子窗口记录联合使用。
          if (args.background !== true) consumeAllObservations(observations, exec, { handle: record.nativeWindow.id }, false, true);
          capturedWindow = {
            id: windowId,
            title: record.window.title,
            ...(typeof record.window.application === 'string' ? { application: record.window.application } : {}),
          };
          capturedFocus = {
            handle: record.nativeWindow.id,
            processId: record.nativeWindow.processId,
            title: record.nativeWindow.title,
          };
        }
        if (output === 'file') {
          const filePath = resolve(saveTo);
          await writeFile(filePath, capture.data);
          return { screenshot_id: `file-${randomUUID()}`, captured_at: capture.capturedAt, content_hash: contentHash(capture.data),
            source_bounds: capture.sourceBounds, ...(capture.captureMode === undefined ? {} : { capture_mode: capture.captureMode }),
            file: { path: filePath, mediaType: 'image/png', bytes: capture.data.byteLength, width: capture.width ?? new DataView(capture.data.buffer, capture.data.byteOffset).getUint32(16), height: capture.height ?? new DataView(capture.data.buffer, capture.data.byteOffset).getUint32(20) },
            ...(capturedWindow === undefined ? {} : { window: capturedWindow }) };
        }
        const attachment = await attachments.saveImage({
          data: capture.data,
          mediaType: 'image/png',
          name: capturedWindow === undefined ? 'desktop-screenshot.png' : 'window-screenshot.png',
        });
        const stored = await attachments.readImage(attachment, exec.signal);
        if (!(stored.data instanceof Uint8Array)) throw new Error('attachment provider returned invalid screenshot bytes');
        const state = agentState(observations, exec);
        const screenshotId = `desktop-${randomUUID()}`;
        const hash = contentHash(stored.data);
        rememberBounded(state.observations, screenshotId, {
          capturedAt: capture.capturedAt,
          sourceBounds: capture.sourceBounds,
          image: stored.ref,
          contentHash: hash,
          captureMode: capture.captureMode,
          ...(capturedFocus === undefined ? {} : { focus: capturedFocus }),
        }, config.maxObservationsPerAgent);
        return {
          screenshot_id: screenshotId,
          captured_at: capture.capturedAt,
          content_hash: hash,
          ...(capture.captureMode === undefined ? {} : { capture_mode: capture.captureMode }),
          source_bounds: capture.sourceBounds,
          image: stored.ref,
          ...(capturedWindow === undefined ? {} : { window: capturedWindow }),
        };
      },
    ));
  }

  registerTool(ctx.tools, textTool(
    'computer_find_image',
    'Find a small image (a template PNG) on screen and report where it is. '
    + 'The template is a valid PNG file path. '
    + 'Matching is pixel-based with a colour tolerance, so it also works on surfaces that expose no accessibility tree '
    + '(canvas, games, remote desktops). '
    + 'Not finding it is a normal result (found:false), not an error. '
    + 'Passing window_id raises that window and searches the bounds it actually has — that moves the foreground, so that form counts as desktop control.',
    {
      type: 'object', additionalProperties: false,
      required: ['template'],
      properties: {
        template: { type: 'string', description: 'Path to a PNG template, e.g. written earlier with computer_screenshot save_to.' },
        window_id: { type: 'string', description: 'Optional window_id from computer_windows. Reuse within its lifetime; native identity is checked before use. Raises that window and searches inside the bounds it actually has, in one step. Give it alone — no x/y/width/height and no display_id.' },
        display_id: { type: 'string', description: 'Optional display id from computer_status. Omit for the whole virtual desktop.' },
        x: { type: 'number', description: 'Optional search region left edge, in virtual-desktop pixels (may be negative). Give x, y, width and height together.' },
        y: { type: 'number', description: 'Optional search region top edge, in virtual-desktop pixels (may be negative).' },
        width: { type: 'number', description: 'Optional search region width in pixels.' },
        height: { type: 'number', description: 'Optional search region height in pixels.' },
        threshold: { type: 'number', description: 'Minimum similarity to count as a match, 0..1 (default 0.9). Similarity is the fraction of pixels within the colour tolerance — 0.9 means nine in ten pixels matched.' },
        tolerance: { type: 'number', description: 'Per-channel colour tolerance, 0..255 (default 12). Absorbs anti-aliasing and small rendering differences without treating a neighbouring grey button as a match.' },
      },
    },
    async (rawArgs, exec) => {
      const args = object(rawArgs);
      const templatePath = requiredString(args, 'template');
      const windowId = optionalNonBlankString(args, 'window_id');
      const displayId = optionalNonBlankString(args, 'display_id');
      const region = optionalRegion(args);
      if (windowId !== undefined && (region !== undefined || displayId !== undefined)) {
        throw new Error('window_id searches that window on its own; drop x, y, width, height and display_id');
      }
      const threshold = optionalFiniteNumber(args, 'threshold');
      const tolerance = optionalFiniteNumber(args, 'tolerance');
      if (threshold !== undefined && !(threshold > 0 && threshold <= 1)) throw new Error('threshold must be within (0, 1]');
      if (tolerance !== undefined && (tolerance < 0 || tolerance > 255)) throw new Error('tolerance must be within [0, 255]');
      let focus = null;
      if (windowId !== undefined) {
        const record = freshWindow(observations, exec, windowId, config);
        focus = {
          handle: record.nativeWindow.id,
          processId: record.nativeWindow.processId,
          title: record.nativeWindow.title,
        };
      }
      const result = await computer(ctx).findImage({
        templatePath,
        displayId,
        region: region ?? null,
        threshold: threshold ?? null,
        tolerance: tolerance ?? null,
        focus,
      }, exec.signal);
      if (focus !== null) consumeAllObservations(observations, exec, focus, false, true);
      return describeJson(result);
    },
  ));

  registerTool(ctx.tools, textTool(
    'computer_click_image',
    'Find a template image inside one window and click it — but only when it is found in exactly one place. '
    + 'This refuses to act on ambiguity: if the template matches more than once, or nothing meets the confidence bar, '
    + 'nothing is clicked and the candidates are reported instead. '
    + 'Raising the window changes the foreground, so this counts as desktop control.',
    {
      type: 'object', additionalProperties: false,
      required: ['template', 'window_id'],
      properties: {
        template: { type: 'string', description: 'Path to a PNG template, e.g. written earlier with computer_screenshot save_to.' },
        window_id: { type: 'string', description: 'Required: a session window_id from computer_windows within its lifetime. The window is raised and the search is confined to its bounds, so uniqueness is judged inside that window rather than across the whole desktop.' },
        threshold: { type: 'number', description: 'Minimum similarity, 0..1 (default 0.95 — stricter than computer_find_image, because this one actually clicks).' },
        tolerance: { type: 'number', description: 'Per-channel colour tolerance, 0..255 (default 12).' },
        button: { type: 'string', enum: ['left', 'middle', 'right'] },
        clicks: { type: 'number', enum: [1, 2] },
      },
    },
    async (rawArgs, exec) => {
      const args = object(rawArgs);
      const templatePath = requiredString(args, 'template');
      const windowId = requiredString(args, 'window_id');
      const threshold = optionalFiniteNumber(args, 'threshold') ?? CLICK_IMAGE_THRESHOLD;
      const tolerance = optionalFiniteNumber(args, 'tolerance');
      if (!(threshold > 0 && threshold <= 1)) throw new Error('threshold must be within (0, 1]');
      if (tolerance !== undefined && (tolerance < 0 || tolerance > 255)) throw new Error('tolerance must be within [0, 255]');
      const button = enumValue(args, 'button', ['left', 'middle', 'right'], 'left');
      const clickCount = enumValue(args, 'clicks', [1, 2], 1);

      const record = freshWindow(observations, exec, windowId, config);
      const focus = {
        handle: record.nativeWindow.id,
        processId: record.nativeWindow.processId,
        title: record.nativeWindow.title,
      };
      const result = await computer(ctx).findImage({
        templatePath,
        displayId: undefined,
        region: null,
        threshold,
        tolerance: tolerance ?? null,
        focus,
      }, exec.signal);
      // 提窗改变了前台，此前所有截图与语义快照都不再可信。
      consumeAllObservations(observations, exec, focus, false, true);

      // ---- 硬约束：找得到、且**只找到一处**，两个条件都要 ----
      // 不满足就什么都不做，把情况报回去。这里刻意不做"那就取最好的那个"的降级：
      // 一个会自己拿主意去点的工具，比一个不会点的工具危险得多。
      if (result.found !== true || result.matchCount !== 1) {
        const spots = Array.isArray(result.matches) && result.matches.length > 0
          ? `匹配位置：${result.matches.map((spot) => `(${spot.x}, ${spot.y}) ${Number(spot.score).toFixed(3)}`).join('、')}。`
          : '';
        const why = result.found !== true
          ? '没有找到达到门槛的匹配'
          : `找到 ${result.matchCount} 处匹配，无法确定该点哪一个`;
        return `未点击：${why}（门槛 ${threshold}，窗口「${record.window.title}」）。${spots}`
          + '窗口已提到前台，未发送点击。可以把搜索缩到更小的区域、换一张更有辨识度的模板，或先用 computer_find_image 看清楚情况。';
      }

      const spot = result.matches[0];
      const point = {
        x: spot.x + Math.floor(Number(result.templateWidth) / 2),
        y: spot.y + Math.floor(Number(result.templateHeight) / 2),
      };
      await performInput({ kind: 'click', point, button, clickCount, focus }, exec);
      return `已点击窗口「${record.window.title}」里唯一匹配到的那一处：屏幕坐标 (${point.x}, ${point.y})，`
        + `相似度 ${Number(spot.score).toFixed(3)}（模板 ${result.templateWidth}×${result.templateHeight}，左上角在 (${spot.x}, ${spot.y})）。`
        + '';
    },
  ));

  registerTool(ctx.tools, textTool(
    'computer_status',
    'Report the available desktop platform capabilities and display geometry without controlling the desktop.',
    { type: 'object', properties: {}, additionalProperties: false },
    async (_args, exec) => describeJson({
      capabilities: computer(ctx).capabilities,
      displays: await computer(ctx).listDisplays(exec.signal),
    }),
  ));

  registerTool(ctx.tools, textTool(
    'computer_click',
    'Click a point measured on a recent computer_screenshot attachment. Do not reuse an old screenshot after the screen may have changed.',
    {
      type: 'object', additionalProperties: false,
      required: ['screenshot_id', 'x', 'y'],
      properties: {
        screenshot_id: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' },
        button: { type: 'string', enum: ['left', 'middle', 'right'] }, clicks: { type: 'number', enum: [1, 2, 3] },
        modifiers: { type: 'array', items: { type: 'string', enum: MODIFIERS }, uniqueItems: true },
        hold_ms: { type: 'integer', minimum: 0, maximum: 3000 },
      },
    },
    async (rawArgs, exec) => {
      const args = object(rawArgs);
      const screenshotId = requiredString(args, 'screenshot_id');
      const observation = foregroundObservation(observations, exec, screenshotId, config);
      const point = mapScreenshotPoint(observation, finiteNumber(args, 'x'), finiteNumber(args, 'y'));
      const button = enumValue(args, 'button', ['left', 'middle', 'right'], 'left');
      const clickCount = enumValue(args, 'clicks', [1, 2, 3], 1);
      if ((args.hold_ms ?? 0) > 3000) throw new Error('click hold_ms must not exceed 3000');
      await performInput({ kind: 'click', point, button, clickCount, modifiers: keyOptions(args).modifiers, holdMs: keyOptions(args).holdMs, focus: observation.focus }, exec);
      return `Clicked ${button} button at screenshot (${args.x}, ${args.y}) using ${screenshotId}.`;
    },
  ));

  registerTool(ctx.tools, textTool(
    'computer_drag',
    'Drag from one point to another measured on a recent computer_screenshot attachment.',
    {
      type: 'object', additionalProperties: false,
      required: ['screenshot_id', 'from_x', 'from_y', 'to_x', 'to_y'],
      properties: {
        screenshot_id: { type: 'string' }, from_x: { type: 'number' }, from_y: { type: 'number' }, to_x: { type: 'number' }, to_y: { type: 'number' }, duration_ms: { type: 'number' },
        path: { type: 'array', minItems: 1, maxItems: 119, items: { type: 'object', additionalProperties: false, required: ['x', 'y'], properties: { x: { type: 'number' }, y: { type: 'number' } } }, description: 'Optional intermediate image points followed by to_x/to_y. Windows supports curved paths.' },
        button: { type: 'string', enum: ['left', 'middle', 'right'] },
        modifiers: { type: 'array', items: { type: 'string', enum: MODIFIERS }, uniqueItems: true },
      },
    },
    async (rawArgs, exec) => {
      const args = object(rawArgs);
      const screenshotId = requiredString(args, 'screenshot_id');
      const observation = foregroundObservation(observations, exec, screenshotId, config);
      const from = mapScreenshotPoint(observation, finiteNumber(args, 'from_x'), finiteNumber(args, 'from_y'));
      const to = mapScreenshotPoint(observation, finiteNumber(args, 'to_x'), finiteNumber(args, 'to_y'));
      const durationMs = optionalInteger(args, 'duration_ms', 100);
      if (durationMs < 0 || durationMs > 10_000) throw new Error('duration_ms must be between 0 and 10000');
      let path;
      if (args.path !== undefined) {
        if (!Array.isArray(args.path) || args.path.length < 1 || args.path.length > 119) throw new Error('path must contain 1..119 intermediate points');
        path = [...args.path.map((point) => mapScreenshotPoint(observation, point.x, point.y)), to];
      }
      await performInput({ kind: 'drag', from, to, durationMs, path, button: enumValue(args, 'button', ['left', 'middle', 'right'], 'left'), modifiers: keyOptions(args).modifiers, focus: observation.focus }, exec);
      return `Dragged using ${screenshotId}.`;
    },
  ));

  registerTool(ctx.tools, textTool(
    'computer_scroll',
    'Scroll at a point measured on a recent computer_screenshot attachment. Deltas use native wheel units; 120 is approximately one Windows wheel detent.',
    {
      type: 'object', additionalProperties: false,
      required: ['screenshot_id', 'x', 'y'],
      properties: { screenshot_id: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' }, delta_x: { type: 'integer', minimum: -120000, maximum: 120000 }, delta_y: { type: 'integer', minimum: -120000, maximum: 120000 }, modifiers: { type: 'array', items: { type: 'string', enum: MODIFIERS }, uniqueItems: true } },
    },
    async (rawArgs, exec) => {
      const args = object(rawArgs);
      const screenshotId = requiredString(args, 'screenshot_id');
      const observation = foregroundObservation(observations, exec, screenshotId, config);
      const point = mapScreenshotPoint(observation, finiteNumber(args, 'x'), finiteNumber(args, 'y'));
      const deltaX = args.delta_x === undefined ? 0 : finiteNumber(args, 'delta_x');
      const deltaY = args.delta_y === undefined ? 0 : finiteNumber(args, 'delta_y');
      if (deltaX === 0 && deltaY === 0) throw new Error('at least one of delta_x or delta_y must be non-zero');
      if (![deltaX, deltaY].every((delta) => Number.isInteger(delta) && Math.abs(delta) <= 120000)) throw new Error('scroll deltas must be integers within -120000..120000');
      await performInput({ kind: 'scroll', point, deltaX, deltaY, modifiers: keyOptions(args).modifiers, focus: observation.focus }, exec);
      return `Scrolled using ${screenshotId}.`;
    },
  ));

  registerTool(ctx.tools, textTool(
    'computer_type',
    'Type literal text using a recent screenshot_id, window_id, or window-bound snapshot_id. Windows re-focuses an identified target before injecting; text-only models can use window/semantic evidence. macOS/Linux support desktop screenshot evidence.',
    {
      type: 'object', additionalProperties: false,
      required: ['text'],
      properties: { ...KEYBOARD_EVIDENCE_SCHEMA, text: { type: 'string', maxLength: 100000 } },
    },
    async (rawArgs, exec) => {
      const args = object(rawArgs);
      const { focus, evidence } = keyboardEvidence(observations, exec, args, config);
      const text = requiredString(args, 'text');
      if (text.length > 100000) throw new Error('text exceeds 100000 UTF-16 units');
      await performInput({ kind: 'type', text, focus }, exec);
      return `Typed ${text.length} characters using ${evidence}.`;
    },
  ));

  registerTool(ctx.tools, textTool(
    'computer_key',
    'Send a native key/chord using a recent screenshot_id, window_id, or window-bound snapshot_id. Windows supports Insert/CapsLock, extended keys, hold_ms and repeat, and focuses an identified target before injecting. macOS/Linux support basic chords with desktop screenshot evidence.',
    {
      type: 'object', additionalProperties: false,
      required: ['key'],
      properties: { ...KEYBOARD_EVIDENCE_SCHEMA, key: { type: 'string' }, modifiers: { type: 'array', items: { type: 'string', enum: MODIFIERS }, uniqueItems: true }, repeat: { type: 'integer', minimum: 1, maximum: 100 }, hold_ms: { type: 'integer', minimum: 0, maximum: 10000 } },
    },
    async (rawArgs, exec) => {
      const args = object(rawArgs);
      const { focus, evidence } = keyboardEvidence(observations, exec, args, config);
      const key = requiredString(args, 'key');
      const options = keyOptions(args);
      await performInput({ kind: 'key', key, ...options, focus }, exec);
      return `Sent ${[...options.modifiers, key].join('+')} using ${evidence}.`;
    },
  ));

  registerTool(ctx.tools, textTool(
    'computer_move',
    'Move/hover at an image point on a recent foreground screenshot. Inspect relevant hover effects when they matter to the next action.',
    { type: 'object', additionalProperties: false, required: ['screenshot_id', 'x', 'y'], properties: { screenshot_id: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' } } },
    async (rawArgs, exec) => {
      const args = object(rawArgs);
      const observation = foregroundObservation(observations, exec, requiredString(args, 'screenshot_id'), config);
      const point = mapScreenshotPoint(observation, args.x, args.y);
      await performInput({ kind: 'move', point, focus: observation.focus }, exec);
      return 'Moved pointer. Observe again to inspect hover effects.';
    },
  ));

  registerTool(ctx.tools, textTool(
    'computer_narrator',
    'Windows Narrator: query status or send a fixed Microsoft Standard-layout command to a running reader. Commands require recent window_id, window-bound snapshot_id, or screenshot_id and focus that window. Choose the reader modifier (Insert/CapsLock). The virtual cursor and speech are not exposed by UIA; command delivery does not verify speech or cursor movement. The current API provides status and commands; it does not start Narrator or change settings.',
    {
      type: 'object', additionalProperties: false, required: ['operation'],
      properties: {
        ...KEYBOARD_EVIDENCE_SCHEMA,
        operation: { type: 'string', enum: ['status', 'command'] },
        command: { type: 'string', enum: Object.keys(NARRATOR_COMMANDS) },
        modifier: { type: 'string', enum: ['insert', 'capslock'] },
      },
    },
    async (rawArgs, exec) => {
      const args = object(rawArgs);
      const operation = enumValue(args, 'operation', ['status', 'command']);
      const provider = computer(ctx);
      if (typeof provider.narratorStatus !== 'function') throw new Error('Narrator is unsupported on this platform');
      if (operation === 'status') return describeJson(await provider.narratorStatus(exec.signal));
      const action = narratorAction(requiredString(args, 'command'), args.modifier);
      const { focus, evidence } = keyboardEvidence(observations, exec, args, config);
      if (focus === undefined) throw new Error('Narrator commands require window-bound evidence; list windows or capture a named window first');
      if ((await provider.narratorStatus(exec.signal)).running !== true) throw new Error('Narrator is not running in this Windows session; no command was sent');
      await performInput({ ...action, focus }, exec);
      return describeJson({ command: args.command, evidence, inputDelivered: true, virtualCursorObserved: false, speechCaptured: false, resultVerified: false });
    },
  ));

  registerTool(ctx.tools, textTool(
    'computer_input',
    'Execute one bounded input sequence: move, mouse down/up, key down/up, chords, hold, waits, text and scroll. Windows supports this API. Validate all steps before executing; stop on the first failure and release this sequence\'s held inputs. Pointer steps require a foreground screenshot_id; keyboard-only sequences also accept a window_id or window-bound snapshot_id. Total explicit wait/hold <=10000ms, <=256 steps.',
    { type: 'object', additionalProperties: false, required: ['steps'], properties: { ...KEYBOARD_EVIDENCE_SCHEMA, steps: INPUT_STEPS_SCHEMA } },
    async (rawArgs, exec) => {
      const args = object(rawArgs);
      const { observation, focus } = keyboardEvidence(observations, exec, args, config);
      const steps = inputSequenceArgs(args.steps, observation === undefined ? undefined : (x, y) => mapScreenshotPoint(observation, x, y));
      await performInput({ kind: 'sequence', steps, focus }, exec);
      return `Executed ${steps.length} input steps and released held input.`;
    },
  ));

  registerTool(ctx.tools, textTool(
    'computer_windows',
    'List native windows and receive short-lived session window_id values. Windows includes minimized windows (minimized:true); focus restores them. Windows also supports bounded child HWND enumeration, move/resize/minimize/maximize/restore/close. Identity records are reusable within their lifetime and revalidated natively before control. close requests application closure and does not prove it succeeded.',
    {
      type: 'object', additionalProperties: false,
      required: ['operation'],
      properties: { operation: { type: 'string', enum: ['list', 'focus', 'children', 'move', 'resize', 'minimize', 'maximize', 'restore', 'close'] }, window_id: { type: 'string' }, x: { type: 'integer' }, y: { type: 'integer' }, width: { type: 'integer', minimum: 1, maximum: 32768 }, height: { type: 'integer', minimum: 1, maximum: 32768 }, max_nodes: { type: 'integer', minimum: 1, maximum: 512 } },
    },
    async (rawArgs, exec) => {
      const args = object(rawArgs);
      const operation = enumValue(args, 'operation', ['list', 'focus', 'children', 'move', 'resize', 'minimize', 'maximize', 'restore', 'close']);
      if (operation === 'list') {
        const capturedAt = Date.now();
        const records = (await computer(ctx).listWindows(exec.signal)).map((nativeWindow) => {
          const id = `window-${randomUUID()}`;
          return {
            id,
            nativeWindow,
            window: { ...nativeWindow, id },
          };
        });
        const state = agentState(observations, exec);
        rememberBounded(state.windowLists, `windows-${randomUUID()}`, {
          capturedAt,
          windows: new Map(records.map((record) => [record.id, record])),
        }, config.maxObservationsPerAgent);
        return describeJson({ captured_at: capturedAt, windows: records.map((record) => record.window) });
      }
      const windowId = requiredString(args, 'window_id');
      const record = freshWindow(observations, exec, windowId, config);
      if (operation === 'children') {
        const maxNodes = optionalInteger(args, 'max_nodes', 256);
        if (maxNodes < 1 || maxNodes > 512) throw new Error('max_nodes must be 1..512');
        const provider = computer(ctx);
        if (typeof provider.childWindows !== 'function') throw new Error('child-window enumeration is unsupported on this platform');
        const result = await provider.childWindows(record.nativeWindow, exec.signal, maxNodes);
        const children = result.windows.map((nativeWindow) => ({ id: `child-${randomUUID()}`, nativeWindow }));
        const capturedAt = Date.now();
        rememberBounded(agentState(observations, exec).childWindowLists, `children-${randomUUID()}`, {
          capturedAt, root: record, windows: new Map(children.map((child) => [child.id, child])),
        }, config.maxObservationsPerAgent);
        return describeJson({ captured_at: capturedAt, window_id: windowId, truncated: result.truncated, windows: children.map((child) => ({ ...child.nativeWindow, id: child.id })) });
      }
      const focus = { handle: record.nativeWindow.id };
      if (operation === 'focus') await control(exec, () => computer(ctx).focusWindow(record.nativeWindow, exec.signal), focus, false, true);
      else {
        const provider = computer(ctx);
        if (typeof provider.manageWindow !== 'function') throw new Error('native window management is unsupported on this platform');
        const action = { kind: operation };
        if (operation === 'move') Object.assign(action, { x: optionalInteger(args, 'x'), y: optionalInteger(args, 'y') });
        if (operation === 'resize') {
          const width = optionalInteger(args, 'width'); const height = optionalInteger(args, 'height');
          if (width < 1 || width > 32768 || height < 1 || height > 32768) throw new Error('window width/height must be 1..32768');
          Object.assign(action, { width, height });
        }
        const result = await control(exec, () => provider.manageWindow(record.nativeWindow, action, exec.signal), focus);
        return describeJson({ operation, result });
      }
      return `Focused native window ${record.window.title || windowId}.`;
    },
  ));

  registerTool(ctx.tools, textTool(
    'computer_window_input',
    'Windows targeted background click/scroll on a valid observed child_window_id from computer_windows(operation:children). x/y are native pixels relative to that child client area. Recheck root/parent/PID/class/title; the helper does not request focus or move the global cursor, but the application may activate itself. Fixed messages with timeout report foregroundChanged; delivered does not prove the application acted. Read/observe the result afterwards. Handle identity has no provider runtime generation guarantee.',
    {
      type: 'object', additionalProperties: false, required: ['child_window_id', 'operation', 'x', 'y'],
      properties: { child_window_id: { type: 'string' }, operation: { type: 'string', enum: ['click', 'scroll'] }, x: { type: 'integer' }, y: { type: 'integer' }, button: { type: 'string', enum: ['left', 'middle', 'right'] }, delta_x: { type: 'integer', minimum: -32768, maximum: 32767 }, delta_y: { type: 'integer', minimum: -32768, maximum: 32767 } },
    },
    async (rawArgs, exec) => {
      const args = object(rawArgs);
      const childId = requiredString(args, 'child_window_id');
      let found;
      for (const list of agentState(observations, exec).childWindowLists.values()) {
        const child = list.windows.get(childId);
        if (child === undefined) continue;
        if (list.consumedAt !== undefined || Date.now() - list.capturedAt > config.maxObservationAgeMs) throw new Error('child window observation expired or consumed; list children again');
        found = { list, child }; break;
      }
      if (found === undefined) throw new Error('child window is unavailable in this session; list children first');
      const operation = enumValue(args, 'operation', ['click', 'scroll']);
      const x = optionalInteger(args, 'x'); const y = optionalInteger(args, 'y');
      const action = { kind: operation, x, y };
      if (operation === 'click') action.button = enumValue(args, 'button', ['left', 'middle', 'right'], 'left');
      else {
        const deltaX = optionalInteger(args, 'delta_x', 0); const deltaY = optionalInteger(args, 'delta_y', 0);
        if (deltaX < -32768 || deltaX > 32767 || deltaY < -32768 || deltaY > 32767 || (deltaX === 0 && deltaY === 0)) throw new Error('message deltas need a non-zero value within signed 16-bit bounds');
        Object.assign(action, { deltaX, deltaY });
      }
      const provider = computer(ctx);
      if (typeof provider.performWindowMessage !== 'function') throw new Error('targeted window messages are unsupported on this platform');
      return describeJson(await control(exec, () => provider.performWindowMessage(found.list.root.nativeWindow, found.child.nativeWindow, action, exec.signal), { handle: found.list.root.nativeWindow.id }, true, true));
    },
  ));

  registerTool(ctx.tools, textTool(
    'computer_accessibility',
    'Capture a bounded native accessibility tree independently of vision. Supply a recent window_id, an optional screenshot_id to bind both views, or neither for the focused application. backend selects UIA or Windows MSAA explicitly. Returned snapshot_id and element_id support reading and semantic actions without an image-capable model.',
    {
      type: 'object', additionalProperties: false,
      properties: { ...SEMANTIC_ACQUISITION_SCHEMA, screenshot_id: { type: 'string' }, window_id: { type: 'string' }, backend: { type: 'string', enum: ['native', 'uia', 'msaa'] } },
    },
    async (rawArgs, exec) => {
      return describeJson(await acquireSemantic(object(rawArgs), exec));
    },
  ));

  registerTool(ctx.tools, textTool(
    'computer_find',
    'Find native elements by task-supplied or observed name, role or automation_id. source:snapshot filters a cached page; source:native queries a window or observed subtree without first capturing its whole tree. Native results register a snapshot_id for read/action. Partial coverage and next_cursor describe unsearched portions.',
    {
      type: 'object', additionalProperties: false,
      properties: {
        ...SEMANTIC_ACQUISITION_SCHEMA,
        source: { type: 'string', enum: ['snapshot', 'native'] },
        window_id: { type: 'string' }, backend: { type: 'string', enum: ['native', 'uia', 'msaa'] },
        snapshot_id: { type: 'string' },
        name: { type: 'string' },
        role: { type: 'string' },
        automation_id: { type: 'string' },
        match: { type: 'string', enum: ['exact', 'contains'] },
        include_offscreen: { type: 'boolean' },
      },
    },
    async (rawArgs, exec) => {
      const args = object(rawArgs);
      const source = enumValue(args, 'source', ['snapshot', 'native'], 'snapshot');
      // 续查询可省略既有条件；如果提供任何条件则完整校验，禁止静默改绑。
      const selectors = ['name', 'role', 'automation_id', 'match', 'include_offscreen'];
      const query = source === 'native' && args.cursor && selectors.every((key) => args[key] === undefined) ? undefined : queryArgs(args);
      if (source === 'native') return describeJson(await acquireSemantic(args, exec, query));
      const snapshotId = requiredString(args, 'snapshot_id');
      const snapshot = freshSemanticSnapshot(observations, exec, snapshotId, config);
      const matches = findAccessibilityElements(snapshot.tree, query, config.maxSemanticMatches);
      return describeJson({
        snapshot_id: snapshotId,
        captured_at: snapshot.capturedAt,
        screenshot_id: snapshot.screenshotId,
        screenshot_hash: snapshot.screenshotHash,
        coverage: snapshot.coverage,
        next_cursor: snapshot.nextCursor,
        matches,
      });
    },
  ));

  registerTool(ctx.tools, textTool(
    'computer_read',
    'Read native text, value, selection, range/grid state from an observed element without using an image. Optional text or start/end narrows TextPattern reading; row/column reads a grid cell. Password contents are redacted. Reading does not consume snapshot evidence.',
    {
      type: 'object', additionalProperties: false, required: ['snapshot_id', 'element_id'],
      properties: {
        snapshot_id: { type: 'string' }, screenshot_id: { type: 'string' }, element_id: { type: 'string' },
        max_chars: { type: 'integer', minimum: 1, maximum: 100000 },
        text: { type: 'string' }, start: { type: 'integer', minimum: 0 }, end: { type: 'integer', minimum: 0 },
        row: { type: 'integer', minimum: 0 }, column: { type: 'integer', minimum: 0 },
      },
    },
    async (rawArgs, exec) => {
      const args = object(rawArgs);
      const { snapshotId, snapshot } = semanticEvidence(observations, exec, args, config);
      const elementId = requiredString(args, 'element_id');
      const element = accessibilityElementById(snapshot.tree, elementId);
      if (element === undefined) throw new Error(`element '${elementId}' is unavailable in semantic snapshot '${snapshotId}'`);
      const maxChars = optionalInteger(args, 'max_chars', 16000);
      if (maxChars < 1 || maxChars > 100000) throw new Error('max_chars must be between 1 and 100000');
      const parameters = { maxChars, ...textRangeArgs(args) };
      if (args.row !== undefined || args.column !== undefined) {
        if (!Number.isInteger(args.row) || !Number.isInteger(args.column) || args.row < 0 || args.column < 0) throw new Error('row and column must be non-negative integers together');
        Object.assign(parameters, { row: args.row, column: args.column });
      }
      const result = await computer(ctx).performAccessibility({ kind: 'read', elementId, element, owner: agentState(observations, exec).owner, hwnd: snapshot.focus?.handle, ...parameters }, exec.signal);
      return describeJson({ snapshot_id: snapshotId, element_id: elementId, result });
    },
  ));

  registerTool(ctx.tools, textTool(
    'computer_element',
    'Perform a native accessibility action on an enabled element from a recent semantic snapshot. Independent snapshots require no image. A screenshot-bound snapshot retains its exact image binding. Supported semantic operations may work offscreen; the backend validates current identity, capability and state.',
    {
      type: 'object', additionalProperties: false,
      required: ['snapshot_id', 'element_id', 'operation'],
      properties: {
        screenshot_id: { type: 'string' },
        snapshot_id: { type: 'string' },
        element_id: { type: 'string' },
        operation: { type: 'string', enum: ELEMENT_OPERATIONS },
        ...SEMANTIC_PARAMETERS,
      },
    },
    async (rawArgs, exec) => {
      const args = object(rawArgs);
      const { snapshotId, snapshot } = semanticEvidence(observations, exec, args, config);
      const screenshotId = snapshot.screenshotId;
      const elementId = requiredString(args, 'element_id');
      const element = accessibilityElementById(snapshot.tree, elementId);
      if (element === undefined) throw new Error(`element '${elementId}' is unavailable in semantic snapshot '${snapshotId}'`);
      if (!element.enabled) throw new Error(`element '${elementId}' is disabled`);
      const operation = enumValue(args, 'operation', ELEMENT_OPERATIONS);
      const requiredPattern = PATTERN_BY_OPERATION[operation];
      if (requiredPattern !== undefined && element.patterns_known !== false && !element.patterns.includes(requiredPattern)) {
        throw new Error(`element '${elementId}' does not support ${operation}`);
      }
      const parameters = semanticActionArgs(operation, args);
      const state = agentState(observations, exec);
      const result = await control(exec, () => computer(ctx).performAccessibility({ kind: operation, elementId, element, owner: state.owner, hwnd: snapshot.focus?.handle, ...parameters }, exec.signal), snapshot.focus);
      if (operation === 'find_item') {
        if (result?.found !== true) return describeJson({ found: false, execution_state: 'completed', scope: 'item_container', note: 'The provider returned no item for this property. Unrealized items outside this container were not traversed.' });
        // 容器查找可能改变实例化/滚动状态，因此结果是新的独立语义观测，
        // 不沿用查找前的图像绑定。注册后可用返回的 ID 明确 Realize/read/action。
        const tree = { children: [result.element] };
        const rows = flattenAccessibilityTree(tree);
        if (rows.length !== 1) throw new Error('item_container returned no observable element identity');
        const id = `semantic-${randomUUID()}`;
        const capturedAt = Date.now();
        const coverage = { status: 'partial', reason: 'item_container_result', scope: 'item' };
        rememberBounded(state.semanticSnapshots, id, { capturedAt, tree, focus: snapshot.focus, backend: snapshot.backend,
          workerGeneration: rows[0].worker_generation, coverage }, config.maxSemanticSnapshots);
        return describeJson({ found: true, snapshot_id: id, captured_at: capturedAt, element: rows[0], coverage, execution_state: 'completed' });
      }
      const label = element.name.length > 0 ? ` '${element.name}'` : '';
      return `Performed ${operation} on native element${label} using ${snapshotId}${screenshotId === undefined ? '' : ` and ${screenshotId}`}.`;
    },
  ));
}
