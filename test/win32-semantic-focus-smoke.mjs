import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WindowsComputer } from '../src/windows.js';
import { createRunner } from './win32-runner.mjs';

const runner = createRunner();

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function waitFor(check, description) {
  let lastError;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      const value = await check();
      if (value !== undefined) return value;
    } catch (error) {
      lastError = error;
    }
    await delay(250);
  }
  throw new Error(`${description} did not become available${lastError === undefined ? '' : `: ${lastError.message}`}`);
}

async function snapshotFocusedWindow(window, processId, description) {
  return waitFor(async () => {
    await computer.focusWindow(window);
    const tree = await computer.accessibilitySnapshot();
    return tree?.process_id === processId ? tree : undefined;
  }, description);
}

async function waitForStatus(window, processId, name, description) {
  return waitFor(async () => {
    await computer.focusWindow(window);
    const tree = await computer.accessibilitySnapshot();
    if (tree?.process_id !== processId) return undefined;
    return findElement(tree, (node) => (
      node.role === 'Text' && node.process_id === processId && node.name === name
    )) === undefined ? undefined : tree;
  }, description);
}

function findElement(tree, predicate) {
  const pending = [tree];
  while (pending.length > 0) {
    const node = pending.pop();
    if (node !== null && typeof node === 'object' && predicate(node)) return node;
    if (Array.isArray(node?.children)) {
      for (const child of node.children) pending.push(child);
    }
  }
  return undefined;
}

function requireElement(tree, predicate, description) {
  const element = findElement(tree, predicate);
  if (element === undefined) throw new Error(`the disposable accessibility tree contains no ${description}`);
  return element;
}

const computer = new WindowsComputer(runner, {
  screenshotMaxDimension: 1280,
  screenshotMaxBytes: 12_000_000,
  commandTimeoutMs: 30_000,
  graceMs: 2_000,
  actionDelayMs: 0,
  maxAccessibilityNodes: 1000,
  maxAccessibilityDepth: 8,
  maxAccessibilityBytes: 1_000_000,
  maxAccessibilityActionCandidates: 5_000,
});

const directory = await mkdtemp(join(tmpdir(), 'dsh-computer-use-focus-'));
const script = join(directory, 'focus-smoke.ps1');
const title = `DSH Computer Use Semantic Focus Smoke ${randomUUID()}`;
await writeFile(script, `Add-Type -AssemblyName PresentationFramework
Add-Type -AssemblyName PresentationCore
Add-Type -AssemblyName WindowsBase
[xml]$xaml = @"
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation" xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml" Title="${title}" Width="480" Height="240">
  <Grid Margin="16">
    <StackPanel>
      <TextBox x:Name="Target" Text="semantic-focus-target" Margin="0,0,0,8" />
      <CheckBox x:Name="EnabledOption" Content="Enabled option" Margin="0,0,0,8" />
      <Button x:Name="Commit" Content="Commit" Margin="0,0,0,8" />
      <TextBlock x:Name="Status" Text="Ready" />
    </StackPanel>
  </Grid>
</Window>
"@
$reader = New-Object System.Xml.XmlNodeReader $xaml
$form = [Windows.Markup.XamlReader]::Load($reader)
$target = $form.FindName('Target')
$enabledOption = $form.FindName('EnabledOption')
$commit = $form.FindName('Commit')
$status = $form.FindName('Status')
$target.Add_TextChanged({ if ($target.IsLoaded) { $status.Text = 'Text saved' } })
$enabledOption.Add_Checked({ $status.Text = 'Option enabled' })
$commit.Add_Click({ $status.Text = 'Committed' })
$form.Add_ContentRendered({ $target.Focus() })
$form.ShowDialog()
`, 'utf8');
const windowProcess = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-STA', '-File', script], {
  stdio: 'ignore',
  windowsHide: false,
});

try {
  assert.ok(Number.isInteger(windowProcess.pid), 'the disposable WinForms process did not report a process id');
  const window = await waitFor(async () => {
    const windows = await computer.listWindows();
    return windows.find((candidate) => candidate.title === title && candidate.processId === windowProcess.pid);
  }, 'disposable WinForms window');
  await computer.focusWindow(window);
  const before = await snapshotFocusedWindow(window, windowProcess.pid, 'focused disposable WPF window');
  const target = findElement(before, (node) => (
    node.role === 'Edit'
    && node.process_id === windowProcess.pid
    && node.enabled === true
    && node.offscreen !== true
    && typeof node.element_id === 'string'
  ));
  if (target === undefined) {
    const nodes = [];
    const pending = [before];
    while (pending.length > 0) {
      const node = pending.pop();
      if (node !== null && typeof node === 'object') {
        nodes.push({ processId: node.process_id, role: node.role, name: node.name, enabled: node.enabled, focused: node.focused, focusable: node.focusable, offscreen: node.offscreen, patterns: node.patterns, elementId: node.element_id });
      }
      if (Array.isArray(node?.children)) pending.push(...node.children);
    }
    throw new Error(`the disposable accessibility tree contains no visible enabled Edit element: ${JSON.stringify(nodes)}`);
  }
  await computer.performAccessibility({ kind: 'focus', elementId: target.element_id, element: target });
  const focusedTree = await snapshotFocusedWindow(window, windowProcess.pid, 'focused Edit accessibility tree');
  const restored = requireElement(focusedTree, (node) => (
    node.role === 'Edit' && node.process_id === windowProcess.pid && node.focused === true
  ), 'focused Edit element after focus');
  assert.equal(restored.focused, true, 'the semantic element was not focused after the action');

  const textTarget = requireElement(focusedTree, (node) => (
    node.role === 'Edit' && node.process_id === windowProcess.pid && node.patterns?.includes('value')
  ), 'editable ValuePattern control');
  await computer.performAccessibility({
    kind: 'set_value', elementId: textTarget.element_id, element: textTarget, value: 'updated by semantic action',
  });
  const textTree = await waitForStatus(window, windowProcess.pid, 'Text saved', 'set_value status');
  assert.ok(findElement(textTree, (node) => node.role === 'Text' && node.name === 'Text saved'), 'set_value did not update the disposable WPF status');

  const checkbox = requireElement(textTree, (node) => (
    node.role === 'CheckBox' && node.process_id === windowProcess.pid && node.patterns?.includes('toggle')
  ), 'toggleable CheckBox');
  await computer.performAccessibility({ kind: 'toggle', elementId: checkbox.element_id, element: checkbox });
  const toggleTree = await waitForStatus(window, windowProcess.pid, 'Option enabled', 'toggle status');
  assert.ok(findElement(toggleTree, (node) => node.role === 'Text' && node.name === 'Option enabled'), 'toggle did not update the disposable WPF status');

  const button = requireElement(toggleTree, (node) => (
    node.role === 'Button' && node.process_id === windowProcess.pid && node.patterns?.includes('invoke')
  ), 'invokable Button');
  await computer.performAccessibility({ kind: 'invoke', elementId: button.element_id, element: button });
  const invokeTree = await waitForStatus(window, windowProcess.pid, 'Committed', 'invoke status');
  assert.ok(findElement(invokeTree, (node) => node.role === 'Text' && node.name === 'Committed'), 'invoke did not update the disposable WPF status');

  console.log(JSON.stringify({
    operation: 'focus-set_value-toggle-invoke-disposable-wpf-controls',
    window: { id: window.id, processId: window.processId, title: window.title },
    target: { elementId: target.element_id, role: target.role, name: target.name, focusable: target.focusable },
    focused: { elementId: restored.element_id, role: restored.role, focused: restored.focused },
    semanticActions: {
      setValue: { elementId: textTarget.element_id, status: 'Text saved' },
      toggle: { elementId: checkbox.element_id, status: 'Option enabled' },
      invoke: { elementId: button.element_id, status: 'Committed' },
    },
  }, null, 2));
} finally {
  if (Number.isInteger(windowProcess.pid)) {
    // 用 spawn 而不是 execFile：这里不需要等结果，也不需要捕获输出 —— 共享 runner
    // 已经把 execFile 那条路换成了 spawn（原生 helper 的请求体要走 stdin）。
    spawn('taskkill', ['/pid', String(windowProcess.pid), '/t', '/f'], { stdio: 'ignore' }).unref();
  }
  await rm(directory, { recursive: true, force: true });
}
