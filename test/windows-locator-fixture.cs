// 真正的 WPF 控件与默认 AutomationPeer；不伪造 UIA 查询结果。
// stdin 只控制夹具的定时变化，所有验收动作经生产 worker/ToolRuntime。
using System;
using System.IO;
using System.Threading;
using System.Collections.ObjectModel;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Automation;
using System.Windows.Data;
using System.Windows.Interop;
using System.Windows.Threading;

public class FixtureRow { public string Value { get; set; } public override string ToString() { return Value; } }
public class LocatorFixture {
    static Window MainWindow, Popup, Other;
    static StackPanel Panels; static GroupBox Right; static TextBox Input, OtherInput; static TextBlock Status;
    static int Actions, Generation, OtherActions; static bool OpenPopup, OtherWasForeground;
    [System.Runtime.InteropServices.DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    static void ReplaceRight() { Panels.Children.Remove(Right); Right = Panel("Right panel", true); Panels.Children.Add(Right); Generation++; }
    static void Interfere() {
        // 模拟人在等待期间改值、切到含相同控件的另一个窗口，再替换原目标。
        Input.Text = "manual edit";
        Other = new Window { Title = "Computer locator other window", Width = 340, Height = 200, Left = 720, Top = 80 };
        var group = new GroupBox { Header = "Right panel" }; Name(group, "Right panel", "right-panel");
        var body = new StackPanel(); OtherInput = new TextBox { Text = "other manual" }; Name(OtherInput, "Input", "input");
        var button = new Button { Content = "Apply" }; Name(button, "Apply", "apply");
        button.Click += delegate { OtherActions++; }; body.Children.Add(OtherInput); body.Children.Add(button); group.Content = body;
        Other.Content = group; Other.Show(); Other.Activate();
        OtherWasForeground = GetForegroundWindow() == new WindowInteropHelper(Other).Handle;
        Later(500, ReplaceRight);
    }
    static void Name(DependencyObject element, string name, string id) { AutomationProperties.SetName(element, name); AutomationProperties.SetAutomationId(element, id); }
    static void Later(int ms, Action action) {
        var timer = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(ms) };
        timer.Tick += delegate { timer.Stop(); action(); }; timer.Start();
    }
    static GroupBox Panel(string label, bool enabled) {
        var group = new GroupBox { Header = label, Margin = new Thickness(4), Width = 250 };
        Name(group, label, label == "Right panel" ? "right-panel" : "left-panel");
        var contents = new StackPanel();
        var input = new TextBox { Text = "initial", Margin = new Thickness(4), IsEnabled = enabled };
        Name(input, "Input", "input"); contents.Children.Add(input);
        var button = new Button { Content = "Apply", Margin = new Thickness(4), IsEnabled = enabled };
        Name(button, "Apply", "apply");
        button.Click += delegate { Actions++; Later(150, delegate {
            Status.Text = "Applied " + Actions; AutomationProperties.SetName(Status, Status.Text);
            if (OpenPopup) { Popup = new Window { Title = "Computer locator popup", Width = 250, Height = 150, Owner = MainWindow };
                var close = new Button { Content = "Confirm" }; Name(close, "Confirm", "confirm");
                close.Click += delegate { Actions++; Popup.Close(); }; Popup.Content = close; Popup.Show(); }
        }); };
        contents.Children.Add(button); group.Content = contents;
        if (label == "Right panel") Input = input;
        return group;
    }
    static void Command(string text) {
        if (text == "replace") { Later(250, ReplaceRight); Console.WriteLine("scheduled"); }
        else if (text == "interfere") { Interfere(); Console.WriteLine("interfering"); }
        else if (text == "interference-state") Console.WriteLine("other-actions:" + OtherActions + ";other-value:" + OtherInput.Text + ";other-was-foreground:" + OtherWasForeground + ";other-foreground:" + (GetForegroundWindow() == new WindowInteropHelper(Other).Handle));
        else if (text == "other-close") { Other.Close(); Console.WriteLine("other-closed"); }
        else if (text == "replace-now") { ReplaceRight(); Console.WriteLine("replaced"); }
        else if (text == "manual-edit") { Input.Text = "manual after action"; Console.WriteLine("manually-edited"); }
        else if (text == "rename-window") { MainWindow.Title = "Computer locator renamed window"; Console.WriteLine("window-renamed"); }
        else if (text == "restore-window") { MainWindow.Title = "Computer locator fixture"; Console.WriteLine("window-restored"); }
        else if (text == "disable") { Right.IsEnabled = false; Console.WriteLine("disabled"); }
        else if (text == "enable") { Right.IsEnabled = true; Console.WriteLine("enabled"); }
        else if (text == "popup") { OpenPopup = true; Console.WriteLine("popup-enabled"); }
        else if (text == "state") Console.WriteLine("actions:" + Actions + ";generation:" + Generation + ";value:" + Input.Text);
        else if (text == "quit") { Console.WriteLine("quitting"); Application.Current.Shutdown(); }
        else Console.WriteLine("unknown");
        Console.Out.Flush();
    }
    [STAThread] public static void Main() {
        Console.InputEncoding = new System.Text.UTF8Encoding(false); Console.OutputEncoding = new System.Text.UTF8Encoding(false);
        var app = new Application(); MainWindow = new Window { Title = "Computer locator fixture", Width = 620, Height = 880, Left = 50, Top = 20 };
        var body = new StackPanel(); Panels = new StackPanel { Orientation = Orientation.Horizontal };
        Panels.Children.Add(Panel("Left panel", true)); Right = Panel("Right panel", false); Panels.Children.Add(Right); body.Children.Add(Panels);
        Status = new TextBlock { Text = "Ready", Margin = new Thickness(4) }; Name(Status, "Status", "status"); body.Children.Add(Status);
        var tree = new TreeView { Height = 90 }; Name(tree, "Lazy tree", "lazy-tree");
        var root = new TreeViewItem { Header = "Root" }; Name(root, "Root", "root");
        // placeholder 保留展开模式，叶子直到展开后才被加载。
        root.Items.Add(new TreeViewItem { Header = "Loading" }); bool loaded = false;
        root.Expanded += delegate { if (!loaded) { loaded = true; Later(100, delegate { root.Items.Clear();
            var leaf = new TreeViewItem { Header = "Leaf" }; Name(leaf, "Leaf", "leaf"); root.Items.Add(leaf); }); } };
        tree.Items.Add(root); body.Children.Add(tree);
        var list = new ListBox { Height = 120 }; Name(list, "Virtual list", "virtual-list");
        VirtualizingPanel.SetIsVirtualizing(list, true); VirtualizingPanel.SetVirtualizationMode(list, VirtualizationMode.Recycling);
        ScrollViewer.SetCanContentScroll(list, true); for (int i = 0; i < 600; i++) list.Items.Add("Virtual item " + i); body.Children.Add(list);
        var grid = new DataGrid { Height = 190, AutoGenerateColumns = false, SelectionUnit = DataGridSelectionUnit.Cell, IsReadOnly = true };
        Name(grid, "Records", "records"); grid.Columns.Add(new DataGridTextColumn { Header = "Value", Binding = new Binding("Value") });
        var data = new ObservableCollection<FixtureRow>(); for (int i = 0; i < 40; i++) data.Add(new FixtureRow { Value = "Row " + i }); grid.ItemsSource = data; body.Children.Add(grid);
        MainWindow.Content = body;
        MainWindow.Loaded += delegate { Console.WriteLine(new WindowInteropHelper(MainWindow).Handle.ToInt64()); Console.Out.Flush();
            new Thread(delegate() { string line; while ((line = Console.ReadLine()) != null) { var command = line;
                MainWindow.Dispatcher.BeginInvoke(new Action(delegate { Command(command); })); } }) { IsBackground = true }.Start(); };
        app.Run(MainWindow);
    }
}
