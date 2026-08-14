//! AI 打标：批次与建议 CRUD + 确认流（确认才写 asset_tags，防污染标签体系）

use rusqlite::Connection;
use serde::{Deserialize, Serialize};

use super::{asset_tags, tags};
use crate::error::AppResult;

/// 分类标签：{ 分类名: [标签...] }（PRD 5.5；BTreeMap 保证序列化键序稳定）
pub type CategorizedTags = std::collections::BTreeMap<String, Vec<String>>;

/// 宽容解析历史数据：旧格式是扁平数组 → 收进「未分类」；新格式是分类对象
pub fn parse_tags_json(raw: &str) -> CategorizedTags {
    let v: serde_json::Value = serde_json::from_str(raw).unwrap_or_default();
    if let Some(arr) = v.as_array() {
        let tags: Vec<String> = arr.iter().filter_map(|t| t.as_str().map(String::from)).collect();
        return if tags.is_empty() {
            CategorizedTags::new()
        } else {
            CategorizedTags::from([("未分类".to_string(), tags)])
        };
    }
    serde_json::from_value(v).unwrap_or_default()
}

/// 分类标签写入标签树：分类建/复用父标签，标签建/复用子标签，返回全部子标签 id
fn categorized_tag_ids(conn: &Connection, tags: &CategorizedTags) -> AppResult<Vec<i64>> {
    let mut ids = Vec::new();
    for (category, names) in tags {
        let category = category.trim();
        if category.is_empty() {
            continue;
        }
        let parent = tags::find_or_create_root(conn, category)?;
        for name in names {
            let name = name.trim();
            if !name.is_empty() {
                ids.push(tags::find_or_create_child(conn, parent, name)?);
            }
        }
    }
    Ok(ids)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiBatch {
    pub id: i64,
    pub status: String, // pending|processing|done|cancelled
    pub mode: String,   // cloud|local
    pub total: i64,
    pub processed: i64,
    pub confirmed: i64,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiSuggestion {
    pub id: i64,
    pub batch_id: i64,
    pub asset_id: i64,
    pub asset_path: String,
    pub suggested_tags: CategorizedTags,
    pub status: String, // pending|confirmed|rejected|modified
    pub confirmed_tags: CategorizedTags,
    pub created_at: i64,
}

fn batch_from_row(r: &rusqlite::Row) -> rusqlite::Result<AiBatch> {
    Ok(AiBatch {
        id: r.get(0)?,
        status: r.get(1)?,
        mode: r.get(2)?,
        total: r.get(3)?,
        processed: r.get(4)?,
        confirmed: r.get(5)?,
        created_at: r.get(6)?,
    })
}

const BATCH_COLS: &str = "id, status, mode, total, processed, confirmed, created_at";

pub fn create_batch(conn: &Connection, asset_ids: &[i64], mode: &str) -> AppResult<AiBatch> {
    let now = chrono::Utc::now().timestamp_millis();
    let tx = conn.unchecked_transaction()?;
    tx.execute(
        "INSERT INTO ai_batches (status, mode, total, created_at) VALUES ('pending', ?1, ?2, ?3)",
        rusqlite::params![mode, asset_ids.len() as i64, now],
    )?;
    let batch_id = tx.last_insert_rowid();
    for &aid in asset_ids {
        tx.execute(
            "INSERT INTO ai_suggestions (batch_id, asset_id, suggested_tags, created_at)
             VALUES (?1, ?2, '[]', ?3)",
            rusqlite::params![batch_id, aid, now],
        )?;
    }
    tx.commit()?;
    get_batch(conn, batch_id)
}

pub fn get_batch(conn: &Connection, id: i64) -> AppResult<AiBatch> {
    Ok(conn.query_row(
        &format!("SELECT {BATCH_COLS} FROM ai_batches WHERE id = ?1"),
        [id],
        batch_from_row,
    )?)
}

pub fn list_batches(conn: &Connection) -> AppResult<Vec<AiBatch>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {BATCH_COLS} FROM ai_batches ORDER BY id DESC"
    ))?;
    let rows = stmt.query_map([], batch_from_row)?.collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

pub fn set_batch_status(conn: &Connection, id: i64, status: &str) -> AppResult<()> {
    conn.execute(
        "UPDATE ai_batches SET status = ?1 WHERE id = ?2",
        rusqlite::params![status, id],
    )?;
    Ok(())
}

pub fn inc_batch_processed(conn: &Connection, id: i64) -> AppResult<()> {
    conn.execute(
        "UPDATE ai_batches SET processed = processed + 1 WHERE id = ?1",
        [id],
    )?;
    Ok(())
}

/// 写/覆盖某条建议的 AI 候选标签（tagging_service 用，T05）
pub fn set_suggestion_tags(conn: &Connection, id: i64, tags: &CategorizedTags) -> AppResult<()> {
    conn.execute(
        "UPDATE ai_suggestions SET suggested_tags = ?1 WHERE id = ?2",
        rusqlite::params![serde_json::to_string(tags)?, id],
    )?;
    Ok(())
}

fn suggestion_from_row(r: &rusqlite::Row) -> rusqlite::Result<AiSuggestion> {
    let suggested: String = r.get(4)?;
    let confirmed: Option<String> = r.get(6)?;
    Ok(AiSuggestion {
        id: r.get(0)?,
        batch_id: r.get(1)?,
        asset_id: r.get(2)?,
        asset_path: r.get(3)?,
        suggested_tags: parse_tags_json(&suggested),
        status: r.get(5)?,
        confirmed_tags: confirmed.map(|s| parse_tags_json(&s)).unwrap_or_default(),
        created_at: r.get(7)?,
    })
}

const SUGG_COLS: &str = "s.id, s.batch_id, s.asset_id, a.file_path, s.suggested_tags, s.status, s.confirmed_tags, s.created_at";

pub fn list_suggestions(conn: &Connection, batch_id: i64) -> AppResult<Vec<AiSuggestion>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {SUGG_COLS} FROM ai_suggestions s JOIN assets a ON a.id = s.asset_id
          WHERE s.batch_id = ?1 ORDER BY s.id"
    ))?;
    let rows = stmt
        .query_map([batch_id], suggestion_from_row)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

/// 确认建议（内部版，不开事务）：供外层已开事务的调用方使用（confirm_all_pending）
/// B20：拆出 inner 版，与 asset_tags::assign / assign_inner 模式一致
fn confirm_suggestion_inner(conn: &Connection, id: i64, tags: &CategorizedTags) -> AppResult<()> {
    let (asset_id, batch_id, mode): (i64, i64, String) = conn.query_row(
        "SELECT s.asset_id, s.batch_id, b.mode FROM ai_suggestions s
         JOIN ai_batches b ON b.id = s.batch_id WHERE s.id = ?1",
        [id],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
    )?;
    let source = if mode == "cloud" { "ai_cloud" } else { "ai_local" };

    let tag_ids = categorized_tag_ids(conn, tags)?;
    asset_tags::assign_inner(conn, &[asset_id], &tag_ids, source)?;
    let status = "confirmed";
    conn.execute(
        "UPDATE ai_suggestions SET status = ?1, confirmed_tags = ?2 WHERE id = ?3",
        rusqlite::params![status, serde_json::to_string(tags)?, id],
    )?;
    conn.execute(
        "UPDATE ai_batches SET confirmed = confirmed + 1 WHERE id = ?1",
        [batch_id],
    )?;
    Ok(())
}

/// 确认建议：tags 为最终确认值（含人工修改）；写入 asset_tags 并联动批次计数
/// B20：公开版开单事务调 inner
pub fn confirm_suggestion(conn: &Connection, id: i64, tags: &CategorizedTags) -> AppResult<()> {
    let tx = conn.unchecked_transaction()?;
    confirm_suggestion_inner(&tx, id, tags)?;
    tx.commit()?;
    Ok(())
}

/// 批量套用标签到任意素材（PRD 5.3：胶片条多选套用；来源 manual）
pub fn apply_tags(conn: &Connection, asset_ids: &[i64], tags: &CategorizedTags) -> AppResult<()> {
    if asset_ids.is_empty() {
        return Ok(());
    }
    let tx = conn.unchecked_transaction()?;
    let tag_ids = categorized_tag_ids(&tx, tags)?;
    asset_tags::assign_inner(&tx, asset_ids, &tag_ids, "manual")?;
    tx.commit()?;
    Ok(())
}

/// 撤销拒绝（v2.11）：已拒绝建议恢复为待确认，防误触
pub fn restore_suggestion(conn: &Connection, id: i64) -> AppResult<()> {
    conn.execute(
        "UPDATE ai_suggestions SET status = 'pending' WHERE id = ?1 AND status = 'rejected'",
        rusqlite::params![id],
    )?;
    Ok(())
}

pub fn reject_suggestion(conn: &Connection, id: i64) -> AppResult<()> {
    conn.execute(
        "UPDATE ai_suggestions SET status = 'rejected' WHERE id = ?1",
        [id],
    )?;
    Ok(())
}

/// 批量确认某批次全部 pending 建议（按 AI 原建议写入）
/// B20：外层包裹单事务，保证原子性（部分失败整批回滚）
pub fn confirm_all_pending(conn: &Connection, batch_id: i64) -> AppResult<()> {
    let pendings: Vec<(i64, CategorizedTags)> = {
        let mut stmt = conn.prepare(
            "SELECT id, suggested_tags FROM ai_suggestions WHERE batch_id = ?1 AND status = 'pending'",
        )?;
        let rows = stmt.query_map([batch_id], |r| {
            let raw: String = r.get(1)?;
            Ok((r.get::<_, i64>(0)?, parse_tags_json(&raw)))
        })?
        .collect::<Result<Vec<_>, _>>()?;
        rows
    };
    // B20：外层单事务，部分失败整批回滚
    let tx = conn.unchecked_transaction()?;
    for (id, tags) in pendings {
        confirm_suggestion_inner(&tx, id, &tags)?;
    }
    tx.commit()?;
    Ok(())
}
