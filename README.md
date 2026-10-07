# dsh-computer-use

独立的 Cordis bundle，为 DeepSeek Harness 提供视觉、原生无障碍和 Windows 讲述人操作路径。0.5.5 注册 **18 个 `computer_*` 工具**；无障碍观测、阅读和语义动作可以独立使用，文本模型也能操作原生应用。

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

获取默认是 summary：返回基本属性、边界、模式可用性和子节点覆盖情况，完整文档与模式状态由 `computer_read` 获取。Windows 默认 `consistency:"snapshot"`：在所选范围内采集并校验，封存后从同一固定结果集分页。每页默认最多 300 节点、范围深度 6、1 MB 原生响应；一次工具调用的排队、启动及分段采集共用 30 秒截止。`max_nodes` 同时限定每次原生采集/验证分段的节点数和输出页大小，`max_depth`、`timeout_ms` 可逐次指定。`scope:"children"` 只浏览直属子节点，`scope:"subtree"` 浏览有界子树。

```json
{"window_id":"<已观测窗口ID>","max_nodes":100,"max_depth":2}
```

展开已观测分支时，使用包含该元素的快照：

```json
{"snapshot_id":"<分支所在快照ID>","root_element_id":"<已观测元素ID>","scope":"children","max_nodes":100}
```

返回的 `coverage` 标明 complete、partial 或 unknown 及原因，`consistency` 独立标明 collecting、validating 或 frozen。未完成校验时返回空元素和 `capture_in_progress`，可继续同一采集代次。封存页返回固定的 `result_id`、SHA-256 和采集起止时间；`next_cursor` 表示仍有采集进度或未交付的封存页，用该页的 `snapshot_id` 续取：

```json
{"snapshot_id":"<上一页快照ID>","cursor":"<上一页next_cursor>","max_nodes":100}
```

采集和验证各保留原生 DFS 栈；概览复读全部摘要，查询复读每个覆盖节点的匹配字段及顺序，并复读命中项的完整摘要，包括未命中项变成命中的情况。变化事件或复读差异使未交付代次报 `COMPUTER_SNAPSHOT_CHANGED` 并丢弃。新观测在同一 HWND/PID/标题、未发布元素、明确未开始动作且仍有剩余时间时，可在原工具截止内重采最多两次，返回 `capture_restarts`；已经交付的采集游标不自动换代次，动作、未知结果、资源/时效错误和取消不自动重试。第一页交付前完成校验，之后所有页只读封存行，UI 的插入、删除、重排、改名不会混入这一结果。每页注册独立的工具观测，保留同一结果身份；动作失效后的历史分页可继续阅读，但不会恢复已失效的动作证据。游标绑定会话、后端、工作进程代次、查询、consistency 及深度/scope/detail/截图绑定，改变条件需开始新获取。

每个工作进程最多保留 4 个采集/封存结果，每个结果覆盖最多 20,000 节点，保留数据估算预算 32 MB，合计预算 64 MB。采集和封存各自有 120 秒绝对时效，访问不延长它；时效及淘汰顺序使用单调时钟，采集/验证的原生读取后、封存前和构造输出页前后都检查到期，已到期代次报 `cursor_stale` 并丢弃；池淘汰会使相应游标与引用失效。节点/保留数据上限命中时只封存已验证范围，返回 `capture_node_limit` / `capture_byte_limit` 和 partial；输出页大小不会扩大全树覆盖。深度之外的分支需显式展开或增加深度。

`frozen` 保证多页来自同一个不可变结果，`source_atomic:false` 说明源 UI 采集不是事务快照。UIA/MSAA 没有全树事务接口，两次相符的读取及事件校验仍不能证明所有字段曾在源程序的同一瞬间同时存在。需要源程序某一瞬间的全树原子状态时，须由提供者提供事务或可靠的版本化快照接口；此结果不提供该保证。采集范围是否查完由 coverage 表示，与这两层一致性分别判断。

显式 `consistency:"live"` 保留逐页读取活树的方式，首屏只需本页采集，输出一致性为 unverified。结构事件及每个活动分支最多 8 个导航锚点用于使游标过期；它不能保证页间一致性。固定结果集增加首屏采集/复读成本，封存后续页不再访问提供者，可按范围和所需保证选择模式。

### 查询与已观测元素动作

`computer_find` 默认 `source:"snapshot"`，只在给定快照的一页中查找。`source:"native"` 直接在 Windows 窗口或已观测分支查询，返回可供 read/action 使用的新快照：

```json
{"source":"native","window_id":"<已观测窗口ID>","automation_id":"Commit","match":"exact","max_nodes":1000,"max_depth":12}
```

查询同样返回覆盖范围、一致性和游标；续查询可省略原条件并继承它们。固定结果集在原生工作进程内按缓存字段筛选：未命中项读取并复核名称、角色、automation ID、启用及屏幕外状态等匹配字段，命中项再读取并复核完整摘要、边界和模式可用性，最终只交付命中行。UIA 导航缓存同时取得 runtime ID，动作前仍重新读取实时身份；MSAA 未命中项省去位置与默认动作 getter。live 模式的 UIA 精确条件使用 `PropertyCondition` / `FindFirst(TreeScope.Element)`。缓存范围有界，不使用无界 `FindAll(Descendants)`。原生查询仍有遍历成本，不承诺任意提供者下的常数时间查找。机制对照见 [成熟桌面自动化源码](references/DESKTOP-AUTOMATION-IMPLEMENTATIONS.md)。

正常 Windows 动作使用工作进程注册的原生元素引用，复核窗口生命周期、结构版本、UIA runtime ID 和身份字段后直接调用目标，不从窗口根重扫。引用按会话和进程代次隔离；每个工作进程最多保留 8 个窗口、20000 个元素引用和 32 个 live 游标，另有最多 4 个固定结果集的续页入口；引用时效 120 秒。

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

macOS/Linux 的快照从焦点应用获取，不支持 Windows 形式的目标窗口语义根、`root_element_id`、`scope:"children"`、游标、consistency 选择或 `source:"native"` 查询；默认快照内查找仍可用。显式 UIA/MSAA 后端请求会报错。macOS AX 不提供本接口的字符范围或 grid 读取；Linux 不提供 grid 读取。macOS 多屏左/上方显示器的截图原点与 Quartz 坐标仍待原生验收。

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
pnpm run smoke:snapshots
pnpm run smoke:recovery
pnpm run smoke:lifetimes
pnpm run smoke:windows
# 用当前桌面端实际可执行文件检查 Electron 原生 ABI；按本机路径替换：
pnpm run smoke:electron "C:\path\to\DeepSeek Harness.exe"
pnpm run verify:profile
# 修改 Rust 原生源码后：
cargo build --release --manifest-path native/Cargo.toml
pnpm run native:stage
pnpm pack --pack-destination .local
```

`verify` 检查所有 JS 文件并运行单元/提供者合同及真实 ToolRuntime 回归。`verify:profile` 使用独立临时 DSH home 检查真实 Loader、18 工具及提示词，清理后不影响既有 profile。`smoke:semantics` 用真实 Cordis 本地子进程服务测试万节点 UIA/MSAA、分页/分支/查询/引用/虚拟化、阻塞终止和恢复，并与旧采集算法测量同一提供者的调用量与响应大小。`smoke:snapshots` 验证两种后端万节点固定分页、未交付代次变化丢弃、查询未命中节点复核、静默插删/重排/属性更新、封存后原生采集零调用，以及历史结果不能绕过实时目标校验。`smoke:recovery` 验证查询未命中项静默变更后重采一次、持续变化三次尝试后失败、已交付游标不换结果、旧动作引用实时拒绝，以及相同覆盖范围下的按需缓存读取量。`smoke:lifetimes` 将自建窗口的真实属性读取延迟 1200ms，并把测试进程私有的代次起点移到距期限 1000ms，验证分段内到期丢弃、旧游标拒绝、引用清除及同进程恢复；还验证未来的展示时间戳不会延长封存时效，不修改机器时钟或生产时效常量。Electron smoke 包含这些验收及已有 WPF/WinForms 动作。Windows 动作 smoke 只操作标题唯一、由自己创建的进程，结束后清理自己的进程和临时目录。

`native:stage` 复制 release exe 并记录二进制与 Rust 源文件哈希；`prepack` 要求回归成功且产物清单匹配当前版本/源码。打包不含构建缓存或本地检查点。来源、许可与风险边界见 [UPSTREAM.md](references/UPSTREAM.md)、[LICENSE](LICENSE)、[SECURITY.md](SECURITY.md)，变更见 [CHANGELOG.md](CHANGELOG.md)。
