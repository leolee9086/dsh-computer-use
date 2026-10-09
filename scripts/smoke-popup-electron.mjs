// 四类真实弹窗验收；完成标记必须在内层检查与清理结束后产生。
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { runElectronSmoke } from './electron-smoke-runner.mjs';
const executable = process.argv[2] ?? process.env.DSH_ELECTRON_EXECUTABLE;
if (process.platform !== 'win32' || !executable || !existsSync(executable)) throw new Error('Provide an existing Windows Electron executable');
const root = fileURLToPath(new URL('../', import.meta.url));
if (process.env.DSH_POPUP_MODES !== undefined) runElectronSmoke(executable, resolve(root, 'test/win32-popup-smoke.mjs'), { cwd: root });
else {
  runElectronSmoke(executable, resolve(root, 'test/win32-popup-smoke.mjs'), { cwd: root });
  runElectronSmoke(executable, resolve(root, 'test/win32-popup-app-smoke.mjs'), { cwd: root });
}
