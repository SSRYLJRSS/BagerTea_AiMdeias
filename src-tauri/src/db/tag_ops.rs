//! 打标操作流水（R-25）：挂/摘标签写流水，撤销按 batch_id 反向操作（粒度=批次）

use rusqlite::Connection;
use serde::{Deserialize, Serialize};

use crate::error::AppResult;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TagOp {
    pub id: i64,
    pub asset_id: i64,
    pub tag_id: i64,
    /// add | remove
    pub op: String,
    /// manual | ai_cloud | ai_local
    pub actor: String,
    /// AI 批次 id（手工操作为 NULL）
    pub batch_id: Option<i64>,
    pub created_at: i64,
    // ---- 展示辅助（查询时 JOIN 填充，写入不涉及）----
    pub tag_name: String,
    pub asset_name: String,
}

/// 写一条流水（必须在调用方事务内调用，与 asset_tags 变更同事务保证原子）
pub(crate) fn record(
    conn: &Connection,
    asset_id: i64,
    tag_id: i64,
    op: &str,
    actor: &str,
    batch_id: Option<i64>,
) -> AppResult<()> {
    let now = chrono::Utc::now().timestamp_millis();
    conn.execute(
        "INSERT INTO tag_ops (asset_id, tag_id, op, actor, batch_id, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        rusqlite::params![asset_id, tag_id, op, actor, batch_id, now],
    )?;
    Ok(())
}

/// 最近打标列表（打标页左栏）：按时间倒序，JOIN 标签名/素材名供展示
pub fn recent(conn: &Connection, limit: i64) -> AppResult<Vec<TagOp>> {
    let limit = limit.clamp(1, 500);
    let mut stmt = conn.prepare(
        "SELECT o.id, o.asset_id, o.tag_id, o.op, o.actor, o.batch_id, o.created_at,
                t.name, a.file_name
           FROM tag_ops o
           JOIN tags t ON t.id = o.tag_id
           JOIN assets a ON a.id = o.asset_id
          ORDER BY o.id DESC LIMIT ?1",
    )?;
    let rows = stmt
        .query_map([limit], |r| {
            Ok(TagOp {
                id: r.get(0)?,
                asset_id: r.get(1)?,
                tag_id: r.get(2)?,
                op: r.get(3)?,
                actor: r.get(4)?,
                batch_id: r.get(5)?,
                created_at: r.get(6)?,
                tag_name: r.get(7)?,
                asset_name: r.get(8)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

/// 批次撤销（R-25）：按流水倒序反向操作——add→摘除、remove→挂回（actor 沿用原值）；
/// 反向操作本身不再写流水（撤销即回滚，历史保留原记录）。
/// 幂等：重复撤销无副作用（摘除已不在的关联 / 挂回已存在的关联均被跳过）。
pub fn undo_batch(conn: &Connection, batch_id: i64) -> AppResult<u64> {
    let ops: Vec<(i64, i64, String, String)> = {
        let mut stmt = conn.prepare(
            "SELECT asset_id, tag_id, op, actor FROM tag_ops
              WHERE batch_id = ?1 ORDER BY id DESC",
        )?;
        let rows = stmt
            .query_map([batch_id], |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, i64>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        rows
    };
    if ops.is_empty() {
        return Ok(0);
    }
    let tx = conn.unchecked_transaction()?;
    let now = chrono::Utc::now().timestamp_millis();
    let mut applied: u64 = 0;
    for (asset_id, tag_id, op, actor) in &ops {
        match op.as_str() {
            "add" => {
                applied += tx.execute(
                    "DELETE FROM asset_tags WHERE asset_id = ?1 AND tag_id = ?2",
                    rusqlite::params![asset_id, tag_id],
                )? as u64;
            }
            "remove" => {
                let inserted = tx.execute(
                    "INSERT OR IGNORE INTO asset_tags (asset_id, tag_id, source, created_at)
                     VALUES (?1, ?2, ?3, ?4)",
                    rusqlite::params![asset_id, tag_id, actor, now],
                )?;
                applied += inserted as u64;
            }
            _ => {}
        }
    }
    tx.commit()?;
    Ok(applied)
}
