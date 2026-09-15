// Bounded macOS Accessibility bridge for dsh-computer-use.
// osascript runs this file with one base64 JSON payload argument.

ObjC.import('Foundation');

function safe(read, fallback) {
  try { return read(); } catch (_) { return fallback; }
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  return value === undefined || value === null ? [] : [value];
}

function decodePayload(value) {
  const data = $.NSData.alloc.initWithBase64EncodedStringOptions(value, 0);
  if (data === null) throw new Error('macOS accessibility payload is invalid');
  const text = ObjC.unwrap($.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding));
  return JSON.parse(text);
}

function processList(systemEvents) {
  return asArray(safe(
    () => systemEvents.processes(),
    safe(() => systemEvents.applicationProcesses(), []),
  ));
}

function processIdOf(applicationProcess) {
  const value = Number(safe(() => applicationProcess.unixId(), 0));
  return Number.isInteger(value) && value > 0 ? value : 0;
}

function windowBounds(nativeWindow) {
  const position = safe(() => nativeWindow.position(), []);
  const size = safe(() => nativeWindow.size(), []);
  const x = Number(position[0]);
  const y = Number(position[1]);
  const width = Number(size[0]);
  const height = Number(size[1]);
  if (![x, y, width, height].every(Number.isFinite) || width < 1 || height < 1) return undefined;
  return { x, y, width, height };
}

function sameBounds(left, right) {
  return left !== undefined
    && right !== null
    && typeof right === 'object'
    && Number.isFinite(right.x)
    && Number.isFinite(right.y)
    && Number.isFinite(right.width)
    && Number.isFinite(right.height)
    && left.x === right.x
    && left.y === right.y
    && left.width === right.width
    && left.height === right.height;
}

function actionNames(element) {
  return asArray(safe(() => element.actions(), []))
    .map((action) => String(safe(() => action.name(), '')).toLowerCase())
    .filter((name) => name.length > 0);
}

function actionByName(element, expectedNames) {
  const actions = asArray(safe(() => element.actions(), []));
  for (let index = 0; index < actions.length; index += 1) {
    const name = String(safe(() => actions[index].name(), '')).toLowerCase();
    if (expectedNames.includes(name)) return actions[index];
  }
  return undefined;
}

function patternNames(element) {
  const actions = actionNames(element);
  const patterns = [];
  if (actions.some((name) => ['axpress', 'press', 'click', 'activate', 'open'].includes(name))) patterns.push('invoke');
  if (actions.some((name) => ['axtoggle', 'toggle'].includes(name))) patterns.push('toggle');
  if (actions.some((name) => ['axexpand', 'expand', 'axcollapse', 'collapse'].includes(name))) patterns.push('expand_collapse');
  if (actions.some((name) => ['axselect', 'select'].includes(name))) patterns.push('selection_item');
  if (actions.some((name) => name.includes('scroll') && name.includes('visible'))) patterns.push('scroll_item');
  if (safe(() => element.value(), undefined) !== undefined) patterns.push('value');
  return patterns;
}

function elementId(processId, path) {
  return 'ax:' + String(processId) + ':' + path.join(',');
}

function elementNode(element, processId, path, depth, maxNodes, maxDepth, budget) {
  if (budget.count >= maxNodes) return undefined;
  budget.count += 1;
  const bounds = windowBounds(element);
  const node = {
    element_id: elementId(processId, path),
    role: String(safe(() => element.role(), '')),
    name: String(safe(() => element.name(), '')),
    automation_id: '',
    class_name: '',
    process_id: processId,
    enabled: safe(() => element.enabled(), true) !== false,
    focused: safe(() => element.focused(), false) === true,
    focusable: safe(() => element.focused(), false) === true || actionNames(element).some((name) => ['axpress', 'press', 'click'].includes(name)),
    offscreen: bounds === undefined,
    patterns: patternNames(element),
    children: [],
  };
  if (bounds !== undefined) node.bounds = bounds;
  if (depth >= maxDepth) return node;
  const children = asArray(safe(() => element.uiElements(), []));
  for (let index = 0; index < children.length && budget.count < maxNodes; index += 1) {
    const child = elementNode(children[index], processId, path.concat(index), depth + 1, maxNodes, maxDepth, budget);
    if (child !== undefined) node.children.push(child);
  }
  return node;
}

function frontmostProcess(systemEvents) {
  const processes = processList(systemEvents);
  for (let index = 0; index < processes.length; index += 1) {
    if (safe(() => processes[index].frontmost(), false) === true) return processes[index];
  }
  throw new Error('macOS accessibility has no frontmost application process');
}

function focusedWindowIndex(applicationProcess) {
  const windows = asArray(safe(() => applicationProcess.windows(), []));
  for (let index = 0; index < windows.length; index += 1) {
    if (safe(() => windows[index].focused(), false) === true) return index;
  }
  if (windows.length === 0) throw new Error('frontmost macOS application has no accessible window');
  return 0;
}

function snapshot(payload) {
  const maxNodes = payload.maxNodes;
  const maxDepth = payload.maxDepth;
  if (!Number.isInteger(maxNodes) || maxNodes < 1) throw new Error('macOS accessibility maxNodes is invalid');
  if (!Number.isInteger(maxDepth) || maxDepth < 0) throw new Error('macOS accessibility maxDepth is invalid');
  const systemEvents = Application('System Events');
  const applicationProcess = frontmostProcess(systemEvents);
  const processId = processIdOf(applicationProcess);
  if (processId < 1) throw new Error('frontmost macOS application has no process id');
  const windowIndex = focusedWindowIndex(applicationProcess);
  const root = asArray(safe(() => applicationProcess.windows(), []))[windowIndex];
  const tree = elementNode(root, processId, [windowIndex + 1], 0, maxNodes, maxDepth, { count: 0 });
  if (tree === undefined) throw new Error('macOS accessibility returned no window tree');
  return tree;
}

function parseElementId(elementId) {
  const match = /^ax:([1-9]\d*):(\d+(?:,\d+)*)$/.exec(elementId);
  if (match === null) throw new Error('macOS accessibility element id is invalid');
  return { processId: Number(match[1]), path: match[2].split(',').map((part) => Number(part)) };
}

function findProcessById(systemEvents, processId) {
  const processes = processList(systemEvents);
  for (let index = 0; index < processes.length; index += 1) {
    if (processIdOf(processes[index]) === processId) return processes[index];
  }
  throw new Error('macOS accessibility application process is no longer available');
}

function resolveElement(applicationProcess, path) {
  const windows = asArray(safe(() => applicationProcess.windows(), []));
  const windowIndex = path[0] - 1;
  if (!Number.isInteger(windowIndex) || windowIndex < 0 || windows[windowIndex] === undefined) {
    throw new Error('macOS accessibility window is no longer available');
  }
  let current = windows[windowIndex];
  for (let index = 1; index < path.length; index += 1) {
    const children = asArray(safe(() => current.uiElements(), []));
    const childIndex = path[index];
    if (!Number.isInteger(childIndex) || childIndex < 0 || children[childIndex] === undefined) {
      throw new Error('macOS accessibility element path changed after observation');
    }
    current = children[childIndex];
  }
  return current;
}

function verifyIdentity(element, action) {
  const checks = [
    ['name', String(safe(() => element.name(), ''))],
    ['role', String(safe(() => element.role(), ''))],
  ];
  for (let index = 0; index < checks.length; index += 1) {
    const key = checks[index][0];
    const actual = checks[index][1];
    const expected = action[key];
    if (typeof expected === 'string' && expected.length > 0 && actual !== expected) {
      throw new Error('macOS accessibility element ' + key + ' changed after observation');
    }
  }
  if (action.bounds !== undefined && !sameBounds(windowBounds(element), action.bounds)) {
    throw new Error('macOS accessibility element bounds changed after observation');
  }
}

function performAction(element, names) {
  const action = actionByName(element, names);
  if (action === undefined) throw new Error('macOS accessibility element does not expose the required action');
  action.perform();
}

function perform(payload) {
  const action = payload.action;
  const parsed = parseElementId(action.elementId);
  if (parsed.processId !== action.processId) throw new Error('macOS accessibility process id changed after observation');
  const systemEvents = Application('System Events');
  const applicationProcess = findProcessById(systemEvents, parsed.processId);
  const element = resolveElement(applicationProcess, parsed.path);
  verifyIdentity(element, action);
  switch (action.kind) {
    case 'focus':
      element.focused = true;
      if (safe(() => element.focused(), false) !== true) {
        throw new Error('macOS accessibility element did not become focused');
      }
      break;
    case 'invoke':
      performAction(element, ['axpress', 'press', 'click', 'activate', 'open']);
      break;
    case 'set_value':
      element.value = String(action.value);
      break;
    case 'toggle':
      performAction(element, ['axtoggle', 'toggle']);
      break;
    case 'expand':
      performAction(element, ['axexpand', 'expand']);
      break;
    case 'collapse':
      performAction(element, ['axcollapse', 'collapse']);
      break;
    case 'select':
      performAction(element, ['axselect', 'select', 'axpress', 'press']);
      break;
    case 'scroll_into_view':
      performAction(element, ['axscrolltovisible', 'scroll to visible']);
      break;
    default:
      throw new Error('unsupported macOS accessibility action');
  }
  return { ok: true };
}

function run(argv) {
  if (!Array.isArray(argv) || argv.length !== 1) throw new Error('macOS accessibility helper expects one base64 payload');
  const payload = decodePayload(argv[0]);
  if (payload.kind === 'snapshot') return JSON.stringify(snapshot(payload));
  if (payload.kind === 'action') return JSON.stringify(perform(payload));
  throw new Error('unsupported macOS accessibility helper operation');
}
