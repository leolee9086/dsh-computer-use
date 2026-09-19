# dsh-screen —— 原生桌面 helper

`dsh-computer-use` 的 Windows 后端。一个单文件 exe（约 610KB），不依赖脚本解释器、不依赖运行时。

**为什么这些能力要做成原生程序：**

1. **省掉每次动作的进程启动代价** —— 原先每次都要起一次 `powershell.exe`，那是这条路径最大的固定开销
2. **系统调用写在强类型代码里** —— 不再出现「脚本层属性取到 null 却一路算下去」这类只在运行时才暴露的问题
3. **能自己决定 ROP、裁剪、缩放与输入标志** —— 不受脚本层表达能力限制

## 通信协议

命令走 argv，请求体走 stdin（`base64(UTF-8 JSON)`），结果走 stdout（压缩 JSON）。

> **需要请求体的命令必须喂 stdin。** 不喂它会一直等下去（协议是先读请求体再干活），
> 表现就是调用方挂住不返回。

```
dsh-screen list-displays
  → stdout: [{"id":"…","name":"…","primary":false,"bounds":{…}}]

dsh-screen list-windows
  → stdout: [{"id":"…","title":"…","processId":…,"application":"…","focused":false,"bounds":{…}}]

dsh-screen focus-window
  stdin : {"id":"…","processId":…,"title":"…"}
  stdout: {"ok":true}

dsh-screen action
  stdin : {"action":{"kind":"click","x":…,"y":…,"button":"left","clickCount":1,"delayMs":0},"focus":{…}}
  stdout: {"ok":true}

dsh-screen screenshot --out shot.png
  stdin : base64(UTF-8 JSON) 请求
  stdout: {"path":"shot.png","width":…,"height":…,"sourceBounds":{…},"bytes":…}

dsh-screen find-image
  stdin : {"templatePng":"<base64>","threshold":…,"tolerance":…,…}
  stdout: {"found":true,"x":…,"y":…,"score":…,"matchCount":1,"matches":[…]}
```

`action` 的六种动作是 `move` / `click` / `drag` / `scroll` / `type` / `key`，
字段名一律 camelCase，与宿主侧 `actionPayload` 一一对应。带 `focus` 时**先按身份提窗再注入** ——
两者必须在同一次进程调用里完成，否则第二次 spawn 冒出来的控制台会抢走前台，按键就落错了地方。

`focus-window` 只校验身份（句柄 + 进程 + 标题前缀），**不比对列出时刻的旧边界**：
窗口被移动过并不代表换了一个窗口，拿旧边界去校验会让一次本该成功的聚焦直接失败。

请求字段（全部可选）：

| 字段 | 说明 |
|---|---|
| `displayId` | 显示器 id（来自 `list-displays`）。省略则用整个虚拟桌面 |
| `region` | `{x, y, width, height}`，虚拟桌面坐标，**允许负值**（副屏可能在原点左侧/上方） |
| `scale` | 缩放倍数，1 = 原始像素，2 = 放大 2 倍（用于看清小字） |
| `maxDimension` | 输出图像最长边上限，默认 1920 |
| `maxBytes` | PNG 体积上限，超限报错 |

argv 里的 `--x/--y/--width/--height/--display-id/--scale/--max-dimension/--max-bytes` 会覆盖 stdin 中的同名字段。

### 为什么 PNG 走文件而不是 stdout

早期版本让 helper 把 base64 PNG 打在 stdout 上，结果在 Windows 上会**长时间不返回**
（大块数据塞进管道，读取方状态不明）。所以现在始终用 `--out`，stdout 只回一个小 JSON。
宿主侧 `nativeScreenshot()` 也是这么调的。

## 关键不变量

**回传的 `sourceBounds` 必须等于实际截取的区域。**

宿主用「`sourceBounds` + 图像尺寸」的比例关系把「截图坐标」还原成「屏幕坐标」
（见 `../src/tool.js` 的 `mapScreenshotPoint`）。所以区域裁剪只要如实回报边界，
点击／拖拽／滚动的坐标就自动继续正确。请求区域超出虚拟桌面时会被裁到桌面内，
此时回报的是**裁剪后**的真实边界。

## 两个必须记住的 GDI 坑

这两条都是实测踩出来的，写在这里免得重犯：

1. **`BitBlt` 的 ROP 不能带 `CAPTUREBLT`**（0x40CC0020）。
   它文档上的用途是「把分层窗口也抓进来」，但在部分 GPU/DWM 组合下会让 BitBlt
   **静默产出全黑位图**（`GetDIBits` 拿回全 0）。参考实现
   [xland/ScreenCapture](https://github.com/xland/ScreenCapture)（MIT）三处抓屏一律只用
   `SRCCOPY`（0x00CC0020）。
2. **`GetDIBits` 的 `hdc` 要传创建该位图的内存 DC**。
   MSDN 说「`lpvBits` 非空时 `hdc` 必须为 NULL」，但实测传 NULL 直接返回 0（失败）。
   以实测为准 —— 这类 GDI 行为在不同驱动上确实存在差异。

排查手段：**`GetPixel` 逐点读屏幕是可信对照组**（不依赖 DIB 布局）。
当初就是靠「GetPixel 有内容、GetDIBits 缓冲区全 0」这一对比，才确定是读法问题而非屏幕真黑。

## 调试

设 `DSH_SCREEN_DEBUG=1` 会把各阶段耗时打点到 stderr：

```
[dsh-screen] 1 设置 DPI 感知
[dsh-screen] 3 开始抓屏 区域 400x300 @ (200, 200)
[dsh-screen]   3.5 BitBlt 返回 ok=true
[dsh-screen]   3.6.1 GetDIBits 扫描行数=300，首像素 BGRA=(12,12,12,255)
[dsh-screen] 8 PNG 编码完成，3270 字节
```

## 自行构建

```powershell
cd native
cargo build --release
# 产物：native/target/release/dsh-screen.exe
```

要求 rustc ≥ 1.88（`image` 依赖的 MSRV）。若工具链落后，先 `rustup update stable`。

> 注意：**rustup 不读取 Windows 的系统代理设置**。在需要代理的网络里要显式给环境变量，
> 否则下载会慢到像是卡死：
> ```powershell
> $env:HTTPS_PROXY = 'http://127.0.0.1:7890'; rustup update stable
> ```

构建完成后把 exe 复制到 `native/release/`，这样宿主侧的路径探测能直接找到它。

## 验收

```powershell
node test-screen.mjs      # 覆盖显示器枚举、区域截图、越界裁剪、scale、maxDimension
```

## 许可

MIT。GDI 抓屏的写法参考了 [xland/ScreenCapture](https://github.com/xland/ScreenCapture)（MIT），
详见仓库根目录的 `LICENSE` 与 `EVIDENCE.md`。
