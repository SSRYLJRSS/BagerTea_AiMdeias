//! 感知哈希（W5d，指导书 §W5d）：dHash 9×8 灰度差分 64 位 + 汉明距离 + 高 16 位前缀分桶。
//! 零新依赖（image crate 已有）；与精确 hash（字节级 sha256）互补：dHash 对缩放/轻微色偏/重压缩鲁棒。

use image::DynamicImage;

/// dHash：缩到 9×8 灰度 → 逐行相邻像素差分 → 64 位位图。
/// 差分方向固定（右减左），图片被水平翻转时哈希不匹配（可接受的代价，连拍场景无翻转）。
pub fn dhash(img: &DynamicImage) -> u64 {
    let gray = img.resize_exact(9, 8, image::imageops::FilterType::Triangle).to_luma8();
    let mut hash = 0u64;
    let mut bit = 0;
    for row in gray.rows() {
        let px: Vec<u8> = row.map(|p| p[0]).collect();
        for j in 0..8 {
            if px[j] > px[j + 1] {
                hash |= 1u64 << bit;
            }
            bit += 1;
        }
    }
    hash
}

/// 两个 dHash 的汉明距离（bit 差异数）。
pub fn hamming(a: u64, b: u64) -> u32 {
    (a ^ b).count_ones()
}

/// 高 16 位前缀分桶：把 (id, phash) 按 phash >> 48 分组。
/// 汉明距离 ≤ 8 的两个 64 位哈希，其高 16 位最多差 8 个 bit —— 仍会大量落同桶，
/// 但桶内两两比较把全表 O(n²) 降到「近似重复聚簇的局部比较」（410 行实测微秒级）。
pub fn bucket_by_prefix(rows: impl IntoIterator<Item = (i64, u64)>) -> Vec<(u16, Vec<(i64, u64)>)> {
    let mut buckets: std::collections::HashMap<u16, Vec<(i64, u64)>> = std::collections::HashMap::new();
    for (id, phash) in rows {
        let prefix = (phash >> 48) as u16;
        buckets.entry(prefix).or_default().push((id, phash));
    }
    let mut out: Vec<_> = buckets.into_iter().collect();
    out.sort_by_key(|(k, _)| *k);
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{DynamicImage, Rgb, RgbImage};

    fn solid(rgb: [u8; 3]) -> DynamicImage {
        let mut im = RgbImage::new(24, 16);
        for p in im.pixels_mut() {
            *p = Rgb(rgb);
        }
        DynamicImage::ImageRgb8(im)
    }

    /// 左半边黑右半边白的梯度图（dHash 应稳定产出同一哈希）
    fn half_split(left: [u8; 3], right: [u8; 3]) -> DynamicImage {
        let mut im = RgbImage::new(24, 16);
        for (x, y, p) in im.enumerate_pixels_mut() {
            *p = Rgb(if x < 12 { left } else { right });
        }
        DynamicImage::ImageRgb8(im)
    }

    #[test]
    fn identical_images_same_hash() {
        let a = half_split([0, 0, 0], [255, 255, 255]);
        let b = half_split([0, 0, 0], [255, 255, 255]);
        assert_eq!(dhash(&a), dhash(&b));
        assert_eq!(hamming(dhash(&a), dhash(&b)), 0);
    }

    #[test]
    fn uniform_images_hash_zeroish() {
        // 全黑：每个差分都是 0>0=false → hash 恒 0
        assert_eq!(dhash(&solid([0, 0, 0])), 0);
        // 全白：同样恒 0（差分相等）
        assert_eq!(dhash(&solid([255, 255, 255])), 0);
    }

    #[test]
    fn tiny_edits_yield_small_hamming() {
        let base = half_split([10, 20, 30], [200, 210, 220]);
        let mut shifted = base.clone();
        // 轻微亮度偏移（整图 +10）不该翻转差分方向 → 汉明距离很小
        let rgb = shifted.as_mut_rgb8().unwrap();
        for p in rgb.pixels_mut() {
            p[0] = p[0].saturating_add(10);
            p[1] = p[1].saturating_add(10);
            p[2] = p[2].saturating_add(10);
        }
        assert!(hamming(dhash(&base), dhash(&shifted)) <= 4, "亮度偏移后差异应很小");
    }

    #[test]
    fn resize_robustness() {
        // 同一幅图不同尺寸 → 哈希相同（dHash 对缩放鲁棒，相似检测的核心承诺）
        let small = half_split([10, 20, 30], [200, 210, 220]);
        let mut big = RgbImage::new(480, 320);
        for (x, y, p) in big.enumerate_pixels_mut() {
            *p = Rgb(if x < 240 { [10, 20, 30] } else { [200, 210, 220] });
        }
        let big = DynamicImage::ImageRgb8(big);
        assert_eq!(dhash(&small), dhash(&big), "缩放不应改变 dHash");
    }

    #[test]
    fn opposite_gradient_is_far() {
        // 递增灰度（无差分 → hash 低位全 0）vs 递减灰度（差分全 1 → hash 高位全 1）
        let up = || {
            let mut im = RgbImage::new(24, 16);
            for (x, y, p) in im.enumerate_pixels_mut() {
                let v = (x * 255 / 23) as u8;
                *p = Rgb([v, v, v]);
            }
            DynamicImage::ImageRgb8(im)
        };
        let down = || {
            let mut im = RgbImage::new(24, 16);
            for (x, y, p) in im.enumerate_pixels_mut() {
                let v = 255 - (x * 255 / 23) as u8;
                *p = Rgb([v, v, v]);
            }
            DynamicImage::ImageRgb8(im)
        };
        let d = hamming(dhash(&up()), dhash(&down()));
        assert!(d > 32, "方向相反的渐变差异应显著，实际 {d}");
    }

    #[test]
    fn prefix_bucketing_groups_similar() {
        let rows = vec![
            (1i64, 0xABCD_0000_0000_0001u64),
            (2i64, 0xABCD_0000_0000_0003u64), // 低 48 位仅差 1 bit（汉明 1，应同桶）
            (3i64, 0x0000_FFFF_FFFF_FFFFu64), // 高 16 位不同 → 进另一个桶
        ];
        let buckets = bucket_by_prefix(rows);
        assert_eq!(buckets.len(), 2);
        let pair = buckets
            .iter()
            .find(|(_, v)| v.len() == 2)
            .expect("应存在一个含两条的同前缀桶");
        assert_eq!(
            hamming(pair.1[0].1, pair.1[1].1),
            1,
            "同前缀组内两条应接近"
        );
    }
}
