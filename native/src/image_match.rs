//! 原分辨率、有覆盖证明的灰度模板匹配。这里不调用 Win32，测试直接给像素数组。
//! 所有合法左上角按行扫描；提前淘汰只发生在某个位置已不可能达到阈值时。
use std::collections::HashMap;

pub const DISPLAY_LIMIT: usize = 8;
pub const MAX_CLUSTERS: usize = 100_000;
pub const MAX_TEMPLATE_PIXELS: usize = 1_048_576;

#[derive(Debug, Clone, Copy)]
pub struct GrayImage<'a> {
    pub pixels: &'a [u8],
    pub width: u32,
    pub height: u32,
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

fn pixel_count(image: GrayImage<'_>) -> Result<usize, String> {
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

/// 按离模板均值的距离排像素，先比较更有区分度的部分。
/// 只排序 256 个灰度值，再计数排列像素，避免百万像素的比较排序阻塞预算检查。
fn comparison_order(
    template: GrayImage<'_>,
    screen_width: usize,
    expired: &mut impl FnMut() -> bool,
) -> Option<Vec<(usize, u8)>> {
    let mut counts = [0usize; 256];
    let mut sum = 0u64;
    for (index, &value) in template.pixels.iter().enumerate() {
        if index % 4096 == 0 && expired() {
            return None;
        }
        counts[value as usize] += 1;
        sum += u64::from(value);
    }
    let count = template.pixels.len() as u64;
    let mut values: Vec<usize> = (0..256).collect();
    values.sort_by_key(|&value| std::cmp::Reverse((value as u64 * count).abs_diff(sum)));
    let mut offsets = [0usize; 256];
    let mut next = 0;
    for value in values {
        offsets[value] = next;
        next += counts[value];
    }
    let mut order = vec![(0usize, 0u8); template.pixels.len()];
    let width = template.width as usize;
    for (index, &value) in template.pixels.iter().enumerate() {
        if index % 4096 == 0 && expired() {
            return None;
        }
        order[offsets[value as usize]] = (index / width * screen_width + index % width, value);
        offsets[value as usize] += 1;
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

pub fn scan(
    screen: GrayImage<'_>,
    template: GrayImage<'_>,
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
    let Some(order) = comparison_order(template, screen.width as usize, &mut expired) else {
        return Ok(result(&[], 0, total_positions, Some("time_budget")));
    };
    let allowed = allowed_mismatches(template_pixels, threshold);
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
                if screen.pixels[base + offset].abs_diff(value) > tolerance {
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
                    score: (template_pixels - mismatch) as f64 / template_pixels as f64,
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
