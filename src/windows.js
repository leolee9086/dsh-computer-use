import { Buffer } from 'node:buffer';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ComputerUseError, unsupported } from './errors.js';
import { assertFinitePoint } from './geometry.js';

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
using System.Diagnostics;
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

  public sealed class WindowValue {
    public long id;
    public string title;
    public int processId;
    public string application;
    public RectValue bounds;
    public WindowValue(long id, string title, int processId, string application, RectValue bounds) {
      this.id = id; this.title = title; this.processId = processId; this.application = application; this.bounds = bounds;
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
    [DllImport("user32.dll", SetLastError = true)] public static extern bool IsWindowVisible(IntPtr handle);
    [DllImport("user32.dll", SetLastError = true)] public static extern bool IsIconic(IntPtr handle);
    [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr handle, StringBuilder text, int maxCount);
    [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)] public static extern int GetWindowTextLength(IntPtr handle);
    public delegate bool EnumWindowsProc(IntPtr handle, IntPtr parameter);
    [DllImport("user32.dll", SetLastError = true)] public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr parameter);
    [DllImport("user32.dll", SetLastError = true)] public static extern bool SetForegroundWindow(IntPtr handle);
    [DllImport("user32.dll", SetLastError = true)] public static extern bool BringWindowToTop(IntPtr handle);
    [DllImport("user32.dll", SetLastError = true)] public static extern IntPtr SetFocus(IntPtr handle);
    [DllImport("user32.dll", SetLastError = true)] public static extern bool IsWindow(IntPtr handle);
    [DllImport("user32.dll", SetLastError = true)] public static extern uint GetWindowThreadProcessId(IntPtr handle, IntPtr processId);
    [DllImport("user32.dll", SetLastError = true, EntryPoint = "GetWindowThreadProcessId")] public static extern uint GetWindowThreadProcessIdWithProcess(IntPtr handle, out uint processId);
    [DllImport("user32.dll", SetLastError = true)] public static extern bool AttachThreadInput(uint attachThreadId, uint attachToThreadId, bool attach);
    [DllImport("user32.dll", SetLastError = true)] public static extern bool ShowWindow(IntPtr handle, int command);
    [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
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

    public static void Move(int x, int y) {
      if (!SetCursorPos(x, y)) throw new InvalidOperationException("SetCursorPos failed");
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
        var duration = Math.Max(0, Math.Min(10000, durationMs));
        var steps = Math.Max(1, Math.Min(120, (int)Math.Ceiling(duration / 16.0)));
        for (var index = 1; index <= steps; index++) {
          var fraction = index / (double)steps;
          var x = (int)Math.Round(fromX + (toX - fromX) * fraction);
          var y = (int)Math.Round(fromY + (toY - fromY) * fraction);
          if (duration > 0) Thread.Sleep((int)Math.Round(duration / (double)steps));
          if (!SetCursorPos(x, y)) throw new InvalidOperationException("SetCursorPos failed");
        }
      } finally {
        mouse_event(LEFTUP, 0, 0, 0, IntPtr.Zero);
      }
    }

    public static void Scroll(int x, int y, int deltaX, int deltaY) {
      if (!SetCursorPos(x, y)) throw new InvalidOperationException("SetCursorPos failed");
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

    static string WindowTitle(IntPtr handle) {
      var length = GetWindowTextLength(handle);
      if (length < 1) return "";
      var text = new StringBuilder(length + 1);
      GetWindowText(handle, text, text.Capacity);
      return text.ToString();
    }

    static bool BoundsEqual(RECT rect, RectValue expected) {
      return expected != null
        && rect.Left == expected.x && rect.Top == expected.y
        && rect.Right - rect.Left == expected.width && rect.Bottom - rect.Top == expected.height;
    }

    public static bool WindowMatches(long rawHandle, int expectedProcessId, string expectedTitle, RectValue expectedBounds) {
      var handle = new IntPtr(rawHandle);
      if (!IsWindow(handle) || !IsWindowVisible(handle) || IsIconic(handle)) return false;
      uint processId;
      if (GetWindowThreadProcessIdWithProcess(handle, out processId) == 0 || processId != (uint)expectedProcessId) return false;
      if (WindowTitle(handle) != expectedTitle) return false;
      RECT rect;
      return GetWindowRect(handle, out rect) && BoundsEqual(rect, expectedBounds);
    }

    // Identity-only check: handle, owning process, title. Deliberately NOT the bounds --
    // a window that moved between listing and acting is still the same window.
    public static bool WindowMatchesIdentity(long rawHandle, int expectedProcessId, string expectedTitle) {
      var handle = new IntPtr(rawHandle);
      if (!IsWindow(handle) || !IsWindowVisible(handle) || IsIconic(handle)) return false;
      uint processId;
      if (GetWindowThreadProcessIdWithProcess(handle, out processId) == 0 || processId != (uint)expectedProcessId) return false;
      return WindowTitle(handle) == expectedTitle;
    }

    // Raise a window identified by handle/process/title, without comparing its listed bounds.
    // Needed before injecting keyboard input: this process's own startup console window takes
    // the foreground, and SendInput only reaches the foreground window.
    public static bool FocusWindowByIdentity(long rawHandle, int expectedProcessId, string expectedTitle) {
      var handle = new IntPtr(rawHandle);
      if (!WindowMatchesIdentity(rawHandle, expectedProcessId, expectedTitle)) return false;
      ShowWindow(handle, 9);
      if (SetForegroundWindow(handle) && GetForegroundWindow() == handle) {
        return WindowMatchesIdentity(rawHandle, expectedProcessId, expectedTitle);
      }

      // Windows foreground-lock rules can reject a valid request. Temporarily join the caller
      // with the foreground and target input queues, then verify the result.
      var currentThread = GetCurrentThreadId();
      var foreground = GetForegroundWindow();
      var foregroundThread = foreground == IntPtr.Zero ? 0 : GetWindowThreadProcessId(foreground, IntPtr.Zero);
      var targetThread = GetWindowThreadProcessId(handle, IntPtr.Zero);
      var attachedForeground = false;
      var attachedTarget = false;
      try {
        if (foregroundThread != 0 && foregroundThread != currentThread) {
          attachedForeground = AttachThreadInput(currentThread, foregroundThread, true);
        }
        if (targetThread != 0 && targetThread != currentThread && targetThread != foregroundThread) {
          attachedTarget = AttachThreadInput(currentThread, targetThread, true);
        }
        BringWindowToTop(handle);
        SetForegroundWindow(handle);
        SetFocus(handle);
        return GetForegroundWindow() == handle && WindowMatchesIdentity(rawHandle, expectedProcessId, expectedTitle);
      } finally {
        if (attachedTarget) AttachThreadInput(currentThread, targetThread, false);
        if (attachedForeground) AttachThreadInput(currentThread, foregroundThread, false);
      }
    }

    public static List<WindowValue> VisibleWindows() {
      var windows = new List<WindowValue>();
      if (!EnumWindows((handle, ignored) => {
        if (!IsWindowVisible(handle) || IsIconic(handle)) return true;
        var title = WindowTitle(handle);
        if (String.IsNullOrEmpty(title)) return true;
        RECT rect;
        if (!GetWindowRect(handle, out rect) || rect.Right <= rect.Left || rect.Bottom <= rect.Top) return true;
        uint processId;
        if (GetWindowThreadProcessIdWithProcess(handle, out processId) == 0 || processId == 0 || processId > Int32.MaxValue) return true;
        var application = "";
        try { application = Process.GetProcessById((int)processId).ProcessName; } catch { }
        windows.Add(new WindowValue(handle.ToInt64(), title, (int)processId, application,
          new RectValue(rect.Left, rect.Top, rect.Right - rect.Left, rect.Bottom - rect.Top)));
        return true;
      }, IntPtr.Zero)) throw new InvalidOperationException("EnumWindows failed");
      return windows;
    }

    public static bool FocusWindow(long rawHandle, int expectedProcessId, string expectedTitle, RectValue expectedBounds) {
      var handle = new IntPtr(rawHandle);
      if (!WindowMatches(rawHandle, expectedProcessId, expectedTitle, expectedBounds)) return false;
      ShowWindow(handle, 9);
      if (SetForegroundWindow(handle) && GetForegroundWindow() == handle) {
        return WindowMatches(rawHandle, expectedProcessId, expectedTitle, expectedBounds);
      }

      // Windows foreground-lock rules can reject a valid window. Temporarily join
      // the caller with the foreground and target input queues, then verify focus.
      var currentThread = GetCurrentThreadId();
      var foreground = GetForegroundWindow();
      var foregroundThread = foreground == IntPtr.Zero ? 0 : GetWindowThreadProcessId(foreground, IntPtr.Zero);
      var targetThread = GetWindowThreadProcessId(handle, IntPtr.Zero);
      var attachedForeground = false;
      var attachedTarget = false;
      try {
        if (foregroundThread != 0 && foregroundThread != currentThread) {
          attachedForeground = AttachThreadInput(currentThread, foregroundThread, true);
        }
        if (targetThread != 0 && targetThread != currentThread && targetThread != foregroundThread) {
          attachedTarget = AttachThreadInput(currentThread, targetThread, true);
        }
        BringWindowToTop(handle);
        SetForegroundWindow(handle);
        SetFocus(handle);
        return GetForegroundWindow() == handle && WindowMatches(rawHandle, expectedProcessId, expectedTitle, expectedBounds);
      } finally {
        if (attachedTarget) AttachThreadInput(currentThread, targetThread, false);
        if (attachedForeground) AttachThreadInput(currentThread, foregroundThread, false);
      }
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
  [Console]::Out.Write((ConvertTo-Json -InputObject $value -Depth 64 -Compress))
}

switch ($payload.kind) {
  'displays' {
    $screens = [System.Windows.Forms.Screen]::AllScreens | ForEach-Object {
      @{ id = $_.DeviceName; name = $_.DeviceName; primary = $_.Primary; bounds = @{ x = $_.Bounds.X; y = $_.Bounds.Y; width = $_.Bounds.Width; height = $_.Bounds.Height } }
    }
    Write-ComputerResult @($screens)
    break
  }
  'action' {
    if ($null -ne $payload.focus) {
      # Take the foreground back before injecting. This process starts with a console window
      # that grabs the foreground, and SendInput only reaches whatever is foreground.
      # Pointer actions are unaffected: they inject at coordinates, not at the focus.
      if (-not [DshComputer.Native]::FocusWindowByIdentity([int64]$payload.focus.handle, [int]$payload.focus.processId, [string]$payload.focus.title)) {
        throw "could not raise the target window before the action"
      }
    }
    switch ($payload.action.kind) {
      'move' { [DshComputer.Native]::Move([int]$payload.action.x, [int]$payload.action.y) }
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
    $items = @([DshComputer.Native]::VisibleWindows() | ForEach-Object {
      @{ id = $_.id.ToString(); title = $_.title; processId = $_.processId; application = $_.application; focused = ($_.id -eq $foreground); bounds = @{ x = $_.bounds.x; y = $_.bounds.y; width = $_.bounds.width; height = $_.bounds.height } }
    })
    Write-ComputerResult $items
    break
  }
  'focus' {
    $expectedBounds = New-Object -TypeName DshComputer.RectValue -ArgumentList @([int]$payload.bounds.x, [int]$payload.bounds.y, [int]$payload.bounds.width, [int]$payload.bounds.height)
    if (-not [DshComputer.Native]::FocusWindow([int64]$payload.id, [int]$payload.processId, [string]$payload.title, $expectedBounds)) { throw "the requested window no longer matches its listed identity or foreground focus was rejected" }
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
    function Get-AccessibilityElementId($element) {
      try {
        $runtimeId = @($element.GetRuntimeId())
        if ($runtimeId.Count -gt 0) { return 'uia:' + ($runtimeId -join ',') }
      } catch { }
      return $null
    }
    function Supports-AccessibilityPattern($element, $pattern) {
      try {
        [void]$element.GetCurrentPattern($pattern)
        return $true
      } catch { return $false }
    }
    function Find-AccessibilityApplicationRoot($element) {
      $candidate = $element
      while ($null -ne $candidate) {
        try { $candidateCurrent = $candidate.Current } catch { break }
        if ($candidateCurrent.ControlType -eq [System.Windows.Automation.ControlType]::Window) { return $candidate }
        try { $candidate = $walker.GetParent($candidate) } catch { $candidate = $null }
      }
      return $element
    }
    function Convert-AccessibilityNode($element, [int]$depth) {
      if ($null -eq $element -or $count -ge $maxNodes) { return $null }
      try { $current = $element.Current } catch { return $null }
      $script:count += 1
      $bounds = $null
      try {
        $rectangle = $current.BoundingRectangle
        if (-not $rectangle.IsEmpty) { $bounds = @{ x = [int][Math]::Round($rectangle.X); y = [int][Math]::Round($rectangle.Y); width = [int][Math]::Round($rectangle.Width); height = [int][Math]::Round($rectangle.Height) } }
      } catch { }
      $patterns = @()
      if (Supports-AccessibilityPattern $element ([System.Windows.Automation.InvokePattern]::Pattern)) { $patterns += 'invoke' }
      if (Supports-AccessibilityPattern $element ([System.Windows.Automation.ValuePattern]::Pattern)) { $patterns += 'value' }
      if (Supports-AccessibilityPattern $element ([System.Windows.Automation.TogglePattern]::Pattern)) { $patterns += 'toggle' }
      if (Supports-AccessibilityPattern $element ([System.Windows.Automation.ExpandCollapsePattern]::Pattern)) { $patterns += 'expand_collapse' }
      if (Supports-AccessibilityPattern $element ([System.Windows.Automation.SelectionItemPattern]::Pattern)) { $patterns += 'selection_item' }
      if (Supports-AccessibilityPattern $element ([System.Windows.Automation.ScrollItemPattern]::Pattern)) { $patterns += 'scroll_item' }
      $node = [ordered]@{ role = $current.ControlType.ProgrammaticName.Replace('ControlType.', ''); name = $current.Name; automation_id = $current.AutomationId; class_name = $current.ClassName; process_id = $current.ProcessId; enabled = $current.IsEnabled; focused = $current.HasKeyboardFocus; focusable = $current.IsKeyboardFocusable; offscreen = $current.IsOffscreen; patterns = @($patterns); children = @() }
      $elementId = Get-AccessibilityElementId $element
      if ($null -ne $elementId) { $node.element_id = $elementId }
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
    $focused = [System.Windows.Automation.AutomationElement]::FocusedElement
    if ($null -eq $focused) { $focused = [System.Windows.Automation.AutomationElement]::RootElement }
    $root = Find-AccessibilityApplicationRoot $focused
    $tree = Convert-AccessibilityNode $root 0
    if ($null -eq $tree) { throw 'UI Automation returned no accessible root' }
    Write-ComputerResult $tree
    break
  }
  'accessibility-action' {
    Add-Type -AssemblyName UIAutomationClient
    Add-Type -AssemblyName UIAutomationTypes
    $elementId = [string]$payload.action.elementId
    if ($elementId -notmatch '^uia:-?\d+(,-?\d+)*$') { throw 'accessibility element id is invalid' }
    $processId = [int]$payload.action.processId
    if ($processId -lt 1) { throw 'accessibility action process id is invalid' }
    $maxCandidates = [int]$payload.action.maxCandidates
    if ($maxCandidates -lt 1) { throw 'accessibility action search bound is invalid' }
    [int[]]$runtimeId = @($elementId.Substring(4).Split(',') | ForEach-Object { [int]$_ })
    $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
    $desktopRoot = [System.Windows.Automation.AutomationElement]::RootElement
    $searchRoot = $desktopRoot
    $focused = [System.Windows.Automation.AutomationElement]::FocusedElement
    $ancestor = $focused
    while ($null -ne $ancestor) {
      try { $ancestorCurrent = $ancestor.Current } catch { break }
      if ($ancestorCurrent.ProcessId -eq $processId) { $searchRoot = $ancestor }
      try { $ancestor = $walker.GetParent($ancestor) } catch { $ancestor = $null }
    }
    $element = $null
    $scanned = 0
    $node = $searchRoot
    while ($null -ne $node -and $scanned -lt $maxCandidates) {
      try { $current = $node.Current } catch { $current = $null }
      if ($null -ne $current -and ($node -ne $desktopRoot -or $searchRoot -ne $desktopRoot)) {
        $scanned += 1
        if ($current.ProcessId -eq $processId) {
          try { $candidateRuntimeId = @($node.GetRuntimeId()) } catch { $candidateRuntimeId = @() }
          if ($candidateRuntimeId.Count -eq $runtimeId.Count) {
            $matches = $true
            for ($part = 0; $part -lt $runtimeId.Count; $part += 1) {
              if ($candidateRuntimeId[$part] -ne $runtimeId[$part]) { $matches = $false; break }
            }
            if ($matches) { $element = $node; break }
          }
        }
      }
      $child = $null
      try { $child = $walker.GetFirstChild($node) } catch { $child = $null }
      if ($null -ne $child) {
        $node = $child
        continue
      }
      while ($null -ne $node) {
        if ($node -eq $searchRoot) { $node = $null; break }
        $sibling = $null
        try { $sibling = $walker.GetNextSibling($node) } catch { $sibling = $null }
        if ($null -ne $sibling) { $node = $sibling; break }
        try { $node = $walker.GetParent($node) } catch { $node = $null }
      }
    }
    if ($null -eq $element) { throw 'UI Automation element is no longer available within the configured search bound' }
    $current = $element.Current
    if ([string]$payload.action.automationId -and $current.AutomationId -ne [string]$payload.action.automationId) { throw 'UI Automation element automation id changed after observation' }
    if ([string]$payload.action.name -and $current.Name -ne [string]$payload.action.name) { throw 'UI Automation element name changed after observation' }
    if ([string]$payload.action.className -and $current.ClassName -ne [string]$payload.action.className) { throw 'UI Automation element class changed after observation' }
    if ([string]$payload.action.role -and $current.ControlType.ProgrammaticName.Replace('ControlType.', '') -ne [string]$payload.action.role) { throw 'UI Automation element role changed after observation' }
    switch ([string]$payload.action.kind) {
      'invoke' { ([System.Windows.Automation.InvokePattern]($element.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern))).Invoke() }
      'focus' { $element.SetFocus() }
      'set_value' {
        $pattern = [System.Windows.Automation.ValuePattern]($element.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern))
        if ($pattern.Current.IsReadOnly) { throw 'UI Automation value pattern is read-only' }
        $pattern.SetValue([string]$payload.action.value)
      }
      'toggle' { ([System.Windows.Automation.TogglePattern]($element.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern))).Toggle() }
      'expand' { ([System.Windows.Automation.ExpandCollapsePattern]($element.GetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern))).Expand() }
      'collapse' { ([System.Windows.Automation.ExpandCollapsePattern]($element.GetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern))).Collapse() }
      'select' { ([System.Windows.Automation.SelectionItemPattern]($element.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern))).Select() }
      'scroll_into_view' { ([System.Windows.Automation.ScrollItemPattern]($element.GetCurrentPattern([System.Windows.Automation.ScrollItemPattern]::Pattern))).ScrollIntoView() }
      default { throw "unsupported accessibility action '$($payload.action.kind)'" }
    }
    if ([int]$payload.action.delayMs -gt 0) { Start-Sleep -Milliseconds ([int]$payload.action.delayMs) }
    Write-ComputerResult @{ ok = $true }
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

/* ------------------------------------------------------------------ */
/* 原生截图 helper（dsh-screen.exe，Rust）                              */
/* ------------------------------------------------------------------ */

/**
 * 原生截图 helper（dsh-screen.exe，Rust）的路径。
 *
 * 为什么截图专门做一个原生 exe：
 *   1. 不必为每次截图付一次 powershell.exe 的启动代价
 *   2. 屏幕几何与像素读取在强类型代码里，不会再出现「脚本层属性取到 null 却一路算下去」
 *   3. 可以自行决定 ROP、裁剪与缩放，不受脚本层表达能力限制
 *
 * **没有 helper 就报错，不回退 PowerShell。**
 * 保留两条实现会让两边都难以维护、测试也覆盖不到，而且用户不知道自己实际在用哪个 ——
 * 那种「静默降级」是伪兼容，不如直接说清楚缺什么。
 */
let resolvedHelperPath;
let helperProbeDone = false;

function resolveHelperPath(config) {
  if (helperProbeDone) return resolvedHelperPath;
  helperProbeDone = true;

  const here = dirname(fileURLToPath(import.meta.url));
  const override = typeof config?.nativeHelperPath === 'string' && config.nativeHelperPath.length > 0
    ? config.nativeHelperPath
    : undefined;
  const candidates = [
    override,
    // 开发期：仓库里 cargo 的输出目录
    join(here, '..', 'native', 'target', 'release', 'dsh-screen.exe'),
    // 发布期：跟包一起分发的预编译产物
    join(here, '..', 'native', 'release', 'dsh-screen.exe'),
    join(here, '..', 'bin', 'dsh-screen.exe'),
  ].filter((value) => typeof value === 'string');

  for (const candidate of candidates) {
    try {
      if (existsSync(candidate)) {
        resolvedHelperPath = candidate;
        return resolvedHelperPath;
      }
    } catch {
      // 权限或路径长度问题：当作这个候选不存在，继续试下一个
    }
  }
  resolvedHelperPath = undefined;
  return resolvedHelperPath;
}

/** helper 找不到时给出可操作的错误信息（而不是静默换实现） */
function requireHelperPath(config) {
  const helperPath = resolveHelperPath(config);
  if (helperPath === undefined) {
    throw new ComputerUseError(
      'dsh-screen native helper is not available; build it with `cargo build --release` in native/ '
      + 'or point config.nativeHelperPath at the executable',
    );
  }
  return helperPath;
}

/** 调原生 helper 的某个子命令，payload 走 stdin（base64(UTF8 JSON)），结果解析为 JSON */
async function runNativeHelper(runner, helperPath, args, payload, signal, maxBytes) {
  const encode = (value) => Buffer.from(JSON.stringify(value), 'utf8').toString('base64');
  return runner.runJson([helperPath, ...args], {
    signal,
    stdoutMaxBytes: maxBytes ?? 8 * 1024 * 1024,
    // 截图走文件模式，stdout 只回小 JSON，所以这里的上限不需要很大
    stdin: payload === undefined ? undefined : encode(payload),
  });
}

/**
 * 用原生 helper 抓一张图。
 *
 * 关键设计：**PNG 走文件，不走 stdout**。
 * 让 helper 把 base64 PNG 打在 stdout 上会长时间不返回（大块数据塞进管道，读取方状态不明），
 * 所以这里始终传 `--out`，stdout 只回一个很小的 JSON（宽高、真实区域、字节数）。
 */
async function nativeScreenshot(runner, config, request, signal) {
  // 没有 helper 就抛错。不回退 PowerShell：两条实现都要维护、测试覆盖不到，
  // 而且用户不知道自己实际在用哪个 —— 那是伪兼容，不如直接说清缺什么。
  const helperPath = requireHelperPath(config);

  const directory = await mkdtemp(join(tmpdir(), 'dsh-computer-use-shot-'));
  const pngPath = join(directory, 'shot.png');
  try {
    const payload = {
      maxDimension: config.screenshotMaxDimension,
      maxBytes: config.screenshotMaxBytes,
    };
    if (request.displayId !== undefined && request.displayId !== null) payload.displayId = request.displayId;
    if (request.region !== undefined && request.region !== null) payload.region = request.region;
    if (request.scale !== undefined && request.scale !== null) payload.scale = request.scale;
    // 指名窗口时把「提到前台」一并交给 helper：聚焦与抓屏必须在同一次进程调用里完成，
    // 否则第二次 spawn 冒出来的控制台窗口会盖住刚聚焦好的目标（见 captureWindow 的说明）。
    if (request.focus !== undefined && request.focus !== null) payload.focus = request.focus;

    const meta = await runNativeHelper(
      runner, helperPath, ['screenshot', '--out', pngPath], payload, signal,
      config.screenshotMaxBytes,
    );
    if (meta === null || typeof meta !== 'object' || typeof meta.path !== 'string') {
      throw new ComputerUseError('native screenshot helper returned invalid metadata');
    }
    const data = await readFile(meta.path);
    if (data.byteLength > config.screenshotMaxBytes) {
      throw new ComputerUseError('desktop screenshot exceeds configured screenshotMaxBytes');
    }
    return {
      data,
      mediaType: 'image/png',
      width: Number(meta.width),
      height: Number(meta.height),
      sourceBounds: numericBounds(meta.sourceBounds),
      capturedAt: Date.now(),
      ...(typeof meta.displayId === 'string' ? { displayId: meta.displayId } : {}),
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function listedWindowTarget(raw) {
  if (raw === null || typeof raw !== 'object'
    || typeof raw.id !== 'string' || !/^-?\d+$/.test(raw.id)
    || !Number.isInteger(raw.processId) || raw.processId < 1
    || typeof raw.title !== 'string' || raw.title.length === 0
    || raw.bounds === null || typeof raw.bounds !== 'object'
    || !Number.isFinite(raw.bounds.x) || !Number.isFinite(raw.bounds.y)
    || !Number.isFinite(raw.bounds.width) || !Number.isFinite(raw.bounds.height)
    || raw.bounds.width < 1 || raw.bounds.height < 1) {
    throw new ComputerUseError('Windows focus requires a listed native window record');
  }
  return {
    id: raw.id,
    processId: raw.processId,
    title: raw.title,
    bounds: { x: raw.bounds.x, y: raw.bounds.y, width: raw.bounds.width, height: raw.bounds.height },
  };
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

function accessibilityActionPayload(action, delayMs, maxCandidates) {
  if (action === null || typeof action !== 'object') throw new ComputerUseError('accessibility action is invalid');
  const allowed = ['invoke', 'focus', 'set_value', 'toggle', 'expand', 'collapse', 'select', 'scroll_into_view'];
  if (!allowed.includes(action.kind)) throw new ComputerUseError(`unsupported accessibility action '${action.kind}'`);
  if (typeof action.elementId !== 'string' || !/^uia:-?\d+(,-?\d+)*$/.test(action.elementId)) {
    throw new ComputerUseError('accessibility element id is invalid');
  }
  const element = action.element;
  if (element === null || typeof element !== 'object' || !Number.isInteger(element.process_id) || element.process_id < 1) {
    throw new ComputerUseError('accessibility action requires an element with a positive process_id');
  }
  if (!Number.isInteger(maxCandidates) || maxCandidates < 1) throw new ComputerUseError('accessibility action search bound is invalid');
  const payload = {
    kind: action.kind,
    elementId: action.elementId,
    processId: element.process_id,
    automationId: typeof element.automation_id === 'string' ? element.automation_id : '',
    name: typeof element.name === 'string' ? element.name : '',
    className: typeof element.class_name === 'string' ? element.class_name : '',
    role: typeof element.role === 'string' ? element.role : '',
    maxCandidates,
    delayMs,
  };
  if (action.kind === 'set_value') {
    if (typeof action.value !== 'string') throw new ComputerUseError('accessibility set_value requires a string value');
    payload.value = action.value;
  }
  return payload;
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
    // 截图一律走原生 helper（dsh-screen.exe）。
    // 早先的实现用 PowerShell 脚本抓屏，已经移除：见 nativeScreenshot 上方的说明。
    return nativeScreenshot(this.runner, this.config, request, signal);
  }

  async perform(action, signal) {
    const payload = { kind: 'action', action: actionPayload(action, this.config.actionDelayMs) };
    // 键盘注入只认前台窗口，而本进程（经 DSH 的 Windows runner）启动时就会弹出一个控制台窗口
    // 并把前台抢走 —— 所以必须在动作进程内把目标窗口抢回来，注入才落得到正确的地方。
    if (action.focus !== undefined && action.focus !== null) payload.focus = action.focus;
    await this.run(payload, signal);
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

  async focusWindow(rawTarget, signal) {
    const target = listedWindowTarget(rawTarget);
    await this.run({ kind: 'focus', ...target }, signal);
  }

  /**
   * 聚焦窗口并按它**聚焦之后**的实际边界截图——聚焦与抓屏在同一次原生调用内完成。
   *
   * 为什么必须挤成一次：宿主每 spawn 一次子进程，Windows 就可能把宿主所在的控制台窗口
   * 提到前台（dsh-subprocess-local 的 Windows runner 启动路径没有 windowsHide）。
   * 分成两次调用时，第二次启动冒出来的控制台窗口会正好盖在刚被提到前面的目标上，
   * 截回来的就是那个控制台。合成一次后，弹窗只发生在进程启动那一刻，
   * 紧接着 helper 把目标提到前台把它盖住，再抓屏拿到的就是目标本身。
   *
   * 聚焦只校验身份（句柄 + 进程 + 标题），**不比对列表时刻的旧边界**：
   * 窗口被移动过并不代表换了一个窗口；边界由 helper 在聚焦之后实时读出并回报。
   */
  async captureWindow(rawTarget, request, signal) {
    const target = listedWindowTarget(rawTarget);
    return nativeScreenshot(this.runner, this.config, {
      displayId: undefined,
      region: null,
      scale: request?.scale ?? null,
      focus: { handle: target.id, processId: target.processId, title: target.title },
    }, signal);
  }

  async accessibilitySnapshot(signal) {
    const result = await this.run({
      kind: 'accessibility',
      maxNodes: this.config.maxAccessibilityNodes,
      maxDepth: this.config.maxAccessibilityDepth,
    }, signal, this.config.maxAccessibilityBytes);
    return result;
  }

  async performAccessibility(action, signal) {
    await this.run({
      kind: 'accessibility-action',
      action: accessibilityActionPayload(action, this.config.actionDelayMs, this.config.maxAccessibilityActionCandidates),
    }, signal, this.config.maxAccessibilityBytes);
  }
}
