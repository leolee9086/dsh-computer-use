import { ComputerUseError } from './errors.js';

const DEFAULTS = Object.freeze({
  screenshotMaxDimension: 1920,
  screenshotMaxBytes: 12_000_000,
  commandTimeoutMs: 30_000,
  graceMs: 2_000,
  actionDelayMs: 40,
  maxAccessibilityNodes: 300,
  maxAccessibilityDepth: 6,
  maxAccessibilityBytes: 1_000_000,
  maxAccessibilityActionCandidates: 5_000,
  semanticWorkerCount: 2,
});

function positiveInteger(raw, key) {
  const value = raw[key] ?? DEFAULTS[key];
  if (!Number.isInteger(value) || value < 1) {
    throw new ComputerUseError(`dsh-computer-use: ${key} must be a positive integer`);
  }
  return value;
}

function nonnegativeInteger(raw, key) {
  const value = raw[key] ?? DEFAULTS[key];
  if (!Number.isInteger(value) || value < 0) {
    throw new ComputerUseError(`dsh-computer-use: ${key} must be a non-negative integer`);
  }
  return value;
}

export function resolveHostConfig(raw = {}) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ComputerUseError('dsh-computer-use: host config must be an object');
  }
  if (positiveInteger(raw, 'semanticWorkerCount') > 4) throw new ComputerUseError('dsh-computer-use: semanticWorkerCount must be 1..4');
  if (nonnegativeInteger(raw, 'actionDelayMs') > 10000) throw new ComputerUseError('dsh-computer-use: actionDelayMs must not exceed 10000');
  if (raw.nativeHelperPath !== undefined && (typeof raw.nativeHelperPath !== 'string' || raw.nativeHelperPath.trim().length === 0)) throw new ComputerUseError('dsh-computer-use: nativeHelperPath must be a non-empty executable path');
  return Object.freeze({
    ...(raw.nativeHelperPath === undefined ? {} : { nativeHelperPath: raw.nativeHelperPath }),
    screenshotMaxDimension: positiveInteger(raw, 'screenshotMaxDimension'),
    screenshotMaxBytes: positiveInteger(raw, 'screenshotMaxBytes'),
    commandTimeoutMs: positiveInteger(raw, 'commandTimeoutMs'),
    graceMs: positiveInteger(raw, 'graceMs'),
    actionDelayMs: nonnegativeInteger(raw, 'actionDelayMs'),
    maxAccessibilityNodes: positiveInteger(raw, 'maxAccessibilityNodes'),
    maxAccessibilityDepth: positiveInteger(raw, 'maxAccessibilityDepth'),
    maxAccessibilityBytes: positiveInteger(raw, 'maxAccessibilityBytes'),
    maxAccessibilityActionCandidates: positiveInteger(raw, 'maxAccessibilityActionCandidates'),
    semanticWorkerCount: positiveInteger(raw, 'semanticWorkerCount'),
  });
}

export const hostConfigDefaults = DEFAULTS;
