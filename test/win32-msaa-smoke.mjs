import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WindowsComputer } from '../src/windows.js';
import { flattenAccessibilityTree } from '../src/semantics.js';
import { createRunner } from './win32-runner.mjs';
const driver = new WindowsComputer(createRunner(), { maxAccessibilityNodes: 500, maxAccessibilityDepth: 10, maxAccessibilityActionCandidates: 2000 });
const directory = await mkdtemp(join(tmpdir(), 'dsh-msaa-'));
const script = join(directory, 'fixture.ps1');
const title = `DSH MSAA ${randomUUID()}`;
await writeFile(script, `Add-Type -AssemblyName System.Windows.Forms
$form=New-Object Windows.Forms.Form
$form.Text='${title}'; $form.Width=400; $form.Height=240
$edit=New-Object Windows.Forms.TextBox
$edit.AccessibleName='Legacy editor'; $edit.Text='legacy initial value'; $edit.Width=300; $edit.Top=20
$button=New-Object Windows.Forms.Button
$button.AccessibleName='Commit legacy'; $button.Text='Commit legacy'; $button.Top=70; $button.Width=150
$label=New-Object Windows.Forms.Label
$label.Text='Legacy ready'; $label.Top=120; $label.Width=300
$button.Add_Click({$label.Text='Legacy committed'})
$form.Controls.AddRange(@($edit,$button,$label))
$form.ShowDialog() | Out-Null
`, 'utf8');
const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-STA', '-File', script], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: false });
let fixtureError = '';
child.stderr.on('data', (chunk) => { fixtureError += chunk; });
const until = async (fn) => {
  for (let i = 0; i < 40; i++) { const value = await fn(); if (value) return value; await new Promise((r) => setTimeout(r, 150)); }
  throw new Error(`MSAA fixture not ready: ${fixtureError}`);
};
try {
  const window = await until(async () => (await driver.listWindows()).find((w) => w.processId === child.pid && w.title === title));
  const nodes = async () => flattenAccessibilityTree(await driver.accessibilitySnapshot(window.id, undefined, { backend: 'msaa', window }));
  const find = async (name) => { const all = await nodes(); const e = all.find((e) => e.name === name && (name === 'Legacy editor' ? e.role === 'Edit' : e.role === 'Button')); assert.ok(e, `missing ${name}: ${JSON.stringify(all.map((e) => ({name:e.name,role:e.role,patterns:e.patterns})))}`); return e; };
  let editor = await find('Legacy editor');
  assert.equal(editor.backend, 'msaa');
  const read = await driver.performAccessibility({ kind: 'read', elementId: editor.element_id, element: editor });
  assert.equal(read.value, 'legacy initial value');
  await driver.performAccessibility({ kind: 'set_value', elementId: editor.element_id, element: editor, value: 'updated legacy value' });
  editor = await find('Legacy editor');
  assert.equal((await driver.performAccessibility({ kind: 'read', elementId: editor.element_id, element: editor })).value, 'updated legacy value');
  const button = await find('Commit legacy');
  await driver.performAccessibility({ kind: 'invoke', elementId: button.element_id, element: button });
  await until(async () => (await nodes()).some((e) => e.name === 'Legacy committed'));
  await assert.rejects(() => driver.performAccessibility({ kind: 'invoke', elementId: button.element_id, element: { ...button, process_id: child.pid + 1 } }), /process identity changed/);
  console.log(JSON.stringify({ fixture: { pid: child.pid, title }, checks: ['direct MSAA tree', 'IAccessible read', 'IAccessible value write', 'default action', 'PID identity rejected'] }, null, 2));
} finally {
  child.kill(); await new Promise((r) => child.exitCode !== null ? r() : child.once('exit', r));
  await rm(directory, { recursive: true, force: true });
}
