// 自动遍历语法检查，新增模块或 smoke 不再需要维护一长串文件名。
import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
let count = 0;
async function check(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) await check(path);
    else if (/\.(js|mjs)$/.test(entry.name)) {
      const result = spawnSync(process.execPath, ['--check', path], { stdio: 'inherit' });
      if (result.error) throw result.error;
      if (result.status !== 0) throw new Error(`Syntax check failed: ${entry.name}`);
      count++;
    }
  }
}
for (const directory of ['src', 'test', 'scripts']) await check(resolve(root, directory));
console.log(`Syntax checked ${count} JavaScript files`);
