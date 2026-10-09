import test from 'node:test';
import assert from 'node:assert/strict';
import { windowQueryOptions, validateRelatedWindows } from '../src/window-query.js';

const target = { id: '10', processId: 200, threadId: 300 };
// 纯协议数据：跨进程 owner 是合法关系，不能靠 PID 相等替代真实 owner 链。
const row = () => ({ id: '20', title: '', processId: 201, threadId: 301, className: '#32770', ownerId: '11', ownerChain: ['11', '10'],
  bounds: { x: -100, y: 50, width: 120, height: 80 }, focused: false, minimized: false });
const result = (windows = [row()]) => ({ source: 'win32_related_windows', anchorId: '10', relation: 'owned', windows, visited: 3, coverage: 'complete', stopReason: 'complete' });

test('window query retains explicit empty title and exact class, with bounded named relations', () => {
  assert.deepEqual(windowQueryOptions({ title: '', class_name: '#32770' }), { relation: 'owned', maxNodes: 1024, title: '', className: '#32770' });
  for (const input of [null, [], { unknown: true }, { relation: 'parent' }, { class_name: '' }, { max_windows: 0 }, { max_windows: 4097 }, { title: 'x'.repeat(1025) }]) {
    assert.throws(() => windowQueryOptions(input));
  }
});

test('real owner chain can cross processes; thread and process correlation remain separate', () => {
  const owned = result(); assert.equal(validateRelatedWindows(owned, target, windowQueryOptions({})), owned);
  const processResult = { ...owned, relation: 'same_process' };
  assert.throws(() => validateRelatedWindows(processResult, target, windowQueryOptions({ relation: 'same_process' })), /requested relation/);
  const threadResult = { ...owned, relation: 'same_thread' };
  assert.throws(() => validateRelatedWindows(threadResult, target, windowQueryOptions({ relation: 'same_thread' })), /requested relation/);
  const correlated = { ...row(), processId: 200, threadId: 300, ownerId: null, ownerChain: [] };
  assert.throws(() => validateRelatedWindows(result([correlated]), target, windowQueryOptions({})), /requested relation/);
  validateRelatedWindows({ ...threadResult, windows: [correlated] }, target, windowQueryOptions({ relation: 'same_thread' }));
});

test('partial zero and one candidate remain partial, while inconsistent scope or coverage is refused', () => {
  const options = windowQueryOptions({ max_windows: 3 });
  for (const windows of [[], [row()]]) {
    const partial = { ...result(windows), coverage: 'partial', stopReason: 'node_budget' };
    assert.equal(validateRelatedWindows(partial, target, options).coverage, 'partial');
  }
  for (const patch of [{ anchorId: '99' }, { source: 'legacy' }, { relation: 'same_thread' }, { coverage: 'complete', stopReason: 'time_budget' },
    { coverage: 'partial', stopReason: 'complete' }, { visited: 4 }, { visited: 0 }]) {
    assert.throws(() => validateRelatedWindows({ ...result(), ...patch }, target, options), /scope\/coverage/);
  }
});

test('native window identities, owner chains and requested filters cannot be substituted', () => {
  const options = windowQueryOptions({ title: '', class_name: '#32770' });
  for (const patch of [{ id: '0' }, { id: '10' }, { ownerId: '99' }, { ownerChain: ['11', '11'] }, { ownerChain: ['20', '10'], ownerId: '20' },
    { bounds: { x: 0, y: 0, width: 0, height: 1 } }, { threadId: 0 }, { processId: 0 }, { title: 'other' }, { className: 'SysShadow' }]) {
    assert.throws(() => validateRelatedWindows(result([{ ...row(), ...patch }]), target, options));
  }
  assert.throws(() => validateRelatedWindows(result([row(), row()]), target, options), /window identity/);
});
