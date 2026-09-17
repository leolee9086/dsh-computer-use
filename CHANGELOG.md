# 变更记录

## 未发布

### 新增

- `computer_screenshot` 支持 `window_id`：**一步完成「把窗口提到前台 + 按它此刻的实际边界截图」**，
  所以被别的窗口盖住的窗口也能正确截到。该形态会改变前台，因此按**控制类**审批，
  而不是沿用「观测」那一档。返回值带 `window`（id / 标题），模型可见文本会写明「这张图是把该窗口提到前台换来的」。

  聚焦时只校验身份（窗口句柄 + 进程 + 标题），**不比对列出时的边界** —— 窗口被移动过不代表换了一个窗口；
  原来的做法拿列表时刻的边界做校验，会让一次本该成功的截图直接失败。边界改为在聚焦之后实时读取。

  聚焦与抓屏**在同一次原生 helper 调用内完成**（`dsh-screen.exe screenshot` 新增 `focus` 参数），刻意不拆成两步：
  宿主每 spawn 一次子进程，Windows 就会把宿主所在的控制台窗口提到前台；拆成两次调用时，
  第二次启动冒出来的控制台窗口会正好盖住刚被提到前面的目标，截回来的就是那个控制台。合并成一次后，
  弹窗只发生在进程启动那一刻，紧接着目标被提到前台把它盖住，抓到的就是目标本身（Windows 上实测通过）。

  平台支持：**Windows 可用**。macOS / Linux 的后端目前只能截取整个虚拟桌面（没有区域截图能力），
  调用会明确报错，不会静默交回一张整屏图。

### 修复

- **`computer_screenshot` 的整条工具消息在 GUI 里不显示**：`src/client.js` 全程用大写 `React.*`，
  而该模块只定义了 `let react = require("react")`，渲染时抛 `ReferenceError`，整张工具卡连带整条消息一起消失。
  现已统一为小写并加注释（`3f5da40` 引入）。
- **原生 helper 收到的 payload 恒为空，`region` / `display_id` / `scale` 三个参数全部静默失效**：
  `src/runner.js` 把批式 stdin 写成 `{ text }`，而 DSH 的 `SubprocessStdinMode` 是
  `'ignore' | 'pipe' | { readonly data: string }`，实现侧执行 `stdin.end(stdinMode.data)` ——
  `data` 是 `undefined`，管道被立刻关闭。此前「整屏截图一直正常」只是因为整屏本来就是默认行为
  （同样是 `3f5da40` 引入）。已补 `test/runner.test.js` 断言 `stdio.stdin` 形态的回归测试。

## 0.2.0

### 新增：区域截图与原生截图 helper

- `computer_screenshot` 支持 **截取屏幕的一部分**，不再只能整屏／整显示器：
  - `x` / `y` / `width` / `height` —— 捕获区域（虚拟桌面坐标，允许负值）
  - `scale` —— 裁剪后缩放倍数，用于放大看清小字
  - 越界区域自动裁到虚拟桌面内，并**如实回报真实边界**
- Windows 截图改为调用原生 helper `native/dsh-screen.exe`（Rust + Win32 GDI，单文件约 390KB）：
  - 不必再为每次截图付一次 `powershell.exe` 的启动代价
  - 屏幕几何与像素读取进入强类型代码，消除「脚本层属性取到 null 却继续运算」这类问题
  - 移除旧的 PowerShell 截图脚本分支（**不做回退**：两条实现都要维护、测试覆盖不到，
    用户也不知道自己实际在用哪个）

### 内部

- `runner.run()` 支持向子进程写入 stdin（原生 helper 用它传请求参数）
- 新增 `native/README.md`：协议说明、`sourceBounds` 不变量、两个 GDI 坑、调试与构建方式

### 需要留意的行为变化

- **找不到原生 helper 时截图会直接报错**，并提示构建方式；不再静默回退。
  从源码安装的用户需要先 `cd native && cargo build --release`。
- 抓屏 ROP 改为纯 `SRCCOPY`（去掉 `CAPTUREBLT`）：修掉了部分 GPU/DWM 组合下
  **整张截图全黑**的问题。代价是极少数分层窗口（个别悬浮窗／输入法候选框）
  可能不出现在截图里。

## 0.1.0

- 初始版本：Windows / macOS / Linux 三平台桌面自动化的独立 Cordis 插件集合。
- 观察类工具：`computer_screenshot`、`computer_status`、`computer_windows`、
  `computer_accessibility`、`computer_find`。
- 控制类工具：`computer_click`、`computer_drag`、`computer_scroll`、`computer_type`、
  `computer_key`、`computer_element`。
