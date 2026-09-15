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
  return Object.freeze({
    screenshotMaxDimension: positiveInteger(raw, 'screenshotMaxDimension'),
    screenshotMaxBytes: positiveInteger(raw, 'screenshotMaxBytes'),
    commandTimeoutMs: positiveInteger(raw, 'commandTimeoutMs'),
    graceMs: positiveInteger(raw, 'graceMs'),
    actionDelayMs: nonnegativeInteger(raw, 'actionDelayMs'),
    maxAccessibilityNodes: positiveInteger(raw, 'maxAccessibilityNodes'),
    maxAccessibilityDepth: positiveInteger(raw, 'maxAccessibilityDepth'),
    maxAccessibilityBytes: positiveInteger(raw, 'maxAccessibilityBytes'),
    maxAccessibilityActionCandidates: positiveInteger(raw, 'maxAccessibilityActionCandidates'),
  });
}

export const hostConfigDefaults = DEFAULTS;
