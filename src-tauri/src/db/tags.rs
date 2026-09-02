//! 标签仓储：CRUD + 递归树 + 连带计数（父标签 = 自身+后代去重素材数）

use rusqlite::Connection;
use serde::{Deserialize, Serialize};

use crate::error::AppResult;

// ═══════════════ F4：可见性三常量（各一个声明处，消费点全部引用） ═══════════════
// ⚠ COALESCE(t.status,'active') 兼容历史 NULL status；EXISTS 分面子查询判有效值。

/// 导航可见（侧栏、标签树、TagAssignDialog）：分面 active 且 cfg_visible_in_navigation=1
pub(crate) const NAV_VISIBLE_TAG: &str =
    "COALESCE(t.status,'active') = 'active' AND EXISTS (SELECT 1 FROM tag_facets f \
      WHERE f.key = COALESCE(t.facet_key,'custom') \
        AND f.status = 'active' AND f.cfg_visible_in_navigation = 1)";

/// 可搜索。⚠ 不看 f.status —— 停用分面的标签仍可搜（F4 语义变更）
pub(crate) const SEARCHABLE_TAG: &str =
    "COALESCE(t.status,'active') = 'active' AND EXISTS (SELECT 1 FROM tag_facets f \
      WHERE f.key = COALESCE(t.facet_key,'custom') AND f.cfg_searchable = 1)";

/// 可进 AI 提示词：分面 active 且 cfg_ai_assignable=1
pub(crate) const AI_ASSIGNABLE_TAG: &str =
    "COALESCE(t.status,'active') = 'active' AND EXISTS (SELECT 1 FROM tag_facets f \
      WHERE f.key = COALESCE(t.facet_key,'custom') \
        AND f.status = 'active' AND f.cfg_ai_assignable = 1)";

/// F4：分面生命周期是否有效（存在且 active，不看 cfg_*）。详情页据此对
/// 「分面已停用/已删除」的标签打「已停用/孤儿」角标（get_asset_tags 不过滤恒显示）。
pub(crate) const FACET_EFFECTIVE: &str =
    "EXISTS (SELECT 1 FROM tag_facets f \
      WHERE f.key = COALESCE(t.facet_key,'custom') AND f.status = 'active')";


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
    /// F4：所在分面生命周期是否有效（存在且 active）。UI 打「已停用」角标用。
    #[serde(default)]
    pub facet_effective: bool,
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
/// F1-d：WHERE d < 12 防环死循环兜底（环存在时无限递归会被 SQLite 10s timeout 杀）
fn descendant_ids(conn: &Connection, id: i64) -> AppResult<Vec<i64>> {
    let mut stmt = conn.prepare(
        "WITH RECURSIVE sub(id, d) AS (
           SELECT ?1, 0 UNION ALL
           SELECT t.id, s.d + 1 FROM tags t JOIN sub s ON t.parent_id = s.id
            WHERE s.d < 12
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
        "WITH RECURSIVE sub(id, d) AS (
           SELECT ?1, 0 UNION ALL
           SELECT t.id, s.d + 1 FROM tags t JOIN sub s ON t.parent_id = s.id
            WHERE s.d < 12
         )
         SELECT COUNT(DISTINCT asset_id) FROM asset_tags WHERE tag_id IN (SELECT id FROM sub)",
        [id],
        |r| r.get(0),
    )?;
    Ok(n)
}

/// 全量标签树（百级标签规模，逐标签 CTE 计数毫秒级，架构 §1.4 已论证）
/// F4：可见性收口 NAV_VISIBLE_TAG —— 分面 active + cfg_visible_in_navigation=1 才显示
pub fn list_tree(conn: &Connection) -> AppResult<Vec<TagNode>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT t.id, t.name, COALESCE(t.canonical_name, t.name),
                COALESCE(t.normalized_name, lower(trim(t.name))),
                COALESCE(t.facet_key, 'custom'), t.parent_id,
                COALESCE(t.status, 'active'), COALESCE(t.is_system, 0),
                t.is_preset, t.sort_order,
                (SELECT COUNT(*) FROM asset_tags at WHERE at.tag_id = t.id) AS asset_count,
                {FACET_EFFECTIVE} AS facet_effective
           FROM tags t WHERE {NAV_VISIBLE_TAG}
          ORDER BY t.sort_order, t.id",
    ))?;
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
                facet_effective: r.get::<_, i64>(11)? != 0,
            })
        })?
        .collect::<Result<_, _>>()?;
    for t in &mut tags {
        t.total_count = total_count(conn, t.id)?;
        t.aliases = aliases(conn, t.id)?;
        // F1-d：chain 递归加 d < 12 上限（防环死循环；path 仅展示用）
        t.path = conn
            .query_row(
                "WITH RECURSIVE chain(id, name, parent_id, depth) AS (
               SELECT id, name, parent_id, 0 FROM tags WHERE id = ?1
               UNION ALL SELECT t.id, t.name, t.parent_id, c.depth + 1
                 FROM tags t JOIN chain c ON t.id = c.parent_id
                WHERE c.depth < 12
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
    let facet_effective = conn
        .query_row(
            "SELECT status = 'active' FROM tag_facets WHERE key = ?1",
            [&facet],
            |r| r.get::<_, bool>(0),
        )
        .unwrap_or(false);
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
        facet_effective,
    })
}

/// 新协议使用的规范标签创建：分面是独立实体，标签直接归属分面。
/// F3-a：查重用 find_by_term(mode=Alias) —— 消灭本函数自写的两表 JOIN + ORDER BY 兜底。
pub fn find_or_create_canonical(conn: &Connection, facet_key: &str, name: &str) -> AppResult<i64> {
    let normalized = normalize_name(name);
    if normalized.is_empty() {
        return Err(crate::error::AppError::msg("标签名称不能为空"));
    }
    let lookup = find_by_term(conn, facet_key, &normalized, TermMatch::Alias)?;
    if let Some(hit) = lookup.hits.first() {
        return Ok(hit.tag_id);
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
    // F1-d：递归 CTE 加 d < 12 上限（防环死循环）
    let changed = conn.execute(
        "WITH RECURSIVE sub(id, d) AS (
           SELECT ?1, 0 UNION ALL SELECT t.id, s.d + 1 FROM tags t JOIN sub s ON t.parent_id = s.id
            WHERE s.d < 12
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
    // F1-d：chain 递归加 d < 12 上限（防环死循环；path 仅展示用）
    tag.path = conn
        .query_row(
            "WITH RECURSIVE chain(id, name, parent_id, depth) AS (
               SELECT id, name, parent_id, 0 FROM tags WHERE id = ?1
               UNION ALL SELECT t.id, t.name, t.parent_id, c.depth + 1
                 FROM tags t JOIN chain c ON t.id = c.parent_id
                WHERE c.depth < 12
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

/// W2-9：按使用次数降序取 Top-N 标签（高频词优先 → 标签收敛更快）。
/// 单条 GROUP BY 走 idx_asset_tags_tag；标签名 >12 字截断；总输出 1500 字符上限。
/// 供 W5a 提示词拼入候选词（「含义相同就用已有的词」约束的事实基础）。
pub fn top_tags_per_facet(conn: &Connection, n: usize) -> AppResult<Vec<(String, String)>> {
    // F4：AI_ASSIGNABLE_TAG —— 停用分面的标签不得作为「已有候选词」喂给 AI
    let mut stmt = conn.prepare(&format!(
        "SELECT t.facet_key, t.name, COUNT(at.asset_id) AS uses
           FROM tags t JOIN asset_tags at ON at.tag_id = t.id
          WHERE {AI_ASSIGNABLE_TAG}
          GROUP BY t.id
          ORDER BY uses DESC, t.sort_order, t.id
          LIMIT ?1",
    ))?;
    let rows: Vec<(String, String)> = stmt
        .query_map([n as i64], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })?
        .filter_map(|r| r.ok())
        .collect();

    // 按分面分组聚合成 "facet_key: 词1/词2/..."，超 12 字的词截断，总量 1500 字符封顶
    let mut by_facet: std::collections::BTreeMap<String, Vec<String>> = Default::default();
    for (facet, name) in rows {
        let short: String = name.chars().take(12).collect();
        by_facet.entry(facet).or_default().push(short);
    }
    const CAP: usize = 1500;
    let mut out: Vec<(String, String)> = Vec::new();
    let mut total: usize = 0;
    for (facet, words) in by_facet {
        let line = words.join("/");
        total += line.chars().count() + facet.len() + 2;
        if total > CAP {
            break;
        }
        out.push((facet, line));
    }
    Ok(out)
}

pub fn search_candidates(
    conn: &Connection,
    facet_key: Option<&str>,
    query: &str,
) -> AppResult<Vec<Tag>> {
    let normalized = normalize_name(query);
    // F4：可搜性收口 SEARCHABLE_TAG（不再内联判 f.status='active'）
    let mut sql = format!(
        "SELECT DISTINCT t.id, t.name, COALESCE(t.canonical_name,t.name),
                COALESCE(t.normalized_name,lower(trim(t.name))), COALESCE(t.facet_key,'custom'),
                t.parent_id, COALESCE(t.status,'active'), COALESCE(t.is_system,0),
                t.is_preset, t.sort_order,
                (SELECT COUNT(*) FROM asset_tags at WHERE at.tag_id=t.id),
                {FACET_EFFECTIVE}
           FROM tags t LEFT JOIN tag_aliases ta ON ta.tag_id=t.id
          WHERE {SEARCHABLE_TAG}
            AND (COALESCE(t.normalized_name,lower(trim(t.name))) LIKE ?1
              OR ta.normalized_alias LIKE ?1)"
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
        facet_effective: r.get::<_, i64>(11)? != 0,
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

// ═══════════════ F2-a：V22b 冲突预检（六类，只读） ═══════════════

/// 分面内 term 冲突组（规范名↔规范名 / 规范名↔别名 / 别名↔别名 归一后去重）。
/// 用于设置页展示「「海边」有 2 个条目（关联 12/3 张素材），合并到哪个？」
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TermConflictGroup {
    pub facet_key: String,
    pub term: String,
    pub entries: Vec<TermConflictEntry>,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TermConflictEntry {
    /// 标签 id（tag_aliases 的归属标签）
    pub tag_id: i64,
    pub name: String,
    /// canonical | alias
    pub kind: String,
    pub linked_assets: i64,
}

/// 孤儿标签（facet_key 指向不存在分面）—— 建议迁到 custom，需用户确认。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrphanTag {
    pub id: i64,
    pub name: String,
    pub facet_key: String,
}

/// 跨分面挂父的标签（子标签 facet 与父 facet 不一致）—— 自动断开层级。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CrossFacetChild {
    pub id: i64,
    pub name: String,
    pub parent_id: i64,
    pub own_facet: String,
    pub parent_facet: String,
}

/// 环边（断开最后一条边即可修复）。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CycleEdge {
    pub id: i64,
    pub name: String,
    pub parent_id: Option<i64>,
}

/// tag_terms.facet_key 与 tags.facet_key 不一致（V22b 首次迁移时为空；后续 apply 时查）。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FacetMismatch {
    pub tag_id: i64,
    pub tag_name: String,
    pub terms_facet: String,
    pub tag_facet: String,
}

/// V22b 预检结果汇总。conflicts.is_empty() 才允许启用 tag_unique_terms 等约束。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TagConflictReport {
    pub term_conflicts: Vec<TermConflictGroup>,
    pub orphans: Vec<OrphanTag>,
    pub cross_facet_children: Vec<CrossFacetChild>,
    pub cycle_edges: Vec<CycleEdge>,
    pub over_deep_subtrees: Vec<i64>,
    pub facet_mismatches: Vec<FacetMismatch>,
}

impl TagConflictReport {
    /// 是否零冲突（干净库 = 没有需要人工处理的 term 冲突；自动可修项也并入判断：
    /// V22b 只在「无任何冲突」时直接启用 —— 有自动可修项也应让用户先知情）。
    pub fn is_clean(&self) -> bool {
        self.term_conflicts.is_empty()
            && self.orphans.is_empty()
            && self.cross_facet_children.is_empty()
            && self.cycle_edges.is_empty()
            && self.over_deep_subtrees.is_empty()
            && self.facet_mismatches.is_empty()
    }

    pub fn total(&self) -> usize {
        self.term_conflicts.len()
            + self.orphans.len()
            + self.cross_facet_children.len()
            + self.cycle_edges.len()
            + self.over_deep_subtrees.len()
            + self.facet_mismatches.len()
    }
}

/// F2-a：V22b 前置预检 —— 只读，不修改任何数据。
/// 六类：
///  ① 分面内 term 冲突（规范名↔规范名 / 规范名↔别名 / 别名↔别名，三类都查）
///  ② facet_key 指向不存在分面的孤儿标签
///  ③ 跨分面挂父的标签
///  ④ 环（带深度上限的递归 CTE 探测）
///  ⑤ 超过 8 层的子树
///  ⑥ tag_terms.facet_key 与 tags.facet_key 不一致（首次迁移时为空，后续 apply 时查）
pub fn detect_tag_conflicts(conn: &Connection) -> AppResult<TagConflictReport> {
    // ── ① 分面内 term 冲突：canonical 与可搜别名归一到同一集合，(facet_key, term)
    //    出现 ≥2 个不同标签即冲突（ux_terms 唯一索引的前置检查）──
    let term_conflicts: Vec<TermConflictGroup> = {
        // 冲突组：(facet_key, term) 至少命中 2 个不同标签
        let mut group_stmt = conn.prepare(
            "SELECT facet_key, term FROM (
               SELECT t.facet_key, COALESCE(t.normalized_name, lower(trim(t.name))) AS term, t.id
                 FROM tags t WHERE t.status = 'active'
               UNION ALL
               SELECT t.facet_key, ta.normalized_alias, t.id
                 FROM tag_aliases ta JOIN tags t ON t.id = ta.tag_id
                WHERE t.status = 'active' AND ta.is_searchable = 1
             ) GROUP BY facet_key, term
             HAVING COUNT(DISTINCT id) > 1
             ORDER BY facet_key, term",
        )?;
        let groups: Vec<(String, String)> = group_stmt
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
            .filter_map(|r| r.ok())
            .collect();
        let mut out = Vec::new();
        for (facet, term) in groups {
            let mut members: Vec<TermConflictEntry> = Vec::new();
            // canonical 来源
            let mut canonical = conn.prepare(
                "SELECT t.id, t.name,
                        (SELECT COUNT(*) FROM asset_tags at2 WHERE at2.tag_id = t.id)
                   FROM tags t WHERE t.status='active' AND t.facet_key=?1
                     AND COALESCE(t.normalized_name, lower(trim(t.name))) = ?2
                   ORDER BY t.id",
            )?;
            let mut rows = canonical.query(rusqlite::params![facet, term])?;
            while let Some(r) = rows.next()? {
                members.push(TermConflictEntry {
                    tag_id: r.get(0)?,
                    name: r.get(1)?,
                    kind: "canonical".into(),
                    linked_assets: r.get(2)?,
                });
            }
            // alias 来源（同一标签若已以 canonical 计入则不重复）
            let mut alias = conn.prepare(
                "SELECT t.id, t.name,
                        (SELECT COUNT(*) FROM asset_tags at2 WHERE at2.tag_id = t.id)
                   FROM tag_aliases ta JOIN tags t ON t.id = ta.tag_id
                  WHERE t.status='active' AND t.facet_key=?1 AND ta.is_searchable=1
                    AND ta.normalized_alias = ?2
                    AND NOT EXISTS (
                      SELECT 1 FROM tags tc WHERE tc.id = t.id AND tc.status='active'
                        AND COALESCE(tc.normalized_name, lower(trim(tc.name))) = ?2)
                   ORDER BY t.id",
            )?;
            let mut rows = alias.query(rusqlite::params![facet, term])?;
            while let Some(r) = rows.next()? {
                members.push(TermConflictEntry {
                    tag_id: r.get(0)?,
                    name: r.get(1)?,
                    kind: "alias".into(),
                    linked_assets: r.get(2)?,
                });
            }
            if members.len() > 1 {
                out.push(TermConflictGroup { facet_key: facet, term, entries: members });
            }
        }
        out
    };

    // ── ② 孤儿标签：facet_key 指向不存在的分面 ──
    let orphans: Vec<OrphanTag> = {
        let mut stmt = conn.prepare(
            "SELECT t.id, t.name, t.facet_key FROM tags t
              WHERE t.status = 'active'
                AND NOT EXISTS (SELECT 1 FROM tag_facets f WHERE f.key = t.facet_key)
              ORDER BY t.facet_key, t.name",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(OrphanTag { id: r.get(0)?, name: r.get(1)?, facet_key: r.get(2)? })
        })?;
        rows.filter_map(|r| r.ok()).collect()
    };

    // ── ③ 跨分面挂父 ──
    let cross_facet_children: Vec<CrossFacetChild> = {
        let mut stmt = conn.prepare(
            "SELECT t.id, t.name, t.parent_id, t.facet_key, p.facet_key
               FROM tags t JOIN tags p ON p.id = t.parent_id
              WHERE t.status='active' AND t.facet_key != p.facet_key
              ORDER BY t.id",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(CrossFacetChild {
                id: r.get(0)?,
                name: r.get(1)?,
                parent_id: r.get(2)?,
                own_facet: r.get(3)?,
                parent_facet: r.get(4)?,
            })
        })?;
        rows.filter_map(|r| r.ok()).collect()
    };

    // ── ④ 环（深度上限探测）：沿父链 12 步内回到自身即环成员 ──
    let cycle_edges: Vec<CycleEdge> = {
        let mut all = conn.prepare(
            "SELECT id, name, parent_id FROM tags
              WHERE parent_id IS NOT NULL AND status='active'",
        )?;
        let nodes: Vec<(i64, String, Option<i64>)> = all
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
            .filter_map(|r| r.ok())
            .collect();
        let mut out = Vec::new();
        for (id, name, pid) in nodes {
            let mut cur = id;
            let mut is_cycle = false;
            for _ in 0..12 {
                let parent: Option<Option<i64>> = conn
                    .query_row("SELECT parent_id FROM tags WHERE id=?1", [cur], |r| r.get(0))
                    .ok();
                match parent {
                    Some(Some(p)) if p == id => { is_cycle = true; break; }
                    Some(Some(p)) => cur = p,
                    _ => break,
                }
            }
            if is_cycle {
                out.push(CycleEdge { id, name, parent_id: pid });
            }
        }
        out
    };

    // ── ⑤ 深度 ≥ 8 的节点（超深子树成员；从根计 0）──
    let over_deep_subtrees: Vec<i64> = {
        let mut stmt = conn.prepare(
            "WITH RECURSIVE depth(id, d) AS (
               SELECT id, 0 FROM tags WHERE parent_id IS NULL AND status='active'
               UNION ALL
               SELECT t.id, d.d + 1 FROM tags t JOIN depth d ON t.parent_id = d.id
                WHERE t.status='active' AND d.d < 12
             )
             SELECT id FROM depth WHERE d >= 8 ORDER BY id",
        )?;
        let rows = stmt.query_map([], |r| r.get::<_, i64>(0))?;
        rows.filter_map(|r| r.ok()).collect()
    };

    // ── ⑥ tag_terms.facet_key 与 tags.facet_key 不一致（表不存在 → 空）──
    let facet_mismatches: Vec<FacetMismatch> = {
        let table_exists: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='tag_terms'",
                [],
                |r| r.get(0),
            )
            .unwrap_or(0);
        if table_exists == 0 {
            Vec::new()
        } else {
            let mut stmt = conn.prepare(
                "SELECT tt.tag_id, COALESCE(t.name,''), tt.facet_key, t.facet_key
                   FROM tag_terms tt JOIN tags t ON t.id = tt.tag_id
                  WHERE tt.facet_key != t.facet_key
                  ORDER BY tt.tag_id",
            )?;
            let rows = stmt.query_map([], |r| {
                Ok(FacetMismatch {
                    tag_id: r.get(0)?,
                    tag_name: r.get(1)?,
                    terms_facet: r.get(2)?,
                    tag_facet: r.get(3)?,
                })
            })?;
            rows.filter_map(|r| r.ok()).collect()
        }
    };

    Ok(TagConflictReport {
        term_conflicts,
        orphans,
        cross_facet_children,
        cycle_edges,
        over_deep_subtrees,
        facet_mismatches,
    })
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

// ═══════════════ F3：find_by_term 单一入口 + next_prefix（S5 扩展复用） ═══════════════

/// 词匹配模式（F3 定义；S5 在 LeafCond::Tag 上扩展 term_match 复用同一枚举）。
/// `serde(rename_all)` 对齐前端 camelCase 契约。
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum TermMatch {
    /// 规范名精确（term_kind='canonical'）
    Exact,
    /// 规范名或任意别名精确（默认）
    #[default]
    Alias,
    /// 前缀（「青」→「青少年」）
    Prefix,
    /// 包含（「人」→「人物」「单人」「一个人」）
    Contains,
    /// 编辑距离 ≤ 1（「森材」→「森林」）
    Fuzzy,
}

/// F3-b：字典序的「下一个前缀」，作范围查询开区间上界。
/// 不变式：所有以 prefix 开头的字符串 s 都满足 prefix <= s < next_prefix(prefix)。
/// ⚠ 不能用 `prefix + '\u{FFFF}'` —— 实测 UTF-8 下 U+1F600（😀）字节序大于 U+FFFF，
///   会漏掉含 emoji 的标签。遍历字符递增并自动跳过 surrogate。
pub fn next_prefix(prefix: &str) -> Option<String> {
    let mut chars: Vec<char> = prefix.chars().collect();
    while let Some(last) = chars.pop() {
        let mut cp = last as u32 + 1;
        while cp <= 0x10FFFF {
            if let Some(c) = char::from_u32(cp) {
                let mut out: String = chars.iter().collect();
                out.push(c);
                return Some(out);
            }
            cp += 1;
        }
        // 该字符已到顶 → 丢掉它，对前一个字符继续
    }
    None // 空串或全是 char::MAX → 无上界，调用方只用下界
}

/// 分面内按 term 查标签的**唯一入口**（F3-a）。
/// 唯一索引（ux_terms，tag_unique_terms 启用后）保证最多一行 —— 不再需要 ORDER BY 兜底。
/// 消灭四处重复 SQL 与 `ORDER BY id LIMIT 1`：
///   - find_or_create_canonical（mode=Alias）
///   - ai::set_suggestion_tags 的 tag_id 反查（mode=Alias）
///   - ai::final_pairs 反查（mode=Alias）
///   - search_candidates 保留（模糊候选，见 F4 的 SEARCHABLE_TAG）
///
/// F5-d feature gate：tag_unique_terms=1 时读 tag_terms（事实源），=0 时读旧表
/// （tags + tag_aliases）。分支收在本函数一处，上层不自己判断 feature。
pub fn find_by_term(
    conn: &Connection,
    facet_key: &str,
    normalized: &str,
    mode: TermMatch,
) -> AppResult<TermLookup> {
    let terms_enabled =
        crate::db::schema_features::feature_enabled(conn, "tag_unique_terms").unwrap_or(false);
    let mut warnings = Vec::new();
    let mut hits = Vec::new();
    if terms_enabled {
        // tag_terms 事实源：精确/别名/前缀/包含/纠错 由 S5 扩展；F3 先实现精确类
        let kind_filter = match mode {
            TermMatch::Exact => "AND term_kind = 'canonical'",
            TermMatch::Alias => "",
            _ => "", // Prefix/Contains/Fuzzy 在 S5 扩展（需要 next_prefix + 编辑距离）
        };
        let mut stmt = conn.prepare(&format!(
            "SELECT tag_id, term_kind, term FROM tag_terms
              WHERE facet_key = ?1 AND normalized_term = ?2 {kind_filter}
              ORDER BY term_kind = 'canonical' DESC, term_kind, term LIMIT 1"
        ))?;
        let mut rows = stmt.query(rusqlite::params![facet_key, normalized])?;
        if let Some(r) = rows.next()? {
            let tag_id: i64 = r.get(0)?;
            let term_kind: String = r.get(1)?;
            let matched: String = r.get(2)?;
            let status: String = conn
                .query_row(
                    "SELECT COALESCE(status,'active') FROM tags WHERE id=?1",
                    [tag_id],
                    |r| r.get(0),
                )
                .unwrap_or_else(|_| "active".into());
            if term_kind != "canonical" {
                let canonical: Option<String> = conn
                    .query_row(
                        "SELECT name FROM tags WHERE id=?1",
                        [tag_id],
                        |r| r.get(0),
                    )
                    .ok();
                warnings.push(
                    canonical
                        .map(|c| format!("「{matched}」已归入「{c}」"))
                        .unwrap_or_else(|| format!("「{matched}」是别名，已归入其规范标签")),
                );
            }
            hits.push(TermHit {
                tag_id,
                term_kind,
                matched_term: matched,
                tag_status: status,
            });
        }
    } else {
        // 旧表（tags + tag_aliases）。Exact 只查 tags（规范名）；Alias 才并别名
        let sql = if matches!(mode, TermMatch::Exact) {
            "SELECT t.id, 'canonical', t.name, COALESCE(t.status,'active')
               FROM tags t
              WHERE t.facet_key=?1 AND t.status='active' AND t.normalized_name=?2
              ORDER BY t.id LIMIT 1"
        } else {
            "SELECT t.id, 'canonical', t.name, COALESCE(t.status,'active')
               FROM tags t
              WHERE t.facet_key=?1 AND t.status='active' AND t.normalized_name=?2
              UNION ALL
             SELECT t.id, 'alias', ta.alias, COALESCE(t.status,'active')
               FROM tag_aliases ta JOIN tags t ON t.id=ta.tag_id
              WHERE t.facet_key=?1 AND t.status='active' AND ta.is_searchable=1
                AND ta.normalized_alias=?2
              ORDER BY 1 LIMIT 1"
        };
        let mut stmt = conn.prepare(sql)?;
        let mut rows = stmt.query(rusqlite::params![facet_key, normalized])?;
        if let Some(r) = rows.next()? {
            let tag_id: i64 = r.get(0)?;
            let term_kind: String = r.get(1)?;
            let matched: String = r.get(2)?;
            let status: String = r.get(3)?;
            if term_kind != "canonical" {
                let canonical: Option<String> = conn
                    .query_row("SELECT name FROM tags WHERE id=?1", [tag_id], |r| r.get(0))
                    .ok();
                warnings.push(
                    canonical
                        .map(|c| format!("「{matched}」已归入「{c}」"))
                        .unwrap_or_else(|| format!("「{matched}」是别名，已归入其规范标签")),
                );
            }
            hits.push(TermHit {
                tag_id,
                term_kind,
                matched_term: matched,
                tag_status: status,
            });
        }
    }
    if !terms_enabled && (matches!(mode, TermMatch::Prefix | TermMatch::Contains | TermMatch::Fuzzy)) {
        warnings.push("前缀/包含/纠错匹配需先在设置页启用标签约束".into());
    }
    Ok(TermLookup { hits, warnings })
}

/// find_by_term 的返回。
#[derive(Debug, Clone, Default)]
pub struct TermLookup {
    pub hits: Vec<TermHit>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct TermHit {
    pub tag_id: i64,
    /// canonical 时无需提示；别名命中要告知用户
    pub term_kind: String,
    pub matched_term: String,
    /// active / deprecated（deprecated 不该出现，但要能诊断）
    pub tag_status: String,
}
