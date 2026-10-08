import assert from 'node:assert/strict';
import test from 'node:test';
import { imageSearchOptions, validateImageResult, imageClickPoint } from '../src/image-match.js';

function result(count = 1, partial = false) {
  const matches = Array.from({ length: Math.min(count, 8) }, (_, index) => ({ x: -100 + index * 24, y: 40, score: 1 }));
  return { coverage: partial ? 'partial' : 'complete', status: partial ? 'incomplete' : count ? 'found' : 'not_found',
    found: count > 0, matchCount: count, matches, clusterRule: 'row_major_fixed_anchor_half_template',
    scale: 1, searched: { x: -100, y: 40, width: 240, height: 80 }, templateWidth: 20, templateHeight: 20,
    visitedPositions: partial ? 221 : 13481, totalPositions: 13481, elapsedMs: 15,
    ...(partial ? { stopReason: 'position_limit' } : {}),
    ...(count ? { x: matches[0].x, y: matches[0].y, score: 1 } : { score: 0 }),
    ...(count > 1 ? { runnerUp: 1 } : {}),
  };
}

test('image budgets are integers and grayscale tolerance rejects fractional native u8 values', () => {
  assert.deepEqual(imageSearchOptions({}), { threshold: 0.9, tolerance: 12, budgetMs: 5000, maxPositions: 20000000 });
  assert.equal(imageSearchOptions({}, 0.95).threshold, 0.95);
  for (const args of [{ tolerance: 0.5 }, { tolerance: 256 }, { timeout_ms: 0 }, { timeout_ms: 1.5 },
    { timeout_ms: 120001 }, { max_positions: 0 }, { max_positions: 100000001 }, { threshold: 0 }, { threshold: NaN }]) {
    assert.throws(() => imageSearchOptions(args), /must be/);
  }
});

test('complete unique match maps its center in negative virtual-desktop coordinates', () => {
  assert.deepEqual(imageClickPoint(result()), { x: -90, y: 50 });
});

test('partial zero or one known match never becomes absence or a clickable unique result', () => {
  for (const count of [0, 1]) {
    const data = result(count, true);
    assert.equal(validateImageResult(data), data);
    assert.equal(imageClickPoint(data), null);
    assert.throws(() => validateImageResult({ ...data, status: count ? 'found' : 'not_found' }), /partial status/);
  }
});

test('complete no-match and multiple matches send no click, with count independent of display limit', () => {
  assert.equal(imageClickPoint(result(0)), null);
  assert.equal(imageClickPoint(result(2)), null);
  const many = result(11);
  assert.equal(validateImageResult(many).matchCount, 11);
  assert.equal(many.matches.length, 8);
  assert.equal(imageClickPoint(many), null);
});

test('legacy candidate-only helper result is rejected before clicking', () => {
  const old = result(); delete old.coverage;
  assert.throws(() => imageClickPoint(old), /coverage is required/);
});

test('coverage must agree with examined top-left positions and stop reason', () => {
  for (const patch of [{ visitedPositions: 13480 }, { totalPositions: 13482 }, { stopReason: 'position_limit' },
    { coverage: 'partial', status: 'incomplete', stopReason: 'position_limit' }]) {
    assert.throws(() => validateImageResult({ ...result(), ...patch }), /invalid coverage/);
  }
});

test('missing candidate geometry and impossible count cannot reach coordinate injection', () => {
  for (const patch of [{ matches: [] }, { templateWidth: 0 }, { found: false }, { matchCount: 100001 },
    { matches: [{ x: 200, y: 40, score: 1 }] }, { x: undefined }, { scale: 4 }]) {
    assert.throws(() => imageClickPoint({ ...result(), ...patch }), /invalid coverage/);
  }
});

test('template larger than search region has a complete empty position set', () => {
  const oversized = { ...result(0), templateWidth: 241, visitedPositions: 0, totalPositions: 0 };
  assert.equal(validateImageResult(oversized), oversized);
  assert.equal(imageClickPoint(oversized), null);
});

test('a match below the requested threshold is a malformed native result', () => {
  assert.throws(() => imageClickPoint({ ...result(), score: 0.9, matches: [{ x: -100, y: 40, score: 0.9 }] }), /score/);
});
