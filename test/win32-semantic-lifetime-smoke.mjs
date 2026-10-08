// 使用生产C#源码和真实UIA/MSAA提供者，覆盖分段内到期及封存后的时钟边界。
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createManagedRunner } from './win32-runner.mjs';

if (process.platform !== 'win32') throw new Error('This lifetime fixture requires Windows');
const directory = await mkdtemp(join(tmpdir(), 'dsh-snapshot-lifetime-'));
const runner = await createManagedRunner();
let child;
function lineReader(stream) {
  let buffer = ''; const queued = []; let pending;
  stream.setEncoding('utf8');
  stream.on('data', (text) => {
    buffer += text; let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end).trim(); buffer = buffer.slice(end + 1);
      if (pending) { const deliver = pending; pending = undefined; deliver(line); } else queued.push(line);
    }
  });
  return () => queued.length ? Promise.resolve(queued.shift()) : new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending = undefined; reject(new Error('lifetime fixture command timeout')); }, 10000);
    pending = (line) => { clearTimeout(timer); resolve(line); };
  });
}
async function gac(name) {
  const root = join(process.env.WINDIR ?? 'C:\\Windows', 'Microsoft.NET', 'assembly', 'GAC_MSIL', name);
  return (await readdir(root)).map((version) => join(root, version, `${name}.dll`)).find(existsSync);
}
const path = (relative) => fileURLToPath(new URL(relative, import.meta.url));
try {
  const compiler = join(process.env.WINDIR ?? 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
  const refs = await Promise.all(['UIAutomationClient', 'UIAutomationTypes', 'UIAutomationProvider', 'WindowsBase', 'Accessibility'].map(gac));
  const referenceArgs = refs.map((reference) => `/r:${reference}`);
  const fixture = join(directory, 'fixture.exe');
  await runner.run([compiler, '/nologo', '/noconfig', '/target:exe', `/out:${fixture}`,
    '/r:System.dll', '/r:System.Core.dll', '/r:System.Windows.Forms.dll', '/r:System.Drawing.dll',
    ...referenceArgs, path('./windows-large-tree-fixture.cs')]);
  const legacy = join(directory, 'native-uia.cs');
  await writeFile(legacy, (await readFile(new URL('../src/windows-uia.cs', import.meta.url), 'utf8'))
    .replace('public class Startup', 'public class NativeUia'));
  const probe = join(directory, 'lifetime-probe.exe');
  await runner.run([compiler, '/nologo', '/noconfig', '/target:exe', '/platform:x64', '/main:SnapshotLifetimeFixture', `/out:${probe}`,
    '/r:System.dll', '/r:System.Core.dll', '/r:Microsoft.CSharp.dll', '/r:System.Web.Extensions.dll', ...referenceArgs,
    path('../src/windows-semantic-worker.cs'), path('../src/windows-semantic-snapshot.cs'), path('../src/windows-semantic-locator.cs'), legacy,
    path('./windows-semantic-lifetime-probe.cs')]);
  child = runner.start([fixture]); const nextLine = lineReader(child.stdout);
  const hwnd = await nextLine(); assert.match(hwnd, /^\d+$/);
  child.stdin.write('resize:160\n'); assert.equal(await nextLine(), 'resized');
  child.stdin.write('delay:12:1200\n'); assert.equal(await nextLine(), 'delay-set');
  for (const backend of ['uia', 'msaa']) {
    const result = await runner.runJson([probe, hwnd, backend], { timeoutMs: 20000 });
    assert.equal(result.backend, backend); assert.equal(result.production_lifetime_ms, 120000);
    assert.equal(result.during_capture_expiry, 'passed'); assert.equal(result.expired_cursor_reuse, 'rejected');
    assert.equal(result.expired_references, 'removed'); assert.equal(result.monotonic_frozen_expiry, 'passed');
    assert.equal(result.healthy_after_expiry, 'passed');
    console.log(JSON.stringify(result));
  }
} finally {
  if (child) { child.terminate(); await child.waitForExit(AbortSignal.timeout(3000)); }
  await runner.dispose(); await rm(directory, { recursive: true, force: true });
}
