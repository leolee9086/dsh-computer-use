import assert from 'node:assert/strict';
import test from 'node:test';
import { narratorAction } from '../src/narrator.js';
import { resolveHostConfig } from '../src/config.js';
import { assertBasicInput } from '../src/input-actions.js';
import { actionPayload } from '../src/windows.js';
import { LinuxComputer } from '../src/linux.js';
import { MacComputer } from '../src/macos.js';

test('Narrator validates fixed Standard bindings, alternate modifier and stop speech', () => {
  assert.deepEqual(narratorAction('read_selection', 'capslock'), {kind: 'key', key: 'down', modifiers: ['capslock', 'shift'], repeat: 1, holdMs: 0});
  assert.deepEqual(narratorAction('start_reading_document').modifiers, ['insert', 'control']);
  assert.deepEqual(narratorAction('stop_speech').modifiers, []);
  assert.throws(() => narratorAction('constructor'), /unsupported/);
  assert.throws(() => narratorAction('read_current', 'alt'), /modifier/);
});

test('host keeps explicit helper selection and bounds action delay', () => {
  assert.equal(resolveHostConfig({nativeHelperPath: 'selected.exe'}).nativeHelperPath, 'selected.exe');
  assert.throws(() => resolveHostConfig({nativeHelperPath: ''}), /executable path/);
  assert.throws(() => resolveHostConfig({actionDelayMs: 10001}), /10000/);
});

test('max-duration interpolated drag with modifiers fits the native step budget', () => {
  const action = {kind: 'drag', from: {x: 0,y: 0}, to: {x: 100,y: 100}, durationMs: 10000, modifiers: ['alt','control','meta','shift','insert','rightalt','rightcontrol','rightshift']};
  const result = actionPayload(action, 40);
  assert.ok(result.steps.length <= 256);
  assert.equal(result.steps.filter(step => step.kind === 'wait').reduce((total, step) => total + step.ms, 0), 10000);
  assert.throws(() => actionPayload({...action, path: Array.from({length: 120}, () => ({x: 10,y: 10}))}, 40), /256 native steps/);
});

test('basic backends reject ignored extended input before execution', () => {
  for (const platform of ['Linux','macOS']) {
    assert.throws(() => assertBasicInput({kind: 'drag', path: []}, platform), /curved/);
    assert.throws(() => assertBasicInput({kind: 'click', modifiers: ['shift']}, platform), /pointer modifiers/);
    assert.throws(() => assertBasicInput({kind: 'key', repeat: 2}, platform), /repetition/);
    assert.throws(() => assertBasicInput({kind: 'type', focus: {}}, platform), /window-bound/);
    assertBasicInput({kind: 'key', modifiers: ['control'], repeat: 1, holdMs: 0}, platform);
  }
});

test('cross-platform providers forward bounded read arguments and return helper content', async () => {
  const config = {maxAccessibilityDepth: 6, maxAccessibilityBytes: 100000};
  for (const [Computer, elementId] of [[MacComputer, 'ax:77:1,0'], [LinuxComputer, 'atspi:0,1']]) {
    let payload;
    const runner = {async requireAny() {return 'platform-helper';}, async runJson(argv) {payload=JSON.parse(Buffer.from(argv.at(-1),'base64').toString('utf8')); return {value:'content',backend:'contract'};}};
    const computer = new Computer(runner,config);
    const result = await computer.performAccessibility({kind:'read',elementId,element:{process_id:77,name:'Editor'},maxChars:42});
    assert.equal(result.value,'content');
    assert.equal(payload.action.maxChars,42);
    assert.equal(payload.action.name,'Editor');
    assert.equal(payload.action.kind,'read');
    assert.equal(computer.capabilities.semanticReading,true);
    await assert.rejects(() => computer.accessibilitySnapshot(undefined, undefined, {backend: 'uia'}), /native .* backend only/);
    await assert.rejects(() => computer.accessibilitySnapshot(undefined, undefined, {backend: 'msaa'}), /native .* backend only/);
  }
});
