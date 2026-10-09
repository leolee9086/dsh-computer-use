import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import test, { after } from 'node:test';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { locatorArgs, conditionArgs, waitForLocator } from '../src/locator.js';
import { apply as applyTools } from '../src/tool.js';

// 故障由 computer provider 注入；工具注册、schema 和权限走真实 Cordis/ToolRuntime。
const harnessRoot = process.env.DSH_HARNESS_ROOT ?? fileURLToPath(new URL('../../deepseek-harness/', import.meta.url));
const requireHarness = createRequire(resolve(harnessRoot, 'package.json'));
const { register } = await import(pathToFileURL(requireHarness.resolve('tsx/esm/api')).href);
const loader = register({ namespace: 'locator-contract-tests', tsconfig: resolve(harnessRoot, 'tsconfig.json') });
const [{ Context }, { default: ToolRuntime }, { default: SystemPrompt }] = await Promise.all([
  loader.import('@deepseek-ai/cordis', import.meta.url), loader.import('@deepseek-ai/dsh-tools', import.meta.url), loader.import('@deepseek-ai/dsh-system-prompt', import.meta.url),
]);
const contexts = [];
after(async () => { for (const ctx of contexts) await ctx.fiber.dispose(); loader.unregister(); });

const element = (id = 'uia:1,2', enabled = true) => ({ element_id: id, native_token: id, worker_generation: 'worker',
  process_id: 321, role: 'Button', name: 'Apply', automation_id: 'apply', enabled, offscreen: false,
  patterns: ['invoke'], bounds: { x: 1, y: 2, width: 30, height: 20 } });
const resolved = row => ({ status: 'resolved', element: row, coverage: { status: 'complete' } });
const absent = () => ({ status: 'not_found', coverage: { status: 'complete' } });

async function context(provider, config = {}) {
  const ctx = new Context(); contexts.push(ctx);
  await ctx.plugin(SystemPrompt); await ctx.plugin(ToolRuntime); ctx.provide('computer', provider);
  await ctx.plugin({ name: 'locator-contract-probe', inject: ['tools', 'computer'],
    apply: scope => applyTools(scope, { observeApproval: 'allow', controlApproval: 'allow', ...config }) });
  const exec = { agent: { options: {}, session: {} }, signal: new AbortController().signal }; let calls = 0;
  const execute = async (name, args, execution = exec) => {
    const result = await ctx.tools.execute({ ...execution, callId: `locator-contract-${++calls}`, name, arguments: args });
    if (result.isError) throw new Error(result.error?.message ?? JSON.stringify(result));
    return result.value;
  };
  return { execute, exec };
}
function computer(resolve, perform) {
  return { capabilities: { semanticLocators: true },
    listWindows: async () => [{ id: '123', title: 'Fixture', processId: 321, bounds: { x: 0, y: 0, width: 100, height: 100 } }],
    locateAccessibility: resolve, performAccessibility: perform ?? (async () => ({ ok: true })) };
}
async function listed(probe) { return JSON.parse(await probe.execute('computer_windows', { operation: 'list' })).windows[0].id; }

test('locator validation keeps state queries visible and rejects accidental selectors', () => {
  const path = locatorArgs([{ automation_id: 'panel', scope: 'children' }, { name: 'Apply', class_name: 'Button', framework_id: 'WPF', nth: 1 }]);
  assert.equal(path[0].maxDepth, 1); assert.equal(path[1].query.includeDisabled, true); assert.equal(path[1].query.includeOffscreen, true);
  assert.equal(path[1].query.frameworkId, 'WPF'); assert.equal(path[1].nth, 1);
  assert.throws(() => locatorArgs([{}]), /requires a name/);
  assert.throws(() => locatorArgs([{ name: 'Apply', first: true }]), /unsupported/);
  assert.throws(() => conditionArgs({ state: 'selected' }), /boolean/);
});

test('wait re-resolves replacements and retries only typed read changes', async () => {
  let calls = 0;
  const result = await waitForLocator({ timeoutMs: 500, pollMs: 20, condition: conditionArgs({ state: 'enabled' }), resolve: async () => {
    calls++;
    if (calls === 2) throw Object.assign(new Error('ancestor replaced'), { code: 'COMPUTER_LOCATOR_CHANGED', executionState: 'not_started' });
    return resolved(element(calls < 3 ? 'old' : 'replacement', calls >= 3));
  } });
  assert.equal(result.fulfilled, true); assert.equal(result.attempts, 3); assert.equal(result.last.element.element_id, 'replacement');
  const unknown = Object.assign(new Error('unknown execution'), { code: 'COMPUTER_TARGET_STALE', executionState: 'unknown' });
  await assert.rejects(waitForLocator({ condition: conditionArgs(), resolve: async () => { throw unknown; } }), error => error === unknown);
});

test('partial coverage cannot satisfy absence and ambiguity cannot select the first element', async () => {
  const partial = await waitForLocator({ timeoutMs: 100, pollMs: 20, condition: conditionArgs({ state: 'absent' }),
    resolve: async () => ({ status: 'incomplete', coverage: { status: 'partial', reason: 'node_limit' } }) });
  assert.equal(partial.fulfilled, false); assert.equal(partial.reason, 'timeout');
  await assert.rejects(waitForLocator({ condition: conditionArgs(), resolve: async () => ({ status: 'ambiguous', step: 1 }) }),
    error => error.code === 'COMPUTER_LOCATOR_AMBIGUOUS');
});

test('stable waits reset when a replacement has the same rectangle', async () => {
  const start = performance.now();
  const result = await waitForLocator({ timeoutMs: 600, pollMs: 20, condition: conditionArgs({ state: 'stable', stable_ms: 100 }),
    resolve: async () => resolved(element(performance.now() - start < 80 ? 'old' : 'new')) });
  assert.equal(result.fulfilled, true); assert.ok(result.elapsed_ms >= 170); assert.equal(result.last.element.element_id, 'new');
});

test('cancelled wait stops polling without sending input', async () => {
  const controller = new AbortController(); let calls = 0;
  const promise = waitForLocator({ timeoutMs: 1000, pollMs: 20, signal: controller.signal, condition: conditionArgs(),
    resolve: async () => { calls++; return absent(); } });
  await delay(50); controller.abort(new Error('stop'));
  await assert.rejects(promise, /stop|aborted/); const count = calls; await delay(30); assert.equal(calls, count);
});

test('unknown action executes once and consumes prior semantic evidence', async () => {
  let actions = 0;
  const probe = await context(computer(async () => resolved(element()), async () => {
    actions++; throw Object.assign(new Error('provider stopped after dispatch'), { executionState: 'unknown' });
  }));
  const window_id = await listed(probe), locator = [{ name: 'Apply' }];
  const prior = JSON.parse(await probe.execute('computer_locate', { window_id, locator }));
  const result = JSON.parse(await probe.execute('computer_act', { window_id, locator, operation: 'invoke', after: { condition: { state: 'present' } } }));
  assert.equal(result.execution_state, 'unknown'); assert.equal(actions, 1);
  await assert.rejects(probe.execute('computer_element', { snapshot_id: prior.snapshot_id, element_id: prior.element.element_id, operation: 'invoke' }), /was consumed/);
  assert.equal(actions, 1);
});

test('postcondition failure preserves completed action and all phases share a deadline', async () => {
  let actions = 0, reads = 0; const budgets = [];
  const provider = computer(async (_handle, signal, options) => {
    budgets.push(options.timeoutMs); await delay(15, undefined, { signal });
    return resolved(element());
  }, async action => {
    if (action.kind === 'read') { reads++; budgets.push(action.timeoutMs); return { value: 'old' }; }
    actions++; await delay(30); return { ok: true };
  });
  const probe = await context(provider), window_id = await listed(probe);
  const result = JSON.parse(await probe.execute('computer_act', { window_id, locator: [{ name: 'Apply' }], operation: 'invoke', timeout_ms: 150,
    after: { condition: { state: 'value', value: 'new' } } }));
  assert.equal(result.execution_state, 'completed'); assert.equal(result.postcondition.fulfilled, false);
  assert.equal(actions, 1); assert.ok(reads > 0); assert.ok(budgets.at(-1) < budgets[0]); assert.ok(result.elapsed_ms < 350);
});

test('invalid after condition and insufficient precondition never dispatch an action', async () => {
  let actions = 0; const probe = await context(computer(async () => absent(), async () => { actions++; })), window_id = await listed(probe);
  await assert.rejects(probe.execute('computer_act', { window_id, locator: [{ name: 'Apply' }], operation: 'invoke', after: { condition: { state: 'value' } } }), /requires a string/);
  const result = JSON.parse(await probe.execute('computer_act', { window_id, locator: [{ name: 'Apply' }], operation: 'invoke', timeout_ms: 100 }));
  assert.equal(result.execution_state, 'not_started'); assert.equal(actions, 0);
});

test('Grid cell read publishes an independent snapshot usable for cell actions', async () => {
  const grid = { ...element('grid'), role: 'DataGrid', patterns: ['grid'] }, cell = { ...element('cell'), patterns: ['selection_item'] };
  const calls = [];
  const probe = await context(computer(async () => resolved(grid), async action => {
    calls.push(action); return action.kind === 'read' ? { cell } : { ok: true };
  })), window_id = await listed(probe);
  const located = JSON.parse(await probe.execute('computer_locate', { window_id, locator: [{ name: 'Records' }] }));
  const result = JSON.parse(await probe.execute('computer_read', { snapshot_id: located.snapshot_id, element_id: grid.element_id, row: 3, column: 2 }));
  assert.notEqual(result.cell_snapshot_id, located.snapshot_id);
  await probe.execute('computer_element', { snapshot_id: result.cell_snapshot_id, element_id: cell.element_id, operation: 'select' });
  assert.equal(calls.at(-1).element.native_token, cell.native_token); assert.equal(calls.at(-1).kind, 'select');
});

test('new wait tools respect observation policy and action respects control policy', async () => {
  const probe = await context(computer(async () => resolved(element())), { observeApproval: 'allow', controlApproval: 'deny' });
  const window_id = await listed(probe), locator = [{ name: 'Apply' }];
  const observed = JSON.parse(await probe.execute('computer_wait', { window_id, locator })); assert.equal(observed.fulfilled, true);
  await assert.rejects(probe.execute('computer_act', { window_id, locator, operation: 'invoke' }), /denies desktop control/);
  await assert.rejects(probe.execute('computer_tree', { window_id, locator, path: [{ name: 'Leaf' }] }), /denies desktop control/);
  await assert.rejects(probe.execute('computer_scroll_find', { window_id, locator, item: [{ name: 'Item' }] }), /denies desktop control/);
});

// 故障只注入computer provider；不手写Cordis工具/权限/上下文服务。
function dataResult(id, path, patterns = ['expand_collapse', 'selection_item']) {
  return { ...resolved({ ...element(id), role: 'TreeItem', patterns }), worker_generation: 'worker',
    trace: path.map((element_id, step) => ({ step, element_id, selection: 'unique' })) };
}
test('incomplete identity trace cannot prove tree branch replacement', async () => {
  let rootReads = 0, dispatches = 0;
  const probe = await context(computer(async (_handle, _signal, options) => {
    if (options.locator.length === 1) return dataResult('tree', ['tree']);
    if (++rootReads === 1) return dataResult('root', ['tree', 'root']);
    return { status: 'incomplete', coverage: { status: 'partial', reason: 'time_limit' }, trace: [], worker_generation: 'worker' };
  }, async action => {
    if (action.kind === 'read') return { expand_state: 'Expanded' };
    dispatches++; return { ok: true };
  }));
  const window_id = await listed(probe);
  const result = JSON.parse(await probe.execute('computer_tree', { window_id, locator: [{ name: 'Tree' }], path: [{ name: 'Root' }, { name: 'Leaf' }], timeout_ms: 100 }));
  assert.equal(result.status, 'timeout'); assert.equal(dispatches, 0); assert.equal(result.selection_state, 'not_started');
});
test('tree expansion obtains a fresh reference after its state read', async () => {
  let queries = 0, stateReadAt = 0, dispatches = 0;
  const probe = await context(computer(async (_handle, _signal, options) => {
    queries++;
    const row = options.locator.length === 1 ? dataResult('tree', ['tree'])
      : options.locator.length === 2 ? dataResult('root', ['tree', 'root']) : dataResult('leaf', ['tree', 'root', 'leaf']);
    row.element.native_token = `query-${queries}`; return row;
  }, async action => {
    if (action.kind === 'read') { stateReadAt = queries; return { expand_state: dispatches ? 'Expanded' : 'Collapsed', selected: dispatches === 2 }; }
    if (action.kind === 'expand' && action.element.native_token === `query-${stateReadAt}`) {
      throw Object.assign(new Error('state read invalidated the observed reference'), { code: 'COMPUTER_TARGET_STALE', executionState: 'not_started' });
    }
    dispatches++; return { ok: true };
  }));
  const window_id = await listed(probe);
  const result = JSON.parse(await probe.execute('computer_tree', { window_id, locator: [{ name: 'Tree' }], path: [{ name: 'Root' }, { name: 'Leaf' }] }));
  assert.equal(result.status, 'selected'); assert.equal(dispatches, 2);
  assert.deepEqual(result.actions.map(action => action.operation), ['expand', 'select']);
});
test('tree workflow retains unknown expansion and never repeats it', async () => {
  let dispatches = 0;
  const probe = await context(computer(async (_handle, _signal, options) => options.locator.length === 1
    ? dataResult('tree', ['tree']) : dataResult('root', ['tree', 'root']), async action => {
    if (action.kind === 'read') return { expand_state: 'Collapsed' };
    dispatches++; throw Object.assign(new Error('provider deadline after dispatch'), { executionState: 'unknown' });
  }));
  const window_id = await listed(probe);
  const result = JSON.parse(await probe.execute('computer_tree', { window_id, locator: [{ name: 'Tree' }], path: [{ name: 'Root' }, { name: 'Leaf' }] }));
  assert.equal(result.status, 'error'); assert.equal(result.selection_state, 'not_started'); assert.equal(dispatches, 1);
  assert.equal(result.actions.length, 1); assert.equal(result.actions[0].execution_state, 'unknown');
});
test('tree workflow stops on branch replacement instead of expanding its namesake', async () => {
  let dispatches = 0;
  const probe = await context(computer(async (_handle, _signal, options) => {
    if (options.locator.length === 1) return dataResult('tree', ['tree']);
    return dispatches ? dataResult('new-root', ['tree', 'new-root']) : dataResult('root', ['tree', 'root']);
  }, async action => {
    if (action.kind === 'read') return { expand_state: 'Collapsed' };
    dispatches++; return { ok: true };
  }));
  const window_id = await listed(probe);
  const result = JSON.parse(await probe.execute('computer_tree', { window_id, locator: [{ name: 'Tree' }], path: [{ name: 'Root' }, { name: 'Leaf' }] }));
  assert.equal(result.status, 'ancestor_changed'); assert.equal(dispatches, 1); assert.equal(result.selection_state, 'not_started');
  assert.equal(result.actions[0].execution_state, 'completed');
});
test('scroll search checks container geometry when a provider reports an outside item onscreen', async () => {
  let dispatches = 0;
  const probe = await context(computer(async (_handle, _signal, options) => {
    if (options.locator.length === 1) return dataResult('container', ['container'], ['scroll']);
    return { ...dataResult('item', ['container', 'item'], ['invoke']),
      element: { ...element('item'), bounds: { x: 10, y: dispatches ? 10 : 500, width: 20, height: 20 } } };
  }, async action => {
    if (action.kind === 'read') return { scroll: { vertical: dispatches ? 50 : 0 } };
    dispatches++; return { ok: true };
  }));
  const window_id = await listed(probe);
  const result = JSON.parse(await probe.execute('computer_scroll_find', { window_id, locator: [{ name: 'Container' }], item: [{ name: 'Item' }], page_wait_ms: 100 }));
  assert.equal(result.status, 'found'); assert.equal(dispatches, 1); assert.equal(result.scrolls, 1);
  assert.equal(result.pages[0].viewport_intersects, false); assert.equal(result.pages[1].viewport_intersects, true);
  assert.equal(result.global_absence_proven, false);
});
test('explicit scroll search rejects missing patterns without input or a global absence claim', async () => {
  let dispatches = 0;
  const probe = await context(computer(async (_handle, _signal, options) => options.locator.length === 1
    ? dataResult('container', ['container'], []) : { ...absent(), trace: [{ element_id: 'container' }], worker_generation: 'worker' },
  async () => { dispatches++; }));
  const window_id = await listed(probe);
  const result = JSON.parse(await probe.execute('computer_scroll_find', { window_id, locator: [{ name: 'Container' }], item: [{ name: 'Missing' }], page_wait_ms: 100 }));
  assert.equal(result.status, 'unsupported'); assert.equal(result.global_absence_proven, false); assert.equal(dispatches, 0);
});
test('explicit scroll search retains an unknown scroll without replaying it', async () => {
  let dispatches = 0;
  const probe = await context(computer(async (_handle, _signal, options) => options.locator.length === 1
    ? dataResult('container', ['container'], ['scroll']) : { ...absent(), trace: [{ element_id: 'container' }], worker_generation: 'worker' },
  async action => {
    if (action.kind === 'read') return { scroll: { vertical: 0 } };
    dispatches++; throw Object.assign(new Error('provider stopped after scroll dispatch'), { executionState: 'unknown' });
  }));
  const window_id = await listed(probe);
  const result = JSON.parse(await probe.execute('computer_scroll_find', { window_id, locator: [{ name: 'Container' }], item: [{ name: 'Missing' }] }));
  assert.equal(result.status, 'error'); assert.equal(dispatches, 1); assert.equal(result.actions.length, 1);
  assert.equal(result.actions[0].execution_state, 'unknown'); assert.equal(result.global_absence_proven, false);
});
test('cancelling a scroll workflow after dispatch stops at one provider action', async () => {
  const controller = new AbortController(); let dispatches = 0, queries = 0;
  const probe = await context(computer(async (_handle, _signal, options) => {
    queries++;
    return options.locator.length === 1 ? dataResult('container', ['container'], ['scroll'])
      : { ...absent(), trace: [{ element_id: 'container' }], worker_generation: 'worker' };
  }, async action => {
    if (action.kind === 'read') return { scroll: { vertical: 0 } };
    dispatches++; controller.abort(new Error('cancel after scroll')); return { ok: true };
  }));
  const window_id = await listed(probe);
  // 正式 ToolRuntime 将已取消调用统一结算为 aborted，不能声称内部返回值已经交付。
  await assert.rejects(probe.execute('computer_scroll_find', { window_id, locator: [{ name: 'Container' }], item: [{ name: 'Missing' }] },
    { ...probe.exec, signal: controller.signal }), /tool call aborted/);
  assert.equal(dispatches, 1); const stoppedAt = queries;
  await delay(30); assert.equal(queries, stoppedAt); assert.equal(dispatches, 1);
});
test('explicit scroll search propagates source errors preserving no-input state', async () => {
  let dispatches = 0;
  const probe = await context(computer(async (_handle, _signal, options) => {
    if (options.locator.length === 1) return dataResult('container', ['container'], ['scroll']);
    throw new Error('real source disconnected');
  }, async () => { dispatches++; }));
  const window_id = await listed(probe);
  const result = JSON.parse(await probe.execute('computer_scroll_find', { window_id, locator: [{ name: 'Container' }], item: [{ name: 'Missing' }] }));
  assert.equal(result.status, 'error'); assert.match(result.error.message, /source disconnected/); assert.equal(dispatches, 0);
  assert.equal(result.global_absence_proven, false);
});
