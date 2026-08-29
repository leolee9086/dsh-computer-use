import { WindowsComputer } from './windows.js';
import { MacComputer } from './macos.js';
import { LinuxComputer } from './linux.js';
import { unsupported } from './errors.js';

class UnsupportedComputer {
  constructor() {
    this.capabilities = Object.freeze({
      platform: process.platform,
      screenshot: false,
      pointer: false,
      keyboard: false,
      windows: false,
      accessibility: false,
    });
  }

  unavailable() {
    throw unsupported(`dsh-computer-use does not support ${process.platform}`);
  }

  async listDisplays() { return this.unavailable(); }
  async screenshot() { return this.unavailable(); }
  async perform() { return this.unavailable(); }
  async listWindows() { return this.unavailable(); }
  async focusWindow() { return this.unavailable(); }
  async accessibilitySnapshot() { return this.unavailable(); }
}

export function createPlatformDriver(runner, config) {
  switch (process.platform) {
    case 'win32': return new WindowsComputer(runner, config);
    case 'darwin': return new MacComputer(runner, config);
    case 'linux': return new LinuxComputer(runner, config);
    default: return new UnsupportedComputer();
  }
}
