//! Windows 自带 OCR：字框坐标映射回抓取区域；此引擎没有置信度分数。
use super::Region;
use serde::Serialize;
use std::time::{Duration, Instant};
use windows::core::HSTRING;
use windows::Foundation::{AsyncStatus, Rect};
use windows::Globalization::Language;
use windows::Graphics::Imaging::{BitmapAlphaMode, BitmapPixelFormat, SoftwareBitmap};
use windows::Media::Ocr::OcrEngine;
use windows::Storage::Streams::DataWriter;
use windows::Win32::System::WinRT::{RoInitialize, RoUninitialize, RO_INIT_MULTITHREADED};

struct Apartment;
impl Drop for Apartment {
    fn drop(&mut self) {
        unsafe { RoUninitialize() };
    }
}
#[derive(Debug, Clone, Copy, Serialize)]
pub struct Bounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Word {
    pub text: String,
    pub bounds: Bounds,
    pub image_bounds: Bounds,
    pub line_index: u32,
    pub confidence: Option<f64>,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Line {
    pub line_index: u32,
    pub text: String,
    pub bounds: Bounds,
    pub word_start: usize,
    pub word_count: usize,
    pub confidence: Option<f64>,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Response {
    pub engine: &'static str,
    pub language: String,
    pub confidence_available: bool,
    pub confidence_reason: &'static str,
    pub coverage: &'static str,
    pub status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stop_reason: Option<&'static str>,
    pub searched: Region,
    pub image_width: u32,
    pub image_height: u32,
    pub resize_filter: &'static str,
    pub words: Vec<Word>,
    pub lines: Vec<Line>,
    pub elapsed_ms: u64,
}
fn win<T>(result: windows::core::Result<T>) -> Result<T, String> {
    result.map_err(|error| format!("Windows OCR: {error}"))
}

pub fn languages() -> Result<serde_json::Value, String> {
    unsafe {
        win(RoInitialize(RO_INIT_MULTITHREADED))?;
    }
    let _apartment = Apartment;
    let languages = win(OcrEngine::AvailableRecognizerLanguages())?;
    let mut tags = Vec::new();
    for index in 0..win(languages.Size())? {
        tags.push(win(win(languages.GetAt(index))?.LanguageTag())?.to_string());
    }
    Ok(
        serde_json::json!({ "engine": "windows_media_ocr", "languages": tags,
        "maxImageDimension": win(OcrEngine::MaxImageDimension())?, "confidenceAvailable": false,
        "confidenceReason": "engine_does_not_expose_score" }),
    )
}

/// 实际缩放可能因取整产生不同的 x/y 比例，用真实图宽高换算，不用请求的浮点比例猜。
fn mapped(rect: Rect, crop: Region, width: u32, height: u32) -> Result<(Bounds, Bounds), String> {
    let raw = Bounds {
        x: f64::from(rect.X),
        y: f64::from(rect.Y),
        width: f64::from(rect.Width),
        height: f64::from(rect.Height),
    };
    if ![raw.x, raw.y, raw.width, raw.height]
        .iter()
        .all(|value| value.is_finite())
        || raw.x < 0.0
        || raw.y < 0.0
        || raw.width <= 0.0
        || raw.height <= 0.0
        || raw.x + raw.width > f64::from(width) + 0.01
        || raw.y + raw.height > f64::from(height) + 0.01
    {
        return Err("OCR 返回的字框不在实际图像内".into());
    }
    let sx = f64::from(crop.width) / f64::from(width);
    let sy = f64::from(crop.height) / f64::from(height);
    Ok((
        Bounds {
            x: f64::from(crop.x) + raw.x * sx,
            y: f64::from(crop.y) + raw.y * sy,
            width: raw.width * sx,
            height: raw.height * sy,
        },
        raw,
    ))
}

pub fn recognize(
    pixels: Vec<u8>,
    crop: Region,
    scale: f64,
    language: Option<&str>,
    max_words: usize,
    max_chars: usize,
    started: Instant,
    budget: Duration,
) -> Result<Response, String> {
    if !scale.is_finite()
        || !(1.0..=4.0).contains(&scale)
        || !(1..=2000).contains(&max_words)
        || !(1..=64000).contains(&max_chars)
    {
        return Err("OCR scale 必须是 1..4，maxWords 1..2000，maxChars 1..64000".into());
    }
    unsafe {
        win(RoInitialize(RO_INIT_MULTITHREADED))?;
    }
    let _apartment = Apartment;
    let engine = if let Some(tag) = language {
        if tag.trim().is_empty() {
            return Err("OCR language 不能为空".into());
        }
        let language = win(Language::CreateLanguage(&HSTRING::from(tag)))?;
        if !win(OcrEngine::IsLanguageSupported(&language))? {
            return Err(format!("系统没有 OCR 语言 {tag}"));
        }
        win(OcrEngine::TryCreateFromLanguage(&language))?
    } else {
        win(OcrEngine::TryCreateFromUserProfileLanguages())?
    };
    let width = (f64::from(crop.width) * scale).round() as u32;
    let height = (f64::from(crop.height) * scale).round() as u32;
    let max_dimension = win(OcrEngine::MaxImageDimension())?;
    if width > max_dimension
        || height > max_dimension
        || u64::from(width) * u64::from(height) > 16_000_000
    {
        return Err(format!(
            "OCR 图像超过系统尺寸上限 {max_dimension} 或16000000像素；请缩小 region/scale"
        ));
    }
    let image = image::RgbaImage::from_raw(crop.width as u32, crop.height as u32, pixels)
        .ok_or("OCR 像素尺寸不符")?;
    let mut image = if width == image.width() && height == image.height() {
        image
    } else {
        image::imageops::resize(&image, width, height, image::imageops::FilterType::Lanczos3)
    };
    // Windows OCR 接受 BGRA8；GDI 的原始 alpha 已在抓屏时置为不透明。
    for pixel in image.as_mut().chunks_exact_mut(4) {
        pixel.swap(0, 2);
    }
    let writer = win(DataWriter::new())?;
    win(writer.WriteBytes(image.as_raw()))?;
    let buffer = win(writer.DetachBuffer())?;
    let bitmap = win(SoftwareBitmap::CreateCopyWithAlphaFromBuffer(
        &buffer,
        BitmapPixelFormat::Bgra8,
        width as i32,
        height as i32,
        BitmapAlphaMode::Ignore,
    ))?;
    let mut response = Response {
        engine: "windows_media_ocr",
        language: win(win(engine.RecognizerLanguage())?.LanguageTag())?.to_string(),
        confidence_available: false,
        confidence_reason: "engine_does_not_expose_score",
        coverage: "complete",
        status: "recognized",
        stop_reason: None,
        searched: crop,
        image_width: width,
        image_height: height,
        resize_filter: "lanczos3",
        words: Vec::new(),
        lines: Vec::new(),
        elapsed_ms: 0,
    };
    if started.elapsed() >= budget {
        response.stop_reason = Some("timeout");
    } else {
        let operation = win(engine.RecognizeAsync(&bitmap))?;
        while win(operation.Status())? == AsyncStatus::Started {
            if started.elapsed() >= budget {
                let _ = operation.Cancel();
                response.stop_reason = Some("timeout");
                break;
            }
            // 只在独立 helper 内等待异步状态；宿主还有覆盖整个进程的硬截止。
            std::thread::sleep(Duration::from_millis(5));
        }
        if response.stop_reason.is_none() {
            let result = win(operation.GetResults())?;
            let lines = win(result.Lines())?;
            let mut chars = 0usize;
            'lines: for index in 0..win(lines.Size())? {
                let line = win(lines.GetAt(index))?;
                let words = win(line.Words())?;
                let start = response.words.len();
                for word_index in 0..win(words.Size())? {
                    if started.elapsed() >= budget {
                        response.stop_reason = Some("timeout");
                        break 'lines;
                    }
                    if response.words.len() >= max_words {
                        response.stop_reason = Some("word_limit");
                        break 'lines;
                    }
                    let word = win(words.GetAt(word_index))?;
                    let text = win(word.Text())?.to_string();
                    chars += text.chars().count();
                    if chars > max_chars {
                        response.stop_reason = Some("character_limit");
                        break 'lines;
                    }
                    let (bounds, image_bounds) =
                        mapped(win(word.BoundingRect())?, crop, width, height)?;
                    response.words.push(Word {
                        text,
                        bounds,
                        image_bounds,
                        line_index: index,
                        confidence: None,
                    });
                }
                let group = &response.words[start..];
                if let Some(first) = group.first() {
                    let left = group
                        .iter()
                        .map(|w| w.bounds.x)
                        .fold(first.bounds.x, f64::min);
                    let top = group
                        .iter()
                        .map(|w| w.bounds.y)
                        .fold(first.bounds.y, f64::min);
                    let right = group
                        .iter()
                        .map(|w| w.bounds.x + w.bounds.width)
                        .fold(first.bounds.x, f64::max);
                    let bottom = group
                        .iter()
                        .map(|w| w.bounds.y + w.bounds.height)
                        .fold(first.bounds.y, f64::max);
                    let line_text = win(line.Text())?.to_string();
                    chars += line_text.chars().count();
                    if chars > max_chars {
                        response.stop_reason = Some("character_limit");
                        break 'lines;
                    }
                    response.lines.push(Line {
                        line_index: index,
                        text: line_text,
                        bounds: Bounds {
                            x: left,
                            y: top,
                            width: right - left,
                            height: bottom - top,
                        },
                        word_start: start,
                        word_count: group.len(),
                        confidence: None,
                    });
                }
            }
        }
    }
    if response.stop_reason.is_some() {
        response.coverage = "partial";
        response.status = "incomplete";
    }
    response.elapsed_ms = started.elapsed().as_millis() as u64;
    Ok(response)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn map_uses_actual_dimensions_with_negative_desktop_origin() {
        let crop = Region {
            x: -200,
            y: 50,
            width: 101,
            height: 41,
        };
        let (mapped, raw) = super::mapped(
            Rect {
                X: 20.0,
                Y: 10.0,
                Width: 40.0,
                Height: 20.0,
            },
            crop,
            202,
            82,
        )
        .unwrap();
        assert_eq!(
            (mapped.x, mapped.y, mapped.width, mapped.height),
            (-190.0, 55.0, 20.0, 10.0)
        );
        assert_eq!(raw.x, 20.0);
        assert!(super::mapped(
            Rect {
                X: -1.0,
                Y: 0.0,
                Width: 3.0,
                Height: 3.0
            },
            crop,
            202,
            82
        )
        .is_err());
    }
}
