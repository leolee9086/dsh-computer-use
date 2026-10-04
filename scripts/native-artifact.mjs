// 构建时记录文件哈希，打包时重新核对；不要求安装方拥有 Rust 工具链。
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
export const root = fileURLToPath(new URL('../', import.meta.url));
export const sha256 = data => createHash('sha256').update(data).digest('hex');
export async function sources() {
  const files = ['native/Cargo.toml', 'native/Cargo.lock'];
  for (const name of await readdir(resolve(root, 'native/src'))) {
    if (name.endsWith('.rs')) files.push(`native/src/${name}`);
  }
  const result = {};
  for (const name of files.sort()) result[name] = sha256(await readFile(resolve(root, name)));
  return result;
}
export async function version() {
  return JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8')).version;
}
