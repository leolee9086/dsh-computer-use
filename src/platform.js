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
  async captureWindow() { return this.unavailable(); }
  async findImage() { return this.unavailable(); }
  async perform() { return this.unavailable(); }
  async listWindows() { return this.unavailable(); }
  async focusWindow() { return this.unavailable(); }
  /**
   * 抓一棵语义树。
   * @param windowHandle - 可选的窗口句柄。给了就**必须**从那个窗口扎根；
   *   做不到就报错，不许静默退回"当前焦点窗口"（那会返回另一个窗口的树）。
   * @param signal - 取消信号。
   */
  async accessibilitySnapshot(windowHandle, signal) { return this.unavailable(); }
  async performAccessibility() { return this.unavailable(); }
}

export function createPlatformDriver(runner, config) {
  switch (process.platform) {
    case 'win32': return new WindowsComputer(runner, config);
    case 'darwin': return new MacComputer(runner, config);
    case 'linux': return new LinuxComputer(runner, config);
    default: return new UnsupportedComputer();
  }
}
