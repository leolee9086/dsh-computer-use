import assert from 'node:assert/strict';
import test from 'node:test';
import { imageSearchOptions, validateImageResult, imageClickPoint } from '../src/image-match.js';

const partialOptions = imageSearchOptions({ max_positions: 221 });
function result(count = 1, partial = false, args = {}) {
  const options = imageSearchOptions(args);
  const templateWidth = Math.round(20 * options.templateScale), templateHeight = Math.round(20 * options.templateScale);
  const totalPositions = (240 - templateWidth + 1) * (80 - templateHeight + 1);
  const matches = Array.from({ length: Math.min(count, 8) }, (_, index) => ({ x: -100 + index * 24, y: 40, score: 1 }));
  return { coverage: partial ? 'partial' : 'complete', status: partial ? 'incomplete' : count ? 'found' : 'not_found',
    found: count > 0, matchCount: count, matches, clusterRule: 'row_major_fixed_anchor_half_template',
    scale: 1, searched: { x: -100, y: 40, width: 240, height: 80 }, templateWidth, templateHeight,
    sourceTemplateWidth: 20, sourceTemplateHeight: 20, colorMode: options.colorMode, maskMode: options.maskMode,
    alphaMin: options.alphaMin, templateScale: options.templateScale, resizeFilter: 'nearest',
    activePixelCount: templateWidth * templateHeight,
    visitedPositions: partial ? 221 : totalPositions, totalPositions, elapsedMs: 15,
    ...(partial ? { stopReason: 'position_limit' } : {}),
    ...(count ? { x: matches[0].x, y: matches[0].y, score: 1 } : { score: 0 }),
    ...(count > 1 ? { runnerUp: 1 } : {}),
  };
}

test('image defaults preserve gray/no-mask/scale-one and reject invalid native options', () => {
  assert.deepEqual(imageSearchOptions({}), { threshold: 0.9, tolerance: 12, colorMode: 'gray', maskMode: 'none', alphaMin: 1,
    templateScale: 1, budgetMs: 5000, maxPositions: 20000000 });
  assert.equal(imageSearchOptions({}, 0.95).threshold, 0.95);
  for (const args of [{ tolerance: 0.5 }, { tolerance: 256 }, { timeout_ms: 0 }, { timeout_ms: 1.5 },
    { timeout_ms: 120001 }, { max_positions: 0 }, { max_positions: 100000001 }, { threshold: 0 }, { threshold: NaN },
    { color_mode: 'rgba' }, { mask_mode: 'blend' }, { alpha_min: 0 }, { alpha_min: 256 }, { alpha_min: 1.5 },
    { template_scale: 0.099 }, { template_scale: 4.01 }, { template_scale: NaN }, { template_scale: Infinity }]) {
    assert.throws(() => imageSearchOptions(args), /must be/);
  }
});

test('complete unique match maps its center in negative virtual-desktop coordinates', () => {
  assert.deepEqual(imageClickPoint(result()), { x: -90, y: 50 });
});

test('partial zero or one known match never becomes absence or a clickable unique result', () => {
  for (const count of [0, 1]) {
    const data = result(count, true);
    assert.equal(validateImageResult(data, partialOptions), data);
    assert.equal(imageClickPoint(data, partialOptions), null);
    assert.throws(() => validateImageResult({ ...data, status: count ? 'found' : 'not_found' }, partialOptions), /partial status/);
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
  assert.throws(() => validateImageResult(result(1, true)), /position budget/);
  assert.throws(() => validateImageResult(result(), partialOptions), /position counts/);
});

test('missing candidate geometry and impossible count cannot reach coordinate injection', () => {
  for (const patch of [{ matches: [] }, { templateWidth: 0 }, { found: false }, { matchCount: 100001 },
    { matches: [{ x: 200, y: 40, score: 1 }] }, { x: undefined }, { scale: 4 }]) {
    assert.throws(() => imageClickPoint({ ...result(), ...patch }), /invalid coverage/);
  }
});

test('template larger than search region has a complete empty position set', () => {
  const oversized = { ...result(0), templateWidth: 241, sourceTemplateWidth: 241, activePixelCount: 4820, visitedPositions: 0, totalPositions: 0 };
  assert.equal(validateImageResult(oversized), oversized);
  assert.equal(imageClickPoint(oversized), null);
});

test('a match below the requested threshold is a malformed native result', () => {
  assert.throws(() => imageClickPoint({ ...result(), score: 0.9, matches: [{ x: -100, y: 40, score: 0.9 }] }), /score/);
});

test('native helper must confirm every requested mode and cannot silently downgrade', () => {
  const options = imageSearchOptions({ color_mode: 'rgb', mask_mode: 'alpha', alpha_min: 128, template_scale: 2 });
  const data = result(1, false, { color_mode: 'rgb', mask_mode: 'alpha', alpha_min: 128, template_scale: 2 });
  assert.equal(validateImageResult(data, options), data);
  for (const patch of [{ colorMode: 'gray' }, { maskMode: 'none' }, { alphaMin: 127 }, { templateScale: 1 }, { resizeFilter: 'bilinear' }]) {
    assert.throws(() => imageClickPoint({ ...data, ...patch }, options), /invalid coverage/);
  }
  const old = result(); delete old.colorMode;
  assert.throws(() => imageClickPoint(old), /requested colorMode/);
});

test('transformed template dimensions drive center and coverage; zero or inflated active counts are rejected', () => {
  const args = { color_mode: 'rgb', mask_mode: 'alpha', template_scale: 2 };
  const options = imageSearchOptions(args), data = { ...result(1, false, args), activePixelCount: 144 };
  assert.deepEqual(imageClickPoint(data, options), { x: -80, y: 60 });
  for (const patch of [{ templateWidth: 20 }, { sourceTemplateWidth: 0 }, { activePixelCount: 0 }, { activePixelCount: 1601 }]) {
    assert.throws(() => imageClickPoint({ ...data, ...patch }, options), /invalid coverage/);
  }
  assert.throws(() => imageClickPoint({ ...result(), activePixelCount: 399 }), /participating pixel count/);
});

test('RGB alpha scaled single candidate still needs complete coverage before clicking', () => {
  const args = { color_mode: 'rgb', mask_mode: 'alpha', alpha_min: 255, template_scale: 0.5, max_positions: 221 };
  const options = imageSearchOptions(args), data = { ...result(1, true, args), activePixelCount: 36 };
  assert.equal(validateImageResult(data, options), data);
  assert.equal(imageClickPoint(data, options), null);
});
