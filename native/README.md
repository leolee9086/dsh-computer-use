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
| `find-image` | `templatePng/threshold/tolerance/region?/…` | `found/x/y/score/matchCount/matches/…` |
| `child-windows` | `{window,maxNodes}` | 子 HWND `windows` 与 `truncated` |
| `window-message` | `{window,child,action}` | `delivered/applicationResultVerified/foregroundChanged` |
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

`child-windows` 最大 512 节点。子记录包含 `id,parentId,rootId,processId,className,title,visible,enabled,bounds,clientBounds`；客户区边界给出当前屏幕原点和尺寸。

`window-message` 接受枚举出的完整 child 身份，固定 action 为 `{kind:"click",x,y,button}` 或 `{kind:"scroll",x,y,deltaX,deltaY}`。坐标是**子窗口客户区物理像素**，不是 screenshot 像素。再次核对 root/parent/PID/class/title，消息使用 SendMessageTimeoutW 500ms；不接受任意消息编号。helper 不请求前台或移动全局指针，但应用可在处理消息时自行激活。`foregroundChanged` 是实际测量，`delivered:true` 不证明业务结果。

`manage-window` action 为 move(x/y)、resize(width/height)、minimize/maximize/restore/close。move/resize 使用 NOACTIVATE/NOZORDER；其它窗口状态可能影响前台。close 只投递 WM_CLOSE，应用可能拒绝或弹出保存对话框。最小化后可通过新的 list-windows 记录确认状态，再明确恢复/聚焦。

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
