import { ComputerUseError } from './errors.js';

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export function pngDimensions(data) {
  if (!(data instanceof Uint8Array) || data.byteLength < 24) {
    throw new ComputerUseError('desktop capture did not produce a complete PNG');
  }
  for (let index = 0; index < PNG_SIGNATURE.length; index += 1) {
    if (data[index] !== PNG_SIGNATURE[index]) {
      throw new ComputerUseError('desktop capture did not produce a PNG');
    }
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  if (width < 1 || height < 1) {
    throw new ComputerUseError('desktop capture reported invalid PNG dimensions');
  }
  return { width, height };
}

export function assertFinitePoint(point, label) {
  if (point === null || typeof point !== 'object'
    || !Number.isFinite(point.x) || !Number.isFinite(point.y)) {
    throw new ComputerUseError(`${label} must have finite x and y coordinates`);
  }
  return { x: Math.round(point.x), y: Math.round(point.y) };
}
