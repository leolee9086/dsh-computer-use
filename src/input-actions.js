import { unsupported } from './errors.js';

// 输入协议的界限在工具端和原生端都验证：整条序列先验证，执行时首错停止。
// 名字仅在 Windows 后端映射成 VK；这里保留跨平台的具名动作。
export const MODIFIERS = Object.freeze(['alt', 'control', 'meta', 'shift', 'insert', 'capslock', 'rightalt', 'rightcontrol', 'rightshift']);
export const INPUT_STEPS_SCHEMA = {
  type: 'array', minItems: 1, maxItems: 256,
  items: {
    type: 'object', additionalProperties: false, required: ['operation'],
    properties: {
      operation: { type: 'string', enum: ['move', 'mouse_down', 'mouse_up', 'key_down', 'key_up', 'key', 'type', 'wait', 'scroll'] },
      x: { type: 'number' }, y: { type: 'number' }, button: { type: 'string', enum: ['left', 'middle', 'right'] },
      key: { type: 'string' }, modifiers: { type: 'array', maxItems: 8, uniqueItems: true, items: { type: 'string', enum: MODIFIERS } },
      repeat: { type: 'integer', minimum: 1, maximum: 100 }, hold_ms: { type: 'integer', minimum: 0, maximum: 10000 },
      ms: { type: 'integer', minimum: 0, maximum: 10000 }, text: { type: 'string', maxLength: 100000 },
      delta_x: { type: 'integer', minimum: -120000, maximum: 120000 }, delta_y: { type: 'integer', minimum: -120000, maximum: 120000 },
    },
  },
};
function integer(value, name, min, max, fallback) {
  const result = value ?? fallback;
  if (!Number.isInteger(result) || result < min || result > max) throw new Error(`${name} must be an integer between ${min} and ${max}`);
  return result;
}
function keyName(value) {
  if (typeof value !== 'string' || value.length === 0) throw new Error('key must be a non-empty string');
  return value.toLowerCase();
}
export function keyOptions(args) {
  const modifiers = args.modifiers ?? [];
  if (!Array.isArray(modifiers) || modifiers.length > 8 || modifiers.some((key) => !MODIFIERS.includes(key)) || new Set(modifiers).size !== modifiers.length) {
    throw new Error('modifiers must contain unique supported modifier keys');
  }
  const repeat = integer(args.repeat, 'repeat', 1, 100, 1);
  const holdMs = integer(args.hold_ms, 'hold_ms', 0, 10000, 0);
  if (repeat * holdMs > 10000) throw new Error('total key hold duration must not exceed 10000 ms');
  return { modifiers, repeat, holdMs };
}
// macOS/Linux 的基本后端不能悄悄丢弃 Windows 扩展参数；在任何输入前明确拒绝。
export function assertBasicInput(action, platform) {
  const fail = option => { throw unsupported(`${platform} backend does not support ${option}`); };
  if (action.focus !== undefined) fail('atomic window-bound input; use fresh desktop screenshot evidence');
  if (action.kind === 'sequence') fail('input sequences');
  if ((action.holdMs ?? 0) !== 0) fail('input hold duration');
  if ((action.repeat ?? 1) !== 1) fail('key repetition');
  if (action.kind === 'key') {
    if ((action.modifiers ?? []).some(key => !['alt', 'control', 'meta', 'shift'].includes(key))) fail('extended keyboard modifiers');
  } else if (action.modifiers?.length > 0) fail('pointer modifiers');
  if (action.kind === 'drag') {
    if (action.path !== undefined) fail('curved drag paths');
    if ((action.button ?? 'left') !== 'left') fail('drag with a non-left button');
  }
}

export function inputSequenceArgs(raw, mapPoint) {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 256) throw new Error('steps must contain 1..256 entries');
  const heldKeys = new Set();
  const heldButtons = new Set();
  let duration = 0;
  let textLength = 0;
  const result = raw.map((entry) => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('input step must be an object');
    const point = () => {
      if (mapPoint === undefined) throw new Error('pointer steps require screenshot_id');
      return mapPoint(entry.x, entry.y);
    };
    const balance = (set, value, down) => {
      if (down && set.has(value)) throw new Error(`duplicate down for ${value}`);
      if (!down && !set.has(value)) throw new Error(`up without matching down for ${value}`);
      if (down) set.add(value); else set.delete(value);
    };
    switch (entry.operation) {
      case 'move': return { kind: 'move', point: point() };
      case 'scroll': {
        const deltaX = integer(entry.delta_x, 'delta_x', -120000, 120000, 0);
        const deltaY = integer(entry.delta_y, 'delta_y', -120000, 120000, 0);
        if (deltaX === 0 && deltaY === 0) throw new Error('scroll needs a non-zero delta');
        return { kind: 'scroll', point: point(), deltaX, deltaY };
      }
      case 'mouse_down': case 'mouse_up': {
        if (mapPoint === undefined) throw new Error('mouse steps require screenshot_id');
        const button = entry.button ?? 'left';
        if (!['left', 'middle', 'right'].includes(button)) throw new Error('unsupported mouse button');
        balance(heldButtons, button, entry.operation === 'mouse_down');
        return { kind: entry.operation === 'mouse_down' ? 'mouseDown' : 'mouseUp', button };
      }
      case 'key_down': case 'key_up': {
        const key = keyName(entry.key);
        balance(heldKeys, key, entry.operation === 'key_down');
        return { kind: entry.operation === 'key_down' ? 'keyDown' : 'keyUp', key };
      }
      case 'key': {
        const key = keyName(entry.key);
        const options = keyOptions(entry);
        if (heldKeys.has(key) || options.modifiers.some((modifier) => heldKeys.has(modifier) || modifier === key)) throw new Error('key chord overlaps a held or duplicate key');
        duration += options.repeat * options.holdMs;
        return { kind: 'key', key, ...options };
      }
      case 'type': {
        if (heldKeys.size !== 0) throw new Error('type cannot be combined with held keys');
        if (typeof entry.text !== 'string' || entry.text.length === 0) throw new Error('type requires text');
        textLength += entry.text.length;
        return { kind: 'type', text: entry.text };
      }
      case 'wait': {
        const ms = integer(entry.ms, 'ms', 0, 10000);
        duration += ms;
        return { kind: 'wait', ms };
      }
      default: throw new Error(`unsupported input operation '${entry.operation}'`);
    }
  });
  if (duration > 10000 || textLength > 100000) throw new Error('input sequence exceeds total duration or text bound');
  // 结尾可以仍有 down：后端会自动释放本次持有状态。
  return result;
}
