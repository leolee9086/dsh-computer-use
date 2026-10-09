import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const harnessRoot = process.env.DSH_HARNESS_ROOT
  ? resolve(process.env.DSH_HARNESS_ROOT) : resolve(projectRoot, '..', 'deepseek-harness');
if (!existsSync(join(harnessRoot, 'package.json'))) {
  throw new Error('DSH_HARNESS_ROOT must name an unpacked DeepSeek Harness test checkout');
}
const requireHarness = createRequire(join(harnessRoot, 'package.json'));
const requirePlugin = createRequire(join(projectRoot, 'package.json'));
const { register } = await import(pathToFileURL(requireHarness.resolve('tsx/esm/api')).href);
const sourceLoader = register({ namespace: 'computer-use-composition-probe', tsconfig: join(harnessRoot, 'tsconfig.json') });
const [{ Context, FiberState }, { Loader }, { default: Include, applyEntryPatches, entryListSchema },
  { default: SystemPrompt }, { default: ToolRuntime }, { default: LocalSubprocess }, yaml] = await Promise.all([
  sourceLoader.import('@deepseek-ai/cordis', import.meta.url),
  sourceLoader.import('@deepseek-ai/cordis-plugin-loader', import.meta.url),
  sourceLoader.import('@deepseek-ai/cordis-plugin-include', import.meta.url),
  sourceLoader.import('@deepseek-ai/dsh-system-prompt', import.meta.url),
  sourceLoader.import('@deepseek-ai/dsh-tools', import.meta.url),
  sourceLoader.import('@deepseek-ai/dsh-subprocess-local', import.meta.url),
  sourceLoader.import('js-yaml', pathToFileURL(join(harnessRoot, 'vendor/include/package.json')).href),
]);

const toolNames = [
  'computer_accessibility', 'computer_act', 'computer_click', 'computer_click_image', 'computer_drag',
  'computer_element', 'computer_find', 'computer_find_color', 'computer_find_image', 'computer_input',
  'computer_key', 'computer_locate', 'computer_move', 'computer_narrator', 'computer_ocr', 'computer_read',
  'computer_read_control', 'computer_screenshot', 'computer_scroll', 'computer_scroll_find', 'computer_status',
  'computer_tree', 'computer_type', 'computer_wait', 'computer_wait_visual', 'computer_window_input', 'computer_windows',
];
const toolConfig = {
  observeApproval: 'allow', controlApproval: 'deny', maxObservationAgeMs: 120_000,
  maxObservationsPerAgent: 8, maxSemanticSnapshots: 8, maxSemanticMatches: 20,
};
const directory = await mkdtemp(join(tmpdir(), 'dsh-computer-use-composition-'));
const ctx = new Context();
const result = { observedAt: new Date().toISOString(), mode: 'local-export-composition', sources: {} };
let completed = false;
try {
  // 真正读取 bundle patch，用官方 patch 语义覆盖一整行；不安装依赖、不写 profile。
  const patch = yaml.load(await readFile(join(projectRoot, 'cordis.patch.yml'), 'utf8'), { schema: entryListSchema });
  const entries = applyEntryPatches([], [...patch, { id: 'dsh-computer-use-tool', config: toolConfig }], message => {
    throw new Error(`bundle patch warning: ${message}`);
  });
  assert.equal(entries.length, 3);
  // 自引用 package exports 是真实解析器的结果。把解析到的本地文件 URL 交给 Loader，
  // 因此验收的是源码组合挂载，而不是 npm 安装、CLI/profile 层叠或当前 GUI 升级。
  result.exports = Object.fromEntries(entries.map(entry => [entry.name, requirePlugin.resolve(entry.name)]));
  for (const entry of entries) entry.name = pathToFileURL(result.exports[entry.name]).href;
  await writeFile(join(directory, 'cordis.yml'), JSON.stringify(entries, null, 2));
  await ctx.plugin(Loader, { baseUrl: pathToFileURL(join(directory, 'cordis.yml')).href });
  ctx.loader.builtins.include = Include;
  await ctx.plugin(LocalSubprocess);
  await ctx.plugin(SystemPrompt);
  await ctx.plugin(ToolRuntime);
  await ctx.loader.create({ id: 'probe-composition', name: 'cordis:include', config: { path: './cordis.yml' } });
  await ctx.loader.await();
  // Loader.await 本身会收集 settled 任务；仍需核对每一行确实激活，防止漏注入被吞掉。
  for (const entry of ctx.loader.entries()) {
    assert.equal(entry.fiber?.state, FiberState.ACTIVE, `composition row did not activate: ${entry.id}`);
  }
  const prompt = await ctx.systemPrompt.assemble();
  const signal = new AbortController().signal;
  const status = await ctx.tools.execute({ signal, callId: 'composition-status', name: 'computer_status', arguments: {} });
  const denied = await ctx.tools.execute({ signal, callId: 'composition-control', name: 'computer_type', arguments: { text: 'probe' } });
  assert.equal(status.isError, false, status.error?.message);
  assert.equal(denied.isError, true);
  assert.equal(denied.error?.message, 'dsh-computer-use configuration denies desktop control');
  result.capabilities = ctx.get('computer').capabilities;
  result.tools = ctx.tools.schemas().map(schema => schema.name).filter(name => name.startsWith('computer_')).sort();
  result.workflowPrompt = prompt.sections.some(section => section.name === 'dsh-computer-use-workflow');
  result.observationAllowed = !status.isError;
  result.controlDenied = denied.error.message;
  assert.equal(result.capabilities.platform, process.platform);
  assert.deepEqual(result.tools, toolNames);
  assert.equal(result.workflowPrompt, true);
  if (process.platform === 'win32') {
    assert.equal(result.capabilities.standardListView, true);
    assert.equal(result.capabilities.relatedWindows, true);
  }
  for (const file of ['package.json', 'cordis.patch.yml', 'src/index.js', 'src/host.js', 'src/tool.js', 'src/prompt.js',
    'src/locator.js', 'src/windows-semantic-locator.cs', 'test/profile-runtime-probe.mjs']) {
    result.sources[file] = createHash('sha256').update(await readFile(join(projectRoot, file))).digest('hex');
  }
  completed = true;
} finally {
  try { await ctx.fiber.dispose(); }
  finally { sourceLoader.unregister(); await rm(directory, { recursive: true, force: true }); }
}
assert.equal(completed, true);
result.fullAcceptance = true;
await mkdir(join(projectRoot, '.local'), { recursive: true });
// 用实际 package 版本命名，不覆盖已交付版本的原始组合证据。
const packageVersion = JSON.parse(await readFile(join(projectRoot, 'package.json'), 'utf8')).version;
assert.match(packageVersion, /^\d+\.\d+\.\d+$/);
await writeFile(join(projectRoot, '.local', `composition-${packageVersion}-metrics.json`), JSON.stringify(result, null, 2));
console.log(JSON.stringify({ compositionAcceptance: result }, null, 2));
