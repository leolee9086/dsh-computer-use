// 可重新解析的原生定位条件：它不是元素引用，也不继承截图坐标或旧树身份。
// 每轮从同一原生窗口解析所有容器，保证目标替换后仍按任务条件查找。
import { setTimeout as delay } from 'node:timers/promises';
import { ComputerUseError } from './errors.js';
import { WINDOW_QUERY_SCHEMA } from './window-query.js';

const SELECTOR_FIELDS = [['name', 'name', 1024], ['role', 'role', 128], ['automation_id', 'automationId', 1024],
  ['class_name', 'className', 512], ['framework_id', 'frameworkId', 128]];
const SELECTOR_PROPERTIES = Object.fromEntries(SELECTOR_FIELDS.map(([key, , maxLength]) => [key, { type: 'string', minLength: 1, maxLength }]));
const MATCH_SCHEMA = { type: 'string', enum: ['exact', 'contains', 'regex'],
  description: 'Case-insensitive exact/contains, or .NET regex (IgnoreCase + CultureInvariant, inline options allowed). Regex is parsed once per resolution; 25 ms per match, input at most 16000 characters. Invalid patterns/timeouts are errors.' };
// 不用指向工具根的 $ref：同一 locator schema 还会嵌入 after/path/item。
// 子表达式沿用根节点形状，完整递归互斥/深度/总量由 locatorArgs 验证。
const EXPRESSION_CHILD = { type: 'object', description: 'Same expression shape as where: selector leaf, or exactly one all/any/not. No step options. Maximum expression depth 4.' };
const WHERE_SCHEMA = { type: 'object', additionalProperties: false,
  description: 'Same-node boolean predicate. A leaf ANDs selector fields with its own match (default exact); an operator node has exactly one all/any/not and no selector fields. Maximum depth 4. Outer and relative queries share 64 expression nodes and 32 property comparisons per step. Missing properties stay unknown under NOT; a final unknown result is an error, never a match or proof of absence. Top-level selectors AND with where. MSAA rejects automation_id/framework_id in every branch.',
  properties: { ...SELECTOR_PROPERTIES, match: MATCH_SCHEMA,
    all: { type: 'array', minItems: 1, maxItems: 16, items: EXPRESSION_CHILD },
    any: { type: 'array', minItems: 1, maxItems: 16, items: EXPRESSION_CHILD }, not: EXPRESSION_CHILD } };
const QUERY_PROPERTIES = { ...SELECTOR_PROPERTIES, match: MATCH_SCHEMA, where: WHERE_SCHEMA,
  include_offscreen: { type: 'boolean' }, include_disabled: { type: 'boolean' },
  scope: { type: 'string', enum: ['children', 'subtree'] }, max_depth: { type: 'integer', minimum: 1, maximum: 128 } };
// 关系只接受叶层 relative query，不递归引用 outer step，避免嵌套扩大预算。
const RELATION_SCHEMA = { type: 'object', additionalProperties: false, properties: QUERY_PROPERTIES,
  description: 'Existential query over candidate descendants, excluding the candidate itself. Requires selectors or where; no window, nth or nested relations. Default scope subtree. Shares outer node/time budget and total max_depth; its own max_depth can further restrict the relative scope. has_not passes only after complete absence; truncation stays incomplete.' };
export const LOCATOR_SCHEMA = Object.freeze({
  type: 'array', minItems: 1, maxItems: 16,
  description: 'Ordered window-relative container/target steps. Each step must uniquely match unless nth is explicitly supplied (zero based). Selectors/where AND with has/has_not descendant queries. max_depth bounds candidates and relations together, measured from this step root; children restricts candidates only. Re-resolved from the window on every attempt.',
  items: { type: 'object', additionalProperties: false, properties: {
    ...QUERY_PROPERTIES, has: RELATION_SCHEMA, has_not: RELATION_SCHEMA,
    nth: { type: 'integer', minimum: 0, maximum: 19999 },
  } },
});
export const CONDITION_SCHEMA = Object.freeze({ type: 'object', additionalProperties: false, required: ['state'], properties: {
  state: { type: 'string', enum: ['present', 'absent', 'enabled', 'disabled', 'visible', 'hidden', 'focused', 'value', 'text', 'selected', 'expanded', 'collapsed', 'toggled', 'stable'] },
  value: { type: ['string', 'boolean'], maxLength: 16000 },
  match: { type: 'string', enum: ['exact', 'contains'] },
  stable_ms: { type: 'integer', minimum: 100, maximum: 10000 },
} });
export const LOCATOR_OPTIONS_SCHEMA = Object.freeze({
  window_id: { type: 'string' }, window_query: WINDOW_QUERY_SCHEMA, locator: LOCATOR_SCHEMA,
  backend: { type: 'string', enum: ['native', 'uia', 'msaa'] },
  timeout_ms: { type: 'integer', minimum: 100, maximum: 120000 },
  poll_ms: { type: 'integer', minimum: 20, maximum: 1000 },
  max_nodes: { type: 'integer', minimum: 1, maximum: 20000 },
});
function record(value, name) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} must be an object`);
}
function selectorArgs(raw, limits) {
  const query = { match: raw.match ?? 'exact' };
  if (!MATCH_SCHEMA.enum.includes(query.match)) throw new Error('locator match must be exact, contains or regex');
  let count = 0;
  for (const [key, output, limit] of SELECTOR_FIELDS) {
    if (raw[key] === undefined) continue;
    if (typeof raw[key] !== 'string' || raw[key].length < 1 || raw[key].length > limit) throw new Error(`${key} must contain 1..${limit} characters`);
    query[output] = raw[key]; count++;
    if (++limits.terms > 32) throw new Error('locator predicate exceeds 32 property comparisons');
  }
  return { query, count };
}
function expressionArgs(raw, limits, depth = 1) {
  record(raw, 'locator expression');
  if (depth > 4) throw new Error('locator predicate exceeds depth 4');
  if (++limits.nodes > 64) throw new Error('locator predicate exceeds 64 expression nodes');
  const operators = ['all', 'any', 'not'].filter(key => raw[key] !== undefined);
  if (operators.length) {
    if (operators.length !== 1 || Object.keys(raw).length !== 1) throw new Error('locator expression requires exactly one all/any/not without selector fields');
    const op = operators[0];
    if (op === 'not') return { not: expressionArgs(raw.not, limits, depth + 1) };
    if (!Array.isArray(raw[op]) || raw[op].length < 1 || raw[op].length > 16) throw new Error(`locator ${op} requires 1..16 expressions`);
    return { [op]: raw[op].map(child => expressionArgs(child, limits, depth + 1)) };
  }
  const allowed = new Set([...SELECTOR_FIELDS.map(([key]) => key), 'match']);
  for (const key of Object.keys(raw)) if (!allowed.has(key)) throw new Error(`unsupported locator expression field '${key}'`);
  const { query, count } = selectorArgs(raw, limits);
  if (!count) throw new Error('locator expression requires a name, role, automation_id, class_name or framework_id');
  // 正则不能拿 JS 引擎预判语法；生产 .NET matcher 是唯一解释者。
  return query;
}
function queryArgs(raw, limits) {
  const { query, count } = selectorArgs(raw, limits);
  if (raw.where !== undefined) query.where = expressionArgs(raw.where, limits);
  if (!count && raw.where === undefined) throw new Error('locator query requires a name, role, automation_id, class_name or framework_id, or where');
  query.includeOffscreen = raw.include_offscreen ?? true; query.includeDisabled = raw.include_disabled ?? true;
  if (typeof query.includeOffscreen !== 'boolean' || typeof query.includeDisabled !== 'boolean') throw new Error('locator inclusion options must be boolean');
  return query;
}
function scopeArgs(raw) {
  const scope = raw.scope ?? 'subtree', maxDepth = raw.max_depth ?? 128;
  if (!['children', 'subtree'].includes(scope) || !Number.isInteger(maxDepth) || maxDepth < 1 || maxDepth > 128) throw new Error('invalid locator scope/max_depth');
  return { scope, maxDepth };
}
function relationArgs(raw, limits) {
  record(raw, 'locator relation');
  for (const key of Object.keys(raw)) if (!Object.hasOwn(QUERY_PROPERTIES, key)) throw new Error(`unsupported locator relation field '${key}'`);
  const query = queryArgs(raw, limits), { scope, maxDepth } = scopeArgs(raw);
  return { query, scope, maxDepth: scope === 'children' ? 1 : maxDepth };
}
export function locatorArgs(raw) {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 16) throw new Error('locator must contain 1..16 steps');
  return raw.map((step) => {
    record(step, 'locator step');
    const limits = { nodes: 0, terms: 0 };
    for (const key of Object.keys(step)) if (!Object.hasOwn(LOCATOR_SCHEMA.items.properties, key)) throw new Error(`unsupported locator field '${key}'`);
    const query = queryArgs(step, limits), { scope, maxDepth } = scopeArgs(step);
    // 外层与两个关系共享 expression/selector 上限；不因运行时短路漏校验分支。
    if (step.has !== undefined) query.has = relationArgs(step.has, limits);
    if (step.has_not !== undefined) query.hasNot = relationArgs(step.has_not, limits);
    if (step.nth !== undefined && (!Number.isInteger(step.nth) || step.nth < 0 || step.nth > 19999)) throw new Error('locator nth must be 0..19999');
    // children 只限制外层候选；关系仍需要以 step root 为起点的总深度预算。
    const hasRelations = query.has !== undefined || query.hasNot !== undefined;
    return { query, scope, maxDepth: scope === 'children' && !hasRelations ? 1 : maxDepth, ...(step.nth === undefined ? {} : { nth: step.nth }) };
  });
}
export function conditionArgs(raw = { state: 'present' }) {
  record(raw, 'condition');
  for (const key of Object.keys(raw)) if (!['state', 'value', 'match', 'stable_ms'].includes(key)) throw new Error(`unsupported condition field '${key}'`);
  if (!CONDITION_SCHEMA.properties.state.enum.includes(raw.state)) throw new Error('invalid condition state');
  const result = { state: raw.state, match: raw.match ?? 'exact', stableMs: raw.stable_ms ?? 200 };
  if (!['exact', 'contains'].includes(result.match)) throw new Error('condition match must be exact or contains');
  if (!Number.isInteger(result.stableMs) || result.stableMs < 100 || result.stableMs > 10000) throw new Error('stable_ms must be 100..10000');
  if (['value', 'text'].includes(raw.state)) {
    if (typeof raw.value !== 'string' || raw.value.length > 16000) throw new Error('value/text condition requires a string value of at most 16000 characters');
    result.value = raw.value;
  } else if (['selected', 'toggled'].includes(raw.state)) {
    if (typeof raw.value !== 'boolean') throw new Error('selected/toggled condition requires a boolean value');
    result.value = raw.value;
  } else if (raw.value !== undefined) throw new Error('value is only valid for value/text/selected/toggled conditions');
  return result;
}
function changed(error) { return ['COMPUTER_LOCATOR_CHANGED', 'COMPUTER_TARGET_STALE'].includes(error.code) && error.executionState === 'not_started'; }
function sameText(actual, expected, mode) { return typeof actual === 'string' && (mode === 'exact' ? actual === expected : actual.includes(expected)); }

// resolve/read 都只能读取；动作由工具在此函数之外执行一次。
// 总截止包括查询、读取和轮询。原生调用接收剩余时间，worker 卡住时会被终止。
export async function waitForLocator({ resolve, read, condition, timeoutMs = 10000, pollMs = 100, signal, stopOnCompleteMissing = false }) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) throw new Error('wait budget must be 1..120000 ms');
  if (!Number.isInteger(pollMs) || pollMs < 20 || pollMs > 1000) throw new Error('poll_ms must be 20..1000');
  const started = performance.now(), deadline = started + timeoutMs;
  let attempts = 0, last, stable;
  while (performance.now() < deadline) {
    signal?.throwIfAborted(); attempts++;
    const remaining = () => Math.max(1, Math.floor(deadline - performance.now()));
    try {
      last = await resolve(remaining(), signal);
      if (last.status === 'ambiguous') {
        const error = new ComputerUseError(last.scope === 'related_windows'
          ? 'related window query is ambiguous; inspect candidates and refine title/class/relation'
          : `locator step ${last.step + 1} is ambiguous; refine the container or choose nth explicitly`, 'COMPUTER_LOCATOR_AMBIGUOUS');
        // 后置条件失败仍提供本轮候选，便于审查一次动作之后究竟出现了哪些新根。
        error.locatorResult = last;
        throw error;
      }
      let fulfilled = false;
      const element = last.element;
      if (last.status === 'not_found' && last.coverage?.status === 'complete') fulfilled = ['absent', 'hidden'].includes(condition.state);
      if (last.status === 'resolved') {
        switch (condition.state) {
          case 'present': fulfilled = true; break;
          case 'absent': break;
          case 'enabled': fulfilled = element.enabled === true; break;
          case 'disabled': fulfilled = element.enabled === false; break;
          case 'visible': fulfilled = element.offscreen === false && element.bounds?.width > 0 && element.bounds?.height > 0; break;
          case 'hidden': fulfilled = element.offscreen === true; break;
          case 'focused': fulfilled = element.focused === true; break;
          case 'stable': {
            const rect = element.bounds;
            if (!rect || rect.width <= 0 || rect.height <= 0) { stable = undefined; break; }
            const signature = JSON.stringify([element.element_id, rect.x, rect.y, rect.width, rect.height]);
            if (stable?.signature !== signature) stable = { signature, at: performance.now() };
            fulfilled = performance.now() - stable.at >= condition.stableMs;
            break;
          }
          default: {
            if (performance.now() >= deadline) break;
            const state = await read(element, remaining(), signal);
            last.read = state;
            if (condition.state === 'value' || condition.state === 'text') {
              if (state.redacted) throw new ComputerUseError('the requested condition cannot read password contents');
              if (state[condition.state] === undefined) throw new ComputerUseError(`target does not expose ${condition.state}`);
              fulfilled = sameText(state[condition.state], condition.value, condition.match);
              if (condition.match === 'exact' && state[`${condition.state}_truncated`] === true) fulfilled = false;
            } else if (condition.state === 'selected') {
              if (typeof state.selected !== 'boolean') throw new ComputerUseError('target does not expose selection-item state');
              fulfilled = state.selected === condition.value;
            } else if (condition.state === 'expanded' || condition.state === 'collapsed') {
              if (state.expand_state === undefined) throw new ComputerUseError('target does not expose expand/collapse state');
              fulfilled = state.expand_state === (condition.state === 'expanded' ? 'Expanded' : 'Collapsed');
            } else if (condition.state === 'toggled') {
              if (state.toggle_state === undefined) throw new ComputerUseError('target does not expose toggle state');
              fulfilled = state.toggle_state === (condition.value ? 'On' : 'Off');
            }
          }
        }
      } else stable = undefined;
      if (fulfilled && performance.now() <= deadline) return { fulfilled: true, attempts, elapsed_ms: Math.round(performance.now() - started), last };
      // 显式滚动流程检查的是当前页；完整缺失可结束本页读取，随后决定是否滚动。
      // 普通条件等待仍默认继续轮询，虚拟数据的全局缺失也没有在这里得到证明。
      if (stopOnCompleteMissing && last.status === 'not_found' && last.coverage?.status === 'complete' && performance.now() <= deadline) {
        return { fulfilled: false, reason: 'not_found', attempts, elapsed_ms: Math.round(performance.now() - started), last };
      }
    } catch (error) {
      if (!changed(error)) throw error;
      last = { status: 'changed', error: error.message }; stable = undefined;
    }
    const remainingMs = deadline - performance.now();
    if (remainingMs <= 0) break;
    await delay(Math.min(pollMs, remainingMs), undefined, { signal });
  }
  return { fulfilled: false, reason: 'timeout', attempts, elapsed_ms: Math.round(performance.now() - started), last };
}
