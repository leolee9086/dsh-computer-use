# dsh-screen 原生桌面 helper

Windows 捕获、输入与窗口控制后端，版本 0.5.0。单文件 Rust exe，不需要 PowerShell。Windows UIA/MSAA/Narrator 属于 Node 的独立 C# 桥，不在此 exe 内。

## 协议

命令走 argv；请求体为 `base64(UTF-8 JSON)`，通过 stdin 写完并关闭。stdout 返回 JSON，错误写 stderr 并退出 1。PNG 使用 `screenshot --out <path>` 写文件，stdout 只回元数据。调用方必须在需要请求体时发送 stdin 并结束流，否则 helper 仍会等输入。

| 命令 | 请求 JSON | 结果 |
| --- | --- | --- |
| `list-displays` | 无 | 显示器 `id/name/primary/bounds` 数组 |
| `list-windows` | 无 | `id/title/processId/application/focused/minimized/bounds` 数组，包含有标题的可枚举最小化窗口 |
| `focus-window` | `{id,processId,title}` | 身份/前台确认后 `{ok:true}`，最小化目标先恢复 |
| `action` | `{action,focus?}` | `{ok:true}`；错误前可能已有输入副作用 |
| `screenshot --out <path>` | 下述捕获字段 | `path/width/height/sourceBounds/captureMode/bytes/displayId?` |
| `find-image` | `templatePng/threshold/tolerance/colorMode/maskMode/alphaMin/templateScale/budgetMs/maxPositions/region?/focus?` | `found/status/coverage/visitedPositions/totalPositions/stopReason?/matchCount/matches/…` |
| `find-color` | `{capture:{region,window?,captureMode},rgb,tolerance,direction,budgetMs,maxPixels,maxSamples}` | `found/status/coverage/searched/windowBounds/visitedPixels/totalPixels/matchingPixels/samples/…` |
| `ocr` | `{capture:{region,window?,captureMode},scale,language?,maxWords,maxChars,budgetMs}` | `engine/language/coverage/status/searched/windowBounds/imageWidth/imageHeight/words/lines/…` |
| `ocr-languages` | 无 | 已安装语言、`maxImageDimension` 与置信分数可用性 |
| `child-windows` | `{window,maxNodes}` | 子 HWND `windows` 与 `truncated` |
| `window-message` | `{window,child,action}` | `delivered/applicationResultVerified/foregroundChanged` |
| `read-listview` | `{window,child,columns,startRow,maxRows,maxCells,maxChars,maxCellChars,budgetMs,messageTimeoutMs}` | 行/列文本、选择/焦点、实际计数、覆盖/停止原因/错误及远端隔离状态 |
| `manage-window` | `{window,action}` | 操作结果；关闭为 `posted:true,applicationResultVerified:false` |

除 `focus-window` 的顶层 `id` 外，窗口身份目标 `focus` / `background` / `window` 使用 `{handle,processId,title}`。HWND 是十进制字符串，避免 JavaScript number 精度丢失。边界是实时读取的结果，不作为旧身份字段。原生调用复核句柄/进程/标题，并在需要前台时确认实际前台 HWND。

## 捕获

| 字段 | 含义 |
| --- | --- |
| `displayId` | 可选显示器 ID；省略为虚拟桌面 |
| `region` | `{x,y,width,height}`，物理虚拟桌面坐标，允许负原点；越界裁到桌面内 |
| `scale` | 可选缩放倍数 |
| `maxDimension` | 输出最长边上限，默认 1920 |
| `maxBytes` | 编码 PNG 字节上限 |
| `focus` | 同一次调用聚焦后按实际窗口边界捕获，避免下一次 spawn 干扰前台 |
| `background` | PrintWindow 全窗口渲染；与 focus/region/displayId 互斥，不提窗、不恢复 |

对应 argv 参数覆盖 stdin 选项。`sourceBounds` 必须等于实际捕获区域；上层按图像尺寸和 sourceBounds 映射指针。后台 captureMode 是 `print-window`；该图不能授权全局指针动作。PrintWindow 拒绝最小化窗口，应用不配合、GPU 或保护内容可能失败/空白，没有前台回退。同步 PrintWindow 的挂起由外层 DSH managed subprocess deadline 限制。

GDI 桌面捕获使用 SRCCOPY；此前特定 GPU/DWM 环境下 CAPTUREBLT 产出全黑，因此未开启。读取位图前将其从 DC 移出；GetDIBits 使用有效的兼容 DC。调试设置 `DSH_SCREEN_DEBUG=1`，耗时与像素诊断写 stderr，不污染 stdout JSON。

## 完整覆盖的模板搜索

`find-image` 请求的 `templatePng` 是 base64 PNG。`threshold` 默认 0.9，是容差内参与像素的比例；`tolerance` 为整数 0–255，默认 12。`colorMode` 接受 `gray`（默认，Rec.601 整数灰度）或 `rgb`；RGB 的三个通道都在容差内才算该像素匹配。旧降采样算法造成的 16×16 最小模板限制已经移除。

`maskMode` 接受 `none`（默认，忽略 alpha、比较全部像素）或 `alpha`。`alphaMin` 为整数 1–255、默认 1，alpha 模式只纳入透明度 >= 此值的像素，评分分母使用实际参与数量。不作背景合成或 alpha 加权；半透明像素保留 PNG 原色，已在屏幕合成的颜色可能不同。

`templateScale` 是单个有限比例 0.1–4、默认 1。先用最近邻缩放，再计算遮罩和参与对比度；正尺寸 round（.5 向上）。不自动尝试多个尺度，透明像素隐藏颜色不混入有效像素。零尺寸、源或变换后超过 1,048,576 像素、全排除遮罩均拒绝。只统计参与像素，灰度标准差低于 3，或 RGB 各通道标准差都低于 3 时拒绝。

所有合法左上角按行、步长一像素扫描，灰度/RGB/alpha 共用覆盖、聚类和预算核心。区分度排列只改变单位置的比较顺序；超过阈值允许的不匹配数时才提前淘汰该位置。阈值预算使用最终评分的相同除法判据，避免 0.9/0.95 浮点边界误拒。没有 top-8 候选排除未搜索区域。

`budgetMs` 为 1–120000，默认 5000；`maxPositions` 为 1–100000000，默认 20000000。预算从模板解码开始，包括准备和抓屏；扫描本身定期检查截止，单个大模板比较也可以中断。Win32 系统调用阻塞由宿主 managed subprocess 的额外五秒启动/输出余量截止终止并报错，不伪造成功的部分扫描。

返回请求模式确认 `colorMode/maskMode/alphaMin/templateScale`、`sourceTemplateWidth/Height`、实际 `templateWidth/Height`、`resizeFilter:"nearest"`、`activePixelCount`；原有 `scale:1` 表示抓屏未降采样，与模板比例分别报告。覆盖位置、聚类半径和点击中心使用实际模板尺寸。返回 `visitedPositions/totalPositions`、`coverage:"complete"` 或 `"partial"`。只有完整覆盖的零匹配报告 `status:"not_found"`；时间、位置或 100000 聚类上限耗尽报告 `status:"incomplete"` 及 `stopReason:"time_budget"/"position_limit"/"cluster_limit"`。`found` 只表示已知匹配，部分覆盖的数量是完整计数的下界。

聚类规则 `row_major_fixed_anchor_half_template`：按行首匹配固定锚点，横纵距离分别不超过半模板宽高时归入最早相邻锚点。空间索引限制邻域查找，锚点不随最高分展示点移动，前缀计数不会在继续扫描时下降。`matchCount` 不受八处展示上限影响，`matches` 只输出最高分八处。视觉聚类不等于业务身份，相邻不同对象仍可能合并。宿主点击必须校验完整协议、请求模式与变换、完整覆盖且仅一聚类；旧 helper 缺少确认字段直接拒绝。找图与输入间的界面变化不具有事务保证。

## 区域找色与系统 OCR

`find-color` / `ocr` 的 `capture.region` 必填，面积最多 16,000,000 原生像素。指定 `capture.window` 时，区域相对**完整窗口**左上角，每次读取实时边界换算；省略窗口时使用有符号虚拟桌面坐标。区域必须完整位于实际来源内，越界直接拒绝，不采用 screenshot 的裁切规则。结果 `searched` 是绝对区域，`windowBounds` 为本次窗口边界；桌面模式为 null。

`captureMode` 为 `screen` 或 `print_window`。工具不会聚焦、恢复或输入。窗口 screen 模式要求目标已经前台、可见且未最小化，捕获前后复核身份、边界与前台。print_window 要求窗口身份，先取得完整窗口渲染再裁区域，捕获后复核边界；完整渲染仍受原有 64,000,000 像素上限约束。应用可能不支持后台渲染；错误立即上报，无前台回退。视觉结果属于像素观测，不提供截图或语义元素动作凭据。

找色按 `row_major` / `reverse_row_major` 遍历每个像素，RGB 三个通道分别满足包含边界的 `tolerance`（0–255）才匹配。`maxPixels` 为 1–100,000,000，`maxSamples` 为 1–32；样本展示上限不截断 `matchingPixels`。结果报告方向、请求颜色、容差、实际 RGB 样本和绝对坐标，以及 `visitedPixels/totalPixels`。预算停止时 `coverage:partial/status:incomplete`、`stopReason:timeout/pixel_limit`；部分已知匹配可以证明命中，部分零匹配不能证明缺席。像素数量不等于控件数量或唯一性。

OCR 使用系统 `Windows.Media.Ocr`。`ocr-languages` 无请求体，返回已安装 tags、系统图像最长边上限和分数可用性；显式 language 必须已安装，省略时使用系统 profile 语言，无法创建引擎直接报错。`scale` 为 1–4，以 Lanczos3 放大；返回实际取整后的 `imageWidth/Height`，字框按实际宽高分别映射回原生绝对坐标，不能只除请求比例。原图及 OCR 图面积都最多 16,000,000 像素，OCR 图还受系统最长边约束。

`words` 包含 text、绝对 `bounds`、OCR 图内 `imageBounds` 和 `lineIndex`；`lines` 包含 text、所有成员字框的并集、`lineIndex/wordStart/wordCount`。引擎不暴露置信分数，字/行 `confidence:null`，`confidenceAvailable:false`，原因 `engine_does_not_expose_score`；公开工具拒绝任何 `min_confidence`，包括 0。`maxWords` 为 1–2000，`maxChars` 为 1–64000，字符预算同时计入输出的字和行文本。字、字符或时间预算停止时明确 partial/incomplete（`word_limit/character_limit/timeout`），截断尾部可保留字而没有完整行，不拼接前缀冒充整行。complete 只表示本次引擎结果完整交付，不能证明所有屏幕文字均识别正确。

两命令 `budgetMs` 为 1–120000，包括捕获、准备及扫描/识别；宿主的官方 managed subprocess 用同一总预算终止阻塞，无额外五秒余量。公开 `computer_wait_visual` 每轮重新捕获固定来源，共享单调总截止、链接取消与每轮剩余预算；来源错误立即停止，取消原样上报。出现条件可用已知命中，消失条件要求完整覆盖；OCR 消失只表示无识别匹配。`visual_id` 是独立观测标识，不能用于动作。

## 有界输入

JavaScript 提供者把 move/click/drag/scroll/type/key 和公开 input 序列转成统一的 `action.kind:"sequence"`：

```json
{
  "focus": {"handle":"1234","processId":123,"title":"Fixture"},
  "action": {
    "kind":"sequence",
    "delayMs":0,
    "steps":[
      {"kind":"keyDown","key":17},
      {"kind":"key","key":65,"modifiers":[],"repeat":1,"holdMs":50},
      {"kind":"keyUp","key":17}
    ]
  }
}
```

原生 step 字段：

| kind | 字段 |
| --- | --- |
| `move` | `x,y`，屏幕物理坐标 |
| `mouseDown` / `mouseUp` | `button`：left/middle/right |
| `keyDown` / `keyUp` | 数值 Windows virtual-key `key` |
| `key` | 数值 `key`、数值 `modifiers[]`、`repeat`、`holdMs` |
| `wait` | `ms` |
| `type` | Unicode `text` |
| `scroll` | `x,y,deltaX,deltaY` |

原有 move/click/drag/scroll/type/key action 变体仍兼容；公开 JS 接口统一走上述序列。公开 key 名称由 JS 映射成 VK，mouse click modifier 与路径拖动则展开为明确的 down/move/wait/up。使用 SendInput，MapVirtualKeyW 的扩展前缀控制 Insert/Delete/方向键/右 Ctrl/Alt 等的 EXTENDEDKEY 标志。

序列最多 256 步，显式 wait/hold 总和最多 10000ms，全文本最多 100000 UTF-16 单元。预校验整条请求后才聚焦/执行。每一步在绑定目标时复核其身份与前台，首错停止。已经投递的事件不可回滚。

RAII 记录本序列取得的按键/按钮，在正常结束或处理到的错误时释放，包括调用方省略了尾部 up 的情况。若该输入调用前已在外部按住，拒绝取得，不擅自释放。**强制终止、崩溃或断电不能保证析构执行。** 外层 managed subprocess 取消和超时可能直接终止进程，这条边界不能宣称无条件释放。

## 子窗口与窗口管理

`child-windows` 最大 512 节点。子记录包含 `id,parentId,rootId,processId,className,title,visible,enabled,bounds,clientBounds`；客户区边界给出当前屏幕原点和尺寸。真实辅助 HWND 可以宽/高为零，目录保留它们并继续枚举；负尺寸报错。捕获/manage 和定向动作保持原有效边界要求。

`window-message` 接受枚举出的完整 child 身份，固定 action 为 `{kind:"click",x,y,button}` 或 `{kind:"scroll",x,y,deltaX,deltaY}`。坐标是**子窗口客户区物理像素**，不是 screenshot 像素。再次核对 root/parent/PID/class/title，消息使用 SendMessageTimeoutW 500ms；不接受任意消息编号。helper 不请求前台或移动全局指针，但应用可在处理消息时自行激活。`foregroundChanged` 是实际测量，`delivered:true` 不证明业务结果。

`manage-window` action 为 move(x/y)、resize(width/height)、minimize/maximize/restore/close。move/resize 使用 NOACTIVATE/NOZORDER；其它窗口状态可能影响前台。close 只投递 WM_CLOSE，应用可能拒绝或弹出保存对话框。最小化后可通过新的 list-windows 记录确认状态，再明确恢复/聚焦。

## 标准 ListView 文本协议

`read-listview` 接受准确的顶层与子 HWND 身份，前后复核 root/parent/PID/class/title。只支持 `SysListView32` 和 `WindowsForms10.SysListView32.*`；`LVS_OWNERDATA` 与未知类直接拒绝。禁止任意消息编号，不聚焦、选择或滚动；禁用控件的只读内容可取。标量消息使用 `SendMessageTimeoutW`，文本用 `LVM_GETITEMTEXTW` 完成回调；列数来自同进程、真实子 `SysHeader32`，无可确定 header 时只接受列 0。

请求必填所有预算：columns 为 1–32 个唯一列号 0–255，startRow 不超过 i32::MAX，maxRows 1–512、maxCells 1–4096、maxChars 1–262144、maxCellChars 1–4000（UTF-16 单元）。budgetMs 为 1–120000，messageTimeoutMs 为 1–1000 且受剩余总截止限制。宿主共用总截止，包括启动/排队；阻塞由官方 managed subprocess 终止。结果以完整行前缀计算 nextRow，尾行可能不完整；source_error 保留已读前缀和 failedRow/failedColumn。末尾行数变动报告 sourceCountChanged，读取不具有源程序事务性。

64 位 helper 显式判断目标为 32/64 位，按目标宽度编码 `LVITEMW`。guard 名为 `Local\\DSHComputerUse_ListViewBuffer_<PID>_<creationTime>`，故意跨路径、包版本和会话共享。先复制一个事件句柄进目标，再分配固定 8192 字节；同目标有现存事件时拒绝新分配。pending 在文本发送前置位；超时、kill、取消或文本协议错误保留缓冲/guard 至目标退出，后续读取不累积远端分配。正常完成先释放缓冲，再关闭目标句柄；释放失败保留 guard，目标句柄关闭只尝试一次，防止 Drop 重试误关复用句柄。

文本区域初始为 0xff。`ReplyMessage` 可能在实际处理结束前触发回调，返回后仍检查合法长度、首个 NUL 位置及 UTF-16 解码，成功才清除 pending。容量末尾孤立高代理只缩短一个单元得到合法前缀，其它畸形文本报错。早回复却未写文本的控件被拒绝并隔离。恶意控件先写正确文本再回复、之后继续使用指针的行为无法由这些检查证明安全；此路径依赖标准控件遵守消息协议。访问/完整性拒绝直接报告，不自动提权或改系统状态。

复现：`pnpm run smoke:listview "C:\\path\\to\\DeepSeek Harness.exe"` 跑两种位宽；末尾加 `app` 核对实际系统声音应用。所有模块和清理结束后的完成标记才是通过依据。

## 构建、部署与验收

从仓库根目录运行，Rust >=1.88：

```powershell
cargo fmt --check --manifest-path native/Cargo.toml
cargo check --manifest-path native/Cargo.toml
cargo test --manifest-path native/Cargo.toml
cargo build --release --manifest-path native/Cargo.toml
pnpm run native:stage
node scripts/check-native.mjs
node test/win32-native-expansion-smoke.mjs
```

`native:stage` 复制 target/release 产物到 native/release，并记录版本、exe SHA-256 及 Rust 源码/Cargo 文件哈希。prepack 再核对该清单，防止旧 exe 混入新源码包。

Windows 完整性标签/UIPI 限制调用权限。开发盘上 Low 标签 exe 对 Medium 目标 PrintWindow 曾报错误 5；相同字节放入本次新建的 Medium 临时目录后工作。smoke 使用这种独立部署，操作自建 WinForms 双窗口并清理。产品不会自动提权、修改 ACL/标签或搬迁；需要其它部署位置时用明确的 `nativeHelperPath`，缺失不会静默回退。

原生扩展真机验收覆盖遮挡渲染、Panel/Button 定向消息、身份拒绝、resize、键盘/Unicode、正常释放、失焦释放，以及新列表发现最小化目标后恢复。完整范围和限制见根目录 [EVIDENCE.md](../EVIDENCE.md) 与 [SECURITY.md](../SECURITY.md)。MIT；GDI 写法参考 [xland/ScreenCapture](https://github.com/xland/ScreenCapture)，出处见 [UPSTREAM.md](../references/UPSTREAM.md)。
