import assert from 'node:assert/strict';
import test from 'node:test';
import { pngDimensions } from '../src/geometry.js';
import { mapScreenshotPoint } from '../src/tool.js';

test('pngDimensions reads IHDR width and height', () => {
  const data = new Uint8Array(24);
  data.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  new DataView(data.buffer).setUint32(16, 1234);
  new DataView(data.buffer).setUint32(20, 567);
  assert.deepEqual(pngDimensions(data), { width: 1234, height: 567 });
});

test('mapScreenshotPoint reverses attachment downscaling and origin offset', () => {
  const point = mapScreenshotPoint({
    image: { width: 1000, height: 500 },
    sourceBounds: { x: -1920, y: 1080, width: 2000, height: 1000 },
  }, 500, 250);
  assert.deepEqual(point, { x: -920, y: 1580 });
});

test('mapScreenshotPoint clamps in-range fractional pixels to native bounds', () => {
  const point = mapScreenshotPoint({
    image: { width: 100, height: 50 },
    sourceBounds: { x: 10, y: 20, width: 100, height: 50 },
  }, 99.9, 49.9);
  assert.deepEqual(point, { x: 109, y: 69 });
});

test('mapScreenshotPoint rejects coordinates outside the attached image', () => {
  assert.throws(() => mapScreenshotPoint({
    image: { width: 100, height: 100 },
    sourceBounds: { x: 0, y: 0, width: 100, height: 100 },
  }, 100, 20), /outside screenshot/);
});
