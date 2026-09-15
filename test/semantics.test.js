import assert from 'node:assert/strict';
import test from 'node:test';
import {
  accessibilityElementById,
  findAccessibilityElements,
  flattenAccessibilityTree,
} from '../src/semantics.js';

const tree = {
  element_id: 'uia:42,1',
  role: 'Window',
  name: 'Settings',
  enabled: true,
  offscreen: false,
  patterns: [],
  children: [
    {
      element_id: 'uia:42,2',
      role: 'Button',
      name: 'Save changes',
      automation_id: 'saveButton',
      enabled: true,
      focusable: true,
      offscreen: false,
      patterns: ['invoke'],
      bounds: { x: 12, y: 24, width: 100, height: 32 },
      children: [],
    },
    {
      element_id: 'uia:42,3',
      role: 'Edit',
      name: 'Name',
      automation_id: 'nameInput',
      enabled: true,
      offscreen: false,
      patterns: ['value'],
      children: [],
    },
    {
      element_id: 'uia:42,4',
      role: 'Button',
      name: 'Archived',
      enabled: true,
      offscreen: true,
      patterns: ['invoke'],
      children: [],
    },
    {
      element_id: 'uia:42,5',
      role: 'Button',
      name: 'Disabled',
      enabled: false,
      offscreen: false,
      patterns: ['invoke'],
      children: [],
    },
  ],
};

test('flattenAccessibilityTree keeps model-safe actionable fields', () => {
  const elements = flattenAccessibilityTree(tree);
  assert.deepEqual(elements.map((element) => element.element_id), ['uia:42,1', 'uia:42,2', 'uia:42,3', 'uia:42,4', 'uia:42,5']);
  assert.deepEqual(elements[1].bounds, { x: 12, y: 24, width: 100, height: 32 });
  assert.deepEqual(elements[1].patterns, ['invoke']);
  assert.equal(elements[1].focusable, true);
});

test('findAccessibilityElements matches visible enabled semantics by default', () => {
  const found = findAccessibilityElements(tree, {
    name: 'save',
    role: 'button',
    match: 'contains',
  }, 10);
  assert.deepEqual(found.map((element) => element.element_id), ['uia:42,2']);
  assert.equal(found[0].automation_id, 'saveButton');
});

test('findAccessibilityElements supports exact automation-id matching', () => {
  const found = findAccessibilityElements(tree, {
    automationId: 'nameInput',
    match: 'exact',
  }, 10);
  assert.deepEqual(found.map((element) => element.element_id), ['uia:42,3']);
});

test('findAccessibilityElements excludes offscreen elements unless requested', () => {
  const normal = findAccessibilityElements(tree, { role: 'button', match: 'exact' }, 10);
  const all = findAccessibilityElements(tree, {
    role: 'button',
    match: 'exact',
    includeOffscreen: true,
  }, 10);
  assert.deepEqual(normal.map((element) => element.element_id), ['uia:42,2']);
  assert.deepEqual(all.map((element) => element.element_id), ['uia:42,2', 'uia:42,4']);
});

test('findAccessibilityElements requires an explicit semantic selector', () => {
  assert.throws(() => findAccessibilityElements(tree, {}, 10), /requires name, role, or automation_id/);
});

test('accessibilityElementById returns no result for missing ids', () => {
  assert.equal(accessibilityElementById(tree, 'uia:42,404'), undefined);
  assert.equal(accessibilityElementById(tree, 'uia:42,2').name, 'Save changes');
});
