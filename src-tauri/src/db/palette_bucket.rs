//! C-1：色名分桶 —— 与 `src/utils/colorName.ts`（只读）语义严格对应。
//!
//! colorName.ts 的分段（改它必须同步这里；两侧各有测试锁同一张 fixture 表）：
//! - sat < 10 → 灰阶：lum<20 黑 / lum<85 灰 / 其余 白（折叠 深灰/浅灰 → 灰）
//! - sat ≥ 10 → hue 分段（`HUE_NAMES` 端点，闭开区间）：
//!   红[0,15) 橙[15,45) 黄[45,70) 黄绿[70,90) 绿[90,155) 青绿[155,185) 青[185,225)
//!   天蓝[225,255) 蓝[255,295) 紫[295,320) 品红[320,345) 玫红[345,360)
//!   （前缀 深/浅 不产生新桶：深红/浅红仍是 红 —— U-3 只暴露 12 色块 + 黑/灰/白）
//!
//! 桶 id：0..11 = 上述 hue 顺序；12 = 黑；13 = 灰；14 = 白。

/// 桶 id 0..11 对应的中文名（与 colorName.ts HUE_NAMES 顺序一致）。
pub const HUE_BUCKET_NAMES: [&str; 12] = [
    "红", "橙", "黄", "黄绿", "绿", "青绿", "青", "天蓝", "蓝", "紫", "品红", "玫红",
];
/// hue 分段上界（与 HUE_NAMES 端点一致）。
const HUE_ENDS: [f64; 12] = [
    15.0, 45.0, 70.0, 90.0, 155.0, 185.0, 225.0, 255.0, 295.0, 320.0, 345.0, 360.0,
];

pub const BUCKET_BLACK: i64 = 12;
pub const BUCKET_GRAY: i64 = 13;
pub const BUCKET_WHITE: i64 = 14;

/// 由 (hue 0-360, sat 0-100, lum 0-100) 求桶 id 与折叠色名 —— 镜像 colorNameZh 后折叠。
pub fn bucket_for_hsl(hue: f64, sat: f64, lum: f64) -> (i64, &'static str) {
    let h = ((hue % 360.0) + 360.0) % 360.0;
    let s = sat.clamp(0.0, 100.0);
    let l = lum.clamp(0.0, 100.0);
    if s < 10.0 {
        if l < 20.0 {
            return (BUCKET_BLACK, "黑");
        }
        if l < 85.0 {
            return (BUCKET_GRAY, "灰");
        }
        return (BUCKET_WHITE, "白");
    }
    for (i, &end) in HUE_ENDS.iter().enumerate() {
        if h < end {
            return (i as i64, HUE_BUCKET_NAMES[i]);
        }
    }
    (11, "玫红") // 兜底：h≥360 归一后不会到
}

/// RGB (0-255) → 桶。内部先做标准 RGB→HSL（0-360 / 0-100 / 0-100）。
pub fn bucket_of_rgb(r: u8, g: u8, b: u8) -> (i64, &'static str) {
    let (h, s, l) = rgb_to_hsl(r, g, b);
    bucket_for_hsl(h, s, l)
}

/// RGB → HSL。h ∈ [0,360)，s/l ∈ [0,100]。供回填命令（palette_json 存的是 r/g/b）。
pub fn rgb_to_hsl(r: u8, g: u8, b: u8) -> (f64, f64, f64) {
    let rf = r as f64 / 255.0;
    let gf = g as f64 / 255.0;
    let bf = b as f64 / 255.0;
    let max = rf.max(gf).max(bf);
    let min = rf.min(gf).min(bf);
    let l = (max + min) / 2.0;
    let delta = max - min;
    if delta.abs() < 1e-9 {
        return (0.0, 0.0, l * 100.0);
    }
    let s = if l < 0.5 {
        delta / (max + min)
    } else {
        delta / (2.0 - max - min)
    };
    let mut h = if (max - rf).abs() < 1e-9 {
        60.0 * (((gf - bf) / delta) % 6.0)
    } else if (max - gf).abs() < 1e-9 {
        60.0 * ((bf - rf) / delta + 2.0)
    } else {
        60.0 * ((rf - gf) / delta + 4.0)
    };
    if h < 0.0 {
        h += 360.0;
    }
    (h, s * 100.0, l * 100.0)
}

/// 折叠色名 → 桶 id（供 metadata key palette_* 编译时把名字转 bucket）。
pub fn bucket_id_of_name(name: &str) -> Option<i64> {
    match name {
        "红" => Some(0),
        "橙" => Some(1),
        "黄" => Some(2),
        "黄绿" => Some(3),
        "绿" => Some(4),
        "青绿" => Some(5),
        "青" => Some(6),
        "天蓝" => Some(7),
        "蓝" => Some(8),
        "紫" => Some(9),
        "品红" => Some(10),
        "玫红" => Some(11),
        "黑" => Some(BUCKET_BLACK),
        "灰" => Some(BUCKET_GRAY),
        "白" => Some(BUCKET_WHITE),
        _ => None,
    }
}

/// 桶 id → 折叠色名（查询结果反显/日志用）。
pub fn bucket_name(id: i64) -> Option<&'static str> {
    match id {
        0..=11 => Some(HUE_BUCKET_NAMES[id as usize]),
        12 => Some("黑"),
        13 => Some("灰"),
        14 => Some("白"),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// C-1：与 src/utils/colorName.test.ts 锁同一张 fixture 表（同一 (h,s,l) 两侧同断言）。
    /// 覆盖 12 hue + 黑/灰/白 15 桶与边界。
    #[test]
    fn palette_bucket_matches_colorname_ts() {
        // (hue, sat, lum, 期望桶名) —— TS 侧 colorNameZh 折叠后应同名
        let cases: [(f64, f64, f64, &str); 15] = [
            (7.0, 80.0, 50.0, "红"),
            (30.0, 80.0, 50.0, "橙"),
            (55.0, 80.0, 50.0, "黄"),
            (80.0, 80.0, 50.0, "黄绿"),
            (120.0, 80.0, 50.0, "绿"),
            (170.0, 80.0, 50.0, "青绿"),
            (210.0, 80.0, 50.0, "青"),
            (240.0, 80.0, 50.0, "天蓝"),
            (285.0, 80.0, 50.0, "蓝"),
            (305.0, 80.0, 50.0, "紫"),
            (335.0, 80.0, 50.0, "品红"),
            (350.0, 80.0, 50.0, "玫红"),
            (200.0, 0.0, 10.0, "黑"),
            (200.0, 3.0, 50.0, "灰"),
            (200.0, 5.0, 95.0, "白"),
        ];
        for (h, s, l, want) in cases {
            let (id, name) = bucket_for_hsl(h, s, l);
            assert_eq!(name, want, "hsl({h},{s},{l}) 桶名应 {want}");
            assert_eq!(bucket_name(id), Some(want));
            assert_eq!(bucket_id_of_name(want), Some(id));
        }
        // 深/浅前缀不产生新桶（折叠回基色）
        let (_, n1) = bucket_for_hsl(270.0, 80.0, 10.0);
        assert_eq!(n1, "蓝", "深蓝 → 蓝");
        let (_, n2) = bucket_for_hsl(7.0, 80.0, 90.0);
        assert_eq!(n2, "红", "浅红 → 红");
        // 灰阶折叠：深灰/浅灰 → 灰
        let (id, n3) = bucket_for_hsl(200.0, 2.0, 30.0);
        assert_eq!(n3, "灰");
        assert_eq!(id, BUCKET_GRAY);
    }

    /// 桶 id 必须连续 0..=14（表/索引按此设计）。
    #[test]
    fn bucket_ids_are_contiguous() {
        for id in 0..=14i64 {
            assert!(bucket_name(id).is_some(), "id {id} 必须有名字");
        }
        assert_eq!(HUE_BUCKET_NAMES.len(), 12);
    }
}
