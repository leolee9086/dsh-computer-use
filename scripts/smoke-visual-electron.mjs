// 区域 OCR/找色的真实 Windows 工具验收，必须传正在使用的 Electron 可执行文件。
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { runElectronSmoke } from './electron-smoke-runner.mjs';
const executable = process.argv[2] ?? process.env.DSH_ELECTRON_EXECUTABLE;
if (process.platform !== 'win32' || !executable || !existsSync(executable)) throw new Error('Provide an existing Windows Electron executable');
const root = fileURLToPath(new URL('../', import.meta.url));
runElectronSmoke(executable, resolve(root, 'test/win32-visual-smoke.mjs'), { cwd: root });
