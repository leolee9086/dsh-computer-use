// 仅用于受控性能对照：把改前采集算法放在独立 .NET 进程中，
// 避免依赖测试 Node/Electron 的 edge 原生 ABI。不可用作生产回退。
using System;
using System.Collections.Generic;
using System.Dynamic;
using System.Web.Script.Serialization;

public class LegacyBaseline
{
    [MTAThread] public static void Main() {
        var json = new JavaScriptSerializer { MaxJsonLength = 16000000 };
        string line;
        while ((line = Console.ReadLine()) != null) {
            var values = json.Deserialize<Dictionary<string, object>>(line);
            dynamic input = new ExpandoObject();
            foreach (var pair in values) ((IDictionary<string, object>)input)[pair.Key] = pair.Value;
            Console.WriteLine(json.Serialize(new Startup().Invoke(input).GetAwaiter().GetResult()));
            Console.Out.Flush();
        }
    }
}
