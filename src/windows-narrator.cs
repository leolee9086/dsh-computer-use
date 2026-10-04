// 讲述人状态查询只读，不启动进程、不读取或改变系统讲述人设置。
using System;
using System.Diagnostics;
using System.Collections.Generic;
using System.Threading.Tasks;
public class Startup
{
    public Task<object> Invoke(dynamic input)
    {
        if ((string)input.kind != "status") throw new InvalidOperationException("Unsupported Narrator status operation");
        int session;
        using (var current = Process.GetCurrentProcess()) session = current.SessionId;
        var ids = new List<int>();
        foreach (var process in Process.GetProcessesByName("Narrator"))
        {
            using (process)
            {
                // 其它 Windows 登录会话中的进程不能证明当前桌面的讲述人已运行。
                try { if (process.SessionId == session) ids.Add(process.Id); }
                catch (InvalidOperationException) { /* 查询期间已退出的进程不再是运行证据。 */ }
            }
        }
        object result = new {
            running = ids.Count > 0,
            processIds = ids.ToArray(),
            windowsSessionId = session,
            keyboardLayout = "unknown; commands assume Microsoft Standard layout",
            virtualCursorObserved = false,
            speechCaptured = false
        };
        return Task.FromResult(result);
    }
}
