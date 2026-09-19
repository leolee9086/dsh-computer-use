import assert from 'node:assert/strict';
import test from 'node:test';
import { apply as applyHost } from '../src/host.js';
import { apply as applyTools } from '../src/tool.js';

test('host plugin publishes a single computer provider', () => {
  let published;
  const result = applyHost({
    subprocess: {},
    provide(name, value) {
      published = { name, value };
      return 'disposed';
    },
  }, {
    screenshotMaxDimension: 1920,
    screenshotMaxBytes: 12_000_000,
    commandTimeoutMs: 30_000,
    graceMs: 2_000,
    actionDelayMs: 40,
    maxAccessibilityNodes: 300,
    maxAccessibilityDepth: 6,
    maxAccessibilityBytes: 1_000_000,
    maxAccessibilityActionCandidates: 5_000,
  });
  assert.equal(result, 'disposed');
  assert.equal(published.name, 'computer');
  assert.equal(typeof published.value.screenshot, 'function');
  assert.equal(published.value.capabilities.platform, process.platform);
});

test('tool plugin registers the complete model-facing tool set', () => {
  const tools = [];
  const listeners = [];
  const guards = [];
  const context = {
    tools: {
      register(definition) { tools.push(definition); return () => {}; },
      guard(guard) { guards.push(guard); return () => {}; },
    },
    on(name, listener) { listeners.push({ name, listener }); return () => {}; },
    inject(_names, callback) { callback(this); },
    attachments: { saveImage: async () => ({}) },
  };
  applyTools(context, {
    observeApproval: 'allow',
    controlApproval: 'allow',
    maxObservationAgeMs: 120_000,
    maxObservationsPerAgent: 8,
  });
  assert.deepEqual(tools.map((tool) => tool.name).sort(), [
    'computer_accessibility',
    'computer_click',
    'computer_click_image',
    'computer_drag',
    'computer_element',
    'computer_find',
    'computer_find_image',
    'computer_key',
    'computer_screenshot',
    'computer_scroll',
    'computer_status',
    'computer_type',
    'computer_windows',
  ]);
  assert.equal(listeners.length, 1);
  assert.equal(listeners[0].name, 'tools/pre-execute');
  assert.equal(guards.length, 1);
});

test('approval policy treats window listing as observation and focus as control', async () => {
  let listener;
  let guard;
  const context = {
    tools: {
      register() { return () => {}; },
      guard(callback) { guard = callback; return () => {}; },
    },
    on(name, callback) {
      if (name === 'tools/pre-execute') listener = callback;
      return () => {};
    },
    inject(_names, callback) { callback(this); },
    attachments: { saveImage: async () => ({}) },
  };
  applyTools(context, {
    observeApproval: 'ask',
    controlApproval: 'deny',
    maxObservationAgeMs: 120_000,
    maxObservationsPerAgent: 8,
  });
  assert.equal(typeof listener, 'function');
  assert.equal(typeof guard, 'function');
  const next = async () => ({ kind: 'allow' });
  assert.deepEqual(await listener({ name: 'computer_windows', arguments: { operation: 'list' } }, next), {
    kind: 'ask', reason: 'Allow desktop observation?',
  });
  assert.deepEqual(await listener({ name: 'computer_windows', arguments: { operation: 'focus' } }, next), {
    kind: 'deny', reason: 'dsh-computer-use configuration denies desktop control',
  });
  assert.equal(guard({ name: 'computer_windows', arguments: { operation: 'list' } }), undefined);
  assert.equal(guard({ name: 'computer_windows', arguments: { operation: 'focus' } }), 'dsh-computer-use configuration denies desktop control');
  let delegated = false;
  const downstreamAsk = async () => {
    delegated = true;
    return { kind: 'ask', reason: 'downstream policy' };
  };
  assert.deepEqual(await listener({ name: 'computer_type', arguments: {} }, downstreamAsk), {
    kind: 'deny', reason: 'dsh-computer-use configuration denies desktop control',
  });
  assert.equal(delegated, false);
  assert.deepEqual(await listener({ name: 'computer_click', arguments: {} }, next), {
    kind: 'deny', reason: 'dsh-computer-use configuration denies desktop control',
  });
});

test('Full access permission preset automatically allows default computer asks', async () => {
  let listener;
  let guard;
  const session = {};
  const context = {
    get(name) {
      if (name !== 'permissionPresets') return undefined;
      return {
        current(received) {
          assert.equal(received, session);
          return 'danger-full-access';
        },
        resolve(name) {
          assert.equal(name, 'danger-full-access');
          return { sandbox: 'danger-full-access', approval: 'never' };
        },
      };
    },
    tools: {
      register() { return () => {}; },
      guard(callback) { guard = callback; return () => {}; },
    },
    on(name, callback) {
      if (name === 'tools/pre-execute') listener = callback;
      return () => {};
    },
    inject(_names, callback) { callback(this); },
    attachments: { saveImage: async () => ({}) },
  };
  applyTools(context, {
    observeApproval: 'ask',
    controlApproval: 'ask',
    maxObservationAgeMs: 120_000,
    maxObservationsPerAgent: 8,
  });
  const agent = { session };
  const next = async () => ({ kind: 'allow' });
  assert.deepEqual(await listener({ name: 'computer_status', arguments: {}, agent }, next), { kind: 'allow' });
  assert.deepEqual(await listener({ name: 'computer_type', arguments: { text: 'safe' }, agent }, next), { kind: 'allow' });
  assert.equal(guard({ name: 'computer_status', arguments: {}, agent }), undefined);
  assert.equal(guard({ name: 'computer_type', arguments: { text: 'safe' }, agent }), undefined);
});

test('Full access does not override an explicit computer control deny', async () => {
  let listener;
  const context = {
    get() {
      return {
        current() { return 'danger-full-access'; },
        resolve() { return { sandbox: 'danger-full-access', approval: 'never' }; },
      };
    },
    tools: {
      register() { return () => {}; },
      guard() { return () => {}; },
    },
    on(name, callback) {
      if (name === 'tools/pre-execute') listener = callback;
      return () => {};
    },
    inject(_names, callback) { callback(this); },
    attachments: { saveImage: async () => ({}) },
  };
  applyTools(context, {
    observeApproval: 'ask',
    controlApproval: 'deny',
    maxObservationAgeMs: 120_000,
    maxObservationsPerAgent: 8,
  });
  const result = await listener({
    name: 'computer_type',
    arguments: { text: 'blocked' },
    agent: { session: {} },
  }, async () => ({ kind: 'allow' }));
  assert.deepEqual(result, { kind: 'deny', reason: 'dsh-computer-use configuration denies desktop control' });
});

// 指名窗口的截图会先把该窗口提到前台，所以它必须按控制类审批 ——
// 否则"观测"这一档就成了绕过控制策略的后门。
test('a window-targeted screenshot is classified as desktop control', async () => {
  let listener;
  const context = {
    get() { return undefined; },
    tools: {
      register() { return () => {}; },
      guard() { return () => {}; },
    },
    on(name, callback) {
      if (name === 'tools/pre-execute') listener = callback;
      return () => {};
    },
    inject(_names, callback) { callback(this); },
    attachments: { saveImage: async () => ({}) },
  };
  applyTools(context, {
    observeApproval: 'allow',
    controlApproval: 'deny',
    maxObservationAgeMs: 120_000,
    maxObservationsPerAgent: 8,
  });
  const next = async () => ({ kind: 'allow' });
  const agent = { session: {} };
  assert.deepEqual(
    await listener({ name: 'computer_screenshot', arguments: {}, agent }, next),
    { kind: 'allow' },
  );
  assert.deepEqual(
    await listener({ name: 'computer_screenshot', arguments: { window_id: 'window-1' }, agent }, next),
    { kind: 'deny', reason: 'dsh-computer-use configuration denies desktop control' },
  );
});
