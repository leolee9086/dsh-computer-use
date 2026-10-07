# 成熟桌面自动化实现对照 — 2026-10-07

此次直接读取四个项目的实现，按它们实际处理控件定位、缓存、变化与截止的方式修正通用 UIA/MSAA 采集。参考的是机制，没有复制第三方源码；目标应用无需集成新的协议。

## 已读取的实现

| 项目与固定版本 | 实际机制 | 本次采用与区别 |
| --- | --- | --- |
| [pywinauto：uia_element_info.py](https://github.com/pywinauto/pywinauto/blob/18d2a95cebed2f0061ab4e4c80c3a76ece5dd4f3/pywinauto/windows/uia_element_info.py#L208)，[控件定位](https://github.com/pywinauto/pywinauto/blob/18d2a95cebed2f0061ab4e4c80c3a76ece5dd4f3/pywinauto/base_application.py#L264)，[wait_until_passes](https://github.com/pywinauto/pywinauto/blob/18d2a95cebed2f0061ab4e4c80c3a76ece5dd4f3/pywinauto/timings.py#L400) | 可选对象属性缓存；范围及条件查询；children/descendants 的遍历和深度限制；按指定异常在剩余时间内重新定位 | 查询未命中项只取决定匹配的字段。采集中明确发生变化时，重新定位新的只读采集代次，保留原工具截止。我们的有界 DFS 不一次取得任意大小的 descendants 数组 |
| [FlaUI：CacheRequest](https://github.com/FlaUI/FlaUI/blob/fd7cc64ab01908a0ae4cc7d05e704caa34f98d16/src/FlaUI.Core/CacheRequest.cs)，[UIA3 查询与缓存读取](https://github.com/FlaUI/FlaUI/blob/fd7cc64ab01908a0ae4cc7d05e704caa34f98d16/src/FlaUI.UIA3/UIA3FrameworkAutomationElement.cs#L70)，[Retry](https://github.com/FlaUI/FlaUI/blob/fd7cc64ab01908a0ae4cc7d05e704caa34f98d16/src/FlaUI.Core/Tools/Retry.cs#L39) | 活跃 CacheRequest 确定属性、模式和范围；FindFirst/All 根据缓存请求选择 BuildCache；Current/Cached 分开读取；有界条件重试 | TreeWalker 获取元素时缓存查询字段与 runtime ID，随后读缓存；仅命中项获取完整摘要。动作前仍读实时身份。通用 WhileException(Action) 能重放动作，我们不采用这一行为 |
| [AutoHotkey：ListView 读取](https://github.com/AutoHotkey/AutoHotkey/blob/47eabd4181679e1de5176a86dfe76fab19ff9f98/source/lib/win.cpp#L929) | 按 HWND 发送原生控件消息，先获取行列/选择数量，再有界获取内容；跨进程缓冲区与 SendMessageTimeout，读取循环检查容量并清理 | 这说明标准控件可以直接查询所需内容，不必先完整扫描语义树。本次 MSAA 查询未命中项跳过位置和默认动作 getter；没有新增 ListView 消息适配器，也不照搬将部分读取失败跳过的行为 |
| [Descolada UIA-v2：WaitElement](https://github.com/Descolada/UIA-v2/blob/2846a9b10518a95cf26a6c43671a9512b231ccb7/Lib/UIA.ahk#L3204)，[BuildCache](https://github.com/Descolada/UIA-v2/blob/2846a9b10518a95cf26a6c43671a9512b231ccb7/Lib/UIA.ahk#L3722) | 按条件及路径查找；WaitElement 使用 tick 截止循环调用 FindElement；BuildCache 与 Current/Cached 明确分开 | 采用缓存与有界重新定位机制。我们的恢复只针对尚未发布元素的采集变化，最多重新开始两次；空匹配仍返回空结果，不提供新的无限等待或 wait-for-match 参数 |

## 当前采集与恢复

无查询的概览继续复读覆盖范围内全部摘要。原生查询复读每个已覆盖节点的匹配字段与树顺序，包含未命中项；命中项另行采集并复读完整摘要、边界和模式可用性。决定匹配的名称、角色或状态变化仍会丢弃未交付代次。UIA runtime ID 随同元素缓存取得，避免导航后的重复跨进程读取；动作绑定仍使用当前 runtime ID。MSAA 未命中项读取名称、角色及状态，省去位置和默认动作访问。

变化错误携带原生窗口身份和 `COMPUTER_SNAPSHOT_CHANGED`。新观测在 `not_started`、同一 HWND/PID/标题、尚有剩余时间的条件下，最多重采两次，每次短暂让出时间后重新建立代次。分段、排队、启动及重采共用一次工具截止。`capture_restarts` 返回实际重采次数。资源/时效错误、取消、未知执行状态、显式采集游标和 live 观测不自动切换代次。动作没有重试路径。

封存后各页只读同一固定结果 ID/摘要下的保留行，不再次咨询提供者。采集游标已交付给调用方后，变化返回失败并丢弃旧代次；不能暗中换成另一份结果。动作继续复核当前原生目标，历史行不恢复控制证据。

## 可复现验收

`pnpm run smoke:recovery` 使用真实 UIA/MSAA 提供者：读取第13项时，静默改写先前读过的第12项，覆盖“未命中变成命中”的情况。一次变化应重采一次并返回新名称；持续变化应三次尝试后有界失败；已交付游标不得切换结果。有效控件执行一次动作，改名后旧引用被拒绝。稀疏查询与完整摘要采集比较相同覆盖范围的提供者读取量，并检查命中项的模式和边界仍齐全。实际测量见 [EVIDENCE.md](../EVIDENCE.md)。

这些机制解决正常桌面自动化的定位、变化恢复、固定分页与截止问题。缓存、重定位和固定分页各有明确作用；额外的源程序全树事务保证仍需来源自身的可靠接口，不能从上述机制推导。该区别由 [SOURCE-CONSISTENCY.md](SOURCE-CONSISTENCY.md) 的反例独立检查，不构成继续实现通用自动化的前置条件。
