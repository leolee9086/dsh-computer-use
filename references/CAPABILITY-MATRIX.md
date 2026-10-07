# Computer-use 扩展基线与验收矩阵

接口研究日期：2026-10-04；最新实现与验收：2026-10-07，版本 0.5.3。这里比较可调用接口与可复现行为；接口覆盖不等于任务成功率排名。完整记录见 [EVIDENCE.md](../EVIDENCE.md)。

| 路径 | 成熟参考接口 | 本轮交付 | 已有证据及范围 |
| --- | --- | --- | --- |
| 视觉/输入 | Anthropic screenshot/zoom、move、modifier、down/up、hold、repeat；OpenAI path drag、scroll、键盘 | 保留多屏/裁剪/缩放/匹配，新增悬停、modifier/hold/repeat、路径拖动和有界输入序列 | 坐标/预校验/持续时间/步数合同；真实 Ctrl+A 与 Unicode、keyDown/mouseDown 正常结束释放、失焦停止并释放。每种路径/键布局的事件结果尚未逐项实测。 |
| Win32 窗口 | PrintWindow、子 HWND 与客户区坐标 | 显式后台渲染、身份检查的子窗口目录、限定定向点击/滚轮，窗口管理及最小化状态 | 完全遮挡下目标像素正确；非聚焦 Panel 消息保持前台，Button 消息实际使应用激活并报告变化；PID 拒绝、resize、最小化后新列表与恢复已测。 |
| Windows UIA | Microsoft Control Patterns、TextPattern、CacheRequest、ItemContainer/VirtualizedItem | 默认采集并完整复读有界范围后封存固定结果集，支持分支/续页/原生查询、按需读取、原生引用动作及可终止工作进程；live 显式选择 | 10,020 节点封存成 31 页，同一结果 ID/摘要，源 UI 改名/插删/重排后续页原生采集零调用；未交付代次遇到静默变化或属性事件即丢弃。已有分支/查询/屏幕外 invoke/虚拟化/阻塞恢复及 WPF 动作回归通过。grid、特殊 scroll/window/transform pattern 仍待逐项原生验收。 |
| Windows MSAA | IAccessible、AccessibleObjectFromWindow、AccessibleChildren | 独立 msaa 固定结果分页/查询/读取/默认动作/值/选择，注册引用、HWND/PID/结构版本/身份复核和隔离进程 | 10,001 节点封存成 31 页，同一结果 ID/摘要；等节点数静默重排及改名的未交付代次被丢弃，封存后保留旧行。原生查询、阻塞恢复和 WinForms 动作回归通过；没有同属性替换代际保证或所有动作的前台保持结论。 |
| 源 UI 全树原子性 | 提供者事务或可靠的全树版本快照 | 尚未实现；能力字段 semanticSourceAtomic:false，结果 source_atomic:false | 两遍相符读取和事件校验只能支持上述验证与封存机制，不能证明全部字段在源程序的同一瞬间同时存在。 |
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

大树覆盖明确返回 complete/partial/unknown，与 collecting/validating/frozen 一致性阶段分开。默认模式在第一页交付前验证覆盖范围的全部节点，包括查询未命中节点；封存续页只读不可变行。采集中检测到变化会丢弃未交付代次。live 续页读取活树，结构事件和有界导航锚点不保证页间一致性。两种模式都没有源 UI 全树事务保证，固定结果集不能代替源程序某一瞬间的原子状态。预算或未实例化的虚拟节点不能证明全局不存在；动作仍通过原生引用复核当前目标。固定结果首屏需收集/验证整个有界范围，代价单独测量；历史 live 性能对照和本轮样本不代表所有应用的提速或任务成功率。

跨工具长期保持输入可能遗留系统状态，因此 down/move/up 在一条有界序列中执行，预校验整条请求，首错停止。正常结束和处理到的错误释放该次取得的输入；强制终止/crash 不能保证析构运行。序列不是可回滚事务，已经投递的事件无法撤销。

后台渲染取决于应用配合 PrintWindow。最小化窗口明确拒绝，GPU/保护窗口可能失败或为空白，不静默提窗回退。定向消息也可能按应用逻辑激活窗口，投递成功仍需读取结果。语义 focus、文本选择同样可能改变键盘焦点或前台。

讲述人命令投递、虚拟光标、UIA 焦点和语音分别描述。未采集语音或虚拟光标，不能将命令的 inputDelivered 标记解释为读屏结果。
