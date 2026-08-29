import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ComputerUseError, unsupported } from './errors.js';
import { assertFinitePoint, pngDimensions } from './geometry.js';

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

export class MacComputer {
  constructor(runner, config) {
    this.runner = runner;
    this.config = config;
    this.capabilities = Object.freeze({
      platform: 'darwin',
      screenshot: true,
      pointer: false,
      keyboard: true,
      windows: false,
      accessibility: false,
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
        if (sips !== undefined) {
          await this.runner.run([sips, '--resampleHeightWidthMax', String(this.config.screenshotMaxDimension), file], { signal, stdoutMaxBytes: 4096 });
          data = await readFile(file);
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
      case 'scroll': {
        const cliclick = await this.runner.resolveAny(['cliclick'], signal);
        if (cliclick === undefined) {
          throw unsupported('macOS pointer automation requires the optional cliclick command and Accessibility permission');
        }
        await this.performWithCliclick(cliclick, action, signal);
        return;
      }
      default:
        throw unsupported(`macOS backend does not support '${action.kind}'`);
    }
  }

  async performWithCliclick(cliclick, action, signal) {
    switch (action.kind) {
      case 'move': {
        const point = assertFinitePoint(action.point, 'move point');
        await this.runner.run([cliclick, `m:${point.x},${point.y}`], { signal, stdoutMaxBytes: 4096 });
        return;
      }
      case 'click': {
        const point = assertFinitePoint(action.point, 'click point');
        const prefix = action.button === 'right' ? 'rc' : action.button === 'middle' ? 'mc' : action.clickCount === 2 ? 'dc' : 'c';
        await this.runner.run([cliclick, `${prefix}:${point.x},${point.y}`], { signal, stdoutMaxBytes: 4096 });
        return;
      }
      default:
        throw unsupported(`macOS cliclick adapter does not support '${action.kind}' yet`);
    }
  }

  async listWindows() {
    throw unsupported('macOS window enumeration requires a dedicated AX provider');
  }

  async focusWindow() {
    throw unsupported('macOS window focus requires a dedicated AX provider');
  }

  async accessibilitySnapshot() {
    throw unsupported('macOS accessibility snapshots require a dedicated AX provider');
  }
}
