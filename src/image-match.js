import { ComputerUseError } from './errors.js';

export const IMAGE_SEARCH_OPTIONS = {
  threshold: { type: 'number', exclusiveMinimum: 0, maximum: 1, description: 'Minimum fraction of grayscale pixels within tolerance (default 0.9; click default 0.95).' },
  tolerance: { type: 'integer', minimum: 0, maximum: 255, description: 'Grayscale brightness tolerance, integer 0..255 (default 12). RGB hue is not compared.' },
  timeout_ms: { type: 'integer', minimum: 1, maximum: 120000, description: 'Native search budget including decode/capture, default 5000ms. Exhaustion returns partial coverage; a blocked system call is stopped by the host deadline.' },
  max_positions: { type: 'integer', minimum: 1, maximum: 100000000, description: 'Maximum original-resolution top-left positions to examine, default 20000000. Exhaustion returns partial coverage and cannot prove absence or uniqueness.' },
};

export function imageSearchOptions(args, defaultThreshold = 0.9) {
  const threshold = args.threshold ?? defaultThreshold;
  const tolerance = args.tolerance ?? 12;
  const budgetMs = args.timeout_ms ?? 5000;
  const maxPositions = args.max_positions ?? 20000000;
  if (!Number.isFinite(threshold) || threshold <= 0 || threshold > 1) throw new ComputerUseError('threshold must be within (0, 1]');
  for (const [name, value, min, max] of [
    ['tolerance', tolerance, 0, 255], ['timeout_ms', budgetMs, 1, 120000], ['max_positions', maxPositions, 1, 100000000],
  ]) {
    if (!Number.isSafeInteger(value) || value < min || value > max) throw new ComputerUseError(`${name} must be an integer within [${min}, ${max}]`);
  }
  return { threshold, tolerance, budgetMs, maxPositions };
}

/** 对协议缺字段或互相矛盾直接报错，旧 helper 的候选数不能冒充完整覆盖。 */
export function validateImageResult(result, threshold = 0.9) {
  const invalid = (detail) => { throw new ComputerUseError(`native find-image helper returned invalid coverage/result: ${detail}`); };
  if (result === null || typeof result !== 'object') invalid('expected object');
  if (!['complete', 'partial'].includes(result.coverage)) invalid('coverage is required; rebuild the native helper');
  if (result.clusterRule !== 'row_major_fixed_anchor_half_template' || result.scale !== 1) invalid('unsupported matching rule');
  const integer = (value, min = 0) => Number.isSafeInteger(value) && value >= min;
  if (!integer(result.templateWidth, 1) || !integer(result.templateHeight, 1)
    || result.templateWidth * result.templateHeight > 1048576) invalid('template dimensions');
  const region = result.searched;
  if (region === null || typeof region !== 'object' || !Number.isSafeInteger(region.x) || !Number.isSafeInteger(region.y)
    || !integer(region.width, 1) || !integer(region.height, 1)) invalid('searched bounds');
  const total = Math.max(0, region.width - result.templateWidth + 1) * Math.max(0, region.height - result.templateHeight + 1);
  if (!integer(result.totalPositions) || result.totalPositions !== total || !integer(result.visitedPositions)
    || result.visitedPositions > total) invalid('position counts');
  if (!integer(result.matchCount) || result.matchCount > 100000 || result.matchCount > result.visitedPositions
    || result.found !== (result.matchCount > 0)) invalid('match count/found');
  if (result.coverage === 'complete') {
    if (result.visitedPositions !== total || result.stopReason !== undefined
      || result.status !== (result.found ? 'found' : 'not_found')) invalid('complete status');
  } else if (result.visitedPositions >= total || result.status !== 'incomplete'
    || !['time_budget', 'position_limit', 'cluster_limit'].includes(result.stopReason)) invalid('partial status');
  if (!Array.isArray(result.matches) || result.matches.length !== Math.min(8, result.matchCount)) invalid('displayed matches');
  for (const spot of result.matches) {
    if (spot === null || typeof spot !== 'object' || !Number.isSafeInteger(spot.x) || !Number.isSafeInteger(spot.y)
      || !Number.isFinite(spot.score) || spot.score < threshold || spot.score > 1
      || spot.x < region.x || spot.y < region.y
      || spot.x + result.templateWidth > region.x + region.width
      || spot.y + result.templateHeight > region.y + region.height) invalid('match bounds/score');
  }
  const best = result.matches[0];
  if (best === undefined) {
    if (result.x !== undefined || result.y !== undefined || result.score !== 0 || result.runnerUp !== undefined) invalid('empty result coordinates');
  } else if (result.x !== best.x || result.y !== best.y || result.score !== best.score
    || result.runnerUp !== result.matches[1]?.score) invalid('best/runner-up score');
  if (!integer(result.elapsedMs)) invalid('elapsed time');
  return result;
}

export function imageClickPoint(result, threshold = 0.95) {
  validateImageResult(result, threshold);
  if (result.coverage !== 'complete' || result.found !== true || result.matchCount !== 1) return null;
  const spot = result.matches[0];
  return { x: spot.x + Math.floor(result.templateWidth / 2), y: spot.y + Math.floor(result.templateHeight / 2) };
}
