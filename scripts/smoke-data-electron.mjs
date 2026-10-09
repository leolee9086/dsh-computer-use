import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { runElectronSmoke } from './electron-smoke-runner.mjs';

const executable = process.argv[2], selection = process.argv[3] ?? 'all';
if (!executable) throw new Error('Pass the actual DeepSeek Harness executable');
if (!['all', 'fixture', 'app'].includes(selection)) throw new Error('Select all, fixture or app');
if (selection !== 'app' && process.env.DSH_DATA_APP_PROBE !== undefined) throw new Error('An application probe requires the explicit app entry');
const root = fileURLToPath(new URL('../', import.meta.url));
const run = (file, env = {}) => runElectronSmoke(executable, fileURLToPath(new URL(file, import.meta.url)), { cwd: root, timeoutMs: 180000, env });

// 子集和探查有独立标签。默认完整入口必须顺序跑夹具、真实树应用与真实 Grid 应用，
// 每个模块的官方完成标记都在 Context / 应用 / runner 清理之后才出现。
if (selection === 'app') {
  run('../test/win32-data-app-smoke.mjs');
  console.log(JSON.stringify({ data_acceptance: { fullAcceptance: false, selection: 'app', probeOnly: process.env.DSH_DATA_APP_PROBE === '1' } }));
} else if (selection === 'fixture' || process.env.DSH_DATA_MODES !== undefined) {
  run('../test/win32-data-smoke.mjs');
  console.log(JSON.stringify({ data_acceptance: { fullAcceptance: false, selection: 'fixture', modes: process.env.DSH_DATA_MODES ?? 'tree,virtual,grid,scroll' } }));
} else {
  const started = performance.now(), observedAt = new Date().toISOString();
  run('../test/win32-data-smoke.mjs');
  run('../test/win32-data-app-smoke.mjs', { DSH_DATA_APP_MODE: 'tree' });
  run('../test/win32-data-app-smoke.mjs', { DSH_DATA_APP_MODE: 'grid' });
  const sources = [];
  for (const [file, fixture] of [['data-smoke-metrics.json', true], ['data-app-tree-metrics.json', false], ['data-app-grid-metrics.json', false]]) {
    const bytes = await readFile(new URL(`../.local/${file}`, import.meta.url)), result = JSON.parse(bytes);
    assert.equal(fixture ? result.fullAcceptance : result.accepted, true, `${file} did not accept its task`);
    if (!fixture) assert.equal(result.probeOnly, false);
    sources.push({ file, observedAt: result.observedAt, sha256: createHash('sha256').update(bytes).digest('hex') });
  }
  const result = { observedAt, fullAcceptance: true, stages: ['WPF tree/virtual/grid/scroll', 'System Information tree', 'Out-GridView'],
    elapsed_ms: Math.round(performance.now() - started), sources };
  await mkdir(new URL('../.local/', import.meta.url), { recursive: true });
  await writeFile(new URL('../.local/data-joint-metrics.json', import.meta.url), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ data_acceptance: result }, null, 2));
}
