// 定位与动作的边界集中在这里：轮询只调用 resolve/read，控制最多发送一次。
import { LOCATOR_OPTIONS_SCHEMA, LOCATOR_SCHEMA, CONDITION_SCHEMA, locatorArgs, conditionArgs, waitForLocator } from './locator.js';
import { ELEMENT_OPERATIONS, PATTERN_BY_OPERATION, SEMANTIC_PARAMETERS, semanticActionArgs } from './accessibility-actions.js';
import { WINDOW_QUERY_SCHEMA, windowQueryOptions } from './window-query.js';
import { registerDataTools } from './data-tools.js';

function object(raw, label) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`${label} must be an object`);
  return raw;
}
function integer(raw, key, fallback, min, max) {
  const value = raw[key] ?? fallback;
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${key} must be ${min}..${max}`);
  return value;
}
function errorResult(error) { return { code: error.code ?? 'COMPUTER_OPERATION_FAILED', message: error.message }; }

const focusOf = (result, fallback) => result?.native_root
  ? { handle: result.native_root.id, processId: result.native_root.processId, title: result.native_root.title } : fallback;

export function registerLocatorTools({ register, textTool, provider, state, window, publish, publishWindows, control }) {
  const prepare = (raw, exec) => {
    const args = object(raw, 'arguments');
    const locator = locatorArgs(args.locator);
    const timeoutMs = integer(args, 'timeout_ms', 10000, 100, 120000);
    const pollMs = integer(args, 'poll_ms', 100, 20, 1000);
    const maxNodes = integer(args, 'max_nodes', 20000, 1, 20000);
    const backend = args.backend ?? 'native';
    if (!['native', 'uia', 'msaa'].includes(backend)) throw new Error('invalid locator backend');
    if (typeof args.window_id !== 'string' || !args.window_id) throw new Error('window_id is required');
    if (provider().capabilities.semanticLocators !== true) throw new Error('native locators are unsupported on this backend');
    // 验证并固定身份一次；后续轮询不会使用后来获得焦点的应用。
    const nativeWindow = window(args.window_id, exec).nativeWindow;
    const focus = { handle: nativeWindow.id, processId: nativeWindow.processId, title: nativeWindow.title };
    const owner = state(exec).owner;
    const windowQuery = args.window_query === undefined ? undefined : windowQueryOptions(args.window_query);
    const makeResolve = (path = locator, target = nativeWindow, query = windowQuery) => async (remaining, signal) => {
      const deadline = performance.now() + remaining;
      let root = target, related;
      if (query !== undefined && query !== null) {
        const driver = provider();
        if (driver.capabilities.relatedWindows !== true || typeof driver.relatedWindows !== 'function') throw new Error('related-window locators are unsupported on this backend');
        related = await driver.relatedWindows(target, query, signal, remaining);
        const coverage = { status: related.coverage, reason: related.stopReason, scope: 'related_windows' };
        // 一个部分目录里的候选不能证明全范围唯一，甚至不能证明没有窗口。
        if (related.coverage !== 'complete') return { status: 'incomplete', scope: 'related_windows', coverage, related };
        if (related.windows.length > 1) return { status: 'ambiguous', scope: 'related_windows', coverage, related };
        if (related.windows.length === 0) return { status: 'not_found', scope: 'related_windows', coverage, related };
        root = related.windows[0];
      }
      const budget = Math.floor(deadline - performance.now());
      if (budget <= 0) return { status: 'incomplete', coverage: { status: 'partial', reason: 'time_budget' }, ...(related ? { related } : {}) };
      const result = await provider().locateAccessibility(root.id, signal,
        { locator: path, backend, owner, window: root, maxNodes, timeoutMs: budget });
      return { ...result, ...(related ? { related, native_root: root } : {}) };
    };
    const read = (element, remaining, signal) => provider().performAccessibility({ kind: 'read', elementId: element.element_id, element,
      owner, maxChars: 16000, timeoutMs: remaining }, signal);
    return { args, locator, timeoutMs, pollMs, backend, focus, owner, windowQuery, makeResolve, read };
  };
  const report = (result, exec, focus, backend) => {
    if (!result) return result;
    const { native_root: root, related, ...publicResult } = result;
    if (related) {
      const listed = publishWindows(exec, related.windows);
      publicResult.related = { ...related, ...listed };
      if (root) publicResult.window_id = listed.windows.find(candidate => candidate.native_id === root.id)?.id;
    }
    const rows = result.element ? [result.element] : result.candidates ?? [];
    if (!rows.length) return publicResult;
    const evidence = publish(exec, rows, focusOf(result, focus), backend === 'native' ? 'uia' : backend, result.coverage);
    return { ...publicResult, snapshot_id: evidence.snapshot_id, captured_at: evidence.captured_at,
      ...(result.element ? { element: evidence.elements[0] } : { candidates: evidence.elements }) };
  };
  const wait = (prepared, condition, timeoutMs, exec, resolve = prepared.makeResolve()) => waitForLocator({ resolve, read: prepared.read,
    condition, timeoutMs, pollMs: prepared.pollMs, signal: exec.signal });
  const base = { type: 'object', additionalProperties: false, required: ['window_id', 'locator'], properties: LOCATOR_OPTIONS_SCHEMA };
  registerDataTools({ register, textTool, prepare, report, provider, control });

  register(textTool('computer_locate',
    'Resolve a native container/target locator from a listed window. Optional window_query re-resolves a related new root from that fixed anchor. Multiple roots are ambiguous; partial window scans cannot prove uniqueness or absence. Each locator step is unique unless nth is explicit. Includes disabled/offscreen elements and does not traverse unrealized items.',
    base, async (raw, exec) => {
      const p = prepare(raw, exec);
      return JSON.stringify(report(await p.makeResolve()(p.timeoutMs, exec.signal), exec, p.focus, p.backend));
    }));
  register(textTool('computer_wait',
    'Wait for a native locator condition. Re-resolves the full container chain and optional window_query from a fixed listed anchor on every attempt, including after popup/root replacement. All reads share one deadline. Multiple roots are an error. Absence requires complete window and locator coverage. No input is sent.',
    { ...base, properties: { ...LOCATOR_OPTIONS_SCHEMA, condition: CONDITION_SCHEMA } }, async (raw, exec) => {
      const p = prepare(raw, exec), condition = conditionArgs(p.args.condition);
      const result = await wait(p, condition, p.timeoutMs, exec);
      return JSON.stringify({ ...result, last: report(result.last, exec, p.focus, p.backend) });
    }));
  register(textTool('computer_act',
    'Wait for a native locator precondition, perform one semantic operation, then optionally wait for after. Optional window_query targets a related root; after.window_query waits for a newly opened menu/popup/dialog. An explicit after.window_id without a query reads that listed window directly. One deadline covers all reads and the single action. execution_state and postcondition are separate; unknown or failed actions are never replayed.',
    { ...base, required: [...base.required, 'operation'], properties: {
      ...LOCATOR_OPTIONS_SCHEMA, operation: { type: 'string', enum: ELEMENT_OPERATIONS }, ...SEMANTIC_PARAMETERS,
      before: CONDITION_SCHEMA,
      after: { type: 'object', additionalProperties: false, required: ['condition'], properties: {
        condition: CONDITION_SCHEMA, locator: LOCATOR_SCHEMA,
        window_id: { type: 'string', description: 'Optional other anchor/window already listed in this session.' },
        window_query: WINDOW_QUERY_SCHEMA,
      } },
    } }, async (raw, exec) => {
      const p = prepare(raw, exec), operation = p.args.operation;
      if (!ELEMENT_OPERATIONS.includes(operation)) throw new Error('invalid semantic operation');
      const parameters = semanticActionArgs(operation, p.args);
      const before = conditionArgs(p.args.before ?? { state: operation === 'realize' ? 'present' : 'enabled' });
      let after, afterResolve, afterFocus = p.focus;
      if (p.args.after !== undefined) {
        after = object(p.args.after, 'after');
        const path = after.locator === undefined ? p.locator : locatorArgs(after.locator);
        const target = after.window_id === undefined ? undefined : window(after.window_id, exec).nativeWindow;
        const query = after.window_query === undefined ? (target ? null : p.windowQuery) : windowQueryOptions(after.window_query);
        afterResolve = p.makeResolve(path, target, query);
        after = conditionArgs(after.condition);
        if (target) afterFocus = { handle: target.id, processId: target.processId, title: target.title };
      }
      const started = performance.now(), deadline = started + p.timeoutMs;
      const remaining = () => Math.max(1, Math.floor(deadline - performance.now()));
      const pre = await wait(p, before, remaining(), exec);
      const element = pre.last?.element;
      if (!pre.fulfilled || !element || performance.now() >= deadline) return JSON.stringify({ execution_state: 'not_started',
        precondition: { ...pre, last: report(pre.last, exec, p.focus, p.backend) } });
      if (!element.enabled && operation !== 'realize') throw new Error('target is disabled');
      const required = PATTERN_BY_OPERATION[operation];
      if (required && element.patterns_known !== false && !element.patterns?.includes(required)) throw new Error(`target does not support ${operation}`);
      exec.signal?.throwIfAborted();
      const actionFocus = focusOf(pre.last, p.focus);
      let result;
      try {
        result = await control(exec, () => provider().performAccessibility({ kind: operation, elementId: element.element_id, element,
          owner: p.owner, ...parameters, timeoutMs: remaining() }, exec.signal), actionFocus);
      } catch (error) {
        return JSON.stringify({ execution_state: error.executionState ?? 'unknown', error: errorResult(error),
          precondition: { fulfilled: true, attempts: pre.attempts }, elapsed_ms: Math.round(performance.now() - started) });
      }
      const response = { execution_state: 'completed', result, precondition: { fulfilled: true, attempts: pre.attempts } };
      if (operation === 'find_item' && result?.found) response.item = publish(exec, [result.element], actionFocus,
        p.backend === 'native' ? 'uia' : p.backend, { status: 'partial', reason: 'item_container_result', scope: 'item' });
      if (after) {
        if (performance.now() >= deadline) response.postcondition = { fulfilled: false, reason: 'timeout', attempts: 0 };
        else try {
          const post = await wait(p, after, remaining(), exec, afterResolve);
          response.postcondition = { ...post, last: report(post.last, exec, afterFocus, p.backend) };
        } catch (error) {
          // 已完成的操作与后续查询失败分别报告；后置条件失败不是再次发送动作的理由。
          response.postcondition = { fulfilled: false, reason: exec.signal?.aborted ? 'cancelled' : 'error', error: errorResult(error),
            ...(error.locatorResult ? { last: report(error.locatorResult, exec, afterFocus, p.backend) } : {}) };
        }
      }
      response.elapsed_ms = Math.round(performance.now() - started);
      return JSON.stringify(response);
    }));
}
