import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { runElectronSmoke } from './electron-smoke-runner.mjs';

const executable = process.argv[2];
if (!executable) throw new Error('Pass the actual DeepSeek Harness executable');
const root = fileURLToPath(new URL('../', import.meta.url));
const started = performance.now(), observedAt = new Date().toISOString();
// 两个模块顺序操作各自的新应用，只有清理后的完成标记才能进入联合记录。
for (const file of ['../test/win32-locator-smoke.mjs', '../test/win32-locator-app-smoke.mjs']) {
  runElectronSmoke(executable, fileURLToPath(new URL(file, import.meta.url)), { cwd: root, timeoutMs: 180000 });
}
const sources = [];
for (const file of ['locator-0.5.16-smoke-metrics.json', 'locator-0.5.16-app-metrics.json']) {
  const bytes = await readFile(new URL(`../.local/${file}`, import.meta.url)), result = JSON.parse(bytes);
  assert.equal(result.fullAcceptance, true, `${file} did not accept its own tasks`);
  assert.ok(Date.parse(result.observedAt) >= Date.parse(observedAt), `${file} must come from this joint run`);
  // 不能把上一版实测 hash 当成现在源文件的证据；文案变更也要重新对应。
  for (const [source, expected] of Object.entries(result.sources)) {
    const current = createHash('sha256').update(await readFile(new URL(`../${source}`, import.meta.url))).digest('hex');
    assert.equal(current, expected, `${source} differs from its accepted source`);
  }
  sources.push({ file, observedAt: result.observedAt, sha256: createHash('sha256').update(bytes).digest('hex'), acceptedSources: result.sources });
}
const result = { observedAt, fullAcceptance: true, stages: ['WPF locator and production matcher contracts', 'actual Sound device selection'],
  elapsed_ms: Math.round(performance.now() - started), sources };
await mkdir(new URL('../.local/', import.meta.url), { recursive: true });
await writeFile(new URL('../.local/locator-0.5.16-joint-metrics.json', import.meta.url), JSON.stringify(result, null, 2));
console.log(JSON.stringify({ locator_acceptance: result }, null, 2));
