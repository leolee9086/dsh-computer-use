# 变更记录

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
