import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { LinuxComputer } from '../src/linux.js';

if (process.platform !== 'linux') {
  console.log(JSON.stringify({ platform: process.platform, skipped: true, reason: 'Linux smoke runs only on linux' }));
  process.exit(0);
}

const execute = promisify(execFile);
const runner = {
  async resolveAny(candidates) {
    for (const candidate of candidates) {
      try {
        await execute(candidate, ['--help'], { encoding: 'utf8', maxBuffer: 4096 });
        return candidate;
      } catch {
        // Optional capture backend is absent.
      }
    }
    return undefined;
  },
  async requireAny(candidates) {
    const value = await this.resolveAny(candidates);
    if (value === undefined) throw new Error(`missing Linux executable: ${candidates.join(', ')}`);
    return value;
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
const computer = new LinuxComputer(runner, config);
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
