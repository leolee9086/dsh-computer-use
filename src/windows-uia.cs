// UI Automation 桥：由 edge-js 在 Node 进程内加载，替代原来那份 PowerShell 脚本里的 UIA 部分。
//
// 为什么这一段是 C# 而不是 Rust：UIA 是一整套 COM 自动化接口（元素树、控件模式、
// 遍历器、缓存请求），.NET 的 System.Windows.Automation 是对它的成熟封装。按
// 「能 Rust 就 Rust，只有难以实现或成本过高的系统调用才用 C#」的分工，这一段归 C#。
//
// **程序集引用不写在这个文件里**：UIA 的几个程序集在 GAC 里，
// `#r "UIAutomationClient.dll"` 这种短名解析不到（csc 只查框架目录、不查 GAC）。
// 由 JS 侧探测完整路径，走 edge.func 的 `references` 选项传进来 —— 这样本文件保持纯 C#。
//
// 入口签名由 edge-js 规定：`public async Task<object> Invoke(dynamic input)`。

using System;
using System.Collections.Generic;
using System.Threading.Tasks;
using System.Windows.Automation;

public class Startup
{
    /// 按 kind 分发。kind 与宿主侧 accessibilitySnapshot / performAccessibility 对应。
    public async Task<object> Invoke(dynamic input)
    {
        string kind = (string)input.kind;
        switch (kind)
        {
            case "accessibility":
                return Snapshot(input);
            case "accessibility-action":
                return Perform(input);
            default:
                throw new InvalidOperationException("不支持的 UI Automation 操作 '" + kind + "'");
        }
    }

    /* ------------------------------ 语义树快照 ------------------------------ */

    /// 数节点用的小账本：递归里要共享计数。
    private sealed class Budget
    {
        public int Spent;
    }

    private static object Snapshot(dynamic input)
    {
        int maxNodes = (int)input.maxNodes;
        int maxDepth = (int)input.maxDepth;
        if (maxNodes < 1) throw new InvalidOperationException("UI Automation 节点上限无效");

        var walker = TreeWalker.ControlViewWalker;
        // 优先从调用方指定的窗口扎根：那才是「这张截图拍的那个窗口」。
        var root = RootFromWindowHandle(input);
        if (root == null)
        {
            // 没指定才退回「当前焦点窗口」。
            // 注意：这在多窗口 / 多屏时是**错的**——它问的是"此刻谁在前台"，
            // 而不是"截图拍的是谁"。所以宿主侧抓到窗口截图时一定要把 HWND 传下来。
            var focused = AutomationElement.FocusedElement ?? AutomationElement.RootElement;
            root = FindApplicationRoot(focused, walker);
        }
        var budget = new Budget();
        var tree = ConvertNode(root, 0, maxDepth, maxNodes, walker, budget);
        if (tree == null) throw new InvalidOperationException("UI Automation 没有返回可访问的根元素");
        return tree;
    }

    /// 按 HWND 找那个顶层窗口元素；没指定句柄时返回 null。
    ///
    /// 两个坑写在这里：
    /// 1. UIA 的 `NativeWindowHandle` 是 **int**，不是指针宽度 —— 所以这边收十进制字符串
    ///    再裁到 int。宿主侧一律以十进制字符串传 HWND（见 native/src/main.rs 的说明）。
    /// 2. **找不到就报错，绝不悄悄退回焦点窗口。** 静默回退正是这个 bug 藏了这么久的理由：
    ///    返回的树看起来完全正常，只是属于另一个窗口，而调用方无从察觉。
    private static AutomationElement RootFromWindowHandle(dynamic input)
    {
        string raw = null;
        if (input.hwnd != null) raw = (string)input.hwnd;
        if (string.IsNullOrEmpty(raw)) return null;
        long value;
        if (!long.TryParse(raw, out value))
        {
            throw new InvalidOperationException("窗口句柄必须是十进制数字，收到 '" + raw + "'");
        }
        var condition = new PropertyCondition(
            AutomationElement.NativeWindowHandleProperty, unchecked((int)value));
        var found = AutomationElement.RootElement.FindFirst(TreeScope.Children, condition);
        if (found == null)
        {
            throw new InvalidOperationException(
                "按句柄 " + raw + " 找不到窗口——它可能已经关闭，或者不再是可见的顶层窗口");
        }
        return found;
    }

    /// 从被聚焦的元素往上找最近的窗口级祖先，作为这棵树的根。
    /// 这样返回的树是「用户正在用的那个应用」，而不是整个桌面。
    private static AutomationElement FindApplicationRoot(AutomationElement element, TreeWalker walker)
    {
        var candidate = element;
        while (candidate != null)
        {
            AutomationElement.AutomationElementInformation current;
            try { current = candidate.Current; }
            catch { break; }
            if (current.ControlType == ControlType.Window) return candidate;
            try { candidate = walker.GetParent(candidate); }
            catch { candidate = null; }
        }
        return element;
    }

    /// 元素的稳定标识：UIA 的 runtime id 串成 `uia:a,b,c`，语义动作靠它重新定位。
    private static string ElementId(AutomationElement element)
    {
        try
        {
            int[] runtimeId = element.GetRuntimeId();
            if (runtimeId == null || runtimeId.Length == 0) return null;
            return "uia:" + string.Join(",", runtimeId);
        }
        catch
        {
            return null;
        }
    }

    /// 探测元素是否支持某个控件模式 —— 支持就意味着有一个对应的语义动作可用。
    private static bool Supports(AutomationElement element, AutomationPattern pattern)
    {
        try
        {
            element.GetCurrentPattern(pattern);
            return true;
        }
        catch
        {
            return false;
        }
    }

    private static List<object> SupportedPatterns(AutomationElement element)
    {
        var patterns = new List<object>();
        if (Supports(element, InvokePattern.Pattern)) patterns.Add("invoke");
        if (Supports(element, ValuePattern.Pattern)) patterns.Add("value");
        if (Supports(element, TogglePattern.Pattern)) patterns.Add("toggle");
        if (Supports(element, ExpandCollapsePattern.Pattern)) patterns.Add("expand_collapse");
        if (Supports(element, SelectionItemPattern.Pattern)) patterns.Add("selection_item");
        if (Supports(element, ScrollItemPattern.Pattern)) patterns.Add("scroll_item");
        if (Supports(element, TextPattern.Pattern)) patterns.Add("text");
        if (Supports(element, RangeValuePattern.Pattern)) patterns.Add("range_value");
        if (Supports(element, SelectionPattern.Pattern)) patterns.Add("selection");
        if (Supports(element, ScrollPattern.Pattern)) patterns.Add("scroll");
        if (Supports(element, GridPattern.Pattern)) patterns.Add("grid");
        if (Supports(element, GridItemPattern.Pattern)) patterns.Add("grid_item");
        if (Supports(element, TablePattern.Pattern)) patterns.Add("table");
        if (Supports(element, WindowPattern.Pattern)) patterns.Add("window");
        if (Supports(element, TransformPattern.Pattern)) patterns.Add("transform");
        if (Supports(element, DockPattern.Pattern)) patterns.Add("dock");
        return patterns;
    }

    private static object ConvertNode(
        AutomationElement element, int depth, int maxDepth, int maxNodes, TreeWalker walker, Budget budget)
    {
        if (element == null || budget.Spent >= maxNodes) return null;
        AutomationElement.AutomationElementInformation current;
        try { current = element.Current; }
        catch { return null; }
        budget.Spent++;

        var node = new Dictionary<string, object>
        {
            { "role", current.ControlType.ProgrammaticName.Replace("ControlType.", "") },
            { "name", current.Name },
            { "automation_id", current.AutomationId },
            { "class_name", current.ClassName },
            { "process_id", current.ProcessId },
            { "backend", "uia" },
            { "native_window_handle", unchecked((uint)current.NativeWindowHandle).ToString() },
            { "password", current.IsPassword },
            { "help_text", current.HelpText },
            { "item_status", current.ItemStatus },
            { "enabled", current.IsEnabled },
            { "focused", current.HasKeyboardFocus },
            { "focusable", current.IsKeyboardFocusable },
            { "offscreen", current.IsOffscreen },
            { "patterns", SupportedPatterns(element) },
            { "children", new List<object>() },
        };

        var elementId = ElementId(element);
        if (elementId != null) node["element_id"] = elementId;
        // 状态用于判断下一步，完整文档按需读取；密码控件不读取 Value/Text。
        try { if (!current.IsPassword && Supports(element, ValuePattern.Pattern)) {
            var value = ((ValuePattern)element.GetCurrentPattern(ValuePattern.Pattern)).Current;
            node["value"] = value.Value.Length > 512 ? value.Value.Substring(0, 512) : value.Value;
            node["read_only"] = value.IsReadOnly;
        } } catch { }
        try { if (Supports(element, TogglePattern.Pattern)) node["toggle_state"] = ((TogglePattern)element.GetCurrentPattern(TogglePattern.Pattern)).Current.ToggleState.ToString(); } catch { }
        try { if (Supports(element, ExpandCollapsePattern.Pattern)) node["expand_state"] = ((ExpandCollapsePattern)element.GetCurrentPattern(ExpandCollapsePattern.Pattern)).Current.ExpandCollapseState.ToString(); } catch { }
        try { if (Supports(element, RangeValuePattern.Pattern)) {
            var range = ((RangeValuePattern)element.GetCurrentPattern(RangeValuePattern.Pattern)).Current;
            node["range"] = new Dictionary<string, object> { { "value", range.Value }, { "minimum", range.Minimum }, { "maximum", range.Maximum }, { "small_change", range.SmallChange }, { "large_change", range.LargeChange }, { "read_only", range.IsReadOnly } };
        } } catch { }
        try { if (Supports(element, GridPattern.Pattern)) {
            var grid = ((GridPattern)element.GetCurrentPattern(GridPattern.Pattern)).Current;
            node["grid"] = new Dictionary<string, object> { { "rows", grid.RowCount }, { "columns", grid.ColumnCount } };
        } } catch { }
        try { if (Supports(element, ScrollPattern.Pattern)) {
            var scroll = ((ScrollPattern)element.GetCurrentPattern(ScrollPattern.Pattern)).Current;
            node["scroll"] = new Dictionary<string, object> { { "horizontal", scroll.HorizontalScrollPercent }, { "vertical", scroll.VerticalScrollPercent }, { "horizontal_view", scroll.HorizontalViewSize }, { "vertical_view", scroll.VerticalViewSize } };
        } } catch { }

        try
        {
            var rect = current.BoundingRectangle;
            if (!rect.IsEmpty)
            {
                node["bounds"] = new Dictionary<string, object>
                {
                    { "x", (int)Math.Round(rect.X) },
                    { "y", (int)Math.Round(rect.Y) },
                    { "width", (int)Math.Round(rect.Width) },
                    { "height", (int)Math.Round(rect.Height) },
                };
            }
        }
        catch
        {
            // 边界取不到就不给这个字段：它对定位不是必需的。
        }

        if (depth < maxDepth && budget.Spent < maxNodes)
        {
            var children = (List<object>)node["children"];
            AutomationElement child = null;
            try { child = walker.GetFirstChild(element); }
            catch { child = null; }
            while (child != null && budget.Spent < maxNodes)
            {
                var childNode = ConvertNode(child, depth + 1, maxDepth, maxNodes, walker, budget);
                if (childNode != null) children.Add(childNode);
                try { child = walker.GetNextSibling(child); }
                catch { child = null; }
            }
        }

        return node;
    }

    /* ------------------------------ 语义动作 ------------------------------ */

    /// 先按观测到的身份重新找到那个元素，再施加动作。
    ///
    /// 重新定位靠 runtime id（UIA 的稳定标识），并在施加动作**之前**核对
    /// automation id / 名称 / 类名 / 角色：元素被替换过就失败退出，
    /// 绝不把动作施加到一个仅仅相似的控件上。
    private static object Perform(dynamic input)
    {
        string elementId = (string)input.action.elementId;
        if (elementId == null || !System.Text.RegularExpressions.Regex.IsMatch(elementId, @"^uia:-?\d+(,-?\d+)*$"))
            throw new InvalidOperationException("UI Automation 元素标识无效");

        int processId = (int)input.action.processId;
        if (processId < 1) throw new InvalidOperationException("UI Automation 动作的进程 id 无效");

        int maxCandidates = (int)input.action.maxCandidates;
        if (maxCandidates < 1) throw new InvalidOperationException("UI Automation 动作的搜索上限无效");

        var runtimeId = new List<int>();
        foreach (var part in elementId.Substring(4).Split(','))
        {
            runtimeId.Add(int.Parse(part));
        }

        var walker = TreeWalker.ControlViewWalker;
        var desktopRoot = AutomationElement.RootElement;

        // 搜索根：从被聚焦元素往上找进程匹配的祖先，缩小遍历范围。
        var searchRoot = desktopRoot;
        var ancestor = AutomationElement.FocusedElement;
        while (ancestor != null)
        {
            AutomationElement.AutomationElementInformation ancestorCurrent;
            try { ancestorCurrent = ancestor.Current; }
            catch { break; }
            if (ancestorCurrent.ProcessId == processId) searchRoot = ancestor;
            try { ancestor = walker.GetParent(ancestor); }
            catch { ancestor = null; }
        }

        var actionArgs = (IDictionary<string, object>)input.action;
        // 指定窗口的后台语义动作必须限制到原窗口，不能沿当前焦点搜索其它应用。
        if (actionArgs.ContainsKey("hwnd") && actionArgs["hwnd"] != null) {
            var rootArgs = new System.Dynamic.ExpandoObject();
            ((IDictionary<string, object>)rootArgs)["hwnd"] = actionArgs["hwnd"];
            searchRoot = RootFromWindowHandle(rootArgs);
            if (searchRoot.Current.ProcessId != processId) throw new InvalidOperationException("窗口进程身份在观测之后变了");
        }
        var element = FindByRuntimeId(searchRoot, desktopRoot, processId, runtimeId, maxCandidates, walker);
        if (element == null)
            throw new InvalidOperationException("UI Automation 元素在配置的搜索范围内已不可用");

        // 身份复核：观测量在这中间变过就拒绝动作。
        var current = element.Current;
        string expectedAutomationId = (string)input.action.automationId;
        if (!string.IsNullOrEmpty(expectedAutomationId) && current.AutomationId != expectedAutomationId)
            throw new InvalidOperationException("UI Automation 元素的 automation id 在观测之后变了");
        string expectedName = (string)input.action.name;
        if (!string.IsNullOrEmpty(expectedName) && current.Name != expectedName)
            throw new InvalidOperationException("UI Automation 元素的名称在观测之后变了");
        string expectedClassName = (string)input.action.className;
        if (!string.IsNullOrEmpty(expectedClassName) && current.ClassName != expectedClassName)
            throw new InvalidOperationException("UI Automation 元素的类名在观测之后变了");
        string expectedRole = (string)input.action.role;
        if (!string.IsNullOrEmpty(expectedRole)
            && current.ControlType.ProgrammaticName.Replace("ControlType.", "") != expectedRole)
            throw new InvalidOperationException("UI Automation 元素的角色在观测之后变了");

        return PerformDirect(element, actionArgs);
    }

    // 常驻语义工作进程持有已经观测的元素引用。它完成身份校验后直接调用这里，
    // 不再为每个动作从窗口根扫描 runtime id；旧 edge 入口仍可独立测试。
    public static object PerformDirect(AutomationElement element, IDictionary<string, object> actionArgs, Action onDispatch = null)
    {
        string kind = (string)actionArgs["kind"];
        if (kind == "read") return ReadElement(element, actionArgs);
        if (!element.Current.IsEnabled) throw new InvalidOperationException("UI Automation 元素已禁用");
        // 先解析参数、获取目标模式和验证状态，最后才标记可能有副作用的投送。
        // readonly/unsupported 等明确的执行前错误因此保留 not_started。
        Action mutate;
        switch (kind) {
            case "invoke": { var p = (InvokePattern)element.GetCurrentPattern(InvokePattern.Pattern); mutate = () => p.Invoke(); break; }
            case "focus": mutate = () => element.SetFocus(); break;
            case "set_value": {
                var p = (ValuePattern)element.GetCurrentPattern(ValuePattern.Pattern);
                if (p.Current.IsReadOnly) throw new InvalidOperationException("UI Automation 的 value 模式是只读的");
                string value = (string)actionArgs["value"]; mutate = () => p.SetValue(value); break;
            }
            case "toggle": { var p = (TogglePattern)element.GetCurrentPattern(TogglePattern.Pattern); mutate = () => p.Toggle(); break; }
            case "expand": case "collapse": { var p = (ExpandCollapsePattern)element.GetCurrentPattern(ExpandCollapsePattern.Pattern); mutate = () => { if (kind == "expand") p.Expand(); else p.Collapse(); }; break; }
            case "select": case "add_to_selection": case "remove_from_selection": {
                var p = (SelectionItemPattern)element.GetCurrentPattern(SelectionItemPattern.Pattern);
                mutate = () => { if (kind == "select") p.Select(); else if (kind == "add_to_selection") p.AddToSelection(); else p.RemoveFromSelection(); }; break;
            }
            case "scroll_into_view": { var p = (ScrollItemPattern)element.GetCurrentPattern(ScrollItemPattern.Pattern); mutate = () => p.ScrollIntoView(); break; }
            case "set_range": {
                var p = (RangeValuePattern)element.GetCurrentPattern(RangeValuePattern.Pattern); double value = Number(actionArgs, "number");
                if (p.Current.IsReadOnly) throw new InvalidOperationException("UI Automation 的 range 模式是只读的");
                if (value < p.Current.Minimum || value > p.Current.Maximum) throw new InvalidOperationException("range value 超出目标范围");
                mutate = () => p.SetValue(value); break;
            }
            case "scroll": {
                var p = (ScrollPattern)element.GetCurrentPattern(ScrollPattern.Pattern);
                var h = (ScrollAmount)Enum.Parse(typeof(ScrollAmount), (string)actionArgs["horizontal"]);
                var v = (ScrollAmount)Enum.Parse(typeof(ScrollAmount), (string)actionArgs["vertical"]);
                mutate = () => p.Scroll(h, v); break;
            }
            case "set_scroll": { var p = (ScrollPattern)element.GetCurrentPattern(ScrollPattern.Pattern); double h = Number(actionArgs, "horizontal"), v = Number(actionArgs, "vertical"); mutate = () => p.SetScrollPercent(h, v); break; }
            case "select_text": case "scroll_text": { var range = TextRange(element, actionArgs); mutate = () => { if (kind == "select_text") range.Select(); else range.ScrollIntoView(true); }; break; }
            case "window_state": { var p = (WindowPattern)element.GetCurrentPattern(WindowPattern.Pattern); var state = (WindowVisualState)Enum.Parse(typeof(WindowVisualState), (string)actionArgs["state"]); mutate = () => p.SetWindowVisualState(state); break; }
            case "close": { var p = (WindowPattern)element.GetCurrentPattern(WindowPattern.Pattern); mutate = () => p.Close(); break; }
            case "move": case "resize": {
                var p = (TransformPattern)element.GetCurrentPattern(TransformPattern.Pattern);
                double x = Number(actionArgs, kind == "move" ? "x" : "width"), y = Number(actionArgs, kind == "move" ? "y" : "height");
                if (kind == "move" && !p.Current.CanMove || kind == "resize" && !p.Current.CanResize) throw new InvalidOperationException("目标不支持该 transform 操作");
                mutate = () => { if (kind == "move") p.Move(x,y); else p.Resize(x,y); }; break;
            }
            default: throw new InvalidOperationException("不支持的 UI Automation 动作 '" + kind + "'");
        }
        if (onDispatch != null) onDispatch();
        mutate();
        return new Dictionary<string, object> { { "ok", true } };
    }

    private static double Number(IDictionary<string, object> args, string key) {
        double value = Convert.ToDouble(args[key]);
        if (double.IsNaN(value) || double.IsInfinity(value)) throw new InvalidOperationException("数值必须有限");
        return value;
    }

    // TextPattern 支持按字符范围与精确文本定位；偏移用 UIA TextUnit.Character 语义。
    private static System.Windows.Automation.Text.TextPatternRange TextRange(AutomationElement element, IDictionary<string, object> args) {
        if (element.Current.IsPassword) throw new InvalidOperationException("不能读取密码控件");
        var pattern = (TextPattern)element.GetCurrentPattern(TextPattern.Pattern);
        var range = pattern.DocumentRange.Clone();
        if (args.ContainsKey("text") && !string.IsNullOrEmpty((string)args["text"])) {
            range = range.FindText((string)args["text"], false, false);
            if (range == null) throw new InvalidOperationException("文档中找不到指定文本");
        } else if (args.ContainsKey("start")) {
            int start = Convert.ToInt32(args["start"]), end = Convert.ToInt32(args["end"]);
            if (start < 0 || end < start) throw new InvalidOperationException("文本范围无效");
            range.MoveEndpointByRange(System.Windows.Automation.Text.TextPatternRangeEndpoint.End, range, System.Windows.Automation.Text.TextPatternRangeEndpoint.Start);
            int moved = range.MoveEndpointByUnit(System.Windows.Automation.Text.TextPatternRangeEndpoint.End, System.Windows.Automation.Text.TextUnit.Character, end);
            if (moved != end) throw new InvalidOperationException("文本范围超出文档");
            moved = range.MoveEndpointByUnit(System.Windows.Automation.Text.TextPatternRangeEndpoint.Start, System.Windows.Automation.Text.TextUnit.Character, start);
            if (moved != start) throw new InvalidOperationException("文本范围超出文档");
        }
        return range;
    }

    private static object ReadElement(AutomationElement element, IDictionary<string, object> args) {
        var result = (Dictionary<string, object>)ConvertNode(element, 0, 0, 1, TreeWalker.ControlViewWalker, new Budget());
        if (element.Current.IsPassword) { result["redacted"] = true; return result; }
        int limit = args.ContainsKey("maxChars") ? Convert.ToInt32(args["maxChars"]) : 16000;
        if (limit < 1 || limit > 100000) throw new InvalidOperationException("文本读取上限无效");
        if ((args.ContainsKey("text") || args.ContainsKey("start")) && !Supports(element, TextPattern.Pattern)) throw new InvalidOperationException("该元素不支持 TextPattern 范围读取");
        if ((args.ContainsKey("row") || args.ContainsKey("column")) && !Supports(element, GridPattern.Pattern)) throw new InvalidOperationException("该元素不支持 GridPattern 单元格读取");
        if (Supports(element, ValuePattern.Pattern)) {
            string value = ((ValuePattern)element.GetCurrentPattern(ValuePattern.Pattern)).Current.Value;
            result["value"] = value.Length > limit ? value.Substring(0, limit) : value;
            result["value_truncated"] = value.Length > limit;
        }
        if (Supports(element, TextPattern.Pattern)) {
            var pattern = (TextPattern)element.GetCurrentPattern(TextPattern.Pattern);
            string text = TextRange(element, args).GetText(limit + 1);
            result["text"] = text.Length > limit ? text.Substring(0, limit) : text;
            result["text_truncated"] = text.Length > limit;
            var selections = new List<object>(); int remaining = limit;
            foreach (var range in pattern.GetSelection()) {
                if (selections.Count >= 32 || remaining < 1) break;
                string selected = range.GetText(remaining);
                selections.Add(new Dictionary<string, object> { { "text", selected }, { "bounds", range.GetBoundingRectangles() } });
                remaining -= selected.Length;
            }
            result["selection"] = selections;
            result["selection_support"] = pattern.SupportedTextSelection.ToString();
        }
        if (Supports(element, SelectionPattern.Pattern)) {
            var selection = ((SelectionPattern)element.GetCurrentPattern(SelectionPattern.Pattern)).Current;
            var ids = new List<object>(); foreach (var item in selection.GetSelection()) { if (ids.Count >= 128) break; ids.Add(ElementId(item)); }
            result["selected_elements"] = ids;
            result["multiple_selection"] = selection.CanSelectMultiple;
        }
        if (Supports(element, GridPattern.Pattern) && args.ContainsKey("row") && args.ContainsKey("column")) {
            var cell = ((GridPattern)element.GetCurrentPattern(GridPattern.Pattern)).GetItem(Convert.ToInt32(args["row"]), Convert.ToInt32(args["column"]));
            result["cell"] = ConvertNode(cell, 0, 0, 1, TreeWalker.ControlViewWalker, new Budget());
        }
        return result;
    }

    /// 在搜索根之下按 runtime id 找元素：深度优先，受候选数上限约束。
    /// 用显式的「先孩子、再兄弟、否则回退」遍历，避免递归爆栈。
    private static AutomationElement FindByRuntimeId(
        AutomationElement searchRoot,
        AutomationElement desktopRoot,
        int processId,
        List<int> runtimeId,
        int maxCandidates,
        TreeWalker walker)
    {
        var scanned = 0;
        var node = searchRoot;
        while (node != null && scanned < maxCandidates)
        {
            AutomationElement.AutomationElementInformation current;
            try { current = node.Current; }
            catch { current = default(AutomationElement.AutomationElementInformation); }

            bool isRealNode = node != desktopRoot || searchRoot != desktopRoot;
            if (isRealNode)
            {
                scanned++;
                if (current.ProcessId == processId)
                {
                    int[] candidateId;
                    try { candidateId = node.GetRuntimeId(); }
                    catch { candidateId = null; }
                    if (Matches(candidateId, runtimeId)) return node;
                }
            }

            AutomationElement child = null;
            try { child = walker.GetFirstChild(node); }
            catch { child = null; }
            if (child != null)
            {
                node = child;
                continue;
            }
            while (node != null)
            {
                if (node == searchRoot) { node = null; break; }
                AutomationElement sibling = null;
                try { sibling = walker.GetNextSibling(node); }
                catch { sibling = null; }
                if (sibling != null) { node = sibling; break; }
                try { node = walker.GetParent(node); }
                catch { node = null; }
            }
        }
        return null;
    }

    private static bool Matches(int[] candidate, List<int> expected)
    {
        if (candidate == null || candidate.Length != expected.Count) return false;
        for (var index = 0; index < expected.Count; index++)
        {
            if (candidate[index] != expected[index]) return false;
        }
        return true;
    }
}
