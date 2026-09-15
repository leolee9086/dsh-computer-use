import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { MacComputer } from '../src/macos.js';

if (process.platform !== 'darwin') {
  console.log(JSON.stringify({ platform: process.platform, skipped: true, reason: 'macOS smoke runs only on darwin' }));
  process.exit(0);
}

const execute = promisify(execFile);
const runner = {
  async requireAny(candidates) {
    for (const candidate of candidates) {
      try {
        await execute(candidate, ['-h'], { encoding: 'utf8', maxBuffer: 4096 });
        return candidate;
      } catch {
        // Probe the next standard macOS executable name.
      }
    }
    throw new Error(`missing macOS executable: ${candidates.join(', ')}`);
  },
  async resolveAny(candidates) {
    for (const candidate of candidates) {
      try {
        await execute(candidate, ['-h'], { encoding: 'utf8', maxBuffer: 4096 });
        return candidate;
      } catch {
        // Optional command is absent.
      }
    }
    return undefined;
  },
  async run(argv, options = {}) {
    const { stdout, stderr } = await execute(argv[0], argv.slice(1), {
      encoding: 'utf8',
      maxBuffer: options.stdoutMaxBytes ?? 16 * 1024 * 1024,
    });
    if (stderr.trim() !== '') process.stderr.write(stderr);
    return stdout;
  },
  async runJson(argv, options = {}) {
    const stdout = await this.run(argv, options);
    return JSON.parse(stdout);
  },
};

const config = {
  screenshotMaxDimension: 1920,
  screenshotMaxBytes: 12_000_000,
  commandTimeoutMs: 30_000,
  graceMs: 2_000,
  actionDelayMs: 40,
  maxAccessibilityNodes: 300,
  maxAccessibilityDepth: 6,
  maxAccessibilityBytes: 1_000_000,
  maxAccessibilityActionCandidates: 5_000,
};
const computer = new MacComputer(runner, config);
const [displays, screenshot, windows, accessibility] = await Promise.all([
  computer.listDisplays(),
  computer.screenshot({}),
  computer.listWindows(),
  computer.accessibilitySnapshot(),
]);
console.log(JSON.stringify({
  capabilities: computer.capabilities,
  displays,
  screenshot: { width: screenshot.width, height: screenshot.height, bytes: screenshot.data.byteLength },
  windows: windows.slice(0, 10),
  accessibility: { elementId: accessibility.element_id, role: accessibility.role, name: accessibility.name },
}, null, 2));
