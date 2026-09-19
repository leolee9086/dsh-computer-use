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
                Perform(input);
                return new Dictionary<string, object> { { "ok", true } };
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
        var focused = AutomationElement.FocusedElement ?? AutomationElement.RootElement;
        var root = FindApplicationRoot(focused, walker);
        var budget = new Budget();
        var tree = ConvertNode(root, 0, maxDepth, maxNodes, walker, budget);
        if (tree == null) throw new InvalidOperationException("UI Automation 没有返回可访问的根元素");
        return tree;
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
            { "enabled", current.IsEnabled },
            { "focused", current.HasKeyboardFocus },
            { "focusable", current.IsKeyboardFocusable },
            { "offscreen", current.IsOffscreen },
            { "patterns", SupportedPatterns(element) },
            { "children", new List<object>() },
        };

        var elementId = ElementId(element);
        if (elementId != null) node["element_id"] = elementId;

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
    private static void Perform(dynamic input)
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

        string kind = (string)input.action.kind;
        switch (kind)
        {
            case "invoke":
                ((InvokePattern)element.GetCurrentPattern(InvokePattern.Pattern)).Invoke();
                break;
            case "focus":
                element.SetFocus();
                break;
            case "set_value":
                var valuePattern = (ValuePattern)element.GetCurrentPattern(ValuePattern.Pattern);
                if (valuePattern.Current.IsReadOnly)
                    throw new InvalidOperationException("UI Automation 的 value 模式是只读的");
                valuePattern.SetValue((string)input.action.value);
                break;
            case "toggle":
                ((TogglePattern)element.GetCurrentPattern(TogglePattern.Pattern)).Toggle();
                break;
            case "expand":
                ((ExpandCollapsePattern)element.GetCurrentPattern(ExpandCollapsePattern.Pattern)).Expand();
                break;
            case "collapse":
                ((ExpandCollapsePattern)element.GetCurrentPattern(ExpandCollapsePattern.Pattern)).Collapse();
                break;
            case "select":
                ((SelectionItemPattern)element.GetCurrentPattern(SelectionItemPattern.Pattern)).Select();
                break;
            case "scroll_into_view":
                ((ScrollItemPattern)element.GetCurrentPattern(ScrollItemPattern.Pattern)).ScrollIntoView();
                break;
            default:
                throw new InvalidOperationException("不支持的 UI Automation 动作 '" + kind + "'");
        }
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
