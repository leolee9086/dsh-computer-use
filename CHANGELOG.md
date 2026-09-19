# 变更记录

## 0.4.0

### 变更

**Windows 后端整合：PowerShell 层整体移除。**

原来 Windows 侧是三层语言混在一起：一段 C# 源码躺在 JS 模板字符串里，由每次 spawn 出来的
PowerShell 用 `Add-Type` **现场编译**，再由它转发调用；而截图和找图另有一个 Rust helper。
后果是同一件事有两份实现（提窗判据就是），改一份忘一份；每次动作都要起一个解释器进程，
它弹出的控制台还会抢走前台。现在按能力分工：

- **能直接调 Win32 的进 Rust**（`native/dsh-screen.exe`）：截图、找图、指针与键盘注入、
  窗口枚举、提窗、显示器枚举。新增 `action` / `list-windows` / `focus-window` 三个命令，
  提窗判据收敛到**一处**实现。
- **必须依赖 .NET 的走 C#，但改为进程内调用**：UI Automation 的语义树与语义动作
  放进 `src/windows-uia.cs`，由 `src/csharp.js`（通用 C# 桥，基于 edge-js）在 Node 进程内
  编译并调用 —— 不再 spawn、不再现场编译 C#。

`src/csharp.js` 是**通用桥**：只负责把任意 `.cs` 变成可调用函数（GAC 程序集路径解析、
编译缓存、并发池化、回调包 Promise），具体能力由 `.cs` 自己按 `input.kind` 分发。
它**不是**「一个 `.cs` 配一个 js」—— 那样每加一个 C# 能力都要再写一个桥文件。

**为什么池化是必须的**：一个 edge 函数实例不能并发调用，而同一个会话里可能同时有多个
工具调用在飞。池化保证它们不互相阻塞（实测并发两次 225ms；共用单实例会串行成两倍）。

**从 SAC 项目迁移的做法**：把 edge-cs 的原生 DLL 复制到纯 ASCII 路径，再用
`EDGE_CS_NATIVE` 指过去（那边的原注释：「解决 Windows 下非 ASCII 字符路径问题」）——
插件可能被装在 `C:\Users\<中文用户名>\.dsh\...` 下，不这样做每次编译都会失败。

### 移除

- `src/windows.js` 里约 540 行的 `POWER_SHELL_HELPER`（内嵌 C# + PowerShell 脚本）、
  `commandPayload` / `powershellScript` / `withPowerShellFile`，以及 `WindowsComputer.run()`。
- 对 `pwsh.exe` 的探测与依赖。**平台限定的 PowerShell 路线不再存在**，
  并由单测 `Windows backend carries no PowerShell route` 钉住。

## 0.3.0

### 新增

- **`find-image`（原生 helper 新命令）：在一屏里找一张小图，返回它的位置与相似度。**

  路由是**两层金字塔**，这是被实测逼出来的：
  - **粗筛**：降采样 4 倍 + 相似度阈值 0.7（**故意放松**）。降采样会把像素平均掉，
    逐像素对上是不可能的 —— 拿严格阈值去筛，只会一个候选都不剩。
  - **精算**：回到原分辨率，只在每个候选周围 ±4 像素的窗口里滑窗，用严格阈值。
    **只有这一层的分数进判据。**

  分数是**容差内像素数 / 总像素数**，与按键精灵、大漠插件里那个「相似度」同义 ——
  0.9 就是「九成像素对上了」。这个语义能用，恰恰因为它**不归一化**：先前用过相关系数（ZNCC），
  它先减去均值、除以标准差，于是「布局一样、内容不同」的两块区域也能拿 0.99，
  而 UI 截图里这种地方遍地都是，判据直接失效。

  其他要点：
  - **灰度化**（省掉 2/3 的比较）。
  - 模板灰度标准差低于 3 视为**纯色，当场拒绝**：纯色模板会在任何同色区域拿满分，
    那等于碰运气，而且返回的分数看起来还很自信 —— 比找不到更糟。
  - **提前退出 + 按区分度排序**：先比模板里最有辨识力的像素，不匹配数超上限就立刻换下一个位置。
  - **「找不到」是正常结果**（`found:false`、省略坐标），不是错误；错误留给「请求本身有问题」。
  - 实测：2560×1080 里找 140×140 模板 **287ms**、坐标零误差。同一任务在改成两层之前的实现下是 **158627ms**。
  - 还会回报**通过门槛的不同位置有几个**（按「距离不超过半个模板」聚类）——
    `computer_click_image` 的硬约束直接建立在这个数上。

- **三个工具把找图接到了模型手上**：`computer_screenshot` 新增 `save_to`，新增 `computer_find_image` 与 `computer_click_image`。

  - **`computer_screenshot` 的 `save_to`**：把截图写到指定路径。存下来的是**原始 PNG**，
    不是附件系统里那份给模型看的重编码副本 —— 拿副本当模板会平白掉分。
    这是三个工具串成一条链的前提：模型给不了 base64，只能给路径。
    指名窗口截图（`window_id`）同样支持它。
  - **`computer_find_image`（观测类）**：给一张模板图，回报它在哪、相似度多少、有几处。
    **找不到是正常结果**（`found:false`），不是错误。可选 `window_id`：给了就把那个窗口提到前台、
    按它此刻的实际边界搜索；这一形态会改变前台，因此算**控制类**。
  - **`computer_click_image`（控制类）**：**必须传 `window_id`**；找到、且**只找到一处**才点。
    「只找到一处」是**硬约束** —— 不止一处就**什么都不做**，把各处位置报回去，让调用方自己决定。
    刻意不做「那就取最好的那个」的降级：一个会自己拿主意去点的工具，比一个不会点的工具危险得多。
    门槛也默认更严（0.95 对 0.9）：find 看错了无非白看一眼，click 按错了就是点错东西。
    点击坐标由原生 helper 当场算出来、紧接着用掉，不存在「坐标过期」的问题。

  **唯一性的参照系是窗口内**，不是全屏：两个同型窗口并排时全屏看永远不止一处，
  而在指定窗口里就是唯一的 —— 那正是该允许点的情况。

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

- **`computer_screenshot` 的 `display_id` 从加入起就没工作过**：两套显示器枚举各说各话 ——
  `computer_status` 走的是 PowerShell 分支（`src/windows.js` 的 `{ kind: 'displays' }`），返回
  `\\.\DISPLAY1`（Windows 标准设备名）；而截图走的原生 helper 从 HMONITOR **合成**了一个 id
  （`\\?\DISPLAY<handle>`），`find_display()` 又是精确匹配 —— 于是从 `computer_status` 拿到的
  id 传过去，**必然**报「找不到显示器」。之前的验证只覆盖了 `region` + `scale`
  （它们和 `display_id` 走同一条 payload 通道，所以那条通道"看起来"是通的），把这条路径漏了。
  现在原生改用 `MONITORINFOEXW.szDevice`，id 直接就是 `\\.\DISPLAY1`，与另一套天然一致。
  实测：`display_id="\\.\DISPLAY1"` → 1920×1080，`sourceBounds = {-1920, 0, 1920, 1080}`。

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
