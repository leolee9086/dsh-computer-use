// MSAA 独立后端：直接走 oleacc/IAccessible，适配没有 UIA provider 的传统控件。
// 路径来自 AccessibleChildren 的有界枚举；动作重新解析路径并复核 HWND/PID/属性。
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading.Tasks;
using Accessibility;

public class Startup {
    [DllImport("oleacc.dll")] static extern int AccessibleObjectFromWindow(IntPtr hwnd, uint id, ref Guid iid, [MarshalAs(UnmanagedType.Interface)] out IAccessible accessible);
    [DllImport("oleacc.dll")] static extern int AccessibleChildren(IAccessible accessible, int start, int count, [Out, MarshalAs(UnmanagedType.LPArray, SizeParamIndex=2)] object[] children, out int obtained);
    [DllImport("oleacc.dll", CharSet=CharSet.Unicode)] static extern uint GetRoleText(uint role, StringBuilder text, uint length);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern bool IsWindow(IntPtr hwnd);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr hwnd, StringBuilder text, int length);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int length);

    class Target { public IAccessible Accessible; public object Child = 0; }
    class Budget { public int Count; public int Limit; }
    public async Task<object> Invoke(dynamic raw) {
        var args = (IDictionary<string, object>)raw;
        var hwnd = args.ContainsKey("hwnd") && args["hwnd"] != null ? new IntPtr(long.Parse((string)args["hwnd"])) : GetForegroundWindow();
        if (hwnd == IntPtr.Zero || !IsWindow(hwnd)) throw new InvalidOperationException("MSAA window is unavailable");
        uint pid; GetWindowThreadProcessId(hwnd, out pid);
        if (args.ContainsKey("processId") && Convert.ToUInt32(args["processId"]) != pid) throw new InvalidOperationException("MSAA window process identity changed");
        string title = WindowString(hwnd, false);
        if (args.ContainsKey("title") && (string)args["title"] != title) throw new InvalidOperationException("MSAA window title changed");
        var iid = new Guid("618736E0-3C3D-11CF-810C-00AA00389B71");
        IAccessible root;
        int hr = AccessibleObjectFromWindow(hwnd, unchecked((uint)-4), ref iid, out root);
        if (hr < 0 || root == null) throw new InvalidOperationException("MSAA OBJID_CLIENT is unavailable: " + hr);
        var target = new Target { Accessible = root };
        if ((string)args["kind"] == "accessibility") {
            int limit = Convert.ToInt32(args["maxNodes"]), depth = Convert.ToInt32(args["maxDepth"]);
            if (limit < 1 || limit > 10000 || depth < 0 || depth > 64) throw new InvalidOperationException("MSAA tree bounds invalid");
            var tree = Node(target, hwnd, pid, title, "root", 0, depth, new Budget { Limit=limit });
            if (tree == null) throw new InvalidOperationException("MSAA root is inaccessible");
            return tree;
        }
        var action = (IDictionary<string, object>)args["action"];
        string id = (string)action["elementId"];
        string prefix = "msaa:" + hwnd.ToInt64() + ":";
        if (!id.StartsWith(prefix)) throw new InvalidOperationException("MSAA element belongs to another window");
        string path = id.Substring(prefix.Length);
        if (path != "root") {
            var segments = path.Split('.');
            if (segments.Length > 64) throw new InvalidOperationException("MSAA path exceeds depth limit");
            foreach (string segment in segments) {
                int index = int.Parse(segment);
                if (index < 0 || index >= 10000 || Convert.ToInt32(target.Child) != 0) throw new InvalidOperationException("MSAA element path unavailable");
                var children = Children(target.Accessible, 10000);
                if (index >= children.Length) throw new InvalidOperationException("MSAA element disappeared");
                target = Child(target.Accessible, children[index]);
            }
        }
        var current = Node(target, hwnd, pid, title, path, 0, 0, new Budget { Limit=1 });
        if (current == null) throw new InvalidOperationException("MSAA element unavailable");
        foreach (string field in new [] { "name", "role", "className" }) {
            string key = field == "className" ? "class_name" : field;
            if (action.ContainsKey(field) && (string)action[field] != (string)current[key]) throw new InvalidOperationException("MSAA element identity changed: " + field);
        }
        int state = Convert.ToInt32(current["state"]);
        string operation = (string)action["kind"];
        if (operation == "read") {
            foreach (string unsupported in new [] { "text", "start", "end", "row", "column" }) if (action.ContainsKey(unsupported)) throw new InvalidOperationException("MSAA does not expose TextPattern/GridPattern ranges; omit " + unsupported);
            if ((state & 0x20000000) != 0) { current["redacted"] = true; return current; }
            int max = action.ContainsKey("maxChars") ? Convert.ToInt32(action["maxChars"]) : 16000;
            if (max < 1 || max > 100000) throw new InvalidOperationException("MSAA read limit invalid");
            string value = Safe(() => target.Accessible.get_accValue(target.Child));
            current["value"] = value.Length > max ? value.Substring(0, max) : value;
            current["value_truncated"] = value.Length > max;
            current["description"] = Safe(() => target.Accessible.get_accDescription(target.Child));
            current["help_text"] = Safe(() => target.Accessible.get_accHelp(target.Child));
            return current;
        }
        if ((state & 1) != 0) throw new InvalidOperationException("MSAA element disabled");
        switch (operation) {
            case "invoke": target.Accessible.accDoDefaultAction(target.Child); break;
            case "set_value":
                if ((state & 0x40) != 0) throw new InvalidOperationException("MSAA value is read only");
                target.Accessible.set_accValue(target.Child, (string)action["value"]); break;
            case "focus": target.Accessible.accSelect(1, target.Child); break;
            case "select": target.Accessible.accSelect(2, target.Child); break;
            case "add_to_selection": target.Accessible.accSelect(8, target.Child); break;
            case "remove_from_selection": target.Accessible.accSelect(16, target.Child); break;
            default: throw new InvalidOperationException("MSAA operation unsupported: " + operation);
        }
        return new Dictionary<string, object> { { "ok", true } };
    }
    static string WindowString(IntPtr hwnd, bool className) {
        var value = new StringBuilder(1024);
        if (className) GetClassName(hwnd, value, value.Capacity); else GetWindowText(hwnd, value, value.Capacity);
        return value.ToString();
    }
    static string Safe(Func<string> getter) { try { return getter() ?? ""; } catch { return ""; } }
    static Target Child(IAccessible parent, object value) {
        var accessible = value as IAccessible;
        if (accessible != null) return new Target { Accessible = accessible };
        if (value is int) return new Target { Accessible = parent, Child = value };
        throw new InvalidOperationException("MSAA child has unsupported VARIANT type");
    }
    static object[] Children(IAccessible parent, int limit) {
        int count = Math.Max(0, Math.Min(limit, parent.accChildCount));
        if (count == 0) return new object[0];
        var result = new object[count]; int obtained;
        int hr = AccessibleChildren(parent, 0, count, result, out obtained);
        if (hr < 0) throw new InvalidOperationException("MSAA child enumeration failed: " + hr);
        if (obtained < result.Length) Array.Resize(ref result, Math.Max(0, obtained));
        return result;
    }
    static string Role(object value) {
        int role = Convert.ToInt32(value);
        switch (role) {
            case 9: return "Window"; case 10: return "Client"; case 41: return "Text"; case 42: return "Edit";
            case 43: return "Button"; case 44: return "CheckBox"; case 45: return "RadioButton";
            case 33: return "List"; case 34: return "ListItem"; case 46: return "ComboBox"; case 51: return "Slider";
            default: var name = new StringBuilder(256); GetRoleText((uint)role, name, 256); return name.ToString();
        }
    }
    static Dictionary<string, object> Node(Target target, IntPtr hwnd, uint pid, string title, string path, int depth, int maxDepth, Budget budget) {
        if (budget.Count >= budget.Limit) return null;
        try {
            int state = Convert.ToInt32(target.Accessible.get_accState(target.Child));
            string role = Role(target.Accessible.get_accRole(target.Child));
            string name = Safe(() => target.Accessible.get_accName(target.Child));
            string defaultAction = Safe(() => target.Accessible.get_accDefaultAction(target.Child));
            var patterns = new List<object>();
            if (defaultAction.Length > 0) patterns.Add("invoke");
            if (role == "Edit" || role == "ComboBox") patterns.Add("value");
            if ((state & 0x200000) != 0 || role == "ListItem") patterns.Add("selection_item");
            int left, top, width, height;
            target.Accessible.accLocation(out left, out top, out width, out height, target.Child);
            var children = new List<object>();
            var node = new Dictionary<string, object> {
                { "element_id", "msaa:" + hwnd.ToInt64() + ":" + path }, { "backend", "msaa" },
                { "native_window_handle", hwnd.ToInt64().ToString() }, { "process_id", (int)pid },
                { "window_title", title }, { "role", role }, { "name", name }, { "class_name", WindowString(hwnd, true) },
                { "enabled", (state & 1) == 0 }, { "focused", (state & 4) != 0 }, { "focusable", (state & 0x100000) != 0 },
                { "offscreen", (state & 0x18000) != 0 }, { "password", (state & 0x20000000) != 0 },
                { "state", state }, { "default_action", defaultAction }, { "patterns", patterns }, { "children", children },
                { "bounds", new Dictionary<string, object> { { "x", left }, { "y", top }, { "width", width }, { "height", height } } }
            };
            budget.Count++;
            if (depth < maxDepth && Convert.ToInt32(target.Child) == 0) {
                var items = Children(target.Accessible, budget.Limit - budget.Count);
                for (int index = 0; index < items.Length && budget.Count < budget.Limit; index++) {
                    string nextPath = path == "root" ? index.ToString() : path + "." + index;
                    var child = Node(Child(target.Accessible, items[index]), hwnd, pid, title, nextPath, depth+1, maxDepth, budget);
                    if (child != null) children.Add(child);
                }
            }
            return node;
        } catch { return null; }
    }
}
