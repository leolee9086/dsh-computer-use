import assert from 'node:assert/strict';
import test from 'node:test';
import { hostConfigDefaults, resolveHostConfig } from '../src/config.js';

test('host config has stable deployment defaults', () => {
  const config = resolveHostConfig();
  assert.equal(config.screenshotMaxDimension, hostConfigDefaults.screenshotMaxDimension);
  assert.equal(config.maxAccessibilityNodes, hostConfigDefaults.maxAccessibilityNodes);
  assert.equal(Object.isFrozen(config), true);
});

test('host config rejects unsafe numeric values', () => {
  assert.throws(() => resolveHostConfig({ screenshotMaxBytes: 0 }), /positive integer/);
  assert.throws(() => resolveHostConfig({ actionDelayMs: -1 }), /non-negative integer/);
});
