import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { apply as applyTools } from '../src/tool.js';

function pngBytes() {
  const data = Buffer.alloc(24);
  data.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  new DataView(data.buffer, data.byteOffset, data.byteLength).setUint32(16, 100);
  new DataView(data.buffer, data.byteOffset, data.byteLength).setUint32(20, 50);
  return data;
}

function normalizedPngBytes() {
  const data = pngBytes();
  new DataView(data.buffer, data.byteOffset, data.byteLength).setUint32(16, 50);
  new DataView(data.buffer, data.byteOffset, data.byteLength).setUint32(20, 25);
  return data;
}

function toolContext() {
  const tools = [];
  const semanticTree = {
    element_id: 'uia:42,2',
    role: 'Window',
    name: 'Example',
    enabled: true,
    offscreen: false,
    patterns: [],
    children: [{
      element_id: 'uia:42,9',
      role: 'Button',
      name: 'Save',
      automation_id: 'saveButton',
      process_id: 321,
      enabled: true,
      offscreen: false,
      patterns: ['invoke'],
      bounds: { x: 20, y: 20, width: 80, height: 24 },
      children: [],
    }, {
      element_id: 'uia:42,10',
      role: 'ListItem',
      name: 'Archived result',
      process_id: 321,
      enabled: true,
      offscreen: true,
      patterns: ['scroll_item'],
      children: [],
    }],
  };
  const calls = [];
  const computer = {
    capabilities: {},
    async screenshot() {
      return {
        data: pngBytes(),
        sourceBounds: { x: 0, y: 0, width: 100, height: 50 },
        capturedAt: Date.now(),
      };
    },
    async accessibilitySnapshot() { return semanticTree; },
    async perform(action) { calls.push(action); },
    async listWindows() { return [{ id: 'native-41', title: 'Example Window', processId: 99, bounds: { x: 0, y: 0, width: 100, height: 50 }, focused: true }]; },
    async focusWindow(target) { calls.push({ kind: 'focus_window', target }); },
    async performAccessibility(action) { calls.push(action); },
  };
  const ctx = {
    tools: {
      register(definition) { tools.push(definition); return () => {}; },
      guard() { return () => {}; },
    },
    attachments: {
      async saveImage() {
        return { attachmentId: 'image-1', mediaType: 'image/png', bytes: 24, width: 50, height: 25, originalDimensions: { width: 100, height: 50 } };
      },
      async readImage(ref) {
        return { ref, data: normalizedPngBytes() };
      },
    },
    on() { return () => {}; },
    inject(_names, callback) { callback(this); },
    get(name) {
      if (name === 'computer') return computer;
      if (name === 'llm') return { resolveModelInfo: async () => ({ inputModalities: ['image'] }) };
      return undefined;
    },
  };
  return { ctx, tools, calls };
}

const agent = {
  session: { requestHeader() { return { config: { provider: 'test', model: 'vision-test' } }; } },
  options: {},
};

function toolByName(tools, name) {
  const tool = tools.find((entry) => entry.name === name);
  assert.ok(tool, `missing ${name}`);
  return tool;
}

test('semantic tools bind element actions to fresh image and accessibility observations', async () => {
  const { ctx, tools, calls } = toolContext();
  applyTools(ctx, {
    observeApproval: 'allow',
    controlApproval: 'allow',
    maxObservationAgeMs: 120_000,
    maxObservationsPerAgent: 8,
    maxSemanticSnapshots: 8,
    maxSemanticMatches: 20,
  });
  const exec = { agent };
  const screenshot = await toolByName(tools, 'computer_screenshot').execute({}, exec);
  assert.equal(screenshot.image.width, 50);
  assert.equal(screenshot.image.height, 25);
  assert.equal(screenshot.content_hash, createHash('sha256').update(normalizedPngBytes()).digest('hex'));
  const rendered = toolByName(tools, 'computer_screenshot').output.render({}, screenshot);
  assert.equal(rendered[0].type, 'text');
  assert.equal(rendered[1].type, 'image');
  assert.equal(rendered[1].attachment.attachmentId, 'image-1');
  const accessibility = JSON.parse(await toolByName(tools, 'computer_accessibility').execute({ screenshot_id: screenshot.screenshot_id }, exec));
  assert.match(accessibility.snapshot_id, /^semantic-/);
  assert.equal(accessibility.screenshot_id, screenshot.screenshot_id);
  assert.equal(accessibility.screenshot_hash, screenshot.content_hash);
  const matches = JSON.parse(await toolByName(tools, 'computer_find').execute({
    snapshot_id: accessibility.snapshot_id,
    name: 'save',
    automation_id: '',
    match: 'contains',
  }, exec));
  assert.deepEqual(matches.matches.map((element) => element.element_id), ['uia:42,9']);
  const result = await toolByName(tools, 'computer_element').execute({
    screenshot_id: screenshot.screenshot_id,
    snapshot_id: accessibility.snapshot_id,
    element_id: 'uia:42,9',
    operation: 'invoke',
    value: '',
  }, exec);
  assert.match(result, /Performed invoke/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].kind, 'invoke');
  assert.equal(calls[0].elementId, 'uia:42,9');
  assert.equal(calls[0].element.process_id, 321);
  await assert.rejects(() => toolByName(tools, 'computer_element').execute({
    screenshot_id: screenshot.screenshot_id,
    snapshot_id: accessibility.snapshot_id,
    element_id: 'uia:42,9',
    operation: 'invoke',
  }, exec), /was consumed by a successful desktop action/);
  assert.equal(calls.length, 1);
});

test('control actions consume their screenshot evidence and window focus consumes all evidence', async () => {
  const { ctx, tools, calls } = toolContext();
  applyTools(ctx, {
    observeApproval: 'allow',
    controlApproval: 'allow',
    maxObservationAgeMs: 120_000,
    maxObservationsPerAgent: 8,
    maxSemanticSnapshots: 8,
    maxSemanticMatches: 20,
  });
  const exec = { agent };
  const first = await toolByName(tools, 'computer_screenshot').execute({}, exec);
  const concurrent = await toolByName(tools, 'computer_screenshot').execute({}, exec);
  await toolByName(tools, 'computer_click').execute({
    screenshot_id: first.screenshot_id,
    x: 20,
    y: 10,
  }, exec);
  await assert.rejects(() => toolByName(tools, 'computer_type').execute({
    screenshot_id: concurrent.screenshot_id,
    text: 'stale',
  }, exec), /was consumed by a successful desktop action/);
  await assert.rejects(() => toolByName(tools, 'computer_click').execute({
    screenshot_id: first.screenshot_id,
    x: 20,
    y: 10,
  }, exec), /was consumed by a successful desktop action/);
  const second = await toolByName(tools, 'computer_screenshot').execute({}, exec);
  const listed = JSON.parse(await toolByName(tools, 'computer_windows').execute({ operation: 'list' }, exec));
  assert.equal(listed.windows.length, 1);
  assert.match(listed.windows[0].id, /^window-/);
  assert.notEqual(listed.windows[0].id, 'native-41');
  assert.equal('processId' in listed.windows[0], true);
  await toolByName(tools, 'computer_windows').execute({ operation: 'focus', window_id: listed.windows[0].id }, exec);
  assert.equal(calls.find((call) => call.kind === 'focus_window').target.id, 'native-41');
  assert.equal(calls.find((call) => call.kind === 'focus_window').target.processId, 99);
  await assert.rejects(() => toolByName(tools, 'computer_windows').execute({ operation: 'focus', window_id: listed.windows[0].id }, exec), /was consumed by a successful desktop action/);
  await assert.rejects(() => toolByName(tools, 'computer_windows').execute({ operation: 'focus', window_id: 'native-41' }, exec), /is unavailable in this session/);
  await assert.rejects(() => toolByName(tools, 'computer_type').execute({
    screenshot_id: second.screenshot_id,
    text: 'stale',
  }, exec), /was consumed by a successful desktop action/);
  assert.deepEqual(calls.map((call) => call.kind), ['click', 'focus_window']);
});

test('semantic element action rejects a pattern unsupported by the observed element', async () => {
  const { ctx, tools } = toolContext();
  applyTools(ctx, {
    observeApproval: 'allow',
    controlApproval: 'allow',
    maxObservationAgeMs: 120_000,
    maxObservationsPerAgent: 8,
    maxSemanticSnapshots: 8,
    maxSemanticMatches: 20,
  });
  const exec = { agent };
  const screenshot = await toolByName(tools, 'computer_screenshot').execute({}, exec);
  const accessibility = JSON.parse(await toolByName(tools, 'computer_accessibility').execute({ screenshot_id: screenshot.screenshot_id }, exec));
  await assert.rejects(() => toolByName(tools, 'computer_element').execute({
    screenshot_id: screenshot.screenshot_id,
    snapshot_id: accessibility.snapshot_id,
    element_id: 'uia:42,9',
    operation: 'toggle',
  }, exec), /does not support toggle/);
});

test('semantic element action requires the screenshot bound to its snapshot', async () => {
  const { ctx, tools } = toolContext();
  applyTools(ctx, {
    observeApproval: 'allow',
    controlApproval: 'allow',
    maxObservationAgeMs: 120_000,
    maxObservationsPerAgent: 8,
    maxSemanticSnapshots: 8,
    maxSemanticMatches: 20,
  });
  const exec = { agent };
  const screenshot = await toolByName(tools, 'computer_screenshot').execute({}, exec);
  const accessibility = JSON.parse(await toolByName(tools, 'computer_accessibility').execute({ screenshot_id: screenshot.screenshot_id }, exec));
  const newerScreenshot = await toolByName(tools, 'computer_screenshot').execute({}, exec);
  await assert.rejects(() => toolByName(tools, 'computer_element').execute({
    screenshot_id: newerScreenshot.screenshot_id,
    snapshot_id: accessibility.snapshot_id,
    element_id: 'uia:42,9',
    operation: 'invoke',
  }, exec), /is not bound to screenshot/);
});

test('semantic element action permits scroll_into_view for an offscreen matching pattern', async () => {
  const { ctx, tools, calls } = toolContext();
  applyTools(ctx, {
    observeApproval: 'allow',
    controlApproval: 'allow',
    maxObservationAgeMs: 120_000,
    maxObservationsPerAgent: 8,
    maxSemanticSnapshots: 8,
    maxSemanticMatches: 20,
  });
  const exec = { agent };
  const screenshot = await toolByName(tools, 'computer_screenshot').execute({}, exec);
  const accessibility = JSON.parse(await toolByName(tools, 'computer_accessibility').execute({ screenshot_id: screenshot.screenshot_id }, exec));
  const result = await toolByName(tools, 'computer_element').execute({
    screenshot_id: screenshot.screenshot_id,
    snapshot_id: accessibility.snapshot_id,
    element_id: 'uia:42,10',
    operation: 'scroll_into_view',
  }, exec);
  assert.match(result, /Performed scroll_into_view/);
  assert.equal(calls[0].kind, 'scroll_into_view');
});
