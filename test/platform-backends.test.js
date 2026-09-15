import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import test from 'node:test';
import { LinuxComputer } from '../src/linux.js';
import { MacComputer } from '../src/macos.js';
import { WindowsComputer } from '../src/windows.js';

const config = Object.freeze({
  screenshotMaxDimension: 1920,
  screenshotMaxBytes: 12_000_000,
  commandTimeoutMs: 30_000,
  graceMs: 2_000,
  actionDelayMs: 40,
  maxAccessibilityNodes: 300,
  maxAccessibilityDepth: 6,
  maxAccessibilityBytes: 1_000_000,
  maxAccessibilityActionCandidates: 5_000,
});

test('Linux window enumeration marks the active xdotool window', async () => {
  const runner = {
    async requireAny() { return 'xdotool'; },
    async run(argv) {
      const command = argv.slice(1).join(' ');
      if (command === 'search --onlyvisible --name .') return '41\n42\n';
      if (command === 'getactivewindow') return '42\n';
      if (command === 'getwindowname 41') return 'Terminal\n';
      if (command === 'getwindowname 42') return 'Browser\n';
       if (command === 'getwindowpid 41') return '101\n';
       if (command === 'getwindowpid 42') return '102\n';
      if (command === 'getwindowgeometry --shell 41') return 'X=10\nY=20\nWIDTH=800\nHEIGHT=600\n';
      if (command === 'getwindowgeometry --shell 42') return 'X=30\nY=40\nWIDTH=1024\nHEIGHT=768\n';
      throw new Error(`unexpected xdotool command: ${command}`);
    },
  };
  const computer = new LinuxComputer(runner, config);
  const windows = await computer.listWindows();
  assert.deepEqual(windows, [{
    id: '41',
     processId: 101,
    title: 'Terminal',
    bounds: { x: 10, y: 20, width: 800, height: 600 },
    focused: false,
  }, {
    id: '42',
     processId: 102,
    title: 'Browser',
    bounds: { x: 30, y: 40, width: 1024, height: 768 },
    focused: true,
  }]);
  assert.equal(computer.capabilities.pointer, true);
  assert.equal(computer.capabilities.keyboard, true);
  assert.equal(computer.capabilities.windows, true);
});

test('Linux window enumeration skips entries that vanish during metadata lookup', async () => {
  const runner = {
    async requireAny() { return 'xdotool'; },
    async run(argv) {
      const command = argv.slice(1).join(' ');
      if (command === 'search --onlyvisible --name .') return '41\n42\n';
      if (command === 'getwindowname 41') throw new Error('window vanished');
      if (command === 'getwindowname 42') return 'Browser\n';
      if (command === 'getwindowgeometry --shell 42') return 'X=30\nY=40\nWIDTH=1024\nHEIGHT=768\n';
      if (command === 'getwindowpid 42') return '102\n';
      if (command === 'getactivewindow') return '42\n';
      throw new Error(`unexpected xdotool command: ${command}`);
    },
  };
  const windows = await new LinuxComputer(runner, config).listWindows();
  assert.deepEqual(windows, [{
    id: '42', processId: 102, title: 'Browser',
    bounds: { x: 30, y: 40, width: 1024, height: 768 }, focused: true,
  }]);
});

test('Linux focus revalidates a listed window before activation', async () => {
  const commands = [];
  const runner = {
    async requireAny() { return 'xdotool'; },
    async run(argv) {
      const command = argv.slice(1).join(' ');
      commands.push(command);
      if (command === 'getwindowname 41') return 'Replacement\n';
      if (command === 'getwindowgeometry --shell 41') return 'X=10\nY=20\nWIDTH=800\nHEIGHT=600\n';
      if (command === 'getwindowpid 41') return '101\n';
      throw new Error(`unexpected xdotool command: ${command}`);
    },
  };
  const computer = new LinuxComputer(runner, config);
  await assert.rejects(() => computer.focusWindow({
    id: '41', processId: 101, title: 'Original',
    bounds: { x: 10, y: 20, width: 800, height: 600 },
  }), /changed before focus/);
  assert.equal(commands.some((command) => command.startsWith('windowactivate ')), false);
});

test('Linux focus rejects a native identity change during activation', async () => {
  const commands = [];
  let titleReads = 0;
  const runner = {
    async requireAny() { return 'xdotool'; },
    async run(argv) {
      const command = argv.slice(1).join(' ');
      commands.push(command);
      if (command === 'getwindowname 41') return `${titleReads++ === 0 ? 'Original' : 'Replacement'}\n`;
      if (command === 'getwindowgeometry --shell 41') return 'X=10\nY=20\nWIDTH=800\nHEIGHT=600\n';
      if (command === 'getwindowpid 41') return '101\n';
      if (command === 'windowactivate --sync 41') return '';
      if (command === 'getactivewindow') return '41\n';
      throw new Error(`unexpected xdotool command: ${command}`);
    },
  };
  const computer = new LinuxComputer(runner, config);
  await assert.rejects(() => computer.focusWindow({
    id: '41', processId: 101, title: 'Original',
    bounds: { x: 10, y: 20, width: 800, height: 600 },
  }), /changed during focus/);
  assert.equal(commands.includes('windowactivate --sync 41'), true);
});

test('Linux screenshot scales oversized captures and preserves source bounds', async () => {
  const png = (width, height) => {
    const data = Buffer.alloc(24);
    data.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    view.setUint32(16, width);
    view.setUint32(20, height);
    return data;
  };
  const commands = [];
  const runner = {
    async resolveAny(candidates) {
      if (candidates[0] === 'import') return '/usr/bin/import';
      if (candidates[0] === 'magick') return '/usr/bin/magick';
      return undefined;
    },
    async run(argv) {
      commands.push(argv);
      await writeFile(argv.at(-1), argv.includes('-resize') ? png(1920, 960) : png(4000, 2000));
      return '';
    },
  };
  const computer = new LinuxComputer(runner, config);
  const screenshot = await computer.screenshot({}, undefined);
  assert.equal(screenshot.width, 1920);
  assert.equal(screenshot.height, 960);
  assert.deepEqual(screenshot.sourceBounds, { x: 0, y: 0, width: 4000, height: 2000 });
  assert.deepEqual(commands[1].slice(0, 4), ['/usr/bin/magick', commands[0].at(-1), '-resize', '1920x1920>']);
});

test('Linux pointer commands interpolate drags and preserve positive horizontal scroll', async () => {
  const commands = [];
  const runner = {
    async requireAny() { return 'xdotool'; },
    async run(argv) { commands.push(argv); return ''; },
  };
  const computer = new LinuxComputer(runner, config);
  await computer.perform({ kind: 'drag', from: { x: 0, y: 0 }, to: { x: 100, y: 40 }, durationMs: 64 });
  await computer.perform({ kind: 'scroll', point: { x: 10, y: 20 }, deltaX: 120, deltaY: 0 });
  assert.ok(commands[0].filter((part) => part === 'mousemove').length > 2);
  assert.equal(commands[0].filter((part) => part === 'sleep').length, 4);
  assert.deepEqual(commands[1].slice(-4), ['click', '--repeat', '1', '7']);
});

test('Linux AT-SPI provider emits bounded snapshots and identity-checked actions', async () => {
  const payloads = [];
  let helperPath;
  const runner = {
    async requireAny(candidates) {
      assert.deepEqual(candidates, ['python3', 'python']);
      return 'python3';
    },
    async runJson(argv) {
      assert.equal(argv[0], 'python3');
      assert.match(argv[1], /linux-atspi\.py$/);
       helperPath = argv[1];
      payloads.push(JSON.parse(Buffer.from(argv[2], 'base64').toString('utf8')));
      return argv.length === 3 && payloads.at(-1).kind === 'snapshot'
        ? { element_id: 'atspi:2', role: 'application', process_id: 555, children: [] }
        : { ok: true };
    },
  };
  const computer = new LinuxComputer(runner, { ...config, maxAccessibilityNodes: 12, maxAccessibilityDepth: 4 });
  const tree = await computer.accessibilitySnapshot();
  assert.equal(tree.element_id, 'atspi:2');
  await computer.performAccessibility({
    kind: 'focus',
    elementId: 'atspi:2,4',
    element: {
      process_id: 555,
      process_path: '/usr/bin/example',
      automation_id: 'search',
      name: 'Search',
      class_name: 'Entry',
      role: 'text',
    },
  });
  assert.deepEqual(payloads, [{ kind: 'snapshot', maxNodes: 12, maxDepth: 4, maxCandidates: 5000 }, {
    kind: 'action',
    action: {
      kind: 'focus',
      elementId: 'atspi:2,4',
      maxDepth: 4,
      processId: 555,
      processPath: '/usr/bin/example',
      automationId: 'search',
      name: 'Search',
      className: 'Entry',
      role: 'text',
    },
  }]);
  assert.equal(computer.capabilities.accessibility, true);
   const helper = await readFile(helperPath, 'utf8');
   assert.match(helper, /def children_of\(accessible, limit\):/);
   assert.match(helper, /allowed = min\(max\(0, count\), max\(0, limit\)\)/);
   assert.match(helper, /children_of\(accessible, max_nodes - budget\[0\]\)/);
   assert.match(helper, /children_of\(current, remaining\)/);
});

test('Linux AT-SPI actions reject paths deeper than their snapshot limit', async () => {
  const computer = new LinuxComputer({
    async requireAny() { throw new Error('the backend must not launch'); },
    async runJson() { throw new Error('the backend must not launch'); },
  }, { ...config, maxAccessibilityDepth: 0 });
  await assert.rejects(() => computer.performAccessibility({
    kind: 'focus',
    elementId: 'atspi:2,4',
    element: { process_id: 555, role: 'text' },
  }), /exceeds the configured snapshot depth/);
});

test('macOS window tools use bounded System Events JXA scripts', async () => {
  let listingCommand;
  let focusCommand;
  const runner = {
    async requireAny() { return '/usr/bin/osascript'; },
    async runJson(argv) {
      if (argv[3] === '-e' && argv[4].includes('const expected =')) {
        focusCommand = argv;
        return { ok: true };
      }
      listingCommand = argv;
      return [{
        id: '912:1',
        windowIdentity: 'window-77',
        title: 'Test Window',
        bounds: { x: 20, y: 30, width: 640, height: 480 },
        processId: 912,
        application: 'Test App',
        focused: true,
      }];
    },
  };
  const computer = new MacComputer(runner, { ...config, maxAccessibilityNodes: 12 });
  const windows = await computer.listWindows();
  assert.equal(windows.length, 1);
  assert.match(windows[0].id, /^mac:[A-Za-z0-9_-]+$/);
  assert.deepEqual({ ...windows[0], id: 'opaque' }, {
    id: 'opaque',
    title: 'Test Window',
    bounds: { x: 20, y: 30, width: 640, height: 480 },
    processId: 912,
    application: 'Test App',
    focused: true,
  });
  assert.deepEqual(listingCommand.slice(0, 4), ['/usr/bin/osascript', '-l', 'JavaScript', '-e']);
  assert.match(listingCommand[4], /const limit = 12;/);
  assert.match(listingCommand[4], /windowIdentity/);
  await computer.focusWindow(windows[0].id);
  assert.deepEqual(focusCommand.slice(0, 4), ['/usr/bin/osascript', '-l', 'JavaScript', '-e']);
  assert.match(focusCommand[4], /"processId":912/);
  assert.match(focusCommand[4], /"windowIdentity":"window-77"/);
  assert.match(focusCommand[4], /matches\.length !== 1/);
  assert.doesNotMatch(focusCommand[4], /targetIndex/);
  assert.match(focusCommand[4], /target window no longer has unique matching metadata/);
  assert.match(focusCommand[4], /target window changed while activating its application/);
   assert.ok(
     focusCommand[4].indexOf("target window no longer has unique matching metadata")
       < focusCommand[4].indexOf('targetProcess.frontmost = true'),
     'macOS focus must verify stale metadata before foregrounding the application',
   );
   assert.match(focusCommand[4], /const revalidatedMatches = \[\]/);
   assert.match(focusCommand[4], /target window did not become focused/);
  await assert.rejects(() => computer.focusWindow('not-a-window'), /window id is invalid/);
});

test('macOS focus rejects a helper response without confirmation', async () => {
  let windowId;
  const computer = new MacComputer({
    async requireAny() { return '/usr/bin/osascript'; },
    async runJson(argv) {
      if (argv[3] === '-e' && argv[4].includes('const expected =')) return { ok: false };
      return [{
        id: '912:1',
        windowIdentity: 'window-88',
        title: 'Test Window',
        bounds: { x: 20, y: 30, width: 640, height: 480 },
        processId: 912,
      }];
    },
  }, config);
  [windowId] = (await computer.listWindows()).map((window) => window.id);
  await assert.rejects(() => computer.focusWindow(windowId), /did not confirm focus/);
});

test('macOS window listing omits windows without a durable identity', async () => {
  const computer = new MacComputer({
    async requireAny() { return '/usr/bin/osascript'; },
    async runJson() {
      return [{
        id: '912:1', windowIdentity: '', title: 'Ambiguous Window',
        bounds: { x: 20, y: 30, width: 640, height: 480 }, processId: 912,
      }];
    },
  }, config);
  assert.deepEqual(await computer.listWindows(), []);
});

test('macOS AX provider emits bounded snapshots and identity-checked actions', async () => {
  const payloads = [];
  let helperPath;
  const runner = {
    async requireAny(candidates) {
      assert.deepEqual(candidates, ['osascript', '/usr/bin/osascript']);
      return '/usr/bin/osascript';
    },
    async runJson(argv) {
      assert.deepEqual(argv.slice(0, 3), ['/usr/bin/osascript', '-l', 'JavaScript']);
      assert.match(argv[3], /macos-ax\.js$/);
      helperPath = argv[3];
      payloads.push(JSON.parse(Buffer.from(argv[4], 'base64').toString('utf8')));
      return payloads.at(-1).kind === 'snapshot'
        ? { element_id: 'ax:700:1', role: 'AXWindow', process_id: 700, children: [] }
        : { ok: true };
    },
  };
  const computer = new MacComputer(runner, { ...config, maxAccessibilityNodes: 16, maxAccessibilityDepth: 5 });
  const tree = await computer.accessibilitySnapshot();
  assert.equal(tree.element_id, 'ax:700:1');
  await computer.performAccessibility({
    kind: 'set_value',
    elementId: 'ax:700:1,0',
    value: 'new value',
    element: {
      process_id: 700,
      name: 'Search',
      role: 'AXTextField',
      bounds: { x: 30, y: 40, width: 200, height: 24 },
    },
  });
  assert.deepEqual(payloads, [{ kind: 'snapshot', maxNodes: 16, maxDepth: 5 }, {
    kind: 'action',
    action: {
      kind: 'set_value',
      elementId: 'ax:700:1,0',
      processId: 700,
      name: 'Search',
      role: 'AXTextField',
      bounds: { x: 30, y: 40, width: 200, height: 24 },
      value: 'new value',
    },
  }]);
  assert.equal(computer.capabilities.accessibility, true);
  const helper = await readFile(helperPath, 'utf8');
  assert.match(helper, /function sameBounds/);
  assert.match(helper, /element bounds changed after observation/);
  assert.match(helper, /element did not become focused/);
});

test('macOS pointer adapter uses the bundled CoreGraphics helper', async () => {
  const commands = [];
  const payloads = [];
  const runner = {
    async requireAny() { return '/usr/bin/osascript'; },
    async runJson(argv) {
      commands.push(argv);
      payloads.push(JSON.parse(Buffer.from(argv[4], 'base64').toString('utf8')));
      return { ok: true };
    },
  };
  const computer = new MacComputer(runner, config);
  await computer.perform({ kind: 'drag', from: { x: 10, y: 20 }, to: { x: 30, y: 40 }, durationMs: 200 });
  await computer.perform({ kind: 'scroll', point: { x: 50, y: 60 }, deltaX: 0, deltaY: 240 });
  assert.equal(commands.length, 2);
  assert.deepEqual(commands[0].slice(0, 3), ['/usr/bin/osascript', '-l', 'JavaScript']);
  assert.match(commands[0][3], /macos-input\.js$/);
  assert.deepEqual(payloads, [
    { kind: 'drag', from: { x: 10, y: 20 }, to: { x: 30, y: 40 }, durationMs: 200 },
    { kind: 'scroll', point: { x: 50, y: 60 }, deltaX: 0, deltaY: 240 },
  ]);
  const helper = await readFile(commands[1][3], 'utf8');
  assert.match(helper, /kCGEventLeftMouseDragged/);
  assert.match(helper, /post\(mouseEvent\('drag', point, 'left'\)\)/);
  assert.match(helper, /post\(mouseEvent\('move', point, 'left'\)\)/);
});
test('Windows focus revalidates complete listed window identity', async () => {
  let payload;
  const runner = {
    async requireAny() { return 'powershell.exe'; },
    async runJson(argv) {
      const script = await readFile(argv.at(-1), 'utf8');
      assert.match(script, /EnumWindows\(/);
      assert.match(script, /IsWindowVisible\(handle\)/);
      assert.match(script, /IsIconic\(handle\)/);
       assert.match(script, /ConvertTo-Json -InputObject \$value/);
       assert.match(script, /\$items = @\(\[DshComputer\.Native\]::VisibleWindows\(\)/);
       assert.match(script, /WindowMatches\(long rawHandle/);
      assert.match(script, /requested window no longer matches its listed identity/);
      const encoded = script.match(/FromBase64String\('([^']+)'\)/)?.[1];
      assert.notEqual(encoded, undefined);
      payload = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
      return { ok: true };
    },
  };
  const computer = new WindowsComputer(runner, config);
  await computer.focusWindow({
    id: '12345', processId: 123, title: 'Observed Window',
    bounds: { x: 10, y: 20, width: 800, height: 600 },
  });
  assert.deepEqual(payload, {
    kind: 'focus', id: '12345', processId: 123, title: 'Observed Window',
    bounds: { x: 10, y: 20, width: 800, height: 600 },
  });
  await assert.rejects(() => computer.focusWindow({ id: '12345' }), /requires a listed native window record/);
});

test('Windows semantic actions use their dedicated candidate search bound', async () => {
  let payload;
  const runner = {
    async requireAny() { return 'powershell.exe'; },
    async runJson(argv) {
      const script = await readFile(argv.at(-1), 'utf8');
      assert.doesNotMatch(script, /FindAll\(/);
      assert.match(script, /\$scanned -lt \$maxCandidates/);
      assert.match(script, /public static void Move\(int x, int y\)/);
       assert.match(script, /'move' \{ \[DshComputer\.Native\]::Move\(/);
       assert.doesNotMatch(script, /'move' \{ \[DshComputer\.Native\]::SetCursorPos\(/);
       assert.match(script, /if \(!SetCursorPos\(x, y\)\)/);
      assert.match(script, /Math\.Ceiling\(duration \/ 16\.0\)/);
      const encoded = script.match(/FromBase64String\('([^']+)'\)/)?.[1];
      assert.notEqual(encoded, undefined);
      payload = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
      return { ok: true };
    },
  };
  const computer = new WindowsComputer(runner, {
    ...config,
    maxAccessibilityNodes: 2,
    maxAccessibilityActionCandidates: 777,
  });
  await computer.performAccessibility({
    kind: 'focus',
    elementId: 'uia:7,900,42',
    element: {
      process_id: 900,
      automation_id: 'Target',
      name: 'Target input',
      class_name: 'TextBox',
      role: 'Edit',
    },
  });
  assert.equal(payload.action.maxCandidates, 777);
  assert.equal(payload.action.processId, 900);
  assert.equal(payload.action.kind, 'focus');
});
