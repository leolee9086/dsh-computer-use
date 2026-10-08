# 复杂界面自动化源码调研 — 2026-10-07

复杂界面的主线路径应围绕“限定窗口与容器 → 表达可重新解析的定位条件 → 按控件协议操作 → 等待并读取结果”建立。大型语义树的整树导出、缓存和分页是其中一种读取用途；任务定位应尽早缩小范围，惰性展开所需分支，并使用 Grid、ItemContainer、窗口消息或局部图像等专门路径。

当前 computer_use 已有这些路径的部分基础：原生子树查询、多字段合取、分页、UIA/MSAA、常见 pattern、虚拟项查找与实例化、Grid 单元格读取、窗口与定向输入、局部模板匹配。主要差距是可重新解析的层级定位、条件等待、控件类型适配和动作结果流程，另有 OCR、找色、模板遮罩/缩放、标准 Win32 控件内容适配等底层缺口。接口数量和受控夹具通过不能证明复杂任务已经对齐。

本文保留调研完成时的 0.5.7 实现核对快照，生产源码基线为提交 `3812906f3faf4a55b8aefcefd090fcad069d8323`。没有运行七个框架的应用测试或性能比较。后续 0.5.8 已进入层级定位、条件等待、结果确认与虚拟项/Grid/弹窗实现，当前变更及实际验收见 [CHANGELOG](../CHANGELOG.md) 和 [EVIDENCE](../EVIDENCE.md)；下面的缺口矩阵仍指调研基线。正式安装清单此前确认的运行包为 0.5.1，未在本轮重新核对或安装；仓库能力不能直接当成已部署能力。

## 研究范围与固定来源

| 项目 | 固定提交 | 本轮主要核对的代码 |
| --- | --- | --- |
| pywinauto | `18d2a95cebed` | [控件查询][py-find]、[层级定位与重试][py-locator]、[下拉框][py-combo]、[虚拟项][py-virtual]、[惰性树路径][py-tree] |
| FlaUI | `fd7cc64ab019` | [TreeItem][f-tree]、[ComboBox][f-combo]、[Grid][f-grid]、[菜单项][f-menu]、[Popup 与上下文菜单][f-popup]、[点击与焦点][f-focus] |
| AutoHotkey | `47eabd418167` | [ControlClick][ahk-control]、[ListView 内容][ahk-list]、[WinWait][ahk-wait]、[找色][ahk-pixel]、[图像选项与匹配][ahk-image] |
| Descolada UIA-v2 | `2846a9b10518` | [条件与 native 查询][uia-find]、[等待与路径][uia-wait]、[Chromium 可访问性激活][uia-chromium] |
| SikuliX | `c6f179904945` | [Region 重采与等待][sx-wait]、[图像匹配][sx-image]、[显式模板缩放][sx-resize]、[遮罩][sx-mask]、[OCR 文本定位][sx-text]、[OCR 实现][sx-ocr] |
| Playwright | `d469960fdfc4` | [Locator 组合][pw-locator]、[控件替换时重新定位][pw-retry]、[动作可执行性][pw-action]、[稳定状态][pw-stable]、[命中检查][pw-hit]、[查询缓存与 Shadow DOM][pw-query]、[截止与取消][pw-progress] |
| Robocorp Windows | `801e0bdadac7` | [定位语法][rc-locator]、[层级解析与匹配][rc-find]、[树遍历][rc-tree]、[窗口定位][rc-window]、[条件等待][rc-wait] |

引用链接包含完整 40 位提交，避免随分支变化。前四个项目使用已有本地源码；后三个项目通过显式代理读取完整的 GitHub 文件目录，再下载 21 个核心文件。三个目录均报告 `truncated:false`，下载资料保留 URL、提交、大小、时间及 SHA-256 清单。只读取源码，未执行第三方程序或安装脚本。固定提交不等同于已验证的发行版。

## 1. 大型语义树：先缩小搜索范围，再读取必要信息

pywinauto 的 `WindowSpecification` 保留一串 criteria：先解析窗口，再把每层命中的容器作为下一层的 parent。[UIA-v2][uia-find] 在条件可由 UIA 表达时使用 `FindFirst` / `FindFirstBuildCache`；回调查询可通过返回值剪掉分支。FlaUI 的 TreeItem 子项仅查询直接 TreeItem children。Robocorp 默认窗口查找深度为 1，控件查询有独立深度和 single/siblings/all 策略。

这些机制共同减少无关范围及跨进程属性读取。可以用“窗口 → 属性面板 → 字体区 → 字号输入框”的条件链代替先把全部树导出给调用方。条件可以来自任务要求；诊断时再查看候选和层级。缓存适合批量取得当前查询需要的属性，不能代替下一次操作时的重新定位和身份核对。

实际限制也很具体：

- pywinauto 某些 descendants 路径先物化大量候选再过滤；宽范围仍然昂贵。
- UIA-v2 的 index > 1 分支可能使用 `FindAll`，没有普遍的有界索引查找保证。
- Robocorp 的 `iter_tree` 用非递归 DFS，但每层仍调用 `GetChildren()` 获取整组 children。`only_depths` 过滤返回层级，沿途节点仍需访问；按数字 path 也会枚举该级 siblings。
- Playwright 的查询缓存在一轮 evaluator 结束时清空。开放 Shadow DOM 查询还会扫描 `*` 寻找 shadow roots；宽 DOM 查询同样有成本。

本插件已有 observed root、children/subtree、深度/节点/时间预算、查询前缀截断及固定结果分页。继续补充的重点是让定位条件直接表达容器链、使提供者尽可能先过滤、以及把查询命中转成少量可操作引用。整树读取适合检查和导出；虚拟列表的数据全集需要另走数据控件协议。全树瞬时原子事务无需成为这些任务的统一前置条件。

## 2. 同名控件与复杂层级：位置关系也是定位条件

pywinauto 的 `find_element` 对零结果和多结果分别报错；多结果异常携带候选。它同时支持精确/正则属性、parent、深度以及显式 index。UIA-v2 具有 AND / OR / NOT、match mode、遍历顺序与路径。Robocorp 将属性合取、OR 分支和顶层 `>` 层级拆成查询步骤；其单项查询默认取第一个匹配，中间层也只继续第一个命中的根，因此不提供普遍的唯一性保证。

Playwright Locator 保存 selector，支持 `has`、`hasNot`、文本条件、链式定位、AND/OR 和显式 nth。单目标动作使用 strict，多个匹配产生歧义错误；FrameLocator 明确切入 frame，嵌套条件有同 frame 限制。开放 Shadow DOM 可以穿透查询，已知目标的命中检查还会处理其组件根；这不意味着普通定位器能够搜索任意封闭 Shadow DOM。

可采用的合同是：容器路径与目标属性一起保留；每次按同一条件重新解析；默认返回歧义和候选，显式 index/nth 由调用方选择。祖先容器被替换时，重新解析容器链；元素引用仍只属于取得它的观测。跨浏览器、UIA、MSAA、HWND 与图像路径分别保存来源，动作前取得该路径所需的新证据。

本插件当前 name、role、automation_id 已能合取，且支持 exact/contains。缺的是 class/framework 等查询属性、OR/NOT/regex、关系条件和一条可重新解析的层级 locator。现在可以多次调用找容器再查子树，但调用方要自行保管链和处理替换；这属于已有低层能力缺少统一流程。

## 3. 惰性树、虚拟列表与表格：按控件数据协议定位

pywinauto TreeView `get_item(path)` 从根逐层选择，先 Expand 当前项，再找下一级。这处理尚未创建的 lazy children，并避免展开不相关分支。FlaUI 的 TreeItem 将 ExpandCollapse、SelectionItem、Toggle 分别封装，子项查询保持 children scope。

虚拟列表走 ItemContainer `FindItemByProperty`，需要时用 VirtualizedItem `Realize`，再 ScrollItem `ScrollIntoView`。pywinauto 已有这条路径；按 index 查找则逐项推进，不能当成常数时间读取。FlaUI 明确说明 `Grid.Rows` 只是 UIA 当前可见的行，`GetRowByIndex` 通过 Grid `GetItem(row,0)` 取得对应单元格再取得行；按列值查行仍需逐行读取，可在达到指定命中数后停止。

本插件已有 `find_item`、`realize`、`scroll_into_view`、ExpandCollapse、SelectionItem 和 Grid row/column 读取。当前差距：

- 缺少“逐层展开 → 等待 children → 重新定位 → 选择”的树路径流程，以及结果状态确认。
- `find_item` 支持精确 name/automation_id，但没有 startAfter 或 index 枚举接口，也没有容器不支持时的有界滚动搜索流程。
- Grid 单元格读取返回含 ID 的描述，但该 cell 未注册进新的语义观测和持久 worker 引用表；返回 ID 还不能直接作为 `computer_element` 的可动作引用。
- 不能把“当前树无匹配”解释成“虚拟数据不存在”。也不能把实例化、滚动当成纯读取，它们可能改变界面。

## 4. 下拉框、菜单与弹窗：展开后重新确认搜索根

pywinauto 与 FlaUI 都对不同框架的 ComboBox 作分支：WPF 多使用 ExpandCollapse/SelectionItem；WinForms 有 Open 按钮、List 子控件及 editable 特例；Qt 还有选择行为差异。pywinauto 展开使条目加载后查询、选择并读取选中值/索引。FlaUI 部分分支使用固定动画延时，不能据此认为状态已经满足。

Popup 的拓扑差异更明显：FlaUI 查找 Win32 顶层上下文菜单时从 desktop 找 `#32768` / Context / System；Win32 子菜单可能需重新找到应用窗口下的 Menu；WinForms 的 DropDown 可能是 Menu 或 ToolBar；WPF 的 Menu 位于 Popup 窗口内。pywinauto 某些 toolbar 路径通过操作前后 descendants 的差集寻找新 popup，范围大且关系判断脆弱。

需要封装的是“操作一次 → 在共同截止内观察新窗口/新根 → 建立 owner、进程及触发关系 → 在实际 popup 根内定位 → 操作并读取业务结果”。关系不够明确时返回候选，多个窗口不能凭 first 或同名自行改绑。外部进程打开的对话框也需明确取得新窗口证据，不能硬套同 PID。

本插件可以展开、列窗口、查询新窗口、操作菜单项，但缺少 popup 发现/关联及控件路径流程。保留这些步骤的执行与观测记录即可，不需要强迫调用方每次用整树或截图重建所有状态。

## 5. 动态布局、控件替换与遮挡：条件等待和重新定位

Playwright 每轮重新解析 selector，目标 detached 时再次解析。指针操作依次检查 visible/enabled/stable、滚动、可点击点、iframe 命中和目标事件命中；stable 检查是连续动画帧中 bounding rect 一致。不同失败状态驱动退避等待，Progress 统一管理 monotonic deadline、取消、页面关闭和 frame detach。几何稳定只是位置稳定，不是应用业务加载完毕。

pywinauto 按指定 not-found / invalid-handle / invalid-element 异常重新定位；歧义不在这条重试列表中。AutoHotkey 的 WinWait 区分出现/关闭/激活/失活，按条件重新找窗口或检查固定 HWND；共享等待循环处理消息。Robocorp 的 `wait_for_condition` 默认 8 秒、100ms 轮询，使用 monotonic clock；callback 的读取或重新定位由调用方定义。

本插件 acquisition timeout 是一次读取的截止，input sequence wait 是固定延时；两者都不是“等到元素出现/启用/值改变/窗口关闭”。需要独立的有界条件等待，让每轮重新解析定位条件、只读取必要状态、报告最后结果和覆盖范围。前台窗口身份检查已有；输入控件焦点、目标命中、稳定范围和动作后业务状态还需组成完整流程。语义 Invoke 可在提供者支持时直接执行，不应无条件套用指针的可见/遮挡要求。

采用重新定位时，要区别只读查询和已发送动作：未开始的动作可以先等条件；动作已发送或执行状态未知时先确认结果，再决定下一步。Playwright 包含事件拦截后重试的分支，通用桌面路径没有相同的 DOM 事件控制能力，不能照搬其全部动作重试规则。

## 6. 自绘控件与图像：限定 Region、模板选项与 OCR

SikuliX 把 Region 作为搜索和重复抓图单位。`wait` / `exists` / `waitVanish` 在指定 scan rate 下重新抓取该区域，复用 Finder 并直到条件满足或截止。其 OpenCV 匹配使用相关性方法，透明遮罩有专门路径，模板可显式 resize，并可指定点击 offset。源码中的 downsized 搜索分支被 `trueOrFalse = false` 关闭；有效的显式 resize 不能误写成自动尺度不变搜索。

OCR 真正实现位于 TextRecognizer：Tesseract 配置语言与 page segmentation；灰度、锐化、按文字尺寸放大、再次锐化及可选反色；words/lines 返回文字、confidence 和换回原图的 bbox。Finder 可先在行级筛选，再对行的局部图像识别词并映射坐标。OCR confidence 是识别器输出分数，不能直接当成控件身份保证。

AutoHotkey 另有独立 PixelSearch，按有界区域、坐标模式、方向和 RGB 容差找色；ImageSearch 支持显式尺寸、透明色/图标 mask 和颜色容差。ImageSearch 取第一处匹配，并不自动判定唯一。

本插件已有窗口/矩形范围模板搜索与点击、DPI 坐标处理和候选列表，但目前实现使用灰度像素容差比例：

- 没有 OCR 文本/bbox/confidence、独立找色、模板 mask 和显式模板 resize 参数。截图输出 scale 不能代替模板尺度处理。
- 灰度转换丢失颜色差异并忽略 alpha；工具描述的 per-channel colour tolerance 与当前灰度算法不一致。
- 粗筛只保留 `CANDIDATE_KEEP = 8` 个位置，再逐候选局部精筛、聚类。相邻粗筛候选可能占满名额；返回 `matchCount` 是保留候选中的不同位置数量，不足以证明全搜索区域唯一。当前 click_image 的唯一性判断需专门验证和修正。

视觉路径的完整流程应包含区域/窗口绑定、显式模板尺度与遮罩、候选与覆盖状态、必要的 OCR/找色、等待目标或视觉结果、点击前重新获取目标，以及动作后结果确认。自绘界面不是一次全屏找图就能覆盖。

## 7. 标准 Win32 控件：用专门消息读取数据

AutoHotkey `ListViewGetContent` 直接对 HWND 使用 `LVM_GETITEMCOUNT`、header/selection/focus 消息和指定列读取，使用 SendMessageTimeout。跨进程 LVITEM 缓冲区按目标 32/64 位布局构造。这条路径能读取任务需要的标准控件数据，绕开完整可访问树遍历，但依赖控件类别、进程权限、结构布局和提供者行为。

本插件已有 child HWND 目录及定向 click/scroll 消息，没有 ListView/TreeView/ComboBox 等标准控件内容读取接口。应按真实控件类别逐项增加适配，设置总截止、行列/字节预算和逐消息截止；失败时明确已读范围，不能照搬静默跳过读取错误。存在 HWND 并不意味着控件支持这类协议。背景消息也不能保证应用不激活，已有 foregroundChanged 和动作后读取仍有作用。

## 8. 可访问性缺失、焦点与动作后结果

UIA-v2 针对 Chromium 找 renderer HWND、发 WM_GETOBJECT 激活可访问性，再等待 children。这是特定来源的 accessibility 激活路径。通用界面应先诊断所选 backend、实际窗口根及已暴露模式，再选择 UIA、MSAA、标准控件或局部视觉路径，并清楚返回不支持或覆盖不足的结果。

FlaUI 区分 SetForeground、原生 SetFocus、UIA SetFocus 和 GetClickablePoint；它部分路径会 AttachThreadInput。AutoHotkey ControlClick 的 NA 选项减少激活，但源码记录过嵌套 Save-As 弹窗兼容问题。消息投递成功、输入被系统接收、pattern 返回成功和应用业务状态改变需要分别报告。

结果确认要读取任务相关状态：选中项/输入值、树展开状态、Grid cell、对话框出现或关闭、菜单触发后的设置状态、局部图像变化。代理负责选择任务条件，底层负责可靠定位、等待、输入与读取，这些技术要求与常规 UI 自动化相同。

## 9. 不直接照搬的行为

| 已看到的实现细节 | 本插件应保留的边界 |
| --- | --- |
| UIA-v2 WaitElement 默认无限等待；WaitElementNotExist 广泛 catch 后视为消失 | 默认有总截止；未匹配、来源错误和覆盖不足分开报告 |
| FlaUI MenuItem.Items 的展开状态 do/while 没有截止；ComboBox 有固定动画 sleep | 等目标状态，允许取消，所有层共用截止 |
| Robocorp 至少完整搜索一轮才启用 timeout monitor，命中后有分支停止检查截止 | 长调用也受 worker/总预算约束；不能用“至少完成全树一次”延长硬截止 |
| pywinauto 的 fuzzy/index、Robocorp first 和 AutoHotkey first-image | 默认返回候选与歧义；模糊、序号、第一项选择明确表达 |
| 框架兼容分支可能重放 invoke/click，或把所有异常当暂时错误 | 查询恢复与动作执行状态分开；未知执行先读取结果 |
| Cache / stable / confidence / 前后树差集都有用途 | 分别按属性缓存、几何状态、识别分数、新控件线索使用，不能提升成全树事务或业务正确性证明 |

## 当前源码能力与差距

| 任务能力 | 0.5.7 已有基础 | 尚需补齐 |
| --- | --- | --- |
| 大树内定位 | 多字段 AND、observed 子树、children/subtree、预算、max_matches、固定分页 | 层级 locator、关系条件、更多属性条件、适用时的原生范围/条件下推 |
| 同名目标 | 返回匹配列表，由调用方选元素 | locator 链统一消歧、明确 nth/候选策略和覆盖状态 |
| 惰性树/虚拟列表 | expand/collapse/select、find_item/realize/scroll_into_view | 路径流程、容器枚举/有界滚动、重新定位与状态确认 |
| Grid | row/column 读取并返回 cell 描述 | 注册可操作 cell 引用、行列数据预算及虚拟化任务流程 |
| 菜单/Popup | 展开、列窗口、原生操作、键盘 | 新根关联、跨窗口路径、框架适配与业务结果验证 |
| 动态界面 | 身份复核、新读取恢复、一次读取截止 | appearance/state/value/window 条件等待、链重解、适合指针的稳定与命中检查 |
| 自绘/图像 | 区域/窗口模板匹配、候选、DPI、基础输入 | OCR、找色、mask/模板缩放、匹配覆盖与唯一性、视觉等待/结果确认 |
| 标准 Win32 内容 | HWND 目录、定向 click/scroll | 控件类型专用数据适配 |
| 后台与焦点 | PrintWindow、语义模式、定向消息、前台身份检查 | 复杂任务的焦点/owner/结果流程，按来源表达可用性 |

基线源码核对位置：[查询合同](../src/semantic-query.js#L1)、[定位与读取工具](../src/tool.js#L1151)、[pattern 合同](../src/accessibility-actions.js#L1)、[虚拟项实现](../src/windows-semantic-worker.cs#L515)、[Grid 返回](../src/windows-uia.cs#L403)、[图像候选和精筛](../native/src/main.rs#L596)。冻结结果仍有覆盖与资源预算；有界前缀的一个命中不能当成整个来源范围的唯一目标。

## 下一阶段以任务验收推进

| 顺序 | 具体任务 | 应取得的结果与失败边界 |
| --- | --- | --- |
| A1 定位与等待 | 两个面板都有“应用”；指定面板的输入控件先禁用，加载后被新控件替换 | 按容器链重解、等待 enabled，修改指定控件并读回；歧义明确；错误目标输入次数为 0 |
| A2 等待与执行 | 按一次动作打开对话框；载入图标消失后出现结果；部分轮次故意不出现 | 所有查询共用截止，最后条件明确；发送次数为 1；未出现有界超时；来源错误不能报告“已消失” |
| B1 惰性树 | 从未展开的根按三层路径选择一个节点 | 只展开任务路径；每层等待 children 并重查；选中项核对；分支缺失/被替换明确返回 |
| B2 虚拟数据 | 在有大量数据且目标未实例化的列表找指定项；读取并操作非首屏 Grid cell | ItemContainer/Grid 专门路径；新的 cell 引用可操作；不遍历所有 UI 节点；缺 pattern 时明确有界降级 |
| B3 菜单与新窗口 | 依次覆盖 Win32 上下文菜单、WinForms 下拉、WPF Popup 与外部对话框 | 在实际新根定位；owner/候选可审查；关闭/替换可恢复；菜单只触发一次，结果状态正确 |
| C1 模板可靠性 | 两个相同图标；相邻粗筛候选很多；模板存在透明区域、DPI 或显式尺度变化 | 颜色/遮罩/尺度策略明确；没有覆盖证明时不声称唯一；多个候选不误点；记录实际匹配范围 |
| C2 自绘文字与找色 | 在 SketchUp 等真实自绘区域中定位文字/图标及状态色，并等待结果变化 | 仅指定 region；OCR bbox 映射与 confidence 可检查；找色不依赖树；低置信度/遮挡有界返回 |
| D 标准控件 | 读取标准 ListView 的指定列、选择/焦点及预算内行 | 控件类别与行列内容正确；来源挂起仍有界；返回已读范围；未知类别明确不支持 |

A、B 优先使已有低层能力能够组成完整任务；C 中现有图像唯一性问题应先于新增自动点击路径解决，OCR/找色与 D 是继续补齐覆盖所需的独立能力。命名只是研究后的实施顺序，不表示这些阶段已经实现或通过验收。

验收同时使用自有夹具和真实应用，按每类任务重复运行记录正确结果、错误目标/重复输入次数、超时/恢复、原生调用量和耗时分布。测试具体失败与恢复，不只测试参数 shape。实际性能预算按应用和控件协议设置；没有本轮运行证据的通用延迟或框架优劣不作结论。宏观对齐以真实任务覆盖为准，本轮完成的是源码研究。

[py-find]: https://github.com/pywinauto/pywinauto/blob/18d2a95cebed2f0061ab4e4c80c3a76ece5dd4f3/pywinauto/findwindows.py#L76
[py-locator]: https://github.com/pywinauto/pywinauto/blob/18d2a95cebed2f0061ab4e4c80c3a76ece5dd4f3/pywinauto/base_application.py#L200
[py-combo]: https://github.com/pywinauto/pywinauto/blob/18d2a95cebed2f0061ab4e4c80c3a76ece5dd4f3/pywinauto/controls/uia_controls.py#L211
[py-virtual]: https://github.com/pywinauto/pywinauto/blob/18d2a95cebed2f0061ab4e4c80c3a76ece5dd4f3/pywinauto/controls/uia_controls.py#L885
[py-tree]: https://github.com/pywinauto/pywinauto/blob/18d2a95cebed2f0061ab4e4c80c3a76ece5dd4f3/pywinauto/controls/uia_controls.py#L1524
[f-tree]: https://github.com/FlaUI/FlaUI/blob/fd7cc64ab01908a0ae4cc7d05e704caa34f98d16/src/FlaUI.Core/AutomationElements/TreeItem.cs#L108
[f-combo]: https://github.com/FlaUI/FlaUI/blob/fd7cc64ab01908a0ae4cc7d05e704caa34f98d16/src/FlaUI.Core/AutomationElements/ComboBox.cs#L133
[f-grid]: https://github.com/FlaUI/FlaUI/blob/fd7cc64ab01908a0ae4cc7d05e704caa34f98d16/src/FlaUI.Core/AutomationElements/Grid.cs#L74
[f-menu]: https://github.com/FlaUI/FlaUI/blob/fd7cc64ab01908a0ae4cc7d05e704caa34f98d16/src/FlaUI.Core/AutomationElements/MenuItem.cs#L40
[f-popup]: https://github.com/FlaUI/FlaUI/blob/fd7cc64ab01908a0ae4cc7d05e704caa34f98d16/src/FlaUI.Core/AutomationElements/Window.cs#L61
[f-focus]: https://github.com/FlaUI/FlaUI/blob/fd7cc64ab01908a0ae4cc7d05e704caa34f98d16/src/FlaUI.Core/AutomationElements/AutomationElement.cs#L178
[ahk-control]: https://github.com/AutoHotkey/AutoHotkey/blob/47eabd4181679e1de5176a86dfe76fab19ff9f98/source/lib/win.cpp#L335
[ahk-list]: https://github.com/AutoHotkey/AutoHotkey/blob/47eabd4181679e1de5176a86dfe76fab19ff9f98/source/lib/win.cpp#L923
[ahk-wait]: https://github.com/AutoHotkey/AutoHotkey/blob/47eabd4181679e1de5176a86dfe76fab19ff9f98/source/lib/wait.cpp#L213
[ahk-pixel]: https://github.com/AutoHotkey/AutoHotkey/blob/47eabd4181679e1de5176a86dfe76fab19ff9f98/source/lib/pixel.cpp#L137
[ahk-image]: https://github.com/AutoHotkey/AutoHotkey/blob/47eabd4181679e1de5176a86dfe76fab19ff9f98/source/lib/pixel.cpp#L404
[uia-find]: https://github.com/Descolada/UIA-v2/blob/2846a9b10518a95cf26a6c43671a9512b231ccb7/Lib/UIA.ahk#L2770
[uia-wait]: https://github.com/Descolada/UIA-v2/blob/2846a9b10518a95cf26a6c43671a9512b231ccb7/Lib/UIA.ahk#L3204
[uia-chromium]: https://github.com/Descolada/UIA-v2/blob/2846a9b10518a95cf26a6c43671a9512b231ccb7/Lib/UIA.ahk#L861
[sx-wait]: https://github.com/RaiMan/SikuliX1/blob/c6f17990494541974353a7c64987f41c6761e612/API/src/main/java/org/sikuli/script/Region.java#L2772
[sx-image]: https://github.com/RaiMan/SikuliX1/blob/c6f17990494541974353a7c64987f41c6761e612/API/src/main/java/org/sikuli/script/Finder.java#L626
[sx-resize]: https://github.com/RaiMan/SikuliX1/blob/c6f17990494541974353a7c64987f41c6761e612/API/src/main/java/org/sikuli/script/Finder.java#L150
[sx-mask]: https://github.com/RaiMan/SikuliX1/blob/c6f17990494541974353a7c64987f41c6761e612/API/src/main/java/org/sikuli/script/Pattern.java#L187
[sx-text]: https://github.com/RaiMan/SikuliX1/blob/c6f17990494541974353a7c64987f41c6761e612/API/src/main/java/org/sikuli/script/Finder.java#L751
[sx-ocr]: https://github.com/RaiMan/SikuliX1/blob/c6f17990494541974353a7c64987f41c6761e612/API/src/main/java/org/sikuli/script/TextRecognizer.java#L291
[pw-locator]: https://github.com/microsoft/playwright/blob/d469960fdfc461e2d5795a3fa48a58a52a91ecaf/packages/playwright-core/src/client/locator.ts#L53
[pw-retry]: https://github.com/microsoft/playwright/blob/d469960fdfc461e2d5795a3fa48a58a52a91ecaf/packages/playwright-core/src/server/frames.ts#L1153
[pw-action]: https://github.com/microsoft/playwright/blob/d469960fdfc461e2d5795a3fa48a58a52a91ecaf/packages/playwright-core/src/server/dom.ts#L397
[pw-stable]: https://github.com/microsoft/playwright/blob/d469960fdfc461e2d5795a3fa48a58a52a91ecaf/packages/injected/src/injectedScript.ts#L693
[pw-hit]: https://github.com/microsoft/playwright/blob/d469960fdfc461e2d5795a3fa48a58a52a91ecaf/packages/injected/src/injectedScript.ts#L1023
[pw-query]: https://github.com/microsoft/playwright/blob/d469960fdfc461e2d5795a3fa48a58a52a91ecaf/packages/injected/src/selectorEvaluator.ts#L99
[pw-progress]: https://github.com/microsoft/playwright/blob/d469960fdfc461e2d5795a3fa48a58a52a91ecaf/packages/playwright-core/src/server/progress.ts#L82
[rc-locator]: https://github.com/robocorp/robocorp/blob/801e0bdadac7cd7dfcf79ac1fa7e66f361143e36/windows/docs/guides/01-locators.md
[rc-find]: https://github.com/robocorp/robocorp/blob/801e0bdadac7cd7dfcf79ac1fa7e66f361143e36/windows/src/robocorp/windows/_find_ui_automation.py#L193
[rc-tree]: https://github.com/robocorp/robocorp/blob/801e0bdadac7cd7dfcf79ac1fa7e66f361143e36/windows/src/robocorp/windows/_iter_tree.py#L115
[rc-window]: https://github.com/robocorp/robocorp/blob/801e0bdadac7cd7dfcf79ac1fa7e66f361143e36/windows/src/robocorp/windows/_find_window.py#L76
[rc-wait]: https://github.com/robocorp/robocorp/blob/801e0bdadac7cd7dfcf79ac1fa7e66f361143e36/windows/src/robocorp/windows/__init__.py#L247
