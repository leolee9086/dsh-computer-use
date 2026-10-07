# dsh-computer-use

独立的 Cordis bundle，为 DeepSeek Harness 提供视觉、原生无障碍和 Windows 讲述人操作路径。0.5.2 注册 **18 个 `computer_*` 工具**；无障碍观测、阅读和语义动作可以独立使用，文本模型也能操作原生应用。

Windows 是经过本机运行时验证的主要后端。macOS AX、Linux AT-SPI 已实现并做契约测试，尚无这两个系统的原生运行时验收。接口覆盖与实测范围见 [EVIDENCE.md](EVIDENCE.md)；对标的官方接口见 [能力矩阵](references/CAPABILITY-MATRIX.md)。目前没有任务成功率基准，也没有 SOTA 等效结论。

## 操作路径

| 路径 | 工具 | 行为 |
| --- | --- | --- |
| 视觉 | `computer_screenshot`、`computer_find_image`、`computer_click_image` | 多显示器、区域/缩放、Windows 前台窗口捕获、显式后台 PrintWindow、模板匹配与唯一匹配点击。截图可返回图像附件或保存 PNG 后返回文件信息。 |
| 指针 | `computer_move`、`computer_click`、`computer_drag`、`computer_scroll` | 截图像素映射到实际捕获边界；Windows 支持三击、modifier、按住、带路径拖动。 |
| 键盘/序列 | `computer_key`、`computer_type`、`computer_input` | Windows 支持扩展键、Insert/CapsLock、重复/按住，以及一条有界 down/move/up 序列；纯键盘也接受窗口或绑定窗口的语义证据。 |
| 无障碍 | `computer_accessibility`、`computer_find`、`computer_read`、`computer_element` | 独立快照、元素查找、文本/选择/值/状态读取与控件模式操作。Windows UIA、MSAA 支持分页、分支展开和原生查询。 |
| 窗口 | `computer_windows`、`computer_window_input` | Windows 列出含最小化状态的顶层窗口，枚举子 HWND、管理窗口，或向已观测子窗口发送限定点击/滚轮消息。 |
| 讲述人 | `computer_narrator` | 只读进程状态；向已运行的讲述人发送固定 Microsoft Standard 布局命令。 |
| 能力 | `computer_status` | 返回平台能力和显示器几何。 |

根据控件能力、已有证据和实际可靠性选择视觉、无障碍、键盘、讲述人或窗口消息。查询的名称、角色可以来自任务目标或界面；窗口、元素和截图 ID 来自相应工具的真实观测。

## 独立无障碍与大树

1. 调用 `computer_windows(operation:"list")` 获得本会话的短期 `window_id`，也可直接观察当前焦点应用。有效窗口记录可以复用，执行前仍复核原生身份；过期、消失或身份变化时重新列出。
2. 调用 `computer_accessibility`。Windows 可以给 `window_id`；`backend:"native"` 默认 UIA，`backend:"msaa"` 使用独立的传统 IAccessible 实现。
3. 浏览一页、展开已观测分支，或用 `computer_find(source:"native")` 查询尚未采集的部分。
4. `computer_read` 按需读取有界内容；`computer_element` 使用控件实际暴露的 pattern 操作。屏幕外控件也按其能力及 enabled/readonly 等状态检查。
5. 验证相关结果。目标身份、几何或交互状态变化，或执行结果未知时，更新受影响的观测。

这条路径不需要图像能力。若快照选择绑定 `screenshot_id`，后续阅读/动作仍必须给同一份图像证据及 SHA-256。动作使相关截图/语义状态失效；窗口和子 HWND 的身份记录保留到其时效结束，并在使用时复核。确定 `not_started` 的失败保留观测，可能执行过的失败更新相关状态。

### 概览、分支与续页

获取默认是 summary：返回基本属性、边界、模式可用性和子节点覆盖情况，完整文档与模式状态由 `computer_read` 获取。每页默认最多 300 节点、深度 6、1 MB 原生响应、30 秒；`max_nodes`、`max_depth`、`timeout_ms` 可以逐次指定。`scope:"children"` 只浏览直属子节点，`scope:"subtree"` 浏览有界子树。

```json
{"window_id":"<已观测窗口ID>","max_nodes":100,"max_depth":2}
```

展开已观测分支时，使用包含该元素的快照：

```json
{"snapshot_id":"<分支所在快照ID>","root_element_id":"<已观测元素ID>","scope":"children","max_nodes":100}
```

返回的 `coverage` 标明 complete、partial 或 unknown 及原因。`next_cursor` 表示仍有遍历状态；用该页的 `snapshot_id` 续取：

```json
{"snapshot_id":"<上一页快照ID>","cursor":"<上一页next_cursor>","max_nodes":100}
```

原生遍历保留栈和兄弟位置，续页直接推进该位置。每页注册独立快照，不向结果拼接整棵树。游标绑定会话、窗口、后端、工作进程代次、结构版本、查询及深度/scope/detail/截图绑定；改变这些条件时开始新获取。命中节点、字节、时间或深度预算时，部分覆盖不能证明全树不存在目标。深度之外的分支需要显式展开或增加深度。

动态界面的多页结果不是原子快照。UIA 结构事件、MSAA WinEvent/子节点数和有界导航锚点帮助检测变化，检测到后旧游标和元素引用报失效；提供者不发事件、变化又发生在锚点之外时，不能保证检测所有修改。锚点检查最多验证各活动分支已见的 8 个兄弟节点，不重新扫描所有前页。

### 查询与已观测元素动作

`computer_find` 默认 `source:"snapshot"`，只在给定快照的一页中查找。`source:"native"` 直接在 Windows 窗口或已观测分支查询，返回可供 read/action 使用的新快照：

```json
{"source":"native","window_id":"<已观测窗口ID>","automation_id":"Commit","match":"exact","max_nodes":1000,"max_depth":12}
```

查询同样返回覆盖范围和游标；续查询可省略原条件并继承它们。UIA 精确查询对预算内每个访问节点使用 `PropertyCondition` / `FindFirst(TreeScope.Element)`；包含查询使用缓存字段筛选。缓存仅覆盖当前元素的基本字段及模式可用性，不使用无界 `FindAll(Descendants)`。原生查询仍有遍历成本，不承诺任意提供者下的常数时间查找。

正常 Windows 动作使用工作进程注册的原生元素引用，复核窗口生命周期、结构版本、UIA runtime ID 和身份字段后直接调用目标，不从窗口根重扫。引用按会话和进程代次隔离；每个工作进程最多保留 8 个窗口、20000 个元素引用、32 个游标，引用时效 120 秒。

UIA 读取包括 TextPattern 文档/选择/字符范围、ValuePattern、范围值、选择集、scroll/window 状态和 grid 信息/单元格。动作包括多选增删、范围值、scroll、文本选择/滚入视图、窗口状态/关闭与 transform 移动/缩放，均要求对应模式。

虚拟化控件概览不会自动实例化所有项目。`computer_element(operation:"find_item", property:"name" 或 "automation_id", value:...)` 要求 ItemContainerPattern，可能实例化或滚动目标；找到后返回独立元素快照。`operation:"realize"` 显式调用 VirtualizedItemPattern，再获取相关状态。未实现的虚拟节点不属于“全局不存在”的证据。

MSAA 使用 `AccessibleObjectFromWindow` / `AccessibleChildren`，提供传统控件树、名称/角色/状态/值读取、默认动作、值写入和选择。动作使用注册的 IAccessible 引用并检查 HWND/PID、结构版本和身份字段。同一位置出现属性完全相同的替换控件时，MSAA 无法提供 UIA runtime ID 那样的代际保证。

## 视觉与原生输入

默认 `computer_screenshot(output:"image")` 返回 `screenshot_id`、持久化附件 SHA-256 和实际 `source_bounds`，要求图像输入路由及附件服务。指针工具使用该图像中的坐标。Windows 指名窗口捕获将提窗与抓屏放在同一次 helper 调用里，按控制类审批。

只采集文件时使用：

```json
{"output":"file","save_to":"C:\\captures\\desktop.png"}
```

文件模式要求 `save_to`，保存 PNG 并返回路径、尺寸、字节数、时间、哈希与捕获边界；不要求图像路由或附件服务。它不注册可供坐标输入使用的图像证据。截图卡显示图像附件或文件模式的文字信息。模板匹配接受有效的 PNG 路径。

Windows 输入序列最多 256 步，显式等待/按住总和最多 10 秒；全文本最多 100000 UTF-16 单元。整条序列先校验再执行，首错停止。正常结束及处理到的错误释放该序列取得的按键/鼠标按钮；不会取得或释放调用前已由外部按住的输入。绑定窗口的序列每步检查身份及前台状态。强制结束进程无法保证析构清理执行，见 [SECURITY.md](SECURITY.md)。

`computer_key` / `computer_type` 接受有效的 `window_id`、绑定窗口的 `snapshot_id` 或前台截图证据。键盘快捷键的实际含义由应用决定，输入投递成功仍需确认相关结果。

### 后台捕获与子窗口消息

`computer_screenshot` 给 `window_id` 和 `background:true` 时，Windows 用 PrintWindow 按窗口完整边界渲染，返回 `capture_mode:"print-window"`，不主动提窗或恢复窗口，也不回退到前台捕获。GPU/受保护窗口可能失败或返回空白；最小化窗口明确报错，应先显式恢复。

后台图像不能作为全局指针动作的证据。可以使用语义动作，或先 `computer_windows(operation:"children")` 取得短期 `child_window_id`，再调用 `computer_window_input`。消息坐标是**子窗口客户区物理像素**。接口只有固定 click/scroll，不接受任意消息编号。每次复核 root/parent/PID/class/title，使用 500ms 消息超时。

helper 不主动请求前台，应用的消息处理仍可能自行激活窗口；响应的 `foregroundChanged` 记录实际变化。`delivered:true` 仅代表消息已交付，`applicationResultVerified:false` 表示仍需验证相关结果。窗口 `close` 同样只是请求关闭，应用可能拒绝或弹出保存对话框。

开发时已验证：Low 完整性标签的 exe 对 Medium 目标执行 PrintWindow 会报 Win32 错误 5；相同字节部署到新临时目录、继承 Medium 后捕获成功。插件不会自动修改标签、提升权限或静默搬迁；可通过 host 配置 `nativeHelperPath` 明确选择部署产物。显式路径不存在会报错。

### Windows 讲述人

`computer_narrator(operation:"status")` 只检查当前 Windows 登录会话中的 Narrator 进程，不启动讲述人或改设置。命令要求讲述人已运行以及有效的窗口绑定证据；可选 Insert / CapsLock modifier，命令按 Microsoft **Standard** 布局发送。

支持 item/view 移动、当前项/窗口/标题/文档/选择/行/词阅读、连续阅读、重复语音、scan 切换、激活与停止语音。实际配置布局不能从进程状态中推断，因此响应标为 unknown / Standard assumption。

讲述人虚拟光标、UIA 键盘焦点、语音是不同状态。本版本提供命令投递与 UIA/MSAA 内容读取协作，**没有语音捕获或虚拟光标观测**。本机只验证了状态桥接及命令/审批/证据合同，没有启动讲述人进行语音验收。

## 平台范围与运行时

| 能力 | Windows | macOS | Linux |
| --- | --- | --- | --- |
| 桌面截图/基本输入/窗口列出与聚焦 | 已实测 | 已实现、契约测试 | 已实现、契约测试；输入/窗口需 X11 `xdotool` |
| 独立无障碍观测/读取/基本动作 | UIA、MSAA 已实测 | AXValue / AXSelectedText；需 Automation + Accessibility | AT-SPI 文本/范围/选择/caret/数值；需 Python + pyatspi + AT-SPI 总线 |
| 分支展开、续页、原生查询、常驻隔离工作进程 | UIA、MSAA | 明确不支持 | 明确不支持 |
| 每次获取的节点/深度/时间预算 | 支持 | 支持，契约测试 | 支持，契约测试 |
| 区域/窗口截图、图像匹配 | 已实测 | 明确不支持 | 明确不支持 |
| 原子输入序列/路径拖动/扩展 hold/repeat | 已实现及核心真机检查 | 明确拒绝 | 明确拒绝 |
| PrintWindow/子 HWND/窗口管理/讲述人 | Windows 专属 | 明确拒绝 | 明确拒绝 |

macOS/Linux 的快照从焦点应用获取，不支持 Windows 形式的目标窗口语义根、`root_element_id`、`scope:"children"`、游标或 `source:"native"` 查询；默认快照内查找仍可用。显式 UIA/MSAA 后端请求会报错。macOS AX 不提供本接口的字符范围或 grid 读取；Linux 不提供 grid 读取。macOS 多屏左/上方显示器的截图原点与 Quartz 坐标仍待原生验收。

运行时只通过 Cordis 的服务契约取得 Harness 能力，不导入 Harness 实现。Windows UIA/MSAA 在独立 .NET Framework 控制台进程中运行，首次按源码哈希用系统 `csc.exe` 编译，使用 `ctx.subprocess` 管理 UTF-8 JSON 行管道。`semanticWorkerCount` 默认 2，显式范围 1..4；队列和启动计入调用截止时间。超时或取消会终止对应工作进程并等待退出确认，旧代次引用失效；没有确认退出时不创建替代进程。原生协议区分 `not_started`、`completed` 和 `unknown`；执行错误说明未开始或结果未知，未知结果不自动重试。

讲述人状态仍使用运行时匹配的进程内 C# 桥：普通 Node 使用可选 `edge-js`，Electron 使用可选 `electron-edge-js`。0.5.1 已在 Electron 44 / ABI 149 及普通 Node 24 中验证；其他 Electron 版本需匹配的预编译产物。编译器搬迁保留 `edge-cs-base.dll` 伴随程序集。视觉/窗口输入走仓库自带的 Rust exe。生产后端不走 PowerShell，也不使用系统剪贴板传图。

## 安装与组合

在官方插件面板添加 GitHub 来源 `github:leolee9086/dsh-computer-use#main`；CLI 可用时同样通过 Harness 的插件管理入口添加 profile bundle：

```powershell
pnpm dsh plugin --profile desktop add github:leolee9086/dsh-computer-use#main
```

bundle patch 同时激活 host `computer` 服务、工具和工作流提示词，不需要编辑任何 agent 预设。使用 Harness 正常重启入口加载新 host 代码，刷新网页不足以挂载它。包保持现有 `src` ESM 入口，加载器注册 ID 与包名一致。

默认 `observeApproval` / `controlApproval` 都为 `ask`。权威 DSH 权限预设为 Full access（danger-full-access + approval never）时继承免提示；显式 `deny` 始终有效。Loader 对单行 `config` 整体替换，覆盖时需写全该行配置。截图只读/后台与焦点改变分开审批，讲述人 status / command 同样区分观察与控制。

## 开发与交付验证

Node >=22.19，pnpm；Rust helper 构建需要 Rust >=1.88，Windows 语义工作进程需要系统 .NET Framework 编译器及 UIAutomation 程序集。真实 Harness 回归默认使用相邻 `../deepseek-harness` 检出，可设 `DSH_HARNESS_ROOT`。

```powershell
pnpm install
pnpm run verify
python test/linux-reader-contracts.py
pnpm run smoke:semantics
pnpm run smoke:windows
# 用当前桌面端实际可执行文件检查 Electron 原生 ABI；按本机路径替换：
pnpm run smoke:electron "C:\path\to\DeepSeek Harness.exe"
pnpm run verify:profile
# 修改 Rust 原生源码后：
cargo build --release --manifest-path native/Cargo.toml
pnpm run native:stage
pnpm pack --pack-destination .local
```

`verify` 检查所有 JS 文件并运行单元/提供者合同及真实 ToolRuntime 回归。`verify:profile` 使用独立临时 DSH home 检查真实 Loader、18 工具及提示词，清理后不影响既有 profile。`smoke:semantics` 用真实 Cordis 本地子进程服务测试万节点 UIA/MSAA、分页/分支/查询/引用/虚拟化、阻塞终止和恢复，并与旧采集算法测量同一提供者的调用量与响应大小。Electron smoke 包含这项测试及已有 WPF/WinForms 动作。Windows 动作 smoke 只操作标题唯一、由自己创建的进程，结束后清理自己的进程和临时目录。

`native:stage` 复制 release exe 并记录二进制与 Rust 源文件哈希；`prepack` 要求回归成功且产物清单匹配当前版本/源码。打包不含构建缓存或本地检查点。来源、许可与风险边界见 [UPSTREAM.md](references/UPSTREAM.md)、[LICENSE](LICENSE)、[SECURITY.md](SECURITY.md)，变更见 [CHANGELOG.md](CHANGELOG.md)。
