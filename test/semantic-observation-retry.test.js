import assert from 'node:assert/strict';
import test from 'node:test';
import { WindowsComputer } from '../src/windows.js';
import { resolveHostConfig } from '../src/config.js';
import { ComputerUseError } from '../src/errors.js';

const observedWindow = { handle: '42', processId: 123, title: 'Owned fixture' };
function changed(overrides = {}) {
  return Object.assign(new ComputerUseError('snapshot_changed: unpublished capture discarded', 'COMPUTER_SNAPSHOT_CHANGED'),
    { executionState: 'not_started', observedWindow, nativeCalls: 7 }, overrides);
}
function page(status, overrides = {}) {
  return { elements: [], consistency: { mode: 'snapshot', status }, worker_generation: 'worker-one',
    result_id: status === 'frozen' ? 'new-result' : undefined, visited_nodes: 2, native_calls: 3, ...overrides };
}
// 替换进程协议端点，不伪造Cordis：测试的是生产观测包装层的代次/身份/截止边界。
function driver(respond) {
  const computer = new WindowsComputer({}, resolveHostConfig({ semanticWorkerCount: 1 }));
  const calls = [];
  computer.semantics.call = async (payload, signal, timeout) => {
    calls.push({ payload: { ...payload }, timeout });
    return respond(calls.length, payload, signal);
  };
  return { computer, calls };
}

test('a discarded unpublished capture restarts on its original window and retains one deadline', async () => {
  const { computer, calls } = driver((number) => {
    if (number === 1) return page('collecting', { next_cursor: 'discarded-cursor' });
    if (number === 2) throw changed();
    return page('frozen', { elements: [{ element_id: 'fresh', name: 'New state' }] });
  });
  try {
    const tree = await computer.accessibilitySnapshot(undefined, undefined, { timeoutMs: 1000 });
    assert.equal(tree.element_id, 'fresh'); assert.equal(tree.acquisition.result_id, 'new-result');
    assert.equal(tree.acquisition.capture_restarts, 1); assert.equal(tree.acquisition.native_calls, 13);
    assert.equal(calls[1].payload.cursor, 'discarded-cursor');
    assert.equal(calls[2].payload.cursor, undefined, 'failed generation cannot become a published continuation');
    assert.deepEqual([calls[2].payload.hwnd, calls[2].payload.processId, calls[2].payload.title], ['42', 123, 'Owned fixture']);
    assert.ok(calls[2].timeout <= calls[0].timeout - 40, 'backoff uses the original absolute deadline');
  } finally { await computer.dispose(); }
});

test('persistent changes allow only two fresh capture restarts', async () => {
  const { computer, calls } = driver(() => { throw changed(); });
  try {
    await assert.rejects(computer.accessibilitySnapshot('42', undefined, { timeoutMs: 1000 }), { code: 'COMPUTER_SNAPSHOT_CHANGED' });
    assert.equal(calls.length, 3); assert.ok(calls[2].timeout < calls[0].timeout - 80);
  } finally { await computer.dispose(); }
});

test('a cursor, live observation, exhausted budget or resource error never starts a replacement result', async () => {
  for (const [options, error] of [
    [{ cursor: 'published-continuation' }, changed()], [{ consistency: 'live' }, changed()],
    [{ timeoutMs: 150 }, changed()], [{}, changed({ code: 'COMPUTER_OPERATION_FAILED' })],
    [{}, changed({ executionState: 'unknown' })], [{}, changed({ observedWindow: undefined })],
    [{ window: { processId: 999, title: 'Owned fixture' } }, changed()],
    [{ window: { processId: 123, title: 'Replacement' } }, changed()],
  ]) {
    const { computer, calls } = driver(() => { throw error; });
    try {
      await assert.rejects(computer.accessibilitySnapshot('42', undefined, options), (actual) => actual === error);
      assert.equal(calls.length, 1);
    } finally { await computer.dispose(); }
  }
});

test('a different window or cancellation does not redirect the observation', async () => {
  const controller = new AbortController();
  for (const cancel of [false, true]) {
    const { computer, calls } = driver(() => { if (cancel) controller.abort(); throw changed(); });
    try {
      await assert.rejects(computer.accessibilitySnapshot(cancel ? '42' : '99', controller.signal), { code: 'COMPUTER_SNAPSHOT_CHANGED' });
      assert.equal(calls.length, 1);
    } finally { await computer.dispose(); }
  }
});
