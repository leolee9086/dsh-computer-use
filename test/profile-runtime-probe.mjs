import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const harnessRoot = process.env.DSH_HARNESS_ROOT
  ? resolve(process.env.DSH_HARNESS_ROOT)
  : resolve(projectRoot, '..', 'deepseek-harness');

if (!existsSync(join(harnessRoot, 'package.json'))) {
  throw new Error(`DSH_HARNESS_ROOT must name a DeepSeek Harness checkout; looked for ${join(harnessRoot, 'package.json')}`);
}

function run(command, args, cwd, env) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      cwd,
      env,
      shell: process.platform === 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', rejectRun);
    child.once('close', (code) => {
      if (code === 0) resolveRun({ stdout, stderr });
      else rejectRun(new Error(`${command} ${args.join(' ')} exited ${code}\n${stdout}\n${stderr}`));
    });
  });
}

const toolNames = [
  'computer_accessibility',
  'computer_click',
  'computer_drag',
  'computer_element',
  'computer_find',
  'computer_key',
  'computer_screenshot',
  'computer_scroll',
  'computer_status',
  'computer_type',
  'computer_windows',
];

const toolConfig = {
  observeApproval: 'allow',
  controlApproval: 'deny',
  maxObservationAgeMs: 120_000,
  maxObservationsPerAgent: 8,
  maxSemanticSnapshots: 8,
  maxSemanticMatches: 20,
};

const directory = await mkdtemp(join(tmpdir(), 'dsh-computer-use-profile-'));
const dshHome = join(directory, 'home');
const probePath = join(directory, 'profile-probe.mjs');
const patchPath = join(directory, 'profile-probe.patch.yml');
const profile = `computer-use-${basename(directory).replace(/[^a-z0-9]/gi, '').toLowerCase()}`;
const env = { ...process.env, DSH_HOME: dshHome };

try {
  await writeFile(probePath, `
export const name = 'dsh-computer-use-profile-probe';
export const inject = ['loader', 'tools', 'systemPrompt', 'computer'];

export function apply(ctx) {
  void ctx.loader.await().then(async () => {
    const prompt = await ctx.systemPrompt.assemble();
    const signal = new AbortController().signal;
    const status = await ctx.tools.execute({
      signal, callId: 'computer-use-profile-status', name: 'computer_status', arguments: {},
    });
    const denied = await ctx.tools.execute({
      signal, callId: 'computer-use-profile-control', name: 'computer_type', arguments: { text: 'probe' },
    });
    if (status.isError) throw new Error('computer_status was not allowed by the overlay: ' + status.error?.message);
    if (!denied.isError || denied.error?.message !== 'dsh-computer-use configuration denies desktop control') {
      throw new Error('computer_type did not honor the overlay control deny policy');
    }
    process.stdout.write('DshComputerUseProfileProbe:' + JSON.stringify({
      capabilities: ctx.get('computer')?.capabilities,
      tools: ctx.tools.schemas().map((schema) => schema.name).filter((name) => name.startsWith('computer_')).sort(),
      workflowPrompt: prompt.sections.some((section) => section.name === 'dsh-computer-use-workflow'),
      observationAllowed: !status.isError,
      controlDenied: denied.error?.message,
    }) + '\\n');
    ctx.get('appExit')?.(0);
  }).catch((error) => {
    process.stderr.write('DshComputerUseProfileProbeError:' + (error instanceof Error ? error.stack ?? error.message : String(error)) + '\\n');
    ctx.get('appExit')?.(1);
  });
}
`, 'utf8');
  await writeFile(patchPath, `- id: dsh-computer-use-tool
  config:
    observeApproval: ${toolConfig.observeApproval}
    controlApproval: ${toolConfig.controlApproval}
    maxObservationAgeMs: ${toolConfig.maxObservationAgeMs}
    maxObservationsPerAgent: ${toolConfig.maxObservationsPerAgent}
    maxSemanticSnapshots: ${toolConfig.maxSemanticSnapshots}
    maxSemanticMatches: ${toolConfig.maxSemanticMatches}
- insert:
    - id: dsh-computer-use-profile-probe
      name: ${JSON.stringify(pathToFileURL(probePath).href)}
`, 'utf8');

  await run('pnpm', ['dsh', 'plugin', '--profile', profile, 'add', projectRoot], harnessRoot, env);
  const result = await run('pnpm', ['dsh', '--profile', profile, '--patch', patchPath], harnessRoot, env);
  const marker = /DshComputerUseProfileProbe:(\{[^\r\n]+\})/.exec(`${result.stdout}\n${result.stderr}`)?.[1];
  assert.notEqual(marker, undefined, `profile probe did not emit its result\n${result.stdout}\n${result.stderr}`);
  const probe = JSON.parse(marker);
  assert.equal(probe.capabilities.platform, process.platform);
  assert.deepEqual(probe.tools, toolNames);
  assert.equal(probe.workflowPrompt, true);
  assert.equal(probe.observationAllowed, true);
  assert.equal(probe.controlDenied, 'dsh-computer-use configuration denies desktop control');
  console.log(JSON.stringify({ profile, ...probe }, null, 2));
} finally {
  await rm(directory, { recursive: true, force: true });
}
