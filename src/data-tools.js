// 树路径与显式滚动查找复用 locator 的窗口身份、来源验证和截止。
// 每个控制动作只发送一次；换分支、未知执行和查询失败都保留已经发生的步骤。
import { setTimeout as delay } from 'node:timers/promises';
import { LOCATOR_OPTIONS_SCHEMA, LOCATOR_SCHEMA, locatorArgs, conditionArgs, waitForLocator } from './locator.js';
import { ComputerUseError } from './errors.js';

function integer(args, key, fallback, min, max) {
  const value = args[key] ?? fallback;
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${key} must be ${min}..${max}`);
  return value;
}
function fault(error) { return { code: error.code ?? 'COMPUTER_OPERATION_FAILED', message: error.message }; }
function positiveRect(rect) {
  return rect && ['x', 'y', 'width', 'height'].every(key => Number.isFinite(rect[key])) && rect.width > 0 && rect.height > 0;
}
function changed(message) {
  // 这个错误不能被 waitForLocator 的只读重试吞掉：工作流已经展开过旧分支。
  return new ComputerUseError(message, 'COMPUTER_WORKFLOW_ANCESTOR_CHANGED');
}

export function registerDataTools({ register, textTool, prepare, report, provider, control }) {
  const base = { type: 'object', additionalProperties: false, required: ['window_id', 'locator'], properties: LOCATOR_OPTIONS_SCHEMA };
  function task(p, exec) {
    const started = performance.now(), deadline = started + p.timeoutMs;
    const actions = []; let pinned, last;
    const remaining = () => Math.max(0, Math.floor(deadline - performance.now()));
    const budget = () => {
      exec.signal?.throwIfAborted();
      const ms = remaining();
      if (ms < 1) throw new ComputerUseError('workflow deadline reached', 'COMPUTER_WORKFLOW_TIMEOUT');
      return ms;
    };
    const resolve = path => async (ms, signal) => {
      const result = await p.makeResolve(path)(ms, signal);
      // trace 的 runtime IDs 与 worker generation 标识准确的容器和路径，
      // 不比较每次 Save 都更新的 native_token，也不按同名节点重新绑定。
      if (pinned && result.status !== 'ambiguous') {
        const trace = result.trace;
        // 截断可能发生在已固定路径之前；没有读到某一层不能证明它被替换。
        // 只认本轮实际读出的不同身份，或完整缺失的已固定祖先。
        const different = result.worker_generation !== undefined && result.worker_generation !== pinned.generation;
        const mismatch = Array.isArray(trace) && pinned.ids.some((id, index) => trace[index] && trace[index].element_id !== id);
        const removed = result.status === 'not_found' && result.coverage?.status === 'complete'
          && Array.isArray(trace) && trace.length < pinned.ids.length;
        if (different || mismatch || removed) {
          const error = changed('an observed workflow container or tree branch was removed/replaced');
          error.locatorResult = result; throw error;
        }
        if (result.status === 'resolved' && (!Array.isArray(trace) || trace.length < pinned.ids.length)) {
          throw new ComputerUseError('provider omitted resolved locator identity trace');
        }
      }
      last = result; return result;
    };
    const pin = result => {
      if (!Array.isArray(result.trace) || !result.trace.length || typeof result.worker_generation !== 'string') {
        throw new ComputerUseError('provider omitted locator identity trace');
      }
      pinned = { generation: result.worker_generation, ids: result.trace.map(step => step.element_id) };
    };
    const wait = async (path, condition, maximum = remaining(), stopOnCompleteMissing = false) => {
      const ms = Math.min(budget(), maximum);
      return waitForLocator({ resolve: resolve(path), read: p.read, condition: conditionArgs(condition),
        timeoutMs: ms, pollMs: p.pollMs, signal: exec.signal, stopOnCompleteMissing });
    };
    const read = element => p.read(element, budget(), exec.signal);
    const act = async (element, operation, parameters, stage) => {
      const entry = { stage, operation, element_id: element.element_id, execution_state: 'not_started' };
      // deadline / cancellation / pattern validation happen before this entry is dispatched.
      const ms = budget();
      if (!element.enabled) throw new ComputerUseError('workflow target is disabled');
      const pattern = { expand: 'expand_collapse', select: 'selection_item', scroll: 'scroll' }[operation];
      if (!element.patterns?.includes(pattern)) throw new ComputerUseError(`target does not support ${operation}`);
      actions.push(entry);
      const focus = last?.native_root ? { handle: last.native_root.id, processId: last.native_root.processId, title: last.native_root.title } : p.focus;
      try {
        const result = await control(exec, () => provider().performAccessibility({ kind: operation, elementId: element.element_id,
          element, owner: p.owner, ...parameters, timeoutMs: ms }, exec.signal), focus);
        entry.execution_state = 'completed'; return result;
      } catch (error) { entry.execution_state = error.executionState ?? 'unknown'; throw error; }
    };
    const observedWait = result => ({ ...result, last: report(result.last, exec, p.focus, p.backend) });
    const finish = (status, fields = {}) => ({ status, ...fields, actions,
      elapsed_ms: Math.round(performance.now() - started), ...(last ? { last: report(last, exec, p.focus, p.backend) } : {}) });
    const failure = error => {
      if (error.locatorResult) last = error.locatorResult;
      const status = exec.signal?.aborted ? 'cancelled' : error.code === 'COMPUTER_WORKFLOW_ANCESTOR_CHANGED' ? 'ancestor_changed'
        : error.code === 'COMPUTER_WORKFLOW_TIMEOUT' ? 'timeout' : 'error';
      return finish(status, { error: fault(error) });
    };
    const selectionState = stage => actions.find(entry => entry.stage === stage && entry.operation === 'select')?.execution_state ?? 'not_started';
    return { remaining, budget, resolve, pin, wait, read, act, observedWait, finish, failure, selectionState };
  }

  register(textTool('computer_tree',
    'Select a lazy native tree path from a listed window. locator identifies the tree; path contains direct TreeItem children. Only path ancestors are expanded, once each, and each layer is re-resolved and confirmed under one deadline. Removal/replacement of an observed branch stops with ancestor_changed; completed or unknown operations are never replayed. Returns individual actions and selection confirmation.',
    { ...base, required: [...base.required, 'path'], properties: { ...LOCATOR_OPTIONS_SCHEMA, path: LOCATOR_SCHEMA } }, async (raw, exec) => {
      const p = prepare(raw, exec);
      if (!Array.isArray(raw.path)) throw new Error('path is required');
      const path = locatorArgs(raw.path.map(step => {
        if (step.scope !== undefined && step.scope !== 'children') throw new Error('tree path steps require children scope');
        if (step.role !== undefined && step.role !== 'TreeItem') throw new Error('tree path steps require TreeItem role');
        return { ...step, role: 'TreeItem', scope: 'children' };
      }));
      if (p.locator.length + path.length > 16) throw new Error('tree locator and path together must contain at most 16 steps');
      const t = task(p, exec); let stage = -1, selection = 'not_started';
      try {
        const container = await t.wait(p.locator, { state: 'present' });
        if (!container.fulfilled) return JSON.stringify(t.finish('timeout', { stage, selection_state: selection }));
        t.pin(container.last);
        for (stage = 0; stage < path.length; stage++) {
          const currentPath = [...p.locator, ...path.slice(0, stage + 1)];
          const found = await t.wait(currentPath, { state: 'enabled' });
          if (!found.fulfilled) return JSON.stringify(t.finish('timeout', { stage, selection_state: selection, condition: t.observedWait(found) }));
          t.pin(found.last);
          if (stage < path.length - 1) {
            const state = await t.read(found.last.element);
            if (state.expand_state === undefined) throw new ComputerUseError('tree ancestor does not expose expand/collapse state');
            if (state.expand_state === 'LeafNode') return JSON.stringify(t.finish('leaf_before_path_end', { stage, selection_state: selection }));
            if (state.expand_state !== 'Expanded') {
              // 状态读取之后提供者可再发结构事件；展开前重新取得同一路径引用。
              // 固定的 runtime IDs 仍检查祖先替换，展开只发送一次。
              const fresh = await t.wait(currentPath, { state: 'enabled' });
              if (!fresh.fulfilled) return JSON.stringify(t.finish('timeout', { stage, selection_state: selection, condition: t.observedWait(fresh) }));
              await t.act(fresh.last.element, 'expand', {}, stage);
            }
            const expanded = await t.wait(currentPath, { state: 'expanded' });
            if (!expanded.fulfilled) return JSON.stringify(t.finish('timeout', { stage, selection_state: selection, condition: t.observedWait(expanded) }));
          } else {
            try { await t.act(found.last.element, 'select', {}, stage); selection = 'completed'; }
            catch (error) { selection = t.selectionState(stage); throw error; }
            const confirmed = await t.wait(currentPath, { state: 'selected', value: true });
            return JSON.stringify(t.finish(confirmed.fulfilled ? 'selected' : 'confirmation_timeout',
              { stage, selection_state: selection, confirmed: confirmed.fulfilled, confirmation: t.observedWait(confirmed) }));
          }
        }
      } catch (error) { return JSON.stringify({ ...t.failure(error), stage, selection_state: selection }); }
    }));

  register(textTool('computer_scroll_find',
    'Explicit bounded search of visible native items by scrolling a uniquely located ScrollPattern container. Prefer exact ItemContainer lookup when available. item is relative to the container; its final step requires visible targets. Every page and scroll re-resolves the pinned container; a found target must intersect its newly read rectangle. This is geometry, not pointer hit-test proof. max_scrolls, page_wait_ms and one total deadline bound changes. This can scroll the application; no keyboard/pointer fallback is guessed. An exhausted search never proves global data absence, and no item action is sent.',
    { ...base, required: [...base.required, 'item'], properties: { ...LOCATOR_OPTIONS_SCHEMA, item: LOCATOR_SCHEMA,
      axis: { type: 'string', enum: ['vertical', 'horizontal'] }, direction: { type: 'string', enum: ['forward', 'backward'] },
      max_scrolls: { type: 'integer', minimum: 0, maximum: 100 }, page_wait_ms: { type: 'integer', minimum: 100, maximum: 5000 },
    } }, async (raw, exec) => {
      const p = prepare({ ...raw, max_nodes: raw.max_nodes ?? 512 }, exec);
      const item = locatorArgs(raw.item);
      if (p.locator.length + item.length > 16) throw new Error('container and item locator together must contain at most 16 steps');
      if (item.at(-1).query.includeOffscreen === true && raw.item.at(-1).include_offscreen === true) throw new Error('scroll search requires visible items');
      item.at(-1).query.includeOffscreen = false;
      const axis = raw.axis ?? 'vertical', direction = raw.direction ?? 'forward';
      if (!['vertical', 'horizontal'].includes(axis) || !['forward', 'backward'].includes(direction)) throw new Error('invalid scroll axis/direction');
      const maximum = integer(raw, 'max_scrolls', 10, 0, 100), pageWait = integer(raw, 'page_wait_ms', 300, 100, 5000);
      const t = task(p, exec), pages = []; let scrolls = 0;
      const finish = (status, extra = {}) => t.finish(status, { found: status === 'found', global_absence_proven: false, scrolls, pages, ...extra });
      try {
        const container = await t.wait(p.locator, { state: 'enabled' });
        if (!container.fulfilled) return JSON.stringify(finish('timeout'));
        t.pin(container.last);
        while (t.remaining() > 0) {
          const frame = await t.wait(p.locator, { state: 'enabled' });
          if (!frame.fulfilled) return JSON.stringify(finish('timeout'));
          const viewport = frame.last.element.bounds;
          if (!positiveRect(viewport)) return JSON.stringify(finish('unsupported', { reason: 'missing_viewport_geometry' }));
          const page = await t.wait([...p.locator, ...item], { state: 'visible' }, Math.min(pageWait, t.remaining()), true);
          const rect = page.last?.element?.bounds;
          if (page.fulfilled && !positiveRect(rect)) throw new ComputerUseError('provider omitted finite target geometry');
          // 默认 WPF Button peer 对裁剪区外的项也可能报 IsOffscreen=false。
          // 这里证明的是几何交集，不证明遮挡/点击命中，引用仍只供语义操作。
          const intersects = rect && Math.max(rect.x, viewport.x) < Math.min(rect.x + rect.width, viewport.x + viewport.width)
            && Math.max(rect.y, viewport.y) < Math.min(rect.y + rect.height, viewport.y + viewport.height);
          pages.push({ index: scrolls, fulfilled: page.fulfilled, viewport_intersects: Boolean(intersects), viewport,
            ...(rect ? { target_bounds: rect } : {}), attempts: page.attempts, status: page.last?.status,
            coverage: page.last?.coverage, visited_nodes: page.last?.visited_nodes, native_calls: page.last?.native_calls });
          if (page.fulfilled && intersects) return JSON.stringify(finish('found'));
          if (!(page.fulfilled || page.last?.status === 'not_found') || page.last?.coverage?.status !== 'complete') return JSON.stringify(finish('incomplete'));
          if (scrolls >= maximum) return JSON.stringify(finish('scroll_limit'));
          const fresh = await t.wait(p.locator, { state: 'enabled' });
          if (!fresh.fulfilled) return JSON.stringify(finish('timeout'));
          if (!fresh.last.element.patterns?.includes('scroll')) return JSON.stringify(finish('unsupported', { reason: 'missing_scroll_pattern' }));
          const previous = await t.read(fresh.last.element), percent = previous.scroll?.[axis];
          if (!Number.isFinite(percent)) throw new ComputerUseError('container did not expose the requested scroll position');
          if (percent === -1) return JSON.stringify(finish('unsupported', { reason: 'axis_not_scrollable' }));
          if ((direction === 'forward' && percent >= 100) || (direction === 'backward' && percent <= 0)) return JSON.stringify(finish('scroll_end'));
          await t.act(fresh.last.element, 'scroll', { horizontal: 'NoAmount', vertical: 'NoAmount',
            [axis]: direction === 'forward' ? 'LargeIncrement' : 'LargeDecrement' }, scrolls);
          scrolls++;
          // 下一页以真正的滚动位置变化为条件；发送成功不能代替位置变化。
          const motionDeadline = Math.min(performance.now() + pageWait, performance.now() + t.remaining());
          let moved = false;
          while (performance.now() < motionDeadline && t.remaining() > 0) {
            const observed = await t.wait(p.locator, { state: 'enabled' }, Math.max(1, Math.floor(motionDeadline - performance.now())));
            if (!observed.fulfilled) break;
            const current = await t.read(observed.last.element), currentPercent = current.scroll?.[axis];
            if (!Number.isFinite(currentPercent)) throw new ComputerUseError('container lost the requested scroll state');
            if (currentPercent !== percent) { moved = true; break; }
            const ms = Math.min(p.pollMs, motionDeadline - performance.now(), t.remaining());
            if (ms > 0) await delay(ms, undefined, { signal: exec.signal });
          }
          if (!moved) return JSON.stringify(finish('scroll_not_confirmed'));
        }
        return JSON.stringify(finish('timeout'));
      } catch (error) { return JSON.stringify({ ...t.failure(error), found: false, global_absence_proven: false, scrolls, pages }); }
    }));
}
