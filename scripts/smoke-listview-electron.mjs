// 标准 ListView 的真实 32/64 位验收；外层检查内层运行、清理和完成标记。
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { runElectronSmoke } from './electron-smoke-runner.mjs';
const executable = process.argv[2] ?? process.env.DSH_ELECTRON_EXECUTABLE;
if (process.platform !== 'win32' || !executable || !existsSync(executable)) throw new Error('Provide an existing Windows Electron executable');
const root = fileURLToPath(new URL('../', import.meta.url));
const mode = process.argv[3] ?? 'fixture';
if (!['fixture', 'app'].includes(mode)) throw new Error('ListView smoke mode must be fixture or app');
runElectronSmoke(executable, resolve(root, mode === 'app' ? 'test/win32-listview-app-smoke.mjs' : 'test/win32-listview-smoke.mjs'), { cwd: root });
