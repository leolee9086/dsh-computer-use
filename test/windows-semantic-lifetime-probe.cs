// 仅编入测试入口：调用生产采集/续页代码，用真实慢提供者越过代次时效。
// 移动本进程私有的代次起点，不更改系统时钟、不缩短生产120秒常量。
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Reflection;

internal static class SnapshotLifetimeFixture {
    [MTAThread] public static void Main(string[] args) {
        try { SemanticWorker.ProbeSnapshotLifetime(args[0], args[1]); }
        catch (Exception error) { Console.Error.WriteLine(error.GetType().FullName + ": " + error.Message); Environment.ExitCode = 1; }
    }
}
internal static partial class SemanticWorker {
    static void AgeProbe(SnapshotCapture capture, bool frozen, int remainingMs) {
        long elapsedMs = LifetimeMs - remainingMs;
        // 兼容补修前的wall-clock实现，使同一测试能证明旧代码漏掉分段内到期。
        if (frozen) capture.Finished = DateTime.UtcNow.AddMinutes(10);
        else capture.Started = DateTime.UtcNow.AddMilliseconds(-elapsedMs);
        var stamp = typeof(SnapshotCapture).GetField(frozen ? "FinishedTick" : "StartedTick");
        if (stamp != null) stamp.SetValue(capture, Stopwatch.GetTimestamp() - elapsedMs * Stopwatch.Frequency / 1000);
    }
    static void ExpectProbeExpired(Dictionary<string, object> args, string owner, string resultId) {
        bool rejected = false;
        try { AcquireSnapshot(args, owner); }
        catch (InvalidOperationException error) {
            if (!error.Message.StartsWith("cursor_stale:")) throw;
            rejected = true;
        }
        if (!rejected) throw new InvalidOperationException("expired capture/result was delivered instead of discarded");
        if (Snapshots.ContainsKey(resultId)) throw new InvalidOperationException("expired generation retained");
        foreach (var saved in Elements.Values)
            if (saved.Owner == owner) throw new InvalidOperationException("expired generation kept action references");
    }
    internal static void ProbeSnapshotLifetime(string hwnd, string backend) {
        StartLegacyEvents(); string owner = "lifetime-probe-" + backend;
        var args = new Dictionary<string, object> { { "hwnd", hwnd }, { "backend", backend },
            { "maxNodes", 1 }, { "maxDepth", 2 }, { "maxBytes", 1000000 }, { "budgetMs", 10000 } };
        var progress = (Dictionary<string, object>)AcquireSnapshot(args, owner);
        if (((List<object>)progress["elements"]).Count != 0) throw new InvalidOperationException("unsealed capture published elements");
        string resultId = (string)progress["result_id"];
        AgeProbe(Snapshots[resultId], false, 1000);
        args["cursor"] = progress["next_cursor"]; args["maxNodes"] = 20000;
        // 节点12的真实属性读取阻塞1200ms；入口尚有1000ms，分段内越过期限。
        ExpectProbeExpired(args, owner, resultId);
        ExpectProbeExpired(args, owner, resultId); // 原游标不能复活被丢弃的代次。
        args.Remove("cursor"); args["maxNodes"] = 1;
        var healthy = (Dictionary<string, object>)AcquireSnapshot(args, owner);
        DropSnapshot(Snapshots[(string)healthy["result_id"]]); // 到期不必杀掉可用的工作进程。

        args["maxNodes"] = 20000; args["maxResults"] = 1;
        var sealedPage = (Dictionary<string, object>)AcquireSnapshot(args, owner);
        var consistency = (Dictionary<string, object>)sealedPage["consistency"];
        if ((string)consistency["status"] != "frozen" || sealedPage["next_cursor"] == null)
            throw new InvalidOperationException("expected a frozen first page with continuation");
        resultId = (string)sealedPage["result_id"];
        // 已过期的单调时钟不能被未来的展示时间戳延长；不改机器时钟。
        AgeProbe(Snapshots[resultId], true, -1);
        args["cursor"] = sealedPage["next_cursor"];
        ExpectProbeExpired(args, owner, resultId);
        ExpectProbeExpired(args, owner, resultId);
        Console.WriteLine(Json.Serialize(new Dictionary<string, object> { { "backend", backend },
            { "during_capture_expiry", "passed" }, { "expired_cursor_reuse", "rejected" },
            { "expired_references", "removed" }, { "monotonic_frozen_expiry", "passed" },
            { "healthy_after_expiry", "passed" }, { "production_lifetime_ms", LifetimeMs } }));
    }
}
