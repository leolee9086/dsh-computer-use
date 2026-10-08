//! 独立 RGB 找色：统计的是像素数量，不把一片色块说成一个唯一控件。
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Direction {
    RowMajor,
    ReverseRowMajor,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Pixel {
    pub x: u32,
    pub y: u32,
    pub rgb: [u8; 3],
}
#[derive(Debug)]
pub struct Scan {
    pub visited: u64,
    pub total: u64,
    pub count: u64,
    pub samples: Vec<Pixel>,
    pub stop_reason: Option<&'static str>,
}

pub fn scan(
    rgba: &[u8],
    width: u32,
    height: u32,
    rgb: [u8; 3],
    tolerance: u8,
    direction: Direction,
    max_pixels: u64,
    max_samples: usize,
    mut expired: impl FnMut() -> bool,
) -> Result<Scan, String> {
    let total = u64::from(width) * u64::from(height);
    if total == 0 || total.checked_mul(4) != Some(rgba.len() as u64) {
        return Err("找色像素缓冲区尺寸不符".into());
    }
    if max_pixels == 0 || !(1..=32).contains(&max_samples) {
        return Err("找色扫描/样本预算无效".into());
    }
    let mut result = Scan {
        visited: 0,
        total,
        count: 0,
        samples: Vec::new(),
        stop_reason: None,
    };
    for offset in 0..total {
        if result.visited >= max_pixels {
            result.stop_reason = Some("pixel_limit");
            break;
        }
        if expired() {
            result.stop_reason = Some("timeout");
            break;
        }
        let index = match direction {
            Direction::RowMajor => offset,
            Direction::ReverseRowMajor => total - 1 - offset,
        };
        let start = index as usize * 4;
        let pixel = [rgba[start], rgba[start + 1], rgba[start + 2]];
        result.visited += 1;
        // 与模板 RGB 模式一样：三个通道分别满足容差，alpha 不参与屏幕找色。
        if pixel
            .iter()
            .zip(rgb)
            .all(|(&value, target)| value.abs_diff(target) <= tolerance)
        {
            result.count += 1;
            if result.samples.len() < max_samples {
                result.samples.push(Pixel {
                    x: (index % u64::from(width)) as u32,
                    y: (index / u64::from(width)) as u32,
                    rgb: pixel,
                });
            }
        }
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn count_and_directions_agree_with_independent_channel_oracle() {
        let pixels: Vec<u8> = (0..210)
            .flat_map(|i| [(i * 17) as u8, (i * 29) as u8, (i * 41) as u8, 255])
            .collect();
        let target = [71, 122, 169];
        let expected: Vec<usize> = pixels
            .chunks_exact(4)
            .enumerate()
            .filter_map(|(i, p)| {
                let distance = (0..3)
                    .map(|c| (i16::from(p[c]) - i16::from(target[c])).abs())
                    .max()
                    .unwrap();
                (distance <= 70).then_some(i)
            })
            .collect();
        assert!(expected.len() > 1);
        for direction in [Direction::RowMajor, Direction::ReverseRowMajor] {
            let result = scan(&pixels, 21, 10, target, 70, direction, 210, 32, || false).unwrap();
            assert_eq!(result.count, expected.len() as u64);
            assert_eq!(result.visited, 210);
            assert_eq!(result.stop_reason, None);
            let first = match direction {
                Direction::RowMajor => expected[0],
                Direction::ReverseRowMajor => *expected.last().unwrap(),
            };
            assert_eq!(
                (result.samples[0].x, result.samples[0].y),
                ((first % 21) as u32, (first / 21) as u32)
            );
        }
    }
    #[test]
    fn partial_zero_is_not_absence_and_sample_cap_is_not_count_cap() {
        let pixels = [vec![0u8; 4], vec![255u8; 4].repeat(40)].concat();
        let partial = scan(
            &pixels,
            41,
            1,
            [255; 3],
            0,
            Direction::RowMajor,
            1,
            2,
            || false,
        )
        .unwrap();
        assert_eq!(
            (partial.count, partial.visited, partial.stop_reason),
            (0, 1, Some("pixel_limit"))
        );
        let full = scan(
            &pixels,
            41,
            1,
            [255; 3],
            0,
            Direction::RowMajor,
            41,
            2,
            || false,
        )
        .unwrap();
        assert_eq!(
            (full.count, full.samples.len(), full.stop_reason),
            (40, 2, None)
        );
        let timeout = scan(
            &pixels,
            41,
            1,
            [255; 3],
            0,
            Direction::RowMajor,
            41,
            2,
            || true,
        )
        .unwrap();
        assert_eq!((timeout.visited, timeout.stop_reason), (0, Some("timeout")));
    }
    #[test]
    fn all_channels_and_inclusive_tolerance_are_required() {
        let pixels = [12, 18, 32, 255, 12, 18, 33, 255, 10, 20, 30, 0];
        let result = scan(
            &pixels,
            3,
            1,
            [10, 20, 30],
            2,
            Direction::RowMajor,
            3,
            3,
            || false,
        )
        .unwrap();
        assert_eq!(result.count, 2);
        assert_eq!(
            result.samples.iter().map(|p| p.x).collect::<Vec<_>>(),
            vec![0, 2]
        );
    }
}
