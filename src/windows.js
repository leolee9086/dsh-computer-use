import { Buffer } from 'node:buffer';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SemanticWorkerPool } from './semantic-worker.js';
import { resolveHostConfig } from './config.js';
import { loadCSharpFile } from './csharp.js';
import { ComputerUseError, unsupported } from './errors.js';
import { assertFinitePoint } from './geometry.js';

const KEY_CODES = {
  alt: 0x12,
  backspace: 0x08,
  control: 0x11,
  delete: 0x2e,
  down: 0x28,
  end: 0x23,
  enter: 0x0d,
  escape: 0x1b,
  home: 0x24,
  left: 0x25,
  meta: 0x5b,
  pagedown: 0x22,
  pageup: 0x21,
  right: 0x27,
  shift: 0x10,
  space: 0x20,
  tab: 0x09,
  up: 0x26,
  insert: 0x2d, capslock: 0x14, numlock: 0x90, scrolllock: 0x91,
  printscreen: 0x2c, pause: 0x13, apps: 0x5d,
  rightalt: 0xa5, rightcontrol: 0xa3, rightshift: 0xa1,
  numpadmultiply: 0x6a, numpadadd: 0x6b, numpadsubtract: 0x6d, numpaddecimal: 0x6e, numpaddivide: 0x6f,
  semicolon: 0xba, equals: 0xbb, comma: 0xbc, minus: 0xbd, period: 0xbe, slash: 0xbf,
  backtick: 0xc0, bracketleft: 0xdb, backslash: 0xdc, bracketright: 0xdd, quote: 0xde,
};

for (let code = 0; code < 26; code += 1) KEY_CODES[String.fromCharCode(65 + code).toLowerCase()] = 0x41 + code;
for (let code = 0; code < 10; code += 1) KEY_CODES[String(code)] = 0x30 + code;
for (let code = 0; code < 10; code += 1) KEY_CODES[`numpad${code}`] = 0x60 + code;
for (let code = 1; code <= 24; code += 1) KEY_CODES[`f${code}`] = 0x6f + code;
Object.freeze(KEY_CODES);

/**
 * UI Automation 需要的程序集 —— 只给**名字**，由 C# 桥（`csharp.js`）解析成 GAC 里的完整路径。
 * 三个都要：客户端接口、类型定义、以及 `AutomationElement` 依赖的 WPF 基础。
 */
const UIA_ASSEMBLIES = ['UIAutomationClient', 'UIAutomationTypes', 'WindowsBase'];

function numericBounds(raw) {
  if (raw === null || typeof raw !== 'object'
    || !Number.isFinite(raw.x) || !Number.isFinite(raw.y)
    || !Number.isFinite(raw.width) || !Number.isFinite(raw.height)
    || raw.width < 1 || raw.height < 1) {
    throw new ComputerUseError('Windows helper returned invalid desktop bounds');
  }
  return { x: raw.x, y: raw.y, width: raw.width, height: raw.height };
}

/* ------------------------------------------------------------------ */
/* 原生截图 helper（dsh-screen.exe，Rust）                              */
/* ------------------------------------------------------------------ */

/**
 * 原生截图 helper（dsh-screen.exe，Rust）的路径。
 *
 * 为什么截图专门做一个原生 exe：
 *   1. 不必为每次截图付一次 powershell.exe 的启动代价
 *   2. 屏幕几何与像素读取在强类型代码里，不会再出现「脚本层属性取到 null 却一路算下去」
 *   3. 可以自行决定 ROP、裁剪与缩放，不受脚本层表达能力限制
 *
 * **没有 helper 就报错，不回退 PowerShell。**
 * 保留两条实现会让两边都难以维护、测试也覆盖不到，而且用户不知道自己实际在用哪个 ——
 * 那种「静默降级」是伪兼容，不如直接说清楚缺什么。
 */
function resolveHelperPath(config) {
  // 不跨实例缓存路径：一个会话的显式配置不能被另一实例的首次探测遮蔽。
  if (config?.nativeHelperPath !== undefined) {
    if (typeof config.nativeHelperPath !== 'string' || !existsSync(config.nativeHelperPath)) throw new ComputerUseError('configured nativeHelperPath does not exist');
    return config.nativeHelperPath;
  }
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    // 开发期：仓库里 cargo 的输出目录
    join(here, '..', 'native', 'target', 'release', 'dsh-screen.exe'),
    // 发布期：跟包一起分发的预编译产物
    join(here, '..', 'native', 'release', 'dsh-screen.exe'),
    join(here, '..', 'bin', 'dsh-screen.exe'),
  ].filter((value) => typeof value === 'string');

  for (const candidate of candidates) {
    try {
      if (existsSync(candidate)) {
        return candidate;
      }
    } catch {
      // 权限或路径长度问题：当作这个候选不存在，继续试下一个
    }
  }
  return undefined;
}

/** helper 找不到时给出可操作的错误信息（而不是静默换实现） */
function requireHelperPath(config) {
  const helperPath = resolveHelperPath(config);
  if (helperPath === undefined) {
    throw new ComputerUseError(
      'dsh-screen native helper is not available; build it with `cargo build --release` in native/ '
      + 'or point config.nativeHelperPath at the executable',
    );
  }
  return helperPath;
}

/** 调原生 helper 的某个子命令，payload 走 stdin（base64(UTF8 JSON)），结果解析为 JSON */
async function runNativeHelper(runner, helperPath, args, payload, signal, maxBytes) {
  const encode = (value) => Buffer.from(JSON.stringify(value), 'utf8').toString('base64');
  return runner.runJson([helperPath, ...args], {
    signal,
    stdoutMaxBytes: maxBytes ?? 8 * 1024 * 1024,
    // 截图走文件模式，stdout 只回小 JSON，所以这里的上限不需要很大
    stdin: payload === undefined ? undefined : encode(payload),
  });
}

/**
 * 用原生 helper 抓一张图。
 *
 * 关键设计：**PNG 走文件，不走 stdout**。
 * 让 helper 把 base64 PNG 打在 stdout 上会长时间不返回（大块数据塞进管道，读取方状态不明），
 * 所以这里始终传 `--out`，stdout 只回一个很小的 JSON（宽高、真实区域、字节数）。
 */
async function nativeScreenshot(runner, config, request, signal) {
  // 没有 helper 就抛错。不回退 PowerShell：两条实现都要维护、测试覆盖不到，
  // 而且用户不知道自己实际在用哪个 —— 那是伪兼容，不如直接说清缺什么。
  const helperPath = requireHelperPath(config);

  const directory = await mkdtemp(join(tmpdir(), 'dsh-computer-use-shot-'));
  // saveTo 给了就把 PNG 直接落在那里：那是调用方要**留着当模板**的文件，
  // 不能放在读完即删的临时目录里，也不能拿附件系统里那份 —— 那份可能被缩放或重压，
  // 拿去当模板匹配会平白掉分。落点由 helper 的 --out 决定，宿主只是换了路径。
  const keep = typeof request.saveTo === 'string' && request.saveTo.length > 0;
  const pngPath = keep ? request.saveTo : join(directory, 'shot.png');
  try {
    const payload = {
      maxDimension: config.screenshotMaxDimension,
      maxBytes: config.screenshotMaxBytes,
    };
    if (request.displayId !== undefined && request.displayId !== null) payload.displayId = request.displayId;
    if (request.region !== undefined && request.region !== null) payload.region = request.region;
    if (request.scale !== undefined && request.scale !== null) payload.scale = request.scale;
    // 指名窗口时把「提到前台」一并交给 helper：聚焦与抓屏必须在同一次进程调用里完成，
    // 否则第二次 spawn 冒出来的控制台窗口会盖住刚聚焦好的目标（见 captureWindow 的说明）。
    if (request.focus !== undefined && request.focus !== null) payload.focus = request.focus;
    if (request.background !== undefined && request.background !== null) payload.background = request.background;

    const meta = await runNativeHelper(
      runner, helperPath, ['screenshot', '--out', pngPath], payload, signal,
      config.screenshotMaxBytes,
    );
    if (meta === null || typeof meta !== 'object' || typeof meta.path !== 'string') {
      throw new ComputerUseError('native screenshot helper returned invalid metadata');
    }
    const data = await readFile(meta.path);
    if (data.byteLength > config.screenshotMaxBytes) {
      throw new ComputerUseError('desktop screenshot exceeds configured screenshotMaxBytes');
    }
    return {
      data,
      mediaType: 'image/png',
      width: Number(meta.width),
      height: Number(meta.height),
      sourceBounds: numericBounds(meta.sourceBounds),
      capturedAt: Date.now(),
      captureMode: meta.captureMode,
      ...(typeof meta.displayId === 'string' ? { displayId: meta.displayId } : {}),
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function listedWindowTarget(raw) {
  if (raw === null || typeof raw !== 'object'
    || typeof raw.id !== 'string' || !/^-?\d+$/.test(raw.id)
    || !Number.isInteger(raw.processId) || raw.processId < 1
    || typeof raw.title !== 'string' || raw.title.length === 0
    || raw.bounds === null || typeof raw.bounds !== 'object'
    || !Number.isFinite(raw.bounds.x) || !Number.isFinite(raw.bounds.y)
    || !Number.isFinite(raw.bounds.width) || !Number.isFinite(raw.bounds.height)
    || raw.bounds.width < 1 || raw.bounds.height < 1) {
    throw new ComputerUseError('Windows focus requires a listed native window record');
  }
  return {
    id: raw.id,
    processId: raw.processId,
    title: raw.title,
    bounds: { x: raw.bounds.x, y: raw.bounds.y, width: raw.bounds.width, height: raw.bounds.height },
  };
}

function keyCode(key) {
  const code = KEY_CODES[key.toLowerCase()];
  if (code === undefined) {
    throw unsupported(`key '${key}' is not supported by the Windows backend`);
  }
  return code;
}

function nativeStep(step) {
  switch (step.kind) {
    case 'move': return { kind: 'move', ...assertFinitePoint(step.point, 'move point') };
    case 'scroll': return { kind: 'scroll', ...assertFinitePoint(step.point, 'scroll point'), deltaX: step.deltaX, deltaY: step.deltaY };
    case 'keyDown': case 'keyUp': return { kind: step.kind, key: keyCode(step.key) };
    case 'mouseDown': case 'mouseUp': return { kind: step.kind, button: step.button };
    case 'key': return { kind: 'key', key: keyCode(step.key), modifiers: (step.modifiers ?? []).map(keyCode), repeat: step.repeat ?? 1, holdMs: step.holdMs ?? 0 };
    case 'type': return { kind: 'type', text: step.text };
    case 'wait': return { kind: 'wait', ms: step.ms };
    default: throw new ComputerUseError(`unknown input step '${step.kind}'`);
  }
}
export function actionPayload(action, delayMs) {
  let steps;
  switch (action.kind) {
    case 'sequence': steps = action.steps.map(nativeStep); break;
    case 'move': case 'key': case 'type': case 'scroll': steps = [nativeStep(action)]; break;
    case 'click': {
      const point = assertFinitePoint(action.point, 'click point');
      if (![1, 2, 3].includes(action.clickCount)) throw new ComputerUseError('clickCount must be 1, 2 or 3');
      steps = [{ kind: 'move', ...point }];
      for (let index = 0; index < action.clickCount; index += 1) {
        steps.push({ kind: 'mouseDown', button: action.button });
        if (action.holdMs > 0) steps.push({ kind: 'wait', ms: action.holdMs });
        steps.push({ kind: 'mouseUp', button: action.button });
        if (index + 1 < action.clickCount) steps.push({ kind: 'wait', ms: 60 });
      }
      break;
    }
    case 'drag': {
      const from = assertFinitePoint(action.from, 'drag source');
      const to = assertFinitePoint(action.to, 'drag target');
      if (!Number.isInteger(action.durationMs) || action.durationMs < 0 || action.durationMs > 10000) throw new ComputerUseError('invalid drag duration');
      const path = action.path;
      // path 点是 screenshot 映射后的物理像素。未指定时按 16ms 左右插值，画布可见中间轨迹。
      const maxInterpolatedPoints = Math.min(120, Math.floor((256 - 3 - 2 * (action.modifiers?.length ?? 0)) / 2));
      const count = action.path?.length ?? Math.min(maxInterpolatedPoints, Math.max(1, Math.ceil(action.durationMs / 16)));
      if (count < 1 || count > 120) throw new ComputerUseError('drag path must contain 1..120 points');
      steps = [{ kind: 'move', ...from }, { kind: 'mouseDown', button: action.button ?? 'left' }];
      for (let index = 1; index <= count; index += 1) {
        const point = action.path === undefined ? {
          x: Math.round(from.x + (to.x - from.x) * index / count),
          y: Math.round(from.y + (to.y - from.y) * index / count),
        } : assertFinitePoint(path[index - 1], 'drag path point');
        const wait = Math.floor(action.durationMs * index / count) - Math.floor(action.durationMs * (index - 1) / count);
        if (wait > 0) steps.push({ kind: 'wait', ms: wait });
        steps.push({ kind: 'move', ...point });
      }
      steps.push({ kind: 'mouseUp', button: action.button ?? 'left' });
      break;
    }
    default: throw new ComputerUseError(`unknown computer action '${action.kind}'`);
  }
  if (action.kind !== 'key' && action.kind !== 'sequence' && action.modifiers?.length > 0) {
    steps = [
      ...action.modifiers.map((key) => ({ kind: 'keyDown', key: keyCode(key) })),
      ...steps,
      ...[...action.modifiers].reverse().map((key) => ({ kind: 'keyUp', key: keyCode(key) })),
    ];
  }
  if (steps.length > 256) throw new ComputerUseError('input exceeds 256 native steps; shorten the drag path or reduce modifiers');
  return { kind: 'sequence', steps, delayMs };
}

function accessibilityActionPayload(action, delayMs, maxCandidates) {
  if (action === null || typeof action !== 'object') throw new ComputerUseError('accessibility action is invalid');
  const allowed = ['invoke', 'focus', 'set_value', 'toggle', 'expand', 'collapse', 'select', 'scroll_into_view', 'read', 'add_to_selection', 'remove_from_selection', 'set_range', 'scroll', 'set_scroll', 'select_text', 'scroll_text', 'window_state', 'close', 'move', 'resize'];
  if (!allowed.includes(action.kind)) throw new ComputerUseError(`unsupported accessibility action '${action.kind}'`);
  if (typeof action.elementId !== 'string' || !/^uia:-?\d+(,-?\d+)*$/.test(action.elementId)) {
    throw new ComputerUseError('accessibility element id is invalid');
  }
  const element = action.element;
  if (element === null || typeof element !== 'object' || !Number.isInteger(element.process_id) || element.process_id < 1) {
    throw new ComputerUseError('accessibility action requires an element with a positive process_id');
  }
  if (!Number.isInteger(maxCandidates) || maxCandidates < 1) throw new ComputerUseError('accessibility action search bound is invalid');
  const payload = {
    kind: action.kind,
    elementId: action.elementId,
    processId: element.process_id,
    automationId: typeof element.automation_id === 'string' ? element.automation_id : '',
    name: typeof element.name === 'string' ? element.name : '',
    className: typeof element.class_name === 'string' ? element.class_name : '',
    role: typeof element.role === 'string' ? element.role : '',
    maxCandidates,
    delayMs,
  };
  if (action.kind === 'set_value') {
    if (typeof action.value !== 'string') throw new ComputerUseError('accessibility set_value requires a string value');
    payload.value = action.value;
  }
  // 仅允许工具层验证过的具名参数进入 C#；不提供任意反射或脚本入口。
  for (const key of ['hwnd', 'maxChars', 'text', 'start', 'end', 'row', 'column', 'number', 'horizontal', 'vertical', 'state', 'x', 'y', 'width', 'height']) {
    if (action[key] !== undefined) payload[key] = action[key];
  }
  return payload;
}

export class WindowsComputer {
  constructor(runner, config) {
    this.runner = runner;
    this.config = resolveHostConfig(config);
    this.semantics = new SemanticWorkerPool(runner, this.config);
    this.capabilities = Object.freeze({
      platform: 'win32',
      screenshot: true,
      pointer: true,
      keyboard: true,
      windows: true,
      accessibility: true,
      accessibilityBackends: ['uia', 'msaa'],
      semanticReading: true,
      semanticPaging: true,
      semanticQuery: true,
      semanticWorkerIsolation: true,
      inputSequence: true,
      backgroundCapture: true,
      childWindows: true,
      windowManagement: true,
      narrator: true,
    });
  }

  async narratorStatus() {
    const bridge = await loadCSharpFile('windows-narrator.cs');
    return bridge({ kind: 'status' });
  }

  async listDisplays(signal) {
    const displays = await runNativeHelper(
      this.runner, requireHelperPath(this.config), ['list-displays'], undefined, signal,
    );
    if (!Array.isArray(displays)) throw new ComputerUseError('Windows helper returned invalid display metadata');
    return displays.map((display) => ({
      id: String(display.id),
      name: String(display.name),
      primary: display.primary === true,
      bounds: numericBounds(display.bounds),
    }));
  }

  async screenshot(request, signal) {
    // 截图一律走原生 helper（dsh-screen.exe）。
    // 早先的实现用 PowerShell 脚本抓屏，已经移除：见 nativeScreenshot 上方的说明。
    return nativeScreenshot(this.runner, this.config, request, signal);
  }

  async perform(action, signal) {
    const payload = { action: actionPayload(action, this.config.actionDelayMs) };
    // 键盘注入只认前台窗口，而本进程（经 DSH 的 Windows runner）启动时就会弹出一个控制台窗口
    // 并把前台抢走 —— 所以必须在动作进程内把目标窗口抢回来，注入才落得到正确的地方。
    if (action.focus !== undefined && action.focus !== null) payload.focus = action.focus;
    await runNativeHelper(this.runner, requireHelperPath(this.config), ['action'], payload, signal);
  }

  async listWindows(signal) {
    const windows = await runNativeHelper(
      this.runner, requireHelperPath(this.config), ['list-windows'], undefined, signal,
    );
    if (!Array.isArray(windows)) throw new ComputerUseError('Windows helper returned invalid window metadata');
    return windows.map((window) => ({
      id: String(window.id),
      title: String(window.title),
      bounds: numericBounds(window.bounds),
      ...(Number.isInteger(window.processId) ? { processId: window.processId } : {}),
      ...(typeof window.application === 'string' ? { application: window.application } : {}),
      focused: window.focused === true,
      minimized: window.minimized === true,
    }));
  }

  async focusWindow(rawTarget, signal) {
    const target = listedWindowTarget(rawTarget);
    // 只交身份：原生侧不比对列出时刻的旧边界（见原生 focus_window 的说明）——
    // 传一个用不上的 bounds 只会让读的人以为边界参与校验。
    await runNativeHelper(this.runner, requireHelperPath(this.config), ['focus-window'], {
      id: target.id,
      processId: target.processId,
      title: target.title,
    }, signal);
  }

  /**
   * 聚焦窗口并按它**聚焦之后**的实际边界截图——聚焦与抓屏在同一次原生调用内完成。
   *
   * 为什么必须挤成一次：宿主每 spawn 一次子进程，Windows 就可能把宿主所在的控制台窗口
   * 提到前台（dsh-subprocess-local 的 Windows runner 启动路径没有 windowsHide）。
   * 分成两次调用时，第二次启动冒出来的控制台窗口会正好盖在刚被提到前面的目标上，
   * 截回来的就是那个控制台。合成一次后，弹窗只发生在进程启动那一刻，
   * 紧接着 helper 把目标提到前台把它盖住，再抓屏拿到的就是目标本身。
   *
   * 聚焦只校验身份（句柄 + 进程 + 标题），**不比对列表时刻的旧边界**：
   * 窗口被移动过并不代表换了一个窗口；边界由 helper 在聚焦之后实时读出并回报。
   */
  async captureWindow(rawTarget, request, signal) {
    const target = listedWindowTarget(rawTarget);
    return nativeScreenshot(this.runner, this.config, {
      displayId: undefined,
      region: null,
      scale: request?.scale ?? null,
      saveTo: request?.saveTo ?? null,
      [request?.background === true ? 'background' : 'focus']: { handle: target.id, processId: target.processId, title: target.title },
    }, signal);
  }

  async childWindows(rawTarget, signal, maxNodes = 256) {
    const target = listedWindowTarget(rawTarget);
    return runNativeHelper(this.runner, requireHelperPath(this.config), ['child-windows'], {
      window: { handle: target.id, processId: target.processId, title: target.title }, maxNodes,
    }, signal);
  }

  async performWindowMessage(rawTarget, child, action, signal) {
    const target = listedWindowTarget(rawTarget);
    return runNativeHelper(this.runner, requireHelperPath(this.config), ['window-message'], {
      window: { handle: target.id, processId: target.processId, title: target.title }, child, action,
    }, signal);
  }

  async manageWindow(rawTarget, action, signal) {
    const target = listedWindowTarget(rawTarget);
    return runNativeHelper(this.runner, requireHelperPath(this.config), ['manage-window'], {
      window: { handle: target.id, processId: target.processId, title: target.title }, action,
    }, signal);
  }

  /**
   * 在一屏里找一张小图，返回它的位置与相似度；**找不到是正常结果，不是错误**。
   *
   * 匹配整个在原生 helper 里做：一张 1920×1080 的屏幕转成 RGBA 是 8MB，
   * 把像素来回穿进程边界比匹配本身还贵，所以只在最后过一道坐标和分数。
   *
   * 传 `focus` 时先提窗再按它聚焦后的实际边界搜索 —— 与 captureWindow 同一个理由：
   * 聚焦和抓屏必须挤在一次进程调用里，否则第二次 spawn 冒出来的控制台窗口会盖住目标。
   * helper 会校验它确实到了前台，抢不到就报错，不会对着遮挡物匹配。
   */
  async findImage(request, signal) {
    const helperPath = requireHelperPath(this.config);
    // 模板按路径读：模型给不了 base64，只能给路径 —— 由 computer_screenshot 的 save_to 落下来。
    const template = await readFile(request.templatePath);
    const payload = { templatePng: template.toString('base64') };
    if (request.threshold !== undefined && request.threshold !== null) payload.threshold = request.threshold;
    if (request.tolerance !== undefined && request.tolerance !== null) payload.tolerance = request.tolerance;
    if (request.displayId !== undefined && request.displayId !== null) payload.displayId = request.displayId;
    if (request.region !== undefined && request.region !== null) payload.region = request.region;
    if (request.focus !== undefined && request.focus !== null) payload.focus = request.focus;
    const result = await runNativeHelper(this.runner, helperPath, ['find-image'], payload, signal);
    if (result === null || typeof result !== 'object' || typeof result.found !== 'boolean') {
      throw new ComputerUseError('native find-image helper returned invalid result');
    }
    return result;
  }

  /**
   * 抓一棵语义树。
   *
   * @param windowHandle - 可选的 HWND（宿主侧一律十进制字符串）。给了就从**那个窗口**扎根；
   *   不给才退回"当前焦点窗口"——那在单窗口时够用，多窗口时是错的。
   * @param signal - 取消信号。
   */
  async accessibilitySnapshot(windowHandle, signal, options = {}) {
    const backend = options.backend === 'msaa' ? 'msaa' : 'uia';
    const page = await this.semantics.call({
      kind: 'acquire', backend, hwnd: windowHandle ?? null,
      owner: options.owner ?? 'driver',
      maxNodes: options.maxNodes ?? this.config.maxAccessibilityNodes,
      maxDepth: options.maxDepth ?? this.config.maxAccessibilityDepth,
      maxBytes: this.config.maxAccessibilityBytes,
      maxResults: options.maxResults ?? options.maxNodes ?? this.config.maxAccessibilityNodes,
      scope: options.scope ?? 'subtree', detail: options.detail ?? 'summary',
      cursor: options.cursor, rootToken: options.root?.native_token,
      workerGeneration: options.workerGeneration ?? options.root?.worker_generation,
      signature: options.signature, query: options.query,
      ...(options.window === undefined ? {} : { processId: options.window.processId, title: options.window.title }),
    }, signal, options.timeoutMs ?? this.config.commandTimeoutMs);
    // 页面只构造本次返回的行；原生游标保留未采集部分，不把总树拖回 Host。
    const byId = new Map(page.elements.map((row) => [row.element_id, { ...row, children: [] }]));
    const roots = [];
    for (const row of byId.values()) {
      const parent = byId.get(row.parent_id);
      if (parent === undefined) roots.push(row); else parent.children.push(row);
    }
    const tree = roots.length === 1 ? roots[0] : { backend, children: roots };
    Object.defineProperty(tree, 'acquisition', { value: page, enumerable: false });
    return tree;
  }

  async msaaSnapshot(windowHandle, signal, options = {}) {
    return this.accessibilitySnapshot(windowHandle, signal, { ...options, backend: 'msaa' });
  }

  async dispose() { await this.semantics.dispose(); }

  async performAccessibility(action, signal) {
    if (typeof action.element?.native_token === 'string') {
      const { element, elementId, owner, ...parameters } = action;
      const expected = Object.fromEntries(['name', 'role', 'automation_id', 'class_name', 'process_id'].filter((key) => element[key] !== undefined).map((key) => [key, element[key]]));
      return this.semantics.call({ kind: 'act', owner: owner ?? 'driver', token: element.native_token,
        workerGeneration: element.worker_generation, expected, action: parameters }, signal);
    }
    throw new ComputerUseError('stale_target: observe this element with the current semantic worker before acting');
  }

  // 旧桥只用于兼容性诊断，生产操作必须使用观测时登记的工作进程引用。
  async legacyPerformAccessibility(action, signal) {
    if (action.element?.backend === 'msaa') {
      signal?.throwIfAborted();
      if (!/^msaa:\d+:(root|\d+(\.\d+)*)$/.test(action.elementId) || !Number.isInteger(action.element.process_id) || action.element.process_id < 1) throw new ComputerUseError('MSAA element identity invalid');
      const call = await loadCSharpFile('windows-msaa.cs', { references: ['Accessibility'] });
      const element = action.element;
      return call({
        kind: 'accessibility-action', hwnd: element.native_window_handle, processId: element.process_id, title: element.window_title,
        action: { ...action, elementId: action.elementId, name: element.name, role: element.role, className: element.class_name },
      });
    }
    const call = await loadCSharpFile('windows-uia.cs', { references: UIA_ASSEMBLIES });
    signal?.throwIfAborted();
    return call({
      kind: 'accessibility-action',
      action: accessibilityActionPayload(action, this.config.actionDelayMs, this.config.maxAccessibilityActionCandidates),
    });
  }
}
