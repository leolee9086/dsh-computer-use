import { randomUUID } from 'node:crypto';

const OBSERVATION_TOOLS = new Set([
  'computer_accessibility',
  'computer_screenshot',
  'computer_status',
]);

const TOOL_NAMES = new Set([
  ...OBSERVATION_TOOLS,
  'computer_click',
  'computer_drag',
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

function optionalString(args, key, fallback) {
  const value = args[key] ?? fallback;
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
    value = { observations: new Map() };
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
  return {
    x: Math.round(observation.sourceBounds.x + (x / observation.image.width) * observation.sourceBounds.width),
    y: Math.round(observation.sourceBounds.y + (y / observation.image.height) * observation.sourceBounds.height),
  };
}

function freshObservation(states, exec, screenshotId, config) {
  const record = agentState(states, exec).observations.get(screenshotId);
  if (record === undefined) throw new Error(`screenshot '${screenshotId}' is unavailable in this session; capture a new screenshot`);
  const age = Date.now() - record.capturedAt;
  if (age > config.maxObservationAgeMs) {
    throw new Error(`screenshot '${screenshotId}' is ${age}ms old; capture a new screenshot before controlling the desktop`);
  }
  return record;
}

function observationText(value) {
  const xScale = value.source_bounds.width / value.image.width;
  const yScale = value.source_bounds.height / value.image.height;
  return `<computer-screenshot id="${value.screenshot_id}">
PNG attachment: ${value.image.width}x${value.image.height} px.
Native source bounds: x=${value.source_bounds.x}, y=${value.source_bounds.y}, width=${value.source_bounds.width}, height=${value.source_bounds.height}.
Use image coordinates with this exact screenshot id for click, drag, or scroll. Coordinate scale: x=${xScale.toFixed(4)}, y=${yScale.toFixed(4)}.
</computer-screenshot>`;
}

function screenshotSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['screenshot_id', 'captured_at', 'source_bounds', 'image'],
    properties: {
      screenshot_id: { type: 'string' },
      captured_at: { type: 'number' },
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

function policyDecision(policy, description) {
  if (policy === 'allow') return undefined;
  if (policy === 'deny') return { kind: 'deny', reason: `computer-use profile denies ${description}` };
  return { kind: 'ask', reason: `Allow ${description}?` };
}

export const name = 'dsh-computer-use-tool';
export const inject = ['tools', 'computer'];

export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig);
  const observations = new WeakMap();

  ctx.on('tools/pre-execute', async (exec, next) => {
    const downstream = await next();
    if (!TOOL_NAMES.has(exec.name) || downstream.kind !== 'allow') return downstream;
    const policy = OBSERVATION_TOOLS.has(exec.name) ? config.observeApproval : config.controlApproval;
    return policyDecision(policy, OBSERVATION_TOOLS.has(exec.name) ? 'desktop observation' : 'desktop control') ?? downstream;
  });

  ctx.inject(['attachments'], (nested) => {
    nested.tools.register(imageTool(
      'computer_screenshot',
      'Capture the current desktop as a model-visible PNG. Use its returned screenshot_id for coordinate actions, and capture again after any consequential action.',
      {
        type: 'object',
        additionalProperties: false,
        properties: { display_id: { type: 'string', description: 'Optional display id from computer_status. Omit for the whole virtual desktop.' } },
      },
      async (rawArgs, exec) => {
        const args = object(rawArgs);
        const displayId = args.display_id === undefined ? undefined : optionalString(args, 'display_id', undefined);
        await assertImageCapableRoute(nested, exec);
        const capture = await computer(nested).screenshot({ displayId }, exec.signal);
        const attachment = await nested.attachments.saveImage({
          data: capture.data,
          mediaType: 'image/png',
          name: 'desktop-screenshot.png',
        });
        const state = agentState(observations, exec);
        const screenshotId = `desktop-${randomUUID()}`;
        state.observations.set(screenshotId, {
          capturedAt: capture.capturedAt,
          sourceBounds: capture.sourceBounds,
          image: attachment,
        });
        while (state.observations.size > config.maxObservationsPerAgent) {
          state.observations.delete(state.observations.keys().next().value);
        }
        return {
          screenshot_id: screenshotId,
          captured_at: capture.capturedAt,
          source_bounds: capture.sourceBounds,
          image: attachment,
        };
      },
    ));
  });

  ctx.tools.register(textTool(
    'computer_status',
    'Report the available desktop platform capabilities and display geometry without controlling the desktop.',
    { type: 'object', properties: {}, additionalProperties: false },
    async (_args, exec) => describeJson({
      capabilities: computer(ctx).capabilities,
      displays: await computer(ctx).listDisplays(exec.signal),
    }),
  ));

  ctx.tools.register(textTool(
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
      return `Clicked ${button} button at screenshot (${args.x}, ${args.y}) using ${screenshotId}. Capture a new screenshot before the next consequential action.`;
    },
  ));

  ctx.tools.register(textTool(
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
      return `Dragged using ${screenshotId}. Capture a new screenshot before the next consequential action.`;
    },
  ));

  ctx.tools.register(textTool(
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
      return `Scrolled using ${screenshotId}. Capture a new screenshot before the next consequential action.`;
    },
  ));

  ctx.tools.register(textTool(
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
      return `Typed ${text.length} characters using ${screenshotId}. Capture a new screenshot before the next consequential action.`;
    },
  ));

  ctx.tools.register(textTool(
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
      return `Sent ${[...modifiers, key].join('+')} using ${screenshotId}. Capture a new screenshot before the next consequential action.`;
    },
  ));

  ctx.tools.register(textTool(
    'computer_windows',
    'List visible native windows or focus a previously listed window. Focus is desktop control; observe again after it changes the foreground window.',
    {
      type: 'object', additionalProperties: false,
      required: ['operation'],
      properties: { operation: { type: 'string', enum: ['list', 'focus'] }, window_id: { type: 'string' } },
    },
    async (rawArgs, exec) => {
      const args = object(rawArgs);
      const operation = enumValue(args, 'operation', ['list', 'focus']);
      if (operation === 'list') return describeJson({ windows: await computer(ctx).listWindows(exec.signal) });
      const windowId = requiredString(args, 'window_id');
      await computer(ctx).focusWindow(windowId, exec.signal);
      return `Focused native window ${windowId}. Capture a new screenshot before the next consequential action.`;
    },
  ));

  ctx.tools.register(textTool(
    'computer_accessibility',
    'Read a bounded native accessibility tree rooted at the focused application. Use this semantic view with a fresh screenshot before acting.',
    { type: 'object', properties: {}, additionalProperties: false },
    async (_args, exec) => describeJson({ tree: await computer(ctx).accessibilitySnapshot(exec.signal) }),
  ));
}
