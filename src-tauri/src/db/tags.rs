//! 标签仓储：CRUD + 递归树 + 连带计数（父标签 = 自身+后代去重素材数）

use rusqlite::Connection;
use serde::{Deserialize, Serialize};

use crate::error::AppResult;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Tag {
    pub id: i64,
    pub name: String,
    pub canonical_name: String,
    pub normalized_name: String,
    pub facet_key: String,
    pub parent_id: Option<i64>,
    pub status: String,
    pub is_system: bool,
    pub is_preset: bool,
    pub sort_order: i64,
    /// 自身直接关联素材数
    pub asset_count: i64,
    /// 自身+后代合计（去重；父标签显示值）
    pub total_count: i64,
    #[serde(default)]
    pub aliases: Vec<String>,
    #[serde(default)]
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TagNode {
    pub tag: Tag,
    pub children: Vec<TagNode>,
}

pub fn normalize_name(name: &str) -> String {
    name.trim()
        .chars()
        .map(|c| match c {
            '\u{3000}' => ' ',
            'Ａ'..='Ｚ' => ((c as u32 - 'Ａ' as u32) as u8 + b'a') as char,
            'ａ'..='ｚ' => ((c as u32 - 'ａ' as u32) as u8 + b'a') as char,
            '０'..='９' => ((c as u32 - '０' as u32) as u8 + b'0') as char,
            _ => c,
        })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
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
        "SELECT t.id, t.name, COALESCE(t.canonical_name, t.name),
                COALESCE(t.normalized_name, lower(trim(t.name))),
                COALESCE(t.facet_key, 'custom'), t.parent_id,
                COALESCE(t.status, 'active'), COALESCE(t.is_system, 0),
                t.is_preset, t.sort_order,
                (SELECT COUNT(*) FROM asset_tags at WHERE at.tag_id = t.id) AS asset_count
           FROM tags t WHERE COALESCE(t.status, 'active') = 'active'
          ORDER BY t.sort_order, t.id",
    )?;
    let mut tags: Vec<Tag> = stmt
        .query_map([], |r| {
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
                asset_count: r.get(10)?,
                total_count: 0,
                aliases: Vec::new(),
                path: String::new(),
            })
        })?
        .collect::<Result<_, _>>()?;
    for t in &mut tags {
        t.total_count = total_count(conn, t.id)?;
        t.aliases = aliases(conn, t.id)?;
        t.path = conn
            .query_row(
                "WITH RECURSIVE chain(id, name, parent_id, depth) AS (
               SELECT id, name, parent_id, 0 FROM tags WHERE id = ?1
               UNION ALL SELECT t.id, t.name, t.parent_id, c.depth + 1
                 FROM tags t JOIN chain c ON t.id = c.parent_id
             ) SELECT group_concat(name, ' / ') FROM (SELECT name FROM chain ORDER BY depth DESC)",
                [t.id],
                |r| r.get::<_, Option<String>>(0),
            )?
            .unwrap_or_else(|| t.name.clone());
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
    create_in_facet(conn, name, parent_id, None)
}

pub fn create_in_facet(
    conn: &Connection,
    name: &str,
    parent_id: Option<i64>,
    facet_key: Option<&str>,
) -> AppResult<Tag> {
    let name = name.trim();
    let facet = match facet_key {
        Some(key) => key.to_string(),
        None => parent_id
            .and_then(|id| {
                conn.query_row("SELECT facet_key FROM tags WHERE id = ?1", [id], |r| {
                    r.get(0)
                })
                .ok()
            })
            .unwrap_or_else(|| "custom".to_string()),
    };
    let normalized = normalize_name(name);
    conn.execute(
        "INSERT INTO tags (name, canonical_name, normalized_name, facet_key, parent_id)
         VALUES (?1, ?1, ?3, ?4, ?2)",
        rusqlite::params![name, parent_id, normalized, facet],
    )?;
    let id = conn.last_insert_rowid();
    Ok(Tag {
        id,
        name: name.to_string(),
        canonical_name: name.to_string(),
        normalized_name: normalized,
        facet_key: facet,
        parent_id,
        status: "active".to_string(),
        is_system: false,
        is_preset: false,
        sort_order: 0,
        asset_count: 0,
        total_count: 0,
        aliases: Vec::new(),
        path: String::new(),
    })
}

/// 新协议使用的规范标签创建：分面是独立实体，标签直接归属分面。
pub fn find_or_create_canonical(conn: &Connection, facet_key: &str, name: &str) -> AppResult<i64> {
    let normalized = normalize_name(name);
    if normalized.is_empty() {
        return Err(crate::error::AppError::msg("标签名称不能为空"));
    }
    let existing: Option<i64> = conn
        .query_row(
            "SELECT DISTINCT t.id FROM tags t
               LEFT JOIN tag_aliases ta ON ta.tag_id = t.id AND ta.is_searchable = 1
              WHERE t.facet_key = ?1 AND t.status = 'active'
                AND (t.normalized_name = ?2 OR ta.normalized_alias = ?2)
              ORDER BY t.id LIMIT 1",
            rusqlite::params![facet_key, normalized],
            |r| r.get(0),
        )
        .ok();
    if let Some(id) = existing {
        return Ok(id);
    }
    Ok(create_in_facet(conn, name, None, Some(facet_key))?.id)
}

pub fn update(
    conn: &Connection,
    id: i64,
    name: Option<&str>,
    parent_id: Option<Option<i64>>,
) -> AppResult<()> {
    if let Some(n) = name {
        conn.execute(
            "UPDATE tags SET name = ?1, canonical_name = ?1, normalized_name = ?2 WHERE id = ?3",
            rusqlite::params![n, normalize_name(n), id],
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

pub fn update_preserve_alias(
    conn: &Connection,
    id: i64,
    name: Option<&str>,
    parent_id: Option<Option<i64>>,
) -> AppResult<()> {
    let old_name: Option<String> = if name.is_some() {
        Some(conn.query_row("SELECT name FROM tags WHERE id = ?1", [id], |r| r.get(0))?)
    } else {
        None
    };
    update(conn, id, name, parent_id)?;
    if let (Some(old), Some(new)) = (old_name, name) {
        if old != new {
            add_alias(conn, id, &old, None, "old_name")?;
        }
    }
    Ok(())
}

pub fn deactivate(conn: &Connection, id: i64) -> AppResult<()> {
    let changed = conn.execute(
        "WITH RECURSIVE sub(id) AS (
           SELECT ?1 UNION ALL SELECT t.id FROM tags t JOIN sub s ON t.parent_id = s.id
         ) UPDATE tags SET status = 'deprecated' WHERE id IN (SELECT id FROM sub)",
        [id],
    )?;
    if changed == 0 {
        return Err(crate::error::AppError::msg("标签不存在"));
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TagFacetGovernance {
    pub facet_key: String,
    pub tag_count: i64,
    pub active_tag_count: i64,
    pub deprecated_tag_count: i64,
    pub linked_asset_count: i64,
    pub alias_count: i64,
    pub pending_ai_item_count: i64,
}

pub fn governance(conn: &Connection) -> AppResult<Vec<TagFacetGovernance>> {
    let mut stmt = conn.prepare(
        "SELECT f.key,
                COUNT(DISTINCT t.id),
                COUNT(DISTINCT CASE WHEN t.status = 'active' THEN t.id END),
                COUNT(DISTINCT CASE WHEN t.status = 'deprecated' THEN t.id END),
                COUNT(DISTINCT at.asset_id),
                COUNT(DISTINCT ta.id),
                COUNT(DISTINCT CASE WHEN asi.decision = 'pending' THEN asi.id END)
           FROM tag_facets f
           LEFT JOIN tags t ON t.facet_key = f.key
           LEFT JOIN asset_tags at ON at.tag_id = t.id
           LEFT JOIN tag_aliases ta ON ta.tag_id = t.id
           LEFT JOIN ai_suggestion_items asi ON asi.facet_key = f.key
          GROUP BY f.key, f.sort_order
          ORDER BY f.sort_order, f.key",
    )?;
    let rows = stmt
        .query_map([], |r| {
            Ok(TagFacetGovernance {
                facet_key: r.get(0)?,
                tag_count: r.get(1)?,
                active_tag_count: r.get(2)?,
                deprecated_tag_count: r.get(3)?,
                linked_asset_count: r.get(4)?,
                alias_count: r.get(5)?,
                pending_ai_item_count: r.get(6)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

pub fn add_alias(
    conn: &Connection,
    tag_id: i64,
    alias: &str,
    locale: Option<&str>,
    alias_type: &str,
) -> AppResult<()> {
    let alias = alias.trim();
    if alias.is_empty() {
        return Ok(());
    }
    let normalized = normalize_name(alias);
    let locale = locale.unwrap_or("");
    let conflict: Option<i64> = conn
        .query_row(
            "SELECT tag_id FROM tag_aliases
              WHERE normalized_alias = ?1 AND locale = ?2 AND tag_id != ?3
              LIMIT 1",
            rusqlite::params![normalized, locale, tag_id],
            |r| r.get(0),
        )
        .ok();
    if conflict.is_some() {
        return Err(crate::error::AppError::msg("别名已绑定到其他规范标签"));
    }
    conn.execute(
        "INSERT OR IGNORE INTO tag_aliases
         (tag_id, alias, normalized_alias, locale, alias_type, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        rusqlite::params![
            tag_id,
            alias,
            normalized,
            locale,
            alias_type,
            chrono::Utc::now().timestamp_millis()
        ],
    )?;
    Ok(())
}

pub fn aliases(conn: &Connection, tag_id: i64) -> AppResult<Vec<String>> {
    let mut stmt = conn.prepare("SELECT alias FROM tag_aliases WHERE tag_id = ?1 ORDER BY id")?;
    let rows = stmt.query_map([tag_id], |r| r.get(0))?;
    let aliases = rows.collect::<Result<Vec<_>, _>>()?;
    Ok(aliases)
}

pub fn hydrate_metadata(conn: &Connection, tag: &mut Tag) -> AppResult<()> {
    tag.aliases = aliases(conn, tag.id)?;
    tag.path = conn
        .query_row(
            "WITH RECURSIVE chain(id, name, parent_id, depth) AS (
               SELECT id, name, parent_id, 0 FROM tags WHERE id = ?1
               UNION ALL SELECT t.id, t.name, t.parent_id, c.depth + 1
                 FROM tags t JOIN chain c ON t.id = c.parent_id
             ) SELECT group_concat(name, ' / ') FROM (SELECT name FROM chain ORDER BY depth DESC)",
            [tag.id],
            |r| r.get::<_, Option<String>>(0),
        )?
        .unwrap_or_else(|| tag.name.clone());
    Ok(())
}

pub fn list_by_facet(conn: &Connection, facet_key: &str) -> AppResult<Vec<TagNode>> {
    let tree = list_tree(conn)?;
    fn filter(nodes: Vec<TagNode>, facet: &str) -> Vec<TagNode> {
        nodes
            .into_iter()
            .filter_map(|mut node| {
                let children = filter(node.children, facet);
                if node.tag.facet_key == facet || !children.is_empty() {
                    node.children = children;
                    Some(node)
                } else {
                    None
                }
            })
            .collect()
    }
    Ok(filter(tree, facet_key))
}

pub fn search_candidates(
    conn: &Connection,
    facet_key: Option<&str>,
    query: &str,
) -> AppResult<Vec<Tag>> {
    let normalized = normalize_name(query);
    let mut sql = String::from(
        "SELECT DISTINCT t.id, t.name, COALESCE(t.canonical_name,t.name),
                COALESCE(t.normalized_name,lower(trim(t.name))), COALESCE(t.facet_key,'custom'),
                t.parent_id, COALESCE(t.status,'active'), COALESCE(t.is_system,0),
                t.is_preset, t.sort_order,
                (SELECT COUNT(*) FROM asset_tags at WHERE at.tag_id=t.id)
           FROM tags t LEFT JOIN tag_aliases ta ON ta.tag_id=t.id
          WHERE COALESCE(t.status,'active')='active'
            AND (COALESCE(t.normalized_name,lower(trim(t.name))) LIKE ?1
              OR ta.normalized_alias LIKE ?1)"
            .to_string(),
    );
    if facet_key.is_some() {
        sql.push_str(" AND COALESCE(t.facet_key,'custom') = ?2");
    }
    sql.push_str(" ORDER BY t.sort_order, t.id LIMIT 100");
    let pattern = format!("%{normalized}%");
    let mut stmt = conn.prepare(&sql)?;
    let mut rows = if let Some(facet) = facet_key {
        stmt.query_map(rusqlite::params![pattern, facet], tag_from_row)?
            .collect::<Result<Vec<_>, _>>()?
    } else {
        stmt.query_map(rusqlite::params![pattern], tag_from_row)?
            .collect::<Result<Vec<_>, _>>()?
    };
    for tag in &mut rows {
        tag.total_count = total_count(conn, tag.id)?;
        hydrate_metadata(conn, tag)?;
    }
    Ok(rows)
}

fn tag_from_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<Tag> {
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
        asset_count: r.get(10)?,
        total_count: 0,
        aliases: Vec::new(),
        path: String::new(),
    })
}

/// 合并标签（M3-01 R-19）：src 的素材关联与子标签全部并入 dst，随后删除 src。
/// 单事务；走 DELETE+INSERT 而非 UPDATE 改挂，保证 FTS 触发器（trg_at_ai/ad）联动。
pub fn merge_preserve_alias(conn: &Connection, src_id: i64, dst_id: i64) -> AppResult<()> {
    if src_id == dst_id {
        return Err(crate::error::AppError::msg("不能把标签合并到它自己"));
    }
    // 防环：目标不能是源标签的后代（否则子标签回挂后树结构错乱）
    if descendant_ids(conn, src_id)?.contains(&dst_id) {
        return Err(crate::error::AppError::msg(
            "不能把标签合并到它自己的子标签下",
        ));
    }
    let (src_facet, dst_facet): (String, String) = conn.query_row(
        "SELECT s.facet_key, d.facet_key FROM tags s JOIN tags d ON d.id = ?2 WHERE s.id = ?1",
        rusqlite::params![src_id, dst_id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    if src_facet != dst_facet {
        return Err(crate::error::AppError::msg("不同分面的标签不能合并"));
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
    let src_name: String = tx.query_row("SELECT name FROM tags WHERE id = ?1", [src_id], |r| {
        r.get(0)
    })?;
    // ① src 独有素材 → 挂到 dst（INSERT 触发 FTS 更新）
    tx.execute(
        "INSERT INTO asset_tags
         (asset_id, tag_id, source, created_at, confidence, confirmation, confirmed_at, confirmed_by, source_batch_id)
         SELECT at.asset_id, ?2, at.source, at.created_at, at.confidence, at.confirmation,
                at.confirmed_at, at.confirmed_by, at.source_batch_id FROM asset_tags at
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
    tx.execute(
        "UPDATE tags SET status = 'deprecated' WHERE id = ?1",
        [src_id],
    )?;
    add_alias(&tx, dst_id, &src_name, None, "old_name")?;
    tx.commit()?;
    Ok(())
}

/// 旧版兼容合并：保持原有“源标签物理删除、旧名称不再命中”的语义。
/// 新界面必须使用 merge_preserve_alias。
pub fn merge(conn: &Connection, src_id: i64, dst_id: i64) -> AppResult<()> {
    let src_name: String =
        conn.query_row("SELECT name FROM tags WHERE id=?1", [src_id], |r| r.get(0))?;
    merge_preserve_alias(conn, src_id, dst_id)?;
    let tx = conn.unchecked_transaction()?;
    tx.execute("DELETE FROM tags WHERE id=?1", [src_id])?;
    tx.execute(
        "DELETE FROM tag_aliases WHERE tag_id=?1 AND alias_type='old_name' AND normalized_alias=?2",
        rusqlite::params![dst_id, normalize_name(&src_name)],
    )?;
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
    Ok(create_in_facet(conn, name, None, Some("custom"))?.id)
}

pub fn find_or_create_facet_root(
    conn: &Connection,
    facet_key: &str,
    display_name: &str,
) -> AppResult<i64> {
    let mut stmt = conn.prepare(
        "SELECT id FROM tags WHERE parent_id IS NULL AND facet_key = ?1
          AND status = 'active' ORDER BY is_system DESC, id LIMIT 1",
    )?;
    let mut rows = stmt.query([facet_key])?;
    if let Some(row) = rows.next()? {
        return Ok(row.get(0)?);
    }
    drop(rows);
    drop(stmt);
    let tag = create_in_facet(conn, display_name, None, Some(facet_key))?;
    conn.execute(
        "UPDATE tags SET is_system = 1, is_preset = 1 WHERE id = ?1",
        [tag.id],
    )?;
    Ok(tag.id)
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
    Ok(create_in_facet(conn, name, Some(parent_id), None)?.id)
}

/// 旧版兼容入口：不再自动播种自由标签。
///
/// 过去这里会创建“人像、风景、美食、街拍……”等标签。当前 AI 使用
/// facet + canonical tag，这些预置词既不是必要词表，也容易和用户自己的
/// 标签重复，因此保留函数名但改为空操作，避免外部旧调用失效。
pub fn seed_presets(conn: &Connection) -> AppResult<()> {
    retire_unused_presets(conn)?;
    Ok(())
}

/// 停用没有任何素材关联的旧预置标签。
/// 已经被用户使用过的预置标签不删除，保留历史搜索和素材关联。
pub fn retire_unused_presets(conn: &Connection) -> AppResult<usize> {
    let changed = conn.execute(
        "UPDATE tags SET status = 'deprecated'
          WHERE is_preset = 1
            AND status = 'active'
            AND NOT (is_system = 1 AND parent_id IS NULL)
            AND NOT EXISTS (SELECT 1 FROM asset_tags at WHERE at.tag_id = tags.id)
            AND NOT EXISTS (SELECT 1 FROM tags child WHERE child.parent_id = tags.id AND child.status = 'active')",
        [],
    )?;
    Ok(changed)
}
