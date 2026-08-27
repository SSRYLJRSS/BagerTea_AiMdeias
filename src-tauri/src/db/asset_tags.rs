//! 素材-标签关联：分配 / 移除 / 批量（FTS tag_names 由触发器聚合刷新；R-25 同步写 tag_ops 流水）

use rusqlite::Connection;

use super::{tag_ops, tags::Tag};
use crate::error::AppResult;

/// 不带事务的内部版：供外层已开事务的调用方使用（如 ai::confirm_suggestion）
/// R-25：真实新增的关联写 add 流水（batch_id 由 AI 确认流传入，手工为 None）
pub(crate) fn assign_inner(
    conn: &Connection,
    asset_ids: &[i64],
    tag_ids: &[i64],
    source: &str,
    batch_id: Option<i64>,
) -> AppResult<()> {
    let now = chrono::Utc::now().timestamp_millis();
    for &aid in asset_ids {
        for &tid in tag_ids {
            let n = conn.execute(
                "INSERT OR IGNORE INTO asset_tags
                 (asset_id, tag_id, source, created_at, confirmation, confirmed_at, confirmed_by, source_batch_id)
                 VALUES (?1, ?2, ?3, ?4, 'confirmed', ?4, ?3, ?5)",
                rusqlite::params![aid, tid, source, now, batch_id],
            )?;
            if n > 0 {
                tag_ops::record(conn, aid, tid, "add", source, batch_id)?;
            } else if source == "manual" {
                // 人工确认优先于历史 AI 来源，但关联已存在时不重复记录 add 流水。
                // D-1/D-2：手工覆盖必须清空 source_batch_id，否则撤销 AI 批次会误删手工确认后的标签。
                conn.execute(
                    "UPDATE asset_tags SET source='manual', confidence=NULL,
                            source_batch_id=NULL,
                            confirmation='confirmed', confirmed_at=?3, confirmed_by='manual'
                      WHERE asset_id=?1 AND tag_id=?2 AND source != 'manual'",
                    rusqlite::params![aid, tid, now],
                )?;
            }
        }
    }
    Ok(())
}

pub fn assign(
    conn: &Connection,
    asset_ids: &[i64],
    tag_ids: &[i64],
    source: &str,
) -> AppResult<()> {
    let tx = conn.unchecked_transaction()?;
    assign_inner(&tx, asset_ids, tag_ids, source, None)?;
    tx.commit()?;
    Ok(())
}

/// R-25：真实移除的关联写 remove 流水（actor 读原关联 source，保证 AI 标签可溯源）
pub fn remove(conn: &Connection, asset_ids: &[i64], tag_ids: &[i64]) -> AppResult<()> {
    let tx = conn.unchecked_transaction()?;
    for &aid in asset_ids {
        for &tid in tag_ids {
            let src: Option<String> = tx
                .query_row(
                    "SELECT source FROM asset_tags WHERE asset_id = ?1 AND tag_id = ?2",
                    rusqlite::params![aid, tid],
                    |r| r.get(0),
                )
                .ok();
            let n = tx.execute(
                "DELETE FROM asset_tags WHERE asset_id = ?1 AND tag_id = ?2",
                rusqlite::params![aid, tid],
            )?;
            if n > 0 {
                let actor = src.unwrap_or_else(|| "manual".to_string());
                tag_ops::record(&tx, aid, tid, "remove", &actor, None)?;
            }
        }
    }
    tx.commit()?;
    Ok(())
}

pub fn get_asset_tags(conn: &Connection, asset_id: i64) -> AppResult<Vec<Tag>> {
    let mut stmt = conn.prepare(
        "SELECT t.id, t.name, COALESCE(t.canonical_name,t.name),
                COALESCE(t.normalized_name,lower(trim(t.name))), COALESCE(t.facet_key,'custom'),
                t.parent_id, COALESCE(t.status,'active'), COALESCE(t.is_system,0),
                t.is_preset, t.sort_order
           FROM asset_tags at JOIN tags t ON t.id = at.tag_id
          WHERE at.asset_id = ?1 AND COALESCE(t.status,'active') != 'blocked'
          ORDER BY t.sort_order, t.id",
    )?;
    let mut tags = stmt
        .query_map([asset_id], |r| {
            Ok(Tag {
                id: r.get(0)?,
                name: r.get(1)?,
                canonical_name: r.get(2)?,
                normalized_name: r.get(3)?,
                facet_key: r.get(4)?,
                parent_id: r.get(5)?,
                status: r.get(6)?,
                is_system: r.get::<_, i64>(7)? != 0,
                is_preset: r.get::<_, i64>(8)? != 0,
                sort_order: r.get(9)?,
                asset_count: 0,
                total_count: 0,
                aliases: Vec::new(),
                path: String::new(),
            })
        })?
        .collect::<Result<_, _>>()?;
    for tag in &mut tags {
        super::tags::hydrate_metadata(conn, tag)?;
    }
    Ok(tags)
}
