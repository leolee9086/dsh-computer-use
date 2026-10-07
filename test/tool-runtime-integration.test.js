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
import { readFile, rm } from 'node:fs/promises';
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

  // 文件采集通过真实输出 schema，不加载附件或 llm，也不产生视觉证据。
  const fileCtx = new Context();
  try {
    let captures = 0;
    await fileCtx.plugin(SystemPrompt); await fileCtx.plugin(ToolRuntime);
    fileCtx.provide('computer', { capabilities: { screenshot: true }, screenshot: async () => {
      captures++; return { data: png, sourceBounds: { x: 0, y: 0, width: 1, height: 1 }, capturedAt: Date.now() };
    } });
    await fileCtx.plugin(toolPlugin('dsh-computer-use-file-probe', allowConfig));
    const agent = { options: {}, session: {} };
    const execute = (name, args) => fileCtx.tools.execute({ signal: new AbortController().signal, callId: ToolCallId('file-' + name), name, arguments: args, agent });
    const missingPath = await execute('computer_screenshot', { output: 'file' });
    assert.equal(missingPath.isError, true); assert.equal(captures, 0);
    const file = await execute('computer_screenshot', { output: 'file', save_to: home + '-capture.png' });
    assert.equal(file.isError, false, JSON.stringify(file)); assert.equal(file.content.length, 1);
    assert.equal(file.content[0].type, 'text'); assert.equal(file.value.image, undefined);
    assert.equal(file.value.file.width, 1); assert.deepEqual(await readFile(file.value.file.path), Buffer.from(png));
    const coordinates = await execute('computer_click', { screenshot_id: file.value.screenshot_id, x: 0, y: 0 });
    assert.match(coordinates.error?.message ?? '', /unavailable in this session/);
    assert.equal((await execute('computer_screenshot', {})).isError, true, 'default image delivery requires attachments');
    assert.equal(captures, 1);
    fileCtx.provide('attachments', { saveImage: () => { throw new Error('image route should fail before delivery'); } });
    fileCtx.provide('llm', { resolveModelInfo: async () => ({ inputModalities: ['text'] }) });
    agent.options = { provider: 'fixture', model: 'text' };
    const noVision = await execute('computer_screenshot', {});
    assert.match(noVision.error?.message ?? '', /does not declare image input/); assert.equal(captures, 1);
    await rm(file.value.file.path);
  } finally { await fileCtx.fiber.dispose(); }

  const denyCtx = new Context();
  try {
    await denyCtx.plugin(SystemPrompt);
    await denyCtx.plugin(ToolRuntime);
    denyCtx.provide('computer', { capabilities: {}, narratorStatus: async () => ({ running: false }) });
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
    const narratorStatus = await denyCtx.tools.execute({ signal: new AbortController().signal, callId: ToolCallId('narrator-observe'), name: 'computer_narrator', arguments: { operation: 'status' } });
    assert.equal(narratorStatus.isError, false, JSON.stringify(narratorStatus));
    const narratorDenied = await denyCtx.tools.execute({ signal: new AbortController().signal, callId: ToolCallId('narrator-denied'), name: 'computer_narrator', arguments: { operation: 'command', command: 'next_item' } });
    assert.match(narratorDenied.error?.message ?? '', /denies desktop control/);
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

  // 服务契约 fixture 配合真正的 ToolRuntime 验证证据与状态边界；不把它当作语音实测。
  const readerCtx = new Context();
  try {
    let running = false;
    let failNext = false;
    const inputs = [];
    await readerCtx.plugin(SystemPrompt);
    await readerCtx.plugin(ToolRuntime);
    readerCtx.provide('computer', {
      capabilities: { narrator: true },
      narratorStatus: async () => ({ running, virtualCursorObserved: false, speechCaptured: false }),
      listWindows: async () => [{id: 'reader-window', processId: 78, title: 'Reader fixture', bounds: {x: 0, y: 0, width: 100, height: 100}}],
      perform: async action => {
        inputs.push(action);
        if (failNext) { failNext = false; throw new Error('provider failed after an input side effect'); }
      },
    });
    await readerCtx.plugin(toolPlugin('dsh-computer-use-reader-probe', allowConfig));
    const readerAgent = { options: {}, session: {} };
    let call = 0;
    const execute = (name, args, agent = readerAgent) => readerCtx.tools.execute({ signal: new AbortController().signal, callId: ToolCallId('reader-' + (++call)), name, arguments: args, agent });
    const listed = await execute('computer_windows', {operation: 'list'});
    assert.equal(listed.isError, false, JSON.stringify(listed));
    const windowId = JSON.parse(listed.value).windows[0].id;
    const command = {operation: 'command', command: 'next_item', window_id: windowId};
    const stopped = await execute('computer_narrator', command);
    assert.match(stopped.error?.message ?? '', /not running/);
    assert.equal(inputs.length, 0);
    running = true;
    const otherSession = await execute('computer_narrator', command, { options: {}, session: {} });
    assert.equal(otherSession.isError, true);
    assert.equal(inputs.length, 0);
    const sent = await execute('computer_narrator', command);
    assert.equal(sent.isError, false, JSON.stringify(sent));
    assert.equal(JSON.parse(sent.value).resultVerified, false);
    assert.equal(inputs[0].key, 'right');
    assert.deepEqual(inputs[0].modifiers, ['insert']);
    assert.deepEqual(inputs[0].focus, {handle: 'reader-window', processId: 78, title: 'Reader fixture'});
    assert.equal((await execute('computer_narrator', command)).isError, false, 'window identity remains reusable after a command');
    assert.equal(inputs.length, 2);
    const freshList = await execute('computer_windows', {operation: 'list'});
    const freshId = JSON.parse(freshList.value).windows[0].id;
    failNext = true;
    const failed = await execute('computer_type', {window_id: freshId, text: 'partial input'});
    assert.match(failed.error?.message ?? '', /side effect/);
    const retry = await execute('computer_key', {window_id: freshId, key: 'enter'});
    assert.equal(retry.isError, false, 'unknown action state does not invalidate independently checked window identity');
    assert.equal(inputs.length, 4);
  } finally { await readerCtx.fiber.dispose(); }

  const semanticCtx = new Context();
  try {
    let failureState; let actionCalls = 0; const requests = [];
    await semanticCtx.plugin(SystemPrompt); await semanticCtx.plugin(ToolRuntime);
    const row = id => ({ element_id: 'element-' + id, name: 'Container ' + id, enabled: true, offscreen: true,
      patterns: ['invoke', 'item_container'], backend: 'uia', native_token: 'token-' + id, worker_generation: 'test-generation', children: [] });
    semanticCtx.provide('computer', {
      capabilities: { semanticPaging: true, semanticQuery: true },
      listWindows: async () => ['a', 'b'].map(id => ({ id, processId: 10, title: id })),
      accessibilitySnapshot: async (hwnd, _signal, options) => {
        requests.push(options);
        const tree = row(hwnd ?? 'a');
        Object.defineProperty(tree, 'acquisition', { value: { backend: 'uia', worker_generation: 'test-generation', next_cursor: 'cursor-' + requests.length,
          capture_restarts: options.cursor === undefined ? 1 : 0,
          coverage: { status: 'partial', reason: 'node_limit', max_depth: 6 }, window: { handle: hwnd ?? 'a', processId: 10, title: hwnd ?? 'a' } } });
        return tree;
      },
      performAccessibility: async action => {
        if (action.kind === 'read') return { value: 'readable' };
        actionCalls++;
        if (failureState) { const error = new Error('native failure'); error.executionState = failureState; throw error; }
        if (action.kind === 'find_item') return { found: true, element: { ...row('virtual'), patterns: ['invoke', 'virtualized_item'] } };
        return { ok: true };
      },
      perform: async () => {},
    });
    await semanticCtx.plugin(toolPlugin('dsh-computer-use-semantic-probe', allowConfig));
    const agent = { options: {}, session: {} }; let calls = 0;
    const execute = (name, args, currentAgent = agent) => semanticCtx.tools.execute({ signal: new AbortController().signal, callId: ToolCallId('semantic-' + ++calls), name, arguments: args, agent: currentAgent });
    const json = async (name, args) => { const result = await execute(name, args); assert.equal(result.isError, false, JSON.stringify(result)); return JSON.parse(result.value); };
    const windows = (await json('computer_windows', { operation: 'list' })).windows;
    const a = await json('computer_accessibility', { window_id: windows[0].id });
    const b = await json('computer_accessibility', { window_id: windows[1].id });
    assert.equal(a.capture_restarts, 1, 'real ToolRuntime retains native capture recovery metadata');
    const command = { snapshot_id: a.snapshot_id, element_id: 'element-a', operation: 'invoke' };
    assert.equal((await execute('computer_element', { ...command, operation: 'set_value' })).isError, true);
    assert.equal(actionCalls, 0, 'unsupported operation fails before dispatch');
    failureState = 'not_started'; assert.equal((await execute('computer_element', command)).isError, true);
    assert.equal((await execute('computer_read', { snapshot_id: a.snapshot_id, element_id: 'element-a' })).isError, false);
    failureState = 'unknown'; assert.equal((await execute('computer_element', command)).isError, true);
    assert.equal((await execute('computer_read', { snapshot_id: a.snapshot_id, element_id: 'element-a' })).isError, true);
    assert.equal((await execute('computer_read', { snapshot_id: b.snapshot_id, element_id: 'element-b' })).isError, false, 'window B retains independent state');
    assert.equal((await execute('computer_type', { window_id: windows[0].id, text: 'current identity' })).isError, false);
    failureState = undefined;
    const found = await json('computer_find', { source: 'native', window_id: windows[0].id, name: 'task target' });
    const parameters = { source: 'native', snapshot_id: found.snapshot_id, cursor: found.next_cursor };
    const changed = await execute('computer_find', { ...parameters, name: 'different target' });
    assert.match(changed.error?.message ?? '', /query changed/);
    assert.equal((await execute('computer_find', { ...parameters, backend: 'msaa' })).isError, true);
    assert.equal((await execute('computer_find', { ...parameters, scope: 'children' })).isError, true);
    assert.equal((await execute('computer_find', { ...parameters, max_depth: 1 })).isError, true);
    assert.equal((await execute('computer_find', parameters, { options: {}, session: {} })).isError, true);
    const continued = await json('computer_find', parameters);
    assert.equal(continued.matches.length, 1); assert.equal(requests.at(-1).query.name, 'task target');
    assert.equal(continued.capture_restarts, 0, 'continuation metadata does not invent a fresh recovery');
    const item = await json('computer_element', { snapshot_id: continued.snapshot_id, element_id: 'element-a', operation: 'find_item', value: 'virtual target' });
    assert.equal(item.found, true); assert.equal(item.element.element_id, 'element-virtual');
    assert.equal(item.screenshot_id, undefined);
    assert.equal((await execute('computer_read', { snapshot_id: item.snapshot_id, element_id: item.element.element_id })).isError, false);
    assert.equal((await execute('computer_element', { snapshot_id: item.snapshot_id, element_id: item.element.element_id, operation: 'realize' })).isError, false);
  } finally { await semanticCtx.fiber.dispose(); }

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
