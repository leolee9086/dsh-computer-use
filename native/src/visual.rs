//! OCR 与找色共用有界区域捕获。window 的 region 相对完整窗口边界，每轮按新边界换算。
use super::{
    clip_to_virtual, grab_screen, list_displays, union_of, window_control, FocusTarget, Region,
};
use serde::{Deserialize, Serialize};
use std::time::{Duration, Instant};
use windows::Win32::Foundation::RECT;
use windows::Win32::UI::WindowsAndMessaging::{
    GetForegroundWindow, GetWindowRect, IsIconic, IsWindowVisible,
};

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CaptureMode {
    Screen,
    PrintWindow,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CaptureRequest {
    pub region: Region,
    pub window: Option<FocusTarget>,
    pub capture_mode: CaptureMode,
}
struct Captured {
    region: Region,
    window_bounds: Option<Region>,
    pixels: Vec<u8>,
}
fn area(region: Region) -> Result<(), String> {
    if region.width < 1
        || region.height < 1
        || i64::from(region.width) * i64::from(region.height) > 16_000_000
    {
        return Err("视觉 region 必须是正尺寸且不超过16000000像素".into());
    }
    Ok(())
}
fn absolute_region(relative: Region, window: Region) -> Result<Region, String> {
    area(relative)?;
    if relative.x < 0
        || relative.y < 0
        || i64::from(relative.x) + i64::from(relative.width) > i64::from(window.width)
        || i64::from(relative.y) + i64::from(relative.height) > i64::from(window.height)
    {
        return Err("相对 region 超出当前窗口边界".into());
    }
    Ok(Region {
        x: window.x.checked_add(relative.x).ok_or("region x 溢出")?,
        y: window.y.checked_add(relative.y).ok_or("region y 溢出")?,
        width: relative.width,
        height: relative.height,
    })
}
fn capture(request: &CaptureRequest) -> Result<Captured, String> {
    area(request.region)?;
    if let Some(target) = request.window.as_ref() {
        let handle = window_control::checked_window(target)?;
        if unsafe { IsIconic(handle) }.as_bool() || !unsafe { IsWindowVisible(handle) }.as_bool() {
            return Err("视觉观测要求可见且未最小化的窗口".into());
        }
        if request.capture_mode == CaptureMode::PrintWindow {
            let (full, pixels) = window_control::capture(target)?;
            let region = absolute_region(request.region, full)?;
            let image = image::RgbaImage::from_raw(full.width as u32, full.height as u32, pixels)
                .ok_or("后台捕获缓冲区尺寸不符")?;
            let pixels = image::imageops::crop_imm(
                &image,
                request.region.x as u32,
                request.region.y as u32,
                region.width as u32,
                region.height as u32,
            )
            .to_image()
            .into_raw();
            let mut after = RECT::default();
            unsafe { GetWindowRect(handle, &mut after) }
                .map_err(|error| format!("后台视觉边界复核: {error}"))?;
            if [
                after.left,
                after.top,
                after.right - after.left,
                after.bottom - after.top,
            ] != [full.x, full.y, full.width, full.height]
            {
                return Err("后台视觉抓取期间窗口边界已变".into());
            }
            return Ok(Captured {
                region,
                window_bounds: Some(full),
                pixels,
            });
        }
        // 纯观测不暗中提窗。指定 screen 窗口必须已经在前台，否则报错，不将遮挡物认作目标。
        if unsafe { GetForegroundWindow() } != handle {
            return Err("screen 视觉观测的目标窗口不在前台".into());
        }
        let mut rect = RECT::default();
        unsafe { GetWindowRect(handle, &mut rect) }
            .map_err(|error| format!("视觉窗口边界: {error}"))?;
        let full = Region {
            x: rect.left,
            y: rect.top,
            width: rect.right - rect.left,
            height: rect.bottom - rect.top,
        };
        let region = absolute_region(request.region, full)?;
        let virtual_rect = union_of(&list_displays()?)?;
        let clipped = clip_to_virtual(region, virtual_rect)?;
        if [region.x, region.y, region.width, region.height]
            != [clipped.x, clipped.y, clipped.width, clipped.height]
        {
            return Err("screen 视觉 region 没有完整位于虚拟桌面内".into());
        }
        let pixels = grab_screen(region)?;
        window_control::checked_window(target)?;
        let mut after = RECT::default();
        unsafe { GetWindowRect(handle, &mut after) }
            .map_err(|error| format!("视觉窗口复核: {error}"))?;
        if unsafe { GetForegroundWindow() } != handle || after != rect {
            return Err("抓取期间窗口焦点或边界已变".into());
        }
        return Ok(Captured {
            region,
            window_bounds: Some(full),
            pixels,
        });
    }
    if request.capture_mode != CaptureMode::Screen {
        return Err("print_window 视觉捕获需要 window".into());
    }
    let region = request.region;
    // 使用 i64 先检验，避免旧 clip_to_virtual 的 i32 求和遇到恶意范围溢出。
    let virtual_rect = union_of(&list_displays()?)?;
    if i64::from(region.x) < i64::from(virtual_rect.x)
        || i64::from(region.y) < i64::from(virtual_rect.y)
        || i64::from(region.x) + i64::from(region.width)
            > i64::from(virtual_rect.x) + i64::from(virtual_rect.width)
        || i64::from(region.y) + i64::from(region.height)
            > i64::from(virtual_rect.y) + i64::from(virtual_rect.height)
    {
        return Err("视觉 region 没有完整位于虚拟桌面内".into());
    }
    Ok(Captured {
        region,
        window_bounds: None,
        pixels: grab_screen(region)?,
    })
}
fn budget(value: u64) -> Result<Duration, String> {
    if !(1..=120_000).contains(&value) {
        return Err("视觉 budgetMs 必须是1..120000".into());
    }
    Ok(Duration::from_millis(value))
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ColorRequest {
    pub capture: CaptureRequest,
    pub rgb: [u8; 3],
    pub tolerance: u8,
    pub direction: super::color_search::Direction,
    pub budget_ms: u64,
    pub max_pixels: u64,
    pub max_samples: usize,
}
#[derive(Debug, Serialize)]
pub struct ColorSpot {
    pub x: i32,
    pub y: i32,
    pub rgb: [u8; 3],
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ColorResponse {
    pub found: bool,
    pub status: &'static str,
    pub coverage: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stop_reason: Option<&'static str>,
    pub searched: Region,
    pub capture_mode: CaptureMode,
    pub window_bounds: Option<Region>,
    pub rgb: [u8; 3],
    pub tolerance: u8,
    pub direction: super::color_search::Direction,
    pub visited_pixels: u64,
    pub total_pixels: u64,
    pub matching_pixels: u64,
    pub samples: Vec<ColorSpot>,
    pub elapsed_ms: u64,
}
pub fn find_color(request: &ColorRequest) -> Result<ColorResponse, String> {
    let started = Instant::now();
    let budget = budget(request.budget_ms)?;
    if !(1..=100_000_000).contains(&request.max_pixels) || !(1..=32).contains(&request.max_samples)
    {
        return Err("找色像素/样本预算无效".into());
    }
    let captured = capture(&request.capture)?;
    let scan = super::color_search::scan(
        &captured.pixels,
        captured.region.width as u32,
        captured.region.height as u32,
        request.rgb,
        request.tolerance,
        request.direction,
        request.max_pixels,
        request.max_samples,
        || started.elapsed() >= budget,
    )?;
    let complete = scan.stop_reason.is_none();
    // Pixel 使用有符号屏幕坐标，负原点的副屏不能被强制转成无符号。
    Ok(ColorResponse {
        found: scan.count > 0,
        status: if !complete {
            "incomplete"
        } else if scan.count > 0 {
            "found"
        } else {
            "not_found"
        },
        coverage: if complete { "complete" } else { "partial" },
        stop_reason: scan.stop_reason,
        searched: captured.region,
        capture_mode: request.capture.capture_mode,
        window_bounds: captured.window_bounds,
        rgb: request.rgb,
        tolerance: request.tolerance,
        direction: request.direction,
        visited_pixels: scan.visited,
        total_pixels: scan.total,
        matching_pixels: scan.count,
        samples: scan
            .samples
            .into_iter()
            .map(|p| ColorSpot {
                x: captured.region.x + p.x as i32,
                y: captured.region.y + p.y as i32,
                rgb: p.rgb,
            })
            .collect(),
        elapsed_ms: started.elapsed().as_millis() as u64,
    })
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OcrRequest {
    pub capture: CaptureRequest,
    pub scale: f64,
    pub language: Option<String>,
    pub max_words: usize,
    pub max_chars: usize,
    pub budget_ms: u64,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OcrResponse {
    #[serde(flatten)]
    pub result: super::ocr::Response,
    pub capture_mode: CaptureMode,
    pub window_bounds: Option<Region>,
}
pub fn recognize(request: &OcrRequest) -> Result<OcrResponse, String> {
    let started = Instant::now();
    let budget = budget(request.budget_ms)?;
    // 参数错误先于窗口或像素操作。
    if !request.scale.is_finite()
        || !(1.0..=4.0).contains(&request.scale)
        || !(1..=2000).contains(&request.max_words)
        || !(1..=64000).contains(&request.max_chars)
    {
        return Err("OCR scale/word/character 参数无效".into());
    }
    let captured = capture(&request.capture)?;
    let result = super::ocr::recognize(
        captured.pixels,
        captured.region,
        request.scale,
        request.language.as_deref(),
        request.max_words,
        request.max_chars,
        started,
        budget,
    )?;
    Ok(OcrResponse {
        result,
        capture_mode: request.capture.capture_mode,
        window_bounds: captured.window_bounds,
    })
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn window_relative_region_rebinds_after_move_and_rejects_escape() {
        let r = Region {
            x: 20,
            y: 10,
            width: 100,
            height: 40,
        };
        let result = absolute_region(
            r,
            Region {
                x: -900,
                y: 80,
                width: 400,
                height: 300,
            },
        )
        .unwrap();
        assert_eq!((result.x, result.y, result.width), (-880, 90, 100));
        assert!(absolute_region(
            r,
            Region {
                x: 0,
                y: 0,
                width: 110,
                height: 300
            }
        )
        .is_err());
    }
}
