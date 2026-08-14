//! 搜索路由策略（fix-plan-2026-08-14 BUG-A/B/D 查询侧）：
//! - ≤2 字：LIKE 子串兜底（转义 % _ \，标签名走 EXISTS 子查询）
//! - 含非 CJK 字符且 >2 字（BUG-A/B）：FTS 短语 ∪ LIKE 子串并集，保证子串语义
//!   （FTS 命中 token 整词/跨标签边界；LIKE 命中 token 内部子串，取并集才完整）
//! - 纯 CJK ≥4 字（BUG-D）：2 字块 AND，顺序无关（只要各 2 字块在索引中各自相邻即命中）
//! - 纯 CJK 3 字：FTS 短语（防误命中，如「上海湖」不命中「上海公园湖边」）
//!
//! 关键约束（架构 v1.3 §1.5，均有实测依据）：
//! - 短语必须加双引号，否则空格被当 AND，「海边」会误命中「上海…湖边」；
//! - LIKE 需转义 % _ \，标签名走 EXISTS 子查询避免 N+1。

use std::collections::HashSet;

use rusqlite::Connection;

use crate::error::AppResult;
use crate::utils::bigram::{cjk_bigram, is_cjk};

pub fn search_asset_ids(conn: &Connection, raw: &str) -> AppResult<Vec<i64>> {
    let q = raw.trim().to_lowercase();
    if q.is_empty() {
        return Ok(Vec::new());
    }
    let n = q.chars().count();
    if n <= 2 {
        return like_search(conn, &q);
    }
    // 含非 CJK（ASCII 字母/数字/符号）→ FTS ∪ LIKE 并集（BUG-A/B 子串语义）
    if q.chars().any(|c| !is_cjk(c)) {
        let fts_ids = fts_search(conn, &q)?;
        let like_ids = like_search(conn, &q)?;
        return Ok(union_dedup(fts_ids, like_ids));
    }
    // 纯 CJK ≥4 字 → 2 字块 AND，顺序无关（BUG-D）
    if n >= 4 {
        return fts_search_chunk_and(conn, &q);
    }
    // 纯 CJK 3 字 → 短语（防误命中，如「上海湖」不命中「上海公园湖边」）
    fts_search(conn, &q)
}

/// FTS5 短语匹配（整串相邻）：作精确层，命中 token 完整相等且相邻的资产
fn fts_search(conn: &Connection, q: &str) -> AppResult<Vec<i64>> {
    let expanded = cjk_bigram(q);
    let phrase = format!("\"{}\"", expanded.replace('"', "\"\""));
    let mut stmt =
        conn.prepare("SELECT rowid FROM assets_fts WHERE assets_fts MATCH ?1")?;
    let ids = stmt
        .query_map([phrase], |r| r.get(0))?
        .collect::<Result<Vec<i64>, _>>()?;
    Ok(ids)
}

/// 纯 CJK ≥4 字：按 2 字切块，每块经 cjk_bigram 成「字 字」短语，块间 AND。
/// 顺序无关：各 2 字块只需在索引中各自相邻出现（块间不要求相邻/同序）即命中。
/// 例：`海边日落` → `"海 边" AND "日 落"`；标签顺序「日落 海边」与「海边 日落」均命中。
fn fts_search_chunk_and(conn: &Connection, q: &str) -> AppResult<Vec<i64>> {
    let chars: Vec<char> = q.chars().collect();
    let mut chunks: Vec<String> = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        if i + 1 < chars.len() {
            // 2 字块经 cjk_bigram 后为「字 字」（与索引写入侧同一切分）
            let pair: String = chars[i..i + 2].iter().collect();
            chunks.push(cjk_bigram(&pair));
            i += 2;
        } else {
            // 单字余数独立成块
            chunks.push(chars[i].to_string());
            i += 1;
        }
    }
    let query = chunks
        .iter()
        .map(|c| format!("\"{}\"", c.replace('"', "\"\"")))
        .collect::<Vec<_>>()
        .join(" AND ");
    let mut stmt =
        conn.prepare("SELECT rowid FROM assets_fts WHERE assets_fts MATCH ?1")?;
    let ids = stmt
        .query_map([query], |r| r.get(0))?
        .collect::<Result<Vec<i64>, _>>()?;
    Ok(ids)
}

fn like_search(conn: &Connection, q: &str) -> AppResult<Vec<i64>> {
    let escaped = q.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_");
    let pattern = format!("%{escaped}%");
    let mut stmt = conn.prepare(
        "SELECT a.id FROM assets a
          WHERE a.file_name LIKE ?1 ESCAPE '\\'
             OR EXISTS (SELECT 1 FROM asset_tags at JOIN tags t ON t.id = at.tag_id
                         WHERE at.asset_id = a.id AND t.name LIKE ?1 ESCAPE '\\')
          ORDER BY a.created_at DESC",
    )?;
    let ids = stmt
        .query_map([pattern], |r| r.get(0))?
        .collect::<Result<Vec<i64>, _>>()?;
    Ok(ids)
}

/// 两路结果并集去重（顺序不重要：assets::list 拿到 id 后自行 ORDER BY created_at DESC, id DESC）
fn union_dedup(a: Vec<i64>, b: Vec<i64>) -> Vec<i64> {
    let mut seen = HashSet::with_capacity(a.len() + b.len());
    let mut out = Vec::with_capacity(a.len() + b.len());
    for v in a.into_iter().chain(b) {
        if seen.insert(v) {
            out.push(v);
        }
    }
    out
}
