//! FB2-08：算法提色（Lab 空间 k-means）。
//!
//! 取代"颜色交给视觉大模型输出"的做法——颜色是可精确计算的物理量，算法比 AI 快 3~4 个数量级且确定可复现。
//!
//! 流程（§14.5）：丢弃极端像素（不足则回退全样本，FX-04）→ sRGB→Lab →
//! Hamerly k-means（k=6，3 次取优）→ 合并 ΔE<6 相邻簇 → 按占比降序输出 ≤8 条。
//!
//! **入参必须是已下采样的图像**（调用方走 `imaging::decode_thumb(src, 100)`）。
//! compute_palette 自身不下采样：直接喂原图会让 k-means 在数千万样本上跑。

use image::DynamicImage;
use palette::{FromColor, IntoColor};

/// 一条色板项。
#[derive(Clone, Debug, PartialEq)]
pub struct PaletteEntry {
    pub hex: String,
    pub r: u8,
    pub g: u8,
    pub b: u8,
    /// 占比 0..1，降序
    pub ratio: f32,
}

/// k-means 参数
const K: usize = 6;
const MAX_ITER: usize = 20;
/// Lab 收敛阈值（与 crate 建议一致）
const CONVERGE: f32 = 5.0;
/// 独立运行次数，取 score 最优
const RUNS: usize = 3;
/// ΔE < 该值视为"肉眼看不出差别"，合并
const EPSILON: f32 = 6.0;

/// 极端像素预筛的保留下限：过筛后样本少于原样本的这个比例，说明这张图本身
/// 就以极端亮度为主体（黑白摄影 / 夜景 / 大面积过曝），此时预筛在删主体而不是删边框，
/// 必须回退用全样本 —— 黑白照片的"主色"就是黑/白/灰，这是正确答案而不是缺陷。
/// WHY 是 0.5 而不是分析稿的 0.35：过筛保留 40%（60% 过曝天空 + 40% 地面）时
/// 0.35 不触发回退、天空仍被整体丢掉，指导书自带的 overexposed_sky 用例会失败；
/// 0.5 的语义也最直白 —— 一半以上是极端亮度，极端亮度就是主体。
const PRESCREEN_KEEP_MIN: f32 = 0.5;

/// 由解码后的图计算主色板。纯色图 → 1 簇占~100%。
pub fn compute_palette(img: &DynamicImage) -> Vec<PaletteEntry> {
    let rgba = img.to_rgba8();
    let total_px = rgba.pixels().len();
    if total_px == 0 {
        return Vec::new();
    }
    // 1. 提取像素样本（RGBA → RGB），丢弃极端像素
    let mut all: Vec<[u8; 3]> = Vec::with_capacity(total_px);
    let mut kept: Vec<[u8; 3]> = Vec::with_capacity(total_px);
    for px in rgba.pixels() {
        let rgb = [px[0], px[1], px[2]];
        all.push(rgb);
        let r = px[0] as f32 / 255.0;
        let g = px[1] as f32 / 255.0;
        let b = px[2] as f32 / 255.0;
        // 预筛：低彩度极端亮度直接丢（避免黑边/白底吃掉主色）；L 用 sRGB 亮度近似
        let lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        let maxc = r.max(g).max(b);
        let minc = r.min(g).min(b);
        let sat = if maxc == 0.0 { 0.0 } else { (maxc - minc) / maxc };
        // L* < 4（近纯黑）或 L* > 96（近纯白）且饱和度极低 → 丢
        if (lum < 0.02 && sat < 0.5) || (lum > 0.96 && sat < 0.05) {
            continue;
        }
        kept.push(rgb);
    }
    let rgb_samples = if (kept.len() as f32) < (total_px as f32 * PRESCREEN_KEEP_MIN) {
        all
    } else {
        kept
    };
    if rgb_samples.is_empty() {
        return Vec::new();
    }

    // 2. sRGB → Lab
    let lab: Vec<palette::Lab> = rgb_samples
        .iter()
        .map(|px| {
            palette::Srgb::new(px[0], px[1], px[2])
                .into_format::<f32>()
                .into_color()
        })
        .collect();

    // 3. k-means（Hamerly，多 seed 取优）
    let mut best = kmeans_colors::Kmeans::new();
    let mut best_score = f32::MAX;
    for i in 0..RUNS {
        let run = kmeans_colors::get_kmeans_hamerly(
            K,
            MAX_ITER,
            CONVERGE,
            false,
            &lab,
            i as u64,
        );
        if run.score < best_score {
            best_score = run.score;
            best = run;
        }
    }
    if best.centroids.is_empty() {
        return Vec::new();
    }

    // 4. 按占比聚合（自行按簇累加，避免依赖该库按亮度排序的实现）
    let mut buckets: Vec<LabAgg> = Vec::new();
    for (i, idx) in best.indices.iter().enumerate() {
        let ci = *idx as usize;
        let lab_i = lab[i];
        let rgb_i = rgb_samples[i];
        if buckets.len() <= ci {
            buckets.resize(ci + 1, LabAgg::default());
        }
        buckets[ci].l += lab_i.l;
        buckets[ci].a += lab_i.a;
        buckets[ci].b_v += lab_i.b;
        buckets[ci].r += rgb_i[0] as usize;
        buckets[ci].g += rgb_i[1] as usize;
        buckets[ci].b += rgb_i[2] as usize;
        buckets[ci].count += 1;
    }
    let total = rgb_samples.len() as f32;
    let mut clusters: Vec<Cluster> = buckets
        .into_iter()
        .map(|ag| Cluster {
            l: ag.l / ag.count as f32,
            a: ag.a / ag.count as f32,
            b_v: ag.b_v / ag.count as f32,
            rgb: [
                (ag.r / ag.count).min(255) as u8,
                (ag.g / ag.count).min(255) as u8,
                (ag.b / ag.count).min(255) as u8,
            ],
            ratio: ag.count as f32 / total,
        })
        .collect();

    // 5. 按占比降序
    clusters.sort_by(|a, b| b.ratio.partial_cmp(&a.ratio).unwrap_or(std::cmp::Ordering::Equal));

    // 6. 合并 ΔE<6 的相邻簇（从小的往大的吸，避免色条上出现两块看不出差别的分段）
    clusters = merge_clusters(clusters);

    // 7. 输出（最多 8 条）
    let mut out: Vec<PaletteEntry> = Vec::with_capacity(clusters.len());
    for c in clusters.iter().take(8) {
        out.push(PaletteEntry {
            hex: rgb_to_hex(c.rgb[0], c.rgb[1], c.rgb[2]),
            r: c.rgb[0],
            g: c.rgb[1],
            b: c.rgb[2],
            ratio: (c.ratio as f64 * 100.0).round() as f32 / 100.0,
        });
    }
    out
}

struct Cluster {
    l: f32,
    a: f32,
    b_v: f32,
    rgb: [u8; 3],
    ratio: f32,
}

#[derive(Default, Clone, Copy)]
struct LabAgg {
    l: f32,
    a: f32,
    b_v: f32,
    r: usize,
    g: usize,
    b: usize,
    count: usize,
}

/// Lab 欧氏距离（ΔE76，感知距离近似）
fn delta_(l1: f32, a1: f32, b1: f32, l2: f32, a2: f32, b2: f32) -> f32 {
    ((l1 - l2).powi(2) + (a1 - a2).powi(2) + (b1 - b2).powi(2)).sqrt()
}

/// 贪心合并到不动点（FX-15）：每轮把当前 ΔE 最小且 < EPSILON 的一对簇合成一簇
/// （占比相加，代表色取占比大的那个），直到没有可合并对。
/// 单轮 break 式合并（旧实现）会漏掉"C 能桥接 A 与 B"的情况，结果色条上留下两块肉眼无差别的分段。
/// WHY 合并后不更新代表色的 Lab 坐标：代表色应是某个真实簇的中心，而不是两簇的加权中点
/// （后者可能落在两簇之间"没有像素"的颜色上）。
/// 舍入只在最终输出做一次（compute_palette 第 7 步）—— 过程中舍入会累积误差，
/// 让 ratio 总和偏离 1、色条宽度失真。
fn merge_clusters(mut clusters: Vec<Cluster>) -> Vec<Cluster> {
    loop {
        // 找当前最近的一对（ΔE 最小且 < EPSILON）
        let mut best: Option<(usize, usize, f32)> = None;
        for i in 0..clusters.len() {
            for j in (i + 1)..clusters.len() {
                let d = delta_(
                    clusters[i].l, clusters[i].a, clusters[i].b_v, clusters[j].l, clusters[j].a,
                    clusters[j].b_v,
                );
                if d < EPSILON && best.map(|(_, _, bd)| d < bd).unwrap_or(true) {
                    best = Some((i, j, d));
                }
            }
        }
        let Some((i, j, _)) = best else { break };
        // 保留占比大的那个作为代表色：每轮开头都按占比降序排列过，i<j ⇒ ratio[i] ≥ ratio[j]
        let victim = clusters.remove(j);
        clusters[i].ratio += victim.ratio;
        clusters.sort_by(|a, b| b.ratio.partial_cmp(&a.ratio).unwrap_or(std::cmp::Ordering::Equal));
    }
    clusters
}

/// 由主色（palette[0]）派生 dominant_hue/sat/lum（供索引列与超级搜索）
pub fn dominant_from_rgb(r: u8, g: u8, b: u8) -> (i64, i64, i64) {
    let srgb = palette::Srgb::new(r, g, b).into_format::<f32>();
    let hsv = palette::Hsv::from_color(srgb);
    let hue = (hsv.hue.into_positive_degrees().round() as i64).rem_euclid(360);
    let sat = (hsv.saturation * 100.0).round() as i64;
    let lum = (hsv.value * 100.0).round() as i64;
    (hue, sat, lum)
}

fn rgb_to_hex(r: u8, g: u8, b: u8) -> String {
    format!("#{:02x}{:02x}{:02x}", r, g, b)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn solid_img(r: u8, g: u8, b: u8) -> DynamicImage {
        let img = image::RgbaImage::from_fn(120, 80, |_, _| image::Rgba([r, g, b, 255]));
        DynamicImage::ImageRgba8(img)
    }

    #[test]
    fn solid_color_yields_single_dominant_ratio() {
        let p = compute_palette(&solid_img(30, 120, 200));
        assert!(!p.is_empty(), "纯色图不应空");
        // 主色占比应压倒性
        assert!(p[0].ratio > 0.9, "纯色主色占比应 ≈100%，实际 {}", p[0].ratio);
        // 主色应偏向蓝/青色系（r 低 b 高）
        assert!(p[0].b > p[0].r);
    }

    #[test]
    fn half_black_half_white_yields_two_clusters() {
        let mut img = image::RgbaImage::new(40, 40);
        for (x, _, px) in img.enumerate_pixels_mut() {
            *px = if x < 20 {
                image::Rgba([0, 0, 0, 255])
            } else {
                image::Rgba([255, 255, 255, 255])
            };
        }
        let p = compute_palette(&DynamicImage::ImageRgba8(img));
        // 预筛回退（PRESCREEN_KEEP_MIN）后用全样本：黑白各半应聚出黑、白两簇。
        assert!(p.len() >= 2, "黑白各半应聚出 ≥2 簇，实际 {}", p.len());
        assert!(p[0].ratio < 0.95, "两侧各半，主色占比不应压倒性，实际 {}", p[0].ratio);
    }

    #[test]
    fn all_black_returns_single_black_not_empty() {
        // 语义变更（FX-04）：原 all_black_returns_empty_not_panic 断言"全黑 → 空色板"。
        // 预筛回退后全黑图返回单簇黑色 —— 黑图的主色就是黑，这是正确答案。
        let p = compute_palette(&solid_img(0, 0, 0));
        assert_eq!(p.len(), 1, "全黑图应聚出 1 簇，实际 {}", p.len());
        assert!(p[0].ratio > 0.9);
        assert_eq!(p[0].hex, "#000000");
    }

    #[test]
    fn grayscale_photo_keeps_gray_dominant() {
        // FX-04 回归：低饱和灰阶图（黑白摄影的抽象）主色应是灰阶，而不是空色板。
        let img = image::RgbaImage::from_fn(60, 60, |x, _| {
            let v = (x * 4).min(255) as u8; // 0..240 灰阶
            image::Rgba([v, v, v, 255])
        });
        let p = compute_palette(&DynamicImage::ImageRgba8(img));
        assert!(!p.is_empty(), "灰阶图不应返回空色板");
        for e in &p {
            let spread = e.r.abs_diff(e.g).max(e.g.abs_diff(e.b));
            assert!(spread <= 8, "灰阶图的簇应仍是灰阶，实际 {:?}", e);
        }
    }

    #[test]
    fn overexposed_sky_does_not_lose_subject() {
        // FX-04 回归：60% 近白天空 + 40% 深色地面。预筛若无回退，天空会被整体丢掉。
        let img = image::RgbaImage::from_fn(50, 50, |_, y| {
            if y < 30 { image::Rgba([252, 252, 253, 255]) } else { image::Rgba([48, 62, 40, 255]) }
        });
        let p = compute_palette(&DynamicImage::ImageRgba8(img));
        assert!(p.len() >= 2, "天空与地面应各成一簇，实际 {}", p.len());
        let has_bright = p.iter().any(|e| e.r > 230 && e.g > 230);
        assert!(has_bright, "近白天空不应被整体丢弃：{:?}", p);
    }

    #[test]
    fn sorted_desc_ratio_no_more_than_8() {
        // 一个多色图（12 个颜色）
        let colors: [[u8; 3]; 12] = [
            [200,0,0],[0,200,0],[0,0,200],[200,200,0],[0,200,200],[200,0,200],
            [120,120,120],[40,40,40],[220,220,220],[150,80,20],[20,150,80],[180,20,150],
        ];
        let mut img = image::RgbaImage::new(48, 16);
        // 12 色 × 4 列 = 48 列，每色 4 列宽
        for (x, _, px) in img.enumerate_pixels_mut() {
            let block = x as usize / 4;
            let c = colors[block];
            *px = image::Rgba([c[0], c[1], c[2], 255]);
        }
        let p = compute_palette(&DynamicImage::ImageRgba8(img));
        assert!(p.len() <= 8, "最多 8 条，实际 {}", p.len());
        for w in p.windows(2) {
            assert!(w[0].ratio >= w[1].ratio, "应按占比降序");
        }
    }

    /// FX-15：ΔE < 6 的三簇必须全部合并成一簇（旧实现会留下 2 簇）。
    #[test]
    fn merges_transitively_close_clusters() {
        let img = image::RgbaImage::from_fn(60, 1, |x, _| {
            let c = match x % 3 { 0 => [100, 120, 140], 1 => [102, 122, 142], _ => [104, 124, 144] };
            image::Rgba([c[0], c[1], c[2], 255])
        });
        let p = compute_palette(&DynamicImage::ImageRgba8(img));
        assert_eq!(p.len(), 1, "肉眼无差别的三色应合成一簇，实际 {:?}", p);
        assert!(p[0].ratio > 0.95);
    }

    /// FX-15：ratio 只舍入一次，总和应接近 1。
    #[test]
    fn ratios_sum_close_to_one() {
        let colors: [[u8; 3]; 6] = [
            [200,0,0],[0,200,0],[0,0,200],[200,200,0],[0,200,200],[200,0,200],
        ];
        let img = image::RgbaImage::from_fn(60, 10, |x, _| {
            let c = colors[(x as usize / 10).min(5)];
            image::Rgba([c[0], c[1], c[2], 255])
        });
        let p = compute_palette(&DynamicImage::ImageRgba8(img));
        let sum: f32 = p.iter().map(|e| e.ratio).sum();
        assert!((sum - 1.0).abs() < 0.05, "ratio 总和应≈1（单次舍入），实际 {sum}");
    }

    /// FX-15 附带：k-means 的 indices 必须为每个被引用的桶都提供至少一个样本
    /// （否则 compute_palette 第 4 步的 ag.r / ag.count 会整数除零 panic）。
    /// 用大量随机图压这个不变式 —— 实测 kmeans_colors 0.6 的 Hamerly 实现满足它
    /// （饿死质心会被重随机，indices 只记录实际最近质心），但这依赖于 crate 内部行为，
    /// 升级 kmeans_colors 时这条测试会先红。
    #[test]
    fn kmeans_buckets_have_no_holes() {
        let mut state: u32 = 0x5EED;
        let mut next = || { state ^= state << 13; state ^= state >> 17; state ^= state << 5; state };
        for _ in 0..200 {
            let n = 7 + (next() as usize % 40);
            let img = image::RgbaImage::from_fn(n as u32, 1, |_, _| {
                let r = next();
                image::Rgba([(r & 0xff) as u8, ((r >> 8) & 0xff) as u8, ((r >> 16) & 0xff) as u8, 255])
            });
            // 不 panic 即通过（内部会走 ag.r / ag.count）
            let _ = compute_palette(&DynamicImage::ImageRgba8(img));
        }
    }

    #[test]
    fn dominant_from_rgb_bounds() {
        let (h, s, l) = dominant_from_rgb(255, 0, 0);
        assert!((0..360).contains(&h));
        assert!((0..=100).contains(&s));
        assert!((0..=100).contains(&l));
    }
}