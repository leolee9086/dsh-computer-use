// Supply the real desktop executable, rather than testing only its Node major:
// pnpm run smoke:electron "C:\path\to\Harness.exe"
import { runElectronSmoke } from './electron-smoke-runner.mjs';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const executable = process.argv[2] ?? process.env.DSH_ELECTRON_EXECUTABLE;
if (process.platform !== 'win32' || !executable || !existsSync(executable)) {
  throw new Error('Provide an existing Windows Electron executable as the first argument or DSH_ELECTRON_EXECUTABLE');
}
const root = fileURLToPath(new URL('../', import.meta.url));
// Own-window GUI checks run sequentially to avoid interfering with each other.
for (const file of ['win32-csharp-smoke.mjs', 'win32-semantic-focus-smoke.mjs', 'win32-expansion-smoke.mjs', 'win32-msaa-smoke.mjs', 'win32-semantic-large-tree-smoke.mjs', 'win32-semantic-snapshot-smoke.mjs', 'win32-semantic-recovery-smoke.mjs', 'win32-semantic-match-limit-smoke.mjs', 'win32-semantic-tool-runtime-smoke.mjs', 'win32-semantic-lifetime-smoke.mjs', 'win32-semantic-source-consistency-smoke.mjs']) {
  runElectronSmoke(executable, resolve(root, 'test', file), { cwd: root });
}
