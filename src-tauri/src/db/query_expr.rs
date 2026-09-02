//! 布尔查询表达式树（超级搜索 UI 构建器 → 数据库查询的桥接）。
//!
//! 现状：`AssetFilter` 是扁平结构（facet/metadata 间隐式 AND，exclude 隐式 NOT），
//! 表达不了 `(A 或 B) 且 非C` 这类嵌套布尔。
//! 本模块引入 `QueryExpr`（And/Or/Not/Leaf），由 `assets::build_where` 递归编译，
//! 叶子直接复用现有白名单能力（facet EXISTS、exclude EXISTS、元数据编译、类型/未打标）。
//!
//! 原则：
//! - 列名/操作符来自白名单匹配，绝对不来自外部输入；
//! - 所有值参数绑定；
//! - 递归深度与节点总数有上限；
//! - 未知字段/操作符一律拒绝，不静默忽略。

use serde::{Deserialize, Serialize};

use rusqlite::types::Value;
use rusqlite::{params_from_iter, Connection, OptionalExtension};

use super::sql_utils::offset_placeholders;
use super::tag_facets::EFF_SEARCH;
use super::tags::TermMatch;
use crate::error::{AppError, AppResult};

/// FB5-05（§8.2/§8.3）：搜索范围。列名只能由本枚举映射，绝不能来自模型或用户字符串。
/// serde camelCase + Default = All（旧数据缺 scope 时按 all 处理）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SearchScope {
    /// 文件名 + 标签 + 描述
    #[default]
    All,
    /// 文件名 + 描述（AI 未映射的具体画面概念使用此范围）
    Content,
    /// 只搜 content_description
    Description,
    /// 只搜 file_name
    FileName,
}

/// 单一叶子条件。字段都带 type 标记，便于前端序列化与校验。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(tag = "type")]
pub enum LeafCond {
    /// 标签分面：facetKey + tagIds，mode any/all，includeDescendants。
    /// S5：termQuery/termMatch —— 显式 tagIds 与按词查可同时存在；词先按 term_match
    /// 扩展成一组 tag_id 与 tagIds 求并集，再走 compile_tag_leaf（编译层零改动）。
    /// 缺省 = Alias（旧数据向后兼容）。
    #[serde(rename_all = "camelCase")]
    Tag {
        #[serde(default)]
        facet_key: String,
        tag_ids: Vec<i64>,
        #[serde(default)]
        mode: Option<String>,
        #[serde(default = "default_true")]
        include_descendants: bool,
        /// 【S5】按词查（AI/搜索框路径）
        #[serde(default)]
        term_query: Option<String>,
        /// 【S5】词查的匹配模式（默认 Alias）
        #[serde(default)]
        term_match: TermMatch,
    },
    /// 排除标签（含后代）
    #[serde(rename_all = "camelCase")]
    ExcludeTag {
        #[serde(default)]
        facet_key: String,
        tag_ids: Vec<i64>,
    },
    /// 素材类型：all | image | video
    AssetType { value: String },
    /// 未打标
    Untagged,
    /// 元数据比较：复用 search_query::MetadataFilter
    #[serde(rename_all = "camelCase")]
    Metadata {
        #[serde(flatten)]
        filter: super::search_query::MetadataFilter,
    },
    /// 关键词（FTS/LIKE）。scope 缺省 = all（旧表达式兼容）。
    Search {
        value: String,
        #[serde(default)]
        scope: SearchScope,
    },
    /// W2-7：分面有任意标签（「场景 有任意标签」—— 打标补漏核心场景）
    #[serde(rename_all = "camelCase")]
    FacetHasAny { facet_key: String },
    /// W2-7：分面没有标签（「场景 没有标签」—— 精准补漏筛选）
    #[serde(rename_all = "camelCase")]
    FacetMissing { facet_key: String },
}

fn default_true() -> bool {
    true
}

/// 布尔表达式树
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(tag = "op")]
pub enum QueryExpr {
    #[serde(rename_all = "camelCase")]
    And { children: Vec<QueryExpr> },
    #[serde(rename_all = "camelCase")]
    Or { children: Vec<QueryExpr> },
    #[serde(rename_all = "camelCase")]
    Not { child: Box<QueryExpr> },
    #[serde(rename_all = "camelCase")]
    Leaf { cond: LeafCond },
}

pub const MAX_DEPTH: usize = 5;
pub const MAX_NODES: usize = 100;

/// 校验表达式树：深度/节点上限 + 叶子合法性。
pub fn validate_expr(expr: &QueryExpr) -> AppResult<()> {
    let mut count = 0;
    validate_node(expr, 0, &mut count)?;
    Ok(())
}

fn validate_node(expr: &QueryExpr, depth: usize, count: &mut usize) -> AppResult<()> {
    if depth > MAX_DEPTH {
        return Err(AppError::msg(format!("表达式嵌套过深（上限 {MAX_DEPTH}）")));
    }
    *count += 1;
    if *count > MAX_NODES {
        return Err(AppError::msg(format!("表达式节点过多（上限 {MAX_NODES}）")));
    }
    match expr {
        QueryExpr::And { children } | QueryExpr::Or { children } => {
            if children.is_empty() {
                return Err(AppError::msg("且/或 分组不能为空"));
            }
            for c in children {
                validate_node(c, depth + 1, count)?;
            }
        }
        QueryExpr::Not { child } => validate_node(child, depth + 1, count)?,
        QueryExpr::Leaf { cond } => validate_leaf(cond)?,
    }
    Ok(())
}

fn validate_leaf(cond: &LeafCond) -> AppResult<()> {
    match cond {
        LeafCond::Tag { tag_ids, mode, .. } => {
            if tag_ids.is_empty() {
                return Err(AppError::msg("标签条件不能为空"));
            }
            if let Some(m) = mode {
                if !matches!(m.as_str(), "any" | "all") {
                    return Err(AppError::msg(format!("非法标签 mode：{m}")));
                }
            }
            Ok(())
        }
        LeafCond::ExcludeTag { tag_ids, .. } => {
            if tag_ids.is_empty() {
                return Err(AppError::msg("排除标签条件不能为空"));
            }
            Ok(())
        }
        LeafCond::AssetType { value } => {
            if !matches!(value.as_str(), "all" | "image" | "video") {
                return Err(AppError::msg(format!("非法 assetType：{value}")));
            }
            Ok(())
        }
        LeafCond::Untagged => Ok(()),
        LeafCond::Metadata { filter } => super::search_query::compile_metadata(filter).map(|_| ()),
        LeafCond::Search { value, .. } => {
            if value.chars().count() > 200 {
                return Err(AppError::msg("搜索关键词过长"));
            }
            Ok(())
        }
        LeafCond::FacetHasAny { facet_key } | LeafCond::FacetMissing { facet_key } => {
            if facet_key.trim().is_empty() {
                return Err(AppError::msg("分面 key 不能为空"));
            }
            Ok(())
        }
    }
}

/// 将扁平 `AssetFilter` 拍平为一棵合规的 `QueryExpr`（多组 AND + 若干 NOT），
/// 供统一走 expr 路径或前端回填构建器使用。
pub fn from_filter(
    search: Option<&str>,
    asset_type: Option<&str>,
    untagged_only: bool,
    facet_filters: &[super::assets::FacetTagFilter],
    exclude_tag_ids: &[i64],
    metadata_filters: &[super::search_query::MetadataFilter],
) -> QueryExpr {
    let mut leaves = Vec::new();
    if let Some(s) = search {
        if !s.trim().is_empty() {
            leaves.push(QueryExpr::Leaf {
                cond: LeafCond::Search {
                    value: s.to_string(),
                    scope: SearchScope::All,
                },
            });
        }
    }
    if let Some(t) = asset_type {
        if !t.is_empty() && t != "all" {
            leaves.push(QueryExpr::Leaf {
                cond: LeafCond::AssetType {
                    value: t.to_string(),
                },
            });
        }
    }
    if untagged_only {
        leaves.push(QueryExpr::Leaf {
            cond: LeafCond::Untagged,
        });
    }
    for f in facet_filters {
        if f.tag_ids.is_empty() {
            continue;
        }
        leaves.push(QueryExpr::Leaf {
            cond: LeafCond::Tag {
                term_query: None,
                term_match: Default::default(),
                facet_key: f.facet_key.clone(),
                tag_ids: f.tag_ids.clone(),
                mode: f.mode.clone(),
                include_descendants: f.include_descendants,
            },
        });
    }
    for &tid in exclude_tag_ids {
        leaves.push(QueryExpr::Leaf {
            cond: LeafCond::ExcludeTag {
                facet_key: String::new(),
                tag_ids: vec![tid],
            },
        });
    }
    for m in metadata_filters {
        leaves.push(QueryExpr::Leaf {
            cond: LeafCond::Metadata { filter: m.clone() },
        });
    }
    if leaves.len() == 1 {
        leaves.into_iter().next().unwrap()
    } else {
        QueryExpr::And { children: leaves }
    }
}

/// 编译叶子为可嵌入 WHERE 的片段。素材表别名为 `a`；无搜索时 conn 仅用于 FTS 谓词。
/// 返回的 SQL 使用从 ?1 起的占位符（与单独编译一致，由上层 offset）。
pub fn compile_leaf(conn: &Connection, cond: &LeafCond) -> AppResult<(String, Vec<Value>)> {
    match cond {
        LeafCond::Search { value, scope } => {
            let pred = super::search::build_search_predicate(conn, value, *scope)?
                .unwrap_or_else(|| super::search::SearchPredicate::empty());
            let sql = if pred.sql.is_empty() {
                "1=0".to_string()
            } else {
                pred.sql
            };
            Ok((sql, pred.params))
        }
        LeafCond::AssetType { value } => {
            let sql = match value.as_str() {
                "image" => "a.mime_type LIKE 'image/%'".to_string(),
                "video" => "a.mime_type LIKE 'video/%'".to_string(),
                _ => "1=1".to_string(),
            };
            Ok((sql, Vec::new()))
        }
        LeafCond::Untagged => Ok((
            "NOT EXISTS (SELECT 1 FROM asset_tags at WHERE at.asset_id = a.id)".to_string(),
            Vec::new(),
        )),
        LeafCond::Tag {
            facet_key,
            tag_ids,
            mode,
            include_descendants,
            term_query,
            term_match,
        } => {
            // W2-6：facet 一致性校验改为「剔除 + warning，不报错整次查询」。
            // 旧语义（一个标签跨分面就拒绝整次查询）在分面删除/重建后会卡死已保存的搜索。
            let valid_ids = filter_tags_by_facet(conn, facet_key, tag_ids);
            let mut ids = valid_ids;
            // S5：termQuery 先按 term_match 扩展成一组 tag_id，与显式 tag_ids 求并集
            let has_term = term_query.as_deref().map(str::trim).map_or(false, |s| !s.is_empty());
            if has_term {
                let raw = term_query.as_deref().unwrap_or("").trim();
                let normalized = super::tags::normalize_name(raw);
                let cap = match term_match {
                    TermMatch::Prefix => super::tags::PREFIX_EXPAND_CAP,
                    TermMatch::Contains => super::tags::CONTAINS_EXPAND_CAP,
                    TermMatch::Fuzzy => super::tags::FUZZY_EXPAND_CAP,
                    _ => 1,
                };
                let (hits, warns) =
                    super::tags::expand_term_query(conn, facet_key, &normalized, *term_match, cap)?;
                for h in &hits {
                    if !ids.contains(&h.tag_id) {
                        ids.push(h.tag_id);
                    }
                }
                for w in &warns {
                    // R2-1 起经 &mut Vec<String> 回传前端；目前落日志
                    tracing::warn!("词查「{raw}」({term_match:?}): {w}");
                }
                if ids.is_empty() {
                    // 词查明确但一个都没命中 → 条件不可满足（0 结果），
                    // 区别于「空 tag_ids = 无约束恒真」——搜索框零结果由此给出
                    return Ok(("1=0".to_string(), Vec::new()));
                }
            } else if ids.is_empty() {
                return Ok(("1=1".to_string(), Vec::new()));
            }
            compile_tag_leaf(&ids, mode.as_deref(), *include_descendants)
        }
        LeafCond::FacetHasAny { facet_key } => {
            if !facet_searchable(conn, facet_key) {
                tracing::warn!("分面 {facet_key} 不存在或 cfg_searchable=0，剔除该条件（查询继续）");
                return Ok(("1=1".to_string(), Vec::new()));
            }
            Ok((
                "EXISTS (SELECT 1 FROM asset_tags at2 JOIN tags t2 ON t2.id = at2.tag_id
                  WHERE at2.asset_id = a.id AND t2.facet_key = ?1 AND t2.status = 'active')"
                    .to_string(),
                vec![Value::Text(facet_key.clone())],
            ))
        }
        LeafCond::FacetMissing { facet_key } => {
            if !facet_searchable(conn, facet_key) {
                tracing::warn!("分面 {facet_key} 不存在或 cfg_searchable=0，剔除该条件（查询继续）");
                return Ok(("1=1".to_string(), Vec::new()));
            }
            Ok((
                "NOT EXISTS (SELECT 1 FROM asset_tags at3 JOIN tags t3 ON t3.id = at3.tag_id
                  WHERE at3.asset_id = a.id AND t3.facet_key = ?1 AND t3.status = 'active')"
                    .to_string(),
                vec![Value::Text(facet_key.clone())],
            ))
        }
        LeafCond::ExcludeTag { tag_ids, .. } => {
            let mut sql = String::new();
            let mut params: Vec<Value> = Vec::new();
            for &tid in tag_ids {
                params.push(tid.into());
                // F1-d：后代递归 CTE 加 d < 12 上限
                sql.push_str(&format!(
                    " AND NOT EXISTS (SELECT 1 FROM asset_tags ate WHERE ate.asset_id=a.id AND ate.tag_id IN (
                        WITH RECURSIVE sub(id, d) AS (SELECT ?{}, 0 UNION ALL SELECT t.id, s.d + 1 FROM tags t JOIN sub s ON t.parent_id=s.id WHERE s.d < 12)
                        SELECT id FROM sub))", params.len()
                ));
            }
            Ok((sql.trim_start_matches(" AND ").to_string(), params))
        }
        LeafCond::Metadata { filter } => {
            let compiled = super::search_query::compile_metadata(filter)?;
            match compiled {
                Some(c) => Ok((c.sql, c.params)),
                None => Ok(("1=1".to_string(), Vec::new())),
            }
        }
    }
}

/// W2-6：Tag 叶子的 facet 一致性过滤 —— 不属于声明 facet_key 的 tag_id 直接剔除并 warning，
/// 不再报错整次查询（分面删除/重建后，已保存的搜索不应被一个失效 tag_id 卡死）。
/// 全部剔除时返回空 Vec，compile_leaf 侧折叠为 1=1（条件恒真，查询继续）。
fn filter_tags_by_facet(conn: &Connection, facet_key: &str, tag_ids: &[i64]) -> Vec<i64> {
    if facet_key.is_empty() {
        return tag_ids.to_vec();
    }
    let placeholders = tag_ids.iter().map(|_| "?").collect::<Vec<_>>().join(",");
    if placeholders.is_empty() {
        return Vec::new();
    }
    let mut vals: Vec<Value> = vec![Value::Text(facet_key.to_string())];
    for &t in tag_ids {
        vals.push(Value::Integer(t));
    }
    let mut valid: Vec<i64> = Vec::new();
    if let Ok(mut stmt) = conn.prepare(&format!(
        "SELECT id FROM tags WHERE facet_key = ? AND id IN ({placeholders})"
    )) {
        if let Ok(rows) = stmt.query_map(params_from_iter(vals), |r| r.get::<_, i64>(0)) {
            valid.extend(rows.filter_map(|r| r.ok()));
        }
    }
    let dropped = tag_ids.len() - valid.len();
    if dropped > 0 {
        tracing::warn!("剔除 {dropped} 个不属于分面 {facet_key} 的标签（查询继续）");
    }
    valid
}

/// W2-7 + F4：FacetHasAny / FacetMissing 的分面可搜性校验（编译期剔除，区别于 Tag 的剔除策略）。
/// 分面不存在或 cfg_searchable=0 时 warning + 整叶剔除（1=1），不再报错整次查询
/// （与 W2-6 一致：分面删除/重建后已保存的搜索不应被卡死）。
fn facet_searchable(conn: &Connection, facet_key: &str) -> bool {
    let searchable: Option<i64> = conn
        .query_row(
            &format!(
                "SELECT 1 FROM tag_facets f WHERE f.key = ?1 AND {EFF_SEARCH}"
            ),
            [facet_key],
            |r| r.get(0),
        )
        .optional()
        .unwrap_or(None);
    searchable.is_some()
}

/// 标签叶子（含后代/any-all），复用 build_where 的 EXISTS 形态。
fn compile_tag_leaf(
    tag_ids: &[i64],
    mode: Option<&str>,
    include_descendants: bool,
) -> AppResult<(String, Vec<Value>)> {
    let all_mode = mode == Some("all");
    let mut params: Vec<Value> = Vec::new();
    if all_mode {
        // all：每个标签各一条 EXISTS，AND 连接（防 JOIN 行数爆炸）
        let mut ands = String::new();
        for &tid in tag_ids {
            params.push(tid.into());
            if !ands.is_empty() {
                ands.push_str(" AND ");
            }
            if include_descendants {
                ands.push_str(&format!(
                    "EXISTS (SELECT 1 FROM asset_tags atf WHERE atf.asset_id=a.id AND atf.tag_id IN (
                        WITH RECURSIVE sub(id, d) AS (SELECT ?{} , 0 UNION ALL SELECT t.id, s.d + 1 FROM tags t JOIN sub s ON t.parent_id=s.id WHERE s.d < 12)
                        SELECT id FROM sub))", params.len()
                ));
            } else {
                ands.push_str(&format!(
                    "EXISTS (SELECT 1 FROM asset_tags atf WHERE atf.asset_id=a.id AND atf.tag_id=?{})",
                    params.len()
                ));
            }
        }
        Ok((ands, params))
    } else if include_descendants {
        // any + 后代：多 seed 合一条 EXISTS
        let mut seeds = String::new();
        for &tid in tag_ids {
            params.push(tid.into());
            if !seeds.is_empty() {
                seeds.push_str(" UNION ALL");
            }
            seeds.push_str(&format!(" SELECT ?{}, 0", params.len()));
        }
        Ok((
            format!(
                "EXISTS (SELECT 1 FROM asset_tags atf WHERE atf.asset_id=a.id AND atf.tag_id IN (
                    WITH RECURSIVE sub(id, d) AS ({seeds} UNION ALL SELECT t.id, s.d + 1 FROM tags t JOIN sub s ON t.parent_id=s.id WHERE s.d < 12)
                    SELECT id FROM sub))"
            ),
            params,
        ))
    } else {
        // any + 不含后代：tag_id IN (直接 id)
        let placeholders = tag_ids
            .iter()
            .map(|tid| {
                params.push((*tid).into());
                format!("?{}", params.len())
            })
            .collect::<Vec<_>>()
            .join(",");
        Ok((
            format!(
                "EXISTS (SELECT 1 FROM asset_tags atf WHERE atf.asset_id=a.id AND atf.tag_id IN ({placeholders}))"
            ),
            params,
        ))
    }
}

/// FB5-05（§9.5.6）：统一归一化——空组删除、单子节点组折叠、连续相同 AND/OR 扁平化、
/// 重复 leaf 去重。返回 None 表示整树无有效条件（调用方置 expr=None，不创建空 AND）。
pub fn normalize_expr(expr: QueryExpr) -> Option<QueryExpr> {
    match expr {
        QueryExpr::Leaf { cond } => Some(QueryExpr::Leaf { cond }),
        QueryExpr::And { children } => normalize_group(children, true),
        QueryExpr::Or { children } => normalize_group(children, false),
        QueryExpr::Not { child } => {
            normalize_expr(*child).map(|c| QueryExpr::Not { child: Box::new(c) })
        }
    }
}

fn normalize_group(children: Vec<QueryExpr>, is_and: bool) -> Option<QueryExpr> {
    let mut out: Vec<QueryExpr> = Vec::new();
    for c in children {
        let Some(norm) = normalize_expr(c) else {
            continue; // 空组删除
        };
        match norm {
            // 连续相同节点扁平化
            QueryExpr::And { children: subs } if is_and => out.extend(subs),
            QueryExpr::Or { children: subs } if !is_and => out.extend(subs),
            other => out.push(other),
        }
    }
    // 重复 leaf 去重（序列化比较，稳定）
    let mut seen = std::collections::HashSet::new();
    out.retain(|e| {
        let key = serde_json::to_string(e).unwrap_or_default();
        seen.insert(key)
    });
    match out.len() {
        0 => None,
        1 => out.into_iter().next(),
        _ => Some(if is_and {
            QueryExpr::And { children: out }
        } else {
            QueryExpr::Or { children: out }
        }),
    }
}

/// 递归编译表达式树 → 可嵌入 WHERE 的片段。同样从 ?1 起占位（供上层 offset）。
pub fn compile_expr(conn: &Connection, expr: &QueryExpr) -> AppResult<(String, Vec<Value>)> {
    match expr {
        QueryExpr::Leaf { cond } => compile_leaf(conn, cond),
        QueryExpr::And { children } => compile_group(conn, children, "AND"),
        QueryExpr::Or { children } => compile_group(conn, children, "OR"),
        QueryExpr::Not { child } => {
            let (sql, params) = compile_expr(conn, child)?;
            Ok((format!("NOT ({sql})"), params))
        }
    }
}

fn compile_group(
    conn: &Connection,
    children: &[QueryExpr],
    joiner: &str,
) -> AppResult<(String, Vec<Value>)> {
    let mut parts = Vec::new();
    let mut params: Vec<Value> = Vec::new();
    for c in children {
        let (sql, p) = compile_expr(conn, c)?;
        let shifted = offset_placeholders(&sql, params.len());
        parts.push(format!("({shifted})"));
        params.extend(p);
    }
    let combined = parts.join(&format!(" {joiner} "));
    Ok((combined, params))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::init_memory;

    #[test]
    fn validates_nested_and_or_not() {
        let expr = QueryExpr::And {
            children: vec![
                QueryExpr::Leaf {
                    cond: LeafCond::Untagged,
                },
                QueryExpr::Or {
                    children: vec![
                        QueryExpr::Leaf {
                            cond: LeafCond::AssetType {
                                value: "image".into(),
                            },
                        },
                        QueryExpr::Not {
                            child: Box::new(QueryExpr::Leaf {
                                cond: LeafCond::ExcludeTag {
                                    facet_key: String::new(),
                                    tag_ids: vec![9],
                                },
                            }),
                        },
                    ],
                },
            ],
        };
        assert!(validate_expr(&expr).is_ok());
    }

    #[test]
    fn rejects_empty_group() {
        let expr = QueryExpr::Or { children: vec![] };
        assert!(validate_expr(&expr).is_err());
    }

    #[test]
    fn rejects_bad_asset_type() {
        let expr = QueryExpr::Leaf {
            cond: LeafCond::AssetType {
                value: "banana".into(),
            },
        };
        assert!(validate_expr(&expr).is_err());
    }

    #[test]
    fn rejects_bad_metadata_key() {
        let expr = QueryExpr::Leaf {
            cond: LeafCond::Metadata {
                filter: crate::db::search_query::MetadataFilter {
                    key: "nope".into(),
                    op: "eq".into(),
                    value: Some(serde_json::json!("x")),
                    values: None,
                    min: None,
                    max: None,
                },
            },
        };
        assert!(validate_expr(&expr).is_err());
    }

    #[test]
    fn rejects_too_deep() {
        let mut expr = QueryExpr::Leaf {
            cond: LeafCond::Untagged,
        };
        for _ in 0..8 {
            expr = QueryExpr::Not {
                child: Box::new(expr),
            };
        }
        assert!(validate_expr(&expr).is_err());
    }

    #[test]
    fn compiles_flat_expr_and_shifts_params() {
        let conn = init_memory().unwrap();
        let expr = QueryExpr::And {
            children: vec![
                QueryExpr::Leaf {
                    cond: LeafCond::Tag {
                        term_query: None,
                        term_match: Default::default(),
                        facet_key: "scene".into(),
                        tag_ids: vec![1, 2],
                        mode: Some("any".into()),
                        include_descendants: true,
                    },
                },
                QueryExpr::Leaf {
                    cond: LeafCond::Metadata {
                        filter: crate::db::search_query::MetadataFilter {
                            key: "file_size".into(),
                            op: "gte".into(),
                            value: Some(serde_json::json!(5242880)),
                            values: None,
                            min: None,
                            max: None,
                        },
                    },
                },
            ],
        };
        // W2-6：tag_ids 需真实存在于声明分面（不存在会被剔除+折叠 1=1）——先造标签
        conn.execute(
            "INSERT INTO tags (name, normalized_name, canonical_name, facet_key, is_system, status, sort_order)
             VALUES ('海边', '海边', '海边', 'scene', 0, 'active', 0)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO tags (name, normalized_name, canonical_name, facet_key, is_system, status, sort_order)
             VALUES ('日落', '日落', '日落', 'scene', 0, 'active', 1)",
            [],
        )
        .unwrap();
        let (sql, params) = compile_expr(&conn, &expr).unwrap();
        assert!(sql.contains("EXISTS"));
        assert!(sql.contains(">="));
        assert!(params.len() >= 3);
        // 两次编译结果一致（参数偏移稳定）
        let (sql2, params2) = compile_expr(&conn, &expr).unwrap();
        assert_eq!(sql, sql2);
        assert_eq!(params.len(), params2.len());
    }

    #[test]
    fn unknown_facet_dropped_not_error_not_silent() {
        // W2-6：未知 facet（或标签不属于声明分面）→ 剔除 + warning，查询继续（1=1），
        // 不再报错整次查询（旧行为会卡死分面删除后已保存的搜索）
        let conn = init_memory().unwrap();
        let expr = QueryExpr::Leaf {
            cond: LeafCond::Tag {
                term_query: None,
                term_match: Default::default(),
                facet_key: "nonexistent_facet".into(),
                tag_ids: vec![1],
                mode: Some("any".into()),
                include_descendants: true,
            },
        };
        let (sql, params) = compile_expr(&conn, &expr).unwrap();
        assert_eq!(sql, "1=1", "剔除后折叠为恒真");
        assert!(params.is_empty());
    }

    #[test]
    fn tag_belonging_to_wrong_facet_is_dropped() {
        let conn = init_memory().unwrap();
        // 造一个在 scene 分面下的标签
        conn.execute(
            "INSERT INTO tags (name, normalized_name, canonical_name, facet_key, is_system, status, sort_order)
             VALUES ('海边', '海边', '海边', 'scene', 0, 'active', 0)",
            [],
        )
        .unwrap();
        // W2-6：声明为 color 分面但 tag 属于 scene → 剔除该 tag（warning），折叠 1=1
        let expr = QueryExpr::Leaf {
            cond: LeafCond::Tag {
                term_query: None,
                term_match: Default::default(),
                facet_key: "color".into(),
                tag_ids: vec![1],
                mode: Some("any".into()),
                include_descendants: false,
            },
        };
        let (sql, params) = compile_expr(&conn, &expr).unwrap();
        assert_eq!(sql, "1=1", "剔除后折叠为恒真");
        assert!(params.is_empty());
    }

    #[test]
    fn accepts_tag_belonging_to_declared_facet() {
        let conn = init_memory().unwrap();
        conn.execute(
            "INSERT INTO tags (name, normalized_name, canonical_name, facet_key, is_system, status, sort_order)
             VALUES ('海边', '海边', '海边', 'scene', 0, 'active', 0)",
            [],
        )
        .unwrap();
        let expr = QueryExpr::Leaf {
            cond: LeafCond::Tag {
                term_query: None,
                term_match: Default::default(),
                facet_key: "scene".into(),
                tag_ids: vec![1],
                mode: Some("any".into()),
                include_descendants: false,
            },
        };
        let (sql, _) = compile_expr(&conn, &expr).unwrap();
        assert!(sql.contains("EXISTS"));
    }

    #[test]
    fn from_filter_builds_and_root() {
        let expr = from_filter(
            Some("海边"),
            Some("image"),
            false,
            &[crate::db::assets::FacetTagFilter {
                facet_key: "scene".into(),
                tag_ids: vec![8],
                mode: Some("any".into()),
                include_descendants: true,
            }],
            &[44],
            &[],
        );
        match expr {
            QueryExpr::And { children } => assert!(children.len() >= 4),
            _ => panic!("应组装为 AND"),
        }
    }
}
