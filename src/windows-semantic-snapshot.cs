// 固定结果集：先收集并完整复读所覆盖的节点，校验成功后才允许交付第一页。
// 这保证所有页来自同一份不可变结果；不冒充 UIA/MSAA 没有提供的全树事务。
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Windows.Automation;

internal static partial class SemanticWorker
{
    const int SnapshotLimit = 4;
    const int SnapshotNodeLimit = 20000;
    const long SnapshotByteLimit = 32000000;
    const long SnapshotPoolByteLimit = 64000000;
    static readonly Dictionary<string, SnapshotCapture> Snapshots = new Dictionary<string, SnapshotCapture>();
    static readonly Dictionary<string, SnapshotContinuation> SnapshotCursors = new Dictionary<string, SnapshotContinuation>();

    sealed class SnapshotChangedException : InvalidOperationException {
        public readonly Window ObservedWindow;
        public SnapshotChangedException(Window window, string reason) : base(reason) { ObservedWindow = window; }
    }
    static Dictionary<string, object> SnapshotDescribe(SnapshotCapture capture, Target target) {
        if (capture.Query == null) return Describe(target);
        // 沿用UIA查询缓存：未命中项保留决定匹配的字段和树顺序，仍完整复读。
        // 名称/角色/状态变化影响查询结果；只有命中项才取并校验完整摘要/模式。
        var fields = QueryFields(target, target == capture.Root);
        if (Match(fields, capture.Query)) {
            var summary = Describe(target);
            if (!Match(summary, capture.Query)) throw new SnapshotChangedException(capture.Window, "snapshot_changed: query changed while fetching matched summary");
            return summary;
        }
        fields["element_id"] = target.Id; fields["backend"] = target.Window.Backend;
        return fields;
    }
    sealed class SnapshotEvidence {
        public string Id; public byte[] Fingerprint;
    }
    sealed class SnapshotRow {
        public Target Target; public Dictionary<string, object> Node; public int Bytes;
    }
    sealed class SnapshotCapture {
        public string Id = Guid.NewGuid().ToString("N"), Owner, Signature, Scope, Stage = "collecting", Reason, Digest;
        public Window Window; public Target Root; public int Version, StructureVersion, Depth, CheckIndex, MatchLimit;
        public Dictionary<string, object> Query;
        public Stack<Frame> Stack = new Stack<Frame>();
        public List<SnapshotEvidence> Evidence = new List<SnapshotEvidence>();
        public List<SnapshotRow> Rows = new List<SnapshotRow>();
        public HashSet<string> Seen = new HashSet<string>();
        public DateTime Started = DateTime.UtcNow, Finished;
        // 展示时间使用UTC；时效及淘汰顺序使用单调时钟，系统校时不会延长代次。
        public long StartedTick = Stopwatch.GetTimestamp(), FinishedTick, TouchedTick = Stopwatch.GetTimestamp();
        public long Bytes; public bool DepthLimited, PrefixOnly;
    }
    sealed class SnapshotContinuation {
        public SnapshotCapture Capture; public int Offset;
    }
    static void DropSnapshot(SnapshotCapture capture) {
        Snapshots.Remove(capture.Id);
        var oldCursors = new List<string>();
        foreach (var entry in SnapshotCursors) if (entry.Value.Capture == capture) oldCursors.Add(entry.Key);
        foreach (var cursor in oldCursors) SnapshotCursors.Remove(cursor);
        // 未交付的采集失败没有注册引用。已封存代次被淘汰时同时释放它自己的引用。
        foreach (var row in capture.Rows) {
            string token = Text(row.Node, "native_token"); if (token.Length > 0) Elements.Remove(token);
        }
    }
    static bool SnapshotExpired(SnapshotCapture capture, long now) {
        long start = capture.Stage == "frozen" ? capture.FinishedTick : capture.StartedTick;
        return (now - start) * 1000.0 / Stopwatch.Frequency >= LifetimeMs;
    }
    static long SnapshotAlive(SnapshotCapture capture) {
        long now = Stopwatch.GetTimestamp();
        if (SnapshotExpired(capture, now))
            throw new InvalidOperationException("cursor_stale: snapshot lifetime exceeded; retained generation discarded");
        return now;
    }
    static void SweepSnapshots() {
        var old = new List<SnapshotCapture>(); long now = Stopwatch.GetTimestamp();
        foreach (var capture in Snapshots.Values) if (SnapshotExpired(capture, now)) old.Add(capture);
        foreach (var capture in old) DropSnapshot(capture);
    }
    static void ReserveSnapshot(SnapshotCapture keep, long addition) {
        if (keep.Bytes + addition > SnapshotByteLimit) throw new InvalidOperationException("snapshot retention byte limit exceeded");
        while (true) {
            long total = addition; SnapshotCapture oldest = null;
            foreach (var capture in Snapshots.Values) {
                total += capture.Bytes;
                if (capture != keep && (oldest == null || capture.TouchedTick < oldest.TouchedTick)) oldest = capture;
            }
            if (total <= SnapshotPoolByteLimit) return;
            if (oldest == null) throw new InvalidOperationException("snapshot pool byte limit exceeded");
            DropSnapshot(oldest);
        }
    }
    static void SnapshotUnchanged(SnapshotCapture capture) {
        SnapshotAlive(capture);
        ValidateWindow(capture.Window);
        if (capture.Version != Thread.VolatileRead(ref capture.Window.SnapshotVersion))
            throw new SnapshotChangedException(capture.Window, "snapshot_changed: source changed while collecting or validating; unpublished result discarded");
        // 原生读取或窗口复核可能跨过期限，不能只依赖分段入口的清理。
        SnapshotAlive(capture);
    }
    static void StartSnapshotPass(SnapshotCapture capture) {
        capture.Root.SummaryCached = false;
        capture.Stack.Clear(); capture.Seen.Clear();
        capture.Stack.Push(new Frame { Node = capture.Root, Depth = 0, Entered = capture.Scope == "children" });
    }
    static byte[] SnapshotFingerprint(Dictionary<string, object> node) {
        using (var hash = SHA256.Create()) return hash.ComputeHash(Encoding.UTF8.GetBytes(Json.Serialize(node)));
    }
    static bool SameFingerprint(byte[] a, byte[] b) {
        if (a.Length != b.Length) return false;
        for (int index = 0; index < a.Length; index++) if (a[index] != b[index]) return false;
        return true;
    }
    static void FinishSnapshotCollection(SnapshotCapture capture) {
        capture.Stage = "validating"; capture.CheckIndex = 0; StartSnapshotPass(capture);
    }
    static void SealSnapshot(SnapshotCapture capture) {
        SnapshotUnchanged(capture);
        // 摘要包含所有已检查节点（查询未命中的节点也包含），而不是只签名命中项。
        using (var hash = SHA256.Create()) {
            foreach (var evidence in capture.Evidence) hash.TransformBlock(evidence.Fingerprint, 0, evidence.Fingerprint.Length, null, 0);
            hash.TransformFinalBlock(new byte[0], 0, 0);
            capture.Digest = BitConverter.ToString(hash.Hash).Replace("-", "").ToLowerInvariant();
        }
        foreach (var row in capture.Rows) {
            Save(row.Target, row.Node, capture.Owner);
            // 延迟事件可能落在 Save 之间。引用必须使用采集代次，不能继承后来版本。
            Elements[Text(row.Node, "native_token")].Version = capture.StructureVersion;
            row.Bytes = Encoding.UTF8.GetByteCount(Json.Serialize(row.Node)) + 1;
        }
        SnapshotUnchanged(capture);
        capture.FinishedTick = SnapshotAlive(capture);
        capture.Finished = DateTime.UtcNow; capture.Stage = "frozen"; capture.Stack.Clear(); capture.Seen.Clear();
        // 复读日志到这里已完成其职责。保留摘要及计数，释放每个节点的验证数据。
        capture.CheckIndex = capture.Evidence.Count; capture.Evidence.Clear();
    }
    static object SnapshotResult(SnapshotCapture capture, int offset, int maxRows, int maxBytes, Stopwatch clock, int visited, int validated) {
        SnapshotAlive(capture);
        var rows = new List<object>(); int bytes = 2048 + Encoding.UTF8.GetByteCount(Json.Serialize(capture.Window.Title));
        bool frozen = capture.Stage == "frozen"; int nextOffset = offset;
        if (frozen) {
            while (nextOffset < capture.Rows.Count && rows.Count < maxRows) {
                var row = capture.Rows[nextOffset];
                if (bytes + row.Bytes > maxBytes) {
                    if (rows.Count == 0) throw new InvalidOperationException("snapshot row exceeds maxAccessibilityBytes; increase the output budget or narrow the captured branch");
                    break;
                }
                rows.Add(row.Node); bytes += row.Bytes; nextOffset++;
            }
        }
        SnapshotAlive(capture);
        string cursor = null;
        if (!frozen || nextOffset < capture.Rows.Count) {
            cursor = Guid.NewGuid().ToString("N");
            SnapshotCursors[cursor] = new SnapshotContinuation { Capture = capture, Offset = nextOffset };
        }
        string reason = !frozen ? "capture_in_progress" : nextOffset < capture.Rows.Count ? "page_limit" : capture.Reason;
        bool complete = frozen && nextOffset == capture.Rows.Count && capture.Reason == null;
        return new Dictionary<string, object> {
            { "backend", capture.Window.Backend }, { "elements", rows }, { "next_cursor", cursor }, { "result_id", capture.Id },
            { "coverage", new Dictionary<string, object> { { "status", !frozen ? "unknown" : complete ? "complete" : "partial" },
                { "reason", reason }, { "scope", capture.Scope }, { "max_depth", capture.Depth },
                { "source_status", capture.Reason == null ? (frozen ? "complete" : "unknown") : "partial" }, { "source_reason", capture.Reason },
                { "virtualized_items", "unrealized items are not traversed; use item_container/realize explicitly" } } },
            { "consistency", new Dictionary<string, object> { { "mode", "snapshot" }, { "status", capture.Stage },
                { "result_id", capture.Id }, { "sha256", capture.Digest }, { "source_atomic", false },
                { "validation", capture.Query == null ? "two agreeing bounded summary reads plus change events" : "two agreeing bounded reads of query fields and matched summaries plus change events" },
                { "capture_started_at", new DateTimeOffset(capture.Started).ToUnixTimeMilliseconds() },
                { "capture_finished_at", frozen ? (object)new DateTimeOffset(capture.Finished).ToUnixTimeMilliseconds() : null },
                { "captured_nodes", frozen ? capture.CheckIndex : capture.Evidence.Count }, { "retained_rows", capture.Rows.Count } } },
            { "visited_nodes", visited }, { "validated_nodes", validated }, { "returned_nodes", rows.Count }, { "elapsed_ms", clock.ElapsedMilliseconds },
            { "native_calls", NativeCalls }, { "worker_generation", Generation },
            { "window", new Dictionary<string, object> { { "handle", capture.Window.Hwnd.ToInt64().ToString() }, { "processId", (int)capture.Window.Pid }, { "title", capture.Window.Title } } }
        };
    }
    // JSON整数必须原样校验；Convert.ToInt32会把小数舍入，不能用于匹配上限。
    static int SnapshotMatchLimit(IDictionary<string, object> args) {
        object value;
        if (!args.TryGetValue("query", out value) || value == null) return 0;
        var query = value as Dictionary<string, object>;
        if (query == null) throw new InvalidOperationException("query must be an object");
        if (!query.TryGetValue("maxMatches", out value)) return 0;
        if (!(value is int || value is long) || Convert.ToInt64(value) < 1 || Convert.ToInt64(value) > 20000)
            throw new InvalidOperationException("query maxMatches must be 1..20000");
        return Convert.ToInt32(value);
    }
    static object AcquireSnapshot(IDictionary<string, object> args, string owner) {
        int matchLimit = SnapshotMatchLimit(args);
        SweepSnapshots();
        int maxNodes = Integer(args, "maxNodes", 300), depth = Integer(args, "maxDepth", 6);
        int maxBytes = Integer(args, "maxBytes", 1000000), maxRows = Integer(args, "maxResults", maxNodes), time = Integer(args, "budgetMs", 5000);
        if (maxNodes < 1 || maxNodes > 20000 || depth < 0 || depth > 128 || maxBytes < 4096 || maxBytes > 12000000 || maxRows < 1 || maxRows > 20000 || time < 1)
            throw new InvalidOperationException("semantic acquisition bounds invalid");
        var clock = Stopwatch.StartNew(); SnapshotCapture capture; int offset = 0;
        string previous = Text(args, "cursor");
        if (previous.Length > 0) {
            SnapshotContinuation continuation;
            if (!SnapshotCursors.TryGetValue(previous, out continuation) || continuation.Capture.Owner != owner)
                throw new InvalidOperationException("cursor_stale: snapshot cursor unavailable in this session");
            capture = continuation.Capture; offset = continuation.Offset;
            if (args.ContainsKey("signature") && Text(args, "signature") != capture.Signature) throw new InvalidOperationException("cursor query changed");
            if (Text(args, "backend", capture.Window.Backend) != capture.Window.Backend) throw new InvalidOperationException("cursor backend changed");
            if (matchLimit > 0 && matchLimit != capture.MatchLimit) throw new InvalidOperationException("cursor query maxMatches changed");
            SnapshotCursors.Remove(previous);
        } else {
            string backend = Text(args, "backend", "uia");
            if (backend != "uia" && backend != "msaa") throw new InvalidOperationException("backend invalid");
            var window = ResolveWindow(args, backend); Target root = window.Root;
            if (Text(args, "rootToken").Length > 0) {
                var saved = Lookup(args, "rootToken", owner); root = saved.Target;
                if (root.Window != window) throw new InvalidOperationException("subtree root belongs to another window");
            }
            while (Snapshots.Count >= SnapshotLimit) {
                SnapshotCapture oldest = null;
                foreach (var current in Snapshots.Values) if (oldest == null || current.TouchedTick < oldest.TouchedTick) oldest = current;
                DropSnapshot(oldest);
            }
            capture = new SnapshotCapture { Window = window, Root = root, Owner = owner, Signature = Text(args, "signature"),
                Scope = Text(args, "scope", "subtree"), Depth = depth, MatchLimit = matchLimit, Version = Thread.VolatileRead(ref window.SnapshotVersion), StructureVersion = window.Version };
            if (capture.Scope != "children" && capture.Scope != "subtree") throw new InvalidOperationException("scope invalid");
            if (capture.Scope == "children") capture.Depth = 1;
            if (args.ContainsKey("query")) capture.Query = (Dictionary<string, object>)args["query"];
            Snapshots[capture.Id] = capture; StartSnapshotPass(capture);
        }
        capture.TouchedTick = Stopwatch.GetTimestamp(); int visited = 0, validated = 0, spent = 0;
        try {
            while (capture.Stage != "frozen" && spent < maxNodes && clock.ElapsedMilliseconds < time) {
                SnapshotUnchanged(capture);
                if (capture.Stack.Count == 0) {
                    if (capture.Stage == "collecting") { FinishSnapshotCollection(capture); continue; }
                    if (capture.CheckIndex != capture.Evidence.Count) throw new SnapshotChangedException(capture.Window, "snapshot_changed: nodes disappeared before validation; unpublished result discarded");
                    SealSnapshot(capture); break;
                }
                if (capture.Stage == "validating" && capture.PrefixOnly && capture.CheckIndex == capture.Evidence.Count) { SealSnapshot(capture); break; }
                var frame = capture.Stack.Peek();
                if (!frame.Entered) {
                    if (capture.Stage == "collecting" && capture.Evidence.Count >= SnapshotNodeLimit) {
                        capture.Reason = "capture_node_limit"; capture.PrefixOnly = true; FinishSnapshotCollection(capture); continue;
                    }
                    var node = SnapshotDescribe(capture, frame.Node);
                    node["depth"] = frame.Depth;
                    if (capture.Stack.Count > 1) node["parent_id"] = capture.Stack.ToArray()[1].Node.Id;
                    if (frame.Depth >= capture.Depth) {
                        if (!frame.DepthChildPresent.HasValue) frame.DepthChildPresent = NextChild(frame, capture.Query == null) != null;
                        node["child_state"] = frame.DepthChildPresent.Value ? "present" : "none";
                        if (frame.DepthChildPresent.Value && capture.Scope != "children") { node["children_truncated"] = true; capture.DepthLimited = true; }
                    }
                    byte[] fingerprint = SnapshotFingerprint(node);
                    if (!capture.Seen.Add(frame.Node.Id)) throw new SnapshotChangedException(capture.Window, "snapshot_changed: duplicate element identity during traversal; unpublished result discarded");
                    SnapshotUnchanged(capture);
                    if (capture.Stage == "collecting") {
                        int rowBytes = Encoding.UTF8.GetByteCount(Json.Serialize(node));
                        long retained = 256 + Encoding.UTF8.GetByteCount(frame.Node.Id) + (Match(node, capture.Query) ? rowBytes + 256 : 0);
                        if (capture.Bytes + retained > SnapshotByteLimit) {
                            if (capture.Evidence.Count == 0) throw new InvalidOperationException("snapshot first node exceeds retention budget");
                            capture.Reason = "capture_byte_limit"; capture.PrefixOnly = true; FinishSnapshotCollection(capture); continue;
                        }
                        ReserveSnapshot(capture, retained); capture.Bytes += retained;
                        capture.Evidence.Add(new SnapshotEvidence { Id = frame.Node.Id, Fingerprint = fingerprint });
                        if (Match(node, capture.Query)) capture.Rows.Add(new SnapshotRow { Target = frame.Node, Node = node });
                        visited++;
                    } else {
                        if (capture.CheckIndex >= capture.Evidence.Count || capture.Evidence[capture.CheckIndex].Id != frame.Node.Id || !SameFingerprint(capture.Evidence[capture.CheckIndex].Fingerprint, fingerprint))
                            throw new SnapshotChangedException(capture.Window, "snapshot_changed: node fields or traversal order changed before validation; unpublished result discarded");
                        capture.CheckIndex++; validated++;
                    }
                    frame.Entered = true; spent++;
                    if (capture.Stage == "collecting" && capture.MatchLimit > 0 && capture.Rows.Count >= capture.MatchLimit) {
                        // 只封存已覆盖前缀：先复读全部命中与未命中项，不再导航未搜索的尾部。
                        capture.Reason = "match_limit"; capture.PrefixOnly = true; FinishSnapshotCollection(capture); continue;
                    }
                    if (capture.Stage == "validating" && capture.PrefixOnly && capture.CheckIndex == capture.Evidence.Count) {
                        SealSnapshot(capture); break;
                    }
                }
                if (frame.Depth >= capture.Depth) { capture.Stack.Pop(); continue; }
                var next = NextChild(frame, capture.Query == null);
                if (next == null) { capture.Stack.Pop(); continue; }
                capture.Stack.Push(new Frame { Node = next, Depth = frame.Depth + 1 });
            }
            if (capture.Stage != "frozen") SnapshotUnchanged(capture);
            // 完成最后一个节点后可能刚好命中每次节点预算，终结阶段仍只做内存操作。
            if (capture.Stage == "validating" && (capture.Stack.Count == 0 || capture.PrefixOnly && capture.CheckIndex == capture.Evidence.Count)) {
                if (capture.CheckIndex != capture.Evidence.Count) throw new SnapshotChangedException(capture.Window, "snapshot_changed: validation coverage changed");
                if (capture.DepthLimited && capture.Reason == null) capture.Reason = "depth_limit";
                SealSnapshot(capture);
            }
            if (capture.Stage == "frozen" && capture.DepthLimited && capture.Reason == null) capture.Reason = "depth_limit";
            return SnapshotResult(capture, offset, maxRows, maxBytes, clock, visited, validated);
        } catch (Exception error) {
            // 失败代次与续页一起删除；仅明确的采集变化可以从新代次安全重采。
            DropSnapshot(capture);
            if (error is ElementNotAvailableException || error is InvalidOperationException && error.Message.StartsWith("cursor_stale: MSAA child count changed"))
                throw new SnapshotChangedException(capture.Window, "snapshot_changed: element disappeared or child count changed; unpublished result discarded");
            throw;
        }
    }
}
