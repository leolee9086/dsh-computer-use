// 真实原生与 WinForms ListView：测试代码只注入消息延迟，数据仍由真正控件处理。
using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;

internal static class Native {
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] internal static extern IntPtr CreateWindowEx(int ex, string cls, string title, int style, int x, int y, int w, int h, IntPtr parent, IntPtr id, IntPtr instance, IntPtr param);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] internal static extern IntPtr SendMessage(IntPtr hwnd, int msg, IntPtr wp, IntPtr lp);
    [DllImport("user32.dll")] internal static extern bool ReplyMessage(IntPtr result);
    [DllImport("user32.dll")] internal static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] internal static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")] internal static extern bool ShowWindow(IntPtr hwnd, int command);
    [DllImport("user32.dll")] internal static extern bool SetProcessDPIAware();
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] internal static extern int GetWindowText(IntPtr hwnd, System.Text.StringBuilder text, int max);
    internal static string Title(IntPtr hwnd) { var text = new System.Text.StringBuilder(256); GetWindowText(hwnd, text, 256); return text.ToString(); }
    [DllImport("kernel32.dll")] internal static extern bool ReadProcessMemory(IntPtr process, IntPtr address, byte[] data, UIntPtr count, out UIntPtr read);
    [DllImport("kernel32.dll")] internal static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll")] internal static extern bool GetProcessHandleCount(IntPtr process, out uint count);
    internal static uint Handles() { uint count; if (!GetProcessHandleCount(GetCurrentProcess(), out count)) throw new Exception("GetProcessHandleCount failed"); return count; }
    [DllImport("kernel32.dll")] internal static extern UIntPtr VirtualQuery(IntPtr address, out MemoryInfo info, UIntPtr size);
    [DllImport("comctl32.dll")] internal static extern bool InitCommonControlsEx(ref InitControls init);
    [StructLayout(LayoutKind.Sequential)] internal struct InitControls { internal int size, classes; }
    [StructLayout(LayoutKind.Sequential)] internal struct MemoryInfo { internal IntPtr address, allocation; internal uint allocationProtect; internal UIntPtr regionSize; internal uint state, protect, type; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] internal struct Column { internal uint mask; internal int fmt, width; internal IntPtr text; internal int max, sub, order, min, def, ideal; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] internal struct Item {
        internal uint mask; internal int row, column; internal uint state, stateMask; internal IntPtr text;
        internal int max, image; internal IntPtr param; internal int indent, group; internal uint columns;
        internal IntPtr columnIndices, formats; internal int groupIndex;
    }
    internal static void WithItem(IntPtr hwnd, int message, int row, Item item) {
        IntPtr memory = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(Item)));
        try { Marshal.StructureToPtr(item, memory, false); SendMessage(hwnd, message, new IntPtr(row), memory); }
        finally { Marshal.FreeHGlobal(memory); }
    }
    internal static IntPtr PlainList(IntPtr parent) {
        InitControls init = new InitControls { size = 8, classes = 1 }; if (!InitCommonControlsEx(ref init)) throw new Exception("InitCommonControlsEx failed");
        IntPtr handle = CreateWindowEx(0, "SysListView32", "Plain standard list", 0x50000001, 10, 280, 550, 130, parent, new IntPtr(42), IntPtr.Zero, IntPtr.Zero);
        if (handle == IntPtr.Zero) throw new Exception("CreateWindowEx ListView failed");
        for (int c = 0; c < 3; c++) {
            IntPtr text = Marshal.StringToHGlobalUni("Native column " + c);
            IntPtr memory = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(Column)));
            try {
                Column column = new Column { mask = 6, width = 170, text = text };
                Marshal.StructureToPtr(column, memory, false); SendMessage(handle, 0x1061, new IntPtr(c), memory);
            } finally { Marshal.FreeHGlobal(memory); Marshal.FreeHGlobal(text); }
        }
        for (int r = 0; r < 4; r++) for (int c = 0; c < 3; c++) {
            IntPtr text = Marshal.StringToHGlobalUni(c == 0 ? "原生行 " + r : "native-" + r + "-" + c);
            try {
                Item item = new Item { mask = 1, row = r, column = c, text = text };
                WithItem(handle, c == 0 ? 0x104d : 0x1074, r, item);
            } finally { Marshal.FreeHGlobal(text); }
        }
        WithItem(handle, 0x102b, 2, new Item { state = 3, stateMask = 3 });
        return handle;
    }
}
internal sealed class DelayedList : ListView {
    internal int delayedRow = -1, delayMs, inputCount, textMessages, scalarMs, earlyResult = 777;
    internal bool replyEarly, lateSafe;
    internal IntPtr lastBuffer;
    protected override void WndProc(ref Message message) {
        if ((message.Msg >= 0x100 && message.Msg <= 0x109) || (message.Msg >= 0x201 && message.Msg <= 0x20e)) inputCount++;
        if (message.Msg == 0x1004 && scalarMs > 0) {
            int ms = scalarMs; scalarMs = 0; Console.WriteLine("scalar-entered"); Console.Out.Flush();
            Thread.Sleep(ms); base.WndProc(ref message); Console.WriteLine("scalar-completed"); Console.Out.Flush(); return;
        }
        if (message.Msg == 0x1073) {
            textMessages++;
            if (message.WParam.ToInt32() == delayedRow) {
                delayedRow = -1; lastBuffer = message.LParam;
                Console.WriteLine("text-entered:" + lastBuffer.ToInt64()); Console.Out.Flush();
                if (replyEarly) Native.ReplyMessage(new IntPtr(earlyResult));
                Thread.Sleep(delayMs);
                Native.MemoryInfo info; byte[] probe = new byte[1]; UIntPtr read;
                lateSafe = Native.VirtualQuery(lastBuffer, out info, new UIntPtr((uint)Marshal.SizeOf(typeof(Native.MemoryInfo)))) != UIntPtr.Zero
                    && info.state == 0x1000 && info.regionSize.ToUInt64() >= 8192
                    && Native.ReadProcessMemory(Native.GetCurrentProcess(), lastBuffer, probe, new UIntPtr(1), out read) && read.ToUInt64() == 1;
                if (lateSafe) base.WndProc(ref message); else message.Result = IntPtr.Zero;
                Console.WriteLine("text-completed-safe:" + lateSafe.ToString().ToLowerInvariant()); Console.Out.Flush(); return;
            }
        }
        base.WndProc(ref message);
    }
}
internal sealed class Fixture : Form {
    internal DelayedList data;
    internal ListView virtualData;
    internal Panel unsupported;
    internal Form cover;
    internal IntPtr plain;
    internal Fixture() {
        Text = "DSH Standard ListView Fixture " + (IntPtr.Size * 8); StartPosition = FormStartPosition.Manual;
        Location = new Point(130, 120); ClientSize = new Size(800, 450);
        unsupported = new Panel { Name = "UnsupportedPanel", Bounds = new Rectangle(570, 280, 180, 100) }; Controls.Add(unsupported);
        NewList();
        virtualData = new ListView { Name = "OwnerDataList", View = View.Details, VirtualMode = true, VirtualListSize = 20, Bounds = new Rectangle(570, 10, 200, 240) };
        virtualData.Columns.Add("Virtual", 170); virtualData.RetrieveVirtualItem += delegate(object sender, RetrieveVirtualItemEventArgs args) { args.Item = new ListViewItem("virtual " + args.ItemIndex); };
        Controls.Add(virtualData);
        Shown += delegate {
            plain = Native.PlainList(Handle);
            // Explorer 等真实应用包含零面积辅助 HWND，目录必须保留它且继续枚举。
            if (Native.CreateWindowEx(0, "STATIC", "Zero area helper", 0x40000000, 0, 0, 0, 0, Handle, new IntPtr(43), IntPtr.Zero, IntPtr.Zero) == IntPtr.Zero)
                throw new Exception("CreateWindowEx zero area helper failed");
            data.Items[1].Selected = true; data.Items[3].Selected = true; data.Items[3].Focused = true;
            // 官方 subprocess 以隐藏启动标志启动控制台程序；夹具自行显示其真实窗口。
            Native.ShowWindow(Handle, 5);
            Console.WriteLine(Handle.ToInt64()); Console.Out.Flush();
            Thread thread = new Thread(delegate() {
                string line; while ((line = Console.ReadLine()) != null) {
                    string command = line;
                    try { BeginInvoke(new Action(delegate { Run(command); })); } catch (InvalidOperationException) { break; }
                    if (command == "close") break;
                }
            }); thread.IsBackground = true; thread.Start();
        };
    }
    private void NewList() {
        data = new DelayedList { Name = "ManagedList", View = View.Details, FullRowSelect = true, MultiSelect = true, Bounds = new Rectangle(10, 10, 550, 250) };
        for (int c = 0; c < 3; c++) data.Columns.Add("Managed column " + c, 175);
        for (int r = 0; r < 6; r++) data.Items.Add(new ListViewItem(new string[] { "managed " + r, r == 2 ? "中文🙂" : "value " + r, r == 4 ? new string('L', 180) : "tail " + r }));
        Controls.Add(data); IntPtr handle = data.Handle;
    }
    private void Run(string command) {
        string[] parts = command.Split(':');
        if (parts[0] == "info") { Console.WriteLine("fixture-info;pid:" + Process.GetCurrentProcess().Id + ";visible:" + Visible.ToString().ToLowerInvariant() + ";nativeVisible:" + Native.IsWindowVisible(Handle).ToString().ToLowerInvariant() + ";title:" + Text + ";nativeTitle:" + Native.Title(Handle)); }
        else if (parts[0] == "state") {
            string selected = ""; foreach (int index in data.SelectedIndices) selected += (selected.Length == 0 ? "" : ",") + index;
            Console.WriteLine("selected:" + selected + ";focused:" + (data.FocusedItem == null ? -1 : data.FocusedItem.Index) + ";inputs:" + data.inputCount + ";textMessages:" + data.textMessages + ";handles:" + Native.Handles() + ";foreground:" + Native.GetForegroundWindow().ToInt64());
        } else if (parts[0] == "disable") { data.Enabled = false; Console.WriteLine("ok"); }
        else if (parts[0] == "enable") { data.Enabled = true; Console.WriteLine("ok"); }
        else if (parts[0] == "delay") { data.delayedRow = int.Parse(parts[1]); data.delayMs = int.Parse(parts[2]); data.replyEarly = parts.Length > 3 && parts[3] == "reply"; data.earlyResult = parts.Length > 4 ? int.Parse(parts[4]) : 777; Console.WriteLine("ok"); }
        else if (parts[0] == "hang-count") { data.scalarMs = int.Parse(parts[1]); Console.WriteLine("ok"); }
        else if (parts[0] == "replace") { data.Dispose(); NewList(); Console.WriteLine("ok"); }
        else if (parts[0] == "cover") {
            cover = new Form { Text = "ListView observation cover", StartPosition = FormStartPosition.Manual, Location = Location, Size = Size };
            cover.Show(); cover.Activate(); Console.WriteLine(cover.Handle.ToInt64());
        } else if (parts[0] == "close") { if (cover != null) cover.Close(); Console.WriteLine("closed"); Close(); }
        else throw new Exception("Unknown fixture command: " + command);
        Console.Out.Flush();
    }
    [STAThread] private static void Main() { Native.SetProcessDPIAware(); Application.EnableVisualStyles(); Application.Run(new Fixture()); }
}
