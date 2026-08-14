//! 素材仓储：CRUD + 分页查询（类型/未打标/标签树/搜索 四路筛选，标签聚合返回）

use rusqlite::{Connection, Row};
use serde::{Deserialize, Serialize};

use super::{search, tags::Tag};
use crate::error::AppResult;

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
pub struct AssetFilter {
    /// "all" | "image" | "video"（None / "all" = 全部）
    pub asset_type: Option<String>,
    #[serde(default)]
    pub untagged_only: bool,
    /// 父标签连带子标签（递归 CTE 处理）
    pub tag_id: Option<i64>,
    /// 搜索关键词（FTS5 / ≤2 字 LIKE 兜底，见 db/search.rs）
    pub search: Option<String>,
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
            search: None,
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

const COLUMNS: &str = "id, file_path, file_name, file_ext, file_size, mime_type, width, height, \
                       duration_ms, video_codec, audio_codec, taken_at, created_at, modified_at, \
                       hash, placeholder_path, hd_thumbnail_path, \
                       camera, lens, iso, aperture, shutter, focal";

fn from_row(row: &Row) -> rusqlite::Result<Asset> {
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
        tags: Vec::new(),
    })
}

/// 组装 WHERE 子句与位置参数（?1.. 顺序与返回参数一致）
fn build_where(filter: &AssetFilter, search_ids: Option<&[i64]>) -> (String, Vec<i64>) {
    let mut cond = String::from("1=1");
    let mut params: Vec<i64> = Vec::new();
    match filter.asset_type.as_deref() {
        Some("image") => cond.push_str(" AND a.mime_type LIKE 'image/%'"),
        Some("video") => cond.push_str(" AND a.mime_type LIKE 'video/%'"),
        _ => {}
    }
    if filter.untagged_only {
        cond.push_str(" AND NOT EXISTS (SELECT 1 FROM asset_tags at WHERE at.asset_id = a.id)");
    }
    if let Some(tid) = filter.tag_id {
        params.push(tid);
        cond.push_str(&format!(
            " AND a.id IN (SELECT asset_id FROM asset_tags WHERE tag_id IN (
                WITH RECURSIVE sub(id) AS (
                  SELECT ?{} UNION ALL
                  SELECT t.id FROM tags t JOIN sub s ON t.parent_id = s.id
                ) SELECT id FROM sub))",
            params.len()
        ));
    }
    if let Some(ids) = search_ids {
        if ids.is_empty() {
            cond.push_str(" AND 1=0"); // 搜索无命中
        } else {
            let list = ids.iter().map(i64::to_string).collect::<Vec<_>>().join(",");
            cond.push_str(&format!(" AND a.id IN ({list})"));
        }
    }
    (cond, params)
}

/// 只返回当前筛选结果的 id 数组（BUG-E：全选/反选/批量操作无需完整 Asset 对象）。
/// 复用 build_where 与搜索逻辑，仅 SELECT a.id，ORDER BY 与 list() 一致。
pub fn list_ids(conn: &Connection, filter: &AssetFilter) -> AppResult<Vec<i64>> {
    let search_ids = match &filter.search {
        Some(q) if !q.trim().is_empty() => Some(search::search_asset_ids(conn, q)?),
        _ => None,
    };
    let (cond, params) = build_where(filter, search_ids.as_deref());
    let owned: Vec<Box<dyn rusqlite::ToSql>> = params
        .iter()
        .map(|p| Box::new(*p) as Box<dyn rusqlite::ToSql>)
        .collect();
    let refs: Vec<&dyn rusqlite::ToSql> = owned.iter().map(|b| b.as_ref()).collect();
    let mut stmt = conn.prepare(&format!(
        "SELECT a.id FROM assets a WHERE {cond} ORDER BY a.created_at DESC, a.id DESC LIMIT 100000" // B19：上限 100000（全选用，放宽但防滥用）
    ))?;
    let ids = stmt
        .query_map(refs.as_slice(), |r| r.get::<_, i64>(0))?
        .collect::<Result<Vec<i64>, _>>()?;
    Ok(ids)
}

pub fn list(conn: &Connection, filter: &AssetFilter) -> AppResult<AssetPage> {
    let search_ids = match &filter.search {
        Some(q) if !q.trim().is_empty() => Some(search::search_asset_ids(conn, q)?),
        _ => None,
    };
    let (cond, params) = build_where(filter, search_ids.as_deref());
    let owned: Vec<Box<dyn rusqlite::ToSql>> = params
        .iter()
        .map(|p| Box::new(*p) as Box<dyn rusqlite::ToSql>)
        .collect();
    let mut refs: Vec<&dyn rusqlite::ToSql> = owned.iter().map(|b| b.as_ref()).collect();

    let total: i64 = conn.query_row(
        &format!("SELECT COUNT(*) FROM assets a WHERE {cond}"),
        refs.as_slice(),
        |r| r.get(0),
    )?;

    let mut page_params = refs.clone();
    let limit = filter.limit.max(1).min(1000); // B19：上限 1000，防一次拉全库
    let offset = filter.offset.max(0);
    page_params.push(&limit);
    page_params.push(&offset);
    let mut stmt = conn.prepare(&format!(
        "SELECT {COLUMNS} FROM assets a WHERE {cond} ORDER BY a.created_at DESC, a.id DESC LIMIT ?{} OFFSET ?{}",
        refs.len() + 1,
        refs.len() + 2
    ))?;
    refs.clear();
    let mut items: Vec<Asset> = stmt
        .query_map(page_params.as_slice(), from_row)?
        .collect::<Result<_, _>>()?;

    fill_tags(conn, &mut items)?;
    Ok(AssetPage {
        has_more: offset + (items.len() as i64) < total,
        items,
        total,
    })
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
        "SELECT at.asset_id, t.id, t.name, t.parent_id, t.is_preset, t.sort_order
           FROM asset_tags at JOIN tags t ON t.id = at.tag_id
          WHERE at.asset_id IN ({ids}) ORDER BY t.sort_order, t.id"
    ))?;
    let rows = stmt.query_map([], |r| {
        Ok((
            r.get::<_, i64>(0)?,
            Tag {
                id: r.get(1)?,
                name: r.get(2)?,
                parent_id: r.get(3)?,
                is_preset: r.get::<_, i64>(4)? != 0,
                sort_order: r.get(5)?,
                asset_count: 0,
                total_count: 0,
            },
        ))
    })?;
    for row in rows {
        let (asset_id, tag) = row?;
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
