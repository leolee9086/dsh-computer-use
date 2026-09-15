import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const harnessRoot = process.env.DSH_HARNESS_ROOT
  ? resolve(process.env.DSH_HARNESS_ROOT)
  : resolve(projectRoot, '..', 'deepseek-harness');

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

test('computer tools use real DSH ToolRuntime, approval guards, and Full access presets', { timeout: 120_000 }, async () => {
  assert.equal(existsSync(join(harnessRoot, 'package.json')), true, `DSH_HARNESS_ROOT must name a DeepSeek Harness checkout: ${harnessRoot}`);
  const directory = await mkdtemp(join(tmpdir(), 'dsh-computer-use-tool-runtime-'));
  const home = join(directory, 'home');
  const probePath = join(directory, 'tool-runtime-probe.ts');
  const toolUrl = pathToFileURL(join(projectRoot, 'src', 'tool.js')).href;
  try {
    await writeFile(probePath, `
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { Context } from '@deepseek-ai/cordis';
import LocalAttachmentStore from '@deepseek-ai/dsh-attachment-local';
import { ToolCallId } from '@deepseek-ai/dsh-llm';
import PermissionPresetService from '@deepseek-ai/dsh-permission-presets';
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session';
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import ToolRuntime from '@deepseek-ai/dsh-tools';
import { apply as applyTools } from ${JSON.stringify(toolUrl)};

const home = ${JSON.stringify(home)};
const png = Uint8Array.from(Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWNgZGIGAAAOAAeCcsnOAAAAAElFTkSuQmCC',
  'base64',
));

function toolPlugin(name, config) {
  return {
    name,
    inject: ['tools', 'computer'],
    apply(ctx) {
      applyTools(ctx, config);
    },
  };
}

const allowConfig = {
  observeApproval: 'allow',
  controlApproval: 'allow',
  maxObservationAgeMs: 120_000,
  maxObservationsPerAgent: 8,
  maxSemanticSnapshots: 8,
  maxSemanticMatches: 20,
};
const askConfig = { ...allowConfig, observeApproval: 'ask', controlApproval: 'ask' };

async function main() {
  const imageCtx = new Context();
  try {
    await imageCtx.plugin(SystemPrompt);
    await imageCtx.plugin(ToolRuntime);
    await imageCtx.plugin(LocalAttachmentStore, { dshHome: home });
    imageCtx.provide('computer', {
      capabilities: { screenshot: true },
      screenshot: async () => ({
        data: png,
        sourceBounds: { x: 0, y: 0, width: 1, height: 1 },
        capturedAt: 123,
      }),
    });
    imageCtx.provide('llm', {
      resolveModelInfo: async () => ({ inputModalities: ['image'] }),
    });
    await imageCtx.plugin(toolPlugin('dsh-computer-use-image-probe', allowConfig));
    const result = await imageCtx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('computer-image'),
      name: 'computer_screenshot',
      arguments: {},
      agent: {
        options: { provider: 'fixture', model: 'vision' },
        session: { requestHeader: () => undefined },
      },
    });
    assert.equal(result.isError, false, JSON.stringify(result));
    assert.equal(result.content.length, 2);
    assert.equal(result.content[0]?.type, 'text');
    assert.match(result.content[0]?.text ?? '', /<computer-screenshot id=/);
    assert.equal(result.content[1]?.type, 'image');
    const attachment = result.content[1]?.attachment;
    assert.ok(attachment);
    assert.equal(attachment.mediaType, 'image/png');
    assert.equal(attachment.width, 1);
    assert.equal(attachment.height, 1);
    assert.equal(attachment.name, 'desktop-screenshot.png');
    assert.match(attachment.attachmentId, /^sha256:[0-9a-f]{64}$/);
    const stored = await imageCtx.attachments.readImage(attachment);
    assert.equal(stored.data.byteLength, attachment.bytes);
    assert.equal(createHash('sha256').update(stored.data).digest('hex'), result.value.content_hash);
  } finally {
    await imageCtx.fiber.dispose();
  }

  const denyCtx = new Context();
  try {
    await denyCtx.plugin(SystemPrompt);
    await denyCtx.plugin(ToolRuntime);
    denyCtx.provide('computer', { capabilities: {} });
    denyCtx.on('tools/pre-execute', (exec, next) => (
      exec.name === 'computer_type' ? Promise.resolve({ kind: 'allow' }) : next()
    ), { prepend: true });
    await denyCtx.plugin(toolPlugin('dsh-computer-use-deny-probe', {
      ...allowConfig,
      controlApproval: 'deny',
    }));
    const denied = await denyCtx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('computer-deny'),
      name: 'computer_type',
      arguments: { text: 'unreachable' },
    });
    assert.equal(denied.isError, true);
    assert.equal(denied.error?.message, 'dsh-computer-use configuration denies desktop control');
  } finally {
    await denyCtx.fiber.dispose();
  }

  const askCtx = new Context();
  try {
    let listCalls = 0;
    let approvalCalls = 0;
    await askCtx.plugin(SystemPrompt);
    await askCtx.plugin(ToolRuntime);
    askCtx.provide('computer', {
      capabilities: {},
      listWindows: async () => { listCalls += 1; return []; },
    });
    askCtx.provide('approval', {
      request: async () => { approvalCalls += 1; return 'rejected'; },
    });
    askCtx.on('tools/pre-execute', (exec, next) => (
      exec.name.startsWith('computer_') ? Promise.resolve({ kind: 'allow' }) : next()
    ), { prepend: true });
    await askCtx.plugin(toolPlugin('dsh-computer-use-ask-probe', askConfig));
    const asked = await askCtx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('computer-ask-list'),
      name: 'computer_windows',
      arguments: { operation: 'list' },
      agent: {
        options: { provider: 'fixture', model: 'vision' },
        session: { requestHeader: () => undefined },
      },
    });
    assert.equal(asked.isError, true);
    assert.match(asked.error?.message ?? '', /the user rejected tool/);
    assert.equal(approvalCalls, 1);
    assert.equal(listCalls, 0);
  } finally {
    await askCtx.fiber.dispose();
  }

  const fullAccessCtx = new Context();
  try {
    let listCalls = 0;
    let focusCalls = 0;
    let approvalCalls = 0;
    await fullAccessCtx.plugin(SystemPrompt);
    await fullAccessCtx.plugin(ToolRuntime);
    await fullAccessCtx.plugin(SessionStore);
    await fullAccessCtx.plugin(SessionProjectionRegistry);
    fullAccessCtx.provide('shell', {
      sandboxMode: 'danger-full-access',
      resolve() { throw new Error('Full access probe does not run shell commands'); },
      run() { throw new Error('Full access probe does not run shell commands'); },
      start() { throw new Error('Full access probe does not run shell commands'); },
    });
    fullAccessCtx.provide('approval', {
      config: { policy: 'never' },
      request: async () => { approvalCalls += 1; return 'rejected'; },
    });
    fullAccessCtx.provide('computer', {
      capabilities: {},
      listWindows: async () => {
        listCalls += 1;
        return [{
          id: 'native-window-1',
          title: 'Full access test',
          processId: 77,
          bounds: { x: 0, y: 0, width: 100, height: 100 },
          focused: true,
        }];
      },
      focusWindow: async (window) => {
        focusCalls += 1;
        assert.equal(window.id, 'native-window-1');
      },
    });
    await fullAccessCtx.plugin(PermissionPresetService, {});
    const session = fullAccessCtx.sessions.create(SessionId('computer-full-access-probe'));
    assert.equal(fullAccessCtx.permissionPresets.current(session), 'danger-full-access');
    const agent = {
      options: { provider: 'fixture', model: 'vision' },
      session,
    };
    await fullAccessCtx.plugin(toolPlugin('dsh-computer-use-full-access-probe', askConfig));
    const listed = await fullAccessCtx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('computer-full-access-list'),
      name: 'computer_windows',
      arguments: { operation: 'list' },
      agent,
    });
    assert.equal(listed.isError, false, JSON.stringify(listed));
    const windows = JSON.parse(listed.value);
    const focused = await fullAccessCtx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('computer-full-access-focus'),
      name: 'computer_windows',
      arguments: { operation: 'focus', window_id: windows.windows[0].id },
      agent,
    });
    assert.equal(focused.isError, false, JSON.stringify(focused));
    assert.equal(listCalls, 1);
    assert.equal(focusCalls, 1);
    assert.equal(approvalCalls, 0);
  } finally {
    await fullAccessCtx.fiber.dispose();
  }

  process.stdout.write('DshComputerUseToolRuntimeProbe:' + JSON.stringify({ image: 'ok', fullAccess: 'ok' }) + '\\n');
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
`, 'utf8');
    const result = await run('pnpm', ['exec', 'tsx', probePath], harnessRoot, process.env);
    const marker = /DshComputerUseToolRuntimeProbe:(\{[^\r\n]+\})/.exec(`${result.stdout}\n${result.stderr}`)?.[1];
    assert.notEqual(marker, undefined, `tool runtime probe did not emit its result\n${result.stdout}\n${result.stderr}`);
    assert.deepEqual(JSON.parse(marker), { image: 'ok', fullAccess: 'ok' });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
