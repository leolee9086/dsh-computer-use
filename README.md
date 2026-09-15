# dsh-computer-use

`dsh-computer-use` 是一套独立的 Cordis 插件，为 DeepSeek Harness 提供**模型可见、可审计**的桌面操作能力，且不修改 Harness 源码树、不要求改动任何随附的 agent 预设。

可安装的 bundle 注册一个 `computer` 服务，并在同一个 bundle patch 里激活面向模型的工具插件与工作流提示词插件。安装过程不创建也不需要任何 agent 预设。

## Bundle 结构

一个包、一行裸包加载项、两个面 —— 与 `dsh-tool-websearch`、`dsh-tool-restart` 同构：

- `exports["."]` → `src/index.js` —— 裸包加载项的 host 半边，再导出 host 插件（`provide('computer')`）。它的加载项沿用 `dsh-computer-use-host` 这个 id，因此 profile 层已有的配置覆盖不会失效。
- `exports["./tool"]` → `src/tool.js`、`exports["./prompt"]` → `src/prompt.js` —— 子路径加载项，各自有独立的 config 块（Loader 会整体替换一行的 `config`，所以 host 与 tool 的参数互不干扰，可以各自覆盖）。
- `exports["./client"]` → `src/client.js` —— 浏览器半边（`dsh.client.platform: "web"`），经同一行裸包加载项扫描进 `window.__DSH_BOOT__`。它把 `computer_screenshot` 的工具卡渲染成真实图片，用的是 toolview owner props 里由会话鉴权提供的 `loadImage` 加载器；`read_image` 仍走产品内置的图片卡，没有被遮蔽。

浏览器半边的 `__ModuleLoader__.load` id 必须与包名一致 —— client-modules 图会校验注册 id 与图条目 id 是否相同。

## 能力模型

- 截图观测返回一份模型可见的图片附件、其持久化字节的 SHA-256，以及一个短期有效的 screenshot ID。
- 截图可以瞄准**整个虚拟桌面**、**单个显示器**（`display_id`），或**任意区域**（`x`/`y`/`width`/`height`，单位为虚拟桌面像素，允许负值），并可用 `scale` 放大。超出虚拟桌面的区域会被裁剪到桌面范围内，而回报的 `source_bounds` **始终描述实际截取的区域** —— 正因如此，局部截图的坐标操作才依然正确。
- 坐标操作必须带上那个 screenshot ID。provider 用随观测一并保存的原始捕获边界，把持久化图片的像素换算回物理桌面坐标，再把图片内的比例坐标夹取到该矩形的最后一个物理像素。
- 原生无障碍观测必须带一个**新的** screenshot ID，并把该 screenshot ID 与 SHA-256 一并存入短期有效的语义快照。树的根是被聚焦元素最近的原生 Window/Application，返回稳定的原生 element ID、控件元信息、边界、可聚焦性与支持的 pattern。`computer_find` 按名称、角色或 automation ID 缩小范围；`computer_element` 只接受与该快照绑定的那张截图。
- 语义动作支持原生 invoke/focus/value/toggle/expand/collapse/select，以及针对已发现的屏幕外元素的 `scroll_into_view`。`scroll_into_view` 是一个独立的状态变更步骤：其后任何操作前都要重新截图并重新取语义快照。
- 截图证据对一次有后果的桌面操作是**一次性**的。每一次成功的坐标或语义动作都会消耗该 agent 的全部截图、语义快照与窗口列表记录。窗口聚焦需要 `computer_windows:list` 刚返回的、属于该 agent 的 `window_id`，并同样消耗此前所有记录。因此下一个控制动作必须基于新捕获的桌面状态。
- Windows 在执行动作时，用 UIA runtime ID 加上进程与当前身份属性重新识别元素。如果被观测的元素已被替换或改变，它会失败退出，而不是把动作施加到一个仅仅相似的控件上。模型可见的快照受 `maxAccessibilityNodes` 限制；重新识别走一趟有限的控制视图遍历，受 `maxAccessibilityActionCandidates` 限制，因此不会在施加限制之前就把整个进程树物化出来。
- 输入类动作是串行的，且是独占式工具调用。下一步应当先重新观测屏幕，再做下一个有后果的动作。
- Windows 提供直接捕获（整个桌面、单个显示器，或任意区域，走自带的 `native/dsh-screen.exe`）、指针与键盘注入、可见非最小化顶层窗口枚举、有界的 UI Automation 树、语义元素查找，以及基于 pattern 的 UIA 动作（含 scroll-into-view）。聚焦之前它会拿 PID、标题、边界重新校验所列 HWND，随后核对最终前台状态；常规前台请求失败时，会通过临时挂接输入队列重试一次。
- macOS 提供直接捕获、键盘自动化、有界的 System Events 窗口枚举/聚焦、AX 语义适配器，以及经由自带 JXA helper 的指针动作。只列出暴露了原生窗口标识的窗口。列出的窗口 ID 绑定其 PID、标题、边界与原生窗口 ID；聚焦前会确认当前恰好只有一个匹配项，再把对应应用提到前台，提出后再校验一次，然后聚焦。指针与 AX 操作需要 macOS 的「辅助功能」权限；AX 的快照与动作调用还需要「自动化」权限。AX 动作在条件允许时会重新核对 PID、名称、角色与观测到的边界。
- Linux 通过系统设施捕获；在兼容 X11 的会话里用 `xdotool` 做指针、键盘、窗口枚举、聚焦与活动窗口查询。查询元信息时消失的窗口会被跳过；聚焦前会拿所列 XID 的 PID、标题、边界重新校验，然后激活。它的 AT-SPI 语义适配器用 `python3`/`python` 加 `pyatspi`，并要求 AT-SPI 总线在运行；它惰性枚举子节点，受配置的节点/候选预算约束，并拒绝深度超过其来源快照上限的动作路径。
- 当已安装的 `@yuxianglin/dsh-bridge-browser` host bundle 连接时，对应的 agent 会同时拿到它的 `browser_*` 文本/DOM 工具与 `computer_*`。工作流提示词要求在浏览器/桌面边界之间切换时重新取证，并禁止混用浏览器索引、桌面坐标与原生 element ID。这两个域被刻意保持分离，不存在合成的跨域定位器。
- 本 provider **不使用系统剪贴板**作为图像传输通道，也**不依赖 Rubick 那个不透明的 `ScreenCapture.exe`**。Windows 走自带原生 helper（`native/dsh-screen.exe`，Rust + Win32 GDI，MIT）：捕获路径开源、协议记录在 `native/README.md`，PNG 通过临时文件交回，既不走 stdout 管道也不走剪贴板。

## 安装到当前 web profile

在 `D:\dev\deepseek-harness` 下执行：

```powershell
pnpm dsh plugin --profile web add D:\dev\dsh-computer-use
```

这会把 bundle 装进 profile 并加上它的 `cordis.patch.yml` 层。该层会一并激活 host provider、面向模型的工具消费方与工作流提示词；安装过程中不包含任何预设编辑。bundle 栈是在 Harness 进程启动时读取的，所以请用 Harness 常规的重启入口重启既有进程，再开始会话；只刷新浏览器页面不会挂载新装的 bundle。

bundle 把 `observeApproval` 与 `controlApproval` 默认设为 `ask`。当当前 agent 的 DSH 权限预设解析为 `danger-full-access`（UI 里的「Full access」）时，这些默认的询问会继承该预设的免提示审批策略而自动放行。本插件里显式写的 `deny` 仍然优先。profile patch 可以覆盖任一行，但 Loader 层是**整体替换**一行的 `config`，不做深合并 —— 覆盖某一行时要写全该行的完整配置。`maxAccessibilityActionCandidates` 默认 `5000`，它与模型可见树的限制 `maxAccessibilityNodes` 是两个独立的量。

## 开发

```powershell
npm run verify
npm run verify:profile
npm run smoke:windows
npm run smoke:linux
npm run smoke:macos
```

Windows 的显示器 smoke 是只读的 provider 探针。`npm run verify:profile` 会建一个临时 DSH home，只把本 bundle 装进去，并启动一个真实的 Loader profile，用来检查 provider、全部面向模型的 schema 与工作流提示词，全程不创建也不挂载预设。它默认解析同级的 `../deepseek-harness` 检出；可用 `DSH_HARNESS_ROOT` 指向别的检出。语义聚焦 smoke 会起一个标题唯一的临时 WPF 窗口，通过 UI Automation 聚焦它自己的原生 Edit 元素、写入文本、切换复选框、点击按钮，并在每个动作后用一份新的 UIA 快照确认结果，最后只终止那个子进程并清理自己的临时脚本。

Linux 语义前置条件：`python3` 或 `python`，带 `pyatspi` 模块，且 AT-SPI 总线在运行。macOS 语义前置条件：`osascript` 需要「自动化」与「辅助功能」权限；自带的 `src/macos-ax.js` helper 以 JXA 方式调用。各平台适配器在 Windows 上做契约测试，而原生运行时 smoke 必须在各自的目标操作系统上跑。

本项目**没有运行时 npm 依赖**。它使用 host profile 提供的实时 Cordis 服务，因此它保持为独立版本化的项目，而 DSH 保持为组合宿主。

## 安全

启用控制类动作之前，请先读 [SECURITY.md](SECURITY.md)。[EVIDENCE.md](EVIDENCE.md) 记录了已验证的机制、可复现的检查，以及在任何 SOTA 式声明之前仍然存在的缺口。

## 来源与出处

见 [references/UPSTREAM.md](references/UPSTREAM.md)。项目记录了所审计的参考资料，且不使用任何第三方桌面自动化二进制，也不直接依赖 npm 桌面驱动。

## 变更记录

见 [CHANGELOG.md](CHANGELOG.md)。
