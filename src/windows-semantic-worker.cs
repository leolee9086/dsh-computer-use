// 插件自己的常驻进程：提供者的同步 COM 调用可以阻塞，但不能阻塞 Harness。
// JSON 行协议、元素引用和遍历栈都留在这个进程；Host 可在截止时终止它。
using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Automation;
using Accessibility;

internal static partial class SemanticWorker
{
    internal static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 16000000, RecursionLimit = 128 };
    static readonly string Generation = Guid.NewGuid().ToString("N");
    static readonly Dictionary<string, Window> Windows = new Dictionary<string, Window>();
    static readonly Dictionary<string, Saved> Elements = new Dictionary<string, Saved>();
    static readonly Queue<string> ElementOrder = new Queue<string>();
    static readonly Dictionary<string, Page> Pages = new Dictionary<string, Page>();
    static readonly Queue<string> PageOrder = new Queue<string>();
    static readonly TreeWalker Walker = TreeWalker.ControlViewWalker;
    static readonly CacheRequest Cache = CreateCache();
    static readonly CacheRequest QueryCache = CreateQueryCache();
    static int NativeCalls;
    static bool ActionStarted;
    const int ElementLimit = 20000;
    const int CursorLimit = 32;
    const int WindowLimit = 8;
    const int LifetimeMs = 120000;

    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern bool IsWindow(IntPtr hwnd);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
    [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr hwnd, StringBuilder value, int length);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr hwnd, StringBuilder value, int length);
    [DllImport("oleacc.dll")] static extern int AccessibleObjectFromWindow(IntPtr hwnd, uint id, ref Guid iid, [MarshalAs(UnmanagedType.Interface)] out IAccessible root);
    [DllImport("oleacc.dll")] static extern int AccessibleChildren(IAccessible parent, int start, int count, [Out, MarshalAs(UnmanagedType.LPArray, SizeParamIndex=2)] object[] values, out int obtained);
    [DllImport("oleacc.dll", CharSet=CharSet.Unicode)] static extern uint GetRoleText(uint role, StringBuilder text, uint length);
    delegate void WinEvent(IntPtr hook, uint ev, IntPtr hwnd, int objectId, int childId, uint thread, uint time);
    [DllImport("user32.dll")] static extern IntPtr SetWinEventHook(uint min, uint max, IntPtr module, WinEvent callback, uint pid, uint thread, uint flags);
    [DllImport("user32.dll")] static extern bool GetMessage(out Message message, IntPtr hwnd, uint min, uint max);
    [DllImport("user32.dll")] static extern bool UnhookWinEvent(IntPtr hook);
    [StructLayout(LayoutKind.Sequential)] struct Message { public IntPtr hwnd; public uint message; public UIntPtr wparam; public IntPtr lparam; public uint time; public int x, y; }
    static readonly object WindowLock = new object();
    static WinEvent EventCallback;

    sealed class Window {
        public IntPtr Hwnd; public uint Pid; public string Title, Class, Backend;
        public int Version, SnapshotVersion; public Target Root; public DateTime Touched;
        public StructureChangedEventHandler Handler;
        public AutomationPropertyChangedEventHandler PropertyHandler;
    }
    // UIA 引用/运行时身份，或独立 MSAA 对象+child VARIANT。没有整树动作搜索。
    sealed class Target {
        public AutomationElement Uia; public IAccessible Msaa; public object Child = 0;
        public string Id; public Window Window; public bool SummaryCached;
    }
    sealed class Saved {
        public Target Target; public Dictionary<string, object> Identity; public string Owner;
        public int Version; public DateTime At;
    }
    sealed class Frame {
        public Target Node; public int Depth; public bool Entered;
        public Target LastChild; public int ChildIndex; public bool ChildrenStarted;
        public string FirstChildIdentity; public int LegacyChildCount = -1;
        public bool? DepthChildPresent; // 字节预算续页重取节点时，不能再次推进深度边界探测。
        public readonly List<string> ChildPrefix = new List<string>();
    }
    sealed class Page {
        public Stack<Frame> Stack = new Stack<Frame>(); public Window Window;
        public string Owner, Signature, Scope, Detail; public Dictionary<string, object> Query;
        public int Version, Depth; public bool DepthLimited, ProviderError;
        public DateTime At; public Target Root; public Condition ExactCondition;
    }

    static CacheRequest CreateQueryCache() {
        var cache = new CacheRequest { TreeScope = TreeScope.Element, AutomationElementMode = AutomationElementMode.Full };
        foreach (var property in new [] { AutomationElement.NameProperty, AutomationElement.ControlTypeProperty,
            AutomationElement.AutomationIdProperty, AutomationElement.ClassNameProperty,
            AutomationElement.IsEnabledProperty, AutomationElement.IsOffscreenProperty, AutomationElement.RuntimeIdProperty }) cache.Add(property);
        return cache;
    }
    static Condition ExactQuery(Dictionary<string, object> query) {
        if (query == null || Text(query, "match", "contains") != "exact") return null;
        var conditions = new List<Condition>();
        if (Text(query, "name").Length > 0) conditions.Add(new PropertyCondition(AutomationElement.NameProperty, Text(query, "name"), PropertyConditionFlags.IgnoreCase));
        if (Text(query, "automationId").Length > 0) conditions.Add(new PropertyCondition(AutomationElement.AutomationIdProperty, Text(query, "automationId"), PropertyConditionFlags.IgnoreCase));
        if (Text(query, "role").Length > 0) {
            var field = typeof(ControlType).GetField(Text(query, "role"), System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.Static | System.Reflection.BindingFlags.IgnoreCase);
            if (field == null) return Condition.FalseCondition;
            conditions.Add(new PropertyCondition(AutomationElement.ControlTypeProperty, field.GetValue(null)));
        }
        if (!Flag(query, "includeOffscreen")) conditions.Add(new PropertyCondition(AutomationElement.IsOffscreenProperty, false));
        if (!Flag(query, "includeDisabled")) conditions.Add(new PropertyCondition(AutomationElement.IsEnabledProperty, true));
        return conditions.Count == 1 ? conditions[0] : new AndCondition(conditions.ToArray());
    }
    static Dictionary<string, object> QueryFields(Target target, bool refresh = false) {
        if (target.Uia == null) {
            // MSAA查询/身份复核只需名称、角色和状态，未命中节点不取位置/默认动作。
            NativeCalls += 3;
            int state = Convert.ToInt32(target.Msaa.get_accState(target.Child));
            return new Dictionary<string, object> { { "name", target.Msaa.get_accName(target.Child) ?? "" },
                { "role", LegacyRole(target.Msaa.get_accRole(target.Child)) }, { "automation_id", "" },
                { "class_name", target.Window.Class }, { "enabled", (state & 1) == 0 }, { "offscreen", (state & 0x18000) != 0 } };
        }
        if (refresh) { NativeCalls++; target.Uia = target.Uia.GetUpdatedCache(QueryCache); target.SummaryCached = false; }
        var info = target.Uia.Cached;
        return new Dictionary<string, object> { { "name", info.Name }, { "role", info.ControlType.ProgrammaticName.Replace("ControlType.", "") },
            { "automation_id", info.AutomationId }, { "class_name", info.ClassName }, { "enabled", info.IsEnabled }, { "offscreen", info.IsOffscreen } };
    }

    static string Text(IDictionary<string, object> args, string key, string fallback = "") {
        object value; return args.TryGetValue(key, out value) && value != null ? Convert.ToString(value) : fallback;
    }
    static int Integer(IDictionary<string, object> args, string key, int fallback) {
        object value; return args.TryGetValue(key, out value) && value != null ? Convert.ToInt32(value) : fallback;
    }
    static bool Flag(IDictionary<string, object> args, string key) {
        object value; return args.TryGetValue(key, out value) && value is bool && (bool)value;
    }
    static string WindowText(IntPtr hwnd, bool className) {
        var value = new StringBuilder(2048);
        if (className) GetClassName(hwnd, value, value.Capacity); else GetWindowText(hwnd, value, value.Capacity);
        return value.ToString();
    }
    static string RuntimeId(AutomationElement element) {
        NativeCalls++; var ids = element.GetRuntimeId();
        if (ids == null || ids.Length == 0) throw new InvalidOperationException("provider returned no runtime identity");
        return "uia:" + string.Join(",", ids);
    }
    static string CachedRuntimeId(AutomationElement element) {
        // TreeWalker的缓存请求已经取得身份，不再次跨进程读取。
        // 动作前RuntimeId()仍读取当前身份，不能用缓存替代实时校验。
        var ids = element.GetCachedPropertyValue(AutomationElement.RuntimeIdProperty) as int[];
        if (ids == null || ids.Length == 0) throw new InvalidOperationException("provider returned no cached runtime identity");
        return "uia:" + string.Join(",", ids);
    }
    static CacheRequest CreateCache() {
        var cache = new CacheRequest { TreeScope = TreeScope.Element, AutomationElementMode = AutomationElementMode.Full };
        foreach (var property in new [] {
            AutomationElement.NameProperty, AutomationElement.ControlTypeProperty, AutomationElement.AutomationIdProperty,
            AutomationElement.RuntimeIdProperty, AutomationElement.ClassNameProperty, AutomationElement.ProcessIdProperty, AutomationElement.NativeWindowHandleProperty,
            AutomationElement.IsEnabledProperty, AutomationElement.IsOffscreenProperty, AutomationElement.IsPasswordProperty,
            AutomationElement.HasKeyboardFocusProperty, AutomationElement.IsKeyboardFocusableProperty, AutomationElement.BoundingRectangleProperty,
            AutomationElement.IsInvokePatternAvailableProperty, AutomationElement.IsValuePatternAvailableProperty,
            AutomationElement.IsTogglePatternAvailableProperty, AutomationElement.IsExpandCollapsePatternAvailableProperty,
            AutomationElement.IsSelectionItemPatternAvailableProperty, AutomationElement.IsScrollItemPatternAvailableProperty,
            AutomationElement.IsTextPatternAvailableProperty, AutomationElement.IsRangeValuePatternAvailableProperty,
            AutomationElement.IsSelectionPatternAvailableProperty, AutomationElement.IsScrollPatternAvailableProperty,
            AutomationElement.IsGridPatternAvailableProperty, AutomationElement.IsGridItemPatternAvailableProperty,
            AutomationElement.IsTablePatternAvailableProperty, AutomationElement.IsWindowPatternAvailableProperty,
            AutomationElement.IsTransformPatternAvailableProperty, AutomationElement.IsDockPatternAvailableProperty,
            AutomationElement.IsVirtualizedItemPatternAvailableProperty, AutomationElement.IsItemContainerPatternAvailableProperty
        }) cache.Add(property);
        return cache;
    }
    static void StartLegacyEvents() {
        // MSAA 不提供 UIA 结构事件，独立监听 WinEvent；线程保留消息循环以投送回调。
        EventCallback = delegate(IntPtr hook, uint ev, IntPtr hwnd, int oid, int cid, uint thread, uint time) {
            if (hwnd == IntPtr.Zero) return;
            var root = GetAncestor(hwnd, 2);
            lock (WindowLock) foreach (var window in Windows.Values)
                if (window.Backend == "msaa" && window.Hwnd == root) {
                    Interlocked.Increment(ref window.SnapshotVersion);
                    if (ev <= 0x8004) Interlocked.Increment(ref window.Version);
                }
        };
        var pump = new Thread(delegate() {
            var hook = SetWinEventHook(0x8000, 0x8017, IntPtr.Zero, EventCallback, 0, 0, 0);
            Message message; while (GetMessage(out message, IntPtr.Zero, 0, 0)) { }
            if (hook != IntPtr.Zero) UnhookWinEvent(hook);
        });
        pump.IsBackground = true; pump.SetApartmentState(ApartmentState.MTA); pump.Start();
    }
    static Window ResolveWindow(IDictionary<string, object> args, string backend) {
        var raw = Text(args, "hwnd");
        var hwnd = raw.Length == 0 ? GetForegroundWindow() : new IntPtr(long.Parse(raw));
        if (hwnd == IntPtr.Zero || !IsWindow(hwnd)) throw new InvalidOperationException("window unavailable");
        uint pid; GetWindowThreadProcessId(hwnd, out pid);
        if (args.ContainsKey("processId") && Integer(args, "processId", 0) != pid) throw new InvalidOperationException("window process identity changed");
        var title = WindowText(hwnd, false); var cls = WindowText(hwnd, true);
        if (args.ContainsKey("title") && Text(args, "title") != title) throw new InvalidOperationException("window title changed");
        string key = backend + ":" + hwnd.ToInt64();
        Window window;
        lock (WindowLock) Windows.TryGetValue(key, out window);
        if (window != null && window.Pid == pid && window.Class == cls && window.Title == title) {
            window.Touched = DateTime.UtcNow;
            // 复用原生根引用，但新观测刷新其基本属性，不继承上一页的状态。
            window.Root.SummaryCached = false; return window;
        }
        lock (WindowLock) {
            if (window != null) DropWindow(key, window);
            if (Windows.Count >= WindowLimit) {
                string oldest = null; DateTime at = DateTime.MaxValue;
                foreach (var entry in Windows) if (entry.Value.Touched < at) { at = entry.Value.Touched; oldest = entry.Key; }
                DropWindow(oldest, Windows[oldest]);
            }
            window = new Window { Hwnd = hwnd, Pid = pid, Title = title, Class = cls, Backend = backend, Touched = DateTime.UtcNow };
            if (backend == "msaa") {
                var iid = new Guid("618736E0-3C3D-11CF-810C-00AA00389B71"); IAccessible accessible;
                NativeCalls++;
                int hr = AccessibleObjectFromWindow(hwnd, unchecked((uint)-4), ref iid, out accessible);
                if (hr < 0 || accessible == null) throw new InvalidOperationException("MSAA OBJID_CLIENT unavailable: " + hr);
                window.Root = new Target { Msaa = accessible, Window = window, Id = "msaa:" + hwnd.ToInt64() + ":root" };
            } else {
                NativeCalls++;
                var root = AutomationElement.FromHandle(hwnd).GetUpdatedCache(Cache);
                window.Root = new Target { Uia = root, Window = window, Id = RuntimeId(root) };
                window.Handler = delegate(object sender, StructureChangedEventArgs e) {
                    Interlocked.Increment(ref window.Version); Interlocked.Increment(ref window.SnapshotVersion);
                };
                // 属性变化也使正在采集的代次作废；不把普通焦点/状态改变伪装成结构变化。
                window.PropertyHandler = delegate(object sender, AutomationPropertyChangedEventArgs e) { Interlocked.Increment(ref window.SnapshotVersion); };
                Automation.AddStructureChangedEventHandler(root, TreeScope.Subtree, window.Handler);
                Automation.AddAutomationPropertyChangedEventHandler(root, TreeScope.Subtree, window.PropertyHandler,
                    AutomationElement.NameProperty, AutomationElement.ControlTypeProperty, AutomationElement.AutomationIdProperty,
                    AutomationElement.ClassNameProperty, AutomationElement.ProcessIdProperty, AutomationElement.NativeWindowHandleProperty,
                    AutomationElement.IsEnabledProperty, AutomationElement.IsOffscreenProperty, AutomationElement.IsPasswordProperty,
                    AutomationElement.HasKeyboardFocusProperty, AutomationElement.IsKeyboardFocusableProperty, AutomationElement.BoundingRectangleProperty,
                    AutomationElement.IsInvokePatternAvailableProperty, AutomationElement.IsValuePatternAvailableProperty,
                    AutomationElement.IsTogglePatternAvailableProperty, AutomationElement.IsExpandCollapsePatternAvailableProperty,
                    AutomationElement.IsSelectionItemPatternAvailableProperty, AutomationElement.IsScrollItemPatternAvailableProperty,
                    AutomationElement.IsTextPatternAvailableProperty, AutomationElement.IsRangeValuePatternAvailableProperty,
                    AutomationElement.IsSelectionPatternAvailableProperty, AutomationElement.IsScrollPatternAvailableProperty,
                    AutomationElement.IsGridPatternAvailableProperty, AutomationElement.IsGridItemPatternAvailableProperty,
                    AutomationElement.IsTablePatternAvailableProperty, AutomationElement.IsWindowPatternAvailableProperty,
                    AutomationElement.IsTransformPatternAvailableProperty, AutomationElement.IsDockPatternAvailableProperty,
                    AutomationElement.IsVirtualizedItemPatternAvailableProperty, AutomationElement.IsItemContainerPatternAvailableProperty);
            }
            Windows[key] = window;
        }
        return window;
    }
    static void DropWindow(string key, Window window) {
        Interlocked.Increment(ref window.Version);
        Interlocked.Increment(ref window.SnapshotVersion);
        if (window.Handler != null) Automation.RemoveStructureChangedEventHandler(window.Root.Uia, window.Handler);
        if (window.PropertyHandler != null) Automation.RemoveAutomationPropertyChangedEventHandler(window.Root.Uia, window.PropertyHandler);
        Windows.Remove(key);
    }
    static void ValidateWindow(Window window) {
        uint pid; GetWindowThreadProcessId(window.Hwnd, out pid);
        if (!IsWindow(window.Hwnd) || pid != window.Pid || WindowText(window.Hwnd, true) != window.Class)
            throw new InvalidOperationException("stale_target: window identity changed");
    }
    static Target NextChild(Frame frame, bool summary = true) {
        var parent = frame.Node; NativeCalls++;
        if (parent.Uia != null) {
            var cache = summary ? Cache : QueryCache;
            bool first = !frame.ChildrenStarted;
            var child = first ? Walker.GetFirstChild(parent.Uia, cache) : Walker.GetNextSibling(frame.LastChild.Uia, cache);
            frame.ChildrenStarted = true;
            if (child == null) { if (first) frame.FirstChildIdentity = "none"; return null; }
            var target = new Target { Uia = child, Window = parent.Window, Id = CachedRuntimeId(child), SummaryCached = summary };
            if (first) frame.FirstChildIdentity = target.Id;
            // HWND 根还可能混合系统标题栏与应用片段。保留小范围前缀，
            // 只检查第一个系统节点无法发现紧随其后的应用节点插入。
            if (frame.ChildPrefix.Count < 8) frame.ChildPrefix.Add(target.Id);
            frame.LastChild = target; return target;
        }
        if (Convert.ToInt32(parent.Child) != 0) return null;
        int count = parent.Msaa.accChildCount;
        if (frame.LegacyChildCount < 0) frame.LegacyChildCount = count;
        if (count != frame.LegacyChildCount) {
            Interlocked.Increment(ref parent.Window.Version);
            throw new InvalidOperationException("cursor_stale: MSAA child count changed");
        }
        if (frame.ChildIndex >= count) return null;
        int index = frame.ChildIndex++; var values = new object[1]; int obtained;
        if (AccessibleChildren(parent.Msaa, index, 1, values, out obtained) < 0 || obtained != 1)
            throw new InvalidOperationException("MSAA child enumeration failed");
        var acc = values[0] as IAccessible;
        if (acc == null && !(values[0] is int)) throw new InvalidOperationException("MSAA child VARIANT unsupported");
        return new Target { Msaa = acc ?? parent.Msaa, Child = acc == null ? values[0] : 0, Window = parent.Window, Id = parent.Id + "." + index };
    }
    // MSAA 的可选字符串成员允许未实现；仅这两种明确“不支持”返回缺失。
    // 其它 COM 失败和阻塞继续上报/由宿主截止处理，不能伪装成空值成功。
    static string LegacyOptional(Func<string> getter) {
        try { return getter() ?? ""; }
        catch (COMException error) {
            if (error.ErrorCode == unchecked((int)0x80020003) || error.ErrorCode == unchecked((int)0x80004001)) return null;
            throw;
        }
    }
    static string LegacyRole(object value) {
        int role = Convert.ToInt32(value);
        switch (role) {
            case 9: return "Window"; case 10: return "Client"; case 41: return "Text"; case 42: return "Edit";
            case 43: return "Button"; case 44: return "CheckBox"; case 45: return "RadioButton";
            case 33: return "List"; case 34: return "ListItem"; case 46: return "ComboBox"; case 51: return "Slider";
            default: var text = new StringBuilder(256); GetRoleText((uint)role, text, 256); return text.ToString();
        }
    }
    static Dictionary<string, object> Describe(Target target) {
        var node = new Dictionary<string, object>(); var window = target.Window;
        node["element_id"] = target.Id; node["backend"] = window.Backend;
        node["native_window_handle"] = window.Hwnd.ToInt64().ToString(); node["process_id"] = (int)window.Pid;
        node["window_title"] = window.Title; node["class_name"] = window.Class;
        var patterns = new List<object>(); node["patterns"] = patterns; node["patterns_known"] = true;
        node["child_state"] = "unknown";
        if (target.Uia != null) {
            // 只缓存本节点的基本字段和模式可用性，不隐式取得整个子树或文档。
            if (!target.SummaryCached) NativeCalls++;
            var element = target.SummaryCached ? target.Uia : target.Uia.GetUpdatedCache(Cache);
            target.Uia = element; target.SummaryCached = true;
            var info = element.Cached;
            node["name"] = info.Name; node["role"] = info.ControlType.ProgrammaticName.Replace("ControlType.", "");
            node["automation_id"] = info.AutomationId; node["class_name"] = info.ClassName;
            node["enabled"] = info.IsEnabled; node["offscreen"] = info.IsOffscreen; node["password"] = info.IsPassword;
            node["focused"] = info.HasKeyboardFocus; node["focusable"] = info.IsKeyboardFocusable;
            var rect = info.BoundingRectangle;
            if (!rect.IsEmpty) node["bounds"] = new Dictionary<string, object> { { "x", rect.X }, { "y", rect.Y }, { "width", rect.Width }, { "height", rect.Height } };
            var properties = new [] { AutomationElement.IsInvokePatternAvailableProperty, AutomationElement.IsValuePatternAvailableProperty,
                AutomationElement.IsTogglePatternAvailableProperty, AutomationElement.IsExpandCollapsePatternAvailableProperty,
                AutomationElement.IsSelectionItemPatternAvailableProperty, AutomationElement.IsScrollItemPatternAvailableProperty,
                AutomationElement.IsTextPatternAvailableProperty, AutomationElement.IsRangeValuePatternAvailableProperty,
                AutomationElement.IsSelectionPatternAvailableProperty, AutomationElement.IsScrollPatternAvailableProperty,
                AutomationElement.IsGridPatternAvailableProperty, AutomationElement.IsGridItemPatternAvailableProperty,
                AutomationElement.IsTablePatternAvailableProperty, AutomationElement.IsWindowPatternAvailableProperty,
                AutomationElement.IsTransformPatternAvailableProperty, AutomationElement.IsDockPatternAvailableProperty,
                AutomationElement.IsVirtualizedItemPatternAvailableProperty, AutomationElement.IsItemContainerPatternAvailableProperty };
            var names = new [] { "invoke", "value", "toggle", "expand_collapse", "selection_item", "scroll_item", "text", "range_value", "selection", "scroll", "grid", "grid_item", "table", "window", "transform", "dock", "virtualized_item", "item_container" };
            for (int i = 0; i < properties.Length; i++) if (object.Equals(element.GetCachedPropertyValue(properties[i]), true)) patterns.Add(names[i]);
        } else {
            NativeCalls += 5; // 本段五次 IAccessible 字段/位置读取；不计提供者内部调用。
            var acc = target.Msaa; var child = target.Child;
            int state = Convert.ToInt32(acc.get_accState(child)); string role = LegacyRole(acc.get_accRole(child));
            node["name"] = acc.get_accName(child) ?? ""; node["role"] = role;
            node["enabled"] = (state & 1) == 0; node["offscreen"] = (state & 0x18000) != 0;
            node["password"] = (state & 0x20000000) != 0; node["state"] = state;
            node["focused"] = (state & 4) != 0; node["focusable"] = (state & 0x100000) != 0;
            string action = LegacyOptional(() => acc.get_accDefaultAction(child));
            if (action != null) node["default_action"] = action;
            if (!string.IsNullOrEmpty(action)) patterns.Add("invoke");
            if (role == "Edit" || role == "ComboBox") patterns.Add("value");
            if ((state & 0x200000) != 0 || role == "ListItem") patterns.Add("selection_item");
            int x, y, width, height; acc.accLocation(out x, out y, out width, out height, child);
            node["bounds"] = new Dictionary<string, object> { { "x", x }, { "y", y }, { "width", width }, { "height", height } };
        }
        return node;
    }
    static Saved Lookup(IDictionary<string, object> args, string key, string owner) {
        Saved saved; string token = Text(args, key);
        if (!Elements.TryGetValue(token, out saved) || saved.Owner != owner || (DateTime.UtcNow - saved.At).TotalMilliseconds > LifetimeMs)
            throw new InvalidOperationException("stale_target: reference expired or not observed in this session");
        ValidateWindow(saved.Target.Window);
        if (saved.Version != saved.Target.Window.Version) throw new InvalidOperationException("stale_target: tree structure changed");
        if (saved.Target.Uia != null && RuntimeId(saved.Target.Uia) != saved.Target.Id) throw new InvalidOperationException("stale_target: runtime identity changed");
        // 动作只刷新身份字段，所需模式/状态随后按操作读取；不重取所有概览模式。
        var current = QueryFields(saved.Target, true);
        foreach (var field in new [] { "name", "role", "automation_id", "class_name" }) {
            object expected, actual;
            if (saved.Identity.TryGetValue(field, out expected) && current.TryGetValue(field, out actual) && !object.Equals(expected, actual))
                throw new InvalidOperationException("stale_target: identity changed: " + field);
        }
        return saved;
    }
    static void Save(Target target, Dictionary<string, object> node, string owner) {
        var token = Guid.NewGuid().ToString("N"); node["native_token"] = token; node["worker_generation"] = Generation;
        Elements[token] = new Saved { Target = target, Identity = node, Owner = owner, Version = target.Window.Version, At = DateTime.UtcNow };
        ElementOrder.Enqueue(token);
        while (ElementOrder.Count > ElementLimit) Elements.Remove(ElementOrder.Dequeue());
    }
    static bool Match(Dictionary<string, object> node, Dictionary<string, object> query) {
        if (query == null) return true;
        if (!Flag(query, "includeOffscreen") && Flag(node, "offscreen")) return false;
        if (!Flag(query, "includeDisabled") && !Flag(node, "enabled")) return false;
        bool exact = Text(query, "match", "contains") == "exact";
        foreach (var pair in new [] { new [] { "name", "name" }, new [] { "role", "role" }, new [] { "automationId", "automation_id" } }) {
            var expected = Text(query, pair[0]); if (expected.Length == 0) continue;
            var actual = Text(node, pair[1]);
            if (exact ? !string.Equals(actual, expected, StringComparison.OrdinalIgnoreCase) : actual.IndexOf(expected, StringComparison.OrdinalIgnoreCase) < 0) return false;
        }
        return true;
    }
    static void ValidatePage(Page page) {
        ValidateWindow(page.Window);
        // UIA/WinEvent 的回调是异步通知。续页同时检查仍在栈上的导航锚点，
        // 每层最多检查八个已观测导航锚点，不重播已遍历页。事件与锚点都不是
        // 动态 UI 的原子快照保证；未发事件且在锚点外的修改仍由提供者负责通知。
        foreach (var frame in page.Stack) {
            bool changed = false;
            if (frame.Node.Uia != null) {
                if (RuntimeId(frame.Node.Uia) != frame.Node.Id) changed = true;
                if (frame.FirstChildIdentity != null) {
                    NativeCalls++; var child = Walker.GetFirstChild(frame.Node.Uia, QueryCache);
                    if (frame.ChildPrefix.Count == 0) changed = child != null;
                    for (int index = 0; index < frame.ChildPrefix.Count; index++) {
                        if (child == null || RuntimeId(child) != frame.ChildPrefix[index]) { changed = true; break; }
                        if (index + 1 < frame.ChildPrefix.Count) { NativeCalls++; child = Walker.GetNextSibling(child, QueryCache); }
                    }
                }
            } else if (frame.LegacyChildCount >= 0) {
                NativeCalls++; if (frame.Node.Msaa.accChildCount != frame.LegacyChildCount) changed = true;
            }
            if (changed) {
                Interlocked.Increment(ref page.Window.Version);
                throw new InvalidOperationException("cursor_stale: navigation anchor changed");
            }
        }
    }
    static object Acquire(IDictionary<string, object> args, string owner) {
        int maxNodes = Integer(args, "maxNodes", 300), depth = Integer(args, "maxDepth", 6);
        int maxBytes = Integer(args, "maxBytes", 1000000), maxResults = Integer(args, "maxResults", maxNodes);
        int time = Integer(args, "budgetMs", 5000);
        if (maxNodes < 1 || maxNodes > 20000 || depth < 0 || depth > 128 || maxBytes < 4096 || maxBytes > 12000000 || time < 1 || maxResults < 1 || maxResults > 20000)
            throw new InvalidOperationException("semantic acquisition bounds invalid");
        var clock = Stopwatch.StartNew(); Page page; string cursor = Text(args, "cursor");
        if (cursor.Length > 0) {
            if (!Pages.TryGetValue(cursor, out page) || page.Owner != owner || (DateTime.UtcNow - page.At).TotalMilliseconds > LifetimeMs)
                throw new InvalidOperationException("cursor_stale: cursor unavailable");
            if (page.Version != page.Window.Version) throw new InvalidOperationException("cursor_stale: structure changed");
            ValidatePage(page);
            string expected = Text(args, "signature");
            if (expected.Length > 0 && expected != page.Signature) throw new InvalidOperationException("cursor query changed");
            Pages.Remove(cursor);
        } else {
            string backend = Text(args, "backend", "uia"); if (backend != "uia" && backend != "msaa") throw new InvalidOperationException("backend invalid");
            var window = ResolveWindow(args, backend); Target root = window.Root;
            if (Text(args, "rootToken").Length > 0) { var saved = Lookup(args, "rootToken", owner); root = saved.Target; if (root.Window != window) throw new InvalidOperationException("subtree root belongs to another window"); }
            page = new Page { Window = window, Root = root, Owner = owner, Signature = Text(args, "signature"), Scope = Text(args, "scope", "subtree"), Detail = Text(args, "detail", "summary"), Depth = depth, Version = window.Version, At = DateTime.UtcNow };
            if (args.ContainsKey("query")) page.Query = (Dictionary<string, object>)args["query"];
            page.ExactCondition = backend == "uia" ? ExactQuery(page.Query) : null;
            page.Stack.Push(new Frame { Node = root, Depth = 0, Entered = page.Scope == "children" });
            if (page.Scope == "children") page.Depth = 1;
        }
        // 为协议/覆盖信息和窗口字符串留足空间；节点预算包含完整返回字段。
        var rows = new List<object>(); int visited = 0;
        int bytes = 1024 + Encoding.UTF8.GetByteCount(Json.Serialize(new Dictionary<string, object> {
            { "handle", page.Window.Hwnd.ToInt64().ToString() }, { "processId", (int)page.Window.Pid }, { "title", page.Window.Title } }));
        string reason = null;
        while (page.Stack.Count > 0) {
            if (page.Version != page.Window.Version) throw new InvalidOperationException("cursor_stale: structure changed during acquisition");
            if (visited >= maxNodes) { reason = "node_limit"; break; }
            if (rows.Count >= maxResults) { reason = "result_limit"; break; }
            if (clock.ElapsedMilliseconds >= time) { reason = "time_limit"; break; }
            var frame = page.Stack.Peek();
            if (!frame.Entered) {
                Dictionary<string, object> node = null;
                try {
                    if (page.ExactCondition != null) {
                        // 精确条件交给 UIA 执行，范围只限当前已走到的元素。遍历保留栈
                        // 与所有预算，避免 FindAll(Descendants) 一次取得无界结果。
                        NativeCalls++;
                        if (frame.Node.Uia.FindFirst(TreeScope.Element, page.ExactCondition) != null) node = Describe(frame.Node);
                    } else if (page.Query != null && frame.Node.Uia != null) {
                        if (Match(QueryFields(frame.Node, frame.Depth == 0), page.Query)) node = Describe(frame.Node);
                    } else {
                        var candidate = Describe(frame.Node);
                        if (Match(candidate, page.Query)) node = candidate;
                    }
                } catch (ElementNotAvailableException) { page.ProviderError = true; page.Stack.Pop(); continue; }
                visited++;
                if (frame.Depth >= page.Depth) {
                    if (!frame.DepthChildPresent.HasValue) frame.DepthChildPresent = NextChild(frame, page.Query == null) != null;
                    bool hiddenChild = frame.DepthChildPresent.Value;
                    if (node != null) node["child_state"] = hiddenChild ? "present" : "none";
                    if (hiddenChild && page.Scope != "children") {
                        if (node != null) node["children_truncated"] = true;
                        page.DepthLimited = true;
                    }
                }
                if (node != null) {
                    node["depth"] = frame.Depth; if (page.Stack.Count > 1) {
                        var frames = page.Stack.ToArray(); node["parent_id"] = frames[1].Node.Id;
                    }
                    // 先用同长度 token 计算实际 JSON 字节，提交节点才注册真实引用。
                    node["native_token"] = new string('0', 32); node["worker_generation"] = Generation;
                    int size = Encoding.UTF8.GetByteCount(Json.Serialize(node)) + 1;
                    if (bytes + size > maxBytes) {
                        if (rows.Count == 0) throw new InvalidOperationException("semantic node exceeds maxAccessibilityBytes; narrow the observed branch or increase the byte budget");
                        reason = "byte_limit"; break;
                    }
                    Save(frame.Node, node, owner); rows.Add(node); bytes += size;
                }
                frame.Entered = true;
            }
            if (frame.Depth >= page.Depth) { page.Stack.Pop(); continue; }
            Target next = NextChild(frame, page.Query == null);
            if (next == null) { page.Stack.Pop(); continue; }
            page.Stack.Push(new Frame { Node = next, Depth = frame.Depth + 1 });
        }
        page.At = DateTime.UtcNow;
        string nextCursor = null;
        if (page.Stack.Count > 0) {
            nextCursor = Guid.NewGuid().ToString("N"); Pages[nextCursor] = page; PageOrder.Enqueue(nextCursor);
            while (PageOrder.Count > CursorLimit) Pages.Remove(PageOrder.Dequeue());
        }
        string status = nextCursor == null && !page.DepthLimited && !page.ProviderError ? "complete" : "partial";
        if (reason == null && page.DepthLimited) reason = "depth_limit";
        if (reason == null && page.ProviderError) reason = "provider_error";
        return new Dictionary<string, object> {
            { "backend", page.Window.Backend }, { "elements", rows }, { "next_cursor", nextCursor },
            { "coverage", new Dictionary<string, object> { { "status", status }, { "reason", reason }, { "scope", page.Scope }, { "max_depth", page.Depth }, { "virtualized_items", "unrealized items are not traversed; use item_container/realize explicitly" } } },
            { "visited_nodes", visited }, { "returned_nodes", rows.Count }, { "elapsed_ms", clock.ElapsedMilliseconds },
            { "native_calls", NativeCalls }, { "worker_generation", Generation },
            { "consistency", new Dictionary<string, object> { { "mode", "live" }, { "status", "unverified" }, { "source_atomic", false } } },
            { "window", new Dictionary<string, object> { { "handle", page.Window.Hwnd.ToInt64().ToString() }, { "processId", (int)page.Window.Pid }, { "title", page.Window.Title } } }
        };
    }
    static object Act(IDictionary<string, object> args, string owner) {
        var saved = Lookup(args, "token", owner); var target = saved.Target;
        object expectedRaw;
        if (args.TryGetValue("expected", out expectedRaw) && expectedRaw is Dictionary<string, object>) {
            foreach (var pair in (Dictionary<string, object>)expectedRaw) {
                object actual;
                if (!saved.Identity.TryGetValue(pair.Key, out actual)) actual = ""; // MSAA 没有 automation_id，模型归一化为空串。
                if (!object.Equals(actual, pair.Value))
                    throw new InvalidOperationException("stale_target: expected " + (pair.Key == "process_id" ? "process identity changed" : "identity changed: " + pair.Key));
            }
        }
        var action = (Dictionary<string, object>)args["action"]; string kind = Text(action, "kind");
        if (kind == "find_item") {
            if (target.Uia == null) throw new InvalidOperationException("item_container unavailable on MSAA");
            var container = (ItemContainerPattern)target.Uia.GetCurrentPattern(ItemContainerPattern.Pattern);
            if (!target.Uia.Current.IsEnabled) throw new InvalidOperationException("element disabled");
            string propertyName = Text(action, "property", "name"), value = Text(action, "value");
            if ((propertyName != "name" && propertyName != "automation_id") || value.Length == 0) throw new InvalidOperationException("item lookup requires name/automation_id and a value");
            var property = propertyName == "automation_id" ? AutomationElement.AutomationIdProperty : AutomationElement.NameProperty;
            // ItemContainer 可以实例化或滚动；错误/截止不能假称完全没有副作用。
            ActionStarted = true;
            var item = container.FindItemByProperty(null, property, value);
            if (item == null) return new Dictionary<string, object> { { "found", false } };
            var found = new Target { Uia = item, Window = target.Window, Id = RuntimeId(item) };
            var row = Describe(found); Save(found, row, owner);
            return new Dictionary<string, object> { { "found", true }, { "element", row } };
        }
        if (target.Uia != null) {
            if (kind == "realize") {
                var pattern = (VirtualizedItemPattern)target.Uia.GetCurrentPattern(VirtualizedItemPattern.Pattern);
                ActionStarted = true; pattern.Realize(); return new Dictionary<string, object> { { "ok", true } };
            }
            if (kind != "read" && !target.Uia.Current.IsEnabled) throw new InvalidOperationException("element disabled");
            return NativeUia.PerformDirect(target.Uia, action, delegate() { ActionStarted = true; });
        }
        var acc = target.Msaa; var child = target.Child;
        int state = Convert.ToInt32(acc.get_accState(child));
        if (kind == "read") {
            foreach (var key in new [] { "text", "start", "end", "row", "column" }) if (action.ContainsKey(key)) throw new InvalidOperationException("MSAA does not support range/grid reads");
            var result = Describe(target);
            if ((state & 0x20000000) != 0) { result["redacted"] = true; return result; }
            int max = Integer(action, "maxChars", 16000); if (max < 1 || max > 100000) throw new InvalidOperationException("read limit invalid");
            string value = LegacyOptional(() => acc.get_accValue(child));
            result["value_supported"] = value != null;
            if (value != null) { result["value"] = value.Length > max ? value.Substring(0, max) : value; result["value_truncated"] = value.Length > max; }
            string description = LegacyOptional(() => acc.get_accDescription(child)), help = LegacyOptional(() => acc.get_accHelp(child));
            if (description != null) result["description"] = description;
            if (help != null) result["help_text"] = help;
            return result;
        }
        if ((state & 1) != 0) throw new InvalidOperationException("MSAA element disabled");
        if (kind == "set_value" && (state & 0x40) != 0) throw new InvalidOperationException("MSAA value is read only");
        switch (kind) {
            case "invoke": ActionStarted = true; acc.accDoDefaultAction(child); break;
            case "set_value": ActionStarted = true; acc.set_accValue(child, Text(action, "value")); break;
            case "focus": ActionStarted = true; acc.accSelect(1, child); break;
            case "select": ActionStarted = true; acc.accSelect(2, child); break;
            case "add_to_selection": ActionStarted = true; acc.accSelect(8, child); break;
            case "remove_from_selection": ActionStarted = true; acc.accSelect(16, child); break;
            default: throw new InvalidOperationException("MSAA operation unsupported: " + kind);
        }
        return new Dictionary<string, object> { { "ok", true } };
    }
    [MTAThread] public static void Main() {
        Console.InputEncoding = new UTF8Encoding(false); Console.OutputEncoding = new UTF8Encoding(false);
        StartLegacyEvents(); string line;
        while ((line = Console.ReadLine()) != null) {
            object id = null; ActionStarted = false; NativeCalls = 0;
            try {
                var args = Json.Deserialize<Dictionary<string, object>>(line); id = args["id"];
                string owner = Text(args, "owner"); if (owner.Length == 0) throw new InvalidOperationException("session owner required");
                string consistency = Text(args, "consistency", "snapshot");
                if (consistency != "snapshot" && consistency != "live") throw new InvalidOperationException("consistency must be snapshot or live");
                object result = Text(args, "kind") == "acquire" ? (consistency == "snapshot" ? AcquireSnapshot(args, owner) : Acquire(args, owner)) : Act(args, owner);
                Console.WriteLine(Json.Serialize(new Dictionary<string, object> { { "id", id }, { "result", result }, { "execution_state", ActionStarted ? "completed" : "not_started" } }));
            } catch (Exception error) {
                var response = new Dictionary<string, object> { { "id", id }, { "error", error.Message }, { "execution_state", ActionStarted ? "unknown" : "not_started" } };
                var changed = error as SnapshotChangedException;
                if (changed != null && !ActionStarted) {
                    response["error_code"] = "COMPUTER_SNAPSHOT_CHANGED";
                    response["observed_window"] = new Dictionary<string, object> { { "handle", changed.ObservedWindow.Hwnd.ToInt64().ToString() },
                        { "processId", (int)changed.ObservedWindow.Pid }, { "title", changed.ObservedWindow.Title } };
                    response["native_calls"] = NativeCalls;
                }
                Console.WriteLine(Json.Serialize(response));
            }
        }
    }
}
