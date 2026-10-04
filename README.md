# dsh-computer-use

独立的 Cordis bundle，为 DeepSeek Harness 提供视觉、原生无障碍和 Windows 讲述人操作路径。0.5.0 注册 **18 个 `computer_*` 工具**；无障碍观测、阅读和语义动作可以独立使用，文本模型也能操作原生应用。

Windows 是经过本机运行时验证的主要后端。macOS AX、Linux AT-SPI 已实现并做契约测试，尚无这两个系统的原生运行时验收。接口覆盖与实测范围见 [EVIDENCE.md](EVIDENCE.md)；对标的官方接口见 [能力矩阵](references/CAPABILITY-MATRIX.md)。目前没有任务成功率基准，也没有 SOTA 等效结论。

## 操作路径

| 路径 | 工具 | 行为 |
| --- | --- | --- |
| 视觉 | `computer_screenshot`、`computer_find_image`、`computer_click_image` | Windows 支持多显示器、区域/缩放、前台窗口捕获、显式后台 PrintWindow、模板匹配与唯一匹配点击。图像以 DSH 附件返回。 |
| 指针 | `computer_move`、`computer_click`、`computer_drag`、`computer_scroll` | 截图像素映射到实际捕获边界；Windows 支持三击、modifier、按住、带路径拖动。 |
| 键盘/序列 | `computer_key`、`computer_type`、`computer_input` | Windows 支持扩展键、Insert/CapsLock、重复/按住，以及一条有界 down/move/up 序列；纯键盘也接受窗口或绑定窗口的语义证据。 |
| 无障碍 | `computer_accessibility`、`computer_find`、`computer_read`、`computer_element` | 独立快照、元素查找、文本/选择/值/状态读取与控件模式操作。Windows 显式选择 UIA 或 MSAA。 |
| 窗口 | `computer_windows`、`computer_window_input` | Windows 列出含最小化状态的顶层窗口，枚举子 HWND、管理窗口，或向已观测子窗口发送限定点击/滚轮消息。 |
| 讲述人 | `computer_narrator` | 只读进程状态；向已运行的讲述人发送固定 Microsoft Standard 布局命令。 |
| 能力 | `computer_status` | 返回平台能力和显示器几何。 |

### 独立无障碍循环

1. 调用 `computer_windows`，`operation:"list"`，获得短期 `window_id`；也可直接观察当前焦点应用。
2. 调用 `computer_accessibility`。Windows 可以给 `window_id`；`backend:"native"` 默认 UIA，`backend:"msaa"` 是独立的传统 IAccessible 实现。
3. 用 `computer_find` 缩小元素范围，或直接使用快照中的 `element_id`。
4. `computer_read` 读取有界内容；`computer_element` 使用控件实际暴露的 pattern 操作。
5. 每次控制尝试后重新观测，再进行下一次动作。

这条路径不需要图像能力。若快照选择绑定 `screenshot_id`，后续阅读/动作仍必须给同一份图像证据；截图的 SHA-256 绑定保持有效。

UIA 读取包括 TextPattern 文档/选择/字符范围、ValuePattern、范围值、选择集、scroll/window 状态和 grid 信息/单元格。新增动作包括多选增删、范围值、scroll、文本选择/滚入视图、窗口状态/关闭与 transform 移动/缩放。只有提供对应 pattern 的控件才支持这些动作。

MSAA 使用 `AccessibleObjectFromWindow` / `AccessibleChildren`，提供传统控件树、名称/角色/状态/值读取、默认动作、值写入和选择。它使用 HWND/PID/窗口标题与可重定位路径检查身份；同一位置出现属性完全相同的替换控件时，MSAA 无法提供 UIA runtime ID 那样的代际保证。

### 视觉与原生输入

普通桌面/区域截图返回 `screenshot_id`、持久化附件 SHA-256 和实际 `source_bounds`。指针工具必须使用该图像中的坐标。Windows 指名窗口捕获将提窗与抓屏放在同一次 helper 调用里，避免两次进程启动之间丢失目标；它按控制类审批。

Windows 输入序列最多 256 步，显式等待/按住总和最多 10 秒；全文本最多 100000 UTF-16 单元。整条序列先校验再执行，首错停止。正常结束及处理到的错误会释放该序列取得的按键/鼠标按钮；不会取得或释放调用前已由外部按住的输入。绑定窗口的序列每步检查身份及前台状态。强制结束进程无法保证析构清理执行，见 [SECURITY.md](SECURITY.md)。

`computer_key` / `computer_type` 接受新的 `window_id`、绑定窗口的 `snapshot_id` 或前台截图证据。键盘快捷键的实际含义由应用决定，输入投递成功仍需读取结果确认。

### 后台捕获与子窗口消息

`computer_screenshot` 给 `window_id` 和 `background:true` 时，Windows 用 PrintWindow 按窗口完整边界渲染，返回 `capture_mode:"print-window"`，不主动提窗或恢复窗口，也不回退到前台捕获。GPU/受保护窗口可能失败或返回空白；最小化窗口明确报错，应先显式恢复。

后台图像不能作为全局指针动作的证据。可以使用语义动作，或先 `computer_windows(operation:"children")` 取得短期 `child_window_id`，再调用 `computer_window_input`。消息坐标是**子窗口客户区物理像素**。接口只有固定 click/scroll，不接受任意消息编号。每次复核 root/parent/PID/class/title，使用 500ms 消息超时。

helper 不主动请求前台，应用的消息处理仍可能自行激活窗口；响应的 `foregroundChanged` 记录实际变化。`delivered:true` 仅代表消息已交付，`applicationResultVerified:false` 表示仍需重新读/观察。窗口 `close` 同样只是请求关闭，应用可能拒绝或弹出保存对话框。

开发时已验证：Low 完整性标签的 exe 对 Medium 目标执行 PrintWindow 会报 Win32 错误 5；相同字节部署到新临时目录、继承 Medium 后捕获成功。插件不会自动修改标签、提升权限或静默搬迁；可通过 host 配置 `nativeHelperPath` 明确选择部署产物。显式路径不存在会报错。

### Windows 讲述人

`computer_narrator(operation:"status")` 只检查当前 Windows 登录会话中的 Narrator 进程，不启动讲述人或改设置。命令要求讲述人已运行以及绑定窗口的新证据；可选 Insert / CapsLock modifier，命令按 Microsoft **Standard** 布局发送。

支持 item/view 移动、当前项/窗口/标题/文档/选择/行/词阅读、连续阅读、重复语音、scan 切换、激活与停止语音。实际配置布局不能从进程状态中推断，因此响应明确标为 unknown / Standard assumption。

讲述人虚拟光标、UIA 键盘焦点、语音是不同状态。本版本提供命令投递与 UIA/MSAA 内容读取协作，**没有语音捕获或虚拟光标观测**。本机只验证了状态桥接及命令/审批/证据合同，没有启动讲述人进行语音验收。

## 平台范围

| 能力 | Windows | macOS | Linux |
| --- | --- | --- | --- |
| 桌面截图/基本输入/窗口列出与聚焦 | 已实测 | 已实现、契约测试 | 已实现、契约测试；输入/窗口需 X11 `xdotool` |
| 独立无障碍观测/读取/基本动作 | UIA、MSAA 已实测 | AXValue / AXSelectedText；需 Automation + Accessibility | AT-SPI 文本/范围/选择/caret/数值；需 Python + pyatspi + AT-SPI 总线 |
| 区域/窗口截图、图像匹配 | 已实测 | 明确不支持 | 明确不支持 |
| 原子输入序列/路径拖动/扩展 hold/repeat | 已实现及核心真机检查 | 明确拒绝 | 明确拒绝 |
| PrintWindow/子 HWND/窗口管理/讲述人 | Windows 专属 | 明确拒绝 | 明确拒绝 |

macOS/Linux 的快照目前从焦点应用获取，不支持 Windows 形式的目标窗口语义根。显式 UIA/MSAA 后端请求会报错。macOS AX 不提供本接口的字符范围或 grid 读取；Linux 不提供 grid 读取。不支持的扩展输入选项在执行前报错，避免静默忽略。macOS 多屏左/上方显示器的截图原点与 Quartz 坐标仍待原生验收。

## 安装与组合

在 Harness CLI 可用的环境中，将仓库或打包产物添加为 profile bundle，例如：

```powershell
pnpm dsh plugin --profile web add <path-to-dsh-computer-use>
```

bundle patch 同时激活 host `computer` 服务、工具和工作流提示词，不需要编辑任何 agent 预设。使用 Harness 正常重启入口加载新 host 代码，刷新网页不足以挂载它。包保持现有 `src` ESM 入口；浏览器入口将截图工具卡渲染为图片，加载器注册 ID 与包名一致。

默认 `observeApproval` / `controlApproval` 都为 `ask`。权威 DSH 权限预设为 Full access（danger-full-access + approval never）时继承免提示；显式 `deny` 始终有效。Loader 对单行 `config` 整体替换，覆盖时需写全该行配置。截图只读/后台与焦点改变分开审批，讲述人 status / command 同样区分观察与控制。

运行时只通过 Cordis 的服务契约取得 Harness 能力，不导入 Harness 实现。Windows 无障碍/讲述人依赖可选 `edge-js`，C# 在 Node 进程内编译并调用；视觉/窗口输入走仓库自带的 Rust exe。生产后端不走 PowerShell，也不使用系统剪贴板传图。

## 开发与交付验证

Node >=22.19，pnpm；原生构建需要 Rust >=1.88。真实 Harness 回归默认使用相邻 `../deepseek-harness` 检出，可设 `DSH_HARNESS_ROOT`。

```powershell
pnpm install
pnpm run verify
python test/linux-reader-contracts.py
pnpm run smoke:windows
pnpm run verify:profile
# 修改原生源码后：
cargo build --release --manifest-path native/Cargo.toml
pnpm run native:stage
pnpm pack --pack-destination .local
```

`verify` 检查所有 JS 文件并运行单元/提供者合同及真实 ToolRuntime 回归。`verify:profile` 使用独立临时 DSH home 检查真实 Loader、18 工具及提示词，清理后不影响既有 profile。Windows 动作 smoke 只操作标题唯一、由自己创建的 WPF/WinForms 进程，结束后清理自己的进程和临时目录。

`native:stage` 复制 release exe 并记录二进制与 Rust 源文件哈希；`prepack` 要求回归成功且产物清单匹配当前版本/源码。打包不含构建缓存或本地检查点。来源、许可与风险边界见 [UPSTREAM.md](references/UPSTREAM.md)、[LICENSE](LICENSE)、[SECURITY.md](SECURITY.md)，变更见 [CHANGELOG.md](CHANGELOG.md)。
