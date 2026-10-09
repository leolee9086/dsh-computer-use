// 默认 WPF AutomationPeer 的真实任务夹具；stdin 只安排应用状态变化。
// 所有展开、选择、滚动、Grid读取与业务按钮动作都由生产工具完成。
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

public class DataRow { public string Value { get; set; } }
public class DataFixture {
    static Window MainWindow; static TreeView Tree; static TreeViewItem Root, Branch, Leaf;
    static ListBox VirtualList; static DataGrid Grid; static ScrollViewer Scroller; static TextBlock ScrollStatus;
    static string Mode = "normal"; static int RootExpands, BranchExpands, OtherExpands, Replacements, Selections, ScrollActions;
    static void Name(DependencyObject element, string name, string id) { AutomationProperties.SetName(element, name); AutomationProperties.SetAutomationId(element, id); }
    static void Later(int ms, Action action) {
        var timer = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(ms) };
        timer.Tick += delegate { timer.Stop(); action(); }; timer.Start();
    }
    static TreeViewItem MakeBranch(bool replacement) {
        var node = new TreeViewItem { Header = "Branch" }; Name(node, "Branch", "branch");
        node.Items.Add(new TreeViewItem { Header = "Loading branch" }); bool loaded = false;
        node.Expanded += delegate(object sender, RoutedEventArgs e) {
            if (e.OriginalSource != node || loaded) return; loaded = true; BranchExpands++;
            if (Mode == "replace" && !replacement) {
                Later(120, delegate { Root.Items.Remove(node); Branch = MakeBranch(true); Root.Items.Add(Branch); Replacements++; });
            } else if (Mode != "missing") Later(120, delegate {
                node.Items.Clear(); Leaf = new TreeViewItem { Header = "Target leaf" }; Name(Leaf, "Target leaf", "leaf");
                Leaf.Selected += delegate(object s, RoutedEventArgs selected) { if (selected.OriginalSource == Leaf) Selections++; };
                node.Items.Add(Leaf);
            });
        };
        return node;
    }
    static void ResetTree(string mode) {
        Mode = mode; RootExpands = BranchExpands = OtherExpands = Replacements = Selections = 0;
        Tree.Items.Clear(); Leaf = null; Branch = null;
        Root = new TreeViewItem { Header = "Root" }; Name(Root, "Root", "root");
        Root.Items.Add(new TreeViewItem { Header = "Loading root" }); bool loaded = false;
        Root.Expanded += delegate(object sender, RoutedEventArgs e) {
            if (e.OriginalSource != Root || loaded) return; loaded = true; RootExpands++;
            Later(120, delegate { Root.Items.Clear(); Branch = MakeBranch(false); Root.Items.Add(Branch); });
        };
        var other = new TreeViewItem { Header = "Unrelated" }; Name(other, "Unrelated", "unrelated");
        other.Items.Add(new TreeViewItem { Header = "Other child" });
        other.Expanded += delegate(object sender, RoutedEventArgs e) { if (e.OriginalSource == other) OtherExpands++; };
        Tree.Items.Add(Root); Tree.Items.Add(other);
    }
    static void Command(string text) {
        if (text.StartsWith("tree ")) { ResetTree(text.Substring(5)); Console.WriteLine("tree-ready"); }
        else if (text == "tree-state") Console.WriteLine("root:" + RootExpands + ";branch:" + BranchExpands + ";other:" + OtherExpands + ";replacements:" + Replacements + ";selections:" + Selections + ";selected:" + (Leaf != null && Leaf.IsSelected));
        else if (text == "virtual-state") Console.WriteLine("selected:" + VirtualList.SelectedItem);
        else if (text == "grid-state") {
            string selected = "none"; if (Grid.SelectedCells.Count == 1) selected = ((DataRow)Grid.SelectedCells[0].Item).Value;
            Console.WriteLine("selected:" + selected + ";realized579:" + (Grid.ItemContainerGenerator.ContainerFromIndex(579) != null));
        }
        else if (text == "scroll-reset") { Scroller.ScrollToTop(); Console.WriteLine("scroll-reset"); }
        else if (text == "scroll-state") Console.WriteLine("actions:" + ScrollActions + ";offset:" + Scroller.VerticalOffset.ToString(System.Globalization.CultureInfo.InvariantCulture));
        else if (text == "quit") { Console.WriteLine("quitting"); Application.Current.Shutdown(); }
        else Console.WriteLine("unknown");
        Console.Out.Flush();
    }
    [STAThread] public static void Main() {
        Console.InputEncoding = new System.Text.UTF8Encoding(false); Console.OutputEncoding = new System.Text.UTF8Encoding(false);
        var app = new Application(); MainWindow = new Window { Title = "Computer data tasks fixture", Width = 700, Height = 790, Left = 50, Top = 20 };
        var body = new StackPanel();
        Tree = new TreeView { Height = 135 }; Name(Tree, "Task tree", "task-tree"); ResetTree("normal"); body.Children.Add(Tree);
        VirtualList = new ListBox { Height = 110 }; Name(VirtualList, "Virtual list", "virtual-list");
        VirtualizingPanel.SetIsVirtualizing(VirtualList, true); VirtualizingPanel.SetVirtualizationMode(VirtualList, VirtualizationMode.Recycling);
        ScrollViewer.SetCanContentScroll(VirtualList, true); for (int i = 0; i < 600; i++) VirtualList.Items.Add("Virtual item " + i); body.Children.Add(VirtualList);
        Grid = new DataGrid { Height = 170, AutoGenerateColumns = false, SelectionUnit = DataGridSelectionUnit.Cell, IsReadOnly = true, EnableRowVirtualization = true };
        Name(Grid, "Records", "records"); Grid.Columns.Add(new DataGridTextColumn { Header = "Value", Binding = new Binding("Value") });
        var rows = new ObservableCollection<DataRow>(); for (int i = 0; i < 600; i++) rows.Add(new DataRow { Value = "Row " + i }); Grid.ItemsSource = rows; body.Children.Add(Grid);
        // ScrollViewer 默认peer有ScrollPattern，没有ItemContainer；只限此容器查找。
        Scroller = new ScrollViewer { Height = 110, Width = 320, VerticalScrollBarVisibility = ScrollBarVisibility.Visible }; Name(Scroller, "Scroll items", "scroll-items");
        var items = new StackPanel(); for (int i = 0; i < 80; i++) {
            var button = new Button { Content = "Scroll item " + i, Height = 25 }; Name(button, "Scroll item " + i, "scroll-item-" + i);
            // InvokePattern 可以先返回再由 Dispatcher 执行 Click；只有这里更新业务状态。
            button.Click += delegate {
                ScrollActions++; ScrollStatus.Text = "Scroll actions " + ScrollActions;
                AutomationProperties.SetName(ScrollStatus, ScrollStatus.Text);
            }; items.Children.Add(button);
        }
        Scroller.Content = items; body.Children.Add(Scroller);
        ScrollStatus = new TextBlock { Text = "Scroll actions 0", Height = 20 };
        Name(ScrollStatus, ScrollStatus.Text, "scroll-status"); body.Children.Add(ScrollStatus);
        var unsupported = new GroupBox { Header = "No scroll pattern", Content = new TextBlock { Text = "Ordinary text" }, Height = 45 };
        Name(unsupported, "No scroll pattern", "no-scroll"); body.Children.Add(unsupported);
        MainWindow.Content = body;
        MainWindow.Loaded += delegate { Console.WriteLine(new WindowInteropHelper(MainWindow).Handle.ToInt64()); Console.Out.Flush();
            new Thread(delegate() { string line; while ((line = Console.ReadLine()) != null) { var command = line;
                MainWindow.Dispatcher.BeginInvoke(new Action(delegate { Command(command); })); } }) { IsBackground = true }.Start(); };
        app.Run(MainWindow);
    }
}
