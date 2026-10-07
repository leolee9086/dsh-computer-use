// 真实 UIA/MSAA 提供者：一万兄弟节点和十二层深分支，不需要在工作模型上导航。
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Automation;
using System.Windows.Automation.Provider;
using System.Windows.Forms;
using System.Drawing;

public class LargeTreeForm : Form
{
    public static bool Blocking, BlockingAction;
    public static int Invocations;
    public static int PropertyReads, PatternReads, Navigations, RuntimeIds;
    public static void ResetStats() { Interlocked.Exchange(ref PropertyReads, 0); Interlocked.Exchange(ref PatternReads, 0); Interlocked.Exchange(ref Navigations, 0); Interlocked.Exchange(ref RuntimeIds, 0); }
    public static string Stats() { return "{\"property_reads\":"+PropertyReads+",\"pattern_reads\":"+PatternReads+",\"navigations\":"+Navigations+",\"runtime_ids\":"+RuntimeIds+"}"; }
    public static int LegacyCount = 10000;
    public static readonly List<int> LegacyOrder = new List<int>();
    public static readonly Dictionary<int, string> LegacyNames = new Dictionary<int, string>();
    public static LargeTreeForm Instance;
    public readonly RawNode Root;
    public LargeTreeForm() {
        Instance = this; Text = "DSH semantic large-tree fixture"; Width = 500; Height = 300;
        Root = new RawNode(this, null, -1, 0);
        for (int i=0; i<10000; i++) { Root.Children.Add(new RawNode(this, Root, i, 1)); LegacyOrder.Add(i); }
        var branch = new RawNode(this, Root, 10000, 1); Root.Children.Add(branch);
        for (int depth=2; depth<=13; depth++) { var child = new RawNode(this, branch, 10000+depth, depth); branch.Children.Add(child); branch = child; }
    }
    [DllImport("user32.dll")] static extern void NotifyWinEvent(uint ev, IntPtr hwnd, int objectId, int childId);
    [DllImport("UIAutomationCore.dll")] static extern IntPtr UiaReturnRawElementProvider(IntPtr hwnd, IntPtr wparam, IntPtr lparam, IRawElementProviderSimple provider);
    protected override void WndProc(ref System.Windows.Forms.Message message) {
        if (message.Msg == 0x003D && message.LParam.ToInt64() == -25) { message.Result = UiaReturnRawElementProvider(Handle, message.WParam, message.LParam, Root); return; }
        base.WndProc(ref message);
    }
    protected override AccessibleObject CreateAccessibilityInstance() { return new LegacyRoot(this); }
    public class LegacyRoot : Control.ControlAccessibleObject {
        LargeTreeForm OwnerForm;
        public LegacyRoot(LargeTreeForm owner):base(owner) { OwnerForm=owner; }
        public override int GetChildCount() { return LegacyCount; }
        public override AccessibleObject GetChild(int index) { return index>=0 && index<LegacyCount ? new LegacyChild(this, index < LegacyOrder.Count ? LegacyOrder[index] : index) : null; }
        public override string Name { get { return "MSAA large-tree root"; } }
    }
    public class LegacyChild : AccessibleObject {
        AccessibleObject RootObject; int Index;
        public LegacyChild(AccessibleObject parent, int index) { RootObject=parent; Index=index; }
        public override AccessibleObject Parent { get { return RootObject; } }
        public override string Name { get {
            if (Blocking && Index==9998) Thread.Sleep(60000);
            string renamed; return LegacyNames.TryGetValue(Index, out renamed) ? renamed : "Legacy item "+Index;
        } }
        public override AccessibleRole Role { get { return AccessibleRole.PushButton; } }
        public override AccessibleStates State { get { return AccessibleStates.Focusable | AccessibleStates.Offscreen; } }
        public override Rectangle Bounds { get { return new Rectangle(20,20,10,10); } }
        public override string DefaultAction { get { return "Press"; } }
        public override void DoDefaultAction() { Interlocked.Increment(ref Invocations); }
        public override int GetChildCount() { return 0; }
    }
    [STAThread] public static void Main() {
        var form = new LargeTreeForm(); form.Show();
        Console.WriteLine(form.Handle.ToInt64()); Console.Out.Flush();
        var commands = new Thread(delegate() {
            string line;
            while ((line=Console.ReadLine()) != null) {
                if (line=="block") { Blocking=true; Console.WriteLine("blocked-enabled"); }
                else if (line=="unblock") { Blocking=false; Console.WriteLine("blocked-disabled"); }
                else if (line=="block_action") { BlockingAction=true; Console.WriteLine("action-block-enabled"); }
                else if (line=="count") Console.WriteLine("count:"+Invocations);
                else if (line=="reset_stats") { ResetStats(); Console.WriteLine("stats-reset"); }
                else if (line=="stats") Console.WriteLine(Stats());
                else if (line=="change_legacy") { LegacyCount++; NotifyWinEvent(0x8004, form.Handle, -4, 0); Console.WriteLine("legacy-changed"); }
                // 静默变更故意不发事件：测试完整复读能捕捉八个前缀锚点以外的变化。
                else if (line.StartsWith("resize:")) {
                    int count = int.Parse(line.Substring(7));
                    form.BeginInvoke((Action)delegate() {
                        form.Root.Children.RemoveRange(count, form.Root.Children.Count-count);
                        LegacyCount=count; LegacyOrder.RemoveRange(count,LegacyOrder.Count-count);
                        Console.WriteLine("resized"); Console.Out.Flush();
                    });
                }
                else if (line.StartsWith("rename:") || line.StartsWith("rename_event:") || line.StartsWith("rename_legacy:")) {
                    var parts = line.Split(new [] { ':' }, 3); int index=int.Parse(parts[1]);
                    form.BeginInvoke((Action)delegate() {
                        if (parts[0]=="rename_legacy") LegacyNames[index]=parts[2];
                        else {
                            var node=form.Root.Children.Find(item=>item.ItemIndex==index); string old=node.DisplayName; node.DisplayName=parts[2];
                            if (parts[0]=="rename_event") AutomationInteropProvider.RaiseAutomationPropertyChangedEvent(node,
                                new AutomationPropertyChangedEventArgs(AutomationElementIdentifiers.NameProperty,old,parts[2]));
                        }
                        Console.WriteLine("renamed"); Console.Out.Flush();
                    });
                }
                else if (line=="reorder_silent" || line=="reorder_legacy_silent" || line=="insert_silent" || line=="remove_silent") {
                    string change=line;
                    form.BeginInvoke((Action)delegate() {
                        if (change=="reorder_silent") { var old=form.Root.Children[12]; form.Root.Children[12]=form.Root.Children[13]; form.Root.Children[13]=old; }
                        else if (change=="reorder_legacy_silent") { int old=LegacyOrder[12]; LegacyOrder[12]=LegacyOrder[13]; LegacyOrder[13]=old; }
                        else if (change=="insert_silent") form.Root.Children.Insert(24,new RawNode(form,form.Root,20001,1));
                        else form.Root.Children.RemoveAt(24);
                        Console.WriteLine("mutated"); Console.Out.Flush();
                    });
                }
                else if (line=="change") form.BeginInvoke((Action)delegate() {
                    form.Root.Children.Insert(0, new RawNode(form,form.Root,20001,1));
                    AutomationInteropProvider.RaiseStructureChangedEvent(form.Root, new StructureChangedEventArgs(StructureChangeType.ChildrenInvalidated, form.Root.GetRuntimeId()));
                    Console.WriteLine("changed"); Console.Out.Flush();
                });
                else if (line=="close") { form.BeginInvoke((Action)delegate() { form.Close(); }); break; }
                Console.Out.Flush();
            }
        }); commands.IsBackground=true; commands.Start();
        Application.Run(form);
    }
}

public class RawNode : IRawElementProviderSimple, IRawElementProviderFragmentRoot, IInvokeProvider, IVirtualizedItemProvider, IItemContainerProvider
{
    LargeTreeForm Form; RawNode ParentNode; int Index, Depth;
    public readonly List<RawNode> Children = new List<RawNode>();
    public string DisplayName;
    public int ItemIndex { get { return Index; } }
    public RawNode(LargeTreeForm form, RawNode parent, int index, int depth) { Form=form; ParentNode=parent; Index=index; Depth=depth; }
    public ProviderOptions ProviderOptions { get { return ProviderOptions.ServerSideProvider; } }
    public IRawElementProviderSimple HostRawElementProvider { get { return ParentNode == null ? AutomationInteropProvider.HostProviderFromHandle(Form.Handle) : null; } }
    public object GetPatternProvider(int id) {
        Interlocked.Increment(ref LargeTreeForm.PatternReads);
        if (Index>=0 && id==InvokePatternIdentifiers.Pattern.Id) return this;
        if (Index==9999 && id==VirtualizedItemPatternIdentifiers.Pattern.Id) return this;
        if (Index==-1 && id==ItemContainerPatternIdentifiers.Pattern.Id) return this;
        return null;
    }
    public object GetPropertyValue(int id) {
        Interlocked.Increment(ref LargeTreeForm.PropertyReads);
        if (id==AutomationElementIdentifiers.NameProperty.Id) {
            if (LargeTreeForm.Blocking && Index==9998) Thread.Sleep(60000);
            return DisplayName ?? (Index==-1 ? "UIA large-tree root" : Depth==13 ? "Deep target" : "Item "+Index);
        }
        if (id==AutomationElementIdentifiers.AutomationIdProperty.Id) return "item-"+Index;
        if (id==AutomationElementIdentifiers.ControlTypeProperty.Id) return Index==-1 || Children.Count>0 ? ControlType.Pane.Id : ControlType.Button.Id;
        if (id==AutomationElementIdentifiers.IsControlElementProperty.Id || id==AutomationElementIdentifiers.IsContentElementProperty.Id || id==AutomationElementIdentifiers.IsEnabledProperty.Id || id==AutomationElementIdentifiers.IsKeyboardFocusableProperty.Id) return true;
        if (id==AutomationElementIdentifiers.IsOffscreenProperty.Id) return Index>20;
        if (id==AutomationElementIdentifiers.ClassNameProperty.Id) return "DshLargeTreeNode";
        if (id==AutomationElementIdentifiers.ProcessIdProperty.Id) return System.Diagnostics.Process.GetCurrentProcess().Id;
        if (id==AutomationElementIdentifiers.NativeWindowHandleProperty.Id) return ParentNode==null ? Form.Handle.ToInt32() : 0;
        return null;
    }
    public IRawElementProviderFragment Navigate(NavigateDirection direction) {
        Interlocked.Increment(ref LargeTreeForm.Navigations);
        if (direction==NavigateDirection.Parent) return ParentNode;
        if (direction==NavigateDirection.FirstChild) return Children.Count>0 ? Children[0] : null;
        if (direction==NavigateDirection.LastChild) return Children.Count>0 ? Children[Children.Count-1] : null;
        if (ParentNode==null) return null;
        int index=ParentNode.Children.IndexOf(this);
        if (direction==NavigateDirection.NextSibling) return index+1<ParentNode.Children.Count ? ParentNode.Children[index+1] : null;
        if (direction==NavigateDirection.PreviousSibling) return index>0 ? ParentNode.Children[index-1] : null;
        return null;
    }
    public int[] GetRuntimeId() { Interlocked.Increment(ref LargeTreeForm.RuntimeIds); return new [] { AutomationInteropProvider.AppendRuntimeId, Index+2 }; }
    public System.Windows.Rect BoundingRectangle { get { return new System.Windows.Rect(20,20,10,10); } }
    public IRawElementProviderFragmentRoot FragmentRoot { get { return Form.Root; } }
    public IRawElementProviderSimple[] GetEmbeddedFragmentRoots() { return null; }
    public void SetFocus() { }
    public IRawElementProviderFragment ElementProviderFromPoint(double x, double y) { return Form.Root; }
    public IRawElementProviderFragment GetFocus() { return Form.Root; }
    public void Invoke() { Interlocked.Increment(ref LargeTreeForm.Invocations); if (LargeTreeForm.BlockingAction) Thread.Sleep(60000); }
    public void Realize() { Interlocked.Increment(ref LargeTreeForm.Invocations); }
    public IRawElementProviderSimple FindItemByProperty(IRawElementProviderSimple start, int property, object value) {
        foreach (var child in Children) if (object.Equals(child.GetPropertyValue(property),value)) return child;
        return null;
    }
}
