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
  });
  assert.equal(result, 'disposed');
  assert.equal(published.name, 'computer');
  assert.equal(typeof published.value.screenshot, 'function');
  assert.equal(published.value.capabilities.platform, process.platform);
});

test('tool plugin registers the complete model-facing tool set', () => {
  const tools = [];
  const listeners = [];
  const context = {
    tools: { register(definition) { tools.push(definition); return () => {}; } },
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
    'computer_drag',
    'computer_key',
    'computer_screenshot',
    'computer_scroll',
    'computer_status',
    'computer_type',
    'computer_windows',
  ]);
  assert.equal(listeners.length, 1);
  assert.equal(listeners[0].name, 'tools/pre-execute');
});
