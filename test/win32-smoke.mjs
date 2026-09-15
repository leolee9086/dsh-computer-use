import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { WindowsComputer } from '../src/windows.js';

const execute = promisify(execFile);
const runner = {
  async requireAny() { return 'powershell.exe'; },
  async runJson(argv, options = {}) {
    const { stdout, stderr } = await execute(argv[0], argv.slice(1), {
      encoding: 'utf8',
      maxBuffer: options.stdoutMaxBytes ?? 16 * 1024 * 1024,
    });
    if (stderr.trim() !== '') process.stderr.write(stderr);
    return JSON.parse(stdout);
  },
};

const computer = new WindowsComputer(runner, {
  screenshotMaxDimension: 1280,
  screenshotMaxBytes: 12_000_000,
  commandTimeoutMs: 30_000,
  graceMs: 2_000,
  actionDelayMs: 0,
  maxAccessibilityNodes: 32,
  maxAccessibilityDepth: 3,
  maxAccessibilityBytes: 1_000_000,
  maxAccessibilityActionCandidates: 5_000,
});

function nodeCount(node) {
  if (node === null || typeof node !== 'object') return 0;
  return 1 + (Array.isArray(node.children) ? node.children.reduce((total, child) => total + nodeCount(child), 0) : 0);
}

const [displays, screenshot, windows, accessibility] = await Promise.all([
  computer.listDisplays(),
  computer.screenshot({}),
  computer.listWindows(),
  computer.accessibilitySnapshot(),
]);

console.log(JSON.stringify({
  displays,
  screenshot: {
    width: screenshot.width,
    height: screenshot.height,
    sourceBounds: screenshot.sourceBounds,
    bytes: screenshot.data.byteLength,
  },
  windows: windows.slice(0, 5),
  accessibility: {
    elementId: accessibility.element_id,
    role: accessibility.role,
    name: accessibility.name,
    patterns: accessibility.patterns,
    nodes: nodeCount(accessibility),
    children: accessibility.children?.length ?? 0,
  },
}, null, 2));
