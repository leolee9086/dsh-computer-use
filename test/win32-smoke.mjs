import { WindowsComputer } from '../src/windows.js';
import { createRunner } from './win32-runner.mjs';

const runner = createRunner();

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
