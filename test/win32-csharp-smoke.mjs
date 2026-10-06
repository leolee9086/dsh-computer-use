// Run against the actual Node/Electron executable. This checks native loading,
// the relocated compiler's companion assembly and concurrent bridge reuse.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { loadCSharpFile } from '../src/csharp.js';

assert.equal(process.platform, 'win32', 'This is a Windows native runtime smoke test');
if (process.env.DSH_EXPECT_ELECTRON === '1') {
  assert.ok(process.versions.electron, 'The provided executable must run Electron');
}
const call = await loadCSharpFile('windows-narrator.cs');
const initial = await call({ kind: 'status' });
assert.equal(typeof initial.running, 'boolean');
assert.ok(Number.isInteger(initial.windowsSessionId));
assert.equal(initial.speechCaptured, false);
assert.equal(initial.virtualCursorObserved, false);
const results = await Promise.all(Array.from({ length: 12 }, () => call({ kind: 'status' })));
for (const result of results) {
  assert.equal(result.windowsSessionId, initial.windowsSessionId);
  assert.equal(result.speechCaptured, false);
}
const compiler = process.env.EDGE_CS_NATIVE;
assert.ok(compiler && existsSync(compiler));
assert.ok(existsSync(join(dirname(compiler), 'edge-cs-base.dll')), 'Relocation must preserve compiler dependencies');
assert.match(dirname(compiler), /[a-f0-9]{64}$/);
const nativeVersion = basename(dirname(process.env.EDGE_NATIVE));
assert.equal(nativeVersion, (process.versions.electron ?? process.versions.node).split('.')[0]);
console.log(JSON.stringify({
  runtime: { node: process.versions.node, electron: process.versions.electron ?? null, abi: process.versions.modules },
  bridge: process.versions.electron ? 'electron-edge-js' : 'edge-js',
  checks: ['matching native binary', 'compiler companion assembly', 'Narrator status', '12 concurrent bridge calls'],
  narrator: initial,
}, null, 2));
