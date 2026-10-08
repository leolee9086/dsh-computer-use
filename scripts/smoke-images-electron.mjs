// 图像匹配改动只需图像任务、原生输入/抓屏和实际 ABI 桥的定向回归。
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runElectronSmoke } from './electron-smoke-runner.mjs';

const executable = process.argv[2] ?? process.env.DSH_ELECTRON_EXECUTABLE;
if (process.platform !== 'win32' || !executable || !existsSync(executable)) {
  throw new Error('Provide an existing Windows Electron executable as the first argument or DSH_ELECTRON_EXECUTABLE');
}
const root = fileURLToPath(new URL('../', import.meta.url));
const modules = {
  image: 'win32-image-match-smoke.mjs', native: 'win32-native-expansion-smoke.mjs', bridge: 'win32-csharp-smoke.mjs',
};
// 定向修复后可以只重复失败模块，已通过的 GUI 任务不必重新占用桌面。
const selected = process.argv.slice(3);
const names = selected.length ? selected : Object.keys(modules);
for (const name of names) {
  if (!Object.hasOwn(modules, name)) throw new Error(`Unknown image regression '${name}'; choose image, native or bridge`);
  runElectronSmoke(executable, resolve(root, 'test', modules[name]), { cwd: root });
}
