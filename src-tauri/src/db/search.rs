//! 搜索路由策略（fix-plan-2026-08-14 BUG-A/B/D 查询侧，超级搜索 P1A 改造为库内组合）：
//! - ≤2 字：LIKE 子串兜底（转义 % _ \，标签名走 EXISTS 子查询）
//! - 含非 CJK 字符且 >2 字（BUG-A/B）：FTS 短语 ∪ LIKE 子串并集，保证子串语义
//!   （FTS 命中 token 整词/跨标签边界；LIKE 命中 token 内部子串，取并集才完整）
//! - 纯 CJK ≥4 字（BUG-D）：2 字块 AND，顺序无关（只要各 2 字块在索引中各自相邻即命中）
//! - 纯 CJK 3 字：FTS 短语（防误命中，如「上海湖」不命中「上海公园湖边」）
//!
//! 关键约束（架构 v1.3 §1.5，均有实测依据）：
//! - 短语必须加双引号，否则空格被当 AND，「海边」会误命中「上海…湖边」；
//! - LIKE 需转义 % _ \，标签名走 EXISTS 子查询避免 N+1。
//!
//! P1A 改造：不再把全部命中 ID 拉回 Rust 拼长 IN 列表，而是编译为可嵌入 WHERE 的
//! SQL 谓词（字符串 + 参数），在数据库内与其他条件组合。search_asset_ids 保留为
//! 兼容工具（供既有测试与少量全选场景使用），但不再作为 list / list_ids 的主链路。

use rusqlite::types::Value;
use rusqlite::Connection;

use crate::error::AppResult;
use crate::utils::bigram::{cjk_bigram, is_cjk};

/// 编译好的搜索谓词：可嵌入 WHERE 的 sql 片段 + 位置参数。谓词以 `a` 作为素材表别名。
#[derive(Debug, Clone)]
pub struct SearchPredicate {
    pub sql: String,
    pub params: Vec<Value>,
}

impl SearchPredicate {
    /// 空谓词（无键词时使用），嵌入 WHERE 不产生条件。
    pub fn empty() -> Self {
        Self {
            sql: String::new(),
            params: Vec::new(),
        }
    }
}

/// 将用户关键词编译为一个可嵌入 WHERE 的搜索谓词。返回 None 表示无搜索。
/// 该谓词引用外层素材表别名 `a`，子查询/JOIN 均在其内部完成，避免在 Rust 端拼 ID 列表。
pub fn build_search_predicate(conn: &Connection, raw: &str) -> AppResult<Option<SearchPredicate>> {
    let q = raw.trim().to_lowercase();
    if q.is_empty() {
        return Ok(None);
    }
    let n = q.chars().count();
    if n <= 2 {
        return Ok(Some(like_predicate(&q)));
    }
    // 含非 CJK（ASCII 字母/数字/符号）→ FTS ∪ LIKE 并集（BUG-A/B 子串语义）
    if q.chars().any(|c| !is_cjk(c)) {
        return Ok(Some(union_predicate(conn, &q)?));
    }
    // 纯 CJK ≥4 字 → 2 字块 AND，顺序无关（BUG-D）
    if n >= 4 {
        return Ok(Some(chunk_and_predicate(conn, &q)?));
    }
    // 纯 CJK 3 字 → 短语（防误命中，如「上海湖」不命中「上海公园湖边」）
    Ok(Some(fts_phrase_predicate(conn, &q)?))
}

/// FTS5 短语谓词：整串相邻，作为精确层。
fn fts_phrase_predicate(_conn: &Connection, q: &str) -> AppResult<SearchPredicate> {
    let expanded = cjk_bigram(q);
    let phrase = format!("\"{}\"", expanded.replace('"', "\"\""));
    Ok(SearchPredicate {
        sql: "a.id IN (SELECT rowid FROM assets_fts WHERE assets_fts MATCH ?)".into(),
        params: vec![Value::Text(phrase)],
    })
}

/// 纯 CJK ≥4 字：按 2 字切块，每块经 cjk_bigram 成「字 字」短语，块间 AND。
fn chunk_and_predicate(_conn: &Connection, q: &str) -> AppResult<SearchPredicate> {
    let chars: Vec<char> = q.chars().collect();
    let mut chunks: Vec<String> = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        if i + 1 < chars.len() {
            let pair: String = chars[i..i + 2].iter().collect();
            chunks.push(cjk_bigram(&pair));
            i += 2;
        } else {
            chunks.push(chars[i].to_string());
            i += 1;
        }
    }
    let query = chunks
        .iter()
        .map(|c| format!("\"{}\"", c.replace('"', "\"\"")))
        .collect::<Vec<_>>()
        .join(" AND ");
    Ok(SearchPredicate {
        sql: "a.id IN (SELECT rowid FROM assets_fts WHERE assets_fts MATCH ?)".into(),
        params: vec![Value::Text(query)],
    })
}

/// LIKE 谓词：文件名 + 标签名/别名（EXISTS 子查询避免 N+1）。
fn like_predicate(q: &str) -> SearchPredicate {
    let escaped = q
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_");
    let pattern = format!("%{escaped}%");
    let sql = "(
        a.file_name LIKE ? ESCAPE '\\'
        OR EXISTS (
            SELECT 1 FROM asset_tags at
              JOIN tags t ON t.id = at.tag_id
              LEFT JOIN tag_aliases ta ON ta.tag_id = t.id AND ta.is_searchable = 1
            WHERE at.asset_id = a.id
              AND (t.name LIKE ? ESCAPE '\\' OR ta.alias LIKE ? ESCAPE '\\')
        )
    )"
    .to_string();
    SearchPredicate {
        sql,
        params: vec![
            Value::Text(pattern.clone()),
            Value::Text(pattern.clone()),
            Value::Text(pattern),
        ],
    }
}

/// FTS ∪ LIKE 并集谓词（子串语义）：两条都编译为库内子查询，UNION 由 OR 表达。
fn union_predicate(conn: &Connection, q: &str) -> AppResult<SearchPredicate> {
    let fts = fts_phrase_predicate(conn, q)?;
    let like = like_predicate(q);
    Ok(SearchPredicate {
        sql: format!("({} OR {})", fts.sql, like.sql),
        params: {
            let mut all = fts.params;
            all.extend(like.params);
            all
        },
    })
}

/// 兼容工具：返回当前搜索命中素材 id 列表。
/// 仅供既有测试与少数「全量 id」场景使用；list / list_ids 走 build_search_predicate 库内组合。
pub fn search_asset_ids(conn: &Connection, raw: &str) -> AppResult<Vec<i64>> {
    let Some(pred) = build_search_predicate(conn, raw)? else {
        return Ok(Vec::new());
    };
    let sql = format!("SELECT a.id FROM assets a WHERE {}", pred.sql);
    let mut stmt = conn.prepare(&sql)?;
    let ids = stmt
        .query_map(rusqlite::params_from_iter(pred.params.iter()), |r| r.get(0))?
        .collect::<Result<Vec<i64>, _>>()?;
    Ok(ids)
}
