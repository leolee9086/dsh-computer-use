import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { root, sha256, sources, version } from './native-artifact.mjs';
const input = resolve(root, 'native/target/release/dsh-screen.exe');
const output = resolve(root, 'native/release/dsh-screen.exe');
const data = await readFile(input);
if (data[0] !== 0x4d || data[1] !== 0x5a) throw new Error('Expected a Windows PE executable');
await mkdir(resolve(root, 'native/release'), { recursive: true });
await copyFile(input, output);
// 只记录当前构建的内容，不把本机绝对路径写入发布清单。
const manifest = { version: await version(), executableSha256: sha256(data), sources: await sources() };
await writeFile(resolve(root, 'native/release/manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify(manifest, null, 2));
