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

/// 每个 key 允许的操作符（contract-v1 §4）
fn allowed_ops(key: &str) -> &'static [&'static str] {
    match key {
        "file_ext" | "mime_type" => &["eq", "in"],
        "video_codec" | "audio_codec" | "camera" | "lens" | "shutter" => &["eq", "in", "contains"],
        // P0-2：数值字段允许 `in`，以兼容普通素材库分面把多个离散值以字符串/数值数组传入。
        // 见 contract-v1 §4 及《入库标签与素材库改造开发指导书》阶段 0 P0-2。
        "iso" | "aperture" | "focal" | "width" | "height" | "resolution" | "aspect_ratio"
        | "file_size" | "duration_ms" | "dominant_hue" | "dominant_sat" | "dominant_lum"
        | "latitude" | "longitude" => {
            &["eq", "in", "gt", "gte", "lt", "lte", "between"]
        }
        "has_location" => &["eq", "in"],
        "palette_dominant" | "palette_top3" | "palette_any" => &["eq", "in"],
        // W2-8：评级数值比较 + 收藏有无
        "rating" => &["eq", "in", "gt", "gte", "lt", "lte", "between"],
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
        let msg = match f.key.as_str() {
            "file_size" if x < 1024.0 => {
                Some("文件大小小于 1 KB，是否想写 MB？已按字节执行。".to_string())
            }
            "duration_ms" if x < 100.0 && f.op != "eq" => {
                Some("时长小于 0.1 秒，单位是毫秒。".to_string())
            }
            "resolution" if x < 10000.0 => {
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
            if f.key == "dominant_hue" && lo > hi {
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
}
