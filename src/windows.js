import { Buffer } from 'node:buffer';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ComputerUseError, unsupported } from './errors.js';
import { assertFinitePoint, pngDimensions } from './geometry.js';

const KEY_CODES = {
  alt: 0x12,
  backspace: 0x08,
  control: 0x11,
  delete: 0x2e,
  down: 0x28,
  end: 0x23,
  enter: 0x0d,
  escape: 0x1b,
  home: 0x24,
  left: 0x25,
  meta: 0x5b,
  pagedown: 0x22,
  pageup: 0x21,
  right: 0x27,
  shift: 0x10,
  space: 0x20,
  tab: 0x09,
  up: 0x26,
};

for (let code = 0; code < 26; code += 1) KEY_CODES[String.fromCharCode(65 + code).toLowerCase()] = 0x41 + code;
for (let code = 0; code < 10; code += 1) KEY_CODES[String(code)] = 0x30 + code;
for (let code = 1; code <= 12; code += 1) KEY_CODES[`f${code}`] = 0x6f + code;
Object.freeze(KEY_CODES);

const POWER_SHELL_HELPER = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$payload = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('__PAYLOAD__')) | ConvertFrom-Json

$nativeSource = @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

namespace DshComputer {
  public sealed class RectValue {
    public int x;
    public int y;
    public int width;
    public int height;
    public RectValue(int x, int y, int width, int height) {
      this.x = x; this.y = y; this.width = width; this.height = height;
    }
  }

  public static class Native {
    [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
    [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT {
      public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo;
    }
    [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT {
      public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo;
    }
    [StructLayout(LayoutKind.Explicit)] public struct InputUnion {
      [FieldOffset(0)] public MOUSEINPUT mi;
      [FieldOffset(0)] public KEYBDINPUT ki;
    }
    [StructLayout(LayoutKind.Sequential)] public struct INPUT {
      public uint type;
      public InputUnion U;
    }

    [DllImport("user32.dll", SetLastError = true)] public static extern bool SetCursorPos(int X, int Y);
    [DllImport("user32.dll", SetLastError = true)] public static extern bool GetCursorPos(out POINT point);
    [DllImport("user32.dll", SetLastError = true)] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, IntPtr extraInfo);
    [DllImport("user32.dll", SetLastError = true)] public static extern void keybd_event(byte vk, byte scan, uint flags, IntPtr extraInfo);
    [DllImport("user32.dll", SetLastError = true)] public static extern uint SendInput(uint count, INPUT[] inputs, int size);
    [DllImport("user32.dll", SetLastError = true)] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll", SetLastError = true)] public static extern bool GetWindowRect(IntPtr handle, out RECT rect);
    [DllImport("user32.dll", SetLastError = true)] public static extern bool SetForegroundWindow(IntPtr handle);
    [DllImport("user32.dll", SetLastError = true)] public static extern bool ShowWindow(IntPtr handle, int command);
    [DllImport("user32.dll", SetLastError = true)] public static extern bool SetProcessDPIAware();
    [DllImport("user32.dll", SetLastError = true)] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);

    const uint LEFTDOWN = 0x0002;
    const uint LEFTUP = 0x0004;
    const uint RIGHTDOWN = 0x0008;
    const uint RIGHTUP = 0x0010;
    const uint MIDDLEDOWN = 0x0020;
    const uint MIDDLEUP = 0x0040;
    const uint WHEEL = 0x0800;
    const uint HWHEEL = 0x01000;
    const uint KEYEVENTF_KEYUP = 0x0002;
    const uint KEYEVENTF_UNICODE = 0x0004;

    public static void EnableDpiAwareness() {
      try { SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch { }
      try { SetProcessDPIAware(); } catch { }
    }

    static uint DownFlag(string button) {
      if (button == "right") return RIGHTDOWN;
      if (button == "middle") return MIDDLEDOWN;
      return LEFTDOWN;
    }

    static uint UpFlag(string button) {
      if (button == "right") return RIGHTUP;
      if (button == "middle") return MIDDLEUP;
      return LEFTUP;
    }

    public static void Click(int x, int y, string button, int count) {
      if (!SetCursorPos(x, y)) throw new InvalidOperationException("SetCursorPos failed");
      for (int i = 0; i < count; i++) {
        mouse_event(DownFlag(button), 0, 0, 0, IntPtr.Zero);
        mouse_event(UpFlag(button), 0, 0, 0, IntPtr.Zero);
      }
    }

    public static void Drag(int fromX, int fromY, int toX, int toY, int durationMs) {
      if (!SetCursorPos(fromX, fromY)) throw new InvalidOperationException("SetCursorPos failed");
      mouse_event(LEFTDOWN, 0, 0, 0, IntPtr.Zero);
      try {
        if (durationMs > 0) Thread.Sleep(durationMs);
        if (!SetCursorPos(toX, toY)) throw new InvalidOperationException("SetCursorPos failed");
      } finally {
        mouse_event(LEFTUP, 0, 0, 0, IntPtr.Zero);
      }
    }

    public static void Scroll(int x, int y, int deltaX, int deltaY) {
      SetCursorPos(x, y);
      if (deltaY != 0) mouse_event(WHEEL, 0, 0, unchecked((uint)deltaY), IntPtr.Zero);
      if (deltaX != 0) mouse_event(HWHEEL, 0, 0, unchecked((uint)deltaX), IntPtr.Zero);
    }

    public static void TypeText(string text) {
      var inputs = new List<INPUT>();
      foreach (char character in text) {
        inputs.Add(new INPUT { type = 1, U = new InputUnion { ki = new KEYBDINPUT { wVk = 0, wScan = character, dwFlags = KEYEVENTF_UNICODE, time = 0, dwExtraInfo = IntPtr.Zero } } });
        inputs.Add(new INPUT { type = 1, U = new InputUnion { ki = new KEYBDINPUT { wVk = 0, wScan = character, dwFlags = KEYEVENTF_UNICODE | KEYEVENTF_KEYUP, time = 0, dwExtraInfo = IntPtr.Zero } } });
      }
      if (inputs.Count == 0) return;
      var array = inputs.ToArray();
      var sent = SendInput((uint)array.Length, array, Marshal.SizeOf(typeof(INPUT)));
      if (sent != (uint)array.Length) throw new InvalidOperationException("SendInput did not deliver all text input");
    }

    public static void TapKey(int key, int[] modifiers) {
      foreach (int modifier in modifiers) keybd_event((byte)modifier, 0, 0, IntPtr.Zero);
      try {
        keybd_event((byte)key, 0, 0, IntPtr.Zero);
        keybd_event((byte)key, 0, KEYEVENTF_KEYUP, IntPtr.Zero);
      } finally {
        for (int index = modifiers.Length - 1; index >= 0; index--) keybd_event((byte)modifiers[index], 0, KEYEVENTF_KEYUP, IntPtr.Zero);
      }
    }

    public static RectValue WindowBounds(long rawHandle) {
      RECT rect;
      if (!GetWindowRect(new IntPtr(rawHandle), out rect)) throw new InvalidOperationException("GetWindowRect failed");
      return new RectValue(rect.Left, rect.Top, rect.Right - rect.Left, rect.Bottom - rect.Top);
    }

    public static bool FocusWindow(long rawHandle) {
      var handle = new IntPtr(rawHandle);
      ShowWindow(handle, 9);
      return SetForegroundWindow(handle);
    }

    public static long ForegroundWindow() { return GetForegroundWindow().ToInt64(); }
  }
}
'@
Add-Type -TypeDefinition $nativeSource -Language CSharp
[DshComputer.Native]::EnableDpiAwareness()
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

function Write-ComputerResult($value) {
  [Console]::Out.Write(($value | ConvertTo-Json -Depth 64 -Compress))
}

switch ($payload.kind) {
  'displays' {
    $screens = [System.Windows.Forms.Screen]::AllScreens | ForEach-Object {
      @{ id = $_.DeviceName; name = $_.DeviceName; primary = $_.Primary; bounds = @{ x = $_.Bounds.X; y = $_.Bounds.Y; width = $_.Bounds.Width; height = $_.Bounds.Height } }
    }
    Write-ComputerResult @($screens)
    break
  }
  'screenshot' {
    $selected = $null
    if ($null -ne $payload.displayId -and $payload.displayId -ne '') {
      $selected = [System.Windows.Forms.Screen]::AllScreens | Where-Object { $_.DeviceName -eq $payload.displayId } | Select-Object -First 1
      if ($null -eq $selected) { throw "display '$($payload.displayId)' was not found" }
      $bounds = $selected.Bounds
      $selectedId = $selected.DeviceName
    } else {
      $bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
      $selectedId = $null
    }
    $source = New-Object System.Drawing.Bitmap -ArgumentList @($bounds.Width, $bounds.Height)
    $graphics = [System.Drawing.Graphics]::FromImage($source)
    try {
      $graphics.CopyFromScreen($bounds.X, $bounds.Y, 0, 0, $source.Size)
    } finally {
      $graphics.Dispose()
    }
    $target = $source
    try {
      $maxDimension = [int]$payload.maxDimension
      if ($source.Width -gt $maxDimension -or $source.Height -gt $maxDimension) {
        $scale = [Math]::Min($maxDimension / [double]$source.Width, $maxDimension / [double]$source.Height)
        $scaledWidth = [Math]::Max(1, [int][Math]::Round($source.Width * $scale))
        $scaledHeight = [Math]::Max(1, [int][Math]::Round($source.Height * $scale))
        $target = New-Object System.Drawing.Bitmap -ArgumentList @($scaledWidth, $scaledHeight)
        $scaledGraphics = [System.Drawing.Graphics]::FromImage($target)
        try { $scaledGraphics.DrawImage($source, 0, 0, $scaledWidth, $scaledHeight) } finally { $scaledGraphics.Dispose() }
      }
      $stream = New-Object System.IO.MemoryStream
      try {
        $target.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
        $bytes = $stream.ToArray()
        if ($bytes.Length -gt [int]$payload.maxBytes) { throw "captured PNG exceeds configured screenshotMaxBytes" }
        Write-ComputerResult @{ png = [System.Convert]::ToBase64String($bytes); width = $target.Width; height = $target.Height; displayId = $selectedId; sourceBounds = @{ x = $bounds.X; y = $bounds.Y; width = $bounds.Width; height = $bounds.Height } }
      } finally { $stream.Dispose() }
    } finally {
      if ($target -ne $source) { $target.Dispose() }
      $source.Dispose()
    }
    break
  }
  'action' {
    switch ($payload.action.kind) {
      'move' { [DshComputer.Native]::SetCursorPos([int]$payload.action.x, [int]$payload.action.y) | Out-Null }
      'click' { [DshComputer.Native]::Click([int]$payload.action.x, [int]$payload.action.y, [string]$payload.action.button, [int]$payload.action.clickCount) }
      'drag' { [DshComputer.Native]::Drag([int]$payload.action.fromX, [int]$payload.action.fromY, [int]$payload.action.toX, [int]$payload.action.toY, [int]$payload.action.durationMs) }
      'scroll' { [DshComputer.Native]::Scroll([int]$payload.action.x, [int]$payload.action.y, [int]$payload.action.deltaX, [int]$payload.action.deltaY) }
      'type' { [DshComputer.Native]::TypeText([string]$payload.action.text) }
      'key' { [DshComputer.Native]::TapKey([int]$payload.action.key, [int[]]$payload.action.modifiers) }
      default { throw "unsupported action '$($payload.action.kind)'" }
    }
    if ([int]$payload.action.delayMs -gt 0) { Start-Sleep -Milliseconds ([int]$payload.action.delayMs) }
    Write-ComputerResult @{ ok = $true }
    break
  }
  'windows' {
    $foreground = [DshComputer.Native]::ForegroundWindow()
    $items = @()
    Get-Process | ForEach-Object {
      try {
        if ($_.MainWindowHandle -ne [IntPtr]::Zero -and $_.MainWindowTitle) {
          $bounds = [DshComputer.Native]::WindowBounds($_.MainWindowHandle.ToInt64())
          $items += @{ id = $_.MainWindowHandle.ToInt64().ToString(); title = $_.MainWindowTitle; processId = $_.Id; application = $_.ProcessName; focused = ($_.MainWindowHandle.ToInt64() -eq $foreground); bounds = $bounds }
        }
      } catch { }
    }
    Write-ComputerResult @($items)
    break
  }
  'focus' {
    if (-not [DshComputer.Native]::FocusWindow([int64]$payload.id)) { throw "SetForegroundWindow rejected the requested window" }
    Write-ComputerResult @{ ok = $true }
    break
  }
  'accessibility' {
    Add-Type -AssemblyName UIAutomationClient
    Add-Type -AssemblyName UIAutomationTypes
    $count = 0
    $maxNodes = [int]$payload.maxNodes
    $maxDepth = [int]$payload.maxDepth
    $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
    function Convert-AccessibilityNode($element, [int]$depth) {
      if ($null -eq $element -or $count -ge $maxNodes) { return $null }
      try { $current = $element.Current } catch { return $null }
      $script:count += 1
      $bounds = $null
      try {
        $rectangle = $current.BoundingRectangle
        if (-not $rectangle.IsEmpty) { $bounds = @{ x = [int][Math]::Round($rectangle.X); y = [int][Math]::Round($rectangle.Y); width = [int][Math]::Round($rectangle.Width); height = [int][Math]::Round($rectangle.Height) } }
      } catch { }
      $node = [ordered]@{ role = $current.ControlType.ProgrammaticName.Replace('ControlType.', ''); name = $current.Name; enabled = $current.IsEnabled; focused = $current.HasKeyboardFocus; children = @() }
      if ($null -ne $bounds) { $node.bounds = $bounds }
      if ($depth -lt $maxDepth -and $count -lt $maxNodes) {
        try { $child = $walker.GetFirstChild($element) } catch { $child = $null }
        while ($null -ne $child -and $count -lt $maxNodes) {
          $childNode = Convert-AccessibilityNode $child ($depth + 1)
          if ($null -ne $childNode) { $node.children += $childNode }
          try { $child = $walker.GetNextSibling($child) } catch { $child = $null }
        }
      }
      return $node
    }
    $root = [System.Windows.Automation.AutomationElement]::FocusedElement
    if ($null -eq $root) { $root = [System.Windows.Automation.AutomationElement]::RootElement }
    $tree = Convert-AccessibilityNode $root 0
    if ($null -eq $tree) { throw 'UI Automation returned no accessible root' }
    Write-ComputerResult $tree
    break
  }
  default { throw "unsupported computer helper operation '$($payload.kind)'" }
}
`;

function commandPayload(payload) {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
}

function powershellScript(payload) {
  return POWER_SHELL_HELPER.replace('__PAYLOAD__', commandPayload(payload));
}

async function withPowerShellFile(source, run) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-computer-use-'));
  const file = join(directory, 'computer.ps1');
  try {
    await writeFile(file, source, 'utf8');
    return await run(file);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function numericBounds(raw) {
  if (raw === null || typeof raw !== 'object'
    || !Number.isFinite(raw.x) || !Number.isFinite(raw.y)
    || !Number.isFinite(raw.width) || !Number.isFinite(raw.height)
    || raw.width < 1 || raw.height < 1) {
    throw new ComputerUseError('Windows helper returned invalid desktop bounds');
  }
  return { x: raw.x, y: raw.y, width: raw.width, height: raw.height };
}

function keyCode(key) {
  const code = KEY_CODES[key.toLowerCase()];
  if (code === undefined) {
    throw unsupported(`key '${key}' is not supported by the Windows backend`);
  }
  return code;
}

function actionPayload(action, delayMs) {
  switch (action.kind) {
    case 'move': {
      const point = assertFinitePoint(action.point, 'move point');
      return { kind: 'move', ...point, delayMs };
    }
    case 'click': {
      const point = assertFinitePoint(action.point, 'click point');
      return { kind: 'click', ...point, button: action.button, clickCount: action.clickCount, delayMs };
    }
    case 'drag': {
      const from = assertFinitePoint(action.from, 'drag source');
      const to = assertFinitePoint(action.to, 'drag target');
      return { kind: 'drag', fromX: from.x, fromY: from.y, toX: to.x, toY: to.y, durationMs: action.durationMs, delayMs };
    }
    case 'scroll': {
      const point = action.point === undefined ? { x: 0, y: 0 } : assertFinitePoint(action.point, 'scroll point');
      return { kind: 'scroll', ...point, deltaX: action.deltaX, deltaY: action.deltaY, delayMs };
    }
    case 'type': return { kind: 'type', text: action.text, delayMs };
    case 'key': return {
      kind: 'key',
      key: keyCode(action.key),
      modifiers: action.modifiers.map(keyCode),
      delayMs,
    };
    default: throw new ComputerUseError(`unknown computer action '${action.kind}'`);
  }
}

export class WindowsComputer {
  constructor(runner, config) {
    this.runner = runner;
    this.config = config;
    this.capabilities = Object.freeze({
      platform: 'win32',
      screenshot: true,
      pointer: true,
      keyboard: true,
      windows: true,
      accessibility: true,
    });
  }

  async run(payload, signal, stdoutMaxBytes = this.config.maxAccessibilityBytes) {
    const shell = await this.runner.requireAny(['pwsh.exe', 'pwsh', 'powershell.exe', 'powershell'], 'Windows desktop automation', signal);
    return withPowerShellFile(powershellScript(payload), (file) => this.runner.runJson([
      shell,
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-File',
      file,
    ], { signal, stdoutMaxBytes }));
  }

  async listDisplays(signal) {
    const displays = await this.run({ kind: 'displays' }, signal);
    if (!Array.isArray(displays)) throw new ComputerUseError('Windows helper returned invalid display metadata');
    return displays.map((display) => ({
      id: String(display.id),
      name: String(display.name),
      primary: display.primary === true,
      bounds: numericBounds(display.bounds),
    }));
  }

  async screenshot(request, signal) {
    const response = await this.run({
      kind: 'screenshot',
      displayId: request.displayId ?? null,
      maxDimension: this.config.screenshotMaxDimension,
      maxBytes: this.config.screenshotMaxBytes,
    }, signal, Math.ceil(this.config.screenshotMaxBytes * 1.4) + 4096);
    if (typeof response?.png !== 'string') throw new ComputerUseError('Windows helper returned no screenshot bytes');
    const data = Buffer.from(response.png, 'base64');
    if (data.byteLength > this.config.screenshotMaxBytes) {
      throw new ComputerUseError('desktop screenshot exceeds configured screenshotMaxBytes');
    }
    const dimensions = pngDimensions(data);
    return {
      data,
      mediaType: 'image/png',
      width: dimensions.width,
      height: dimensions.height,
      sourceBounds: numericBounds(response.sourceBounds),
      capturedAt: Date.now(),
      ...(typeof response.displayId === 'string' ? { displayId: response.displayId } : {}),
    };
  }

  async perform(action, signal) {
    await this.run({ kind: 'action', action: actionPayload(action, this.config.actionDelayMs) }, signal);
  }

  async listWindows(signal) {
    const windows = await this.run({ kind: 'windows' }, signal);
    if (!Array.isArray(windows)) throw new ComputerUseError('Windows helper returned invalid window metadata');
    return windows.map((window) => ({
      id: String(window.id),
      title: String(window.title),
      bounds: numericBounds(window.bounds),
      ...(Number.isInteger(window.processId) ? { processId: window.processId } : {}),
      ...(typeof window.application === 'string' ? { application: window.application } : {}),
      focused: window.focused === true,
    }));
  }

  async focusWindow(id, signal) {
    if (!/^-?\d+$/.test(id)) throw new ComputerUseError('window id is invalid');
    await this.run({ kind: 'focus', id }, signal);
  }

  async accessibilitySnapshot(signal) {
    const result = await this.run({
      kind: 'accessibility',
      maxNodes: this.config.maxAccessibilityNodes,
      maxDepth: this.config.maxAccessibilityDepth,
    }, signal, this.config.maxAccessibilityBytes);
    return result;
  }
}
