// 一次性 WinForms 双窗口：实际核对后台像素、前台保持、消息点击和输入释放。
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WindowsComputer } from '../src/windows.js';
import { createRunner } from './win32-runner.mjs';
import { flattenAccessibilityTree } from '../src/semantics.js';
const runner = createRunner();
const directory = await mkdtemp(join(tmpdir(), 'dsh-native-expansion-'));
// 该开发盘继承 Low 文件标签，会让 exe 启动降级。验证真实产物的独立部署，不修改工作区 ACL。
const nativeHelperPath = join(directory, 'dsh-screen.exe');
await copyFile(new URL('../native/release/dsh-screen.exe', import.meta.url), nativeHelperPath);
const driver = new WindowsComputer(runner, { nativeHelperPath, actionDelayMs: 50, screenshotMaxDimension: 2048, screenshotMaxBytes: 8 * 1024 * 1024, maxAccessibilityNodes: 500, maxAccessibilityDepth: 10, maxAccessibilityActionCandidates: 2000 });
const title = `DSH Native ${randomUUID()}`;
const coverTitle = `${title} cover`;
const fixture = join(directory, 'fixture.ps1');
const shotPath = join(directory, 'background.png');
// 编译的事件处理避免 PowerShell scriptblock 对消息循环的调度影响。
await writeFile(fixture, `\uFEFFAdd-Type -ReferencedAssemblies System.Windows.Forms,System.Drawing -TypeDefinition @'
using System;
using System.Drawing;
using System.Windows.Forms;
// 单行 TextBox 的组合键会先走 ProcessCmdKey；在应用契约中显式定义全选。
// 整个测试仍由真正的 SendInput、WinForms 消息循环和 UIA 回读验证。
public class FixtureEdit : TextBox {
 protected override bool ProcessCmdKey(ref Message message, Keys keys) {
  if(keys==(Keys.Control|Keys.A)) {SelectAll(); return true;}
  return base.ProcessCmdKey(ref message,keys);
 }
}
public static class Fixture {
 public static void Run() {
  var form = new Form {Text="${title}", Width=500, Height=300, Left=100, Top=120, StartPosition=FormStartPosition.Manual, KeyPreview=true, BackColor=Color.CornflowerBlue};
  var edit = new FixtureEdit {Name="Input", AccessibleName="Native editor", Text="native initial", Width=300, Top=20, Left=20};
  var button = new Button {Text="Background commit", AccessibleName="Background commit", Top=80, Left=20, Width=180};
  var label = new Label {Text="Ready native", Top=140, Left=20, Width=300};
  var surface = new Panel {AccessibleName="Message surface", Left=330, Top=20, Width=100, Height=100};
  button.Click += (sender,e) => label.Text="Background committed";
  button.MouseUp += (sender,e) => label.Text="Background mouse messages received";
  surface.MouseUp += (sender,e) => label.Text="Background mouse messages received";
  form.Controls.AddRange(new Control[] {edit,button,label,surface});
  var cover = new Form {Text="${coverTitle}", TopMost=true, Width=500, Height=300, Left=100, Top=120, StartPosition=FormStartPosition.Manual, BackColor=Color.Magenta};
  form.KeyDown += (sender,e) => {if(e.KeyCode==Keys.F9) {cover.WindowState=FormWindowState.Normal; cover.Show(); cover.Activate();}};
  form.Shown += (sender,e) => {cover.Show(); cover.Activate();};
  Application.Run(form);
  cover.Dispose();
 }
}
'@
[Fixture]::Run()
`, 'utf8');
const processFixture = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-STA', '-File', fixture], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: false });
processFixture.stdout.on('data', chunk => console.log(`fixture: ${chunk.toString().trim()}`));
let fixtureError = '';
processFixture.stderr.on('data', (chunk) => { fixtureError += chunk; });
const until = async (fn, label) => {
  for (let index = 0; index < 40; index += 1) {
    const result = await fn();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`${label}: ${fixtureError}`);
};
const checks = [];
try {
  const target = await until(async () => (await driver.listWindows()).find((window) => window.title === title && window.processId === processFixture.pid), 'target ready');
  const cover = await until(async () => (await driver.listWindows()).find((window) => window.title === coverTitle && window.processId === processFixture.pid), 'cover ready');
  const focused = async () => (await driver.listWindows()).find((window) => window.focused)?.id;
  console.log(JSON.stringify({ stage: 'fixture ready', target, cover }));
  await until(async () => (await focused()) === cover.id, 'cover must actually occlude the target before capture');
  const before = await focused();
  console.log(JSON.stringify({ stage: 'background capture', before }));
  const image = await driver.captureWindow(target, { background: true, saveTo: shotPath });
  assert.equal(image.captureMode, 'print-window');
  assert.equal(await focused(), before);
  const pixels = await runner.runJson(['powershell.exe', '-NoProfile', '-Command', `Add-Type -AssemblyName System.Drawing; $bitmap=[Drawing.Bitmap]::new('${shotPath}'); $pixel=$bitmap.GetPixel($bitmap.Width-40,$bitmap.Height-40); @{r=$pixel.R;g=$pixel.G;b=$pixel.B;width=$bitmap.Width;height=$bitmap.Height}|ConvertTo-Json -Compress; $bitmap.Dispose()`]);
  assert.deepEqual([pixels.r, pixels.g, pixels.b], [100, 149, 237], 'background target pixels must differ from magenta cover');
  checks.push('PrintWindow target pixels under full occlusion; foreground preserved');

  const childList = await driver.childWindows(target);
  const button = childList.windows.find((window) => window.title === 'Background commit' && /Button/i.test(window.className));
  const edit = childList.windows.find((window) => /Edit/i.test(window.className));
  const surface = childList.windows.find((window) => /Window/i.test(window.className) && window.clientBounds.width === 100);
  assert.ok(button); assert.ok(edit); assert.ok(surface, JSON.stringify(childList));
  const messageBefore = await focused();
  const result = await driver.performWindowMessage(target, surface, { kind: 'click', x: 40, y: 10, button: 'left' });
  assert.equal(await focused(), messageBefore, 'foreground checked immediately after message delivery');
  assert.equal(result.delivered, true);
  assert.equal(result.applicationResultVerified, false);
  const nodes = async () => flattenAccessibilityTree(await driver.accessibilitySnapshot(target.id));
  await until(async () => (await nodes()).some((node) => node.name === 'Background mouse messages received' || node.name === 'Background committed'), 'background mouse messages');
  assert.equal(result.foregroundChanged, false);
  checks.push('child HWND mouse messages received by non-focusable surface; foreground preserved');
  const buttonBefore = await focused();
  const buttonResult = await driver.performWindowMessage(target, button, { kind: 'click', x: 40, y: 10, button: 'left' });
  assert.equal(buttonResult.foregroundChanged, (await focused()) !== buttonBefore);
  const afterMessages = await focused();
  checks.push(`button message activation measured: foregroundChanged=${buttonResult.foregroundChanged}`);
  await assert.rejects(() => driver.performWindowMessage(target, { ...button, processId: button.processId + 1 }, { kind: 'click', x: 40, y: 10, button: 'left' }), /身份/);
  checks.push('stale child PID rejected');

  await driver.manageWindow(target, { kind: 'resize', width: 520, height: 320 });
  assert.equal(await focused(), afterMessages);
  const resized = (await driver.listWindows()).find((window) => window.id === target.id);
  assert.equal(resized.bounds.width, 520); assert.equal(resized.bounds.height, 320);
  checks.push('resize without activation');

  await driver.manageWindow(cover, { kind: 'minimize' });
  const focus = { handle: target.id, processId: target.processId, title: target.title };
  const editPoint = { x: edit.clientBounds.x + 30, y: edit.clientBounds.y + 10 };
  await driver.perform({ kind: 'click', point: editPoint, button: 'left', clickCount: 1, focus });
  await driver.perform({ kind: 'key', key: 'a', modifiers: ['control'], holdMs: 50, focus });
  const selectedEditor = (await nodes()).find(node => node.name === 'Native editor');
  await until(async () => {
    const selection = await driver.performAccessibility({ kind: 'read', elementId: selectedEditor.element_id, element: selectedEditor });
    return selection.selection.some(range => range.text === 'native initial');
  }, 'modifier-driven SelectAll must finish in the application');
  await driver.perform({ kind: 'type', text: 'native sequence text', focus });
  const editor = (await nodes()).find((node) => node.name === 'Native editor' && node.role === 'Edit');
  assert.equal((await driver.performAccessibility({ kind: 'read', elementId: editor.element_id, element: editor })).value, 'native sequence text');
  checks.push('native modifier selection and Unicode typing');

  await driver.perform({ kind: 'sequence', focus, steps: [{ kind: 'keyDown', key: 'control' }, { kind: 'wait', ms: 20 }] });
  const keyState = async () => runner.runJson(['powershell.exe', '-NoProfile', '-Command', `Add-Type 'using System.Runtime.InteropServices; public class Keys { [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int key); }'; @{control=[Keys]::GetAsyncKeyState(17);left=[Keys]::GetAsyncKeyState(1)}|ConvertTo-Json -Compress`]);
  assert.ok((await keyState()).control >= 0);
  checks.push('keyDown automatically released at end');
  await driver.perform({ kind: 'sequence', focus, steps: [{ kind: 'move', point: editPoint }, { kind: 'mouseDown', button: 'left' }, { kind: 'wait', ms: 20 }] });
  assert.ok((await keyState()).left >= 0);
  checks.push('mouseDown automatically released at end');
  await assert.rejects(() => driver.perform({ kind: 'sequence', focus, steps: [{ kind: 'keyDown', key: 'control' }, { kind: 'key', key: 'f9', modifiers: [] }, { kind: 'wait', ms: 100 }, { kind: 'key', key: 'x', modifiers: [] }] }), /step/);
  assert.ok((await keyState()).control >= 0);
  await until(async () => (await focused()) === cover.id, 'the application must finish activating its cover after F9');
  checks.push('stop after focus changes and release held control');

  await driver.manageWindow(target, { kind: 'minimize' });
  await assert.rejects(() => driver.captureWindow(target, { background: true }), /最小化/);
  const minimizedTarget = (await driver.listWindows()).find(window => window.id === target.id);
  assert.equal(minimizedTarget?.minimized, true, 'a new list must discover the minimized target');
  await driver.focusWindow(minimizedTarget);
  assert.equal(await focused(), target.id);
  checks.push('background minimized explicit error; new list discovers minimized target and focus restores it');
  console.log(JSON.stringify({ fixture: { pid: processFixture.pid, title }, beforeForeground: before, checks }, null, 2));
} finally {
  await driver.dispose();
  processFixture.kill();
  await new Promise((resolve) => processFixture.exitCode !== null ? resolve() : processFixture.once('exit', resolve));
  await rm(directory, { recursive: true, force: true });
}
