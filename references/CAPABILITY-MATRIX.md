# Computer-use 扩展基线与验收矩阵

接口研究日期：2026-10-04；最新实现与验收：2026-10-07，版本 0.5.2。这里比较可调用接口与可复现行为；接口覆盖不等于任务成功率排名。完整记录见 [EVIDENCE.md](../EVIDENCE.md)。

| 路径 | 成熟参考接口 | 本轮交付 | 已有证据及范围 |
| --- | --- | --- | --- |
| 视觉/输入 | Anthropic screenshot/zoom、move、modifier、down/up、hold、repeat；OpenAI path drag、scroll、键盘 | 保留多屏/裁剪/缩放/匹配，新增悬停、modifier/hold/repeat、路径拖动和有界输入序列 | 坐标/预校验/持续时间/步数合同；真实 Ctrl+A 与 Unicode、keyDown/mouseDown 正常结束释放、失焦停止并释放。每种路径/键布局的事件结果尚未逐项实测。 |
| Win32 窗口 | PrintWindow、子 HWND 与客户区坐标 | 显式后台渲染、身份检查的子窗口目录、限定定向点击/滚轮，窗口管理及最小化状态 | 完全遮挡下目标像素正确；非聚焦 Panel 消息保持前台，Button 消息实际使应用激活并报告变化；PID 拒绝、resize、最小化后新列表与恢复已测。 |
| Windows UIA | Microsoft Control Patterns、TextPattern、CacheRequest、ItemContainer/VirtualizedItem | 独立概览/分支/续页/原生查询，按需内容读取，直接原生引用动作与可终止工作进程 | 万节点分页、深分支、精确查询、屏幕外 invoke、虚拟化显式操作、结构失效、阻塞终止恢复通过；WPF 文档/选择/Value/slider/多选/invoke 已实测。grid、特殊 scroll/window/transform pattern 仍待逐项原生验收。 |
| Windows MSAA | IAccessible、AccessibleObjectFromWindow、AccessibleChildren | 独立 msaa 续页/查询/读取/默认动作/值/选择，注册引用、HWND/PID/结构版本/身份复核和隔离进程 | 万节点分页、原生查询、结构失效和阻塞终止恢复通过；WinForms 读取、值写入、默认动作、PID 拒绝已实测；没有同属性替换代际保证或所有动作的前台保持结论。 |
| Windows 讲述人 | Microsoft Standard：Insert/CapsLock modifier、item/view、scan、阅读 | 同登录会话状态、固定命令，独立窗口证据键盘与 UIA/MSAA 阅读协作 | 只读状态 C# 桥实测，命令/审批/会话证据合同通过；没有启动读屏器验收语音或虚拟光标，结果明确未验证。 |
| 跨平台 | macOS AX、Linux AT-SPI 与系统输入 | 焦点树、快照内查找与内容读取，落实每次节点/深度/时间预算；原生分支/续页/查询及 Windows 扩展明确拒绝 | 提供者预算与拒绝合同、Linux Python 纯读取/身份边界通过；两种系统的原生桌面尚未实测。 |

## 已读取的官方来源

- [Anthropic computer use](https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool)：本次官方页面的 17 member tools；mouse_move、left_mouse_down/up、modifier click/scroll/drag、hold_key 和 key repeat。批次按序执行，首错停止，截图坐标需要映射。
- [OpenAI SDK 计算机动作类型](https://github.com/openai/openai-python/blob/main/src/openai/types/responses/response_computer_tool_call.py)：click/double_click/drag/path/keypress/move/screenshot/scroll/type/wait，以及 pointer 动作的 keys。接口源码不能证明模型的整体任务胜率。
- [Microsoft UIA control patterns](https://learn.microsoft.com/en-us/dotnet/framework/ui-automation/ui-automation-control-patterns-overview)。
- [Microsoft UIA TextPattern](https://learn.microsoft.com/en-us/dotnet/framework/ui-automation/ui-automation-textpattern-overview)。
- [Microsoft MSAA 与 UIA 比较](https://learn.microsoft.com/en-us/windows/win32/winauto/microsoft-active-accessibility-and-ui-automation-compared)：两条 API 的树与属性不同，需独立实现。
- [Microsoft Narrator commands](https://support.microsoft.com/en-us/accessibility/windows/narrator/appendix-b-narrator-keyboard-commands-and-touch-gestures)：Insert/CapsLock modifier；Standard 与 Legacy 的独立表。本版本固定采用 Standard，不能从进程状态推断实际设置。
- [Microsoft UFO controller](https://github.com/microsoft/UFO/blob/main/ufo/automator/ui_control/controller.py)：参考 Windows agent 的控件封装与后端分层；没有复制其代码。

## 设计与验证边界

无障碍快照不要求图像输入能力，可从焦点应用或 Windows 有效窗口 ID 独立获取。选择绑定截图时必须保留那张图的 ID 与 SHA-256。按控件能力、已有证据和实际可靠性选择操作路径。控制使受影响的图像/语义状态失效；窗口/子 HWND 身份记录可在时效内复用并在使用时复核。明确未开始的失败保留观测，未知结果不自动重试；纯读取不消耗。后端不会静默切换目标或操作范式。

大树覆盖明确返回 complete/partial/unknown，预算或未实例化的虚拟节点不能证明全局不存在。续页推进已有遍历状态，动作通过原生引用直接访问已观测目标。结构事件和有界导航锚点无法让动态树成为原子快照，不能检测所有未报告的变化。性能对照使用同一受控原生提供者的实际属性/模式/导航调用量和响应字节；它不代表所有应用的提速或任务成功率。

跨工具长期保持输入可能遗留系统状态，因此 down/move/up 在一条有界序列中执行，预校验整条请求，首错停止。正常结束和处理到的错误释放该次取得的输入；强制终止/crash 不能保证析构运行。序列不是可回滚事务，已经投递的事件无法撤销。

后台渲染取决于应用配合 PrintWindow。最小化窗口明确拒绝，GPU/保护窗口可能失败或为空白，不静默提窗回退。定向消息也可能按应用逻辑激活窗口，投递成功仍需读取结果。语义 focus、文本选择同样可能改变键盘焦点或前台。

讲述人命令投递、虚拟光标、UIA 焦点和语音分别描述。未采集语音或虚拟光标，不能将命令的 inputDelivered 标记解释为读屏结果。
