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
    public static volatile int DelayedIndex = -2, DelayMilliseconds;
    public static void DelayRead(int index) { if (index == DelayedIndex && DelayMilliseconds > 0) Thread.Sleep(DelayMilliseconds); }
    // 反例只有两个合法源状态，切换不发事件：分开的读取可以拼出从未存在的组合。
    static readonly object PairLock = new object();
    static string PairInstance = Guid.NewGuid().ToString("N");
    static bool PairEnabled; static int PairState, PairLeftReads, PairRightReads; static long PairEpoch;
    static string PairLeft { get { return PairState == 0 ? "Pair left active" : "Pair left idle"; } }
    static string PairRight { get { return PairState == 1 ? "Pair right active" : "Pair right idle"; } }
    public static string ReadPairName(int index) {
        lock (PairLock) {
            if (!PairEnabled || (index != 12 && index != 13)) return null;
            int state = index == 12 ? 0 : 1;
            if (PairState != state) { PairEpoch += 2; PairState = state; }
            if (index == 12) PairLeftReads++; else PairRightReads++;
            return index == 12 ? PairLeft : PairRight;
        }
    }
    static void EnablePair() {
        // 版本号重置必须换来源代次；旧stamp不能和新一轮的同号版本混淆。
        lock (PairLock) { PairInstance = Guid.NewGuid().ToString("N"); PairEnabled = true; PairState = 0; PairEpoch = 0; PairLeftReads = PairRightReads = 0; }
    }
    static void StepPair() { lock (PairLock) { PairEpoch += 2; PairState = 1 - PairState; } }
    static string ExportPair() {
        // 这个测试导出同时持有源锁。单次导出有原子切点；UIA/MSAA的逐字段读取没有。
        lock (PairLock) return "{\"source_instance\":\""+PairInstance+"\",\"source_epoch\":\""+PairEpoch+
            "\",\"left\":\""+PairLeft+"\",\"right\":\""+PairRight+"\",\"left_reads\":"+PairLeftReads+
            ",\"right_reads\":"+PairRightReads+",\"state\":"+PairState+"}";
    }
    // 恢复测试在读第13项时静默改写已经读过的第12项；默认关闭，不影响旧测试。
    static readonly object MutationLock = new object();
    static string MutationBackend; static int MutationRemaining, Mutations;
    static void ConfigureMutation(string backend, bool repeat) {
        lock (MutationLock) {
            MutationBackend = backend; MutationRemaining = repeat ? -1 : 1; Mutations = 0;
            if (backend == "uia") Instance.Root.Children.Find(item => item.ItemIndex == 12).DisplayName = "Before mutation";
            else LegacyNames[12] = "Before mutation";
        }
    }
    public static void MutateOnRead(int index, string backend) {
        if (index != 13) return;
        lock (MutationLock) {
            if (MutationRemaining == 0 || MutationBackend != backend) return;
            string name = "Mutation target " + (++Mutations);
            if (backend == "uia") Instance.Root.Children.Find(item => item.ItemIndex == 12).DisplayName = name;
            else LegacyNames[12] = name;
            if (MutationRemaining > 0) MutationRemaining--;
        }
    }
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
            DelayRead(Index); MutateOnRead(Index, "msaa");
            string paired = ReadPairName(Index); if (paired != null) return paired;
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
                else if (line.StartsWith("delay:")) {
                    var parts = line.Split(':'); DelayedIndex=int.Parse(parts[1]); DelayMilliseconds=int.Parse(parts[2]);
                    Console.WriteLine("delay-set");
                }
                else if (line=="count") Console.WriteLine("count:"+Invocations);
                else if (line=="pair_enable") { EnablePair(); Console.WriteLine("pair-enabled"); }
                else if (line=="pair_step") { StepPair(); Console.WriteLine("pair-stepped"); }
                else if (line=="pair_export") Console.WriteLine(ExportPair());
                else if (line=="reset_stats") { ResetStats(); Console.WriteLine("stats-reset"); }
                else if (line=="stats") Console.WriteLine(Stats());
                else if (line=="mutation:disable") { lock (MutationLock) { MutationRemaining=0; } Console.WriteLine("mutation-disabled"); }
                else if (line=="mutation_stats") { lock (MutationLock) { Console.WriteLine("mutations:"+Mutations); } }
                else if (line.StartsWith("mutation:")) {
                    var parts=line.Split(':');
                    form.BeginInvoke((Action)delegate() { ConfigureMutation(parts[1],parts[2]=="always"); Console.WriteLine("mutation-enabled"); Console.Out.Flush(); });
                }
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
            LargeTreeForm.DelayRead(Index); LargeTreeForm.MutateOnRead(Index, "uia");
            string paired = LargeTreeForm.ReadPairName(Index); if (paired != null) return paired;
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
