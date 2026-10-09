import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Electron 的外层可执行文件可能在内层 Node 失败时仍返回0。
// 完成标记必须在测试模块和清理都结束后打印；晚到的异常另留失败标记。
export function runElectronSmoke(executable, file, { timeoutMs = 120000, expectElectron = true, reportOutput = true, cwd, env = {} } = {}) {
  const entry = pathToFileURL(resolve(file)).href;
  const complete = `DshComputerUseSmokeComplete:${entry}`;
  const failed = `DshComputerUseSmokeFailed:${entry}`;
  const bootstrap = `
const entry = process.argv[1];
const failed = 'DshComputerUseSmokeFailed:' + entry;
const fail = error => { console.error(failed); console.error(error); process.exitCode = 1; };
process.on('uncaughtException', fail);
process.on('unhandledRejection', fail);
try {
  if (process.env.DSH_EXPECT_ELECTRON === '1' && !process.versions.electron) throw new Error('Expected the actual Electron runtime');
  await import(entry);
  console.log('DshComputerUseSmokeComplete:' + entry);
} catch (error) { fail(error); }
`;
  const result = spawnSync(resolve(executable), ['--input-type=module', '--eval', bootstrap, entry], {
    cwd,
    env: { ...process.env, ...env, ELECTRON_RUN_AS_NODE: '1', DSH_EXPECT_ELECTRON: expectElectron ? '1' : '0' },
    stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', windowsHide: true,
    timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024,
  });
  if (reportOutput) {
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
  }
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${file} failed in Electron (exit ${result.status})`);
  const stdoutLines = (result.stdout ?? '').split(/\r?\n/);
  const stderrLines = (result.stderr ?? '').split(/\r?\n/);
  if (stdoutLines.includes(failed) || stderrLines.includes(failed)) throw new Error(`${file} reported a runtime failure despite exit 0`);
  if (!stdoutLines.includes(complete)) throw new Error(`${file} exited without its completion marker`);
  return result;
}
