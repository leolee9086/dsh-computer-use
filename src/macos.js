import { Buffer } from 'node:buffer';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ComputerUseError, unavailable, unsupported } from './errors.js';
import { pngDimensions } from './geometry.js';

function appleString(value) {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, '\\n');
}

const APPLE_KEY_CODES = Object.freeze({
  backspace: 51,
  delete: 117,
  down: 125,
  end: 119,
  enter: 36,
  escape: 53,
  home: 115,
  left: 123,
  pagedown: 121,
  pageup: 116,
  right: 124,
  space: 49,
  tab: 48,
  up: 126,
});

const APPLE_MODIFIERS = Object.freeze({
  alt: 'option down',
  control: 'control down',
  meta: 'command down',
  shift: 'shift down',
});

function applescriptKey(action) {
  const modifierText = action.modifiers.map((modifier) => APPLE_MODIFIERS[modifier]).filter(Boolean);
  if (modifierText.length !== action.modifiers.length) {
    throw unsupported('one or more keyboard modifiers are unsupported by the macOS backend');
  }
  const suffix = modifierText.length === 0 ? '' : ` using {${modifierText.join(', ')}}`;
  const code = APPLE_KEY_CODES[action.key.toLowerCase()];
  const body = code === undefined
    ? `keystroke "${appleString(action.key)}"${suffix}`
    : `key code ${code}${suffix}`;
  return `tell application "System Events" to ${body}`;
}

async function withCaptureFile(run) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-computer-use-'));
  const file = join(directory, 'screen.png');
  try {
    return await run(file);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function parseRawMacWindowId(id) {
  const match = /^([1-9]\d*):([1-9]\d*)$/.exec(id);
  if (match === null) throw new ComputerUseError('macOS helper returned invalid window id');
  return { processId: Number(match[1]), index: Number(match[2]) };
}

function macWindowId(value) {
  return `mac:${Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')}`;
}

function parseMacWindowId(id) {
  if (typeof id !== 'string' || !/^mac:[A-Za-z0-9_-]+$/.test(id)) {
    throw new ComputerUseError('window id is invalid');
  }
  let value;
  try {
    value = JSON.parse(Buffer.from(id.slice(4), 'base64url').toString('utf8'));
  } catch {
    throw new ComputerUseError('window id is invalid');
  }
  const bounds = boundsPayload(value?.bounds);
  if (value === null || typeof value !== 'object'
    || !Number.isInteger(value.processId) || value.processId < 1
    || typeof value.title !== 'string'
    || typeof value.windowIdentity !== 'string' || value.windowIdentity.length === 0
    || bounds === undefined) {
    throw new ComputerUseError('window id is invalid');
  }
  return { processId: value.processId, title: value.title, bounds, windowIdentity: value.windowIdentity };
}

function macWindowListingScript(maxWindows) {
  return `
const systemEvents = Application('System Events');
function safe(read, fallback) {
  try { return read(); } catch (_) { return fallback; }
}
function asArray(value) {
  if (Array.isArray(value)) return value;
  return value === undefined || value === null ? [] : [value];
}
function stringValue(value) {
  return value === undefined || value === null ? '' : String(value);
}
const processes = asArray(safe(
  () => systemEvents.processes(),
  safe(() => systemEvents.applicationProcesses(), []),
));
const result = [];
const limit = ${maxWindows};
for (let processIndex = 0; processIndex < processes.length && result.length < limit; processIndex += 1) {
  const applicationProcess = processes[processIndex];
  const processId = Number(safe(() => applicationProcess.unixId(), 0));
  if (!Number.isInteger(processId) || processId < 1) continue;
  const application = String(safe(() => applicationProcess.name(), ''));
  const frontmost = safe(() => applicationProcess.frontmost(), false) === true;
  const windows = asArray(safe(() => applicationProcess.windows(), []));
  for (let windowIndex = 0; windowIndex < windows.length && result.length < limit; windowIndex += 1) {
    const nativeWindow = windows[windowIndex];
    const windowIdentity = stringValue(safe(() => nativeWindow.id(), ''));
    if (windowIdentity.length === 0) continue;
    const position = safe(() => nativeWindow.position(), []);
    const size = safe(() => nativeWindow.size(), []);
    const x = Number(position[0]);
    const y = Number(position[1]);
    const width = Number(size[0]);
    const height = Number(size[1]);
    if (![x, y, width, height].every(Number.isFinite) || width < 1 || height < 1) continue;
    result.push({
      id: String(processId) + ':' + String(windowIndex + 1),
      windowIdentity,
      title: String(safe(() => nativeWindow.name(), '')),
      bounds: { x, y, width, height },
      processId,
      application,
      focused: frontmost && safe(() => nativeWindow.focused(), false) === true,
    });
  }
}
JSON.stringify(result);
`;
}

function macFocusWindowScript(expected) {
  return `
const systemEvents = Application('System Events');
function safe(read, fallback) {
  try { return read(); } catch (_) { return fallback; }
}
function asArray(value) {
  if (Array.isArray(value)) return value;
  return value === undefined || value === null ? [] : [value];
}
function stringValue(value) {
  return value === undefined || value === null ? '' : String(value);
}
function boundsOf(nativeWindow) {
  const position = safe(() => nativeWindow.position(), []);
  const size = safe(() => nativeWindow.size(), []);
  const x = Number(position[0]);
  const y = Number(position[1]);
  const width = Number(size[0]);
  const height = Number(size[1]);
  return [x, y, width, height].every(Number.isFinite) && width >= 1 && height >= 1
    ? { x, y, width, height }
    : null;
}
function sameBounds(left, right) {
  return left !== null
    && left.x === right.x
    && left.y === right.y
    && left.width === right.width
    && left.height === right.height;
}
function windowIdentityOf(nativeWindow) {
  return stringValue(safe(() => nativeWindow.id(), ''));
}
const expected = ${JSON.stringify(expected)};
const processes = asArray(safe(
  () => systemEvents.processes(),
  safe(() => systemEvents.applicationProcesses(), []),
));
let targetProcess = null;
for (let processIndex = 0; processIndex < processes.length; processIndex += 1) {
  if (Number(safe(() => processes[processIndex].unixId(), 0)) === expected.processId) {
    targetProcess = processes[processIndex];
    break;
  }
}
if (targetProcess === null) throw new Error('target application process is no longer available');
const matches = [];
const windows = asArray(safe(() => targetProcess.windows(), []));
for (let windowIndex = 0; windowIndex < windows.length; windowIndex += 1) {
  const candidate = windows[windowIndex];
  if (String(safe(() => candidate.name(), '')) !== expected.title) continue;
  if (!sameBounds(boundsOf(candidate), expected.bounds)) continue;
  if (windowIdentityOf(candidate) !== expected.windowIdentity) continue;
  matches.push(candidate);
}
if (matches.length !== 1) throw new Error('target window no longer has unique matching metadata');
targetProcess.frontmost = true;
if (safe(() => targetProcess.frontmost(), false) !== true) throw new Error('target application did not become frontmost');
const revalidatedMatches = [];
const currentWindows = asArray(safe(() => targetProcess.windows(), []));
for (let windowIndex = 0; windowIndex < currentWindows.length; windowIndex += 1) {
  const candidate = currentWindows[windowIndex];
  if (String(safe(() => candidate.name(), '')) !== expected.title) continue;
  if (!sameBounds(boundsOf(candidate), expected.bounds)) continue;
  if (windowIdentityOf(candidate) !== expected.windowIdentity) continue;
  revalidatedMatches.push(candidate);
}
if (revalidatedMatches.length !== 1) throw new Error('target window changed while activating its application');
const targetWindow = revalidatedMatches[0];
targetWindow.focused = true;
if (safe(() => targetWindow.focused(), false) !== true) throw new Error('target window did not become focused');
JSON.stringify({ ok: true });
`;
}

function normalizeMacWindow(raw) {
  if (raw === null || typeof raw !== 'object' || typeof raw.id !== 'string') {
    throw new ComputerUseError('macOS helper returned invalid window metadata');
  }
  const { processId } = parseRawMacWindowId(raw.id);
  const bounds = boundsPayload(raw.bounds);
  if (bounds === undefined) throw new ComputerUseError('macOS helper returned invalid window bounds');
  if (!Number.isInteger(raw.processId) || raw.processId !== processId) {
    throw new ComputerUseError('macOS helper returned mismatched process metadata');
  }
  const title = typeof raw.title === 'string' ? raw.title : '';
  const windowIdentity = typeof raw.windowIdentity === 'string' ? raw.windowIdentity : '';
  if (windowIdentity.length === 0) return undefined;
  return {
    id: macWindowId({ processId, title, bounds, windowIdentity }),
    title,
    bounds,
    processId,
    ...(typeof raw.application === 'string' ? { application: raw.application } : {}),
    focused: raw.focused === true,
  };
}

const inputHelperPath = fileURLToPath(new URL('./macos-input.js', import.meta.url));
const axHelperPath = fileURLToPath(new URL('./macos-ax.js', import.meta.url));

function inputPayload(value) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64');
}

function axPayload(value) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64');
}

function boundsPayload(raw) {
  if (raw === null || typeof raw !== 'object'
    || !Number.isFinite(raw.x) || !Number.isFinite(raw.y)
    || !Number.isFinite(raw.width) || !Number.isFinite(raw.height)
    || raw.width < 1 || raw.height < 1) return undefined;
  return { x: raw.x, y: raw.y, width: raw.width, height: raw.height };
}

function axActionPayload(action) {
  if (action === null || typeof action !== 'object') throw new ComputerUseError('accessibility action is invalid');
  const allowed = ['invoke', 'focus', 'set_value', 'toggle', 'expand', 'collapse', 'select', 'scroll_into_view'];
  if (!allowed.includes(action.kind)) throw new ComputerUseError(`unsupported accessibility action '${action.kind}'`);
  if (typeof action.elementId !== 'string' || !/^ax:[1-9]\d*:\d+(,\d+)*$/.test(action.elementId)) {
    throw new ComputerUseError('macOS accessibility element id is invalid');
  }
  const element = action.element;
  if (element === null || typeof element !== 'object' || !Number.isInteger(element.process_id) || element.process_id < 1) {
    throw new ComputerUseError('macOS accessibility action requires an element with a positive process_id');
  }
  const bounds = boundsPayload(element.bounds);
  const payload = {
    kind: action.kind,
    elementId: action.elementId,
    processId: element.process_id,
    name: typeof element.name === 'string' ? element.name : '',
    role: typeof element.role === 'string' ? element.role : '',
    ...(bounds === undefined ? {} : { bounds }),
  };
  if (action.kind === 'set_value') {
    if (typeof action.value !== 'string') throw new ComputerUseError('macOS set_value requires a string value');
    payload.value = action.value;
  }
  return payload;
}

export class MacComputer {
  constructor(runner, config) {
    this.runner = runner;
    this.config = config;
    this.capabilities = Object.freeze({
      platform: 'darwin',
      screenshot: true,
      pointer: true,
      keyboard: true,
      windows: true,
      accessibility: true,
    });
  }

  async capture(signal) {
    const executable = await this.runner.requireAny(['screencapture', '/usr/sbin/screencapture'], 'macOS screen capture', signal);
    return withCaptureFile(async (file) => {
      await this.runner.run([executable, '-x', '-t', 'png', file], { signal, stdoutMaxBytes: 4096 });
      let data = await readFile(file);
      const source = pngDimensions(data);
      if (Math.max(source.width, source.height) > this.config.screenshotMaxDimension) {
        const sips = await this.runner.resolveAny(['sips', '/usr/bin/sips'], signal);
        if (sips === undefined) {
          throw unavailable('macOS screen capture exceeds screenshotMaxDimension and requires sips for scaling');
        }
        await this.runner.run([sips, '--resampleHeightWidthMax', String(this.config.screenshotMaxDimension), file], { signal, stdoutMaxBytes: 4096 });
        data = await readFile(file);
        const resized = pngDimensions(data);
        if (Math.max(resized.width, resized.height) > this.config.screenshotMaxDimension) {
          throw new ComputerUseError('macOS image resizer returned an oversized screenshot');
        }
      }
      if (data.byteLength > this.config.screenshotMaxBytes) {
        throw new ComputerUseError('desktop screenshot exceeds configured screenshotMaxBytes');
      }
      return { data, source };
    });
  }

  async listDisplays(signal) {
    const { source } = await this.capture(signal);
    return [{
      id: 'virtual',
      name: 'Virtual desktop',
      primary: true,
      bounds: { x: 0, y: 0, width: source.width, height: source.height },
    }];
  }

  async screenshot(request, signal) {
    if (request.displayId !== undefined && request.displayId !== 'virtual') {
      throw unsupported('the macOS backend currently captures the complete virtual desktop only');
    }
    const { data, source } = await this.capture(signal);
    const dimensions = pngDimensions(data);
    return {
      data,
      mediaType: 'image/png',
      width: dimensions.width,
      height: dimensions.height,
      sourceBounds: { x: 0, y: 0, width: source.width, height: source.height },
      capturedAt: Date.now(),
      displayId: 'virtual',
    };
  }

  async ax(signal) {
    return this.runner.requireAny(['osascript', '/usr/bin/osascript'], 'macOS Accessibility automation', signal);
  }

  async runAx(payload, signal) {
    const osascript = await this.ax(signal);
    return this.runner.runJson([
      osascript,
      '-l',
      'JavaScript',
      axHelperPath,
      axPayload(payload),
    ], { signal, stdoutMaxBytes: this.config.maxAccessibilityBytes });
  }

  async perform(action, signal) {
    const osascript = await this.runner.requireAny(['osascript', '/usr/bin/osascript'], 'macOS keyboard automation', signal);
    switch (action.kind) {
      case 'type':
        await this.runner.run([osascript, '-e', `tell application "System Events" to keystroke "${appleString(action.text)}"`], { signal, stdoutMaxBytes: 4096 });
        return;
      case 'key':
        await this.runner.run([osascript, '-e', applescriptKey(action)], { signal, stdoutMaxBytes: 4096 });
        return;
      case 'move':
      case 'click':
      case 'drag':
      case 'scroll':
        await this.runner.runJson([
          osascript,
          '-l',
          'JavaScript',
          inputHelperPath,
          inputPayload(action),
        ], { signal, stdoutMaxBytes: 4096 });
        return;
      default:
        throw unsupported(`macOS backend does not support '${action.kind}'`);
    }
  }

  async listWindows(signal) {
    const osascript = await this.runner.requireAny(['osascript', '/usr/bin/osascript'], 'macOS window automation', signal);
    const windows = await this.runner.runJson([
      osascript,
      '-l',
      'JavaScript',
      '-e',
      macWindowListingScript(this.config.maxAccessibilityNodes),
    ], { signal, stdoutMaxBytes: this.config.maxAccessibilityBytes });
    if (!Array.isArray(windows)) throw new ComputerUseError('macOS helper returned invalid window list');
    return windows.map(normalizeMacWindow).filter((window) => window !== undefined);
  }

  async focusWindow(rawTarget, signal) {
    const id = typeof rawTarget === 'string' ? rawTarget : rawTarget?.id;
    const expected = parseMacWindowId(id);
    const osascript = await this.runner.requireAny(['osascript', '/usr/bin/osascript'], 'macOS window automation', signal);
    const result = await this.runner.runJson([
      osascript,
      '-l',
      'JavaScript',
      '-e',
      macFocusWindowScript(expected),
    ], { signal, stdoutMaxBytes: 4096 });
    if (result === null || typeof result !== 'object' || result.ok !== true) {
      throw new ComputerUseError('macOS window focus helper did not confirm focus');
    }
  }

  async accessibilitySnapshot(signal) {
    return this.runAx({
      kind: 'snapshot',
      maxNodes: this.config.maxAccessibilityNodes,
      maxDepth: this.config.maxAccessibilityDepth,
    }, signal);
  }

  async performAccessibility(action, signal) {
    await this.runAx({ kind: 'action', action: axActionPayload(action) }, signal);
  }
}
