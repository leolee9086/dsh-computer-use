import assert from 'node:assert/strict';
import test from 'node:test';
import { inputSequenceArgs, keyOptions } from '../src/input-actions.js';

test('validate whole sequence before obtaining any input state', () => {
  assert.throws(() => inputSequenceArgs([{ operation: 'key_down', key: 'control' }, { operation: 'wait', ms: 10001 }]), /ms/);
  assert.throws(() => inputSequenceArgs([{ operation: 'key_up', key: 'control' }]), /matching down/);
  assert.throws(() => inputSequenceArgs([{ operation: 'key_down', key: 'control' }, { operation: 'key', key: 'a', modifiers: ['control'] }]), /overlaps/);
  assert.throws(() => inputSequenceArgs([{ operation: 'wait', ms: 6000 }, { operation: 'wait', ms: 6000 }]), /total/);
});
test('pure keyboard evidence cannot authorize pointer steps', () => {
  assert.throws(() => inputSequenceArgs([{ operation: 'move', x: 1, y: 2 }]), /screenshot_id/);
  assert.throws(() => inputSequenceArgs([{ operation: 'mouse_down', button: 'left' }]), /screenshot_id/);
  const mapped = inputSequenceArgs([{ operation: 'move', x: 10, y: 15 }], (x, y) => ({ x: x * 2 - 100, y: y * 2 }));
  assert.deepEqual(mapped, [{ kind: 'move', point: { x: -80, y: 30 } }]);
});
test('Narrator modifiers and hold/repeat duration are checked', () => {
  assert.deepEqual(keyOptions({ modifiers: ['control', 'insert'], repeat: 2, hold_ms: 100 }), { modifiers: ['control', 'insert'], repeat: 2, holdMs: 100 });
  assert.throws(() => keyOptions({ modifiers: ['insert', 'insert'] }), /unique/);
  assert.throws(() => keyOptions({ repeat: 100, hold_ms: 101 }), /duration/);
});
