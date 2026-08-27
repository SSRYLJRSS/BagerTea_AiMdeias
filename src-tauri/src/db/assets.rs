//! 素材仓储：CRUD + 分页查询（类型/未打标/标签树/搜索 四路筛选，标签聚合返回）

use rusqlite::{types::Value, Connection, Row};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub use super::search_query::MetadataFilter;
use super::search_query::{self};
use super::sql_utils::offset_placeholders;
use super::{search, tags::Tag};
use crate::error::{AppError, AppResult};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Asset {
    pub id: i64,
    pub file_path: String,
    pub file_name: String,
    pub file_ext: String,
    pub file_size: i64,
    pub mime_type: String,
    pub width: Option<i64>,
    pub height: Option<i64>,
    pub duration_ms: Option<i64>,
    pub video_codec: Option<String>,
    pub audio_codec: Option<String>,
    pub taken_at: Option<i64>,
    pub created_at: i64,
    pub modified_at: i64,
    pub hash: Option<String>,
    pub placeholder_path: Option<String>,
    pub hd_thumbnail_path: Option<String>,
    // EXIF 元信息（PRD 5.5，入库自动提取，不进打标流）
    pub camera: Option<String>,
    pub lens: Option<String>,
    pub iso: Option<i64>,
    pub aperture: Option<f64>,
    pub shutter: Option<String>,
    pub focal: Option<f64>,
    pub tags: Vec<Tag>,
    // 媒体元数据（指导书 §7.3/§7.4，V12 迁移新增列；后端探测为事实源）
    pub media_kind: Option<String>,
    pub container_format: Option<String>,
    pub video_profile: Option<String>,
    pub pixel_format: Option<String>,
    pub bit_depth: Option<i64>,
    pub frame_rate: Option<f64>,
    pub video_bit_rate: Option<i64>,
    pub color_range: Option<String>,
    pub color_space: Option<String>,
    pub color_transfer: Option<String>,
    pub color_primaries: Option<String>,
    pub audio_sample_rate: Option<i64>,
    pub audio_channels: Option<i64>,
    pub audio_layout: Option<String>,
    pub rotation: Option<i64>,
    pub media_metadata_json: Option<String>,
    pub metadata_version: Option<i64>,
    pub metadata_scanned_at: Option<i64>,
    pub metadata_error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    pub imported: i64,
    pub failed: i64,
    pub duplicates: i64,
    pub errors: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FacetTagFilter {
    pub facet_key: String,
    #[serde(default)]
    pub tag_ids: Vec<i64>,
    #[serde(default)]
    pub mode: Option<String>,
    #[serde(default = "default_true")]
    pub include_descendants: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MetadataFacetItem {
    pub value: String,
    pub label: String,
    pub count: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MetadataFacet {
    pub key: String,
    pub display_name: String,
    pub description: String,
    pub items: Vec<MetadataFacetItem>,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetFilter {
    /// "all" | "image" | "video"（None / "all" = 全部）
    pub asset_type: Option<String>,
    #[serde(default)]
    pub untagged_only: bool,
    /// 父标签连带子标签（递归 CTE 处理）
    pub tag_id: Option<i64>,
    /// 多标签筛选（R-21，与 tag_id 二选一，优先 tag_ids）
    #[serde(default)]
    pub tag_ids: Vec<i64>,
    /// 多标签组合模式：any（默认）| all（EXISTS 逐标签，防 JOIN 行数爆炸）
    #[serde(default)]
    pub tags_mode: Option<String>,
    /// 新分面协议：同一项内部 any/all，不同分面项之间 AND。
    #[serde(default)]
    pub facet_filters: Vec<FacetTagFilter>,
    /// 明确排除的标签；默认同时排除其后代。
    #[serde(default)]
    pub exclude_tag_ids: Vec<i64>,
    /// 文件自身携带的元数据分面；同组 values 为 OR，不同 key 之间为 AND。
    #[serde(default)]
    pub metadata_filters: Vec<MetadataFilter>,
    /// 搜索关键词（FTS5 / ≤2 字 LIKE 兜底，见 db/search.rs）
    pub search: Option<String>,
    /// 排序字段（R-21）：created_at（默认）| taken_at | size | resolution；缺值排最后
    #[serde(default)]
    pub sort_by: Option<String>,
    /// 排序方向：desc（默认）| asc
    #[serde(default)]
    pub sort_dir: Option<String>,
    /// true = 查回收站（deleted_at 非空）；默认查在库（R-22）
    #[serde(default)]
    pub trash_only: bool,
    /// 布尔表达式树（P4 query_expr）：表达式构建器产物；存在时优先走表达式编译，
    /// 与扁平字段二选一（两者互斥，若同时存在以 expr 为准）。
    #[serde(default)]
    pub expr: Option<super::query_expr::QueryExpr>,
    #[serde(default)]
    pub offset: i64,
    #[serde(default = "default_limit")]
    pub limit: i64,
}

fn default_limit() -> i64 {
    200
}

/// 手写 Default：与 serde 反序列化默认值保持一致（派生 Default 会给 limit=0）
impl Default for AssetFilter {
    fn default() -> Self {
        Self {
            asset_type: None,
            untagged_only: false,
            tag_id: None,
            tag_ids: Vec::new(),
            tags_mode: None,
            facet_filters: Vec::new(),
            exclude_tag_ids: Vec::new(),
            metadata_filters: Vec::new(),
            search: None,
            sort_by: None,
            sort_dir: None,
            trash_only: false,
            expr: None,
            offset: 0,
            limit: default_limit(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetPage {
    pub items: Vec<Asset>,
    pub total: i64,
    pub has_more: bool,
}

pub(crate) const COLUMNS: &str =
    "id, file_path, file_name, file_ext, file_size, mime_type, width, height, \
                       duration_ms, video_codec, audio_codec, taken_at, created_at, modified_at, \
                       hash, placeholder_path, hd_thumbnail_path, \
                       camera, lens, iso, aperture, shutter, focal, \
                       media_kind, container_format, video_profile, pixel_format, bit_depth, frame_rate, \
                       video_bit_rate, color_range, color_space, color_transfer, color_primaries, \
                       audio_sample_rate, audio_channels, audio_layout, rotation, \
                       media_metadata_json, metadata_version, metadata_scanned_at, metadata_error";

pub(crate) fn from_row(row: &Row) -> rusqlite::Result<Asset> {
    Ok(Asset {
        id: row.get(0)?,
        file_path: row.get(1)?,
        file_name: row.get(2)?,
        file_ext: row.get(3)?,
        file_size: row.get(4)?,
        mime_type: row.get(5)?,
        width: row.get(6)?,
        height: row.get(7)?,
        duration_ms: row.get(8)?,
        video_codec: row.get(9)?,
        audio_codec: row.get(10)?,
        taken_at: row.get(11)?,
        created_at: row.get(12)?,
        modified_at: row.get(13)?,
        hash: row.get(14)?,
        placeholder_path: row.get(15)?,
        hd_thumbnail_path: row.get(16)?,
        camera: row.get(17)?,
        lens: row.get(18)?,
        iso: row.get(19)?,
        aperture: row.get(20)?,
        shutter: row.get(21)?,
        focal: row.get(22)?,
        media_kind: row.get(23)?,
        container_format: row.get(24)?,
        video_profile: row.get(25)?,
        pixel_format: row.get(26)?,
        bit_depth: row.get(27)?,
        frame_rate: row.get(28)?,
        video_bit_rate: row.get(29)?,
        color_range: row.get(30)?,
        color_space: row.get(31)?,
        color_transfer: row.get(32)?,
        color_primaries: row.get(33)?,
        audio_sample_rate: row.get(34)?,
        audio_channels: row.get(35)?,
        audio_layout: row.get(36)?,
        rotation: row.get(37)?,
        media_metadata_json: row.get(38)?,
        metadata_version: row.get(39)?,
        metadata_scanned_at: row.get(40)?,
        metadata_error: row.get(41)?,
        tags: Vec::new(),
    })
}

/// 组装 WHERE 子句与位置参数（?1.. 顺序与返回参数一致）
/// search_pred 为库内编译好的搜索谓词（来自 search::build_search_predicate），
/// 在数据库内与其他条件组合，不再回传大 ID 列表。
fn build_where(
    conn: &Connection,
    filter: &AssetFilter,
    search_pred: Option<&search::SearchPredicate>,
) -> AppResult<(String, Vec<Value>)> {
    let mut cond = String::from("1=1");
    let mut params: Vec<Value> = Vec::new();
    // 回收站隔离（R-22）：默认只看不在回收站的
    if filter.trash_only {
        cond.push_str(" AND a.deleted_at IS NOT NULL");
    } else {
        cond.push_str(" AND a.deleted_at IS NULL");
    }
    // 布尔表达式树分支（P4 query_expr）：有 expr 时以表达式为准，忽略扁平字段。
    // 此处仅追加 expr 编译片段；回收站隔离已在上方作为基础条件。
    if let Some(expr) = &filter.expr {
        match super::query_expr::compile_expr(conn, expr) {
            Ok((sql, p)) => {
                if !sql.trim().is_empty() {
                    cond.push_str(&format!(" AND ({sql})"));
                    params.extend(p);
                }
                return Ok((cond, params));
            }
            Err(e) => {
                return Err(e);
            }
        }
    }
    match filter.asset_type.as_deref() {
        Some("image") => cond.push_str(" AND a.mime_type LIKE 'image/%'"),
        Some("video") => cond.push_str(" AND a.mime_type LIKE 'video/%'"),
        _ => {}
    }
    if filter.untagged_only {
        cond.push_str(" AND NOT EXISTS (SELECT 1 FROM asset_tags at WHERE at.asset_id = a.id)");
    }
    if let Some(tid) = filter.tag_id {
        params.push(tid.into());
        cond.push_str(&format!(
            " AND a.id IN (SELECT asset_id FROM asset_tags WHERE tag_id IN (
                WITH RECURSIVE sub(id) AS (
                  SELECT ?{} UNION ALL
                  SELECT t.id FROM tags t JOIN sub s ON t.parent_id = s.id
                ) SELECT id FROM sub))",
            params.len()
        ));
    }
    // 多标签筛选（R-21）：any = 单 CTE 多 seed；all = 逐标签 EXISTS（防 JOIN 行数爆炸）
    if !filter.tag_ids.is_empty() {
        let all_mode = filter.tags_mode.as_deref() == Some("all");
        if all_mode {
            for &tid in &filter.tag_ids {
                params.push(tid.into());
                cond.push_str(&format!(
                    " AND EXISTS (SELECT 1 FROM asset_tags at2 WHERE at2.asset_id = a.id AND at2.tag_id IN (
                        WITH RECURSIVE sub(id) AS (
                          SELECT ?{} UNION ALL
                          SELECT t.id FROM tags t JOIN sub s ON t.parent_id = s.id
                        ) SELECT id FROM sub))",
                    params.len()
                ));
            }
        } else {
            let mut seeds = String::new();
            for &tid in &filter.tag_ids {
                params.push(tid.into());
                if !seeds.is_empty() {
                    seeds.push_str(" UNION ALL");
                }
                seeds.push_str(&format!(" SELECT ?{}", params.len()));
            }
            cond.push_str(&format!(
                " AND a.id IN (SELECT asset_id FROM asset_tags WHERE tag_id IN (
                    WITH RECURSIVE sub(id) AS (
                      {seeds} UNION ALL
                      SELECT t.id FROM tags t JOIN sub s ON t.parent_id = s.id
                    ) SELECT id FROM sub))"
            ));
        }
    }
    for facet in &filter.facet_filters {
        if facet.tag_ids.is_empty() {
            continue;
        }
        let all_mode = facet.mode.as_deref() == Some("all");
        let descendant = facet.include_descendants;
        let append_one = |cond: &mut String, params: &mut Vec<Value>, tid: i64| {
            params.push(tid.into());
            if descendant {
                cond.push_str(&format!(
                    " AND EXISTS (SELECT 1 FROM asset_tags atf WHERE atf.asset_id = a.id AND atf.tag_id IN (
                        WITH RECURSIVE sub(id) AS (SELECT ?{} UNION ALL SELECT t.id FROM tags t JOIN sub s ON t.parent_id=s.id)
                        SELECT id FROM sub))", params.len()
                ));
            } else {
                cond.push_str(&format!(
                    " AND EXISTS (SELECT 1 FROM asset_tags atf WHERE atf.asset_id = a.id AND atf.tag_id = ?{})",
                    params.len()
                ));
            }
        };
        if all_mode {
            for &tid in &facet.tag_ids {
                append_one(&mut cond, &mut params, tid);
            }
        } else if descendant {
            let mut seeds = String::new();
            for &tid in &facet.tag_ids {
                params.push(tid.into());
                if !seeds.is_empty() {
                    seeds.push_str(" UNION ALL");
                }
                seeds.push_str(&format!(" SELECT ?{}", params.len()));
            }
            cond.push_str(&format!(
                " AND EXISTS (SELECT 1 FROM asset_tags atf WHERE atf.asset_id=a.id AND atf.tag_id IN (
                    WITH RECURSIVE sub(id) AS ({seeds} UNION ALL SELECT t.id FROM tags t JOIN sub s ON t.parent_id=s.id)
                    SELECT id FROM sub))"
            ));
        } else {
            let placeholders = facet
                .tag_ids
                .iter()
                .map(|tid| {
                    params.push((*tid).into());
                    format!("?{}", params.len())
                })
                .collect::<Vec<_>>()
                .join(",");
            cond.push_str(&format!(
                " AND EXISTS (SELECT 1 FROM asset_tags atf WHERE atf.asset_id=a.id AND atf.tag_id IN ({placeholders}))"
            ));
        }
    }
    for &tid in &filter.exclude_tag_ids {
        params.push(tid.into());
        cond.push_str(&format!(
            " AND NOT EXISTS (SELECT 1 FROM asset_tags ate WHERE ate.asset_id=a.id AND ate.tag_id IN (
                WITH RECURSIVE sub(id) AS (SELECT ?{} UNION ALL SELECT t.id FROM tags t JOIN sub s ON t.parent_id=s.id)
                SELECT id FROM sub))", params.len()
        ));
    }
    // 元数据比较：按白名单 key/op 编译，全部参数绑定，非法条件即报错（build_where 被上层校验兜底）
    if !filter.metadata_filters.is_empty() {
        match search_query::compile_metadata_all(&filter.metadata_filters) {
            Ok(Some((meta_sql, meta_params))) => {
                if !meta_sql.is_empty() {
                    cond.push_str(&format!(" AND ({meta_sql})"));
                    params.extend(meta_params);
                }
            }
            Ok(None) => {}
            Err(e) => return Err(e),
        }
    }
    if let Some(pred) = search_pred {
        if !pred.sql.is_empty() {
            // 把谓词中的占位符偏移到全局参数索引
            let shifted = offset_placeholders(&pred.sql, params.len());
            cond.push_str(&format!(" AND ({shifted})"));
            params.extend(pred.params.iter().cloned());
        }
    }
    Ok((cond, params))
}

/// 排序子句（R-21）：taken_at/resolution 缺值排最后；尾缀 a.id DESC 稳定分页
fn order_by(filter: &AssetFilter) -> String {
    let dir = if filter.sort_dir.as_deref() == Some("asc") {
        "ASC"
    } else {
        "DESC"
    };
    let expr = match filter.sort_by.as_deref() {
        Some("taken_at") => format!("CASE WHEN a.taken_at IS NULL THEN 1 ELSE 0 END ASC, a.taken_at {dir}"),
        Some("size") => format!("a.file_size {dir}"),
        Some("resolution") => format!(
            "CASE WHEN a.width IS NULL OR a.height IS NULL THEN 1 ELSE 0 END ASC, (a.width * a.height) {dir}"
        ),
        Some("name") => format!("a.file_name {dir}"),
        Some("modified_at") => format!("a.modified_at {dir}"),
        _ => format!("a.created_at {dir}"),
    };
    format!("{expr}, a.id DESC")
}

/// 编译筛选条件中的搜索谓词（库内组合）；无搜索返回 None。
fn build_search_predicate(
    conn: &Connection,
    filter: &AssetFilter,
) -> AppResult<Option<search::SearchPredicate>> {
    match &filter.search {
        Some(q) if !q.trim().is_empty() => search::build_search_predicate(conn, q),
        _ => Ok(None),
    }
}

const VALID_SORT: &[&str] = &[
    "created_at",
    "taken_at",
    "modified_at",
    "name",
    "size",
    "resolution",
];

impl AssetFilter {
    /// 参数校验：非法 key/op/值/数量/排序/分页一律返回 AppError，不静默忽略。
    /// list / list_ids 入口处调用；非法条件直接拒绝整次查询。
    pub fn validate(&self) -> AppResult<()> {
        if let Some(t) = &self.asset_type {
            if !matches!(t.as_str(), "image" | "video" | "all") {
                return Err(AppError::msg(format!("非法 assetType：{t}")));
            }
        }
        if let Some(m) = &self.tags_mode {
            if !matches!(m.as_str(), "any" | "all") {
                return Err(AppError::msg(format!("非法 tagsMode：{m}")));
            }
        }
        if let Some(dir) = &self.sort_dir {
            if !matches!(dir.as_str(), "asc" | "desc") {
                return Err(AppError::msg(format!("非法 sortDir：{dir}")));
            }
        }
        if let Some(sb) = &self.sort_by {
            if !VALID_SORT.contains(&sb.as_str()) {
                return Err(AppError::msg(format!("非法排序字段：{sb}")));
            }
        }
        // 分页：沿用 B19 钳制语义（list 内 clamp limit 到 [1,1000]、offset ≥0），
        // validate 不拒绝——前端可能传 0/极值，保持既有行为。
        // 标签与排除标签数量上限
        if self.tag_ids.len() > 100
            || self.exclude_tag_ids.len() > 100
            || self.facet_filters.len() > 100
        {
            return Err(AppError::msg("标签条件数量超出上限"));
        }
        for facet in &self.facet_filters {
            if facet.tag_ids.is_empty() {
                return Err(AppError::msg("分面标签条件不能为空"));
            }
            if let Some(m) = &facet.mode {
                if !matches!(m.as_str(), "any" | "all") {
                    return Err(AppError::msg(format!("非法分面 mode：{m}")));
                }
            }
        }
        // 元数据：白名单 key/op/值类型/数量
        search_query::validate_metadata(&self.metadata_filters)?;
        // 布尔表达式树：深度/节点/叶子合法性
        if let Some(expr) = &self.expr {
            super::query_expr::validate_expr(expr)?;
        }
        Ok(())
    }
}

/// 只返回当前筛选结果的 id 数组（BUG-E：全选/反选/批量操作无需完整 Asset 对象）。
/// 复用 build_where 与搜索逻辑，仅 SELECT a.id，ORDER BY 与 list() 一致。
pub fn list_ids(conn: &Connection, filter: &AssetFilter) -> AppResult<Vec<i64>> {
    filter.validate()?;
    let search_pred = build_search_predicate(conn, filter)?;
    let (cond, params) = build_where(conn, filter, search_pred.as_ref())?;
    let mut stmt = conn.prepare(&format!(
        "SELECT a.id FROM assets a WHERE {cond} ORDER BY {} LIMIT 100000", // B19：上限 100000（全选用，放宽但防滥用）
        order_by(filter)
    ))?;
    let ids = stmt
        .query_map(rusqlite::params_from_iter(params.iter()), |r| {
            r.get::<_, i64>(0)
        })?
        .collect::<Result<Vec<i64>, _>>()?;
    Ok(ids)
}

pub fn list(conn: &Connection, filter: &AssetFilter) -> AppResult<AssetPage> {
    filter.validate()?;
    let search_pred = build_search_predicate(conn, filter)?;
    let (cond, params) = build_where(conn, filter, search_pred.as_ref())?;
    let total: i64 = conn.query_row(
        &format!("SELECT COUNT(*) FROM assets a WHERE {cond}"),
        rusqlite::params_from_iter(params.iter()),
        |r| r.get(0),
    )?;

    let mut page_params = params.clone();
    let limit = filter.limit.clamp(1, 1000); // B19：上限 1000，防一次拉全库
    let offset = filter.offset.max(0);
    page_params.push(limit.into());
    page_params.push(offset.into());
    let mut stmt = conn.prepare(&format!(
        "SELECT {COLUMNS} FROM assets a WHERE {cond} ORDER BY {} LIMIT ?{} OFFSET ?{}",
        order_by(filter),
        params.len() + 1,
        params.len() + 2
    ))?;
    let mut items: Vec<Asset> = stmt
        .query_map(rusqlite::params_from_iter(page_params.iter()), from_row)?
        .collect::<Result<_, _>>()?;

    fill_tags(conn, &mut items)?;
    Ok(AssetPage {
        has_more: offset + (items.len() as i64) < total,
        items,
        total,
    })
}

fn metadata_items(
    conn: &Connection,
    value_expr: &str,
    label_expr: &str,
    present_expr: &str,
) -> AppResult<Vec<MetadataFacetItem>> {
    let sql = format!(
        "SELECT {value_expr} AS value, {label_expr} AS label, COUNT(*) AS count
           FROM assets a
          WHERE a.deleted_at IS NULL AND {present_expr}
          GROUP BY value
          ORDER BY count DESC, label COLLATE NOCASE
          LIMIT 80"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map([], |row| {
        Ok(MetadataFacetItem {
            value: row.get(0)?,
            label: row.get(1)?,
            count: row.get(2)?,
        })
    })?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

/// 文件属性分面：由导入时读取的文件信息与 EXIF 动态聚合，不写入人工/AI 标签表。
pub fn list_metadata_facets(
    conn: &Connection,
    library_root: Option<&str>,
) -> AppResult<Vec<MetadataFacet>> {
    let normalized_aperture = "rtrim(rtrim(printf('%.2f', a.aperture), '0'), '.')";
    let normalized_focal = "rtrim(rtrim(printf('%.2f', a.focal), '0'), '.')";
    let taken_month = "strftime('%Y-%m', a.taken_at / 1000, 'unixepoch', 'localtime')";
    let mut facets = vec![
        MetadataFacet {
            key: "folder".into(),
            display_name: "所在文件夹".into(),
            description: "入库分库或素材原始目录".into(),
            items: list_folder_items(conn, library_root)?,
        },
        MetadataFacet {
            key: "taken_month".into(),
            display_name: "拍摄时间".into(),
            description: "按照片或视频的拍摄月份".into(),
            items: metadata_items(
                conn,
                taken_month,
                &format!("substr({taken_month}, 1, 4) || '年' || substr({taken_month}, 6, 2) || '月'"),
                "a.taken_at IS NOT NULL",
            )?,
        },
        MetadataFacet {
            key: "camera".into(),
            display_name: "拍摄设备".into(),
            description: "相机或手机型号".into(),
            items: metadata_items(conn, "a.camera", "a.camera", "a.camera IS NOT NULL AND trim(a.camera) != ''")?,
        },
        MetadataFacet {
            key: "lens".into(),
            display_name: "镜头".into(),
            description: "EXIF 中记录的镜头型号".into(),
            items: metadata_items(conn, "a.lens", "a.lens", "a.lens IS NOT NULL AND trim(a.lens) != ''")?,
        },
        MetadataFacet {
            key: "iso".into(),
            display_name: "感光度".into(),
            description: "ISO 拍摄参数".into(),
            items: metadata_items(conn, "CAST(a.iso AS TEXT)", "'ISO ' || a.iso", "a.iso IS NOT NULL")?,
        },
        MetadataFacet {
            key: "aperture".into(),
            display_name: "光圈".into(),
            description: "镜头光圈值".into(),
            items: metadata_items(conn, normalized_aperture, &format!("'f/' || {normalized_aperture}"), "a.aperture IS NOT NULL")?,
        },
        MetadataFacet {
            key: "shutter".into(),
            display_name: "快门".into(),
            description: "曝光时间".into(),
            items: metadata_items(conn, "a.shutter", "a.shutter", "a.shutter IS NOT NULL AND trim(a.shutter) != ''")?,
        },
        MetadataFacet {
            key: "focal".into(),
            display_name: "焦距".into(),
            description: "拍摄焦段".into(),
            items: metadata_items(conn, normalized_focal, &format!("{normalized_focal} || ' mm'"), "a.focal IS NOT NULL")?,
        },
        MetadataFacet {
            key: "file_ext".into(),
            display_name: "文件格式".into(),
            description: "图片或视频的扩展名".into(),
            items: metadata_items(conn, "lower(a.file_ext)", "upper(a.file_ext)", "trim(a.file_ext) != ''")?,
        },
        MetadataFacet {
            key: "resolution".into(),
            display_name: "分辨率".into(),
            description: "文件的像素尺寸".into(),
            items: metadata_items(
                conn,
                "CAST(a.width AS TEXT) || 'x' || CAST(a.height AS TEXT)",
                "CAST(a.width AS TEXT) || ' × ' || CAST(a.height AS TEXT)",
                "a.width IS NOT NULL AND a.height IS NOT NULL",
            )?,
        },
        MetadataFacet {
            key: "file_size".into(),
            display_name: "文件大小".into(),
            description: "适合快速定位大文件".into(),
            items: metadata_items(
                conn,
                "CASE WHEN a.file_size < 1048576 THEN 'lt_1mb' WHEN a.file_size < 10485760 THEN '1_10mb' WHEN a.file_size < 104857600 THEN '10_100mb' ELSE 'gte_100mb' END",
                "CASE WHEN a.file_size < 1048576 THEN '小于 1 MB' WHEN a.file_size < 10485760 THEN '1–10 MB' WHEN a.file_size < 104857600 THEN '10–100 MB' ELSE '大于等于 100 MB' END",
                "a.file_size IS NOT NULL",
            )?,
        },
        MetadataFacet {
            key: "duration".into(),
            display_name: "视频时长".into(),
            description: "仅显示视频素材的时长区间".into(),
            items: metadata_items(
                conn,
                "CASE WHEN a.duration_ms < 10000 THEN 'lt_10s' WHEN a.duration_ms < 60000 THEN '10_60s' WHEN a.duration_ms < 300000 THEN '1_5m' ELSE 'gte_5m' END",
                "CASE WHEN a.duration_ms < 10000 THEN '小于 10 秒' WHEN a.duration_ms < 60000 THEN '10 秒–1 分钟' WHEN a.duration_ms < 300000 THEN '1–5 分钟' ELSE '大于等于 5 分钟' END",
                "a.duration_ms IS NOT NULL",
            )?,
        },
        MetadataFacet {
            key: "video_codec".into(),
            display_name: "视频编码".into(),
            description: "视频编解码格式".into(),
            items: metadata_items(conn, "lower(a.video_codec)", "upper(a.video_codec)", "a.video_codec IS NOT NULL AND trim(a.video_codec) != ''")?,
        },
        MetadataFacet {
            key: "audio_codec".into(),
            display_name: "音频编码".into(),
            description: "视频中的音频编码格式".into(),
            items: metadata_items(conn, "lower(a.audio_codec)", "upper(a.audio_codec)", "a.audio_codec IS NOT NULL AND trim(a.audio_codec) != ''")?,
        },
    ];
    facets.retain(|facet| !facet.items.is_empty());
    Ok(facets)
}

fn list_folder_items(
    conn: &Connection,
    library_root: Option<&str>,
) -> AppResult<Vec<MetadataFacetItem>> {
    let mut stmt = conn.prepare("SELECT file_path FROM assets WHERE deleted_at IS NULL")?;
    let paths = stmt
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    let root = library_root
        .map(crate::utils::path::normalize_path)
        .filter(|value| !value.trim().is_empty())
        .map(|value| value.trim_end_matches('/').to_string());
    let mut counts = BTreeMap::<String, i64>::new();
    for path in paths {
        let normalized = crate::utils::path::normalize_path(&path);
        let Some(parent) = normalized
            .rsplit_once('/')
            .map(|(parent, _)| parent.to_string())
        else {
            continue;
        };
        let folder = parent.trim_end_matches('/').to_string();
        let mut current = Some(folder);
        while let Some(folder) = current {
            let inside_root = root
                .as_ref()
                .map(|value| folder == *value || folder.starts_with(&format!("{value}/")))
                .unwrap_or(true);
            if !inside_root {
                break;
            }
            let label = if let Some(root) = &root {
                if folder == *root {
                    "总库根目录".to_string()
                } else if let Some(relative) = folder.strip_prefix(&format!("{root}/")) {
                    relative.to_string()
                } else {
                    folder.clone()
                }
            } else {
                folder.clone()
            };
            *counts.entry(format!("{folder}\t{label}")).or_default() += 1;
            current = folder
                .rsplit_once('/')
                .map(|(parent, _)| parent.to_string());
        }
    }
    let mut items = counts
        .into_iter()
        .map(|(key, count)| {
            let (value, label) = key.split_once('\t').unwrap_or((&key, &key));
            MetadataFacetItem {
                value: value.to_string(),
                label: label.to_string(),
                count,
            }
        })
        .collect::<Vec<_>>();
    items.sort_by(|a, b| b.count.cmp(&a.count).then_with(|| a.label.cmp(&b.label)));
    items.truncate(80);
    Ok(items)
}

/// 聚合返回每页素材的标签（一次 IN 查询，Rust 侧归组）
fn fill_tags(conn: &Connection, items: &mut [Asset]) -> AppResult<()> {
    if items.is_empty() {
        return Ok(());
    }
    let ids = items
        .iter()
        .map(|a| a.id.to_string())
        .collect::<Vec<_>>()
        .join(",");
    let mut stmt = conn.prepare(&format!(
        "SELECT at.asset_id, t.id, t.name, COALESCE(t.canonical_name,t.name),
                COALESCE(t.normalized_name,lower(trim(t.name))), COALESCE(t.facet_key,'custom'),
                t.parent_id, COALESCE(t.status,'active'), COALESCE(t.is_system,0),
                t.is_preset, t.sort_order
           FROM asset_tags at JOIN tags t ON t.id = at.tag_id
          WHERE at.asset_id IN ({ids}) AND COALESCE(t.status,'active') != 'blocked'
          ORDER BY t.sort_order, t.id"
    ))?;
    let rows = stmt.query_map([], |r| {
        Ok((
            r.get::<_, i64>(0)?,
            Tag {
                id: r.get(1)?,
                name: r.get(2)?,
                canonical_name: r.get(3)?,
                normalized_name: r.get(4)?,
                facet_key: r.get(5)?,
                parent_id: r.get(6)?,
                status: r.get(7)?,
                is_system: r.get::<_, i64>(8)? != 0,
                is_preset: r.get::<_, i64>(9)? != 0,
                sort_order: r.get(10)?,
                asset_count: 0,
                total_count: 0,
                aliases: Vec::new(),
                path: String::new(),
            },
        ))
    })?;
    for row in rows {
        let (asset_id, mut tag) = row?;
        super::tags::hydrate_metadata(conn, &mut tag)?;
        if let Some(a) = items.iter_mut().find(|a| a.id == asset_id) {
            a.tags.push(tag);
        }
    }
    Ok(())
}

pub fn get(conn: &Connection, id: i64) -> AppResult<Asset> {
    let mut asset = conn.query_row(
        &format!("SELECT {COLUMNS} FROM assets WHERE id = ?1"),
        [id],
        from_row,
    )?;
    let mut items = vec![asset.clone()];
    fill_tags(conn, &mut items)?;
    asset.tags = items.pop().map(|a| a.tags).unwrap_or_default();
    Ok(asset)
}

#[allow(clippy::too_many_arguments)]
pub fn insert(
    conn: &Connection,
    file_path: &str,
    file_name: &str,
    file_ext: &str,
    file_size: i64,
    mime_type: &str,
    modified_at: i64,
) -> AppResult<i64> {
    let now = chrono::Utc::now().timestamp_millis();
    conn.execute(
        "INSERT INTO assets (file_path, file_name, file_ext, file_size, mime_type, created_at, modified_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        rusqlite::params![file_path, file_name, file_ext, file_size, mime_type, now, modified_at],
    )?;
    Ok(conn.last_insert_rowid())
}

pub fn delete(conn: &Connection, ids: &[i64]) -> AppResult<u64> {
    if ids.is_empty() {
        return Ok(0);
    }
    let list = ids.iter().map(i64::to_string).collect::<Vec<_>>().join(",");
    let n = conn.execute(&format!("DELETE FROM assets WHERE id IN ({list})"), [])?;
    Ok(n as u64)
}

/// R-22 软删入回收站：deleted_at 置当前时间（重复软删不覆盖首次时间）
pub fn soft_delete(conn: &Connection, ids: &[i64]) -> AppResult<u64> {
    if ids.is_empty() {
        return Ok(0);
    }
    let list = ids.iter().map(i64::to_string).collect::<Vec<_>>().join(",");
    let now = chrono::Utc::now().timestamp_millis();
    let n = conn.execute(
        &format!("UPDATE assets SET deleted_at = ?1 WHERE id IN ({list}) AND deleted_at IS NULL"),
        [now],
    )?;
    Ok(n as u64)
}

/// R-22 从回收站恢复：deleted_at 置空
pub fn restore(conn: &Connection, ids: &[i64]) -> AppResult<u64> {
    if ids.is_empty() {
        return Ok(0);
    }
    let list = ids.iter().map(i64::to_string).collect::<Vec<_>>().join(",");
    let n = conn.execute(
        &format!(
            "UPDATE assets SET deleted_at = NULL WHERE id IN ({list}) AND deleted_at IS NOT NULL"
        ),
        [],
    )?;
    Ok(n as u64)
}

/// R-22 查超期回收站项（deleted_at < cutoff），返回 (id, file_path) 供锁外删文件
pub fn list_expired_trash(conn: &Connection, cutoff_ms: i64) -> AppResult<Vec<(i64, String)>> {
    let mut stmt = conn.prepare(
        "SELECT id, file_path FROM assets WHERE deleted_at IS NOT NULL AND deleted_at < ?1",
    )?;
    let rows = stmt.query_map([cutoff_ms], |r| {
        Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?))
    })?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

/// EXIF 回写补丁（均为可空，提取不到就存 NULL）
#[derive(Debug, Clone, Copy, Default)]
pub struct ExifPatch<'a> {
    pub camera: Option<&'a str>,
    pub lens: Option<&'a str>,
    pub iso: Option<i64>,
    pub aperture: Option<f64>,
    pub shutter: Option<&'a str>,
    pub focal: Option<f64>,
    pub taken_at: Option<i64>,
}

/// EXIF 元信息回写（入库管线阶段二调用）
pub fn set_exif(conn: &Connection, id: i64, ex: &ExifPatch<'_>) -> AppResult<()> {
    conn.execute(
        "UPDATE assets SET camera=?1, lens=?2, iso=?3, aperture=?4, shutter=?5, focal=?6,
            taken_at = COALESCE(?7, taken_at) WHERE id=?8",
        rusqlite::params![
            ex.camera,
            ex.lens,
            ex.iso,
            ex.aperture,
            ex.shutter,
            ex.focal,
            ex.taken_at,
            id
        ],
    )?;
    Ok(())
}

pub fn find_by_path(conn: &Connection, file_path: &str) -> AppResult<Option<i64>> {
    let mut stmt = conn.prepare("SELECT id FROM assets WHERE file_path = ?1")?;
    let mut rows = stmt.query([file_path])?;
    Ok(rows.next()?.map(|r| r.get(0)).transpose()?)
}

/// 媒体探测回写（指导书 §7.4/§7.5）：结构字段 + metadata_scanned_at / metadata_error。
/// 只回写本次探测结果；error 与 NULL 分属「读取失败」「未读取」，不可混为一谈。
#[derive(Debug, Default, Clone)]
pub struct MediaProbeUpdate {
    pub media_kind: Option<String>,
    pub width: Option<i64>,
    pub height: Option<i64>,
    pub duration_ms: Option<i64>,
    pub video_codec: Option<String>,
    pub audio_codec: Option<String>,
    pub container_format: Option<String>,
    pub video_profile: Option<String>,
    pub pixel_format: Option<String>,
    pub frame_rate: Option<f64>,
    pub rotation: Option<i64>,
    pub media_metadata_json: Option<String>,
    pub metadata_version: Option<i64>,
    /// 探测失败原因（可辨识）；None = 成功
    pub error: Option<String>,
}

/// 把一次探测结果回写到 assets（媒体探测协议版本 V12 之后）。
pub fn update_media_metadata(conn: &Connection, id: i64, m: &MediaProbeUpdate) -> AppResult<()> {
    let now = chrono::Utc::now().timestamp_millis();
    conn.execute(
        "UPDATE assets SET media_kind=?1, width=?2, height=?3, duration_ms=?4, video_codec=?5, audio_codec=?6,
            container_format=?7, video_profile=?8, pixel_format=?9, frame_rate=?10, rotation=?11,
            media_metadata_json=?12, metadata_error=?13, metadata_version=?14, metadata_scanned_at=?15
         WHERE id=?16",
        rusqlite::params![
            m.media_kind,
            m.width,
            m.height,
            m.duration_ms,
            m.video_codec,
            m.audio_codec,
            m.container_format,
            m.video_profile,
            m.pixel_format,
            m.frame_rate,
            m.rotation,
            m.media_metadata_json,
            m.error,
            m.metadata_version,
            now,
            id
        ],
    )?;
    Ok(())
}

/// 列出缺少媒体元数据的视频（用于「仅缺字段」回填范围）。视频 = MIME video/* 或已有 duration。
pub fn list_video_ids_needing_metadata(conn: &Connection) -> AppResult<Vec<i64>> {
    let mut stmt = conn.prepare(
        "SELECT id FROM assets
          WHERE deleted_at IS NULL
            AND (mime_type LIKE 'video/%' OR duration_ms IS NOT NULL)
            AND (duration_ms IS NULL OR video_codec IS NULL)",
    )?;
    let rows = stmt.query_map([], |r| r.get(0))?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

/// 列出全部视频的 id（用于「全部视频」回填范围）。
pub fn list_video_ids(conn: &Connection) -> AppResult<Vec<i64>> {
    let mut stmt = conn.prepare(
        "SELECT id FROM assets
          WHERE deleted_at IS NULL AND (mime_type LIKE 'video/%' OR duration_ms IS NOT NULL)",
    )?;
    let rows = stmt.query_map([], |r| r.get(0))?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}


pub fn set_hash(conn: &Connection, id: i64, hash: &str) -> AppResult<()> {
    conn.execute(
        "UPDATE assets SET hash = ?1 WHERE id = ?2",
        rusqlite::params![hash, id],
    )?;
    Ok(())
}

pub fn hash_exists(conn: &Connection, hash: &str) -> AppResult<bool> {
    let n: i64 = conn.query_row("SELECT COUNT(*) FROM assets WHERE hash = ?1", [hash], |r| {
        r.get(0)
    })?;
    Ok(n > 0)
}

pub fn set_placeholder_path(conn: &Connection, id: i64, path: &str) -> AppResult<()> {
    conn.execute(
        "UPDATE assets SET placeholder_path = ?1 WHERE id = ?2",
        rusqlite::params![path, id],
    )?;
    Ok(())
}

pub fn set_hd_thumbnail_path(conn: &Connection, id: i64, path: &str) -> AppResult<()> {
    conn.execute(
        "UPDATE assets SET hd_thumbnail_path = ?1 WHERE id = ?2",
        rusqlite::params![path, id],
    )?;
    Ok(())
}

/// B04：move 导出后同步更新库记录的文件路径与文件名（unique_dest 可能加了后缀）
pub fn update_file_path_and_name(
    conn: &Connection,
    id: i64,
    file_path: &str,
    file_name: &str,
) -> AppResult<()> {
    conn.execute(
        "UPDATE assets SET file_path = ?1, file_name = ?2 WHERE id = ?3",
        rusqlite::params![file_path, file_name, id],
    )?;
    Ok(())
}

/// B27：清空所有素材的占位图路径（清缓存时回写 DB，避免 DB 指向已删文件）
pub fn clear_all_placeholder_paths(conn: &Connection) -> AppResult<()> {
    conn.execute("UPDATE assets SET placeholder_path = NULL", [])?;
    Ok(())
}

/// B27：清空所有素材的高清缩略图路径（清缓存时回写 DB）
pub fn clear_all_hd_thumbnail_paths(conn: &Connection) -> AppResult<()> {
    conn.execute("UPDATE assets SET hd_thumbnail_path = NULL", [])?;
    Ok(())
}
