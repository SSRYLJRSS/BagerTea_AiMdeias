//! 元数据查询编译 + 校验（超级搜索 P1A）：
//! - MetadataFilter 升级为 `{key, op, value, values, min, max}`（serde camelCase，与 TS 对齐）；
//! - 按 key 白名单编译为固定 SQL 表达式，op 白名单决定比较方式，值全部参数绑定；
//! - 未知 key / 非法 op / 非法值一律返回 AppError，不静默忽略。
//!
//! 规范单位（见 contract-v1 §6）：文件大小字节、视频时长毫秒、resolution=width*height、
//! aspect_ratio=width/height；日期为本地时区左闭右开区间；比较字段为 NULL 时不命中。

use rusqlite::types::Value;
use serde::{Deserialize, Serialize};

use super::sql_utils::offset_placeholders;
use crate::error::{AppError, AppResult};

#[allow(unused_imports)]
use chrono::{Local, TimeZone};

/// 元数据比较操作符（一期冻结，见 contract-v1 §4）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MetadataFilter {
    pub key: String,
    pub op: String, // eq | in | contains | gt | gte | lt | lte | between
    #[serde(default)]
    pub value: Option<serde_json::Value>,
    #[serde(default)]
    pub values: Option<Vec<serde_json::Value>>,
    #[serde(default)]
    pub min: Option<serde_json::Value>,
    #[serde(default)]
    pub max: Option<serde_json::Value>,
}

/// 编译结果：where 片段 + 位置参数。
#[derive(Debug)]
pub struct CompiledMetadata {
    pub sql: String,
    pub params: Vec<Value>,
}

/// S0：可搜元数据 key 的**单一事实源**（= key_spec 全部分支）。
/// `key_spec` 入口先按本常量放行，任何不在全集里的 key 一律 None ——
/// 「加 spec 忘了 key」不可能发生（分支不达）；「加 key 忘了 spec」由
/// 验收测试 `whitelist_single_source` 抓住。其余白名单（AI 提示词、
/// schema enum、排序校验）全部引用本常量，不再各自维护一份。
pub const ALL_METADATA_KEYS: &[&str] = &[
    "file_ext",
    "mime_type",
    "video_codec",
    "audio_codec",
    "camera",
    "lens",
    "shutter",
    "iso",
    "aperture",
    "focal",
    "width",
    "height",
    "resolution",
    "aspect_ratio",
    "file_size",
    "duration_ms",
    "dominant_hue",
    "dominant_sat",
    "dominant_lum",
    "latitude",
    "longitude",
    "has_location",
    "rating",
    "favorite",
    "taken_at",
    "created_at",
    "modified_at",
    "folder",
    // C-1：色板关系表三个 rank 范围 key（值 = 折叠色名，eq/in）
    "palette_dominant",
    "palette_top3",
    "palette_any",
];

/// S0：排序字段白名单**单一事实源**。assets.rs `VALID_SORT` / AI 侧
/// `is_valid_sort_by` / `validate_intent` 三份都改为引用本常量。
pub const ALL_SORT_KEYS: &[&str] = &[
    "created_at",
    "taken_at",
    "modified_at",
    "name",
    "size",
    "resolution",
    "rating",
];

/// S0：key 是否在白名单（AI schema / 提示词生成用）。
pub fn is_metadata_key(key: &str) -> bool {
    ALL_METADATA_KEYS.contains(&key)
}

/// S0：key 是否可编译（白名单 + 有完整 spec 分支）。验收测试正向断言用。
pub fn is_supported_metadata_key(key: &str) -> bool {
    key_spec(key).is_some()
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum ValueKind {
    String,
    Number,
    Date,
    Folder,
}

/// 每个 key 的取值类型与允许表达
struct KeySpec {
    kind: ValueKind,
    /// 是否为 NULL 判断（数值/日期字段为 NULL 不命中；字符串按空串/空判断）
    null_guard: Option<&'static str>,
}

fn key_spec(key: &str) -> Option<KeySpec> {
    // S0：key 集合以 ALL_METADATA_KEYS 为唯一事实源 —— 不在全集里的一律 None。
    // 反方向（spec 认识的都在全集里）由此结构性保证：分支先过白名单才可达。
    if !ALL_METADATA_KEYS.contains(&key) {
        return None;
    }
    Some(match key {
        "file_ext" | "mime_type" | "video_codec" | "audio_codec" => KeySpec {
            kind: ValueKind::String,
            null_guard: None,
        },
        "camera" | "lens" | "shutter" => KeySpec {
            kind: ValueKind::String,
            null_guard: None,
        },
        "iso" | "aperture" | "focal" | "width" | "height" | "file_size" | "duration_ms"
        | "dominant_hue" | "dominant_sat" | "dominant_lum" => KeySpec {
            kind: ValueKind::Number,
            null_guard: Some("IS NOT NULL"),
        },
        "resolution" | "aspect_ratio" => KeySpec {
            kind: ValueKind::Number,
            null_guard: Some("IS NOT NULL"),
        },
        // GPS 定位（V18）：带符号十进制度，北纬东经为正；允许负值（不在非负校验名单）
        "latitude" | "longitude" => KeySpec {
            kind: ValueKind::Number,
            null_guard: Some("IS NOT NULL"),
        },
        // 定位有无（分面用）：编译为 CASE 表达式，值域 yes/no
        "has_location" => KeySpec {
            kind: ValueKind::String,
            null_guard: None,
        },
        // C-1：色板桶（EXISTS 子查询编译，值 = 折叠色名；此处仅 String kind 声明）
        "palette_dominant" | "palette_top3" | "palette_any" => KeySpec {
            kind: ValueKind::String,
            null_guard: None,
        },
        // W2-8：评级（0–5；0 = 未评级）。INTEGER 列自带 0 默认值，非 NULL 语义。
        "rating" => KeySpec {
            kind: ValueKind::Number,
            null_guard: None,
        },
        // W2-8：收藏有无（分面用）：仿 has_location 编译为 CASE 表达式，值域 yes/no
        "favorite" => KeySpec {
            kind: ValueKind::String,
            null_guard: None,
        },
        "taken_at" | "created_at" | "modified_at" => KeySpec {
            kind: ValueKind::Date,
            null_guard: Some("IS NOT NULL"),
        },
        "folder" => KeySpec {
            kind: ValueKind::Folder,
            null_guard: None,
        },
        _ => return None,
    })
}

// ════════════════════════════════════════════════════════════════════════════════
// Phase 4（§5.3）NumericDomain 单一事实源
//
// 值域此前在四处各写一遍：TS FIELD_OPTIONS、本文件的 allowed_ops、AI schema 的
// file_size minimum、dimension_warnings 的三条阈值。此处收敛为一张 spec 表，五处消费：
// ① 前端 ValueInput 的 min/max/step/后缀/预设 ② allowed_ops（编译侧同源）
// ③ AI schema 的 minimum/maximum ④ dimension_warnings 量纲阈值 ⑤ 数值分面 domain
// （Phase 7 由 tag_facets 的 num_* 列即时生成同构 domain，与内置 key 混同返回）。
//
// 只收 ValueKind::Number 的 key。palette_* 是显式例外（§5.2 #2/#3：eq+min 挪用成
// 占比阈值，不是区间下界），不进本表 —— 止损线 7 允许例外但不许弱化双向断言。
// ════════════════════════════════════════════════════════════════════════════════

/// 展示后缀（单位，紧贴数字右侧）；f/ 这类前缀走 presets 的 label，不进 suffix。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Unit {
    /// 无特殊控件：裸数字（width/height/focal 数值本身）
    Raw,
    Bytes,
    Millis,
    Pixels,
    Degrees,
    Percent,
    Stars,
    /// 自定义后缀（数值分面 "人" 等），suffix 为展示文本
    Custom(&'static str),
}

/// 数值字段的预设快捷值（label 展示、value 提交），如 16:9、f/2.8、ISO 800。
#[derive(Debug, Clone, Copy)]
struct NumericSpec {
    key: &'static str,
    unit: Unit,
    /// 输入 clamp + AI schema minimum（None = 不限）
    min: Option<f64>,
    max: Option<f64>,
    step: f64,
    decimals: u8,
    presets: &'static [(&'static str, f64)],
    /// dominant_hue：min > max 合法（跨 0°）
    circular: bool,
    /// R2-2 量纲提示阈值（< 该值提示可能写错单位）
    suspicious_below: Option<f64>,
}

/// 数值型 key 的运算符（P0-2：含 `in`，兼容分面以数组传多个离散值）。
/// allowed_ops() 对数值 key 一律返回本常量 —— 一处定义，UI 与编译同源。
const NUMERIC_OPS: &[&str] = &["eq", "in", "gt", "gte", "lt", "lte", "between"];

const ASPECT_PRESETS: &[(&str, f64)] = &[
    ("1:1", 1.0),
    ("4:3", 4.0 / 3.0),
    ("3:2", 3.0 / 2.0),
    ("16:9", 16.0 / 9.0),
    ("9:16", 9.0 / 16.0),
];
const APERTURE_PRESETS: &[(&str, f64)] = &[
    ("f/1.0", 1.0),
    ("f/1.4", 1.4),
    ("f/2.0", 2.0),
    ("f/2.8", 2.8),
    ("f/4.0", 4.0),
    ("f/5.6", 5.6),
    ("f/8.0", 8.0),
    ("f/11", 11.0),
    ("f/16", 16.0),
    ("f/22", 22.0),
];
const ISO_PRESETS: &[(&str, f64)] = &[
    ("ISO 50", 50.0),
    ("ISO 100", 100.0),
    ("ISO 200", 200.0),
    ("ISO 400", 400.0),
    ("ISO 800", 800.0),
    ("ISO 1600", 1600.0),
    ("ISO 3200", 3200.0),
    ("ISO 6400", 6400.0),
    ("ISO 12800", 12800.0),
    ("ISO 25600", 25600.0),
    ("ISO 51200", 51200.0),
    ("ISO 102400", 102400.0),
];
const FOCAL_PRESETS: &[(&str, f64)] =
    &[("24mm", 24.0), ("35mm", 35.0), ("50mm", 50.0), ("85mm", 85.0), ("200mm", 200.0)];

/// §5.1 精确表：15 个数值型 key 的值域/单位/预设。追加新数值 key 必须同步加 spec
/// （双向测试 numeric_domain_single_source 会抓漏）。
const NUMERIC_SPECS: &[NumericSpec] = &[
    NumericSpec {
        key: "file_size",
        unit: Unit::Bytes,
        min: Some(0.0),
        max: None,
        step: 1.0,
        decimals: 0,
        presets: &[],
        circular: false,
        suspicious_below: Some(1024.0),
    },
    NumericSpec {
        key: "duration_ms",
        unit: Unit::Millis,
        min: Some(0.0),
        max: None,
        step: 1.0,
        decimals: 0,
        presets: &[],
        circular: false,
        suspicious_below: Some(100.0),
    },
    NumericSpec {
        key: "resolution",
        unit: Unit::Pixels,
        min: Some(0.0),
        max: None,
        step: 1.0,
        decimals: 0,
        presets: &[],
        circular: false,
        suspicious_below: Some(10_000.0),
    },
    NumericSpec {
        key: "width",
        unit: Unit::Pixels,
        min: Some(0.0),
        max: None,
        step: 1.0,
        decimals: 0,
        presets: &[],
        circular: false,
        suspicious_below: None,
    },
    NumericSpec {
        key: "height",
        unit: Unit::Pixels,
        min: Some(0.0),
        max: None,
        step: 1.0,
        decimals: 0,
        presets: &[],
        circular: false,
        suspicious_below: None,
    },
    NumericSpec {
        key: "aspect_ratio",
        unit: Unit::Raw,
        min: Some(0.0),
        max: None,
        step: 0.01,
        decimals: 4,
        presets: ASPECT_PRESETS,
        circular: false,
        suspicious_below: None,
    },
    NumericSpec {
        key: "iso",
        unit: Unit::Raw,
        min: Some(0.0),
        max: None,
        step: 1.0,
        decimals: 0,
        presets: ISO_PRESETS,
        circular: false,
        suspicious_below: None,
    },
    NumericSpec {
        key: "aperture",
        unit: Unit::Custom("f/"),
        min: Some(0.0),
        max: None,
        step: 1.0 / 3.0,
        decimals: 2,
        presets: APERTURE_PRESETS,
        circular: false,
        suspicious_below: None,
    },
    NumericSpec {
        key: "focal",
        unit: Unit::Custom("mm"),
        min: Some(0.0),
        max: None,
        step: 1.0,
        decimals: 0,
        presets: FOCAL_PRESETS,
        circular: false,
        suspicious_below: None,
    },
    NumericSpec {
        key: "dominant_hue",
        unit: Unit::Degrees,
        min: Some(0.0),
        max: Some(359.0),
        step: 1.0,
        decimals: 0,
        presets: &[],
        circular: true,
        suspicious_below: None,
    },
    NumericSpec {
        key: "dominant_sat",
        unit: Unit::Percent,
        min: Some(0.0),
        max: Some(100.0),
        step: 1.0,
        decimals: 0,
        presets: &[],
        circular: false,
        suspicious_below: None,
    },
    NumericSpec {
        key: "dominant_lum",
        unit: Unit::Percent,
        min: Some(0.0),
        max: Some(100.0),
        step: 1.0,
        decimals: 0,
        presets: &[],
        circular: false,
        suspicious_below: None,
    },
    NumericSpec {
        key: "latitude",
        unit: Unit::Degrees,
        min: Some(-90.0),
        max: Some(90.0),
        step: 0.000_001,
        decimals: 6,
        presets: &[],
        circular: false,
        suspicious_below: None,
    },
    NumericSpec {
        key: "longitude",
        unit: Unit::Degrees,
        min: Some(-180.0),
        max: Some(180.0),
        step: 0.000_001,
        decimals: 6,
        presets: &[],
        circular: false,
        suspicious_below: None,
    },
    NumericSpec {
        key: "rating",
        unit: Unit::Stars,
        min: Some(0.0),
        max: Some(5.0),
        step: 1.0,
        decimals: 0,
        presets: &[],
        circular: false,
        suspicious_below: None,
    },
];

fn numeric_spec(key: &str) -> Option<&'static NumericSpec> {
    NUMERIC_SPECS.iter().find(|s| s.key == key)
}

/// 数值 key 是否允许区间倒置（唯一例外：dominant_hue 跨 0°）
fn is_circular_numeric(key: &str) -> bool {
    numeric_spec(key).is_some_and(|s| s.circular)
}

/// 数值 key 的展示单位（前缀/后缀文本：f/、mm、B、px…）
fn numeric_unit_label(key: &str) -> Option<&'static str> {
    let s = numeric_spec(key)?;
    match s.unit {
        Unit::Bytes => Some("B"),
        Unit::Millis => Some("ms"),
        Unit::Pixels => Some("px"),
        Unit::Degrees => Some("°"),
        Unit::Percent => Some("%"),
        Unit::Stars => Some("星"),
        Unit::Raw => None,
        Unit::Custom(label) => Some(label),
    }
}

fn unit_tag(u: Unit) -> &'static str {
    match u {
        Unit::Raw => "raw",
        Unit::Bytes => "bytes",
        Unit::Millis => "millis",
        Unit::Pixels => "pixels",
        Unit::Degrees => "degrees",
        Unit::Percent => "percent",
        Unit::Stars => "stars",
        Unit::Custom(_) => "custom",
    }
}

/// Phase 4（§5.3）下发给前端的数值字段 domain —— 一处定义，五处消费。
/// `unit` = 控件类型标签（raw|bytes|millis|pixels|degrees|percent|stars|custom），
/// `unitLabel` = 单位展示文本（f/、mm、B、px、°、%…，None = 无单位）。
/// presets 以 (label, value) 元组序列化，UI 渲染成快捷 chip。
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NumericDomain {
    pub key: String,
    /// V24（Phase 7-8）：数值分面的显示名（人数）；内置 key 由前端字段表提供 label，此列为 None
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    pub unit: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unit_label: Option<String>,
    pub min: Option<f64>,
    pub max: Option<f64>,
    pub step: f64,
    pub decimals: u8,
    pub presets: Vec<(String, f64)>,
    pub circular: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub suspicious_below: Option<f64>,
    pub allowed_ops: Vec<String>,
}

fn build_domain(s: &'static NumericSpec) -> NumericDomain {
    NumericDomain {
        key: s.key.into(),
        label: None,
        unit: unit_tag(s.unit).into(),
        unit_label: numeric_unit_label(s.key).map(String::from),
        min: s.min,
        max: s.max,
        step: s.step,
        decimals: s.decimals,
        presets: s.presets.iter().map(|(l, v)| (l.to_string(), *v)).collect(),
        circular: s.circular,
        suspicious_below: s.suspicious_below,
        allowed_ops: NUMERIC_OPS.iter().map(|x| x.to_string()).collect(),
    }
}

/// 全部内置数值 domain（get_numeric_domains 命令的数据源）。
pub fn numeric_domains() -> Vec<NumericDomain> {
    NUMERIC_SPECS.iter().map(|s| build_domain(s)).collect()
}

/// V24（§5.3/Phase 7-8）：数值分面的 domain —— 由 tag_facets 的 num_* 五列即时生成，
/// key = "facet:<facet_key>"，label = 显示名。与内置 key 混在同一列表返回（§5.3 第五消费点）。
pub fn facet_numeric_domains(conn: &rusqlite::Connection) -> Vec<NumericDomain> {
    let mut stmt = match conn.prepare(
        "SELECT key, display_name, num_min, num_max, num_unit, num_decimals, num_step
           FROM tag_facets WHERE facet_kind = 'number' ORDER BY sort_order",
    ) {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };
    let rows = stmt.query_map([], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, Option<f64>>(2)?,
            r.get::<_, Option<f64>>(3)?,
            r.get::<_, String>(4)?,
            r.get::<_, i64>(5)?,
            r.get::<_, f64>(6)?,
        ))
    });
    let Ok(rows) = rows else { return Vec::new() };
    rows.filter_map(|r| r.ok())
        .map(|(key, name, min, max, unit, decimals, step)| NumericDomain {
            key: format!("facet:{key}"),
            label: Some(name),
            unit: "custom".into(),
            unit_label: if unit.is_empty() { None } else { Some(unit) },
            min,
            max,
            step,
            decimals: decimals.clamp(0, 6) as u8,
            presets: Vec::new(),
            circular: false,
            suspicious_below: None,
            allowed_ops: NUMERIC_OPS.iter().map(|x| x.to_string()).collect(),
        })
        .collect()
}

/// get_numeric_domains 命令的数据源：内置 + 数值分面（动态段）。
pub fn numeric_domains_with_facets(conn: &rusqlite::Connection) -> Vec<NumericDomain> {
    let mut out = numeric_domains();
    out.extend(facet_numeric_domains(conn));
    out
}

/// 单 key 数值 domain（None = 非数值字段）。
pub fn numeric_domain(key: &str) -> Option<NumericDomain> {
    numeric_spec(key).map(build_domain)
}

/// 每个 key 允许的操作符（contract-v1 §4）。数值 key 的集合以 NUMERIC_OPS 为唯一事实源。
fn allowed_ops(key: &str) -> &'static [&'static str] {
    if numeric_spec(key).is_some() {
        return NUMERIC_OPS;
    }
    match key {
        "file_ext" | "mime_type" => &["eq", "in"],
        "video_codec" | "audio_codec" | "camera" | "lens" | "shutter" => &["eq", "in", "contains"],
        "has_location" => &["eq", "in"],
        "palette_dominant" | "palette_top3" | "palette_any" => &["eq", "in"],
        // W2-8：收藏有无
        "favorite" => &["eq", "in"],
        "taken_at" | "created_at" | "modified_at" => &["gte", "lte", "between"],
        "folder" => &["eq", "in"],
        _ => &[],
    }
}

/// 编译 key 的取值表达式（列名来自白名单 match，绝不来自外部输入）
fn value_expr(key: &str) -> String {
    match key {
        "file_ext" => "lower(a.file_ext)".into(),
        "mime_type" => "a.mime_type".into(),
        "camera" => "a.camera".into(),
        "lens" => "a.lens".into(),
        "shutter" => "a.shutter".into(),
        "video_codec" => "lower(a.video_codec)".into(),
        "audio_codec" => "lower(a.audio_codec)".into(),
        "iso" => "a.iso".into(),
        "aperture" => "a.aperture".into(),
        "focal" => "a.focal".into(),
        "width" => "a.width".into(),
        "height" => "a.height".into(),
        "resolution" => "(a.width * a.height)".into(),
        "aspect_ratio" => "(CAST(a.width AS REAL) / a.height)".into(),
        "file_size" => "a.file_size".into(),
        "duration_ms" => "a.duration_ms".into(),
        "dominant_hue" => "a.dominant_hue".into(),
        "dominant_sat" => "a.dominant_sat".into(),
        "dominant_lum" => "a.dominant_lum".into(),
        "latitude" => "a.latitude".into(),
        "longitude" => "a.longitude".into(),
        "has_location" => {
            "(CASE WHEN a.latitude IS NOT NULL AND a.longitude IS NOT NULL THEN 'yes' ELSE 'no' END)"
                .into()
        }
        // W2-8：收藏有无（favorite 列 0/1，分面侧呈现 yes/no）
        "favorite" => "(CASE WHEN a.favorite = 1 THEN 'yes' ELSE 'no' END)".into(),
        "rating" => "a.rating".into(),
        "taken_at" => "a.taken_at".into(),
        "created_at" => "a.created_at".into(),
        "modified_at" => "a.modified_at".into(),
        "folder" => "a.file_path".into(),
        _ => String::new(),
    }
}

/// resolution / aspect_ratio 必须同时非空；aspect_ratio 还要求 height != 0（除数）
fn extra_null_guard(key: &str) -> Option<&'static str> {
    match key {
        "resolution" => Some("a.width IS NOT NULL AND a.height IS NOT NULL"),
        "aspect_ratio" => Some("a.width IS NOT NULL AND a.height IS NOT NULL AND a.height != 0"),
        _ => None,
    }
}

fn escape_like(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
}

/// 解析日期字符串（YYYY-MM-DD 或完整 ISO 时间）为本地时区当日起始毫秒。
/// 左闭右开：between 的 max 取该日+1 天起始（含头不含尾）。
fn parse_date_ms(s: &str) -> AppResult<i64> {
    let s = s.trim();
    let dt = chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d")
        .map(|d| d.and_hms_opt(0, 0, 0).expect("00:00:00 恒合法"))
        .map_err(|_| AppError::msg(format!("无法解析日期（需 YYYY-MM-DD）：{s}")))?;
    let local = Local
        .from_local_datetime(&dt)
        .single()
        .ok_or_else(|| AppError::msg(format!("日期不在本地时区有效范围：{s}")))?;
    Ok(local.timestamp_millis())
}

/// 取日期次日起始（用于左闭右开的上界）
fn next_day_ms(s: &str) -> AppResult<i64> {
    let s = s.trim();
    let d = chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d")
        .map_err(|_| AppError::msg(format!("无法解析日期（需 YYYY-MM-DD）：{s}")))?;
    let next = d
        .succ_opt()
        .ok_or_else(|| AppError::msg(format!("日期无后继：{s}")))?;
    let dt = next.and_hms_opt(0, 0, 0).expect("00:00:00 恒合法");
    let local = Local
        .from_local_datetime(&dt)
        .single()
        .ok_or_else(|| AppError::msg(format!("日期不在本地时区有效范围：{s}")))?;
    Ok(local.timestamp_millis())
}

/// 校验并编译单个元数据条件。校验失败返回 AppError。
/// R2-2：量纲可疑区间的人话提示（不报错 —— 手填 100 字节是合法的，但值得点一句）。
/// 把「静默 0 结果」变成「0 结果 + 一句人话」。只对数值型键的单值/min/max 生效。
/// C-1：palette_* 编译为对 asset_palette_colors 的 EXISTS（值 = 折叠色名 → 桶 id）。
/// - palette_dominant → rank=0；palette_top3 → rank<3；palette_any → 不限 rank。
/// 实测关系表覆盖索引（ix_apc_bucket）；like/字符串列是 SCAN，故不用。
/// U-3：eq + 数字 min = 占比阈值（「前三色含红且红占 ≥50%」→ bucket=红 AND ratio>=0.5）。
/// 复用数值条件的 min 字段表达阈值，allowed_ops 仍只 eq/in —— AI schema 与校验面不变。
fn compile_palette_meta(f: &MetadataFilter) -> AppResult<Option<CompiledMetadata>> {
    let rank_sql = match f.key.as_str() {
        "palette_dominant" => Some(" AND apc.rank = 0"),
        "palette_top3" => Some(" AND apc.rank < 3"),
        "palette_any" => None,
        _ => return Ok(None),
    };
    let rank_sql = match rank_sql {
        Some(x) => x,
        None => return Ok(None), // 非 palette key
    };
    let ratio_min = f.min.as_ref().and_then(json_f64);
    let names: Vec<String> = match f.op.as_str() {
        "eq" => {
            if ratio_min.is_some() {
                // U-3：占比阈值 = 单色 eq + min（避免「多种颜色共享一个阈值」的歧义）
                let Some(v) = f.value.as_ref() else {
                    return Err(AppError::msg("palette 等值条件缺少 value"));
                };
                match v {
                    serde_json::Value::String(s) => vec![s.clone()],
                    _ => return Err(AppError::msg("带占比阈值的色板条件一次只能选一种颜色")),
                }
            } else {
                let Some(v) = f.value.as_ref() else {
                    return Err(AppError::msg("palette 等值条件缺少 value"));
                };
                match v {
                    serde_json::Value::String(s) => vec![s.clone()],
                    serde_json::Value::Array(a) => a
                        .iter()
                        .filter_map(|x| x.as_str().map(String::from))
                        .collect(),
                    _ => return Err(AppError::msg("palette 等值条件值必须是色名")),
                }
            }
        }
        "in" => {
            if ratio_min.is_some() {
                return Err(AppError::msg("带占比阈值的色板条件仅支持等于（eq）单色"));
            }
            let mut out = Vec::new();
            if let Some(v) = f.value.as_ref() {
                if let Some(x) = v.as_str() {
                    out.push(x.to_string());
                }
            }
            if let Some(arr) = f.values.as_ref() {
                for x in arr {
                    if let Some(x) = x.as_str() {
                        out.push(x.to_string());
                    }
                }
            }
            if out.is_empty() {
                return Err(AppError::msg("palette in 条件缺少 values"));
            }
            out
        }
        _ => return Err(AppError::msg(format!("色板 key 不支持操作符：{}", f.op))),
    };
    let mut ids: Vec<i64> = Vec::new();
    for name in &names {
        let id = crate::db::palette_bucket::bucket_id_of_name(name).ok_or_else(|| {
            AppError::msg(format!("未知色名：{name}（可用：红/橙/黄/黄绿/绿/青绿/青/天蓝/蓝/紫/品红/玫红/黑/灰/白）"))
        })?;
        ids.push(id);
    }
    // U-3：单色 + 阈值 → ratio >= min（先绑定颜色再限定占比，覆盖索引依然可用）
    if let Some(r) = ratio_min {
        if ids.len() != 1 {
            return Err(AppError::msg("带占比阈值的色板条件一次只能选一种颜色"));
        }
        if !(0.0..=1.0).contains(&r) {
            return Err(AppError::msg("色板占比阈值必须在 0..1 之间"));
        }
        return Ok(Some(CompiledMetadata {
            sql: format!(
                "EXISTS (SELECT 1 FROM asset_palette_colors apc WHERE apc.asset_id = a.id AND apc.color_bucket = ?1 AND apc.ratio >= ?2{rank_sql})"
            ),
            params: vec![Value::Integer(ids[0]), Value::Real(r)],
        }));
    }
    let ph = ids
        .iter()
        .enumerate()
        .map(|(i, _)| format!("?{}", i + 1))
        .collect::<Vec<_>>()
        .join(",");
    let params = ids.into_iter().map(Value::Integer).collect::<Vec<_>>();
    Ok(Some(CompiledMetadata {
        sql: format!(
            "EXISTS (SELECT 1 FROM asset_palette_colors apc WHERE apc.asset_id = a.id AND apc.color_bucket IN ({ph}){rank_sql})"
        ),
        params,
    }))
}

/// JSON 数值（数字字面量或可解析字符串）→ f64。
fn json_f64(v: &serde_json::Value) -> Option<f64> {
    match v {
        serde_json::Value::Number(n) => n.as_f64(),
        serde_json::Value::String(s) => s.trim().parse::<f64>().ok(),
        _ => None,
    }
}

pub fn dimension_warnings(f: &MetadataFilter) -> Vec<String> {
    let mut out = Vec::new();
    let num = |v: &serde_json::Value| -> Option<f64> {
        match v {
            serde_json::Value::Number(n) => n.as_f64(),
            serde_json::Value::String(s) => s.trim().parse::<f64>().ok(),
            _ => None,
        }
    };
    let mut probe = |tag: &str, v: &serde_json::Value| {
        let Some(x) = num(v) else { return };
        // 阈值单一事实源 = NumericDomain（§5.3）：低于 suspicious_below 提示量纲可疑。
        let sb = numeric_spec(&f.key).and_then(|s| s.suspicious_below);
        let msg = match (f.key.as_str(), sb) {
            ("file_size", Some(b)) if x < b => {
                Some("文件大小小于 1 KB，是否想写 MB？已按字节执行。".to_string())
            }
            ("duration_ms", Some(b)) if x < b && f.op != "eq" => {
                Some("时长小于 0.1 秒，单位是毫秒。".to_string())
            }
            ("resolution", Some(b)) if x < b => {
                Some("分辨率是总像素数（1920×1080 = 2073600），不是边长。".to_string())
            }
            _ => None,
        };
        if let Some(m) = msg {
            out.push(if tag.is_empty() { m } else { format!("{tag}：{m}") });
        }
    };
    if let Some(v) = &f.value {
        probe("", v);
    }
    if let Some(v) = &f.min {
        probe("范围下限", v);
    }
    if let Some(v) = &f.max {
        probe("范围上限", v);
    }
    out
}

pub fn compile_metadata(f: &MetadataFilter) -> AppResult<Option<CompiledMetadata>> {
    let spec =
        key_spec(&f.key).ok_or_else(|| AppError::msg(format!("未知元数据字段：{}", f.key)))?;
    let ops = allowed_ops(&f.key);
    if !ops.contains(&f.op.as_str()) {
        return Err(AppError::msg(format!(
            "字段 {} 不支持操作符：{}",
            f.key, f.op
        )));
    }

    // C-1：色板 key 走专用 EXISTS 编译（非列比较）
    if let Some(c) = compile_palette_meta(f)? {
        return Ok(Some(c));
    }
    // 值校验按 kind 分支
    match spec.kind {
        ValueKind::String => compile_string(f, &spec, ops),
        ValueKind::Number => compile_number(f, &spec),
        ValueKind::Date => compile_date(f, &spec),
        ValueKind::Folder => compile_folder(f, &spec),
    }
}

fn compile_string(
    f: &MetadataFilter,
    spec: &KeySpec,
    _ops: &[&str],
) -> AppResult<Option<CompiledMetadata>> {
    let expr = value_expr(&f.key);
    let null_guard = spec.null_guard.map(|g| format!(" AND {expr} {g}"));
    match f.op.as_str() {
        "eq" => {
            let v =
                f.value.as_ref().and_then(|v| v.as_str()).ok_or_else(|| {
                    AppError::msg(format!("字段 {} 的 eq 需要字符串 value", f.key))
                })?;
            if v.chars().count() > 200 {
                return Err(AppError::msg("字符串值过长"));
            }
            Ok(Some(
                CompiledMetadata {
                    sql: format!("{expr} = ?1"),
                    params: vec![Value::Text(v.to_string())],
                }
                .with_null_guard(null_guard),
            ))
        }
        "in" => {
            let values = f
                .values
                .as_ref()
                .ok_or_else(|| AppError::msg(format!("字段 {} 的 in 需要 values 数组", f.key)))?;
            if values.is_empty() {
                return Err(AppError::msg(format!(
                    "字段 {} 的 in values 不能为空",
                    f.key
                )));
            }
            if values.len() > 100 {
                return Err(AppError::msg("in 的 values 数量超出上限"));
            }
            let mut params = Vec::new();
            let mut marks = String::new();
            for v in values {
                let s = v
                    .as_str()
                    .ok_or_else(|| AppError::msg(format!("字段 {} 的 in 需要字符串数组", f.key)))?;
                if s.chars().count() > 200 {
                    return Err(AppError::msg("字符串值过长"));
                }
                params.push(Value::Text(s.to_string()));
                if !marks.is_empty() {
                    marks.push(',');
                }
                marks.push_str(&format!("?{}", params.len()));
            }
            Ok(Some(
                CompiledMetadata {
                    sql: format!("{expr} IN ({marks})"),
                    params,
                }
                .with_null_guard(null_guard),
            ))
        }
        "contains" => {
            let v = f.value.as_ref().and_then(|v| v.as_str()).ok_or_else(|| {
                AppError::msg(format!("字段 {} 的 contains 需要字符串 value", f.key))
            })?;
            if v.chars().count() > 200 {
                return Err(AppError::msg("字符串值过长"));
            }
            let pattern = format!("%{}%", escape_like(v));
            Ok(Some(
                CompiledMetadata {
                    sql: format!("{expr} LIKE ?1 ESCAPE '\\'"),
                    params: vec![Value::Text(pattern)],
                }
                .with_null_guard(null_guard),
            ))
        }
        _ => Err(AppError::msg(format!(
            "字段 {} 不支持操作符：{}",
            f.key, f.op
        ))),
    }
}

fn compile_number(f: &MetadataFilter, spec: &KeySpec) -> AppResult<Option<CompiledMetadata>> {
    let expr = value_expr(&f.key);
    let extra = extra_null_guard(&f.key);
    let null_guard = match (&spec.null_guard, extra) {
        (Some(g), Some(e)) => format!(" AND {expr} {g} AND {e}"),
        (Some(g), None) => format!(" AND {expr} {g}"),
        (None, Some(e)) => format!(" AND {e}"),
        (None, None) => String::new(),
    };
    // P0-2：同时接受 JSON number 与数字字符串（普通素材库分面以字符串形式传入值）。
    // 转换失败仍返回明确错误，不在命令层偷偷转换，编译逻辑集中在 search_query.rs。
    let num = |v: &serde_json::Value| -> AppResult<f64> {
        let n = match v {
            serde_json::Value::Number(n) => n.as_f64(),
            serde_json::Value::String(s) => s.trim().parse::<f64>().ok(),
            _ => None,
        }
        .ok_or_else(|| AppError::msg(format!("字段 {} 需要数值，收到：{v}", f.key)))?;
        if !n.is_finite() {
            return Err(AppError::msg(format!("字段 {} 数值必须有限", f.key)));
        }
        // 非负尺寸/大小/时长
        if matches!(
            f.key.as_str(),
            "width" | "height" | "resolution" | "file_size" | "duration_ms"
        ) && n < 0.0
        {
            return Err(AppError::msg(format!("字段 {} 不能为负", f.key)));
        }
        Ok(n)
    };
    let bind_num = |n: f64| -> Value {
        // 整数列用 Integer，避免浮点比较精度问题
        if n.fract() == 0.0 {
            Value::Integer(n as i64)
        } else {
            Value::Real(n)
        }
    };
    let op_sql = |op: &str| -> String {
        match op {
            "gt" => format!("{expr} > ?1"),
            "gte" => format!("{expr} >= ?1"),
            "lt" => format!("{expr} < ?1"),
            "lte" => format!("{expr} <= ?1"),
            "eq" => format!("{expr} = ?1"),
            _ => String::new(),
        }
    };
    match f.op.as_str() {
        "gt" | "gte" | "lt" | "lte" | "eq" => {
            let v = f
                .value
                .as_ref()
                .ok_or_else(|| AppError::msg(format!("字段 {} 的 {} 需要 value", f.key, f.op)))?;
            let n = num(v)?;
            let final_sql = format!(
                "{base}{guard}",
                base = op_sql(f.op.as_str()),
                guard = null_guard
            );
            Ok(Some(CompiledMetadata {
                sql: final_sql,
                params: vec![bind_num(n)],
            }))
        }
        "between" => {
            let min = f
                .min
                .as_ref()
                .ok_or_else(|| AppError::msg(format!("字段 {} 的 between 需要 min", f.key)))?;
            let max = f
                .max
                .as_ref()
                .ok_or_else(|| AppError::msg(format!("字段 {} 的 between 需要 max", f.key)))?;
            let lo = num(min)?;
            let hi = num(max)?;
            // FB2-08（§14.9③）：色相是环形量。min > max 表示区间跨越 0°（如红色 345~15），
            // 必须编译为双区间 OR，否则 BETWEEN 345 AND 15 恒为空集，"搜红色素材"静默返回 0 条。
            // 是否允许倒置以 NumericDomain.circular 为唯一事实源（§5.3）。
            if is_circular_numeric(&f.key) && lo > hi {
                return Ok(Some(CompiledMetadata {
                    sql: format!("({expr} >= ?1 OR {expr} <= ?2){guard}", guard = null_guard),
                    params: vec![bind_num(lo), bind_num(hi)],
                }));
            }
            if hi < lo {
                return Err(AppError::msg(format!("字段 {} 的 between 区间倒置", f.key)));
            }
            Ok(Some(CompiledMetadata {
                sql: format!("{expr} >= ?1 AND {expr} <= ?2{guard}", guard = null_guard),
                params: vec![bind_num(lo), bind_num(hi)],
            }))
        }
        "in" => {
            let values = f
                .values
                .as_ref()
                .ok_or_else(|| AppError::msg(format!("字段 {} 的 in 需要 values 数组", f.key)))?;
            if values.is_empty() {
                return Err(AppError::msg(format!(
                    "字段 {} 的 in values 不能为空",
                    f.key
                )));
            }
            if values.len() > 100 {
                return Err(AppError::msg("in 的 values 数量超出上限"));
            }
            let mut params = Vec::new();
            let mut marks = String::new();
            for v in values {
                let n = num(v)?;
                params.push(bind_num(n));
                if !marks.is_empty() {
                    marks.push(',');
                }
                marks.push_str(&format!("?{}", params.len()));
            }
            Ok(Some(CompiledMetadata {
                sql: format!("{expr} IN ({marks}){guard}", guard = null_guard),
                params,
            }))
        }
        _ => Err(AppError::msg(format!(
            "字段 {} 不支持操作符：{}",
            f.key, f.op
        ))),
    }
}

fn compile_date(f: &MetadataFilter, _spec: &KeySpec) -> AppResult<Option<CompiledMetadata>> {
    let expr = value_expr(&f.key);
    let bind_text = |ms: i64| Value::Integer(ms);
    match f.op.as_str() {
        "gte" => {
            let v =
                f.value.as_ref().and_then(|v| v.as_str()).ok_or_else(|| {
                    AppError::msg(format!("字段 {} 的 gte 需要日期 value", f.key))
                })?;
            let ms = parse_date_ms(v)?;
            Ok(Some(CompiledMetadata {
                sql: format!("{expr} >= ?1 AND {expr} IS NOT NULL"),
                params: vec![bind_text(ms)],
            }))
        }
        "lte" => {
            let v =
                f.value.as_ref().and_then(|v| v.as_str()).ok_or_else(|| {
                    AppError::msg(format!("字段 {} 的 lte 需要日期 value", f.key))
                })?;
            // 含当天 → < 次日起始（左闭右开）
            let ms = next_day_ms(v)?;
            Ok(Some(CompiledMetadata {
                sql: format!("{expr} < ?1 AND {expr} IS NOT NULL"),
                params: vec![bind_text(ms)],
            }))
        }
        "between" => {
            let min =
                f.min.as_ref().and_then(|v| v.as_str()).ok_or_else(|| {
                    AppError::msg(format!("字段 {} 的 between 需要 min 日期", f.key))
                })?;
            let max =
                f.max.as_ref().and_then(|v| v.as_str()).ok_or_else(|| {
                    AppError::msg(format!("字段 {} 的 between 需要 max 日期", f.key))
                })?;
            let lo = parse_date_ms(min)?;
            let hi = next_day_ms(max)?; // max 含当天，取次日起始作上界
            if hi <= lo {
                return Err(AppError::msg(format!("字段 {} 的日期区间无效", f.key)));
            }
            Ok(Some(CompiledMetadata {
                sql: format!("{expr} >= ?1 AND {expr} < ?2 AND {expr} IS NOT NULL"),
                params: vec![bind_text(lo), bind_text(hi)],
            }))
        }
        _ => Err(AppError::msg(format!(
            "字段 {} 不支持操作符：{}",
            f.key, f.op
        ))),
    }
}

fn compile_folder(f: &MetadataFilter, spec: &KeySpec) -> AppResult<Option<CompiledMetadata>> {
    let expr = value_expr(&f.key);
    let _ = spec;
    // folder 语义：匹配该目录（含子目录）。values 为目录路径列表。
    let dir_cond = |dir: &str, params: &mut Vec<Value>| -> AppResult<String> {
        if dir.chars().count() > 500 {
            return Err(AppError::msg("文件夹路径过长"));
        }
        let dir = dir.trim_end_matches('/');
        let pattern = format!("{}/%", escape_like(dir));
        params.push(Value::Text(pattern));
        Ok(format!("{expr} LIKE ?{} ESCAPE '\\'", params.len()))
    };
    match f.op.as_str() {
        "eq" => {
            let v = f
                .value
                .as_ref()
                .and_then(|v| v.as_str())
                .ok_or_else(|| AppError::msg(format!("字段 folder 的 eq 需要路径 value")))?;
            let mut params = Vec::new();
            let cond = dir_cond(v, &mut params)?;
            Ok(Some(CompiledMetadata { sql: cond, params }))
        }
        "in" => {
            let values = f
                .values
                .as_ref()
                .ok_or_else(|| AppError::msg(format!("字段 folder 的 in 需要 values 数组")))?;
            if values.is_empty() {
                return Err(AppError::msg("folder 的 in values 不能为空"));
            }
            if values.len() > 100 {
                return Err(AppError::msg("folder 的 in values 数量超出上限"));
            }
            let mut params = Vec::new();
            let mut conds = Vec::new();
            for v in values {
                let s = v
                    .as_str()
                    .ok_or_else(|| AppError::msg("folder 需要路径字符串数组"))?;
                conds.push(dir_cond(s, &mut params)?);
            }
            Ok(Some(CompiledMetadata {
                sql: format!("({})", conds.join(" OR ")),
                params,
            }))
        }
        _ => Err(AppError::msg(format!("字段 folder 不支持操作符：{}", f.op))),
    }
}

/// 追加 NULL 守卫的辅助封装
impl CompiledMetadata {
    fn with_null_guard(self, guard: Option<String>) -> Self {
        match guard {
            Some(g) => Self {
                sql: format!("{} {g}", self.sql),
                params: self.params,
            },
            None => self,
        }
    }
}

/// 校验 AssetFilter 中全部元数据条件（仅结构，不发 SQL）；供命令层入参校验用。
pub fn validate_metadata(filters: &[MetadataFilter]) -> AppResult<()> {
    if filters.len() > 100 {
        return Err(AppError::msg("元数据条件数量超出上限"));
    }
    for f in filters {
        compile_metadata(f)?;
    }
    Ok(())
}

/// 测试辅助：编译一批元数据条件 → 拼接为可嵌入 WHERE 的字符串与参数。
/// 供 assets::build_where 复用（主链路）。
pub fn compile_metadata_all(filters: &[MetadataFilter]) -> AppResult<Option<(String, Vec<Value>)>> {
    let mut parts: Vec<String> = Vec::new();
    let mut params: Vec<Value> = Vec::new();
    for f in filters {
        let Some(c) = compile_metadata(f)? else {
            continue;
        };
        // 把编译结果中占位符统一偏移到全局参数索引
        let shifted = offset_placeholders(&c.sql, params.len());
        parts.push(format!("({shifted})"));
        params.extend(c.params);
    }
    if parts.is_empty() {
        Ok(None)
    } else {
        Ok(Some((parts.join(" AND "), params)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn between(key: &str, min: i64, max: i64) -> MetadataFilter {
        MetadataFilter {
            key: key.into(),
            op: "between".into(),
            value: None,
            values: None,
            min: Some(serde_json::json!(min)),
            max: Some(serde_json::json!(max)),
        }
    }

    /// FB2-08（§14.9③）：色相环形 —— min>max 编译为双区间 OR（搜红色 345~15 同时命中 350 与 10）。
    #[test]
    fn dominant_hue_wraps_red_across_zero() {
        let c = compile_metadata(&between("dominant_hue", 345, 15))
            .unwrap()
            .unwrap();
        assert!(c.sql.contains("OR"), "应编译为双区间 OR，实际：{}", c.sql);
        assert_eq!(c.params.len(), 2);
    }

    /// FB2-08：dominant_sat 白名单 / between 正向区间正常。
    #[test]
    fn dominant_sat_between_compiles() {
        let c = compile_metadata(&between("dominant_sat", 10, 60))
            .unwrap()
            .unwrap();
        assert!(c.sql.contains(">= ?1") && c.sql.contains("<= ?2"));
    }

    /// FB2-08（§14.14）：未收进白名单的 dominant_xxx 报「未知字段」。
    #[test]
    fn unknown_dominant_key_rejected() {
        let c = compile_metadata(&between("dominant_unknown", 0, 359));
        assert!(c.is_err());
        let err = c.unwrap_err().to_string();
        assert!(err.contains("未知元数据字段"), "实际：{}", err);
    }

    /// GPS 定位（V18）：latitude/longitude 数值白名单，between/gt 正常编译且允许负值。
    #[test]
    fn latitude_longitude_numeric_ops_compile() {
        // between 正常区间（南半球负纬度合法）
        let c = compile_metadata(&between("latitude", -45, 45)).unwrap().unwrap();
        assert!(c.sql.contains("a.latitude >= ?1") && c.sql.contains("a.latitude <= ?2"));
        assert!(c.sql.contains("IS NOT NULL"), "NULL 守卫不得命中无定位素材");
        // lt 负值（西经）不报「不能为负」
        let lt = MetadataFilter {
            key: "longitude".into(),
            op: "lt".into(),
            value: Some(serde_json::json!(-120.5)),
            values: None,
            min: None,
            max: None,
        };
        let c = compile_metadata(&lt).unwrap().unwrap();
        assert!(c.sql.contains("a.longitude < ?1"));
    }

    /// GPS 定位（V18）：has_location 编译为 CASE 表达式，仅支持 eq/in。
    #[test]
    fn has_location_compiles_case_expr() {
        let eq = MetadataFilter {
            key: "has_location".into(),
            op: "eq".into(),
            value: Some(serde_json::json!("yes")),
            values: None,
            min: None,
            max: None,
        };
        let c = compile_metadata(&eq).unwrap().unwrap();
        assert!(c.sql.contains("CASE WHEN a.latitude IS NOT NULL"), "实际：{}", c.sql);
        // 不支持 gt
        let gt = MetadataFilter {
            key: "has_location".into(),
            op: "gt".into(),
            value: Some(serde_json::json!("yes")),
            values: None,
            min: None,
            max: None,
        };
        assert!(compile_metadata(&gt).is_err());
    }

    /// U-3：palette eq + 数字 min = 占比阈值编译（bucket=色 AND ratio>=min + rank 限定）。
    #[test]
    fn palette_eq_with_ratio_min_compiles() {
        let f = MetadataFilter {
            key: "palette_top3".into(),
            op: "eq".into(),
            value: Some(serde_json::json!("红")),
            values: None,
            min: Some(serde_json::json!(0.5)),
            max: None,
        };
        let c = compile_metadata(&f).unwrap().unwrap();
        assert!(c.sql.contains("apc.color_bucket = ?1"), "{}", c.sql);
        assert!(c.sql.contains("apc.ratio >= ?2"), "{}", c.sql);
        assert!(c.sql.contains("rank < 3"), "{}", c.sql);
        assert_eq!(c.params.len(), 2);
        // in + min 拒绝（阈值只配单色 eq）
        let in_min = MetadataFilter {
            key: "palette_top3".into(),
            op: "in".into(),
            value: None,
            values: Some(vec![serde_json::json!("红"), serde_json::json!("蓝")]),
            min: Some(serde_json::json!(0.5)),
            max: None,
        };
        assert!(compile_metadata(&in_min).is_err());
        // 阈值越界拒绝
        let oob = MetadataFilter {
            key: "palette_top3".into(),
            op: "eq".into(),
            value: Some(serde_json::json!("红")),
            values: None,
            min: Some(serde_json::json!(1.5)),
            max: None,
        };
        assert!(compile_metadata(&oob).is_err());
    }

    /// Phase 4（§5.3）双向断言：每个 ValueKind::Number 的 key 都有 domain，
    /// 且 domain.allowed_ops 与编译侧 allowed_ops 逐字相等（同一常量 NUMERIC_OPS）。
    /// palette_* 是显式例外（eq+min 挪用占比阈值，不是数值比较），不进表。
    #[test]
    fn numeric_domain_single_source() {
        // 正向：15 个数值 key 全有 spec，且 spec 数 = key_spec(Number) 数（无遗漏无多余）。
        let spec_keys: Vec<&str> = NUMERIC_SPECS.iter().map(|s| s.key).collect();
        let number_keys: Vec<&str> = ALL_METADATA_KEYS
            .iter()
            .copied()
            .filter(|k| matches!(key_spec(k), Some(KeySpec { kind: ValueKind::Number, .. })))
            .collect();
        assert_eq!(
            spec_keys.len(),
            number_keys.len(),
            "数值 spec 与 Number 类 key 数量不一致：spec={spec_keys:?} number={number_keys:?}"
        );
        for k in &number_keys {
            assert!(numeric_spec(k).is_some(), "Number key 缺 spec：{k}");
        }
        for k in &spec_keys {
            assert!(
                matches!(
                    key_spec(k),
                    Some(KeySpec { kind: ValueKind::Number, .. })
                ),
                "spec 里的 key 必须是 Number 类：{k}"
            );
        }
        // palette_* 显式例外：不是 Number 类 → 不进表。
        for k in ["palette_dominant", "palette_top3", "palette_any"] {
            assert!(numeric_spec(k).is_none(), "palette 例外 key 误入 spec：{k}");
        }
        // 双向：domain.allowed_ops == allowed_ops(key) 逐字相等。
        for s in NUMERIC_SPECS {
            assert_eq!(
                NUMERIC_OPS,
                allowed_ops(s.key),
                "{} 的编译运算符应与 NUMERIC_OPS 同源",
                s.key
            );
            let d = numeric_domain(s.key).expect("spec 有 domain");
            assert_eq!(d.allowed_ops, NUMERIC_OPS.iter().map(|x| x.to_string()).collect::<Vec<_>>());
            assert_eq!(d.circular, s.circular, "{}", s.key);
            assert_eq!(d.suspicious_below, s.suspicious_below, "{}", s.key);
        }
        // rating 是数值 key（0–5），必须能编译比较
        assert!(compile_metadata(&MetadataFilter {
            key: "rating".into(),
            op: "gte".into(),
            value: Some(serde_json::json!(3)),
            values: None,
            min: None,
            max: None,
        })
        .is_ok());
    }

    /// Phase 4（§5.3）：domain 序列化为 camelCase 载荷（unit/allowedOps/presets），供 get_numeric_domains。
    #[test]
    fn numeric_domain_serializes_camel_case() {
        let all = numeric_domains();
        assert_eq!(all.len(), NUMERIC_SPECS.len());
        let iso = all.iter().find(|d| d.key == "iso").expect("iso domain");
        assert!(!iso.presets.is_empty(), "iso 应有档位预设");
        assert!(iso.presets.iter().any(|(l, v)| l == "ISO 800" && (*v - 800.0).abs() < 1e-9));
        let json = serde_json::to_value(&iso).unwrap();
        assert_eq!(json["allowedOps"][0], "eq");
        assert!(json.get("unitLabel").is_none(), "iso 无单位后缀");
        let hue = all.iter().find(|d| d.key == "dominant_hue").unwrap();
        assert!(hue.circular, "色相必须 circular");
        assert_eq!(hue.min, Some(0.0));
        assert_eq!(hue.max, Some(359.0));
        let focal = all.iter().find(|d| d.key == "focal").unwrap();
        assert_eq!(focal.unit_label.as_deref(), Some("mm"));
        let fs = all.iter().find(|d| d.key == "file_size").unwrap();
        assert_eq!(fs.suspicious_below, Some(1024.0), "file_size 量纲阈值保持 1KB");
    }

    /// Phase 4（§5.3）：dimension_warnings 的量纲阈值来自 domain（改了 spec 就改阈值，不另藏常数）。
    #[test]
    fn dimension_warning_thresholds_follow_domain() {
        // file_size：x < suspicious_below(1024) 提示（边界 1024 不提示，与历史行为一致）
        let warn = |v: i64| {
            dimension_warnings(&MetadataFilter {
                key: "file_size".into(),
                op: "lt".into(),
                value: Some(serde_json::json!(v)),
                values: None,
                min: None,
                max: None,
            })
        };
        assert!(!warn(512).is_empty());
        assert!(warn(1024).is_empty(), "1024 = 恰好 1KB，不应提示");
        assert!(warn(2048).is_empty());
        // duration_ms 阈值 100ms
        let dw = dimension_warnings(&MetadataFilter {
            key: "duration_ms".into(),
            op: "lt".into(),
            value: Some(serde_json::json!(50)),
            values: None,
            min: None,
            max: None,
        });
        assert!(dw.iter().any(|w| w.contains("毫秒")));
    }
}
