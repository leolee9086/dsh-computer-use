// Supply the real desktop executable, rather than testing only its Node major:
// pnpm run smoke:electron "C:\path\to\Harness.exe"
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const executable = process.argv[2] ?? process.env.DSH_ELECTRON_EXECUTABLE;
if (process.platform !== 'win32' || !executable || !existsSync(executable)) {
  throw new Error('Provide an existing Windows Electron executable as the first argument or DSH_ELECTRON_EXECUTABLE');
}
const root = fileURLToPath(new URL('../', import.meta.url));
// Own-window GUI checks run sequentially to avoid interfering with each other.
for (const file of ['win32-csharp-smoke.mjs', 'win32-semantic-focus-smoke.mjs', 'win32-expansion-smoke.mjs', 'win32-msaa-smoke.mjs', 'win32-semantic-large-tree-smoke.mjs', 'win32-semantic-snapshot-smoke.mjs', 'win32-semantic-lifetime-smoke.mjs']) {
  const result = spawnSync(resolve(executable), [resolve(root, 'test', file)], {
    cwd: root,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', DSH_EXPECT_ELECTRON: '1' },
    stdio: 'inherit',
    windowsHide: true,
    timeout: 120000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${file} failed in Electron (exit ${result.status})`);
}
