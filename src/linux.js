import { Buffer } from 'node:buffer';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ComputerUseError, unavailable, unsupported } from './errors.js';
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

function parseProcessId(value) {
  const processId = Number(value.trim());
  if (!Number.isInteger(processId) || processId < 1) {
    throw new ComputerUseError('xdotool returned an invalid window process id');
  }
  return processId;
}

function sameBounds(left, right) {
  return left.x === right.x
    && left.y === right.y
    && left.width === right.width
    && left.height === right.height;
}

function listedWindowTarget(raw) {
  if (raw === null || typeof raw !== 'object'
    || typeof raw.id !== 'string' || !/^\d+$/.test(raw.id)
    || typeof raw.title !== 'string'
    || !Number.isInteger(raw.processId) || raw.processId < 1
    || raw.bounds === null || typeof raw.bounds !== 'object'
    || !Number.isFinite(raw.bounds.x) || !Number.isFinite(raw.bounds.y)
    || !Number.isFinite(raw.bounds.width) || !Number.isFinite(raw.bounds.height)
    || raw.bounds.width < 1 || raw.bounds.height < 1) {
    throw new ComputerUseError('Linux focus requires a listed native window record');
  }
  return {
    id: raw.id,
    title: raw.title,
    processId: raw.processId,
    bounds: { x: raw.bounds.x, y: raw.bounds.y, width: raw.bounds.width, height: raw.bounds.height },
  };
}

const atspiHelperPath = fileURLToPath(new URL('./linux-atspi.py', import.meta.url));

function atspiPayload(value) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64');
}

function atspiActionPayload(action, maxDepth) {
  if (action === null || typeof action !== 'object') throw new ComputerUseError('accessibility action is invalid');
  if (!Number.isInteger(maxDepth) || maxDepth < 0) throw new ComputerUseError('AT-SPI accessibility action depth is invalid');
  const allowed = ['invoke', 'focus', 'set_value', 'toggle', 'expand', 'collapse', 'select', 'scroll_into_view'];
  if (!allowed.includes(action.kind)) throw new ComputerUseError(`unsupported accessibility action '${action.kind}'`);
  if (typeof action.elementId !== 'string' || !/^atspi:\d+(,\d+)*$/.test(action.elementId)) {
    throw new ComputerUseError('AT-SPI accessibility element id is invalid');
  }
  const pathDepth = action.elementId.slice('atspi:'.length).split(',').length - 1;
  if (pathDepth > maxDepth) {
    throw new ComputerUseError('AT-SPI accessibility element path exceeds the configured snapshot depth');
  }
  const element = action.element;
  if (element === null || typeof element !== 'object' || !Number.isInteger(element.process_id) || element.process_id < 1) {
    throw new ComputerUseError('AT-SPI accessibility action requires an element with a positive process_id');
  }
  const payload = {
    kind: action.kind,
    elementId: action.elementId,
    maxDepth,
    processId: element.process_id,
    ...(typeof element.process_path === 'string' && element.process_path.length > 0 ? { processPath: element.process_path } : {}),
    automationId: typeof element.automation_id === 'string' ? element.automation_id : '',
    name: typeof element.name === 'string' ? element.name : '',
    className: typeof element.class_name === 'string' ? element.class_name : '',
    role: typeof element.role === 'string' ? element.role : '',
  };
  if (action.kind === 'set_value') {
    if (typeof action.value !== 'string') throw new ComputerUseError('AT-SPI set_value requires a string value');
    payload.value = action.value;
  }
  return payload;
}

export class LinuxComputer {
  constructor(runner, config) {
    this.runner = runner;
    this.config = config;
    this.capabilities = Object.freeze({
      platform: 'linux',
      screenshot: true,
      pointer: true,
      keyboard: true,
      windows: true,
      accessibility: true,
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
      let data = await readFile(file);
      const source = pngDimensions(data);
      if (Math.max(source.width, source.height) > this.config.screenshotMaxDimension) {
        const resizer = await this.runner.resolveAny(['magick', 'convert'], signal);
        if (resizer === undefined) {
          throw unavailable('Linux screen capture exceeds screenshotMaxDimension and requires ImageMagick magick or convert for scaling');
        }
        const resizedFile = `${file}.resized.png`;
        await this.runner.run([
          resizer,
          file,
          '-resize',
          `${this.config.screenshotMaxDimension}x${this.config.screenshotMaxDimension}>`,
          resizedFile,
        ], { signal, stdoutMaxBytes: 4096 });
        data = await readFile(resizedFile);
        const resized = pngDimensions(data);
        if (Math.max(resized.width, resized.height) > this.config.screenshotMaxDimension) {
          throw new ComputerUseError('Linux image resizer returned an oversized screenshot');
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
      throw unsupported('the Linux backend currently captures the complete virtual desktop only');
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

  async xdotool(signal) {
    return this.runner.requireAny(['xdotool'], 'Linux pointer and keyboard automation', signal);
  }

  async atspi(signal) {
    return this.runner.requireAny(['python3', 'python'], 'Linux AT-SPI accessibility', signal);
  }

  async runAtspi(payload, signal) {
    const python = await this.atspi(signal);
    return this.runner.runJson([
      python,
      atspiHelperPath,
      atspiPayload(payload),
    ], { signal, stdoutMaxBytes: this.config.maxAccessibilityBytes });
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
        const duration = Number.isFinite(action.durationMs)
          ? Math.max(0, Math.min(10_000, Math.trunc(action.durationMs)))
          : 0;
        const steps = Math.max(1, Math.min(120, Math.ceil(duration / 16)));
        const commands = [xdotool, 'mousemove', '--sync', String(from.x), String(from.y), 'mousedown', '1'];
        for (let index = 1; index <= steps; index += 1) {
          const fraction = index / steps;
          if (duration > 0) commands.push('sleep', String(duration / steps / 1000));
          commands.push(
            'mousemove', '--sync',
            String(Math.round(from.x + (to.x - from.x) * fraction)),
            String(Math.round(from.y + (to.y - from.y) * fraction)),
          );
        }
        commands.push('mouseup', '1');
        await this.runner.run(commands, { signal, stdoutMaxBytes: 4096 });
        return;
      }
      case 'scroll': {
        const point = assertFinitePoint(action.point, 'scroll point');
        const commands = [xdotool, 'mousemove', '--sync', String(point.x), String(point.y)];
        if (action.deltaY !== 0) commands.push('click', '--repeat', String(scrollCount(action.deltaY)), action.deltaY > 0 ? '4' : '5');
        if (action.deltaX !== 0) commands.push('click', '--repeat', String(scrollCount(action.deltaX)), action.deltaX > 0 ? '7' : '6');
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

  async windowMetadata(xdotool, id, signal) {
    const [title, geometry, processId] = await Promise.all([
      this.runner.run([xdotool, 'getwindowname', id], { signal, stdoutMaxBytes: 64 * 1024 }),
      this.runner.run([xdotool, 'getwindowgeometry', '--shell', id], { signal, stdoutMaxBytes: 64 * 1024 }),
      this.runner.run([xdotool, 'getwindowpid', id], { signal, stdoutMaxBytes: 4096 }),
    ]);
    return { title: title.trim(), bounds: parseGeometry(geometry), processId: parseProcessId(processId) };
  }

  async listWindows(signal) {
    const xdotool = await this.xdotool(signal);
    const rawIds = await this.runner.run([xdotool, 'search', '--onlyvisible', '--name', '.'], { signal, stdoutMaxBytes: this.config.maxAccessibilityBytes });
    const ids = [...new Set(rawIds.trim().split(/\r?\n/).filter(Boolean))];
    const windows = [];
    for (const id of ids.slice(0, this.config.maxAccessibilityNodes)) {
      try {
        const metadata = await this.windowMetadata(xdotool, id, signal);
        windows.push({ id, ...metadata, focused: false });
      } catch (error) {
        if (signal?.aborted) throw error;
        // A window can disappear after xdotool search but before metadata lookup.
      }
    }
    let focusedId = '';
    try {
      focusedId = (await this.runner.run([xdotool, 'getactivewindow'], { signal, stdoutMaxBytes: 4096 })).trim();
    } catch (error) {
      if (signal?.aborted) throw error;
      // Desktop sessions can legitimately have no active xdotool window.
    }
    return windows.map((window) => ({ ...window, focused: window.id === focusedId }));
  }

  async focusWindow(rawTarget, signal) {
    const target = listedWindowTarget(rawTarget);
    const xdotool = await this.xdotool(signal);
    const current = await this.windowMetadata(xdotool, target.id, signal);
    if (current.processId !== target.processId || current.title !== target.title || !sameBounds(current.bounds, target.bounds)) {
      throw new ComputerUseError('listed Linux window changed before focus; list native windows again');
    }
    await this.runner.run([xdotool, 'windowactivate', '--sync', target.id], { signal, stdoutMaxBytes: 4096 });
    const focusedId = (await this.runner.run([xdotool, 'getactivewindow'], { signal, stdoutMaxBytes: 4096 })).trim();
    if (focusedId !== target.id) throw new ComputerUseError('xdotool did not focus the requested window');
    const after = await this.windowMetadata(xdotool, target.id, signal);
    if (after.processId !== target.processId || after.title !== target.title || !sameBounds(after.bounds, target.bounds)) {
      throw new ComputerUseError('Linux window changed during focus; capture fresh desktop evidence');
    }
  }

  /**
   * 按窗口截图需要"按区域截图"，而 Linux 后端目前只能抓整个虚拟桌面。
   * 这里明确报错，而不是静默交回一张整屏图——那会让调用方以为自己拿到的是那个窗口。
   */
  async captureWindow() {
    throw unsupported('capturing one window requires region capture, which the Linux backend does not provide yet');
  }

  async accessibilitySnapshot(signal) {
    return this.runAtspi({
      kind: 'snapshot',
      maxNodes: this.config.maxAccessibilityNodes,
      maxDepth: this.config.maxAccessibilityDepth,
      maxCandidates: this.config.maxAccessibilityActionCandidates,
    }, signal);
  }

  async performAccessibility(action, signal) {
    await this.runAtspi({
      kind: 'action',
      action: atspiActionPayload(action, this.config.maxAccessibilityDepth),
    }, signal);
  }
}
