import { ComputerUseError } from './errors.js';

export const IMAGE_SEARCH_OPTIONS = {
  threshold: { type: 'number', exclusiveMinimum: 0, maximum: 1, description: 'Minimum fraction of participating pixels within tolerance (default 0.9; click default 0.95).' },
  tolerance: { type: 'integer', minimum: 0, maximum: 255, description: 'Per-channel tolerance, integer 0..255 (default 12). RGB requires all three channels within tolerance for a pixel to match.' },
  color_mode: { type: 'string', enum: ['gray', 'rgb'], description: 'Default gray compares Rec.601 integer brightness; rgb preserves color differences.' },
  mask_mode: { type: 'string', enum: ['none', 'alpha'], description: 'Default none ignores PNG alpha and compares every pixel. alpha includes only pixels with alpha >= alpha_min; it does not blend or weight transparency.' },
  alpha_min: { type: 'integer', minimum: 1, maximum: 255, description: 'Inclusive PNG alpha cutoff for mask_mode:alpha, default 1. Applied after nearest-neighbor template resizing.' },
  template_scale: { type: 'number', minimum: 0.1, maximum: 4, description: 'One explicit template ratio, default 1. Nearest-neighbor resize rounds positive dimensions to the nearest integer (.5 up); no automatic multi-scale search. Zero-size or over-1048576-pixel source/resized templates are rejected.' },
  timeout_ms: { type: 'integer', minimum: 1, maximum: 120000, description: 'Native search budget including decode/capture, default 5000ms. Exhaustion returns partial coverage; a blocked system call is stopped by the host deadline.' },
  max_positions: { type: 'integer', minimum: 1, maximum: 100000000, description: 'Maximum screen-resolution top-left positions to examine, default 20000000. Exhaustion returns partial coverage and cannot prove absence or uniqueness.' },
};

export function imageSearchOptions(args, defaultThreshold = 0.9) {
  const threshold = args.threshold ?? defaultThreshold;
  const tolerance = args.tolerance ?? 12;
  const colorMode = args.color_mode ?? 'gray';
  const maskMode = args.mask_mode ?? 'none';
  const alphaMin = args.alpha_min ?? 1;
  const templateScale = args.template_scale ?? 1;
  const budgetMs = args.timeout_ms ?? 5000;
  const maxPositions = args.max_positions ?? 20000000;
  if (!Number.isFinite(threshold) || threshold <= 0 || threshold > 1) throw new ComputerUseError('threshold must be within (0, 1]');
  if (!['gray', 'rgb'].includes(colorMode)) throw new ComputerUseError('color_mode must be gray or rgb');
  if (!['none', 'alpha'].includes(maskMode)) throw new ComputerUseError('mask_mode must be none or alpha');
  if (!Number.isFinite(templateScale) || templateScale < 0.1 || templateScale > 4) throw new ComputerUseError('template_scale must be within [0.1, 4]');
  for (const [name, value, min, max] of [
    ['tolerance', tolerance, 0, 255], ['alpha_min', alphaMin, 1, 255],
    ['timeout_ms', budgetMs, 1, 120000], ['max_positions', maxPositions, 1, 100000000],
  ]) {
    if (!Number.isSafeInteger(value) || value < min || value > max) throw new ComputerUseError(`${name} must be an integer within [${min}, ${max}]`);
  }
  return { threshold, tolerance, colorMode, maskMode, alphaMin, templateScale, budgetMs, maxPositions };
}

/** 请求模式必须被原生结果明确确认，旧 helper 不能静默忽略 RGB、遮罩或缩放。 */
export function validateImageResult(result, options = imageSearchOptions({})) {
  const invalid = (detail) => { throw new ComputerUseError(`native find-image helper returned invalid coverage/result: ${detail}`); };
  if (result === null || typeof result !== 'object') invalid('expected object');
  if (!['complete', 'partial'].includes(result.coverage)) invalid('coverage is required; rebuild the native helper');
  if (result.clusterRule !== 'row_major_fixed_anchor_half_template' || result.scale !== 1) invalid('unsupported matching rule');
  for (const key of ['colorMode', 'maskMode', 'alphaMin', 'templateScale']) {
    if (result[key] !== options[key]) invalid(`requested ${key} was not confirmed; rebuild the native helper`);
  }
  if (result.resizeFilter !== 'nearest') invalid('unsupported resize filter');
  const integer = (value, min = 0) => Number.isSafeInteger(value) && value >= min;
  const area = result.templateWidth * result.templateHeight;
  if (!integer(result.templateWidth, 1) || !integer(result.templateHeight, 1) || area > 1048576
    || !integer(result.sourceTemplateWidth, 1) || !integer(result.sourceTemplateHeight, 1)
    || result.sourceTemplateWidth * result.sourceTemplateHeight > 1048576
    || result.templateWidth !== Math.round(result.sourceTemplateWidth * options.templateScale)
    || result.templateHeight !== Math.round(result.sourceTemplateHeight * options.templateScale)) invalid('template dimensions');
  if (!integer(result.activePixelCount, 1) || result.activePixelCount > area
    || (options.maskMode === 'none' && result.activePixelCount !== area)) invalid('participating pixel count');
  const region = result.searched;
  if (region === null || typeof region !== 'object' || !Number.isSafeInteger(region.x) || !Number.isSafeInteger(region.y)
    || !integer(region.width, 1) || !integer(region.height, 1)) invalid('searched bounds');
  const total = Math.max(0, region.width - result.templateWidth + 1) * Math.max(0, region.height - result.templateHeight + 1);
  if (!integer(result.totalPositions) || result.totalPositions !== total || !integer(result.visitedPositions)
    || result.visitedPositions > total || result.visitedPositions > options.maxPositions) invalid('position counts');
  if (!integer(result.matchCount) || result.matchCount > 100000 || result.matchCount > result.visitedPositions
    || result.found !== (result.matchCount > 0)) invalid('match count/found');
  if (result.coverage === 'complete') {
    if (result.visitedPositions !== total || result.stopReason !== undefined
      || result.status !== (result.found ? 'found' : 'not_found')) invalid('complete status');
  } else if (result.visitedPositions >= total || result.status !== 'incomplete'
    || !['time_budget', 'position_limit', 'cluster_limit'].includes(result.stopReason)) invalid('partial status');
  if (result.stopReason === 'position_limit' && result.visitedPositions !== options.maxPositions) invalid('position budget');
  if (!Array.isArray(result.matches) || result.matches.length !== Math.min(8, result.matchCount)) invalid('displayed matches');
  for (const spot of result.matches) {
    if (spot === null || typeof spot !== 'object' || !Number.isSafeInteger(spot.x) || !Number.isSafeInteger(spot.y)
      || !Number.isFinite(spot.score) || spot.score < options.threshold || spot.score > 1
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

export function imageClickPoint(result, options = imageSearchOptions({}, 0.95)) {
  validateImageResult(result, options);
  if (result.coverage !== 'complete' || result.found !== true || result.matchCount !== 1) return null;
  const spot = result.matches[0];
  return { x: spot.x + Math.floor(result.templateWidth / 2), y: spot.y + Math.floor(result.templateHeight / 2) };
}
