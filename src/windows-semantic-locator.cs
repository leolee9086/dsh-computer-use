// 层级定位走有界实时遍历，不先导出/封存整树。每级只保留消歧所需候选，
// 只有唯一命中（或明确 nth）才能继续；整条链及关系复查共用节点和时间预算。
using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Text;
using System.Text.RegularExpressions;
using System.Windows.Automation;

internal static partial class SemanticWorker
{
    // 一次请求先编译完整 path，包括短路时不会执行的关系/布尔分支。
    // 无效正则和不支持属性在遍历前失败；同节点 OR 不重复计数。
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
    // 不把关系扫描或 fresh recheck 的额外工作藏在独立预算中。
    sealed class LocatorBudget {
        public Window Window; public int Version, MaxNodes, BudgetMs, Visited;
        public Stopwatch Clock; public string Reason;
        public bool Check() {
            if (Window.Version != Version) throw new ElementNotAvailableException("locator tree changed while resolving");
            if (Clock.ElapsedMilliseconds >= BudgetMs) Reason = "time_limit";
            return Reason == null;
        }
        public bool Visit() {
            if (!Check()) return false;
            if (Visited >= MaxNodes) { Reason = "node_limit"; return false; }
            Visited++; return true;
        }
    }
    sealed class LocatorRelation {
        public LocatorMatcher Matcher; public string Scope; public int MaxDepth;
        public static LocatorRelation Build(object value, LocatorCompiler compiler) {
            var raw = value as Dictionary<string, object>; object query;
            if (raw == null || !raw.TryGetValue("query", out query)) throw new InvalidOperationException("locator relation requires query");
            foreach (string key in raw.Keys) if (key != "query" && key != "scope" && key != "maxDepth") throw new InvalidOperationException("unsupported locator relation field: " + key);
            string scope = Text(raw, "scope", "subtree"); int depth = Integer(raw, "maxDepth", 128);
            if ((scope != "children" && scope != "subtree") || depth < 1 || depth > 128) throw new InvalidOperationException("locator relation bounds invalid");
            return new LocatorRelation { Matcher = LocatorMatcher.Build(query as Dictionary<string, object>, compiler, false), Scope = scope, MaxDepth = scope == "children" ? 1 : depth };
        }
        public bool? Contains(Target candidate, LocatorBudget budget, int remainingDepth) {
            int depth = Math.Min(MaxDepth, remainingDepth); bool depthLimited = false;
            // candidate 本身永不参与匹配。root 只用于取得相对后代。
            var pending = new Stack<Frame>(); pending.Push(new Frame { Node = candidate, Depth = 0, Entered = true });
            while (pending.Count > 0) {
                if (!budget.Check()) return null;
                var frame = pending.Peek();
                if (!frame.Entered) {
                    if (!budget.Visit()) return null;
                    frame.Entered = true;
                    bool found = Matcher.Matches(QueryFields(frame.Node));
                    if (!budget.Check()) return null;
                    // 任意一个 witness 已能证明存在，别支深度截断不否定该证明。
                    if (found) return true;
                }
                if (frame.Depth >= depth) {
                    // children 的完整范围只有直接孩子；若总深度连孩子都容不下则仍未知。
                    if ((Scope != "children" || depth < 1) && NextChild(frame, false) != null) depthLimited = true;
                    pending.Pop(); continue;
                }
                var next = NextChild(frame, false);
                if (next == null) pending.Pop();
                else pending.Push(new Frame { Node = next, Depth = frame.Depth + 1 });
            }
            if (!budget.Check()) return null;
            if (depthLimited) { budget.Reason = "depth_limit"; return null; }
            return false;
        }
    }
    sealed class LocatorMatcher {
        Func<Dictionary<string, object>, bool?> Test; bool IncludeOffscreen, IncludeDisabled;
        LocatorRelation Has, HasNot;
        public bool HasRelations { get { return Has != null || HasNot != null; } }
        // 保留 Compile/Matches 的纯属性契约，编译器也校验所有关系分支。
        public static LocatorMatcher Compile(Dictionary<string, object> query, string backend) {
            return Build(query, new LocatorCompiler { Backend = backend }, true);
        }
        public static LocatorMatcher Build(Dictionary<string, object> query, LocatorCompiler compiler, bool allowRelations) {
            if (query == null) throw new InvalidOperationException("locator query must be an object");
            foreach (string key in query.Keys) {
                if (key == "has" || key == "hasNot") {
                    if (!allowRelations) throw new InvalidOperationException("nested locator relations are unsupported");
                } else if (key != "name" && key != "role" && key != "automationId" && key != "className" && key != "frameworkId" && key != "match" && key != "where" && key != "includeOffscreen" && key != "includeDisabled")
                    throw new InvalidOperationException("unsupported locator query field: " + key);
            }
            var tests = new List<Func<Dictionary<string, object>, bool?>>();
            var top = compiler.Leaf(query, true); if (top != null) tests.Add(top);
            object value; if (query.TryGetValue("where", out value)) tests.Add(compiler.Expression(value, 1));
            if (tests.Count == 0) throw new InvalidOperationException("locator query requires selectors or where");
            var matcher = new LocatorMatcher { Test = LocatorCompiler.Combine(tests, true), IncludeOffscreen = Flag(query, "includeOffscreen"), IncludeDisabled = Flag(query, "includeDisabled") };
            if (query.TryGetValue("has", out value)) matcher.Has = LocatorRelation.Build(value, compiler);
            if (query.TryGetValue("hasNot", out value)) matcher.HasNot = LocatorRelation.Build(value, compiler);
            return matcher;
        }
        public bool Matches(Dictionary<string, object> node) {
            if (!IncludeOffscreen && Flag(node, "offscreen")) return false;
            if (!IncludeDisabled && !Flag(node, "enabled")) return false;
            bool? result = Test(node);
            if (!result.HasValue) throw new InvalidOperationException("locator_property_unavailable: predicate result is unknown");
            return result.Value;
        }
        public bool? Evaluate(Target target, LocatorBudget budget, int remainingDepth, bool refresh = false) {
            if (!budget.Check()) return null;
            bool propertyMatch = Matches(QueryFields(target, refresh));
            if (!budget.Check()) return null;
            if (!propertyMatch) return false;
            if (Has != null) {
                bool? present = Has.Contains(target, budget, remainingDepth);
                if (present != true) return present;
            }
            if (HasNot != null) {
                bool? present = HasNot.Contains(target, budget, remainingDepth);
                if (!present.HasValue) return null;
                if (present.Value) return false;
            }
            return budget.Check() ? (bool?)true : null;
        }
    }
    static object Locate(IDictionary<string, object> args, string owner) {
        string backend = Text(args, "backend", "uia");
        if (backend != "uia" && backend != "msaa") throw new InvalidOperationException("backend invalid");
        var path = args["locator"] as IList;
        if (path == null || path.Count < 1 || path.Count > 16) throw new InvalidOperationException("locator requires 1..16 steps");
        int limit = Integer(args, "maxNodes", 20000), budgetMs = Integer(args, "budgetMs", 5000), bytesLimit = Integer(args, "maxBytes", 1000000);
        if (limit < 1 || limit > 20000 || budgetMs < 1 || bytesLimit < 4096) throw new InvalidOperationException("locator budgets invalid");
        var clock = Stopwatch.StartNew(); var matchers = new List<LocatorMatcher>();
        foreach (var item in path) {
            var step = item as Dictionary<string, object>; object query;
            if (step == null || !step.TryGetValue("query", out query)) throw new InvalidOperationException("locator step requires query");
            matchers.Add(LocatorMatcher.Compile(query as Dictionary<string, object>, backend));
        }
        var window = ResolveWindow(args, backend); Target root = window.Root;
        var budget = new LocatorBudget { Window = window, Version = window.Version, Clock = clock, MaxNodes = limit, BudgetMs = budgetMs };
        int stepIndex = 0; bool prefixSelected = false;
        var ancestors = new List<Target>(); var remainingDepths = new List<int>();
        var trace = new List<object>(); var candidates = new List<object>(); var candidateHits = new List<Target>();
        string status = "not_found", reason = null;
        for (stepIndex = 0; stepIndex < path.Count; stepIndex++) {
            status = "not_found";
            var step = (Dictionary<string, object>)path[stepIndex]; var matcher = matchers[stepIndex];
            string scope = Text(step, "scope", "subtree"); int depth = Integer(step, "maxDepth", 128), nth = Integer(step, "nth", -1);
            if ((scope != "children" && scope != "subtree") || depth < 1 || depth > 128 || nth < -1 || nth > 19999) throw new InvalidOperationException("locator step bounds invalid");
            if (scope == "children" && !matcher.HasRelations) depth = 1;
            int candidateDepth = scope == "children" ? 1 : depth;
            var pending = new Stack<Frame>(); pending.Push(new Frame { Node = root, Depth = 0, Entered = true });
            var hits = new List<Target>(); var hitDepths = new List<int>();
            int matches = 0, chosenDepth = 0; bool depthLimited = false; Target chosen = null;
            while (pending.Count > 0) {
                if (!budget.Check()) break;
                var frame = pending.Peek();
                if (!frame.Entered) {
                    if (!budget.Visit()) break;
                    frame.Entered = true;
                    bool? matched = matcher.Evaluate(frame.Node, budget, depth - frame.Depth);
                    if (!matched.HasValue) break;
                    if (matched.Value) {
                        matches++;
                        if (nth < 0) {
                            hits.Add(frame.Node); hitDepths.Add(frame.Depth);
                            if (hits.Count == 2) { status = "ambiguous"; reason = "multiple_matches"; break; }
                        } else if (matches == nth + 1) { chosen = frame.Node; chosenDepth = frame.Depth; break; }
                    }
                }
                if (frame.Depth >= candidateDepth) {
                    if (scope != "children" && NextChild(frame, false) != null) depthLimited = true;
                    pending.Pop(); continue;
                }
                var next = NextChild(frame, false);
                if (next == null) pending.Pop();
                else pending.Push(new Frame { Node = next, Depth = frame.Depth + 1 });
            }
            if (budget.Reason != null) { status = "incomplete"; reason = budget.Reason; break; }
            if (status == "ambiguous") { candidateHits.AddRange(hits); break; }
            // nth 前跳过的深层节点可能包含更早匹配，不能声称序号有效。
            if (depthLimited) { status = "incomplete"; reason = "depth_limit"; break; }
            if (chosen == null && hits.Count == 1) { chosen = hits[0]; chosenDepth = hitDepths[0]; }
            if (chosen == null) break;
            if (!budget.Visit()) { status = "incomplete"; reason = budget.Reason; break; }
            if (chosen.Uia != null && RuntimeId(chosen.Uia) != chosen.Id) throw new ElementNotAvailableException("locator ancestor replaced");
            bool? rechecked = matcher.Evaluate(chosen, budget, depth - chosenDepth, true);
            if (!rechecked.HasValue) { status = "incomplete"; reason = budget.Reason; break; }
            if (!rechecked.Value) throw new ElementNotAvailableException("locator ancestor no longer matches");
            trace.Add(new Dictionary<string, object> { { "step", stepIndex }, { "element_id", chosen.Id }, { "matches", matches }, { "selection", nth < 0 ? "unique" : "nth" } });
            if (nth >= 0) prefixSelected = true;
            ancestors.Add(chosen); remainingDepths.Add(depth - chosenDepth); root = chosen; status = "resolved";
        }
        // 未找到也复查已选容器；新鲜关系扫描仍共享预算，不借 changed 重试突破预算。
        ValidateWindow(window);
        for (int i = 0; i < ancestors.Count; i++) {
            if (!budget.Visit()) { status = "incomplete"; reason = budget.Reason; break; }
            var target = ancestors[i];
            if (target.Uia != null && RuntimeId(target.Uia) != target.Id) throw new ElementNotAvailableException("locator ancestor unavailable");
            bool? rechecked = matchers[i].Evaluate(target, budget, remainingDepths[i], true);
            if (!rechecked.HasValue) { status = "incomplete"; reason = budget.Reason; break; }
            if (!rechecked.Value) throw new ElementNotAvailableException("locator ancestor changed");
        }
        Dictionary<string, object> element = null;
        if (status == "resolved" && budget.Check()) { element = Describe(root); Save(root, element, owner); }
        if (status == "ambiguous" && budget.Check()) foreach (var hit in candidateHits) { var row = Describe(hit); Save(hit, row, owner); candidates.Add(row); }
        if (!budget.Check()) { status = "incomplete"; reason = budget.Reason; }
        if (status == "incomplete") { element = null; candidates.Clear(); }
        // nth 只证明明确的前缀选择，不声称唯一；截断不证明 absent。
        string coverage = status == "incomplete" || status == "ambiguous" || (status == "resolved" && prefixSelected) ? "partial" : "complete";
        var result = new Dictionary<string, object> {
            { "status", status }, { "step", Math.Min(stepIndex, path.Count - 1) }, { "element", element }, { "candidates", candidates }, { "trace", trace },
            { "coverage", new Dictionary<string, object> { { "status", coverage }, { "reason", reason ?? (prefixSelected ? "explicit_nth_prefix" : null) }, { "scope", "locator_steps" }, { "unrealized_items_traversed", false } } },
            { "consistency", new Dictionary<string, object> { { "mode", "live" }, { "source_atomic", false } } },
            { "visited_nodes", budget.Visited }, { "native_calls", NativeCalls }, { "elapsed_ms", clock.ElapsedMilliseconds }, { "worker_generation", Generation },
            { "window", new Dictionary<string, object> { { "handle", window.Hwnd.ToInt64().ToString() }, { "processId", (int)window.Pid }, { "title", window.Title } } }
        };
        if (Encoding.UTF8.GetByteCount(Json.Serialize(result)) > bytesLimit) throw new InvalidOperationException("locator result exceeds byte budget");
        return result;
    }
}
