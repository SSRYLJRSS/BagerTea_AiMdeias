//! S1/S2/S4/S6：SearchPlanV3 —— 硬性过滤 + 硬性排除 + 加权可选（should）+ 版本号 + 多路召回。
//!
//! SQL 编译形态（每个 should 只求值一次，两层派生表）：
//! ```sql
//! SELECT q.id, q.score, q.hits FROM (
//!   SELECT a.id, m1, m2, ...,
//!          (m1*w1 + m2*w2 + ...) AS score,
//!          (m1 + m2 + ...)       AS hits
//!     FROM assets a
//!    WHERE <filter> AND NOT (<must_not>) AND a.deleted_at IS NULL
//! ) q WHERE q.hits >= :min_should
//! ORDER BY score DESC, id DESC
//! ```
//! should 片段与 filter 走**同一套** compile_leaf/compile_expr（零新编译逻辑，
//! 白名单/参数绑定安全自动继承）；权重只影响 score（排序），不影响命中集合。
//!
//! S6 三个版本号单点声明在本模块；plan_schema_version 变更必须写迁移函数。

use rusqlite::types::Value;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};

use super::query_expr::{compile_expr, compile_leaf, validate_expr, LeafCond, QueryExpr};
use super::sql_utils::offset_placeholders;
use super::search_query::ALL_SORT_KEYS;
use crate::error::{AppError, AppResult};

/// S6：plan 结构版本（加/删/改字段语义时 +1，须写 migrate 函数）。
pub const PLAN_SCHEMA_VERSION: u32 = 3;
/// S6：归一化规则版本（规则变了 → 旧 plan 读到先重归一化一次）。
pub const NORMALIZATION_VERSION: u32 = 1;
/// S6：SQL 生成方式版本（每次现算，不持久化，只用于日志排查）。
pub const COMPILER_VERSION: u32 = 1;

fn default_plan_schema_version() -> u32 {
    PLAN_SCHEMA_VERSION
}
fn default_normalization_version() -> u32 {
    NORMALIZATION_VERSION
}
fn default_compiler_version() -> u32 {
    COMPILER_VERSION
}
fn default_weight() -> f32 {
    1.0
}

/// S1：加权可选子句（满足则加分，不满足不淘汰）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShouldClause {
    /// 与 filter 完全同一套叶子条件
    pub cond: LeafCond,
    /// 默认 1.0；UI 只给三档 0.5 / 1.0 / 2.0
    #[serde(default = "default_weight")]
    pub weight: f32,
    /// 给用户看（「蓝天（加分项）」）
    #[serde(default)]
    pub label: String,
}

/// S2：多路召回融合方式。RRF 只用排名（bm25 负值 / should 加分任意正数 不可比，
/// 排名可比）—— 默认；Linear 各路 min-max 归一到 [0,1] 后加权（可选项）。
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum Fusion {
    #[default]
    Rrf,
    Linear,
}

/// S2：排序方式。用户显式选字段时用字段；否则相关度（should 加权 + 检索器融合）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Ranking {
    Field { key: String, dir: String },
    /// should 加权 + retrievers 融合（RRF）。本字段存在 = 走相关度。
    #[serde(rename_all = "camelCase")]
    Relevance {
        #[serde(default)]
        retrievers: RetrieverPlan,
    },
}

/// S4：多路召回计划（S2 默认走 RRF；本波次先用 should 加权一路，Fts/TagAlias S4 填）。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RetrieverPlan {
    #[serde(default)]
    pub retrievers: Vec<WeightedRetriever>,
    #[serde(default)]
    pub fusion: Fusion,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WeightedRetriever {
    pub weight: f32,
    pub kind: Retriever,
}

/// S4：检索器（Fts / TagAlias）。明确不做向量（不建 asset_embeddings、不写 Vector 分支）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(tag = "type")]
pub enum Retriever {
    Fts {
        query: String,
        scope: super::query_expr::SearchScope,
    },
    TagAlias {
        text: String,
        #[serde(default)]
        facet_key: Option<String>,
    },
}

/// S1：完整搜索计划（超级搜索持久化/执行的单一结构）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchPlanV3 {
    #[serde(default = "default_plan_schema_version")]
    pub plan_schema_version: u32,
    #[serde(default = "default_normalization_version")]
    pub normalization_version: u32,
    #[serde(default = "default_compiler_version")]
    pub compiler_version: u32,

    /// 硬性必须满足（沿用现有 QueryExpr，零改动复用全部编译逻辑）
    #[serde(default)]
    pub filter: Option<QueryExpr>,
    /// 硬性排除
    #[serde(default)]
    pub must_not: Option<QueryExpr>,
    /// 加权可选：满足则加分，不满足不淘汰
    #[serde(default)]
    pub should: Vec<ShouldClause>,
    /// 至少命中几条 should 才进结果。
    /// ⚠ filter 为空且 should 非空时**强制 ≥ 1**（否则返回全库）。
    #[serde(default)]
    pub minimum_should_match: u32,
    #[serde(default)]
    pub retrievers: RetrieverPlan,
    pub ranking: Ranking,
}

/// should 条数上限（S1 validate：≤ 12 条）。
pub const MAX_SHOULD_CLAUSES: usize = 12;

impl SearchPlanV3 {
    pub fn field_ranking(key: &str, dir: &str) -> SearchPlanV3 {
        SearchPlanV3 {
            ranking: Ranking::Field { key: key.into(), dir: dir.into() },
            ..Default::default()
        }
    }
}

impl Default for SearchPlanV3 {
    fn default() -> Self {
        Self {
            plan_schema_version: PLAN_SCHEMA_VERSION,
            normalization_version: NORMALIZATION_VERSION,
            compiler_version: COMPILER_VERSION,
            filter: None,
            must_not: None,
            should: Vec::new(),
            minimum_should_match: 0,
            retrievers: RetrieverPlan::default(),
            ranking: Ranking::Field {
                key: "created_at".into(),
                dir: "desc".into(),
            },
        }
    }
}

/// 校验计划：should ≤ 12；filter/must_not 走现有 validate_expr；
/// Field 排序 key 必须在 ALL_SORT_KEYS；should 非空但 min=0 且 filter 为空 → 强制 ≥1。
pub fn validate_search_plan(plan: &SearchPlanV3) -> AppResult<()> {
    if plan.should.len() > MAX_SHOULD_CLAUSES {
        return Err(AppError::msg(format!(
            "加分条件过多（上限 {MAX_SHOULD_CLAUSES} 条）"
        )));
    }
    if plan.should.is_empty() && plan.minimum_should_match > 0 {
        return Err(AppError::msg("没有加分条件时不得要求最低命中数"));
    }
    if let Some(f) = &plan.filter {
        validate_expr(f)?;
    }
    if let Some(m) = &plan.must_not {
        validate_expr(m)?;
    }
    if let Ranking::Field { key, .. } = &plan.ranking {
        if !ALL_SORT_KEYS.contains(&key.as_str()) {
            return Err(AppError::msg(format!("非法排序字段：{key}")));
        }
    }
    Ok(())
}

/// 排序字段 → 资产列表达式（白名单映射，绝不来自外部字符串）。
fn sort_column_sql(key: &str) -> Option<String> {
    let col = match key {
        "created_at" | "taken_at" | "modified_at" => format!("a.{key}"),
        "name" => "a.file_name".to_string(),
        "size" => "a.file_size".to_string(),
        "resolution" => "(a.width * a.height)".to_string(),
        "rating" => "a.rating".to_string(),
        _ => return None,
    };
    Some(col)
}

/// 编译结果：完整 SQL + 顺序参数（?1..?N，可直接 bind）。
#[derive(Debug)]
pub struct CompiledPlan {
    pub sql: String,
    pub params: Vec<Value>,
}

/// 编译 SearchPlanV3 → 两层派生表 SQL（每个 should 只求值一次）。
/// 排序：Relevance → score DESC, id DESC；Field → sortv 升/降 + id DESC（分页稳定）。
pub fn compile_search_plan(conn: &Connection, plan: &SearchPlanV3) -> AppResult<CompiledPlan> {
    validate_search_plan(plan)?;
    // 生效的 min_should：filter 为空且 should 非空 → 至少 1（防返回全库）
    let min_should = {
        let effective = if plan.filter.is_none() && !plan.should.is_empty() {
            plan.minimum_should_match.max(1)
        } else {
            plan.minimum_should_match
        };
        effective as i64
    };
    // 1) 基础 WHERE：filter AND NOT(must_not) AND deleted_at IS NULL
    let mut base_sql = String::new();
    let mut params: Vec<Value> = Vec::new();
    let mut parts: Vec<String> = Vec::new();
    if let Some(f) = &plan.filter {
        let (sql, p) = compile_expr(conn, f)?;
        if !sql.is_empty() {
            parts.push(format!("({})", offset_placeholders(&sql, params.len())));
            params.extend(p);
        }
    }
    if let Some(m) = &plan.must_not {
        let (sql, p) = compile_expr(conn, m)?;
        if !sql.is_empty() {
            parts.push(format!("NOT ({})", offset_placeholders(&sql, params.len())));
            params.extend(p);
        }
    }
    parts.push("a.deleted_at IS NULL".to_string());
    base_sql = parts.join(" AND ");
    if base_sql.is_empty() {
        base_sql = "1=1".to_string();
    }

    // 2) should 标记：每个片段只出现一次（CASE WHEN）
    let mut marker_sql = String::new();
    let mut score_terms: Vec<String> = Vec::new();
    let mut hits_terms: Vec<String> = Vec::new();
    for (i, sc) in plan.should.iter().enumerate() {
        let (frag, p) = compile_leaf(conn, &sc.cond)?;
        let shifted = offset_placeholders(&frag, params.len());
        let m = format!("m{}", i + 1);
        if !marker_sql.is_empty() {
            marker_sql.push_str(", ");
        }
        marker_sql.push_str(&format!("CASE WHEN ({shifted}) THEN 1 ELSE 0 END AS {m}"));
        params.extend(p);
        score_terms.push(format!("{m} * {w}", w = fmt_weight(sc.weight)));
        hits_terms.push(m);
    }
    let score_expr = if score_terms.is_empty() {
        "0.0".to_string()
    } else {
        score_terms.join(" + ")
    };
    let hits_expr = if hits_terms.is_empty() {
        "0".to_string()
    } else {
        hits_terms.join(" + ")
    };

    // 3) 排序：Field → 额外算 sortv（内层）；Relevance → score DESC, id DESC
    let mut order_sql = String::new();
    let mut sortv_keep = String::new();
    let mut sortv_inner = String::new();
    match &plan.ranking {
        Ranking::Relevance { .. } => order_sql = "score DESC, id DESC".to_string(),
        Ranking::Field { key, dir } => {
            let col = sort_column_sql(key)
                .ok_or_else(|| AppError::msg(format!("非法排序字段：{key}")))?;
            sortv_inner = format!(", {col} AS sortv");
            sortv_keep = ", x.sortv AS sortv".to_string();
            let dir = if dir.eq_ignore_ascii_case("asc") { "ASC" } else { "DESC" };
            order_sql = format!("sortv {dir}, id DESC");
        }
    }

    // 4) 组装（三层：内层算 0/1 标记 → 中层算 score/hits → 外层过滤/排序）。
    //    每个 should 片段只在内层出现一次（别名不能在同一个 SELECT 里复用）。
    let inner_sel = if marker_sql.is_empty() {
        format!("SELECT a.id{sortv_inner}\n    FROM assets a\n   WHERE {base_sql}")
    } else {
        format!(
            "SELECT a.id, {marker_sql}{sortv_inner}\n    FROM assets a\n   WHERE {base_sql}"
        )
    };
    let mid_sel = format!(
        "SELECT x.id, {score_expr} AS score, {hits_expr} AS hits{sortv_keep}\n    FROM (\n  {inner_sel}\n) x"
    );
    params.push(Value::Integer(min_should));
    let min_param = params.len();
    let sql = format!(
        "SELECT q.id, q.score, q.hits FROM (\n  {mid_sel}\n) q\n\
         WHERE q.hits >= ?{min_param}\nORDER BY {order_sql}"
    );
    Ok(CompiledPlan { sql, params })
}

fn fmt_weight(w: f32) -> String {
    // 权重打印为可读小数（1.0 → 1.0；0.5 → 0.5；2.0 → 2.0）
    format!("{w}")
}

/// 执行计划：返回 (asset_id, score, hits) 列表。
pub fn run_search_plan(
    conn: &Connection,
    plan: &SearchPlanV3,
    limit: Option<i64>,
    offset: i64,
) -> AppResult<Vec<(i64, f64, f64)>> {
    // S2/S4：Relevance 且配了检索器 → should 加权排序转排名，与各路检索器 RRF 融合
    if matches!(&plan.ranking, Ranking::Relevance { .. })
        && !plan.retrievers.retrievers.is_empty()
    {
        return run_relevance_fused(conn, plan, limit, offset);
    }
    let compiled = compile_search_plan(conn, plan)?;
    let mut sql = compiled.sql.clone();
    let mut params = compiled.params;
    if let Some(l) = limit {
        let li = params.len() + 1;
        params.push(Value::Integer(l.clamp(0, 1000)));
        let oi = params.len() + 1;
        params.push(Value::Integer(offset.max(0)));
        sql.push_str(&format!(" LIMIT ?{li} OFFSET ?{oi}"));
    }
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt
        .query_map(rusqlite::params_from_iter(params.iter()), |r| {
            Ok((r.get::<_, i64>(0)?, r.get::<_, f64>(1)?, r.get::<_, f64>(2)?))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

/// S2/S4：候选集 = filter/must_not/min_should（compile_search_plan 的 WHERE），
/// should 加权分排序成一路排名；各路检索器（Fts bm25 / TagAlias）各成一排名；
/// 全部经 RRF 融合 —— 量纲统一（bm25 负值 / should 加分任意正数 / 别名 0-1 只比排名）。
fn run_relevance_fused(
    conn: &Connection,
    plan: &SearchPlanV3,
    limit: Option<i64>,
    offset: i64,
) -> AppResult<Vec<(i64, f64, f64)>> {
    // ① 候选 + should 相关度顺序（现有 SQL 已按 score DESC, id DESC）
    let compiled = compile_search_plan(conn, plan)?;
    let mut stmt = conn.prepare(&compiled.sql)?;
    let candidates = stmt
        .query_map(rusqlite::params_from_iter(compiled.params.iter()), |r| {
            Ok((r.get::<_, i64>(0)?, r.get::<_, f64>(1)?))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    if candidates.is_empty() {
        return Ok(Vec::new());
    }
    let cand_set: std::collections::HashSet<i64> =
        candidates.iter().map(|(id, _)| *id).collect();
    // ② should 一路 = 候选集按 score 排序的排名
    let should_ranked: Vec<i64> = candidates.iter().map(|(id, _)| *id).collect();
    // ③ 各路检索器排名（各自 ≥0 条）
    let mut lists: Vec<(&[i64], f32)> = Vec::new();
    lists.push((&should_ranked, 1.0));
    let mut owned: Vec<Vec<i64>> = Vec::new();
    for wr in &plan.retrievers.retrievers {
        let ids = run_retriever(conn, &wr.kind)?;
        owned.push(ids);
    }
    for (wr, ids) in plan.retrievers.retrievers.iter().zip(owned.iter()) {
        if !ids.is_empty() {
            lists.push((ids.as_slice(), wr.weight));
        }
    }
    let fused = rrf_fuse(&lists);
    // ④ 结果限制在候选集内（filter 是硬性必须）；分页
    let page: Vec<(i64, f64, f64)> = fused
        .into_iter()
        .filter(|(id, _)| cand_set.contains(id))
        .skip(offset.max(0) as usize)
        .take(limit.map(|l| l.clamp(0, 1000) as usize).unwrap_or(usize::MAX))
        .map(|(id, s)| (id, s, 0.0))
        .collect();
    Ok(page)
}

/// S2：RRF（Reciprocal Rank Fusion）—— `score = Σ w_i / (k + rank_i)`，k=60。
/// 只用排名不用原始分数：bm25 是负值（越小越相关）、should 加分任意正数、
/// 别名命中 0/1 —— 三者的**排名**可比，**分数**不可比，RRF 天然免疫量纲。
pub fn rrf_fuse(lists: &[(&[i64], f32)]) -> Vec<(i64, f64)> {
    let k = 60.0f64;
    let mut acc: std::collections::HashMap<i64, f64> = std::collections::HashMap::new();
    for (ids, w) in lists {
        for (rank, &id) in ids.iter().enumerate() {
            let e = acc.entry(id).or_insert(0.0);
            *e += *w as f64 / (k + rank as f64);
        }
    }
    let mut out: Vec<(i64, f64)> = acc.into_iter().collect();
    out.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal).then_with(|| a.0.cmp(&b.0)));
    out
}

/// S4：执行单路检索器 → 该路按相关度排序的素材 id 列表。
/// - `Fts`：FTS5 bm25 排序（MATCH 词与编译期谓词同一套语义 —— 复用
///   build_search_predicate 的 MATCH 参数，排名用 bm25(assets_fts)；明确不做向量）。
/// - `TagAlias`：经 tag_terms 别名扩展命中 tag（受 F5-d feature gate 控制，
///   关时返回空 + warning）再查素材（≤10 上限语义由调用方在融合前截断）。
pub fn run_retriever(conn: &Connection, r: &Retriever) -> AppResult<Vec<i64>> {
    match r {
        Retriever::Fts { query, scope } => {
            let Some(pred) = super::search::build_search_predicate(conn, query, *scope)? else {
                return Ok(Vec::new());
            };
            let Some(Value::Text(term)) = pred.params.first() else {
                return Ok(Vec::new());
            };
            let mut stmt = conn.prepare(
                "SELECT a.id
                   FROM assets a
                   JOIN (SELECT rowid FROM assets_fts WHERE assets_fts MATCH ?1
                          ORDER BY bm25(assets_fts) LIMIT 200) f ON f.rowid = a.id
                  WHERE a.deleted_at IS NULL",
            )?;
            let rows = stmt
                .query_map([term.as_str()], |r| r.get::<_, i64>(0))?
                .filter_map(|r| r.ok())
                .collect();
            Ok(rows)
        }
        Retriever::TagAlias { text, facet_key } => {
            let terms_enabled =
                crate::db::schema_features::feature_enabled(conn, "tag_unique_terms")
                    .unwrap_or(false);
            if !terms_enabled {
                tracing::warn!("标签别名检索需先在设置页启用标签约束，已跳过该路召回");
                return Ok(Vec::new());
            }
            let facet = facet_key.as_deref().unwrap_or("");
            let normalized = crate::db::tags::normalize_name(text);
            // Alias 单点（canonical/synonym 均命中；cap 1 语义 = 单标签）
            let lookup =
                crate::db::tags::find_by_term(conn, facet, &normalized, crate::db::tags::TermMatch::Alias)?;
            let Some(hit) = lookup.hits.into_iter().next() else {
                return Ok(Vec::new());
            };
            let mut stmt = conn.prepare(
                "SELECT a.id
                   FROM assets a JOIN asset_tags at ON at.asset_id = a.id
                  WHERE at.tag_id = ?1 AND a.deleted_at IS NULL
                  ORDER BY a.id DESC LIMIT 10",
            )?;
            let rows = stmt
                .query_map([hit.tag_id], |r| r.get::<_, i64>(0))?
                .filter_map(|r| r.ok())
                .collect();
            Ok(rows)
        }
    }
}

// ═══════════════ C-2：AST 感知命中诊断（2N+1 次 COUNT） ═══════════════

/// 单个叶子条件的诊断。path = 从根到该叶子的子节点索引路径（OR/AND children 下标）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LeafDiagnostic {
    pub path: Vec<usize>,
    pub label: String,
    /// ① 该条件单独执行的命中数
    pub self_count: i64,
    /// ② 完整表达式的命中数（所有叶子共享同一个值）
    pub result_count: i64,
    /// ③ 把该叶子从 AST 中移除后的命中数
    pub count_without_leaf: i64,
    /// ④ delta = count_without_leaf - result_count
    ///    AND 下为正（砍掉多少）；OR 下为负（贡献多少）；NOT 下反转 —— 唯一三态都有意义的量
    pub delta: i64,
}

/// should（加分项）诊断：不淘汰结果，只显示「命中该加分项的素材数 / 结果总数」。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShouldDiagnostic {
    pub label: String,
    pub hit_count: i64,
    pub total_count: i64,
}

/// 对 SearchPlanV3 做 AST 命中诊断（N 叶子 = 2N+1 次 COUNT；毫秒级）。
/// filter/must_not 叶子进 LeafDiagnostic；should 单独进 ShouldDiagnostic（hits/total）。
pub fn diagnose_search_plan(
    conn: &Connection,
    plan: &SearchPlanV3,
) -> AppResult<(Vec<LeafDiagnostic>, Vec<ShouldDiagnostic>)> {
    let result_count = count_plan(conn, plan)?;
    let mut leaves: Vec<LeafDiagnostic> = Vec::new();
    // filter 树叶子
    if let Some(f) = &plan.filter {
        collect_leaves(conn, plan, f, &[], true, result_count, &mut leaves)?;
    }
    // must_not 树叶子（NOT 语境）
    if let Some(m) = &plan.must_not {
        collect_leaves(conn, plan, m, &[], false, result_count, &mut leaves)?;
    }
    // should 命中/总数
    let mut should_diag = Vec::new();
    for sc in &plan.should {
        let mut solo = SearchPlanV3::default();
        solo.filter = Some(QueryExpr::Leaf { cond: sc.cond.clone() });
        solo.minimum_should_match = 0;
        let hit = count_plan(conn, &solo)?;
        should_diag.push(ShouldDiagnostic {
            label: if sc.label.is_empty() {
                format!("加分项")
            } else {
                sc.label.clone()
            },
            hit_count: hit,
            total_count: result_count,
        });
    }
    Ok((leaves, should_diag))
}

fn count_plan(conn: &Connection, plan: &SearchPlanV3) -> AppResult<i64> {
    let compiled = compile_search_plan(conn, plan)?;
    let sql = format!("SELECT COUNT(*) FROM (\n{}\n) _diag", compiled.sql);
    let n: i64 = conn.query_row(
        &sql,
        rusqlite::params_from_iter(compiled.params.iter()),
        |r| r.get(0),
    )?;
    Ok(n)
}

/// 递归收集叶子。pos = 相对当前树根的路径；ctx_and=true 时叶子在正向 filter（AND/OR 语境），
/// ctx_and=false 表示 must_not（NOT 语境，self_count = 叶子单独命中数，语义与指南表一致）。
fn collect_leaves(
    conn: &Connection,
    plan: &SearchPlanV3,
    node: &QueryExpr,
    prefix: &[usize],
    positive: bool,
    result_count: i64,
    out: &mut Vec<LeafDiagnostic>,
) -> AppResult<()> {
    match node {
        QueryExpr::Leaf { cond } => {
            // self_count：叶子单独执行（在 NOT 语境下也是「该条件本身」的命中数）
            let mut solo = SearchPlanV3::default();
            solo.filter = Some(QueryExpr::Leaf { cond: cond.clone() });
            solo.minimum_should_match = 0;
            let self_count = count_plan(conn, &solo)?;
            // without：从原树移除该叶子（按 prefix 定位）后重算
            let mut variant = plan.clone();
            if positive {
                variant.filter = remove_leaf(variant.filter.as_ref(), prefix);
            } else {
                variant.must_not = remove_leaf(variant.must_not.as_ref(), prefix);
            }
            let without = count_plan(conn, &variant)?;
            let label = cond_label(cond);
            out.push(LeafDiagnostic {
                path: prefix.to_vec(),
                label,
                self_count,
                result_count,
                count_without_leaf: without,
                delta: without - result_count,
            });
            Ok(())
        }
        QueryExpr::And { children } | QueryExpr::Or { children } => {
            for (i, c) in children.iter().enumerate() {
                let mut p = prefix.to_vec();
                p.push(i);
                collect_leaves(conn, plan, c, &p, positive, result_count, out)?;
            }
            Ok(())
        }
        QueryExpr::Not { child } => {
            // NOT 子树：进入即翻转语境（指南 NOT B：self = B 单独命中）
            let mut p = prefix.to_vec();
            p.push(0);
            collect_leaves(conn, plan, child, &p, !positive, result_count, out)
        }
    }
}

/// 从 expr 移除 path 指定的叶子；返回 None 表示整棵被移除（子树空）。
fn remove_leaf(expr: Option<&QueryExpr>, path: &[usize]) -> Option<QueryExpr> {
    let e = expr?;
    if path.is_empty() {
        return None; // 移除根
    }
    match e {
        QueryExpr::Leaf { .. } => None, // 路径不匹配（叶子上还有下标）→ 不变
        QueryExpr::And { children } | QueryExpr::Or { children } => {
            let i = path[0];
            if i >= children.len() {
                return Some(e.clone());
            }
            let mut kids = children.clone();
            if path.len() == 1 {
                kids.remove(i);
            } else {
                let sub = remove_leaf(Some(&kids[i]), &path[1..]);
                match sub {
                    Some(n) => kids[i] = n,
                    None => {
                        kids.remove(i);
                    }
                }
            }
            match kids.len() {
                0 => None,
                1 => Some(kids.into_iter().next().unwrap()),
                _ => Some(match e {
                    QueryExpr::And { .. } => QueryExpr::And { children: kids },
                    _ => QueryExpr::Or { children: kids },
                }),
            }
        }
        QueryExpr::Not { child } => {
            if path.len() == 1 {
                return Some(e.clone()); // 不会从 Not 上取叶子
            }
            let sub = remove_leaf(Some(child), &path[1..]);
            match sub {
                Some(n) => Some(QueryExpr::Not {
                    child: Box::new(n),
                }),
                None => None,
            }
        }
    }
}

fn cond_label(cond: &LeafCond) -> String {
    match cond {
        LeafCond::Tag { facet_key, tag_ids, term_query, .. } => {
            if let Some(tq) = term_query.as_deref().filter(|s| !s.is_empty()) {
                format!("{facet_key}: {tq}")
            } else {
                format!("{facet_key}: 标签×{}", tag_ids.len())
            }
        }
        LeafCond::ExcludeTag { facet_key, tag_ids } => {
            format!("排除 {facet_key}×{}", tag_ids.len())
        }
        LeafCond::AssetType { value } => format!("类型: {value}"),
        LeafCond::Untagged => "未打标".into(),
        LeafCond::Metadata { filter } => format!("{} {} {:?}", filter.key, filter.op, filter.value),
        LeafCond::Search { value, .. } => format!("关键词: {value}"),
        LeafCond::FacetHasAny { facet_key } => format!("{facet_key} 有任意标签"),
        LeafCond::FacetMissing { facet_key } => format!("{facet_key} 没有标签"),
    }
}

/// S6：schema 版本迁移（plan_schema_version 3 → 4 时在此加 migrate_plan_v3_to_v4；
/// 现在结构未变，直接原样返回）。读到旧版本先迁移再执行。
pub fn migrate_plan(plan: &mut SearchPlanV3) {
    match plan.plan_schema_version {
        v if v < PLAN_SCHEMA_VERSION => {
            // 未来：plan = migrate_plan_v3_to_v4(plan) 后再走下一段
            plan.plan_schema_version = PLAN_SCHEMA_VERSION;
        }
        v if v > PLAN_SCHEMA_VERSION => {
            // 用户降级了应用：不在此迁移，由调用方丢弃 + warning（superSearchStore hydrate）
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::init_memory;
    use crate::db::{asset_tags, assets, tags};

    fn insert_asset(c: &Connection, path: &str) -> i64 {
        assets::insert(c, path, "a.jpg", "jpg", 1024, "image/jpeg", 1700000000000).unwrap()
    }
    fn tag(c: &Connection, facet: &str, name: &str) -> i64 {
        tags::create_in_facet(c, name, None, Some(facet)).unwrap().id
    }
    fn tag_leaf(facet: &str, ids: Vec<i64>) -> LeafCond {
        LeafCond::Tag {
            term_query: None,
            term_match: Default::default(),
            facet_key: facet.into(),
            tag_ids: ids,
            mode: None,
            include_descendants: true,
        }
    }
    fn tag_plan(facet: &str, tag_id: i64, should: &[(&str, i64, f32)]) -> SearchPlanV3 {
        SearchPlanV3 {
            filter: Some(QueryExpr::Leaf {
                cond: tag_leaf(facet, vec![tag_id]),
            }),
            should: should
                .iter()
                .map(|(label, id, w)| ShouldClause {
                    cond: tag_leaf(facet, vec![*id]),
                    weight: *w,
                    label: label.to_string(),
                })
                .collect(),
            minimum_should_match: 0,
            ranking: Ranking::Relevance { retrievers: RetrieverPlan::default() },
            ..Default::default()
        }
    }

    #[test]
    fn should_does_not_eliminate_nonmatching() {
        let c = init_memory().unwrap();
        let (grass, sky) = (tag(&c, "scene", "草地"), tag(&c, "scene", "蓝天"));
        let a = insert_asset(&c, "d:/1.jpg");
        let b = insert_asset(&c, "d:/2.jpg");
        asset_tags::assign(&c, &[a], &[grass, sky], "manual").unwrap();
        asset_tags::assign(&c, &[b], &[grass], "manual").unwrap();
        let plan = tag_plan("scene", grass, &[("蓝天", sky, 1.0)]);
        let out = run_search_plan(&c, &plan, None, 0).unwrap();
        let ids: Vec<i64> = out.iter().map(|x| x.0).collect();
        assert!(ids.contains(&b), "无蓝天的草地照不得被淘汰");
        assert!(ids.contains(&a));
        assert_eq!(out[0].0, a, "有蓝天应排前");
    }

    #[test]
    fn should_affects_order_only_when_min_is_zero() {
        let c = init_memory().unwrap();
        let (grass, sky) = (tag(&c, "scene", "草地"), tag(&c, "scene", "蓝天"));
        let a = insert_asset(&c, "d:/1.jpg");
        let b = insert_asset(&c, "d:/2.jpg");
        asset_tags::assign(&c, &[a], &[grass, sky], "manual").unwrap();
        asset_tags::assign(&c, &[b], &[grass], "manual").unwrap();
        let mut plan = tag_plan("scene", grass, &[("蓝天", sky, 1.0)]);
        plan.minimum_should_match = 0;
        let out0 = run_search_plan(&c, &plan, None, 0).unwrap();
        assert_eq!(out0.len(), 2, "min=0 时 should 只影响顺序不影响集合");
        assert_eq!(out0[0].0, a);
        plan.minimum_should_match = 1;
        let out1 = run_search_plan(&c, &plan, None, 0).unwrap();
        let ids: Vec<i64> = out1.iter().map(|x| x.0).collect();
        assert_eq!(ids, vec![a], "min=1 时只有命中的进结果");
    }

    #[test]
    fn min_should_match_filters() {
        let c = init_memory().unwrap();
        let (grass, sky, night) =
            (tag(&c, "scene", "草地"), tag(&c, "scene", "蓝天"), tag(&c, "scene", "夜景"));
        let a = insert_asset(&c, "d:/1.jpg");
        let b = insert_asset(&c, "d:/2.jpg");
        let d = insert_asset(&c, "d:/3.jpg");
        asset_tags::assign(&c, &[a], &[grass, sky, night], "manual").unwrap();
        asset_tags::assign(&c, &[b], &[grass, sky], "manual").unwrap();
        asset_tags::assign(&c, &[d], &[grass], "manual").unwrap();
        let mut plan = tag_plan(
            "scene",
            grass,
            &[("蓝天", sky, 1.0), ("夜景", night, 2.0)],
        );
        plan.minimum_should_match = 2;
        let out = run_search_plan(&c, &plan, None, 0).unwrap();
        let ids: Vec<i64> = out.iter().map(|x| x.0).collect();
        assert_eq!(ids, vec![a], "min=2 → 只有两条加分都命中的 {ids:?}");
    }

    #[test]
    fn empty_filter_forces_min_should_one() {
        let c = init_memory().unwrap();
        let sky = tag(&c, "scene", "蓝天");
        let a = insert_asset(&c, "d:/1.jpg");
        let b = insert_asset(&c, "d:/2.jpg");
        asset_tags::assign(&c, &[a], &[sky], "manual").unwrap();
        asset_tags::assign(&c, &[b], &[tag(&c, "scene", "其他")], "manual").unwrap();
        let mut plan = tag_plan("scene", sky, &[("蓝天", sky, 1.0)]);
        plan.filter = None; // 空 filter + should 非空 → 强制 min ≥ 1
        plan.minimum_should_match = 0;
        let out = run_search_plan(&c, &plan, None, 0).unwrap();
        let ids: Vec<i64> = out.iter().map(|x| x.0).collect();
        assert_eq!(ids, vec![a], "空 filter 时不得返回全库（强制 min=1）");
    }

    #[test]
    fn should_sql_evaluated_once() {
        let c = init_memory().unwrap();
        let (grass, sky, night) =
            (tag(&c, "scene", "草地"), tag(&c, "scene", "蓝天"), tag(&c, "scene", "夜景"));
        let _a = insert_asset(&c, "d:/1.jpg");
        let plan = tag_plan(
            "scene",
            grass,
            &[("蓝天", sky, 1.0), ("夜景", night, 2.0)],
        );
        let compiled = compile_search_plan(&c, &plan).unwrap();
        let count_case = compiled.sql.matches("CASE WHEN").count();
        assert_eq!(count_case, 2, "每个 should 片段只应求值一次: {}", compiled.sql);
        // 每个分面 EXISTS 片段应各出现一次（含后代子查询体只出现一次）
        assert_eq!(compiled.sql.matches("EXISTS").count(), 1 + 2, "filter 1 + should 2 各一次");
    }

    #[test]
    fn validates_should_limit_and_sort_key() {
        let plan = SearchPlanV3 {
            ranking: Ranking::Field { key: "magic".into(), dir: "desc".into() },
            ..Default::default()
        };
        assert!(validate_search_plan(&plan).is_err(), "非法排序字段必须拒绝");
        let mut p2 = SearchPlanV3::default();
        p2.minimum_should_match = 1; // should 空但 min>0
        assert!(validate_search_plan(&p2).is_err());
    }

    /// S2：RRF 只用排名 —— 把某一路权重全乘 100（等效把该路分数放大），排序不变。
    #[test]
    fn rrf_fusion_is_scale_invariant() {
        let a = [10i64, 20, 30];
        let b = [25i64, 5];
        let base = rrf_fuse(&[(&a, 1.0), (&b, 2.0)]);
        let scaled = rrf_fuse(&[(&a, 100.0), (&b, 200.0)]);
        let order = |v: &[(i64, f64)]| v.iter().map(|x| x.0).collect::<Vec<_>>();
        assert_eq!(order(&base), order(&scaled), "整体权重放大不改变排序");
        // 交集元素按排名融合（id 20 在两路都靠前 → 总分高于只在单路的 30）
        let score_of = |v: &[(i64, f64)], id: i64| v.iter().find(|x| x.0 == id).map(|x| x.1);
        let s20 = score_of(&base, 20).unwrap();
        let s30 = score_of(&base, 30).unwrap();
        assert!(s20 > s30, "20 两路命中应高于只在单路的 30");
        // 单路权重缩放不改变内部次序（bm25 负值场景下仍然只用排名）
        let only = rrf_fuse(&[(&a, 1.0)]);
        let only_scaled = rrf_fuse(&[(&a, 1000.0)]);
        assert_eq!(order(&only), order(&only_scaled));
        assert_eq!(order(&only), vec![10, 20, 30]);
    }

    /// S2：用户显式选了排序字段 → 不走相关度（should 只影响集合/加分不影响顺序）。
    #[test]
    fn field_ranking_overrides_relevance() {
        let c = init_memory().unwrap();
        let (grass, sky) = (tag(&c, "scene", "草地"), tag(&c, "scene", "蓝天"));
        let a = insert_asset(&c, "d:/1.jpg"); // rating 高但无蓝天
        let b = insert_asset(&c, "d:/2.jpg"); // 低 rating 但有蓝天
        asset_tags::assign(&c, &[a], &[grass], "manual").unwrap();
        asset_tags::assign(&c, &[b], &[grass, sky], "manual").unwrap();
        c.execute("UPDATE assets SET rating = ?1 WHERE id = ?2", rusqlite::params![5, a])
            .unwrap();
        c.execute("UPDATE assets SET rating = ?1 WHERE id = ?2", rusqlite::params![1, b])
            .unwrap();
        let mut plan = tag_plan("scene", grass, &[("蓝天", sky, 1.0)]);
        plan.ranking = Ranking::Field { key: "rating".into(), dir: "desc".into() };
        let out = run_search_plan(&c, &plan, None, 0).unwrap();
        let ids: Vec<i64> = out.iter().map(|x| x.0).collect();
        assert_eq!(ids[0], a, "显式 rating desc → 5 星排前（无视应蓝天加分）");
        assert_eq!(ids.len(), 2, "should 仍不影响集合（min=0）");
    }

    // ═══════════════ S4：两路真实检索器（TagAlias 别名扩展 / Fts bm25） ═══════════════

    fn s4_terms_db() -> Connection {
        let c = init_memory().unwrap();
        crate::db::migrations::apply_v22b_constraints(&c).unwrap();
        crate::db::schema_features::set_feature(&c, "tag_unique_terms", true, None).unwrap();
        c
    }
    fn s4_asset(c: &Connection, file_name: &str) -> i64 {
        assets::insert(c, &format!("d:/{file_name}"), file_name, "jpg", 1024, "image/jpeg", 1700000000000)
            .unwrap()
    }

    /// S4：TagAlias 检索 —— 搜「海滨」经 tag_terms 命中「海边」→ 返回其素材。
    #[test]
    fn alias_retriever_expands_via_tag_terms() {
        let c = s4_terms_db();
        let t = tags::create_in_facet(&c, "海边", None, Some("scene")).unwrap();
        tags::add_alias(&c, t.id, "海滨", None, "synonym").unwrap();
        let aid = s4_asset(&c, "a.jpg");
        asset_tags::assign(&c, &[aid], &[t.id], "manual").unwrap();
        let ids = run_retriever(
            &c,
            &Retriever::TagAlias {
                text: "海滨".into(),
                facet_key: Some("scene".into()),
            },
        )
        .unwrap();
        assert!(ids.contains(&aid), "搜「海滨」应命中「海边」素材：{ids:?}");
    }

    /// S4：feature gate 关时 TagAlias 返回空（不误命中旧表别名）。
    #[test]
    fn alias_retriever_disabled_without_terms() {
        let c = init_memory().unwrap(); // tag_unique_terms 默认关
        let t = tags::create_in_facet(&c, "海边", None, Some("scene")).unwrap();
        let aid = s4_asset(&c, "a.jpg");
        asset_tags::assign(&c, &[aid], &[t.id], "manual").unwrap();
        let ids = run_retriever(
            &c,
            &Retriever::TagAlias {
                text: "海边".into(),
                facet_key: Some("scene".into()),
            },
        )
        .unwrap();
        assert!(ids.is_empty(), "gate 关时不得走 tag_terms 扩展：{ids:?}");
    }

    /// S4：TagAlias 素材上限 ≤10。
    #[test]
    fn alias_retriever_respects_cap() {
        let c = s4_terms_db();
        let t = tags::create_in_facet(&c, "海边", None, Some("scene")).unwrap();
        let mut aids = Vec::new();
        for i in 0..12 {
            let a = s4_asset(&c, &format!("a{i}.jpg"));
            asset_tags::assign(&c, &[a], &[t.id], "manual").unwrap();
            aids.push(a);
        }
        let ids = run_retriever(
            &c,
            &Retriever::TagAlias {
                text: "海边".into(),
                facet_key: Some("scene".into()),
            },
        )
        .unwrap();
        assert_eq!(ids.len(), 10, "TagAlias 素材上限 10：{ids:?}");
    }

    /// S4：Fts 检索 —— bm25 相关度排序（命中词素材排前，无关素材不出现）。
    #[test]
    fn fts_retriever_exposes_bm25_rank() {
        let c = init_memory().unwrap();
        let hit = s4_asset(&c, "wxyzportrait");
        let miss = s4_asset(&c, "zzqotherimage");
        let _other = s4_asset(&c, "wxyzportrait2"); // 同词另一张（不同 token：portrait2）
        let ids = run_retriever(
            &c,
            &Retriever::Fts {
                query: "wxyzportrait".into(),
                scope: crate::db::query_expr::SearchScope::FileName,
            },
        )
        .unwrap();
        assert!(!ids.is_empty(), "Fts 检索应命中含词素材");
        assert_eq!(ids[0], hit, "精确命中素材应排最前：{ids:?}");
        assert!(!ids.contains(&miss), "无关素材不得出现在 bm25 排序结果里");
    }


    // ═══════════════ C-2：AST 命中诊断 ═══════════════
    fn d_tag(facet: &str, id: i64) -> QueryExpr {
        QueryExpr::Leaf {
            cond: LeafCond::Tag {
                facet_key: facet.into(),
                tag_ids: vec![id],
                mode: Some("any".into()),
                include_descendants: true,
                term_query: None,
                term_match: crate::db::tags::TermMatch::Alias,
            },
        }
    }
    fn diag_leaves(conn: &Connection, plan: &SearchPlanV3) -> Vec<LeafDiagnostic> {
        diagnose_search_plan(conn, plan).unwrap().0
    }

    /// C-2：AND 中把结果砍到 0 的叶子 —— delta>0 且 result_count==0（罪魁祸首标红依据）。
    #[test]
    fn diagnostic_delta_identifies_zeroing_leaf() {
        let c = init_memory().unwrap();
        let a = tag(&c, "scene", "标签甲");
        let b = tag(&c, "scene", "标签乙");
        let a1 = insert_asset(&c, "d:/d1.jpg");
        let a2 = insert_asset(&c, "d:/d2.jpg");
        let _b1 = insert_asset(&c, "d:/d3.jpg");
        asset_tags::assign(&c, &[a1], &[a], "manual").unwrap();
        asset_tags::assign(&c, &[a2], &[a], "manual").unwrap();
        asset_tags::assign(&c, &[_b1], &[b], "manual").unwrap();
        let plan = SearchPlanV3 {
            filter: Some(QueryExpr::And {
                children: vec![d_tag("scene", a), d_tag("scene", b)],
            }),
            should: Vec::new(),
            ranking: Ranking::Relevance { retrievers: RetrieverPlan::default() },
            ..Default::default()
        };
        let leaves = diag_leaves(&c, &plan);
        assert_eq!(leaves.len(), 2);
        // children 顺序 = [标签甲, 标签乙]
        let al = &leaves[0];
        let bl = &leaves[1];
        assert_eq!(bl.result_count, 0);
        assert!(bl.delta > 0, "乙把结果砍到 0 → delta 为正：{bl:?}");
        assert_eq!(al.self_count, 2);
        assert_eq!(bl.self_count, 1);
    }

    /// C-2：self_count==0 单独标注（区分「条件本身无效」与「与其他条件冲突」）。
    #[test]
    fn diagnostic_self_count_zero_is_distinguished() {
        let c = init_memory().unwrap();
        let a = tag(&c, "scene", "标签甲");
        let z = tag(&c, "scene", "无人标签");
        let a1 = insert_asset(&c, "d:/e1.jpg");
        asset_tags::assign(&c, &[a1], &[a], "manual").unwrap();
        let plan = SearchPlanV3 {
            filter: Some(QueryExpr::And {
                children: vec![d_tag("scene", a), d_tag("scene", z)],
            }),
            ranking: Ranking::Relevance { retrievers: RetrieverPlan::default() },
            ..Default::default()
        };
        let leaves = diag_leaves(&c, &plan);
        let al = &leaves[0];
        let zl = &leaves[1];
        assert_eq!(zl.self_count, 0, "无人标签自身 0 命中");
        assert_eq!(zl.result_count, 0);
        assert!(zl.delta > 0, "移除无人标签后有结果");
        assert!(al.self_count > 0);
    }

    /// C-2：OR / NOT 下 delta 语义 —— OR 叶子 delta<0（贡献），NOT 叶子 delta>0。
    #[test]
    fn diagnostic_works_under_or_and_not() {
        let c = init_memory().unwrap();
        let a = tag(&c, "scene", "标签甲");
        let b = tag(&c, "scene", "标签乙");
        let mut a_ids = Vec::new();
        for i in 0..3 {
            let id = insert_asset(&c, &format!("d:/or_a{i}.jpg"));
            asset_tags::assign(&c, &[id], &[a], "manual").unwrap();
            a_ids.push(id);
        }
        let mut b_ids = Vec::new();
        for i in 0..2 {
            let id = insert_asset(&c, &format!("d:/or_b{i}.jpg"));
            asset_tags::assign(&c, &[id], &[b], "manual").unwrap();
            b_ids.push(id);
        }
        // OR：结果 5；乙贡献 → delta = without(甲 3) - result(5) = -2
        let or_plan = SearchPlanV3 {
            filter: Some(QueryExpr::Or {
                children: vec![d_tag("scene", a), d_tag("scene", b)],
            }),
            ranking: Ranking::Relevance { retrievers: RetrieverPlan::default() },
            ..Default::default()
        };
        let leaves = diag_leaves(&c, &or_plan);
        let bl = &leaves[1]; // [甲, 乙]
        assert_eq!(bl.self_count, 2);
        assert_eq!(bl.result_count, 5);
        assert!(bl.delta < 0, "OR 下乙贡献 → delta 为负：{bl:?}");
        // NOT（must_not 单叶子 B，需与甲有交集才能体现排除量）：新库单独构造
        let c2 = init_memory().unwrap();
        let a2 = tag(&c2, "scene", "标签甲");
        let b2 = tag(&c2, "scene", "标签乙");
        let _p1 = insert_asset(&c2, "d:/n1.jpg");
        let _p2 = insert_asset(&c2, "d:/n2.jpg");
        let p3 = insert_asset(&c2, "d:/n3.jpg");
        asset_tags::assign(&c2, &[_p1, _p2, p3], &[a2], "manual").unwrap();
        asset_tags::assign(&c2, &[p3], &[b2], "manual").unwrap(); // 甲 3 张，其中 1 张含乙
        let not_plan = SearchPlanV3 {
            filter: Some(d_tag("scene", a2)),
            must_not: Some(d_tag("scene", b2)),
            ranking: Ranking::Relevance { retrievers: RetrieverPlan::default() },
            ..Default::default()
        };
        let nl = diag_leaves(&c2, &not_plan);
        let bl2 = &nl[1]; // [filter甲, must_not乙]
        assert_eq!(bl2.self_count, 1, "乙单独命中 1：{bl2:?}");
        assert_eq!(bl2.delta, 1, "NOT 下乙排除了 1：{bl2:?}");
    }

    /// C-2：should 显示「命中该加分项的素材数 / 结果总数」。
    #[test]
    fn diagnostic_should_shows_hit_ratio() {
        let c = init_memory().unwrap();
        let a = tag(&c, "scene", "标签甲");
        let s = tag(&c, "scene", "加分乙");
        let a1 = insert_asset(&c, "d:/f1.jpg");
        let a2 = insert_asset(&c, "d:/f2.jpg");
        asset_tags::assign(&c, &[a1, a2], &[a], "manual").unwrap();
        asset_tags::assign(&c, &[a1], &[s], "manual").unwrap();
        let plan = SearchPlanV3 {
            filter: Some(d_tag("scene", a)),
            should: vec![ShouldClause {
                cond: LeafCond::Tag {
                    facet_key: "scene".into(),
                    tag_ids: vec![s],
                    mode: Some("any".into()),
                    include_descendants: true,
                    term_query: None,
                    term_match: crate::db::tags::TermMatch::Alias,
                },
                weight: 1.0,
                label: "加分乙（蓝天）".into(),
            }],
            ranking: Ranking::Relevance { retrievers: RetrieverPlan::default() },
            ..Default::default()
        };
        let (_, should_diag) = diagnose_search_plan(&c, &plan).unwrap();
        assert_eq!(should_diag.len(), 1);
        assert_eq!(should_diag[0].hit_count, 1);
        assert_eq!(should_diag[0].total_count, 2);
    }
}
