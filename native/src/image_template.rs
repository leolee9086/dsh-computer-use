//! 显式模板变换：先检查尺寸资源，再最近邻缩放，再按 alpha 选参与像素。
//! 遮罩是排除规则，不做透明度加权或背景合成；RGB 对比度按各通道分别计算。
use crate::image_match::MAX_TEMPLATE_PIXELS;
use image::{imageops::FilterType, RgbaImage};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum ColorMode {
    #[default]
    Gray,
    Rgb,
}
#[derive(Debug, Clone, Copy, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum MaskMode {
    #[default]
    None,
    Alpha,
}
#[derive(Debug, Clone, Copy)]
pub struct Options {
    pub color_mode: ColorMode,
    pub mask_mode: MaskMode,
    pub alpha_min: u8,
    pub template_scale: f64,
}
impl Options {
    pub fn validate(self) -> Result<(), String> {
        if !self.template_scale.is_finite() || !(0.1..=4.0).contains(&self.template_scale) {
            return Err("templateScale 必须在 [0.1, 4] 内".into());
        }
        if self.alpha_min == 0 {
            return Err("alphaMin 必须在 1..255 内".into());
        }
        Ok(())
    }
}

#[derive(Debug)]
pub struct Prepared {
    pub image: RgbaImage,
    pub mask: Option<Vec<bool>>,
    pub active_pixels: usize,
    pub source_width: u32,
    pub source_height: u32,
}

/// 与旧版相同的 Rec.601 整数亮度，避免升级改变默认灰度像素值。
fn gray(pixel: &[u8]) -> u8 {
    ((299 * u32::from(pixel[0]) + 587 * u32::from(pixel[1]) + 114 * u32::from(pixel[2])) / 1000)
        as u8
}

pub fn colors<const CHANNELS: usize>(rgba: &[u8]) -> Vec<[u8; CHANNELS]> {
    assert!(CHANNELS == 1 || CHANNELS == 3);
    rgba.chunks_exact(4)
        .map(|rgba| {
            let mut pixel = [0u8; CHANNELS];
            if CHANNELS == 1 {
                pixel[0] = gray(rgba);
            } else {
                pixel.copy_from_slice(&rgba[..3]);
            }
            pixel
        })
        .collect()
}

/// round 的正数 .5 向上规则与协议尺寸校验一致；不把小模板强行补成 1px。
fn dimensions(width: u32, height: u32, scale: f64) -> Result<(u32, u32), String> {
    let scaled_w = (f64::from(width) * scale).round();
    let scaled_h = (f64::from(height) * scale).round();
    if width == 0 || height == 0 || scaled_w < 1.0 || scaled_h < 1.0 {
        return Err("源模板或缩放后的模板尺寸为 0".into());
    }
    if u64::from(width) * u64::from(height) > MAX_TEMPLATE_PIXELS as u64
        || scaled_w * scaled_h > MAX_TEMPLATE_PIXELS as f64
    {
        return Err(format!(
            "源模板和缩放后的模板都不得超过 {MAX_TEMPLATE_PIXELS} 像素"
        ));
    }
    Ok((scaled_w as u32, scaled_h as u32))
}

pub fn prepare(source: RgbaImage, options: Options) -> Result<Prepared, String> {
    options.validate()?;
    let (source_width, source_height) = source.dimensions();
    let (width, height) = dimensions(source_width, source_height, options.template_scale)?;
    // 最近邻不会把被排除像素的隐藏 RGB 混入有效像素，也不会造出新的 alpha 边缘。
    let image = if (width, height) == (source_width, source_height) {
        source
    } else {
        image::imageops::resize(&source, width, height, FilterType::Nearest)
    };
    let mask = if options.mask_mode == MaskMode::Alpha {
        Some(
            image
                .pixels()
                .map(|pixel| pixel[3] >= options.alpha_min)
                .collect::<Vec<_>>(),
        )
    } else {
        None
    };
    let active_pixels = mask
        .as_ref()
        .map_or((width as usize) * (height as usize), |values| {
            values.iter().filter(|&&value| value).count()
        });
    if active_pixels == 0 {
        return Err("alpha 遮罩没有参与像素：模板全透明或 alphaMin 排除了全部像素".into());
    }

    // 只统计参与像素。透明边框里的噪声不能替纯色的可见部分制造对比度。
    let mut sums = [0f64; 3];
    let mut squares = [0f64; 3];
    let channels = if options.color_mode == ColorMode::Gray {
        1
    } else {
        3
    };
    for (index, pixel) in image.pixels().enumerate() {
        if mask.as_ref().is_some_and(|values| !values[index]) {
            continue;
        }
        for channel in 0..channels {
            let value = f64::from(if channels == 1 {
                gray(&pixel.0)
            } else {
                pixel[channel]
            });
            sums[channel] += value;
            squares[channel] += value * value;
        }
    }
    let count = active_pixels as f64;
    let stddev = (0..channels)
        .map(|channel| {
            (squares[channel] / count - (sums[channel] / count).powi(2))
                .max(0.0)
                .sqrt()
        })
        .fold(0.0, f64::max);
    if stddev < 3.0 {
        return Err(format!(
            "模板参与像素几乎是纯色（所选颜色模式最大通道标准差 {stddev:.1}）：没有可匹配的结构"
        ));
    }
    Ok(Prepared {
        image,
        mask,
        active_pixels,
        source_width,
        source_height,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::Rgba;
    fn options(color_mode: ColorMode, mask_mode: MaskMode) -> Options {
        Options {
            color_mode,
            mask_mode,
            alpha_min: 1,
            template_scale: 1.0,
        }
    }
    #[test]
    fn equal_luma_color_structure_is_valid_only_in_rgb() {
        // 两色 Rec.601 都为 76，RGB 具有明确结构。
        let source = RgbaImage::from_fn(4, 2, |x, _| {
            if x % 2 == 0 {
                Rgba([255, 0, 0, 255])
            } else {
                Rgba([0, 130, 0, 255])
            }
        });
        assert!(
            prepare(source.clone(), options(ColorMode::Gray, MaskMode::None))
                .unwrap_err()
                .contains("纯色")
        );
        assert_eq!(
            prepare(source, options(ColorMode::Rgb, MaskMode::None))
                .unwrap()
                .active_pixels,
            8
        );
    }
    #[test]
    fn alpha_cutoff_is_inclusive_and_mask_none_keeps_all_pixels() {
        let source = RgbaImage::from_fn(4, 2, |x, _| {
            Rgba([20 + x as u8 * 50, 30, 40, [0, 127, 128, 255][x as usize]])
        });
        let mut config = options(ColorMode::Rgb, MaskMode::Alpha);
        config.alpha_min = 128;
        let masked = prepare(source.clone(), config).unwrap();
        assert_eq!(masked.active_pixels, 4);
        assert_eq!(&masked.mask.unwrap()[..4], &[false, false, true, true]);
        assert_eq!(
            prepare(source, options(ColorMode::Rgb, MaskMode::None))
                .unwrap()
                .active_pixels,
            8
        );
    }
    #[test]
    fn empty_mask_and_hidden_only_contrast_are_rejected() {
        let source = RgbaImage::from_fn(4, 2, |x, _| Rgba([x as u8 * 60, 0, 0, 0]));
        assert!(
            prepare(source.clone(), options(ColorMode::Rgb, MaskMode::Alpha))
                .unwrap_err()
                .contains("没有参与像素")
        );
        let mut visible = source;
        visible.put_pixel(0, 0, Rgba([20, 30, 40, 255]));
        assert!(prepare(visible, options(ColorMode::Rgb, MaskMode::Alpha))
            .unwrap_err()
            .contains("纯色"));
    }
    #[test]
    fn nearest_scale_preserves_pixel_and_alpha_without_blending() {
        let source = RgbaImage::from_fn(2, 2, |x, y| {
            Rgba([
                40 + x as u8 * 100,
                y as u8 * 90,
                20,
                if x == 0 { 255 } else { 0 },
            ])
        });
        let mut config = options(ColorMode::Rgb, MaskMode::Alpha);
        config.template_scale = 2.0;
        let prepared = prepare(source.clone(), config).unwrap();
        assert_eq!(prepared.image.dimensions(), (4, 4));
        assert_eq!(
            (
                prepared.source_width,
                prepared.source_height,
                prepared.active_pixels
            ),
            (2, 2, 8)
        );
        for y in 0..4 {
            for x in 0..4 {
                assert_eq!(
                    prepared.image.get_pixel(x, y),
                    source.get_pixel(x / 2, y / 2)
                );
            }
        }
        assert_eq!(dimensions(5, 7, 0.5).unwrap(), (3, 4));
    }
    #[test]
    fn invalid_scale_zero_dimensions_and_scaled_resource_limit_fail_before_resize() {
        assert!(dimensions(1, 2, 0.1).unwrap_err().contains("尺寸为 0"));
        assert!(dimensions(1024, 1024, 2.0)
            .unwrap_err()
            .contains("不得超过"));
        for scale in [0.0, 0.099, 4.01, f64::NAN, f64::INFINITY] {
            let mut config = options(ColorMode::Gray, MaskMode::None);
            config.template_scale = scale;
            assert!(config.validate().is_err());
        }
        let mut config = options(ColorMode::Gray, MaskMode::Alpha);
        config.alpha_min = 0;
        assert!(config.validate().is_err());
    }
}
