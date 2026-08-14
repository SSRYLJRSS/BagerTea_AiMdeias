//! 素材-标签关联：分配 / 移除 / 批量（FTS tag_names 由触发器聚合刷新）

use rusqlite::Connection;

use super::tags::Tag;
use crate::error::AppResult;

/// 不带事务的内部版：供外层已开事务的调用方使用（如 ai::confirm_suggestion）
pub(crate) fn assign_inner(conn: &Connection, asset_ids: &[i64], tag_ids: &[i64], source: &str) -> AppResult<()> {
    let now = chrono::Utc::now().timestamp_millis();
    for &aid in asset_ids {
        for &tid in tag_ids {
            conn.execute(
                "INSERT OR IGNORE INTO asset_tags (asset_id, tag_id, source, created_at)
                 VALUES (?1, ?2, ?3, ?4)",
                rusqlite::params![aid, tid, source, now],
            )?;
        }
    }
    Ok(())
}

pub fn assign(conn: &Connection, asset_ids: &[i64], tag_ids: &[i64], source: &str) -> AppResult<()> {
    let tx = conn.unchecked_transaction()?;
    assign_inner(&tx, asset_ids, tag_ids, source)?;
    tx.commit()?;
    Ok(())
}

pub fn remove(conn: &Connection, asset_ids: &[i64], tag_ids: &[i64]) -> AppResult<()> {
    let tx = conn.unchecked_transaction()?;
    for &aid in asset_ids {
        for &tid in tag_ids {
            tx.execute(
                "DELETE FROM asset_tags WHERE asset_id = ?1 AND tag_id = ?2",
                rusqlite::params![aid, tid],
            )?;
        }
    }
    tx.commit()?;
    Ok(())
}

pub fn get_asset_tags(conn: &Connection, asset_id: i64) -> AppResult<Vec<Tag>> {
    let mut stmt = conn.prepare(
        "SELECT t.id, t.name, t.parent_id, t.is_preset, t.sort_order
           FROM asset_tags at JOIN tags t ON t.id = at.tag_id
          WHERE at.asset_id = ?1 ORDER BY t.sort_order, t.id",
    )?;
    let tags = stmt
        .query_map([asset_id], |r| {
            Ok(Tag {
                id: r.get(0)?,
                name: r.get(1)?,
                parent_id: r.get(2)?,
                is_preset: r.get::<_, i64>(3)? != 0,
                sort_order: r.get(4)?,
                asset_count: 0,
                total_count: 0,
            })
        })?
        .collect::<Result<_, _>>()?;
    Ok(tags)
}
