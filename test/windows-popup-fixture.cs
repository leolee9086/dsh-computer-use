// 四种真正的窗口协议：Win32 TrackPopupMenu、WinForms DropDown、WPF Popup、跨进程 owner 对话框。
// 使用框架自带 AutomationPeer/provider；stdin 只安排夹具变化，业务动作必须由生产工具发送。
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;
using System.Web.Script.Serialization;
using Forms = System.Windows.Forms;
using Wpf = System.Windows;
using Controls = System.Windows.Controls;
using Primitives = System.Windows.Controls.Primitives;
using System.Windows.Automation;
using System.Windows.Interop;
using System.Windows.Threading;

public static class PopupNative {
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hwnd, int command);
    [DllImport("user32.dll")] public static extern IntPtr CreatePopupMenu();
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern bool AppendMenu(IntPtr menu, uint flags, UIntPtr id, string text);
    [DllImport("user32.dll", SetLastError=true)] public static extern uint TrackPopupMenu(IntPtr menu, uint flags, int x, int y, int reserved, IntPtr hwnd, IntPtr rect);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool DestroyMenu(IntPtr menu);
    [DllImport("user32.dll")] public static extern bool EndMenu();
    [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hwnd, int message, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll", EntryPoint="SetWindowLongPtrW")] public static extern IntPtr SetOwner(IntPtr hwnd, int index, IntPtr owner);
}
public class PopupForm : Forms.Form {
    public int ExternalActions, NativeCommands, MenuEnters, MenuExits;
    public Action ExternalChanged, NativeChanged;
    protected override void WndProc(ref Forms.Message message) {
        if (message.Msg == 0x8011) { ExternalActions++; if (ExternalChanged != null) ExternalChanged(); }
        if (message.Msg == 0x211) MenuEnters++;
        if (message.Msg == 0x212) MenuExits++;
        // 标准菜单由 WM_COMMAND 交付选择；UIA 的 Win32 菜单 provider 也使用此协议。
        if (message.Msg == 0x111 && ((long)message.WParam & 0xffff) == 100) {
            NativeCommands++; if (NativeChanged != null) NativeChanged();
        }
        base.WndProc(ref message);
    }
}
public class PopupFixture {
    static string Mode, Title;
    static int Opens, Actions, Replacements, MenuStarts, MenuReturns, TrackError;
    static uint TrackReturn;
    static bool ForegroundRequest;
    static string ForegroundBefore, ForegroundAtTrack, ForegroundAfter;
    static bool Disabled;
    static PopupForm MainForm;
    static Forms.Label FormsStatus;
    static Forms.ToolStripDropDown DropDown;
    static readonly List<Forms.Form> Extras = new List<Forms.Form>();
    static readonly List<Process> ExternalProcesses = new List<Process>();
    static Wpf.Window WpfWindow;
    static Controls.TextBlock WpfStatus;
    static Primitives.Popup WpfPopup;
    static Controls.Button WpfOpen;
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
    static void Print(object value) { Console.WriteLine(Json.Serialize(value)); Console.Out.Flush(); }
    static void Status() {
        string text = Mode + " " + (Mode == "external" ? MainForm.ExternalActions : Actions);
        if (WpfStatus != null) { WpfStatus.Text = text; AutomationProperties.SetName(WpfStatus, text); }
        if (FormsStatus != null) FormsStatus.Text = text;
    }
    static void Later(int ms, Action action) {
        if (Mode == "wpf") {
            var timer = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(ms) };
            timer.Tick += delegate { timer.Stop(); action(); }; timer.Start();
        } else {
            var timer = new Forms.Timer { Interval = ms };
            timer.Tick += delegate { timer.Stop(); timer.Dispose(); action(); }; timer.Start();
        }
    }
    static void Open(bool count) {
        if (count) Opens++;
        if (Mode == "native") {
            // Invoke 返回后再进入真正的 Win32 菜单循环，不能用夹具伪造一个菜单窗口。
            Later(60, delegate {
                IntPtr menu = PopupNative.CreatePopupMenu();
                try {
                    PopupNative.AppendMenu(menu, 0, new UIntPtr(100), "Run native item");
                    PopupNative.AppendMenu(menu, 0, new UIntPtr(101), "Dismiss");
                    // 按 Win32 上下文菜单协议先把 owner 置于前台；记录实际前台与菜单循环，而不靠 Invoke 返回猜业务结果。
                    ForegroundBefore = PopupNative.GetForegroundWindow().ToInt64().ToString();
                    ForegroundRequest = PopupNative.SetForegroundWindow(MainForm.Handle);
                    ForegroundAtTrack = PopupNative.GetForegroundWindow().ToInt64().ToString();
                    MenuStarts++;
                    TrackReturn = PopupNative.TrackPopupMenu(menu, 0, 120, 150, 0, MainForm.Handle, IntPtr.Zero);
                    TrackError = TrackReturn == 0 ? Marshal.GetLastWin32Error() : 0;
                    MenuReturns++; ForegroundAfter = PopupNative.GetForegroundWindow().ToInt64().ToString();
                    PopupNative.PostMessage(MainForm.Handle, 0, IntPtr.Zero, IntPtr.Zero);
                } finally { PopupNative.DestroyMenu(menu); }
            });
        } else if (Mode == "forms") {
            DropDown = new Forms.ToolStripDropDown();
            var item = new Forms.ToolStripMenuItem("Run forms item") { Enabled = !Disabled };
            item.Click += delegate { Actions++; Status(); DropDown.Close(); };
            DropDown.Items.Add(item); DropDown.Show(MainForm, new System.Drawing.Point(20, 90));
        } else if (Mode == "wpf") {
            var item = new Controls.Button { Content = "Run WPF item", Width = 210, Height = 60, IsEnabled = !Disabled };
            AutomationProperties.SetName(item, "Run WPF item"); AutomationProperties.SetAutomationId(item, "popup-item");
            var border = new Controls.Border { Background = System.Windows.Media.Brushes.White, Child = item };
            WpfPopup = new Primitives.Popup { Child = border, PlacementTarget = WpfOpen, Placement = Primitives.PlacementMode.Bottom, StaysOpen = true, IsOpen = true };
            item.Click += delegate { Actions++; Status(); WpfPopup.IsOpen = false; };
        } else {
            var start = new ProcessStartInfo(Process.GetCurrentProcess().MainModule.FileName,
                "dialog " + MainForm.Handle.ToInt64() + " \"" + Title + " dialog\"") { UseShellExecute = false };
            ExternalProcesses.Add(Process.Start(start));
        }
    }
    static void ClosePopup() {
        if (DropDown != null) { DropDown.Close(); DropDown.Dispose(); DropDown = null; }
        if (WpfPopup != null) { WpfPopup.IsOpen = false; WpfPopup = null; }
        if (Mode == "native") PopupNative.EndMenu();
    }
    static void Command(string command) {
        if (command == "state") Print(new { mode = Mode, opens = Opens, actions = Actions, externalActions = MainForm == null ? 0 : MainForm.ExternalActions, nativeCommands = MainForm == null ? 0 : MainForm.NativeCommands, replacements = Replacements,
            nativeMenu = Mode == "native" ? new { starts = MenuStarts, returns = MenuReturns, enters = MainForm.MenuEnters, exits = MainForm.MenuExits, trackReturn = TrackReturn, trackError = TrackError, foregroundRequest = ForegroundRequest, foregroundBefore = ForegroundBefore, foregroundAtTrack = ForegroundAtTrack, foregroundAfter = ForegroundAfter } : null });
        else if (command == "disable-next") { Disabled = true; Print("disabled"); }
        else if (command == "replace") {
            Later(250, delegate { ClosePopup(); Disabled = false; Replacements++; Later(100, delegate { Open(false); }); }); Print("scheduled");
        } else if (command == "duplicates") {
            for (int i = 0; i < 2; i++) { var dialog = new Forms.Form { Text = Title + " duplicate", Width = 260, Height = 130 };
                var button = new Forms.Button { Text = "Wrong item", Dock = Forms.DockStyle.Fill };
                button.Click += delegate { throw new Exception("duplicate candidate was incorrectly invoked"); };
                dialog.Controls.Add(button); dialog.Show(MainForm); Extras.Add(dialog); }
            Print("duplicates-open");
        } else if (command == "duplicates-close") { foreach (var extra in Extras) extra.Close(); Extras.Clear(); Print("duplicates-closed"); }
        else if (command == "rename") { MainForm.Text = Title + " renamed"; Print("renamed"); }
        else if (command == "restore-title") { MainForm.Text = Title; Print("restored"); }
        else if (command == "quit") {
            ClosePopup(); foreach (var extra in Extras) extra.Close();
            foreach (var process in ExternalProcesses) { if (!process.HasExited) { process.CloseMainWindow(); if (!process.WaitForExit(1000)) process.Kill(); } process.Dispose(); }
            Print("quitting"); if (Mode == "wpf") Wpf.Application.Current.Shutdown(); else MainForm.Close();
        } else Print("unknown");
    }
    static void Reader(Action<Action> dispatch) {
        new Thread(delegate() { string line; while ((line = Console.ReadLine()) != null) { string command = line; dispatch(delegate { Command(command); }); } }) { IsBackground = true }.Start();
    }
    static void FormsMain() {
        MainForm = new PopupForm { Text = Title, Width = 480, Height = 240, Left = 60, Top = 60 };
        var open = new Forms.Button { Text = "Open menu", AccessibleName = "Open menu", Left = 20, Top = 20, Width = 180 };
        open.Click += delegate { Open(true); }; MainForm.Controls.Add(open);
        FormsStatus = new Forms.Label { Text = Mode + " 0", Left = 20, Top = 65, Width = 360 }; MainForm.Controls.Add(FormsStatus);
        MainForm.ExternalChanged = Status;
        MainForm.NativeChanged = delegate { Actions++; Status(); };
        MainForm.Shown += delegate { PopupNative.ShowWindow(MainForm.Handle, 5); Print(new { hwnd = MainForm.Handle.ToInt64().ToString(), pid = Process.GetCurrentProcess().Id });
            Reader(action => MainForm.BeginInvoke(action)); };
        Forms.Application.Run(MainForm);
    }
    static void WpfMain() {
        var app = new Wpf.Application(); WpfWindow = new Wpf.Window { Title = Title, Width = 480, Height = 240, Left = 60, Top = 60 };
        var panel = new Controls.StackPanel(); WpfOpen = new Controls.Button { Content = "Open menu", Margin = new Wpf.Thickness(20), Height = 35 };
        AutomationProperties.SetName(WpfOpen, "Open menu"); WpfOpen.Click += delegate { Open(true); }; panel.Children.Add(WpfOpen);
        WpfStatus = new Controls.TextBlock { Text = "wpf 0" }; AutomationProperties.SetName(WpfStatus, "wpf 0"); panel.Children.Add(WpfStatus); WpfWindow.Content = panel;
        WpfWindow.Loaded += delegate { var hwnd = new WindowInteropHelper(WpfWindow).Handle; PopupNative.ShowWindow(hwnd, 5);
            Print(new { hwnd = hwnd.ToInt64().ToString(), pid = Process.GetCurrentProcess().Id }); Reader(action => WpfWindow.Dispatcher.BeginInvoke(action)); };
        app.Run(WpfWindow);
    }
    static void DialogMain(IntPtr owner) {
        var dialog = new Forms.Form { Text = Title, Width = 300, Height = 160, Left = 180, Top = 120 };
        var confirm = new Forms.Button { Text = "Confirm external", Dock = Forms.DockStyle.Fill };
        confirm.Click += delegate { PopupNative.PostMessage(owner, 0x8011, IntPtr.Zero, IntPtr.Zero); dialog.Close(); }; dialog.Controls.Add(confirm);
        dialog.Shown += delegate { PopupNative.SetOwner(dialog.Handle, -8, owner); PopupNative.ShowWindow(dialog.Handle, 5); };
        Forms.Application.Run(dialog);
    }
    [STAThread] public static void Main(string[] args) {
        Console.InputEncoding = new System.Text.UTF8Encoding(false); Console.OutputEncoding = new System.Text.UTF8Encoding(false);
        PopupNative.SetProcessDPIAware(); Mode = args[0];
        if (Mode == "dialog") { Title = args[2]; DialogMain(new IntPtr(long.Parse(args[1]))); return; }
        Title = args[1]; if (Mode == "wpf") WpfMain(); else FormsMain();
    }
}
