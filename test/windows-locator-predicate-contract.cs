// 直接反射生产编译产物中的纯 matcher，不复制匹配实现，也不伪造 UIA 服务。
// 字典只模拟提供者暴露/未暴露的属性，用来检查 NOT、未知值和正则的错误边界。
using System;
using System.Collections.Generic;
using System.Reflection;
using System.Diagnostics;

public class LocatorPredicateContracts {
    static Type Matcher; static MethodInfo Compile, Matches; static int Checks;
    static Dictionary<string, object> D(params object[] pairs) {
        var value = new Dictionary<string, object>();
        for (int i = 0; i < pairs.Length; i += 2) value.Add((string)pairs[i], pairs[i + 1]);
        return value;
    }
    static object Build(Dictionary<string, object> query, string backend = "uia") {
        query["includeOffscreen"] = true; query["includeDisabled"] = true;
        try { return Compile.Invoke(null, new object[] { query, backend }); }
        catch (TargetInvocationException error) { throw error.InnerException; }
    }
    static bool Match(object matcher, Dictionary<string, object> node) {
        try { return (bool)Matches.Invoke(matcher, new object[] { node }); }
        catch (TargetInvocationException error) { throw error.InnerException; }
    }
    static void Check(bool condition) { if (!condition) throw new Exception("predicate contract failed at check " + (Checks + 1)); Checks++; }
    static void Error(Action run, string expected) {
        try { run(); } catch (Exception error) { Check(error.Message.Contains(expected)); return; }
        throw new Exception("predicate contract expected error: " + expected);
    }
    public static void Main(string[] args) {
        var production = Assembly.LoadFrom(args[0]);
        Matcher = production.GetType("SemanticWorker", true).GetNestedType("LocatorMatcher", BindingFlags.NonPublic);
        Compile = Matcher.GetMethod("Compile", BindingFlags.Public | BindingFlags.Static);
        Matches = Matcher.GetMethod("Matches", BindingFlags.Public | BindingFlags.Instance);
        var apply = D("name", "Apply", "role", "Button", "automation_id", "apply", "framework_id", "WPF");
        Check(Match(Build(D("name", "apply")), apply));
        Check(!Match(Build(D("name", "app")), apply));
        Check(Match(Build(D("name", "app", "match", "contains")), apply));
        Check(Match(Build(D("name", "\\A(?<word>apply)\\z", "match", "regex")), apply));
        Check(!Match(Build(D("name", "\\A(?-i:apply)\\z", "match", "regex")), apply));
        Check(Match(Build(D("name", "\\A\\p{L}+\\z", "match", "regex")), D("name", "显示")));
        var overlap = D("any", new object[] { D("name", "Apply"), D("automationId", "apply") });
        Check(Match(Build(D("role", "Button", "where", overlap)), apply));
        Check(!Match(Build(D("role", "Edit", "where", overlap)), apply));
        var not = D("not", D("frameworkId", "WinForm"));
        Check(Match(Build(D("where", D("all", new object[] { overlap, not }))), apply));
        Check(!Match(Build(D("where", D("not", overlap))), apply));
        Check(Match(Build(D("where", D("not", D("not", overlap)))), apply));
        // 缺失或null应传播未知；最终未知直接错误，不能作为 complete absence。
        var missing = Build(D("where", D("not", D("frameworkId", "WPF"))));
        Error(() => Match(missing, D("name", "Apply")), "locator_property_unavailable");
        Error(() => Match(missing, D("framework_id", null)), "locator_property_unavailable");
        Check(Match(Build(D("name", "\\A\\z", "match", "regex")), D("name", "")));
        Check(Match(Build(D("where", D("any", new object[] { D("name", "Apply"), not }))), D("name", "Apply")));
        Check(!Match(Build(D("where", D("all", new object[] { D("name", "Other"), not }))), D("name", "Apply")));
        Error(() => Build(D("where", D("any", new object[] { D("name", "Apply"), D("name", "[", "match", "regex") }))), "locator_regex_invalid");
        Error(() => Build(D("where", D("any", new object[] { D("name", "Apply"), not })), "msaa"), "MSAA does not expose framework_id");
        Error(() => Build(D("where", D("not", D("automationId", "apply"))), "msaa"), "MSAA does not expose automation_id");
        Error(() => Build(D("where", D("any", new object[0]))), "1..16");
        Error(() => Build(D("where", D("not", D("name", "Apply"), "role", "Button"))), "exactly one");
        Error(() => Build(D("where", D("not", D("not", D("not", D("not", D("name", "Apply"))))))), "depth 4");
        Error(() => Match(Build(D("name", ".*", "match", "regex")), D("name", new string('a', 16001))), "locator_regex_input_limit");
        var clock = Stopwatch.StartNew();
        Error(() => Match(Build(D("name", "(a+)+$", "match", "regex")), D("name", new string('a', 12000) + "!")), "locator_regex_timeout");
        long timeoutMs = clock.ElapsedMilliseconds;
        Console.WriteLine("{\"production_matcher\":\"passed\",\"checks\":" + Checks + ",\"regex_timeout_elapsed_ms\":" + timeoutMs + "}");
    }
}
