import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ComputerUseError, unsupported } from './errors.js';
import { assertFinitePoint, pngDimensions } from './geometry.js';

async function withCaptureFile(run) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-computer-use-'));
  const file = join(directory, 'screen.png');
  try {
    return await run(file);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function modifierName(value) {
  return value === 'control' ? 'ctrl' : value === 'meta' ? 'super' : value;
}

function scrollCount(delta) {
  return Math.max(1, Math.ceil(Math.abs(delta) / 120));
}

function parseGeometry(value) {
  const pairs = new Map(value.split(/\r?\n/)
    .map((line) => line.match(/^([A-Z_]+)=(.*)$/))
    .filter(Boolean)
    .map((match) => [match[1], match[2]]));
  const x = Number(pairs.get('X'));
  const y = Number(pairs.get('Y'));
  const width = Number(pairs.get('WIDTH'));
  const height = Number(pairs.get('HEIGHT'));
  if (![x, y, width, height].every(Number.isFinite) || width < 1 || height < 1) {
    throw new ComputerUseError('xdotool returned invalid window geometry');
  }
  return { x, y, width, height };
}

export class LinuxComputer {
  constructor(runner, config) {
    this.runner = runner;
    this.config = config;
    this.capabilities = Object.freeze({
      platform: 'linux',
      screenshot: true,
      pointer: false,
      keyboard: false,
      windows: false,
      accessibility: false,
    });
  }

  async capture(signal) {
    return withCaptureFile(async (file) => {
      const grim = await this.runner.resolveAny(['grim'], signal);
      if (grim !== undefined) {
        await this.runner.run([grim, file], { signal, stdoutMaxBytes: 4096 });
      } else {
        const gnome = await this.runner.resolveAny(['gnome-screenshot'], signal);
        if (gnome !== undefined) {
          await this.runner.run([gnome, '-f', file], { signal, stdoutMaxBytes: 4096 });
        } else {
          const importCommand = await this.runner.resolveAny(['import'], signal);
          if (importCommand === undefined) {
            throw unsupported('Linux screen capture requires grim, gnome-screenshot, or ImageMagick import');
          }
          await this.runner.run([importCommand, '-window', 'root', file], { signal, stdoutMaxBytes: 4096 });
        }
      }
      const data = await readFile(file);
      if (data.byteLength > this.config.screenshotMaxBytes) {
        throw new ComputerUseError('desktop screenshot exceeds configured screenshotMaxBytes');
      }
      return { data, source: pngDimensions(data) };
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
      throw unsupported('the Linux backend currently captures the complete virtual desktop only');
    }
    const { data, source } = await this.capture(signal);
    return {
      data,
      mediaType: 'image/png',
      width: source.width,
      height: source.height,
      sourceBounds: { x: 0, y: 0, width: source.width, height: source.height },
      capturedAt: Date.now(),
      displayId: 'virtual',
    };
  }

  async xdotool(signal) {
    return this.runner.requireAny(['xdotool'], 'Linux pointer and keyboard automation', signal);
  }

  async perform(action, signal) {
    const xdotool = await this.xdotool(signal);
    switch (action.kind) {
      case 'move': {
        const point = assertFinitePoint(action.point, 'move point');
        await this.runner.run([xdotool, 'mousemove', '--sync', String(point.x), String(point.y)], { signal, stdoutMaxBytes: 4096 });
        return;
      }
      case 'click': {
        const point = assertFinitePoint(action.point, 'click point');
        const button = action.button === 'right' ? '3' : action.button === 'middle' ? '2' : '1';
        await this.runner.run([xdotool, 'mousemove', '--sync', String(point.x), String(point.y), 'click', '--repeat', String(action.clickCount), button], { signal, stdoutMaxBytes: 4096 });
        return;
      }
      case 'drag': {
        const from = assertFinitePoint(action.from, 'drag source');
        const to = assertFinitePoint(action.to, 'drag target');
        await this.runner.run([xdotool, 'mousemove', '--sync', String(from.x), String(from.y), 'mousedown', '1', 'mousemove', '--sync', String(to.x), String(to.y), 'mouseup', '1'], { signal, stdoutMaxBytes: 4096 });
        return;
      }
      case 'scroll': {
        const point = assertFinitePoint(action.point, 'scroll point');
        const commands = [xdotool, 'mousemove', '--sync', String(point.x), String(point.y)];
        if (action.deltaY !== 0) commands.push('click', '--repeat', String(scrollCount(action.deltaY)), action.deltaY > 0 ? '4' : '5');
        if (action.deltaX !== 0) commands.push('click', '--repeat', String(scrollCount(action.deltaX)), action.deltaX > 0 ? '6' : '7');
        await this.runner.run(commands, { signal, stdoutMaxBytes: 4096 });
        return;
      }
      case 'type':
        await this.runner.run([xdotool, 'type', '--clearmodifiers', '--delay', String(this.config.actionDelayMs), action.text], { signal, stdoutMaxBytes: 4096 });
        return;
      case 'key': {
        const combo = [...action.modifiers.map(modifierName), action.key].join('+');
        await this.runner.run([xdotool, 'key', '--clearmodifiers', combo], { signal, stdoutMaxBytes: 4096 });
        return;
      }
      default:
        throw unsupported(`Linux backend does not support '${action.kind}'`);
    }
  }

  async listWindows(signal) {
    const xdotool = await this.xdotool(signal);
    const ids = (await this.runner.run([xdotool, 'search', '--onlyvisible', '--name', '.'], { signal, stdoutMaxBytes: this.config.maxAccessibilityBytes }))
      .trim().split(/\r?\n/).filter(Boolean);
    const windows = [];
    for (const id of ids.slice(0, this.config.maxAccessibilityNodes)) {
      const [title, geometry] = await Promise.all([
        this.runner.run([xdotool, 'getwindowname', id], { signal, stdoutMaxBytes: 64 * 1024 }),
        this.runner.run([xdotool, 'getwindowgeometry', '--shell', id], { signal, stdoutMaxBytes: 64 * 1024 }),
      ]);
      windows.push({ id, title: title.trim(), bounds: parseGeometry(geometry), focused: false });
    }
    return windows;
  }

  async focusWindow(id, signal) {
    const xdotool = await this.xdotool(signal);
    if (!/^\d+$/.test(id)) throw new ComputerUseError('window id is invalid');
    await this.runner.run([xdotool, 'windowactivate', '--sync', id], { signal, stdoutMaxBytes: 4096 });
  }

  async accessibilitySnapshot() {
    throw unsupported('Linux accessibility snapshots require a dedicated AT-SPI provider');
  }
}
