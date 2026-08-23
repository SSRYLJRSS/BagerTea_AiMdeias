//! 标签仓储：CRUD + 递归树 + 连带计数（父标签 = 自身+后代去重素材数）

use rusqlite::Connection;
use serde::{Deserialize, Serialize};

use crate::error::AppResult;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Tag {
    pub id: i64,
    pub name: String,
    pub parent_id: Option<i64>,
    pub is_preset: bool,
    pub sort_order: i64,
    /// 自身直接关联素材数
    pub asset_count: i64,
    /// 自身+后代合计（去重；父标签显示值）
    pub total_count: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TagNode {
    pub tag: Tag,
    pub children: Vec<TagNode>,
}

/// 子孙 id 集合（含自身）—— 递归 CTE
fn descendant_ids(conn: &Connection, id: i64) -> AppResult<Vec<i64>> {
    let mut stmt = conn.prepare(
        "WITH RECURSIVE sub(id) AS (
           SELECT ?1 UNION ALL
           SELECT t.id FROM tags t JOIN sub s ON t.parent_id = s.id
         ) SELECT id FROM sub",
    )?;
    let ids = stmt
        .query_map([id], |r| r.get(0))?
        .collect::<Result<Vec<i64>, _>>()?;
    Ok(ids)
}

/// 连带计数：标签及其后代关联的去重素材数
pub fn total_count(conn: &Connection, id: i64) -> AppResult<i64> {
    let n: i64 = conn.query_row(
        "WITH RECURSIVE sub(id) AS (
           SELECT ?1 UNION ALL
           SELECT t.id FROM tags t JOIN sub s ON t.parent_id = s.id
         )
         SELECT COUNT(DISTINCT asset_id) FROM asset_tags WHERE tag_id IN (SELECT id FROM sub)",
        [id],
        |r| r.get(0),
    )?;
    Ok(n)
}

/// 全量标签树（百级标签规模，逐标签 CTE 计数毫秒级，架构 §1.4 已论证）
pub fn list_tree(conn: &Connection) -> AppResult<Vec<TagNode>> {
    let mut stmt = conn.prepare(
        "SELECT t.id, t.name, t.parent_id, t.is_preset, t.sort_order,
                (SELECT COUNT(*) FROM asset_tags at WHERE at.tag_id = t.id) AS asset_count
           FROM tags t ORDER BY t.sort_order, t.id",
    )?;
    let mut tags: Vec<Tag> = stmt
        .query_map([], |r| {
            Ok(Tag {
                id: r.get(0)?,
                name: r.get(1)?,
                parent_id: r.get(2)?,
                is_preset: r.get::<_, i64>(3)? != 0,
                sort_order: r.get(4)?,
                asset_count: r.get(5)?,
                total_count: 0,
            })
        })?
        .collect::<Result<_, _>>()?;
    for t in &mut tags {
        t.total_count = total_count(conn, t.id)?;
    }

    // 组树
    fn build(parent: Option<i64>, tags: &[Tag]) -> Vec<TagNode> {
        tags.iter()
            .filter(|t| t.parent_id == parent)
            .map(|t| TagNode {
                tag: t.clone(),
                children: build(Some(t.id), tags),
            })
            .collect()
    }
    Ok(build(None, &tags))
}

pub fn create(conn: &Connection, name: &str, parent_id: Option<i64>) -> AppResult<Tag> {
    conn.execute(
        "INSERT INTO tags (name, parent_id) VALUES (?1, ?2)",
        rusqlite::params![name, parent_id],
    )?;
    let id = conn.last_insert_rowid();
    Ok(Tag {
        id,
        name: name.to_string(),
        parent_id,
        is_preset: false,
        sort_order: 0,
        asset_count: 0,
        total_count: 0,
    })
}

pub fn update(
    conn: &Connection,
    id: i64,
    name: Option<&str>,
    parent_id: Option<Option<i64>>,
) -> AppResult<()> {
    if let Some(n) = name {
        conn.execute(
            "UPDATE tags SET name = ?1 WHERE id = ?2",
            rusqlite::params![n, id],
        )?;
    }
    if let Some(pid) = parent_id {
        // 防环：新父级不能是自身或自身后代
        if let Some(new_parent) = pid {
            if descendant_ids(conn, id)?.contains(&new_parent) {
                return Err(crate::error::AppError::msg("不能把标签挂到自己的子标签下"));
            }
        }
        conn.execute(
            "UPDATE tags SET parent_id = ?1 WHERE id = ?2",
            rusqlite::params![pid, id],
        )?;
    }
    Ok(())
}

/// 删除标签：CASCADE 删除子标签与 asset_tags 关联（FTS 由触发器联动）
pub fn delete(conn: &Connection, id: i64) -> AppResult<()> {
    conn.execute("DELETE FROM tags WHERE id = ?1", [id])?;
    Ok(())
}

/// 合并标签（M3-01 R-19）：src 的素材关联与子标签全部并入 dst，随后删除 src。
/// 单事务；走 DELETE+INSERT 而非 UPDATE 改挂，保证 FTS 触发器（trg_at_ai/ad）联动。
pub fn merge(conn: &Connection, src_id: i64, dst_id: i64) -> AppResult<()> {
    if src_id == dst_id {
        return Err(crate::error::AppError::msg("不能把标签合并到它自己"));
    }
    // 防环：目标不能是源标签的后代（否则子标签回挂后树结构错乱）
    if descendant_ids(conn, src_id)?.contains(&dst_id) {
        return Err(crate::error::AppError::msg(
            "不能把标签合并到它自己的子标签下",
        ));
    }
    // 预检子标签同名冲突（tags 表 UNIQUE(parent_id, name)）
    let clash: i64 = conn.query_row(
        "SELECT COUNT(*) FROM tags a JOIN tags b
           ON a.parent_id = ?1 AND b.parent_id = ?2 AND a.name = b.name",
        rusqlite::params![src_id, dst_id],
        |r| r.get(0),
    )?;
    if clash > 0 {
        return Err(crate::error::AppError::msg(
            "目标标签下已有同名子标签，请先重命名后再合并",
        ));
    }

    let tx = conn.unchecked_transaction()?;
    // ① src 独有素材 → 挂到 dst（INSERT 触发 FTS 更新）
    tx.execute(
        "INSERT INTO asset_tags (asset_id, tag_id, source, created_at)
         SELECT at.asset_id, ?2, at.source, at.created_at FROM asset_tags at
          WHERE at.tag_id = ?1
            AND NOT EXISTS (SELECT 1 FROM asset_tags x WHERE x.asset_id = at.asset_id AND x.tag_id = ?2)",
        rusqlite::params![src_id, dst_id],
    )?;
    // ② 删除 src 全部关联（DELETE 触发 FTS 更新；已挂 dst 的素材去重生效）
    tx.execute("DELETE FROM asset_tags WHERE tag_id = ?1", [src_id])?;
    // ③ src 的子标签回挂 dst（保留层级）
    tx.execute(
        "UPDATE tags SET parent_id = ?2 WHERE parent_id = ?1",
        rusqlite::params![src_id, dst_id],
    )?;
    // ④ 删除 src 标签本体（关联已清空，CASCADE 无副作用）
    tx.execute("DELETE FROM tags WHERE id = ?1", [src_id])?;
    tx.commit()?;
    Ok(())
}

/// 按名称查找/创建根级标签（AI 打标确认写入用）
pub fn find_or_create_root(conn: &Connection, name: &str) -> AppResult<i64> {
    let mut stmt = conn.prepare("SELECT id FROM tags WHERE name = ?1 AND parent_id IS NULL")?;
    let mut rows = stmt.query([name])?;
    if let Some(row) = rows.next()? {
        return Ok(row.get(0)?);
    }
    drop(rows);
    drop(stmt);
    Ok(create(conn, name, None)?.id)
}

/// 按名称查找/创建子标签（PRD 5.5：AI 分类标签，分类=父标签）
pub fn find_or_create_child(conn: &Connection, parent_id: i64, name: &str) -> AppResult<i64> {
    let mut stmt = conn.prepare("SELECT id FROM tags WHERE name = ?1 AND parent_id = ?2")?;
    let mut rows = stmt.query(rusqlite::params![name, parent_id])?;
    if let Some(row) = rows.next()? {
        return Ok(row.get(0)?);
    }
    drop(rows);
    drop(stmt);
    Ok(create(conn, name, Some(parent_id))?.id)
}

/// 预置标签（首次启动播种）
pub fn seed_presets(conn: &Connection) -> AppResult<()> {
    let count: i64 = conn.query_row("SELECT COUNT(*) FROM tags", [], |r| r.get(0))?;
    if count > 0 {
        return Ok(());
    }
    const PRESETS: &[&str] = &[
        "人像", "风景", "美食", "街拍", "宠物", "建筑", "夜景", "自拍", "旅行",
    ];
    for (i, name) in PRESETS.iter().enumerate() {
        conn.execute(
            "INSERT INTO tags (name, is_preset, sort_order) VALUES (?1, 1, ?2)",
            rusqlite::params![name, i as i64],
        )?;
    }
    Ok(())
}
