import { createHash, randomUUID } from 'node:crypto';
import { accessibilityElementById, findAccessibilityElements } from './semantics.js';

const OBSERVATION_TOOLS = new Set([
  'computer_accessibility',
  'computer_find',
  'computer_screenshot',
  'computer_status',
]);

const TOOL_NAMES = new Set([
  ...OBSERVATION_TOOLS,
  'computer_click',
  'computer_drag',
  'computer_element',
  'computer_key',
  'computer_scroll',
  'computer_type',
  'computer_windows',
]);

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
    value = { observations: new Map(), semanticSnapshots: new Map(), windowLists: new Map() };
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

function freshObservation(states, exec, screenshotId, config) {
  const record = agentState(states, exec).observations.get(screenshotId);
  if (record === undefined) throw new Error(`screenshot '${screenshotId}' is unavailable in this session; capture a new screenshot`);
  if (record.consumedAt !== undefined) {
    throw new Error(`screenshot '${screenshotId}' was consumed by a successful desktop action; capture a new screenshot before controlling the desktop`);
  }
  const age = Date.now() - record.capturedAt;
  if (age > config.maxObservationAgeMs) {
    throw new Error(`screenshot '${screenshotId}' is ${age}ms old; capture a new screenshot before controlling the desktop`);
  }
  return record;
}

function freshSemanticSnapshot(states, exec, snapshotId, config) {
  const record = agentState(states, exec).semanticSnapshots.get(snapshotId);
  if (record === undefined) throw new Error(`accessibility snapshot '${snapshotId}' is unavailable in this session; capture a new semantic snapshot`);
  if (record.consumedAt !== undefined) {
    throw new Error(`accessibility snapshot '${snapshotId}' was consumed by a successful desktop action; capture a new screenshot and semantic snapshot`);
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
    if (list.consumedAt !== undefined) {
      throw new Error(`window '${windowId}' was consumed by a successful desktop action; list native windows again before focusing one`);
    }
    const age = Date.now() - list.capturedAt;
    if (age > config.maxObservationAgeMs) {
      throw new Error(`window '${windowId}' is ${age}ms old; list native windows again before focusing one`);
    }
    return window;
  }
  throw new Error(`window '${windowId}' is unavailable in this session; list native windows before focusing one`);
}

function consumeAllObservations(states, exec) {
  const state = agentState(states, exec);
  const consumedAt = Date.now();
  for (const observation of state.observations.values()) observation.consumedAt = consumedAt;
  for (const snapshot of state.semanticSnapshots.values()) snapshot.consumedAt = consumedAt;
  for (const list of state.windowLists.values()) list.consumedAt = consumedAt;
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
  return `<computer-screenshot id="${value.screenshot_id}">
${value.image.mediaType} attachment: ${value.image.width}x${value.image.height} px; SHA-256: ${value.content_hash}.
Native source bounds: x=${value.source_bounds.x}, y=${value.source_bounds.y}, width=${value.source_bounds.width}, height=${value.source_bounds.height}.
Use image coordinates with this exact screenshot id for click, drag, or scroll. Coordinate scale: x=${xScale.toFixed(4)}, y=${yScale.toFixed(4)}.
</computer-screenshot>`;
}

function screenshotSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['screenshot_id', 'captured_at', 'content_hash', 'source_bounds', 'image'],
    properties: {
      screenshot_id: { type: 'string' },
      captured_at: { type: 'number' },
      content_hash: { type: 'string' },
      source_bounds: {
        type: 'object',
        additionalProperties: false,
        required: ['x', 'y', 'width', 'height'],
        properties: { x: { type: 'number' }, y: { type: 'number' }, width: { type: 'number' }, height: { type: 'number' } },
      },
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
    },
  };
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
  if (OBSERVATION_TOOLS.has(exec.name)) return true;
  return exec.name === 'computer_windows'
    && exec.arguments !== null
    && typeof exec.arguments === 'object'
    && !Array.isArray(exec.arguments)
    && exec.arguments.operation === 'list';
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

  ctx.inject(['attachments'], (nested) => {
    registerTool(nested.tools, imageTool(
      'computer_screenshot',
      'Capture the desktop, a display, or one region as a model-visible image. Use its returned screenshot_id for coordinate actions, and capture again after any consequential action.',
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
        },
      },
      async (rawArgs, exec) => {
        const args = object(rawArgs);
        const displayId = optionalNonBlankString(args, 'display_id');
        const region = optionalRegion(args);
        const scale = optionalFiniteNumber(args, 'scale');
        if (scale !== undefined && scale <= 0) throw new Error('scale must be greater than 0');
        await assertImageCapableRoute(nested, exec);
        // Pass explicit nulls rather than undefined: the backend payload crosses a JSON
        // boundary, and null is the unambiguous "not requested" marker there.
        const capture = await computer(nested).screenshot({
          displayId,
          region: region ?? null,
          scale: scale ?? null,
        }, exec.signal);
        const attachment = await nested.attachments.saveImage({
          data: capture.data,
          mediaType: 'image/png',
          name: 'desktop-screenshot.png',
        });
        const stored = await nested.attachments.readImage(attachment, exec.signal);
        if (!(stored.data instanceof Uint8Array)) throw new Error('attachment provider returned invalid screenshot bytes');
        const state = agentState(observations, exec);
        const screenshotId = `desktop-${randomUUID()}`;
        const hash = contentHash(stored.data);
        rememberBounded(state.observations, screenshotId, {
          capturedAt: capture.capturedAt,
          sourceBounds: capture.sourceBounds,
          image: stored.ref,
          contentHash: hash,
        }, config.maxObservationsPerAgent);
        return {
          screenshot_id: screenshotId,
          captured_at: capture.capturedAt,
          content_hash: hash,
          source_bounds: capture.sourceBounds,
          image: stored.ref,
        };
      },
    ));
  });

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
        button: { type: 'string', enum: ['left', 'middle', 'right'] }, clicks: { type: 'number', enum: [1, 2] },
      },
    },
    async (rawArgs, exec) => {
      const args = object(rawArgs);
      const screenshotId = requiredString(args, 'screenshot_id');
      const observation = freshObservation(observations, exec, screenshotId, config);
      const point = mapScreenshotPoint(observation, finiteNumber(args, 'x'), finiteNumber(args, 'y'));
      const button = enumValue(args, 'button', ['left', 'middle', 'right'], 'left');
      const clickCount = enumValue(args, 'clicks', [1, 2], 1);
      await computer(ctx).perform({ kind: 'click', point, button, clickCount }, exec.signal);
      consumeAllObservations(observations, exec);
      return `Clicked ${button} button at screenshot (${args.x}, ${args.y}) using ${screenshotId}. Capture a new screenshot before the next consequential action.`;
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
      },
    },
    async (rawArgs, exec) => {
      const args = object(rawArgs);
      const screenshotId = requiredString(args, 'screenshot_id');
      const observation = freshObservation(observations, exec, screenshotId, config);
      const from = mapScreenshotPoint(observation, finiteNumber(args, 'from_x'), finiteNumber(args, 'from_y'));
      const to = mapScreenshotPoint(observation, finiteNumber(args, 'to_x'), finiteNumber(args, 'to_y'));
      const durationMs = optionalInteger(args, 'duration_ms', 100);
      if (durationMs < 0 || durationMs > 10_000) throw new Error('duration_ms must be between 0 and 10000');
      await computer(ctx).perform({ kind: 'drag', from, to, durationMs }, exec.signal);
      consumeAllObservations(observations, exec);
      return `Dragged using ${screenshotId}. Capture a new screenshot before the next consequential action.`;
    },
  ));

  registerTool(ctx.tools, textTool(
    'computer_scroll',
    'Scroll at a point measured on a recent computer_screenshot attachment. Deltas use native wheel units; 120 is approximately one Windows wheel detent.',
    {
      type: 'object', additionalProperties: false,
      required: ['screenshot_id', 'x', 'y'],
      properties: { screenshot_id: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' }, delta_x: { type: 'number' }, delta_y: { type: 'number' } },
    },
    async (rawArgs, exec) => {
      const args = object(rawArgs);
      const screenshotId = requiredString(args, 'screenshot_id');
      const observation = freshObservation(observations, exec, screenshotId, config);
      const point = mapScreenshotPoint(observation, finiteNumber(args, 'x'), finiteNumber(args, 'y'));
      const deltaX = args.delta_x === undefined ? 0 : finiteNumber(args, 'delta_x');
      const deltaY = args.delta_y === undefined ? 0 : finiteNumber(args, 'delta_y');
      if (deltaX === 0 && deltaY === 0) throw new Error('at least one of delta_x or delta_y must be non-zero');
      await computer(ctx).perform({ kind: 'scroll', point, deltaX, deltaY }, exec.signal);
      consumeAllObservations(observations, exec);
      return `Scrolled using ${screenshotId}. Capture a new screenshot before the next consequential action.`;
    },
  ));

  registerTool(ctx.tools, textTool(
    'computer_type',
    'Type literal text into the currently focused native control. Name a recent screenshot_id so the action remains tied to an observed desktop state.',
    {
      type: 'object', additionalProperties: false,
      required: ['screenshot_id', 'text'],
      properties: { screenshot_id: { type: 'string' }, text: { type: 'string' } },
    },
    async (rawArgs, exec) => {
      const args = object(rawArgs);
      const screenshotId = requiredString(args, 'screenshot_id');
      freshObservation(observations, exec, screenshotId, config);
      const text = requiredString(args, 'text');
      await computer(ctx).perform({ kind: 'type', text }, exec.signal);
      consumeAllObservations(observations, exec);
      return `Typed ${text.length} characters using ${screenshotId}. Capture a new screenshot before the next consequential action.`;
    },
  ));

  registerTool(ctx.tools, textTool(
    'computer_key',
    'Send one native key or key chord to the focused control. Name a recent screenshot_id so the action remains tied to an observed desktop state.',
    {
      type: 'object', additionalProperties: false,
      required: ['screenshot_id', 'key'],
      properties: { screenshot_id: { type: 'string' }, key: { type: 'string' }, modifiers: { type: 'array', items: { type: 'string', enum: ['alt', 'control', 'meta', 'shift'] } } },
    },
    async (rawArgs, exec) => {
      const args = object(rawArgs);
      const screenshotId = requiredString(args, 'screenshot_id');
      freshObservation(observations, exec, screenshotId, config);
      const key = requiredString(args, 'key');
      const modifiers = arrayOfStrings(args, 'modifiers');
      if (modifiers.some((modifier) => !['alt', 'control', 'meta', 'shift'].includes(modifier))) throw new Error('modifiers contains an unsupported key');
      await computer(ctx).perform({ kind: 'key', key, modifiers }, exec.signal);
      consumeAllObservations(observations, exec);
      return `Sent ${[...modifiers, key].join('+')} using ${screenshotId}. Capture a new screenshot before the next consequential action.`;
    },
  ));

  registerTool(ctx.tools, textTool(
    'computer_windows',
    'List visible native windows and receive short-lived window_id values. Focus requires a recent window_id from this session; observe again after it changes the foreground window.',
    {
      type: 'object', additionalProperties: false,
      required: ['operation'],
      properties: { operation: { type: 'string', enum: ['list', 'focus'] }, window_id: { type: 'string' } },
    },
    async (rawArgs, exec) => {
      const args = object(rawArgs);
      const operation = enumValue(args, 'operation', ['list', 'focus']);
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
      await computer(ctx).focusWindow(record.nativeWindow, exec.signal);
      consumeAllObservations(observations, exec);
      return `Focused native window ${record.window.title || windowId}. Capture a new screenshot before the next consequential action.`;
    },
  ));

  registerTool(ctx.tools, textTool(
    'computer_accessibility',
    'Capture a bounded native accessibility tree for the application shown in a recent screenshot. It returns a short-lived snapshot_id, the bound screenshot evidence, and stable element_id values for semantic lookup and native control actions.',
    {
      type: 'object', additionalProperties: false,
      required: ['screenshot_id'],
      properties: { screenshot_id: { type: 'string' } },
    },
    async (rawArgs, exec) => {
      const args = object(rawArgs);
      const screenshotId = requiredString(args, 'screenshot_id');
      const screenshot = freshObservation(observations, exec, screenshotId, config);
      const tree = await computer(ctx).accessibilitySnapshot(exec.signal);
      const state = agentState(observations, exec);
      const capturedAt = Date.now();
      const snapshotId = `semantic-${randomUUID()}`;
      rememberBounded(state.semanticSnapshots, snapshotId, {
        capturedAt,
        screenshotId,
        screenshotHash: screenshot.contentHash,
        tree,
      }, config.maxSemanticSnapshots);
      return describeJson({
        snapshot_id: snapshotId,
        captured_at: capturedAt,
        screenshot_id: screenshotId,
        screenshot_hash: screenshot.contentHash,
        tree,
      });
    },
  ));

  registerTool(ctx.tools, textTool(
    'computer_find',
    'Find actionable native elements in a recent computer_accessibility snapshot by name, role, or automation_id. Use only selector values observed in the snapshot and omit unknown selectors rather than supplying placeholders. Use the returned element_id with computer_element instead of a coordinate click when possible.',
    {
      type: 'object', additionalProperties: false,
      required: ['snapshot_id'],
      properties: {
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
      const snapshotId = requiredString(args, 'snapshot_id');
      const snapshot = freshSemanticSnapshot(observations, exec, snapshotId, config);
      if (args.include_offscreen !== undefined && typeof args.include_offscreen !== 'boolean') {
        throw new Error('include_offscreen must be a boolean');
      }
      const matches = findAccessibilityElements(snapshot.tree, {
        name: optionalNonBlankString(args, 'name'),
        role: optionalNonBlankString(args, 'role'),
        automationId: optionalNonBlankString(args, 'automation_id'),
        match: args.match ?? 'contains',
        includeOffscreen: args.include_offscreen === true,
      }, config.maxSemanticMatches);
      return describeJson({
        snapshot_id: snapshotId,
        captured_at: snapshot.capturedAt,
        screenshot_id: snapshot.screenshotId,
        screenshot_hash: snapshot.screenshotHash,
        matches,
      });
    },
  ));

  registerTool(ctx.tools, textTool(
    'computer_element',
    'Perform a native UI Automation action on an enabled element from a recent semantic snapshot. The screenshot_id must be the exact screenshot bound to that snapshot. Use scroll_into_view only for an offscreen element, then capture new screenshot and semantic evidence before any other action.',
    {
      type: 'object', additionalProperties: false,
      required: ['screenshot_id', 'snapshot_id', 'element_id', 'operation'],
      properties: {
        screenshot_id: { type: 'string' },
        snapshot_id: { type: 'string' },
        element_id: { type: 'string' },
        operation: { type: 'string', enum: ['invoke', 'focus', 'set_value', 'toggle', 'expand', 'collapse', 'select', 'scroll_into_view'] },
        value: { type: 'string', description: 'Only use with set_value; omit it for every other operation.' },
      },
    },
    async (rawArgs, exec) => {
      const args = object(rawArgs);
      const screenshotId = requiredString(args, 'screenshot_id');
      const screenshot = freshObservation(observations, exec, screenshotId, config);
      const snapshotId = requiredString(args, 'snapshot_id');
      const snapshot = freshSemanticSnapshot(observations, exec, snapshotId, config);
      if (snapshot.screenshotId !== screenshotId || snapshot.screenshotHash !== screenshot.contentHash) {
        throw new Error(`semantic snapshot '${snapshotId}' is not bound to screenshot '${screenshotId}'; capture accessibility immediately after that screenshot`);
      }
      const elementId = requiredString(args, 'element_id');
      const element = accessibilityElementById(snapshot.tree, elementId);
      if (element === undefined) throw new Error(`element '${elementId}' is unavailable in semantic snapshot '${snapshotId}'`);
      if (!element.enabled) throw new Error(`element '${elementId}' is disabled`);
      const operation = enumValue(args, 'operation', ['invoke', 'focus', 'set_value', 'toggle', 'expand', 'collapse', 'select', 'scroll_into_view']);
      if (element.offscreen && operation !== 'scroll_into_view') {
        throw new Error(`element '${elementId}' is offscreen; use scroll_into_view and capture new evidence before acting`);
      }
      if (!element.offscreen && operation === 'scroll_into_view') {
        throw new Error(`element '${elementId}' is already visible`);
      }
      const patternByOperation = {
        invoke: 'invoke',
        focus: undefined,
        set_value: 'value',
        toggle: 'toggle',
        expand: 'expand_collapse',
        collapse: 'expand_collapse',
        select: 'selection_item',
        scroll_into_view: 'scroll_item',
      };
      const requiredPattern = patternByOperation[operation];
      if (requiredPattern !== undefined && !element.patterns.includes(requiredPattern)) {
        throw new Error(`element '${elementId}' does not support ${operation}`);
      }
      let value;
      if (operation === 'set_value') {
        if (typeof args.value !== 'string') throw new Error('value must be a string for set_value');
        value = args.value;
      } else if (args.value !== undefined && args.value !== '') {
        throw new Error('value is only valid for set_value');
      }
      await computer(ctx).performAccessibility({ kind: operation, elementId, element, ...(value === undefined ? {} : { value }) }, exec.signal);
      consumeAllObservations(observations, exec);
      const label = element.name.length > 0 ? ` '${element.name}'` : '';
      return `Performed ${operation} on native element${label} using ${snapshotId} and ${screenshotId}. Capture a new screenshot and semantic snapshot before the next consequential action.`;
    },
  ));
}
