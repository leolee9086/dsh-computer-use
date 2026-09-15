import assert from 'node:assert/strict';
import test from 'node:test';
import { apply, inject, name } from '../src/prompt.js';

test('workflow prompt is agent-scoped and declares separate browser and desktop evidence', () => {
  let registered;
  const result = apply({
    systemPrompt: {
      section(value) {
        registered = value;
        return 'disposed';
      },
    },
  });
  assert.equal(name, 'dsh-computer-use-workflow-prompt');
  assert.deepEqual(inject, ['systemPrompt']);
  assert.equal(result, 'disposed');
  assert.equal(registered.name, 'dsh-computer-use-workflow');
  assert.match(registered.text, /browser_snapshot/);
  assert.match(registered.text, /computer_accessibility/);
  assert.match(registered.text, /different evidence domains/);
});
