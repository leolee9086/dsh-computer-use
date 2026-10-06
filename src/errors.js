export class ComputerUseError extends Error {
  // Keep the public string code separate from ErrorOptions so a native bridge
  // failure retains its original cause without turning code into an object.
  constructor(message, code = 'COMPUTER_OPERATION_FAILED', options) {
    super(message, options);
    this.name = 'ComputerUseError';
    this.code = code;
  }
}

export function unavailable(message) {
  return new ComputerUseError(message, 'COMPUTER_UNAVAILABLE');
}

export function unsupported(message) {
  return new ComputerUseError(message, 'COMPUTER_UNSUPPORTED');
}

/**
 * 这个平台还不能"按窗口抓语义树"时，把话说明白。
 *
 * 为什么是报错而不是忽略：忽略就等于**悄悄退回"当前焦点窗口"**——
 * 返回的树看着完全正常，只是属于另一个窗口。调用方拿着同一个 screenshot_id
 * 得到两份互相矛盾的证据，却没有任何迹象提示它。做不到就说做不到。
 *
 * @param windowHandle - 宿主侧传下来的窗口句柄；空值表示没指定，可以直接放行。
 * @param platformName - 平台名，用在报错里。
 */
export function requireWindowHandleUnsupported(windowHandle, platformName) {
  if (typeof windowHandle !== 'string' || windowHandle.length === 0) return;
  throw unsupported(
    `${platformName} 后端还不支持按窗口抓语义树（收到窗口句柄 ${windowHandle}）。`
    + '请改用整屏截图，或者先给这个平台补上按窗口扎根的实现——'
    + '不要静默退回"当前焦点窗口"，那会返回另一个窗口的树。',
  );
}
