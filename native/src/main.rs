//! dsh-screen —— dsh-computer-use 的原生屏幕捕获 helper。
//!
//! 为什么用 Rust 重写掉原来的 PowerShell helper：
//!   1. **无 shell 启动开销**：每次截图不再付出一次 powershell.exe 的启动代价
//!   2. **类型在编译期检查**：屏幕几何、坐标、结构体字段都是强类型，
//!      不会再出现「属性取到 null 却一路算下去」这类只在运行时才暴露的问题
//!   3. **屏幕几何由系统权威提供**：用 Win32 的显示器枚举与虚拟桌面矩形，
//!      而不是依赖某个脚本层的属性（那正是原实现踩坑的地方）
//!   4. **行为可复现**：直接跑这个 exe 就能看到输入输出，不依赖宿主环境
//!
//! 通信协议与原 PowerShell helper **完全一致**，方便宿主侧平滑替换：
//!   - 参数走 argv（`screenshot --display-id ... --x ...`）
//!   - 截图参数走 stdin：base64(UTF8 JSON)
//!   - 结果走 stdout：压缩 JSON
//!
//! 关键不变量（宿主侧依赖它做坐标换算）：**回传的 sourceBounds 必须等于实际截取的区域**。
//! 宿主用「sourceBounds + 图像尺寸」的比例关系把「截图坐标」还原成「屏幕坐标」
//! （见 src/tool.js 的 mapScreenshotPoint），所以区域裁剪只要如实回报边界，
//! 点击/拖拽/滚动的坐标就自动继续正确。

use std::io::{Read, Write};
use std::process::ExitCode;

use base64::Engine as _;
use serde::{Deserialize, Serialize};
use windows::Win32::Foundation::{BOOL, LPARAM, RECT, TRUE};
use windows::Win32::Graphics::Gdi::{
    BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, EnumDisplayMonitors,
    GetDC, GetDIBits, GetMonitorInfoW, GetPixel, ReleaseDC, SelectObject, BITMAPINFO, BITMAPINFOHEADER,
    BI_RGB, CLR_INVALID, DIB_RGB_COLORS, HBITMAP, HDC, HMONITOR, MONITORINFO, ROP_CODE,
};
use windows::Win32::UI::HiDpi::{SetProcessDpiAwareness, PROCESS_PER_MONITOR_DPI_AWARE};

/* ------------------------------ 通信协议 ------------------------------ */

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ScreenshotRequest {
    #[serde(default)]
    display_id: Option<String>,
    #[serde(default)]
    region: Option<Region>,
    #[serde(default)]
    scale: Option<f64>,
    #[serde(default)]
    max_dimension: Option<i64>,
    #[serde(default)]
    max_bytes: Option<i64>,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize)]
struct Region {
    x: i32,
    y: i32,
    width: i32,
    height: i32,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DisplayInfo {
    id: String,
    name: String,
    primary: bool,
    bounds: Region,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ScreenshotResponse {
    /// base64 PNG。文件模式下不回这个字段（大块数据走文件，不进 stdout 管道）
    #[serde(skip_serializing_if = "Option::is_none")]
    png: Option<String>,
    width: u32,
    height: u32,
    /// 实际截取的屏幕区域（可能与请求的区域不同：越界部分会被裁到虚拟桌面内）
    source_bounds: Region,
    #[serde(skip_serializing_if = "Option::is_none")]
    display_id: Option<String>,
}

/// 文件模式下 stdout 回的小 JSON：只给元信息，PNG 在磁盘上
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct OutMeta {
    path: String,
    width: u32,
    height: u32,
    source_bounds: Region,
    #[serde(skip_serializing_if = "Option::is_none")]
    display_id: Option<String>,
    bytes: u64,
}

fn fail(message: impl std::fmt::Display) -> ExitCode {
    let _ = writeln!(std::io::stderr(), "dsh-screen: {message}");
    ExitCode::from(1)
}

fn write_json<T: Serialize>(value: &T) -> Result<(), String> {
    let text = serde_json::to_string(value).map_err(|e| format!("JSON 序列化失败：{e}"))?;
    let stdout = std::io::stdout();
    let mut lock = stdout.lock();
    lock.write_all(text.as_bytes()).map_err(|e| format!("写 stdout 失败：{e}"))?;
    lock.flush().map_err(|e| format!("flush stdout 失败：{e}"))?;
    Ok(())
}

/* ------------------------------ 显示器枚举 ------------------------------ */

/// 显示器条目：设备名 + 该显示器在虚拟桌面里的矩形。
/// 用 `Raw*` 前缀是提醒调用方：这里的 HWND 只在回调期间有效，不可保存。
struct RawDisplay {
    device: String,
    bounds: RECT,
}

fn device_name(handle: isize) -> String {
    // DISPLAY_DEVICE.DeviceName 是 [u16; 32]，但 Win32 的 MONITORINFOEXW.szDevice
    // 同样足够。这里用 EnumDisplayMonitors + MONITORINFOEXW 更直接；
    // 为减少依赖，改从 handle 合成一个稳定 id（见下），设备名仅做展示。
    format!("\\\\?\\DISPLAY{handle}")
}

unsafe extern "system" fn monitor_enum_proc(
    monitor: HMONITOR,
    _hdc: HDC,
    _clip: *mut RECT,
    data: LPARAM,
) -> BOOL {
    let out = &mut *(data.0 as *mut Vec<RawDisplay>);
    let mut info = MONITORINFO {
        cbSize: std::mem::size_of::<MONITORINFO>() as u32,
        ..Default::default()
    };
    if GetMonitorInfoW(monitor, &mut info).as_bool() {
        out.push(RawDisplay {
            // MONITORINFO 不含设备名，这里用显示器句柄的数值做稳定标识：
            // 在同一次系统会话里它稳定，且足以区分多屏 —— 而宿主只需要「能指回同一块屏」。
            device: device_name(monitor.0 as isize),
            bounds: info.rcMonitor,
        });
    }
    TRUE
}

fn list_displays() -> Result<Vec<DisplayInfo>, String> {
    let mut raw: Vec<RawDisplay> = Vec::new();
    unsafe {
        EnumDisplayMonitors(
            None,
            None,
            // MONITORENUMPROC 是 Option<fn>，所以要包 Some
            Some(monitor_enum_proc),
            LPARAM(&mut raw as *mut _ as isize),
        )
        .ok()
        .map_err(|e| format!("EnumDisplayMonitors 失败：{e}"))?;
    }
    if raw.is_empty() {
        return Err("枚举不到任何显示器".into());
    }
    // 与「虚拟桌面」原点的关系用来判定主显示器：主显示器左上角通常就是原点
    let min_x = raw.iter().map(|d| d.bounds.left).min().unwrap_or(0);
    let min_y = raw.iter().map(|d| d.bounds.top).min().unwrap_or(0);
    Ok(raw
        .into_iter()
        .map(|d| DisplayInfo {
            name: d.device.clone(),
            id: d.device,
            primary: d.bounds.left == min_x && d.bounds.top == min_y,
            bounds: Region {
                x: d.bounds.left,
                y: d.bounds.top,
                width: d.bounds.right - d.bounds.left,
                height: d.bounds.bottom - d.bounds.top,
            },
        })
        .collect())
}

/// 虚拟桌面矩形 = 所有显示器矩形的并集。
/// 自己求并集而不是查某个「VirtualScreen」属性：并集是定义，不会因 API 差异而变。
fn virtual_screen() -> Result<Region, String> {
    let displays = list_displays()?;
    union_of(&displays)
}

fn union_of(displays: &[DisplayInfo]) -> Result<Region, String> {
    let left = displays.iter().map(|d| d.bounds.x).min().ok_or("没有显示器")?;
    let top = displays.iter().map(|d| d.bounds.y).min().ok_or("没有显示器")?;
    let right = displays.iter().map(|d| d.bounds.x + d.bounds.width).max().ok_or("没有显示器")?;
    let bottom = displays.iter().map(|d| d.bounds.y + d.bounds.height).max().ok_or("没有显示器")?;
    Ok(Region { x: left, y: top, width: right - left, height: bottom - top })
}

/// 按设备 id 找显示器；顺带回传它的矩形，用于「指定显示器整屏截图」
fn find_display(id: &str) -> Result<DisplayInfo, String> {
    let displays = list_displays()?;
    displays
        .into_iter()
        .find(|d| d.id == id)
        .ok_or_else(|| format!("找不到显示器 '{id}'"))
}

/* ------------------------------ 屏幕捕获 ------------------------------ */

/// 阶段打点：只在设了 DSH_SCREEN_DEBUG 时输出到 stderr。
/// 这个 helper 出过一次「screenshot 挂死」，就是靠这些打点定位到具体阶段的，
/// 所以保留下来当常驻排查手段（默认静默，不影响正常使用）。
fn trace(label: &str) {
    if std::env::var_os("DSH_SCREEN_DEBUG").is_some() {
        let _ = writeln!(std::io::stderr(), "[dsh-screen] {label}");
    }
}

fn capture(request: &ScreenshotRequest) -> Result<ScreenshotResponse, String> {
    // DPI 感知必须在任何坐标查询之前设置：
    // 否则在缩放显示器（125%/150%）上，系统回报的是「逻辑像素」，
    // 会导致截到的区域比请求的小一圈 —— 这类偏差在截图上看不出来，但坐标会错。
    trace("1 设置 DPI 感知");
    unsafe {
        // 用 PER_MONITOR 而不是 SYSTEM：多屏不同缩放率时，前者按显示器各自换算，
        // 后者只按主屏算，副屏坐标会偏。返回 Err 说明感知已被设置过，属正常，忽略即可。
        let _ = SetProcessDpiAwareness(PROCESS_PER_MONITOR_DPI_AWARE);
    }

    trace("2 枚举显示器");
    let displays = list_displays()?;
    let virtual_rect = union_of(&displays)?;
    trace(&format!(
        "  虚拟桌面 {}x{} @ ({}, {})，共 {} 块屏",
        virtual_rect.width, virtual_rect.height, virtual_rect.x, virtual_rect.y, displays.len()
    ));

    // 源区域决策：
    //   1) 给了 region 就用它（虚拟桌面坐标，允许负值：副屏可能位于原点左侧/上方）
    //   2) 否则给了 display_id 就用那块屏的整屏
    //   3) 都没有 = 整个虚拟桌面
    let (requested, display_id) = match (&request.region, &request.display_id) {
        (Some(r), _) => (*r, None),
        (None, Some(id)) => {
            let d = find_display(id)?;
            (d.bounds, Some(d.id))
        }
        (None, None) => (virtual_rect, None),
    };

    if requested.width < 1 || requested.height < 1 {
        return Err("截图区域的宽高必须 >= 1".into());
    }

    // 与虚拟桌面求交：请求区域可能越界（多屏坐标算错、窗口贴边）。
    // 越界部分直接 BitBlt 会得到黑边，那不是「屏幕内容」，所以裁掉并如实回报实际区域。
    let left = requested.x.max(virtual_rect.x);
    let top = requested.y.max(virtual_rect.y);
    let right = (requested.x + requested.width).min(virtual_rect.x + virtual_rect.width);
    let bottom = (requested.y + requested.height).min(virtual_rect.y + virtual_rect.height);
    if right <= left || bottom <= top {
        return Err(format!(
            "请求的截图区域完全落在虚拟桌面之外（虚拟桌面 {}x{} @ ({}, {})）",
            virtual_rect.width, virtual_rect.height, virtual_rect.x, virtual_rect.y
        ));
    }
    let crop = Region { x: left, y: top, width: right - left, height: bottom - top };

    trace(&format!("3 开始抓屏 区域 {}x{} @ ({}, {})", crop.width, crop.height, crop.x, crop.y));
    let pixels = grab_screen(crop)?;
    trace(&format!("4 抓屏完成，像素 {} 字节", pixels.len()));

    // 缩放两段算，而不是合并成一个倍率：
    // 先应用调用方要求的 scale（放大看小字），再受 maxDimension 限制缩小。
    // 分开算的好处是「请求 2 倍放大」在尺寸允许时真的得到 2 倍，而不是被悄悄改成别的倍率。
    let user_scale = request.scale.filter(|s| *s > 0.0).unwrap_or(1.0);
    let after_user_w = ((crop.width as f64 * user_scale).round() as u32).max(1);
    let after_user_h = ((crop.height as f64 * user_scale).round() as u32).max(1);

    let max_dimension = request.max_dimension.unwrap_or(1920).max(1) as u32;
    let clamp = (max_dimension as f64 / after_user_w as f64)
        .min(max_dimension as f64 / after_user_h as f64)
        .min(1.0);
    let out_w = ((after_user_w as f64 * clamp).round() as u32).max(1);
    let out_h = ((after_user_h as f64 * clamp).round() as u32).max(1);

    let rgba = image::RgbaImage::from_raw(crop.width as u32, crop.height as u32, pixels)
        .ok_or("位图缓冲区尺寸与区域不符")?;
    trace(&format!("5 组装 RgbaImage 完成，输出目标 {}x{}", out_w, out_h));
    let final_image = if out_w != crop.width as u32 || out_h != crop.height as u32 {
        let r = image::imageops::resize(&rgba, out_w, out_h, image::imageops::FilterType::Lanczos3);
        trace("6 缩放完成");
        r
    } else {
        rgba
    };

    trace("7 开始 PNG 编码");
    let mut png: Vec<u8> = Vec::new();
    image::DynamicImage::ImageRgba8(final_image)
        .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
        .map_err(|e| format!("PNG 编码失败：{e}"))?;
    trace(&format!("8 PNG 编码完成，{} 字节", png.len()));

    if let Some(max_bytes) = request.max_bytes {
        if png.len() as i64 > max_bytes {
            return Err(format!(
                "截图 PNG 体积 {} 字节，超过上限 {} 字节",
                png.len(), max_bytes
            ));
        }
    }

    Ok(ScreenshotResponse {
        png: Some(base64::engine::general_purpose::STANDARD.encode(&png)),
        width: out_w,
        height: out_h,
        source_bounds: crop,
        display_id,
    })
}

/// 用 GDI 抓取指定区域的像素，返回 RGBA8。
fn grab_screen(crop: Region) -> Result<Vec<u8>, String> {
    unsafe {
        let screen_dc = GetDC(None);
        if screen_dc.is_invalid() {
            return Err("GetDC 失败".into());
        }
        // 用闭包包住是为了保证异常路径也释放 GDI 对象：GDI 句柄泄漏在长驻进程里会累积成故障
        let result = (|| -> Result<Vec<u8>, String> {
            trace("  3.1 GetDC 完成");
            let mem_dc = CreateCompatibleDC(screen_dc);
            if mem_dc.is_invalid() {
                return Err("CreateCompatibleDC 失败".into());
            }
            trace("  3.2 CreateCompatibleDC 完成");
            let bitmap = CreateCompatibleBitmap(screen_dc, crop.width, crop.height);
            if bitmap.is_invalid() {
                let _ = DeleteDC(mem_dc);
                return Err("CreateCompatibleBitmap 失败".into());
            }
            trace("  3.3 CreateCompatibleBitmap 完成");
            let previous = SelectObject(mem_dc, bitmap);

            // ROP 用纯 SRCCOPY（0x00CC0020）。
            //
            // 刻意**不加 CAPTUREBLT**：它文档上的用途是「把分层窗口也抓进来」，
            // 但在部分 GPU/DWM 组合下会让 BitBlt 静默产出全黑位图（GetDIBits 拿回全 0，
            // 而同一时刻 GetPixel 逐点读屏幕却有内容 —— 这个现象就是本机实测到的）。
            // 参考实现 xland/ScreenCapture（MIT）三处抓屏一律只用 SRCCOPY，以它为准。
            let rop = ROP_CODE(0x00CC_0020);
            trace("  3.4 开始 BitBlt");
            let blit = BitBlt(
                mem_dc,
                0,
                0,
                crop.width,
                crop.height,
                screen_dc,
                crop.x,
                crop.y,
                rop,
            );
            trace(&format!("  3.5 BitBlt 返回 ok={}", blit.is_ok()));

            let pixels = if blit.is_err() {
                Err("BitBlt 失败".into())
            } else {
                let r = read_bitmap_pixels(mem_dc, bitmap, crop.width, crop.height);
                trace(&format!("  3.6 GetDIBits 完成 ok={}", r.is_ok()));
                r
            };

            // 清理顺序：先恢复原对象，再删位图与 DC
            SelectObject(mem_dc, previous);
            // HBITMAP 实现了 CanInto<HGDIOBJ>，DeleteObject 是泛型参数，直接传即可
            let _ = DeleteObject(bitmap);
            let _ = DeleteDC(mem_dc);
            pixels
        })();

        let _ = ReleaseDC(None, screen_dc);
        result
    }
}

/// 从 DIB 读出像素并转成 RGBA8（GDI 给的是 BGRA）
fn read_bitmap_pixels(dc: HDC, bitmap: HBITMAP, width: i32, height: i32) -> Result<Vec<u8>, String> {
    let stride = width * 4;
    let mut info = BITMAPINFO {
        bmiHeader: BITMAPINFOHEADER {
            biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: width,
            // 负高度 = 请求自上而下排列的 DIB，省掉手工翻行
            biHeight: -height,
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB.0,
            // biSizeImage 对 BI_RGB 不是必需，但显式给上更稳（有些驱动会读它）
            biSizeImage: (stride * height) as u32,
            ..Default::default()
        },
        ..Default::default()
    };
    let mut buffer = vec![0u8; (stride * height) as usize];

    let scanned = unsafe {
        GetDIBits(
            // 传内存 DC（xland 的参考实现也是这么传的，实测在本机可用）。
            // 注意 MSDN 文档说的是「lpvBits 非空时 hdc 必须为 NULL」，
            // 但实测传 NULL 会直接返回 0（失败），而传创建该位图的内存 DC 才能读到像素。
            // 以实测为准 —— 这类 GDI 行为在不同驱动上确实存在差异。
            dc,
            bitmap,
            0,
            height as u32,
            Some(buffer.as_mut_ptr() as *mut _),
            &mut info,
            DIB_RGB_COLORS,
        )
    };
    if scanned == 0 {
        return Err("GetDIBits 失败".into());
    }

    trace(&format!(
        "  3.6.1 GetDIBits 扫描行数={scanned}，首像素 BGRA=({},{},{},{})",
        buffer[0], buffer[1], buffer[2], buffer[3]
    ));

    // BGRA -> RGBA，同时把 alpha 强制为不透明：
    // 屏幕像素的 alpha 通道在 GDI 里通常是 0，直接当 alpha 用会得到全透明图。
    for pixel in buffer.chunks_exact_mut(4) {
        pixel.swap(0, 2);
        pixel[3] = 255;
    }

    trace(&format!(
        "  3.6.2 转换后首像素 RGBA=({},{},{},{})",
        buffer[0], buffer[1], buffer[2], buffer[3]
    ));
    Ok(buffer)
}

/* ------------------------------ 入口 ------------------------------ */

/// 解析 `--key value` 形式的位置参数，返回 (命令, 参数表)
fn parse_args(argv: Vec<String>) -> (String, std::collections::HashMap<String, String>) {
    let mut iter = argv.into_iter();
    let command = iter.next().unwrap_or_default();
    let mut flags = std::collections::HashMap::new();
    let mut pending: Option<String> = None;
    for token in iter {
        if let Some(key) = pending.take() {
            flags.insert(key, token);
            continue;
        }
        if let Some(key) = token.strip_prefix("--") {
            pending = Some(key.to_string());
        }
    }
    (command, flags)
}

fn flag_i32(flags: &std::collections::HashMap<String, String>, key: &str) -> Option<i32> {
    flags.get(key).and_then(|v| v.parse().ok())
}

fn flag_f64(flags: &std::collections::HashMap<String, String>, key: &str) -> Option<f64> {
    flags.get(key).and_then(|v| v.parse().ok())
}

/// 从 stdin 读请求（base64(UTF8 JSON)），再用 argv 里的同名参数覆盖。
///
/// 为什么保留 stdin 这条路：宿主在只需小参数时直接管道传很省事；
/// 但**大块结果（PNG）绝不要走 stdout 管道** —— 那条路在 Windows 上会因
/// 管道缓冲区被填满且读取方状态不明而挂死（这个坑真实踩过，见 PROGRESS 记录）。
/// 所以截图的大数据一律落文件，stdout 只回小 JSON。
fn read_request(flags: &std::collections::HashMap<String, String>) -> Result<ScreenshotRequest, String> {
    let mut raw = String::new();
    std::io::stdin()
        .read_to_string(&mut raw)
        .map_err(|e| format!("读取 stdin 失败：{e}"))?;

    let trimmed = raw.trim();
    let mut request: ScreenshotRequest = if trimmed.is_empty() {
        // 允许完全不传 stdin（全部参数走 argv）
        ScreenshotRequest { display_id: None, region: None, scale: None, max_dimension: None, max_bytes: None }
    } else {
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(trimmed)
            .map_err(|e| format!("stdin 不是合法 base64：{e}"))?;
        let text = String::from_utf8(decoded)
            .map_err(|e| format!("base64 解出的内容不是 UTF-8：{e}"))?;
        serde_json::from_str(&text)
            .map_err(|e| format!("请求 JSON 解析失败：{e}（原文：{text}）"))?
    };

    // argv 覆盖 stdin：这样宿主可以「stdin 传大对象、argv 微调单个字段」
    if let (Some(x), Some(y), Some(w), Some(h)) = (
        flag_i32(flags, "x"),
        flag_i32(flags, "y"),
        flag_i32(flags, "width"),
        flag_i32(flags, "height"),
    ) {
        request.region = Some(Region { x, y, width: w, height: h });
    }
    if let Some(id) = flags.get("display-id") {
        request.display_id = Some(id.clone());
    }
    if let Some(scale) = flag_f64(flags, "scale") {
        request.scale = Some(scale);
    }
    if let Some(max) = flag_i32(flags, "max-dimension") {
        request.max_dimension = Some(max as i64);
    }
    if let Some(max) = flag_i32(flags, "max-bytes") {
        request.max_bytes = Some(max as i64);
    }
    Ok(request)
}

/// 文件模式：PNG 直接写进 `--out`，stdout 只回小 JSON。
/// 这是宿主应该用的模式 —— 大块二进制不进管道，从根上避开挂死。
fn screenshot_to_files(flags: &std::collections::HashMap<String, String>) -> ExitCode {
    let request = match read_request(flags) {
        Ok(r) => r,
        Err(e) => return fail(e),
    };
    let out_path = match flags.get("out") {
        Some(p) => p.clone(),
        None => return fail("文件模式需要 --out <png 路径>"),
    };

    let response = match capture(&request) {
        Ok(r) => r,
        Err(e) => return fail(e),
    };

    // 先解码再写文件：写盘失败要如实报错，不能留下半截文件
    let png_b64 = match response.png.as_deref() {
        Some(s) => s,
        None => return fail("内部错误：capture 没有返回 PNG 数据"),
    };
    let bytes = match base64::engine::general_purpose::STANDARD.decode(png_b64) {
        Ok(b) => b,
        Err(e) => return fail(format!("PNG base64 解码失败：{e}")),
    };
    if let Err(e) = std::fs::write(&out_path, &bytes) {
        return fail(format!("写入 {out_path} 失败：{e}"));
    }
    trace(&format!("9 已写盘 {out_path}（{} 字节）", bytes.len()));

    // stdout 只回小 JSON（不含 png 字段）
    let meta = OutMeta {
        path: out_path,
        width: response.width,
        height: response.height,
        source_bounds: response.source_bounds,
        display_id: response.display_id,
        bytes: bytes.len() as u64,
    };
    match write_json(&meta) {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => fail(e),
    }
}

/// 标准模式：PNG 以 base64 放进 stdout 的 JSON 里（供小图/兼容老调用方使用）
fn screenshot_to_stdout(flags: &std::collections::HashMap<String, String>) -> ExitCode {
    let request = match read_request(flags) {
        Ok(r) => r,
        Err(e) => return fail(e),
    };
    match capture(&request) {
        Ok(response) => match write_json(&response) {
            Ok(()) => ExitCode::SUCCESS,
            Err(e) => fail(e),
        },
        Err(e) => fail(e),
    }
}

fn main() -> ExitCode {
    let (command, flags) = parse_args(std::env::args().skip(1).collect());

    match command.as_str() {
        "list-displays" => {
            unsafe {
                // 用 PER_MONITOR 而不是 SYSTEM：多屏不同缩放率时，前者按显示器各自换算，
        // 后者只按主屏算，副屏坐标会偏。返回 Err 说明感知已被设置过，属正常，忽略即可。
        let _ = SetProcessDpiAwareness(PROCESS_PER_MONITOR_DPI_AWARE);
            }
            match list_displays() {
                Ok(displays) => match write_json(&displays) {
                    Ok(()) => ExitCode::SUCCESS,
                    Err(e) => fail(e),
                },
                Err(e) => fail(e),
            }
        }
        "screenshot" => {
            let use_files = flags.contains_key("out") || flags.contains_key("out-meta");
            if use_files {
                return screenshot_to_files(&flags);
            }
            screenshot_to_stdout(&flags)
        }
        "probe-pixels" => {
            // 排查用：拿 GetPixel 直接读几个点，与 GetDIBits 的缓冲区对比。
            // 用途：区分「屏幕真的是黑的」和「缓冲区里全是 0（读法/格式不对）」。
            // GetPixel 是逐点查询、不依赖 DIB 布局，所以它是可信的对照组。
            unsafe {
                let _ = SetProcessDpiAwareness(PROCESS_PER_MONITOR_DPI_AWARE);
                let dc = GetDC(None);
                if dc.is_invalid() {
                    return fail("GetDC 失败");
                }
                let points = [
                    (200, 200), (900, 400), (60, 20), (1000, 1000),
                    (2000, 500), (2700, 400), (-1800, 500),
                ];
                for (x, y) in points {
                    // GetPixel 返回 ColorRef 包装类型，.0 取出裸 u32；CLR_INVALID 本身就是 u32
                    let raw = GetPixel(dc, x, y).0;
                    if raw == CLR_INVALID {
                        println!("({x},{y}) GetPixel=CLR_INVALID");
                    } else {
                        let r = raw & 0xFF;
                        let g = (raw >> 8) & 0xFF;
                        let b = (raw >> 16) & 0xFF;
                        println!("({x},{y}) GetPixel rgb=({r},{g},{b}) raw=0x{raw:08X}");
                    }
                }
                let _ = ReleaseDC(None, dc);
            }
            ExitCode::SUCCESS
        }
        "" => fail("用法：dsh-screen <list-displays|screenshot|probe-pixels> [--x N --y N --width N --height N]"),
        other => fail(format!("未知命令 '{other}'（支持 list-displays / screenshot / probe-pixels）")),
    }
}
