//! 有覆盖证明的像素模板匹配。RGB、灰度和显式遮罩共用同一个扫描核。
//! 所有合法左上角按行扫描；提前淘汰只发生在某个位置已不可能达到阈值时。
use std::collections::HashMap;

pub const DISPLAY_LIMIT: usize = 8;
pub const MAX_CLUSTERS: usize = 100_000;
pub const MAX_TEMPLATE_PIXELS: usize = 1_048_576;

#[derive(Debug, Clone, Copy)]
pub struct PixelImage<'a, const CHANNELS: usize> {
    pub pixels: &'a [[u8; CHANNELS]],
    pub width: u32,
    pub height: u32,
}

// 旧灰度回归保留原来的输入形式，通过无拷贝视图进入同一个生产扫描核。
#[cfg(test)]
#[derive(Debug, Clone, Copy)]
struct GrayImage<'a> {
    pixels: &'a [u8],
    width: u32,
    height: u32,
}

#[derive(Debug, Clone, Copy)]
pub struct Limits {
    pub max_positions: u64,
    pub max_clusters: usize,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Spot {
    pub x: u32,
    pub y: u32,
    pub score: f64,
}

#[derive(Debug)]
pub struct ScanResult {
    pub matches: Vec<Spot>,
    pub match_count: usize,
    pub visited_positions: u64,
    pub total_positions: u64,
    pub stop_reason: Option<&'static str>,
}

struct Cluster {
    anchor_x: u32,
    anchor_y: u32,
    best: Spot,
}

fn pixel_count<const CHANNELS: usize>(image: PixelImage<'_, CHANNELS>) -> Result<usize, String> {
    if CHANNELS != 1 && CHANNELS != 3 {
        return Err("只支持单通道灰度或三通道 RGB".into());
    }
    let count = (image.width as usize)
        .checked_mul(image.height as usize)
        .ok_or("图像像素数溢出")?;
    if count == 0 || image.pixels.len() != count {
        return Err("灰度图尺寸与像素数组不一致".into());
    }
    Ok(count)
}

/// 用最终评分的同一个除法寻找允许的最大不匹配数。
/// 不用 floor((1-threshold)*total)：0.9 在二进制中会让十像素的一处偏差被误拒。
fn allowed_mismatches(total: usize, threshold: f64) -> usize {
    let (mut low, mut high) = (0, total);
    while low < high {
        let mid = low + (high - low) / 2;
        if mid as f64 / total as f64 >= threshold {
            high = mid;
        } else {
            low = mid + 1;
        }
    }
    total - low
}

/// 按有效像素离各通道均值的平均距离计数排列；只排序 256 个桶。
/// 顺序只影响提前淘汰的速度，最终仍比较全部参与像素，不作为候选过滤条件。
fn comparison_order<const CHANNELS: usize>(
    template: PixelImage<'_, CHANNELS>,
    mask: Option<&[bool]>,
    participating: usize,
    screen_width: usize,
    expired: &mut impl FnMut() -> bool,
) -> Option<Vec<(usize, [u8; CHANNELS])>> {
    let included = |index: usize| mask.is_none_or(|values| values[index]);
    let mut sums = [0u64; CHANNELS];
    for (index, value) in template.pixels.iter().enumerate() {
        if index % 4096 == 0 && expired() {
            return None;
        }
        if included(index) {
            for channel in 0..CHANNELS {
                sums[channel] += u64::from(value[channel]);
            }
        }
    }
    let count = participating as u64;
    let bucket = |value: &[u8; CHANNELS]| -> usize {
        (value
            .iter()
            .zip(sums)
            .map(|(&v, sum)| (u64::from(v) * count).abs_diff(sum))
            .sum::<u64>()
            / (count * CHANNELS as u64)) as usize
    };
    let mut counts = [0usize; 256];
    for (index, value) in template.pixels.iter().enumerate() {
        if index % 4096 == 0 && expired() {
            return None;
        }
        if included(index) {
            counts[bucket(value)] += 1;
        }
    }
    let mut offsets = [0usize; 256];
    let mut next = 0;
    for value in (0..256).rev() {
        offsets[value] = next;
        next += counts[value];
    }
    let mut order = vec![(0usize, [0u8; CHANNELS]); participating];
    let width = template.width as usize;
    for (index, &value) in template.pixels.iter().enumerate() {
        if index % 4096 == 0 && expired() {
            return None;
        }
        if included(index) {
            let key = bucket(&value);
            order[offsets[key]] = (index / width * screen_width + index % width, value);
            offsets[key] += 1;
        }
    }
    Some(order)
}

fn result(
    clusters: &[Cluster],
    visited_positions: u64,
    total_positions: u64,
    stop_reason: Option<&'static str>,
) -> ScanResult {
    // 展示上限不影响计数。最多维护八个展示候选，避免结束时再做大排序。
    let mut matches: Vec<Spot> = Vec::new();
    for cluster in clusters {
        matches.push(cluster.best);
        matches.sort_by(|a, b| {
            b.score
                .total_cmp(&a.score)
                .then(a.y.cmp(&b.y))
                .then(a.x.cmp(&b.x))
        });
        matches.truncate(DISPLAY_LIMIT);
    }
    ScanResult {
        matches,
        match_count: clusters.len(),
        visited_positions,
        total_positions,
        stop_reason,
    }
}

pub fn scan_pixels<const CHANNELS: usize>(
    screen: PixelImage<'_, CHANNELS>,
    template: PixelImage<'_, CHANNELS>,
    mask: Option<&[bool]>,
    tolerance: u8,
    threshold: f64,
    limits: Limits,
    mut expired: impl FnMut() -> bool,
) -> Result<ScanResult, String> {
    pixel_count(screen)?;
    let template_pixels = pixel_count(template)?;
    if template_pixels > MAX_TEMPLATE_PIXELS {
        return Err(format!("模板不得超过 {MAX_TEMPLATE_PIXELS} 像素"));
    }
    if mask.is_some_and(|values| values.len() != template_pixels) {
        return Err("遮罩尺寸与模板不一致".into());
    }
    let participating = mask.map_or(template_pixels, |values| {
        values.iter().filter(|&&v| v).count()
    });
    if participating == 0 {
        return Err("模板遮罩没有参与像素".into());
    }
    if !threshold.is_finite() || threshold <= 0.0 || threshold > 1.0 {
        return Err("threshold 必须在 (0, 1] 内".into());
    }
    if limits.max_positions == 0 || limits.max_clusters == 0 || limits.max_clusters > MAX_CLUSTERS {
        return Err("扫描位置和聚类资源预算无效".into());
    }
    if template.width > screen.width || template.height > screen.height {
        return Ok(result(&[], 0, 0, None));
    }
    let columns = screen.width - template.width + 1;
    let rows = screen.height - template.height + 1;
    let total_positions = u64::from(columns) * u64::from(rows);
    let Some(order) = comparison_order(
        template,
        mask,
        participating,
        screen.width as usize,
        &mut expired,
    ) else {
        return Ok(result(&[], 0, total_positions, Some("time_budget")));
    };
    let allowed = allowed_mismatches(participating, threshold);
    let radius_x = template.width / 2;
    let radius_y = template.height / 2;
    let cell_width = radius_x + 1;
    let cell_height = radius_y + 1;
    let mut cells: HashMap<(u32, u32), usize> = HashMap::new();
    let mut clusters: Vec<Cluster> = Vec::new();
    let mut visited = 0u64;
    let mut comparisons = 0usize;
    let mut stop_reason = None;

    'positions: for y in 0..rows {
        for x in 0..columns {
            if visited >= limits.max_positions {
                stop_reason = Some("position_limit");
                break 'positions;
            }
            if expired() {
                stop_reason = Some("time_budget");
                break 'positions;
            }
            let base = y as usize * screen.width as usize + x as usize;
            let mut mismatch = 0usize;
            for &(offset, value) in &order {
                comparisons = comparisons.wrapping_add(1);
                // 单个大模板也要能中断；未完成的位置不计入已覆盖位置数。
                if comparisons % 256 == 0 && expired() {
                    stop_reason = Some("time_budget");
                    break 'positions;
                }
                // RGB 必须每个通道都在容差内才算这一像素匹配；分母仍是像素数。
                if screen.pixels[base + offset]
                    .iter()
                    .zip(value)
                    .any(|(&actual, expected)| actual.abs_diff(expected) > tolerance)
                {
                    mismatch += 1;
                    if mismatch > allowed {
                        break;
                    }
                }
            }
            if mismatch <= allowed {
                let spot = Spot {
                    x,
                    y,
                    score: (participating - mismatch) as f64 / participating as f64,
                };
                let cell_x = x / cell_width;
                let cell_y = y / cell_height;
                // 聚类锚点永远是按行遇到的第一个匹配，不随更高分位置移动。
                // 同时接近多个锚点时归入最早的那个。这样前缀计数是完整计数的下界。
                let mut cluster_index: Option<usize> = None;
                for cy in cell_y.saturating_sub(1)..=cell_y.saturating_add(1) {
                    for cx in cell_x.saturating_sub(1)..=cell_x.saturating_add(1) {
                        if let Some(&index) = cells.get(&(cx, cy)) {
                            let cluster = &clusters[index];
                            if x.abs_diff(cluster.anchor_x) <= radius_x
                                && y.abs_diff(cluster.anchor_y) <= radius_y
                            {
                                cluster_index =
                                    Some(cluster_index.map_or(index, |old| old.min(index)));
                            }
                        }
                    }
                }
                if let Some(index) = cluster_index {
                    if spot.score > clusters[index].best.score {
                        clusters[index].best = spot;
                    }
                } else {
                    if clusters.len() == limits.max_clusters {
                        stop_reason = Some("cluster_limit");
                        break 'positions;
                    }
                    cells.insert((cell_x, cell_y), clusters.len());
                    clusters.push(Cluster {
                        anchor_x: x,
                        anchor_y: y,
                        best: spot,
                    });
                }
            }
            visited += 1;
        }
    }
    Ok(result(&clusters, visited, total_positions, stop_reason))
}

#[cfg(test)]
fn scan(
    screen: GrayImage<'_>,
    template: GrayImage<'_>,
    tolerance: u8,
    threshold: f64,
    limits: Limits,
    expired: impl FnMut() -> bool,
) -> Result<ScanResult, String> {
    scan_pixels(
        PixelImage {
            pixels: screen.pixels.as_chunks::<1>().0,
            width: screen.width,
            height: screen.height,
        },
        PixelImage {
            pixels: template.pixels.as_chunks::<1>().0,
            width: template.width,
            height: template.height,
        },
        None,
        tolerance,
        threshold,
        limits,
        expired,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn image(pixels: &[u8], width: u32) -> GrayImage<'_> {
        GrayImage {
            pixels,
            width,
            height: pixels.len() as u32 / width,
        }
    }
    fn complete(screen: GrayImage<'_>, template: GrayImage<'_>, threshold: f64) -> ScanResult {
        scan(
            screen,
            template,
            0,
            threshold,
            Limits {
                max_positions: u64::MAX,
                max_clusters: MAX_CLUSTERS,
            },
            || false,
        )
        .unwrap()
    }
    fn stamp(screen: &mut [u8], width: usize, template: &[u8], tw: usize, x: usize, y: usize) {
        for (index, value) in template.iter().enumerate() {
            screen[(y + index / tw) * width + x + index % tw] = *value;
        }
    }

    #[test]
    fn covers_tail_and_all_positions() {
        let template = [11, 241, 153, 73];
        let mut screen = vec![0; 17 * 9];
        stamp(&mut screen, 17, &template, 2, 15, 7);
        let result = complete(image(&screen, 17), image(&template, 2), 1.0);
        assert_eq!(result.visited_positions, 16 * 8);
        assert_eq!(result.total_positions, 16 * 8);
        assert_eq!(result.stop_reason, None);
        assert_eq!(result.match_count, 1);
        assert_eq!((result.matches[0].x, result.matches[0].y), (15, 7));
    }

    #[test]
    fn counts_two_identical_targets() {
        let template = [11, 241, 153, 73];
        let mut screen = vec![0; 30 * 10];
        stamp(&mut screen, 30, &template, 2, 1, 1);
        stamp(&mut screen, 30, &template, 2, 25, 7);
        let result = complete(image(&screen, 30), image(&template, 2), 1.0);
        assert_eq!(result.match_count, 2);
        assert_eq!(result.matches.len(), 2);
    }

    #[test]
    fn nearby_hits_cannot_hide_far_target_or_truncate_count() {
        // 十处密集匹配占满旧 top-8，末尾还有一处；展示八处，计数仍十一处。
        let template = [11, 241, 153, 73];
        let mut screen = vec![0; 80 * 8];
        for x in (0..30).step_by(3) {
            stamp(&mut screen, 80, &template, 2, x, 1);
        }
        stamp(&mut screen, 80, &template, 2, 78, 6);
        let result = complete(image(&screen, 80), image(&template, 2), 1.0);
        assert_eq!(result.match_count, 11);
        assert_eq!(result.matches.len(), DISPLAY_LIMIT);
        assert_eq!(result.stop_reason, None);
    }

    #[test]
    fn threshold_boundary_uses_actual_score() {
        let template: Vec<u8> = (1..=20).collect();
        let mut screen = template.clone();
        screen[0] = 255;
        assert_eq!(
            complete(image(&screen, 20), image(&template, 20), 0.95).match_count,
            1
        );
        assert_eq!(
            complete(image(&screen[..10], 10), image(&template[..10], 10), 0.9).match_count,
            1
        );
        assert_eq!(
            complete(image(&screen, 20), image(&template, 20), 0.9500000000001).match_count,
            0
        );
    }

    #[test]
    fn partial_zero_and_one_cannot_prove_absence_or_uniqueness() {
        let template = [11, 241, 153, 73];
        let mut screen = vec![0; 20 * 6];
        stamp(&mut screen, 20, &template, 2, 0, 0);
        stamp(&mut screen, 20, &template, 2, 18, 4);
        let one = scan(
            image(&screen, 20),
            image(&template, 2),
            0,
            1.0,
            Limits {
                max_positions: 1,
                max_clusters: MAX_CLUSTERS,
            },
            || false,
        )
        .unwrap();
        assert_eq!((one.match_count, one.visited_positions), (1, 1));
        assert_eq!(one.stop_reason, Some("position_limit"));
        screen[..2].fill(0);
        let zero = scan(
            image(&screen, 20),
            image(&template, 2),
            0,
            1.0,
            Limits {
                max_positions: 1,
                max_clusters: MAX_CLUSTERS,
            },
            || false,
        )
        .unwrap();
        assert_eq!(zero.match_count, 0);
        assert_eq!(zero.stop_reason, Some("position_limit"));
    }

    #[test]
    fn exact_position_budget_is_complete() {
        let result = scan(
            image(&[0; 6], 3),
            image(&[1, 2], 2),
            0,
            1.0,
            Limits {
                max_positions: 4,
                max_clusters: MAX_CLUSTERS,
            },
            || false,
        )
        .unwrap();
        assert_eq!(result.stop_reason, None);
        assert_eq!(result.visited_positions, result.total_positions);
        assert_eq!(result.match_count, 0);
    }

    #[test]
    fn timeout_and_cluster_capacity_are_explicit_partial_results() {
        let timeout = scan(
            image(&[0; 6], 3),
            image(&[1, 2], 2),
            0,
            1.0,
            Limits {
                max_positions: 10,
                max_clusters: MAX_CLUSTERS,
            },
            || true,
        )
        .unwrap();
        assert_eq!(timeout.stop_reason, Some("time_budget"));
        assert_eq!(timeout.visited_positions, 0);
        let capacity = scan(
            image(&[1, 2, 0, 1, 2], 5),
            image(&[1, 2], 2),
            0,
            1.0,
            Limits {
                max_positions: 10,
                max_clusters: 1,
            },
            || false,
        )
        .unwrap();
        assert_eq!(capacity.stop_reason, Some("cluster_limit"));
        assert_eq!(capacity.match_count, 1);
        assert_eq!(capacity.visited_positions, 3);
    }

    #[test]
    fn clustering_uses_fixed_first_anchor() {
        let result = complete(image(&[1; 12], 12), image(&[1; 4], 4), 1.0);
        // 半宽为二，锚点依次 0、3、6；不会被一条相邻匹配链全合并。
        assert_eq!(result.match_count, 3);
        assert_eq!(
            result.matches.iter().map(|spot| spot.x).collect::<Vec<_>>(),
            vec![0, 3, 6]
        );
    }

    #[test]
    fn small_template_and_oversized_template_have_defined_coverage() {
        let exact = complete(image(&[10, 20], 2), image(&[20], 1), 1.0);
        assert_eq!(exact.match_count, 1);
        let oversized = complete(image(&[10, 20], 2), image(&[10, 20, 30], 3), 1.0);
        assert_eq!(oversized.total_positions, 0);
        assert_eq!(oversized.stop_reason, None);
    }

    fn rgb(pixels: &[[u8; 3]], width: u32) -> PixelImage<'_, 3> {
        PixelImage {
            pixels,
            width,
            height: pixels.len() as u32 / width,
        }
    }
    fn limits() -> Limits {
        Limits {
            max_positions: u64::MAX,
            max_clusters: MAX_CLUSTERS,
        }
    }

    #[test]
    fn rgb_requires_each_channel_within_tolerance_and_counts_pixels() {
        let template = [[30, 60, 90], [150, 140, 130]];
        let screen = [[30, 60, 101], [150, 140, 130]];
        let exact = scan_pixels(
            rgb(&screen, 2),
            rgb(&template, 2),
            None,
            10,
            1.0,
            limits(),
            || false,
        )
        .unwrap();
        assert_eq!(exact.match_count, 0);
        let half = scan_pixels(
            rgb(&screen, 2),
            rgb(&template, 2),
            None,
            10,
            0.5,
            limits(),
            || false,
        )
        .unwrap();
        assert_eq!(half.matches[0].score, 0.5);
        assert_eq!(
            scan_pixels(
                rgb(&screen, 2),
                rgb(&template, 2),
                None,
                11,
                1.0,
                limits(),
                || false
            )
            .unwrap()
            .match_count,
            1
        );
    }

    #[test]
    fn mask_ignores_hidden_colors_and_uses_active_threshold_denominator() {
        let template: Vec<[u8; 3]> = (1..=24).map(|v| [v, v + 30, v + 60]).collect();
        let mut screen = template.clone();
        let mask: Vec<bool> = (0..24).map(|i| i < 20).collect();
        screen[0][1] = 255;
        screen[20..].fill([255; 3]);
        let result = scan_pixels(
            rgb(&screen, 24),
            rgb(&template, 24),
            Some(&mask),
            0,
            0.95,
            limits(),
            || false,
        )
        .unwrap();
        assert_eq!(result.matches[0].score, 0.95);
        assert_eq!(
            scan_pixels(
                rgb(&screen, 24),
                rgb(&template, 24),
                Some(&mask),
                0,
                0.9500000000001,
                limits(),
                || false
            )
            .unwrap()
            .match_count,
            0
        );
        assert!(scan_pixels(
            rgb(&screen, 24),
            rgb(&template, 24),
            Some(&[false; 24]),
            0,
            1.0,
            limits(),
            || false
        )
        .unwrap_err()
        .contains("没有参与像素"));
        assert!(scan_pixels(
            rgb(&screen, 24),
            rgb(&template, 24),
            Some(&[true]),
            0,
            1.0,
            limits(),
            || false
        )
        .unwrap_err()
        .contains("遮罩尺寸"));
    }

    #[test]
    fn rgb_masked_scan_agrees_with_independent_brute_force() {
        let screen: Vec<[u8; 3]> = (0..91)
            .map(|i| {
                [
                    ((i * 37 + i * i * 11) % 256) as u8,
                    ((i * 19) % 256) as u8,
                    ((i * 53) % 256) as u8,
                ]
            })
            .collect();
        let template = [
            screen[15], screen[16], screen[17], screen[28], screen[29], screen[30],
        ];
        let mask = [true, false, true, true, false, true];
        for threshold in [0.25, 0.5, 0.75, 1.0] {
            let optimized = scan_pixels(
                rgb(&screen, 13),
                rgb(&template, 3),
                Some(&mask),
                100,
                threshold,
                limits(),
                || false,
            )
            .unwrap();
            let mut anchors = Vec::new();
            for y in 0usize..6 {
                for x in 0usize..11 {
                    let mut matched = 0;
                    for i in 0..6 {
                        if mask[i]
                            && (0..3).all(|c| {
                                screen[(y + i / 3) * 13 + x + i % 3][c].abs_diff(template[i][c])
                                    <= 100
                            })
                        {
                            matched += 1;
                        }
                    }
                    if matched as f64 / 4.0 >= threshold
                        && !anchors
                            .iter()
                            .any(|&(ax, ay)| x.abs_diff(ax) <= 1 && y.abs_diff(ay) <= 1)
                    {
                        anchors.push((x, y));
                    }
                }
            }
            assert_eq!(optimized.match_count, anchors.len());
            assert_eq!(optimized.visited_positions, 66);
            assert_eq!(optimized.stop_reason, None);
        }
    }

    #[test]
    fn rgb_masked_prefix_and_timeout_keep_explicit_partial_coverage() {
        let template = [[10, 20, 30], [80, 90, 100]];
        let screen = [[10, 20, 30], [255; 3], [0; 3], [10, 20, 30], [255; 3]];
        let prefix = scan_pixels(
            rgb(&screen, 5),
            rgb(&template, 2),
            Some(&[true, false]),
            0,
            1.0,
            Limits {
                max_positions: 1,
                max_clusters: MAX_CLUSTERS,
            },
            || false,
        )
        .unwrap();
        assert_eq!(
            (
                prefix.match_count,
                prefix.visited_positions,
                prefix.total_positions
            ),
            (1, 1, 4)
        );
        assert_eq!(prefix.stop_reason, Some("position_limit"));
        let timeout = scan_pixels(
            rgb(&screen, 5),
            rgb(&template, 2),
            Some(&[true, false]),
            0,
            1.0,
            limits(),
            || true,
        )
        .unwrap();
        assert_eq!(timeout.stop_reason, Some("time_budget"));
        assert_eq!(timeout.visited_positions, 0);
    }

    #[test]
    fn optimized_scan_agrees_with_brute_force_threshold_decisions() {
        // 独立朴素判据，验证区分度排列和提前淘汰没有漏掉阈值内位置。
        let screen: Vec<u8> = (0..91)
            .map(|i| ((i * 37 + i * i * 11) % 256) as u8)
            .collect();
        let template = [11, 60, 140, 219, 86, 177];
        for threshold in [0.5, 2.0 / 3.0, 0.9, 1.0] {
            let optimized = scan(
                image(&screen, 13),
                image(&template, 3),
                20,
                threshold,
                Limits {
                    max_positions: u64::MAX,
                    max_clusters: MAX_CLUSTERS,
                },
                || false,
            )
            .unwrap();
            let mut anchors = Vec::new();
            for y in 0usize..6 {
                for x in 0usize..11 {
                    let matched = template
                        .iter()
                        .enumerate()
                        .filter(|(i, v)| screen[(y + i / 3) * 13 + x + i % 3].abs_diff(**v) <= 20)
                        .count();
                    if matched as f64 / 6.0 >= threshold
                        && !anchors
                            .iter()
                            .any(|&(ax, ay)| x.abs_diff(ax) <= 1 && y.abs_diff(ay) <= 1)
                    {
                        anchors.push((x, y));
                    }
                }
            }
            assert_eq!(optimized.match_count, anchors.len());
            assert_eq!(optimized.visited_positions, 66);
        }
    }
}
