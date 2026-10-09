// 层级定位走有界实时遍历，不先导出/封存整树。每级只保留消歧所需候选，
// 只有唯一命中（或明确 nth）才能继续；整条链共用节点、字节和时间预算。
using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Text;
using System.Text.RegularExpressions;
using System.Windows.Automation;

internal static partial class SemanticWorker
{
    // 这是 locator 专用 matcher，不改变基础 find 的封存/分页查询。
    // 一次请求先编译完整 path，包括短路时不会执行的分支；无效正则/不支持属性
    // 必须在遍历前失败。布尔树作用于同一个节点，重叠 OR 不重复计数。
    sealed class LocatorCompiler {
        public string Backend; public int Nodes, Terms;
        static readonly string[][] Fields = { new [] { "name", "name", "1024" }, new [] { "role", "role", "128" },
            new [] { "automationId", "automation_id", "1024" }, new [] { "className", "class_name", "512" }, new [] { "frameworkId", "framework_id", "128" } };
        internal static Func<Dictionary<string, object>, bool?> Combine(List<Func<Dictionary<string, object>, bool?>> tests, bool all) {
            return node => {
                bool unknown = false;
                foreach (var test in tests) {
                    bool? result = test(node);
                    if (result == (all ? false : true)) return result;
                    if (!result.HasValue) unknown = true;
                }
                return unknown ? (bool?)null : all;
            };
        }
        public Func<Dictionary<string, object>, bool?> Leaf(Dictionary<string, object> raw, bool optional) {
            object value; string mode = "exact";
            if (raw.TryGetValue("match", out value)) {
                mode = value as string;
                if (mode != "exact" && mode != "contains" && mode != "regex") throw new InvalidOperationException("locator match invalid");
            }
            var tests = new List<Func<Dictionary<string, object>, bool?>>();
            foreach (var pair in Fields) {
                if (!raw.TryGetValue(pair[0], out value)) continue;
                string expected = value as string, field = pair[1];
                if (expected == null || expected.Length < 1 || expected.Length > int.Parse(pair[2])) throw new InvalidOperationException("locator selector length invalid: " + field);
                if (++Terms > 32) throw new InvalidOperationException("locator predicate exceeds 32 property comparisons");
                if (Backend == "msaa" && (field == "framework_id" || field == "automation_id")) throw new InvalidOperationException("MSAA does not expose " + field);
                Regex regex = null;
                if (mode == "regex") {
                    try { regex = new Regex(expected, RegexOptions.IgnoreCase | RegexOptions.CultureInvariant, TimeSpan.FromMilliseconds(25)); }
                    catch (ArgumentException) { throw new InvalidOperationException("locator_regex_invalid: invalid .NET pattern for " + field); }
                }
                tests.Add(node => {
                    object actualValue;
                    // 缺失/null不是空串，也不能经 NOT 变成命中。正常暴露的空串仍可匹配。
                    if (!node.TryGetValue(field, out actualValue) || !(actualValue is string)) return null;
                    string actual = (string)actualValue;
                    if (regex != null) {
                        if (actual.Length > 16000) throw new InvalidOperationException("locator_regex_input_limit: property exceeds 16000 characters: " + field);
                        try { return regex.IsMatch(actual); }
                        catch (RegexMatchTimeoutException) { throw new InvalidOperationException("locator_regex_timeout: .NET match exceeded 25 ms for " + field); }
                    }
                    return mode == "exact" ? string.Equals(actual, expected, StringComparison.OrdinalIgnoreCase) : actual.IndexOf(expected, StringComparison.OrdinalIgnoreCase) >= 0;
                });
            }
            if (tests.Count == 0) {
                if (!optional) throw new InvalidOperationException("locator expression requires selector fields");
                return null;
            }
            return Combine(tests, true);
        }
        public Func<Dictionary<string, object>, bool?> Expression(object expression, int depth) {
            var raw = expression as Dictionary<string, object>;
            if (raw == null) throw new InvalidOperationException("locator expression must be an object");
            if (depth > 4 || ++Nodes > 64) throw new InvalidOperationException("locator predicate exceeds depth 4 or 64 expression nodes");
            string op = null;
            foreach (string key in new [] { "all", "any", "not" }) if (raw.ContainsKey(key)) {
                if (op != null || raw.Count != 1) throw new InvalidOperationException("locator expression requires exactly one all/any/not without selector fields");
                op = key;
            }
            if (op == "not") { var test = Expression(raw[op], depth + 1); return node => !test(node); }
            if (op != null) {
                var children = raw[op] as IList;
                if (children == null || children.Count < 1 || children.Count > 16) throw new InvalidOperationException("locator " + op + " requires 1..16 expressions");
                var tests = new List<Func<Dictionary<string, object>, bool?>>();
                foreach (var child in children) tests.Add(Expression(child, depth + 1));
                return Combine(tests, op == "all");
            }
            foreach (string key in raw.Keys) if (key != "match" && !Array.Exists(Fields, pair => pair[0] == key)) throw new InvalidOperationException("unsupported locator expression field: " + key);
            return Leaf(raw, false);
        }
    }
    sealed class LocatorMatcher {
        Func<Dictionary<string, object>, bool?> Test; bool IncludeOffscreen, IncludeDisabled;
        public static LocatorMatcher Compile(Dictionary<string, object> query, string backend) {
            if (query == null) throw new InvalidOperationException("locator query must be an object");
            var compiler = new LocatorCompiler { Backend = backend };
            var tests = new List<Func<Dictionary<string, object>, bool?>>();
            var top = compiler.Leaf(query, true); if (top != null) tests.Add(top);
            object expression; if (query.TryGetValue("where", out expression)) tests.Add(compiler.Expression(expression, 1));
            if (tests.Count == 0) throw new InvalidOperationException("locator query requires selectors or where");
            return new LocatorMatcher { Test = LocatorCompiler.Combine(tests, true), IncludeOffscreen = Flag(query, "includeOffscreen"), IncludeDisabled = Flag(query, "includeDisabled") };
        }
        public bool Matches(Dictionary<string, object> node) {
            if (!IncludeOffscreen && Flag(node, "offscreen")) return false;
            if (!IncludeDisabled && !Flag(node, "enabled")) return false;
            bool? result = Test(node);
            // 无法判定不能当作不命中，否则完整遍历会给 absent 一个错误的证明。
            if (!result.HasValue) throw new InvalidOperationException("locator_property_unavailable: predicate result is unknown");
            return result.Value;
        }
    }
    static object Locate(IDictionary<string, object> args, string owner) {
        string backend = Text(args, "backend", "uia");
        if (backend != "uia" && backend != "msaa") throw new InvalidOperationException("backend invalid");
        var path = args["locator"] as IList;
        if (path == null || path.Count < 1 || path.Count > 16) throw new InvalidOperationException("locator requires 1..16 steps");
        int limit = Integer(args, "maxNodes", 20000), budget = Integer(args, "budgetMs", 5000), bytesLimit = Integer(args, "maxBytes", 1000000);
        if (limit < 1 || limit > 20000 || budget < 1 || bytesLimit < 4096) throw new InvalidOperationException("locator budgets invalid");
        var clock = Stopwatch.StartNew(); var matchers = new List<LocatorMatcher>();
        foreach (var item in path) {
            var step = item as Dictionary<string, object>; object query;
            if (step == null || !step.TryGetValue("query", out query)) throw new InvalidOperationException("locator step requires query");
            matchers.Add(LocatorMatcher.Compile(query as Dictionary<string, object>, backend));
        }
        var window = ResolveWindow(args, backend); Target root = window.Root;
        int version = window.Version, visited = 0, stepIndex = 0; bool prefixSelected = false;
        var ancestors = new List<Target>();
        var trace = new List<object>(); var candidates = new List<object>(); string status = "not_found", reason = null;
        for (stepIndex = 0; stepIndex < path.Count; stepIndex++) {
            status = "not_found";
            var step = (Dictionary<string, object>)path[stepIndex]; var matcher = matchers[stepIndex];
            string scope = Text(step, "scope", "subtree"); int depth = Integer(step, "maxDepth", 128), nth = Integer(step, "nth", -1);
            if ((scope != "children" && scope != "subtree") || depth < 1 || depth > 128 || nth < -1 || nth > 19999) throw new InvalidOperationException("locator step bounds invalid");
            if (scope == "children") depth = 1;
            // root 本身不匹配：每一步查询上一层窗口/容器的后代。
            var pending = new Stack<Frame>(); pending.Push(new Frame { Node = root, Depth = 0, Entered = true });
            var hits = new List<Target>(); int matches = 0; bool depthLimited = false; Target chosen = null;
            while (pending.Count > 0) {
                if (window.Version != version) throw new ElementNotAvailableException("locator tree changed while resolving");
                if (clock.ElapsedMilliseconds >= budget) { reason = "time_limit"; break; }
                var frame = pending.Peek();
                if (!frame.Entered) {
                    if (visited >= limit) { reason = "node_limit"; break; }
                    visited++; frame.Entered = true;
                    if (matcher.Matches(QueryFields(frame.Node))) {
                        matches++;
                        if (nth < 0) {
                            hits.Add(frame.Node);
                            if (hits.Count == 2) { status = "ambiguous"; reason = "multiple_matches"; break; }
                        } else if (matches == nth + 1) { chosen = frame.Node; break; }
                    }
                }
                if (frame.Depth >= depth) {
                    if (scope != "children" && NextChild(frame, false) != null) depthLimited = true;
                    pending.Pop(); continue;
                }
                var next = NextChild(frame, false);
                if (next == null) pending.Pop();
                else pending.Push(new Frame { Node = next, Depth = frame.Depth + 1 });
            }
            if (status == "ambiguous") {
                foreach (var hit in hits) { var row = Describe(hit); Save(hit, row, owner); candidates.Add(row); }
                break;
            }
            // 在 nth 前跳过的深层节点可能包含更早匹配；这时不能声称序号有效。
            if (reason != null || depthLimited) { status = "incomplete"; reason = reason ?? "depth_limit"; break; }
            if (chosen == null && hits.Count == 1) chosen = hits[0];
            if (chosen == null) break;
            if (chosen.Uia != null && RuntimeId(chosen.Uia) != chosen.Id) throw new ElementNotAvailableException("locator ancestor replaced");
            if (!matcher.Matches(QueryFields(chosen, true))) throw new ElementNotAvailableException("locator ancestor no longer matches");
            trace.Add(new Dictionary<string, object> { { "step", stepIndex }, { "element_id", chosen.Id }, { "matches", matches }, { "selection", nth < 0 ? "unique" : "nth" } });
            if (nth >= 0) prefixSelected = true;
            ancestors.Add(chosen); root = chosen; status = "resolved";
        }
        // 未找到也要复查已选容器，避免把一次容器替换误认为目标消失。
        ValidateWindow(window);
        for (int i = 0; i < ancestors.Count; i++) {
            var target = ancestors[i];
            if (target.Uia != null && RuntimeId(target.Uia) != target.Id) throw new ElementNotAvailableException("locator ancestor unavailable");
            if (!matchers[i].Matches(QueryFields(target, true))) throw new ElementNotAvailableException("locator ancestor changed");
        }
        Dictionary<string, object> element = null;
        if (status == "resolved") { element = Describe(root); Save(root, element, owner); }
        if (window.Version != version) throw new ElementNotAvailableException("locator tree changed while resolving");
        if (clock.ElapsedMilliseconds >= budget) { status = "incomplete"; reason = "time_limit"; element = null; candidates.Clear(); }
        // nth 是明确的前缀选择，只有唯一/缺失判断要求穷尽范围；不把 nth 当作唯一。
        string coverage = status == "incomplete" || status == "ambiguous" || (status == "resolved" && prefixSelected) ? "partial" : "complete";
        var result = new Dictionary<string, object> {
            { "status", status }, { "step", Math.Min(stepIndex, path.Count - 1) }, { "element", element }, { "candidates", candidates }, { "trace", trace },
            { "coverage", new Dictionary<string, object> { { "status", coverage }, { "reason", reason ?? (prefixSelected ? "explicit_nth_prefix" : null) }, { "scope", "locator_steps" }, { "unrealized_items_traversed", false } } },
            { "consistency", new Dictionary<string, object> { { "mode", "live" }, { "source_atomic", false } } },
            { "visited_nodes", visited }, { "native_calls", NativeCalls }, { "elapsed_ms", clock.ElapsedMilliseconds }, { "worker_generation", Generation },
            { "window", new Dictionary<string, object> { { "handle", window.Hwnd.ToInt64().ToString() }, { "processId", (int)window.Pid }, { "title", window.Title } } }
        };
        if (Encoding.UTF8.GetByteCount(Json.Serialize(result)) > bytesLimit) throw new InvalidOperationException("locator result exceeds byte budget");
        return result;
    }
}
