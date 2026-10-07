// 真机扩展验收：只操作本次创建的 HWND/PID，读取和语义动作无需截图或提窗。
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WindowsComputer } from '../src/windows.js';
import { flattenAccessibilityTree } from '../src/semantics.js';
import { createRunner } from './win32-runner.mjs';
const driver = new WindowsComputer(createRunner(), {
  screenshotMaxDimension: 1280, screenshotMaxBytes: 12000000,
  actionDelayMs: 0, maxAccessibilityNodes: 1000, maxAccessibilityDepth: 12,
  maxAccessibilityActionCandidates: 5000,
});
const directory = await mkdtemp(join(tmpdir(), 'dsh-expansion-'));
const title = `DSH Expansion ${randomUUID()}`;
const script = join(directory, 'fixture.ps1');
await writeFile(script, `Add-Type -AssemblyName PresentationFramework
Add-Type -AssemblyName PresentationCore
Add-Type -AssemblyName WindowsBase
[xml]$xaml = @'
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation" xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml" Title="${title}" Width="560" Height="420" ShowActivated="False">
<StackPanel Margin="16">
<TextBox x:Name="Edit" Text="editable native value" AutomationProperties.AutomationId="fixture-edit"/>
<RichTextBox x:Name="Document" Height="100" AutomationProperties.AutomationId="fixture-document"><FlowDocument><Paragraph>Native document alpha beta gamma</Paragraph></FlowDocument></RichTextBox>
<Slider x:Name="Range" Minimum="0" Maximum="100" Value="20" AutomationProperties.AutomationId="fixture-range"/>
<ListBox x:Name="Choices" SelectionMode="Multiple" AutomationProperties.AutomationId="fixture-choices"><ListBoxItem>First choice</ListBoxItem><ListBoxItem>Second choice</ListBoxItem></ListBox>
<Button x:Name="Commit" Content="Commit fixture" AutomationProperties.AutomationId="fixture-commit"/>
<TextBlock x:Name="Status" Text="Ready" AutomationProperties.AutomationId="fixture-status"/>
</StackPanel></Window>
'@
$form=[Windows.Markup.XamlReader]::Load((New-Object System.Xml.XmlNodeReader $xaml))
$status=$form.FindName('Status')
$form.FindName('Commit').Add_Click({$status.Text='Committed fixture'})
$form.ShowDialog() | Out-Null
`, 'utf8');
const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-STA', '-File', script], { stdio: 'ignore', windowsHide: true });
const checks = [];
const until = async (fn) => {
  for (let index = 0; index < 40; index++) { const value = await fn(); if (value) return value; await new Promise((r) => setTimeout(r, 150)); }
  throw new Error('fixture did not reach expected state');
};
try {
  const window = await until(async () => (await driver.listWindows()).find((w) => w.title === title && w.processId === child.pid));
  const snapshot = () => driver.accessibilitySnapshot(window.id, undefined, { window });
  const find = async (id) => {
    const element = flattenAccessibilityTree(await snapshot()).find((e) => e.automation_id === id || e.name === id);
    assert.ok(element, `missing ${id}`); return element;
  };
  const perform = async (id, kind, parameters = {}) => {
    const element = await find(id);
    return driver.performAccessibility({ kind, elementId: element.element_id, element, hwnd: window.id, ...parameters });
  };
  const before = (await driver.listWindows()).find((w) => w.focused)?.id;
  const initial = await perform('fixture-document', 'read', { maxChars: 1024 });
  assert.match(initial.text, /Native document alpha beta gamma/); checks.push('TextPattern document');
  await perform('fixture-document', 'select_text', { text: 'alpha beta' });
  const selected = await perform('fixture-document', 'read', { maxChars: 1024 });
  assert.equal(selected.selection[0].text, 'alpha beta'); checks.push('TextPattern selection');
  await perform('fixture-edit', 'set_value', { value: 'updated semantic value' });
  assert.equal((await perform('fixture-edit', 'read')).value, 'updated semantic value'); checks.push('ValuePattern read/write');
  await perform('fixture-range', 'set_range', { number: 73 });
  assert.equal((await perform('fixture-range', 'read')).range.value, 73); checks.push('RangeValuePattern');
  await perform('First choice', 'select');
  await perform('Second choice', 'add_to_selection');
  assert.equal((await perform('fixture-choices', 'read')).selected_elements.length, 2); checks.push('multiple selection');
  await perform('First choice', 'remove_from_selection');
  assert.equal((await perform('fixture-choices', 'read')).selected_elements.length, 1); checks.push('remove selection');
  await perform('fixture-commit', 'invoke');
  await until(async () => (await find('fixture-status')).name === 'Committed fixture'); checks.push('background invoke');
  const button = await find('fixture-commit');
  await assert.rejects(() => driver.performAccessibility({ kind: 'invoke', elementId: button.element_id, element: { ...button, name: 'changed identity' }, hwnd: window.id }), /stale_target/); checks.push('stale identity rejected');
  const after = (await driver.listWindows()).find((w) => w.focused)?.id;
  // TextRange.Select 可能按应用设计改变键盘焦点，记录实际结果而不把它当后台承诺。
  console.log(JSON.stringify({ fixture: { pid: child.pid, title }, checks, foreground: { before, after, preserved: before === after } }, null, 2));
} finally {
  await driver.dispose();
  child.kill();
  await new Promise((resolve) => child.exitCode !== null ? resolve() : child.once('exit', resolve));
  await rm(directory, { recursive: true, force: true });
}
