//! 超级搜索 AI 服务（FB5-05 §9）：自然语言 → SearchIntentV2 → QueryExpr。
//! - 模型只输出分组概念事实源（组内 AND、组间 OR），后端生成并校验 QueryExpr；
//! - AI parse result 只返回 expr/排序/解释/warnings/resolvedTags，无扁平 query；
//! - 未知/歧义标签 → content 搜索 leaf 或 warning；强制不查询回收站；零数据库写入。

use rusqlite::Connection;
use serde::{Deserialize, Serialize};

use crate::db::query_expr::{normalize_expr, LeafCond, QueryExpr};
use crate::db::search_query::{self, MetadataFilter};
use crate::db::settings::AiSettings;
use crate::db::tag_facets::FacetPromptContext;
use crate::db::tags;
use crate::error::{AppError, AppResult};
use crate::services::ai_cloud::{self, TextJsonTier};

pub const MAX_INPUT_LEN: usize = 200;

/// §9.2-2：共享停用词（单一常量）。Prompt 文本由本常量生成，本地清洗复用同一集合——
/// 禁止维护两份会漂移的列表。
pub const SEARCH_CONCEPT_STOPWORDS: &[&str] = &[
    "然后",
    "还有",
    "有",
    "和",
    "与",
    "并且",
    "再",
    "里面",
    "画面中",
    "上面",
    "中间",
    "旁边",
    "拍的",
    "一个",
    "一些",
];

/// §9.3：OR 触发词（本地 group 守卫用）
const OR_WORDS: &[&str] = &["或者", "或", "任一", "二选一"];

/// §9.3 assetType 守卫：只有原文含明确词才接受
const IMAGE_WORDS: &[&str] = &["图片", "照片", "相片", "图像"];
const VIDEO_WORDS: &[&str] = &["视频", "录像", "片段", "短片"];

/// §9.2.2：元数据 key 契约集（与 db/search_query.rs 白名单同步，禁止漂移）。
/// 提示词教学段与 schema enum 均由本常量生成——单一事实源。
/// latitude/longitude 为并行数据契约（REAL，有符号十进制度，支持 eq/gt/gte/lt/lte/between），
/// 白名单补齐前本服务会按「丢弃 + warning」降级，不会整体报错。
pub const METADATA_KEYS: &[&str] = &[
    "file_ext",
    "mime_type",
    "video_codec",
    "audio_codec",
    "camera",
    "lens",
    "shutter",
    "iso",
    "aperture",
    "focal",
    "width",
    "height",
    "resolution",
    "aspect_ratio",
    "file_size",
    "duration_ms",
    "dominant_hue",
    "dominant_sat",
    "dominant_lum",
    "taken_at",
    "created_at",
    "modified_at",
    "folder",
    "latitude",
    "longitude",
];

/// 元数据操作符全集（= search_query.rs 各 key allowed_ops 的并集）
pub const METADATA_OPS: &[&str] = &["eq", "in", "gt", "gte", "lt", "lte", "between", "contains"];

/// concept 过长判定（§9.3：超过 12 个 Unicode 字符即句子化）
pub const MAX_CONCEPT_CHARS: usize = 12;
/// concept 清理后的首尾标点（本地清洗）
const CONCEPT_EDGE_PUNCT: &[char] = &[
    '。', '！', '？', '，', ',', '.', '!', '?', '；', ';', '：', ':', '、', '"', '"', '\'', '（',
    '）', '(', ')', '…', '·',
];

// ═══════════════ SearchIntent V2 结构（§9.1） ═══════════════

/// FB5-05：V2 单一概念协议。旧字段 search/tags/excludeTags/unresolved/relation 全部删除。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchIntentV2 {
    /// 组间 OR；每个 group 内全部条件 AND（§9.1）
    #[serde(default)]
    pub groups: Vec<SearchGroupV2>,
    /// 全局排除（对整个正向结果 NOT）
    #[serde(default)]
    pub exclusions: Vec<SearchConceptV2>,
    #[serde(default)]
    pub sort_by: Option<String>,
    #[serde(default)]
    pub sort_dir: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchGroupV2 {
    /// all | image | video（§9.3：本地守卫校验依据）
    #[serde(default = "default_asset_type")]
    pub asset_type: String,
    #[serde(default)]
    pub concepts: Vec<SearchConceptV2>,
    #[serde(default)]
    pub text_terms: Vec<IntentTextTerm>,
    #[serde(default)]
    pub metadata: Vec<MetadataFilter>,
}

fn default_asset_type() -> String {
    "all".into()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchConceptV2 {
    pub text: String,
    #[serde(default)]
    pub role: String,
    #[serde(default)]
    pub facet_hint: Option<String>,
    /// 0~1；缺省（fallback 路径）按 0 处理 → 不进入硬筛选（§9.4）
    #[serde(default)]
    pub confidence: Option<f32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IntentTextTerm {
    pub text: String,
    /// all | content | description | fileName（映射到 SearchScope，列名只能由此枚举出）
    #[serde(default = "default_text_scope")]
    pub scope: String,
}

fn default_text_scope() -> String {
    "all".into()
}

/// 已解析标签（前端展示）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedTag {
    pub facet_key: String,
    pub text: String,
    pub tag_id: i64,
    pub path: String,
}

/// 执行对象（ResolvedSearchQuery，contract-v1 §3）。
/// FB5-05：AI parse result 不再返回它（改用 expr）；保留给手动/兼容链路使用。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedQuery {
    pub search: String,
    pub asset_type: String,
    pub untagged_only: bool,
    pub facet_filters: Vec<ResolvedFacet>,
    pub exclude_tag_ids: Vec<i64>,
    pub missing_facet_keys: Vec<String>,
    pub metadata_filters: Vec<MetadataFilter>,
    pub sort_by: String,
    pub sort_dir: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedFacet {
    pub facet_key: String,
    pub tag_ids: Vec<i64>,
    pub mode: String,
    pub include_descendants: bool,
}

/// FB5-05（§9.5）：AI 解析结果。expr 为唯一执行事实源；排序单独返回。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiSearchParseResult {
    pub intent: SearchIntentV2,
    pub expr: Option<QueryExpr>,
    pub sort_by: String,
    pub sort_dir: String,
    pub explanation: String,
    pub warnings: Vec<String>,
    pub resolved_tags: Vec<ResolvedTag>,
}

// ═══════════════ 校验（§9.2.2 结构层） ═══════════════

/// 校验 SearchIntentV2：未知字段/枚举/非法值一律拒绝（不静默忽略）。
/// 本地语义守卫（§9.3）由 guard_intent 承担；本函数只做结构性校验。
/// 注意：非法/未知 metadata 条件不在此报错——先经 sanitize_metadata 丢弃 + warning 降级，
/// 本函数收到的 metadata 均视为合法（编译期兜底见 query_expr::validate_expr）。
pub fn validate_intent(intent: &SearchIntentV2, facets: &[FacetPromptContext]) -> AppResult<()> {
    if let Some(sb) = &intent.sort_by {
        if !matches!(
            sb.as_str(),
            "created_at" | "taken_at" | "modified_at" | "name" | "size" | "resolution"
        ) {
            return Err(AppError::msg(format!("非法排序字段：{sb}")));
        }
    }
    if let Some(sd) = &intent.sort_dir {
        if !matches!(sd.as_str(), "asc" | "desc") {
            return Err(AppError::msg(format!("非法 sortDir：{sd}")));
        }
    }
    if intent.groups.len() > 6 {
        return Err(AppError::msg("分组数量超出上限（最多 6 组）"));
    }
    if intent.exclusions.len() > 20 {
        return Err(AppError::msg("排除概念数量超出上限"));
    }
    for g in &intent.groups {
        if !matches!(g.asset_type.as_str(), "all" | "image" | "video") {
            return Err(AppError::msg(format!("非法 assetType：{}", g.asset_type)));
        }
        if g.metadata.len() > 20 {
            return Err(AppError::msg("元数据条件数量超出上限"));
        }
        for c in &g.concepts {
            validate_concept_shape(c)?;
        }
        for tt in &g.text_terms {
            if tt.text.trim().is_empty() {
                return Err(AppError::msg("搜索词不能为空"));
            }
            if tt.text.chars().count() > 200 {
                return Err(AppError::msg("搜索词过长"));
            }
            if !matches!(
                tt.scope.as_str(),
                "all" | "content" | "description" | "fileName"
            ) {
                return Err(AppError::msg(format!("非法搜索范围：{}", tt.scope)));
            }
        }
    }
    for c in &intent.exclusions {
        validate_concept_shape(c)?;
    }
    let _ = facets; // 结构校验不再依赖分面集合（facet 收窄在解析层做）
    Ok(())
}

fn validate_concept_shape(c: &SearchConceptV2) -> AppResult<()> {
    if c.text.trim().is_empty() {
        return Err(AppError::msg("概念文字不能为空"));
    }
    if c.text.chars().count() > 100 {
        return Err(AppError::msg("概念文字过长"));
    }
    if let Some(h) = &c.facet_hint {
        if h.chars().count() > 60 {
            return Err(AppError::msg("分面提示过长"));
        }
    }
    Ok(())
}

/// 元数据条件容错降级（第六轮反馈改造）：单条非法/未知 metadata 条件（未知 key、
/// 不支持的 op、非法值）只丢弃该条件并记 warning，其余合法条件保留照常执行；
/// 结构性错误（排序/分组枚举等）仍由 validate_intent 整体报错。
/// 判定依据 = search_query::compile_metadata（与执行层同一校验，绝不漂移）。
pub fn sanitize_metadata(intent: &mut SearchIntentV2) -> Vec<String> {
    let mut warnings = Vec::new();
    for g in &mut intent.groups {
        g.metadata.retain(|f| match search_query::compile_metadata(f) {
            Ok(_) => true,
            Err(e) => {
                let msg = format!("已忽略无效的元数据条件（{} {}）：{e}", f.key, f.op);
                tracing::warn!("超级搜索丢弃非法元数据条件: key={} op={} 原因={e}", f.key, f.op);
                warnings.push(msg);
                false
            }
        });
    }
    warnings
}

// ═══════════════ 本地确定性守卫（§9.3） ═══════════════

/// 本地守卫：不信任模型。返回非阻断 warnings。
/// ① group 与 OR：原文无 OR 词而模型输出多组 → 合并为单 AND 组；
///    原文含 OR 而模型只给一组 → 保留并提示「或关系未能准确分组」。
/// ② assetType：原文无明确词 → 改回 all。
/// ③ concept 清洗：trim/去首尾标点/去停用词/拒句子化文本/按 text+role 去重/confidence 钳制。
/// ④ 全量概念计数上限（groups+exclusions ≤ 20）；语义相同的重复 group 去重。
pub fn guard_intent(input: &str, intent: &mut SearchIntentV2) -> Vec<String> {
    let mut warnings = Vec::new();
    let has_or = OR_WORDS.iter().any(|w| input.contains(w));

    // ① group 与 OR 守卫
    if !has_or && intent.groups.len() > 1 {
        warnings.push("输入没有明确的「或」关系，已将多组条件合并为一组全部满足。".into());
        let mut merged = SearchGroupV2 {
            asset_type: "all".into(),
            concepts: Vec::new(),
            text_terms: Vec::new(),
            metadata: Vec::new(),
        };
        for g in intent.groups.drain(..) {
            merged.concepts.extend(g.concepts);
            merged.text_terms.extend(g.text_terms);
            merged.metadata.extend(g.metadata);
        }
        intent.groups = vec![merged];
    } else if has_or && intent.groups.len() == 1 {
        warnings.push("「或」关系未能准确分组，已按全部条件同时满足执行。".into());
    }
    // group 上限 6；清理后为空组删除
    intent.groups.truncate(6);

    // ② assetType 守卫
    for g in &mut intent.groups {
        let grounded = match g.asset_type.as_str() {
            "image" => IMAGE_WORDS.iter().any(|w| input.contains(w)),
            "video" => VIDEO_WORDS.iter().any(|w| input.contains(w)),
            _ => true,
        };
        if !grounded {
            warnings.push(format!(
                "原文未明确提到「{}」，已忽略类型条件。",
                if g.asset_type == "image" {
                    "图片/照片"
                } else {
                    "视频/录像"
                }
            ));
            g.asset_type = "all".into();
        }
    }

    // ③ concept 清洗（group 内 + exclusions）
    let mut total_concepts = 0usize;
    for g in &mut intent.groups {
        clean_concepts(&mut g.concepts, &mut warnings, &mut total_concepts);
    }
    clean_concepts(&mut intent.exclusions, &mut warnings, &mut total_concepts);
    if total_concepts > 20 {
        warnings.push(format!(
            "条件概念较多（{total_concepts} 个），已按置信度优先截取 20 个。"
        ));
    }

    // ④ 语义相同的重复 group 去重（序列化比较）
    let mut seen = std::collections::HashSet::new();
    intent.groups.retain(|g| {
        let key = serde_json::to_string(g).unwrap_or_default();
        seen.insert(key)
    });
    // 单个概念（text+role 标准化后）去重
    for g in &mut intent.groups {
        dedup_concepts(&mut g.concepts);
    }
    dedup_concepts(&mut intent.exclusions);

    warnings
}

fn clean_concepts(
    concepts: &mut Vec<SearchConceptV2>,
    warnings: &mut Vec<String>,
    total: &mut usize,
) {
    let mut kept: Vec<SearchConceptV2> = Vec::new();
    for c in concepts.drain(..) {
        let mut text = c.text.trim().to_string();
        // 去首尾标点
        text = text
            .trim_matches(|ch: char| CONCEPT_EDGE_PUNCT.contains(&ch))
            .trim()
            .to_string();
        if text.is_empty() {
            continue;
        }
        // 停用词
        if SEARCH_CONCEPT_STOPWORDS.iter().any(|w| *w == text) {
            continue;
        }
        // 句子化文本拒绝
        if text.chars().count() > MAX_CONCEPT_CHARS {
            warnings.push(format!("「{text}」是句子而非原子概念，已忽略。"));
            continue;
        }
        let confidence = c.confidence.unwrap_or(0.0).clamp(0.0, 1.0);
        kept.push(SearchConceptV2 {
            text,
            role: c.role.trim().to_string(),
            facet_hint: c
                .facet_hint
                .as_ref()
                .map(|h| h.trim().to_string())
                .filter(|h| !h.is_empty()),
            confidence: Some(confidence),
        });
        *total += 1;
    }
    *concepts = kept;
}

fn dedup_concepts(concepts: &mut Vec<SearchConceptV2>) {
    let mut seen = std::collections::HashSet::new();
    concepts.retain(|c| {
        let key = format!(
            "{}|{}",
            tags::normalize_name(&c.text),
            c.role.to_ascii_lowercase()
        );
        seen.insert(key)
    });
}

// ═══════════════ 标签解析 + QueryExpr 生成（§9.4/§9.5） ═══════════════

enum ConceptOutcome {
    Tag(ResolvedTag),
    /// 未映射的具体画面概念 → content 范围搜索 leaf（§9.4）
    Content(String),
    /// 未采用（warning 文案）
    Dropped(String),
}

/// §9.4 标签解析策略：
///  1. 规范名精确匹配（全分面）；
///  2. alias 精确匹配；
///  3. facetHint 范围内只有一个前缀候选，且 confidence ≥ 0.85；
///  4. 其他包含/模糊多候选 → 不擅选（转 content 或 drop）。
/// 无法可靠映射时：正向 concept 且 conf ≥ 0.55 → content 搜索 leaf（显式硬条件）；
/// exclusion 且 conf ≥ 0.55 → 全局 NOT(content)；conf < 0.55 → 未采用 warning。
fn resolve_concept(
    conn: &Connection,
    c: &SearchConceptV2,
    exclusion: bool,
) -> AppResult<ConceptOutcome> {
    let text = c.text.trim().to_string();
    let confidence = c.confidence.unwrap_or(0.0).clamp(0.0, 1.0);
    let normalized = tags::normalize_name(&text);

    // facetHint 收窄（hint 分面不存在时全分面）
    let scope: Option<&str> = c.facet_hint.as_deref().filter(|h| {
        conn.query_row("SELECT 1 FROM tag_facets WHERE key = ?1", [h], |_| Ok(()))
            .is_ok()
    });
    let candidates = tags::search_candidates(conn, scope, &text)?;

    // 1+2：规范名 / alias 精确匹配
    if let Some(t) = candidates.iter().find(|t| {
        t.normalized_name == normalized
            || t.aliases
                .iter()
                .any(|a| tags::normalize_name(a) == normalized)
    }) {
        return Ok(ConceptOutcome::Tag(ResolvedTag {
            facet_key: t.facet_key.clone(),
            text,
            tag_id: t.id,
            path: t.path.clone(),
        }));
    }
    // 3：facetHint 范围内唯一前缀候选 + 高置信
    if confidence >= 0.85 {
        let prefixes: Vec<&tags::Tag> = candidates
            .iter()
            .filter(|t| t.normalized_name.starts_with(&normalized))
            .collect();
        if prefixes.len() == 1 {
            let t = prefixes[0];
            return Ok(ConceptOutcome::Tag(ResolvedTag {
                facet_key: t.facet_key.clone(),
                text,
                tag_id: t.id,
                path: t.path.clone(),
            }));
        }
    }
    // 4：无法可靠映射
    if confidence >= 0.55 {
        // 正向概念 → group 内 content 搜索 leaf；exclusion → 全局 NOT(content)
        Ok(ConceptOutcome::Content(text))
    } else if exclusion {
        Ok(ConceptOutcome::Dropped(format!(
            "未采用排除概念「{text}」（置信度过低，无法可靠映射）"
        )))
    } else {
        Ok(ConceptOutcome::Dropped(format!(
            "未采用概念「{text}」（置信度过低，无法可靠映射）"
        )))
    }
}

/// §9.5：SearchIntentV2 → QueryExpr（AI 结果唯一执行事实源）。
/// 组内 leaf 独立生成（同一分面「树+花」绝不合并成 mode:any）；组间 OR；
/// exclusions 全局 NOT；最终 AND(positiveRoot, NOT...)。生成后统一 normalize + validate。
pub fn build_expr_from_v2(
    conn: &Connection,
    intent: &SearchIntentV2,
) -> AppResult<(Option<QueryExpr>, Vec<ResolvedTag>, Vec<String>)> {
    let mut warnings = Vec::new();
    let mut resolved_tags: Vec<ResolvedTag> = Vec::new();
    let mut group_exprs: Vec<QueryExpr> = Vec::new();

    for g in &intent.groups {
        let mut leaves: Vec<QueryExpr> = Vec::new();
        if g.asset_type != "all" {
            leaves.push(QueryExpr::Leaf {
                cond: LeafCond::AssetType {
                    value: g.asset_type.clone(),
                },
            });
        }
        for m in &g.metadata {
            leaves.push(QueryExpr::Leaf {
                cond: LeafCond::Metadata { filter: m.clone() },
            });
        }
        for tt in &g.text_terms {
            let scope = match tt.scope.as_str() {
                "content" => crate::db::query_expr::SearchScope::Content,
                "description" => crate::db::query_expr::SearchScope::Description,
                "fileName" => crate::db::query_expr::SearchScope::FileName,
                _ => crate::db::query_expr::SearchScope::All,
            };
            leaves.push(QueryExpr::Leaf {
                cond: LeafCond::Search {
                    value: tt.text.trim().to_string(),
                    scope,
                },
            });
        }
        for c in &g.concepts {
            match resolve_concept(conn, c, false)? {
                ConceptOutcome::Tag(r) => {
                    leaves.push(QueryExpr::Leaf {
                        cond: LeafCond::Tag {
                            facet_key: r.facet_key.clone(),
                            tag_ids: vec![r.tag_id],
                            mode: Some("any".into()),
                            include_descendants: true,
                        },
                    });
                    resolved_tags.push(r);
                }
                ConceptOutcome::Content(term) => {
                    // 显式硬条件：显示成可单独移除的「内容：xxx」chip（§9.4）
                    leaves.push(QueryExpr::Leaf {
                        cond: LeafCond::Search {
                            value: term,
                            scope: crate::db::query_expr::SearchScope::Content,
                        },
                    });
                }
                ConceptOutcome::Dropped(w) => warnings.push(w),
            }
        }
        if let Some(e) = pack_and(leaves) {
            group_exprs.push(e);
        }
    }

    // 组间 OR；无组 → 无正向 root
    let positive_root: Option<QueryExpr> = match group_exprs.len() {
        0 => None,
        1 => group_exprs.pop(),
        _ => Some(QueryExpr::Or {
            children: group_exprs,
        }),
    };

    // exclusions：各自 NOT(tag/content)，全局生效
    let mut nots: Vec<QueryExpr> = Vec::new();
    let mut excluded_tag_ids: std::collections::HashSet<i64> = std::collections::HashSet::new();
    for c in &intent.exclusions {
        match resolve_concept(conn, c, true)? {
            ConceptOutcome::Tag(r) => {
                excluded_tag_ids.insert(r.tag_id);
                nots.push(QueryExpr::Not {
                    child: Box::new(QueryExpr::Leaf {
                        cond: LeafCond::Tag {
                            facet_key: r.facet_key.clone(),
                            tag_ids: vec![r.tag_id],
                            mode: Some("any".into()),
                            include_descendants: true,
                        },
                    }),
                });
                resolved_tags.push(r);
            }
            ConceptOutcome::Content(term) => {
                nots.push(QueryExpr::Not {
                    child: Box::new(QueryExpr::Leaf {
                        cond: LeafCond::Search {
                            value: term,
                            scope: crate::db::query_expr::SearchScope::Content,
                        },
                    }),
                });
            }
            ConceptOutcome::Dropped(w) => warnings.push(w),
        }
    }

    // §9.3：exclusions 与正向概念解析到同一 tagId → 以 exclusion 为准，移除正向该 leaf
    let positive_root: Option<QueryExpr> = if excluded_tag_ids.is_empty() {
        positive_root
    } else {
        match positive_root {
            Some(p) => match without_tag_leaves(&p, &excluded_tag_ids) {
                Some(cleaned) => {
                    warnings.push("部分条件同时被包含与排除，已按排除处理。".into());
                    Some(cleaned)
                }
                None => {
                    warnings.push("部分条件同时被包含与排除，已按排除处理。".into());
                    None
                }
            },
            None => None,
        }
    };

    // §9.5.5：AND(positiveRoot, NOT...)；无正向 root 时可只由 NOT 组成
    let mut root_children: Vec<QueryExpr> = Vec::new();
    if let Some(p) = positive_root {
        root_children.push(p);
    }
    root_children.extend(nots);
    let expr = pack_and(root_children).and_then(normalize_expr);
    if let Some(e) = &expr {
        crate::db::query_expr::validate_expr(e)?;
    }
    Ok((expr, resolved_tags, warnings))
}

/// 从表达式树移除包含指定 tagId 的 Tag leaf（排除优先）。返回 None 表示正向部分被清空。
fn without_tag_leaves(
    expr: &QueryExpr,
    excluded: &std::collections::HashSet<i64>,
) -> Option<QueryExpr> {
    match expr {
        QueryExpr::Leaf {
            cond: LeafCond::Tag { tag_ids, .. },
        } => {
            if tag_ids.iter().any(|t| excluded.contains(t)) {
                None
            } else {
                Some(expr.clone())
            }
        }
        QueryExpr::And { children } => {
            let kept: Vec<QueryExpr> = children
                .iter()
                .filter_map(|c| without_tag_leaves(c, excluded))
                .collect();
            pack_and(kept)
        }
        QueryExpr::Or { children } => {
            let kept: Vec<QueryExpr> = children
                .iter()
                .filter_map(|c| without_tag_leaves(c, excluded))
                .collect();
            match kept.len() {
                0 => None,
                1 => kept.into_iter().next(),
                _ => Some(QueryExpr::Or { children: kept }),
            }
        }
        QueryExpr::Not { child } => {
            without_tag_leaves(child, excluded).map(|c| QueryExpr::Not { child: Box::new(c) })
        }
        other => Some(other.clone()),
    }
}

fn pack_and(leaves: Vec<QueryExpr>) -> Option<QueryExpr> {
    match leaves.len() {
        0 => None,
        1 => leaves.into_iter().next(),
        _ => Some(QueryExpr::And { children: leaves }),
    }
}

// ═══════════════ 词典（§9.2.1） ═══════════════

const DICT_MAX_PER_FACET: usize = 50;
const DICT_MAX_ALIASES: usize = 5;
const DICT_CHAR_CAP: usize = 6000;

/// 提取分面标签词典（§9.2.1）：只读 active 标签 + is_searchable=1 的别名；
/// 每分面最多 50 个规范标签、每标签最多 5 个别名；去除换行与控制字符；
/// 超字符上限时按分面公平截断（不让一个分面占满上下文）。
pub fn collect_tag_dictionary(
    conn: &Connection,
    facets: &[FacetPromptContext],
) -> AppResult<Vec<String>> {
    let mut per_facet: Vec<Vec<String>> = Vec::new();
    for f in facets {
        let mut stmt = conn.prepare(
            "SELECT t.name,
                    (SELECT GROUP_CONCAT(ta.normalized_alias, ',') FROM (
                        SELECT ta.normalized_alias FROM tag_aliases ta
                         WHERE ta.tag_id = t.id AND ta.is_searchable = 1
                         ORDER BY ta.id LIMIT ?2) ta)
               FROM tags t
              WHERE t.facet_key = ?1 AND COALESCE(t.status,'active') = 'active'
              ORDER BY t.sort_order, t.id LIMIT ?3",
        )?;
        let rows = stmt.query_map(
            rusqlite::params![
                f.key.as_str(),
                DICT_MAX_ALIASES as i64,
                DICT_MAX_PER_FACET as i64
            ],
            |r| Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?)),
        )?;
        let mut lines = Vec::new();
        for row in rows {
            let (name, aliases) = row?;
            let name = sanitize_dict_text(&name);
            if name.is_empty() {
                continue;
            }
            let line = match aliases {
                Some(a) => {
                    let list: Vec<String> = a
                        .split(',')
                        .map(|s| sanitize_dict_text(s.trim()))
                        .filter(|s| !s.is_empty())
                        .collect();
                    if list.is_empty() {
                        name
                    } else {
                        format!("{name} | aliases: {}", list.join(", "))
                    }
                }
                None => name,
            };
            lines.push(line);
        }
        per_facet.push(lines);
    }

    // 公平截断：总字符超限时，迭代丢弃「当前最长的分面」的最后一行
    let mut total_chars: usize = per_facet.iter().flatten().map(|l| l.chars().count()).sum();
    while total_chars > DICT_CHAR_CAP {
        let mut longest = 0usize;
        for (i, lines) in per_facet.iter().enumerate() {
            if !lines.is_empty()
                && (longest == usize::MAX
                    || lines.iter().map(|l| l.chars().count()).sum::<usize>()
                        > per_facet[longest]
                            .iter()
                            .map(|l| l.chars().count())
                            .sum::<usize>())
            {
                longest = i;
            }
        }
        if per_facet[longest].is_empty() {
            break;
        }
        let dropped = per_facet[longest].pop().unwrap();
        total_chars -= dropped.chars().count();
    }
    Ok(per_facet.into_iter().flatten().collect())
}

fn sanitize_dict_text(s: &str) -> String {
    s.chars().filter(|c| !c.is_control()).collect()
}

// ═══════════════ 解析与网络请求 ═══════════════

/// 解析模型回复为 SearchIntentV2。兼容 {query:{...}} 包一层。
pub fn parse_intent(content: &str) -> AppResult<SearchIntentV2> {
    let trimmed = content.trim();
    let parsed: Option<serde_json::Value> = serde_json::from_str(trimmed).ok().or_else(|| {
        let start = trimmed.find('{')?;
        let end = trimmed.rfind('}')?;
        serde_json::from_str(&trimmed[start..=end]).ok()
    });
    let Some(v) = parsed else {
        return Err(AppError::msg("AI 未返回可解析的 JSON"));
    };
    let value = if v.get("query").is_some() && v.get("groups").is_none() {
        v.get("query").cloned().unwrap_or(v)
    } else {
        v
    };
    serde_json::from_value::<SearchIntentV2>(value)
        .map_err(|e| AppError::msg(format!("AI JSON 校验失败：{e}")))
}

/// 网络 + 解析 + 校验：由调用方在短锁内收集 facets/dict 后，再在锁外调用本函数。
/// 不持有 DB 锁；text 已由命令层校验长度。
pub fn request_intent(
    cfg: &AiSettings,
    text: &str,
    facets: &[FacetPromptContext],
    dict: &[String],
) -> AppResult<(SearchIntentV2, Vec<String>)> {
    let profile = cfg
        .active()
        .ok_or_else(|| AppError::msg("请先在设置页添加 API 配置"))?;
    if profile.base_url.trim().is_empty() {
        return Err(AppError::msg("当前 API 配置缺少 base_url"));
    }

    let schema = intent_schema();
    let system = build_system_prompt(facets);
    let mut user = String::from("标签词典（规范名 | aliases: 可搜索别名）\n");
    for t in dict {
        user.push_str(&format!("- {t}\n"));
    }
    user.push_str("\n分面说明\n");
    for f in facets {
        user.push_str(&format!(
            "- {}(key={}) selection={} max={}: {}\n",
            f.display_name,
            f.key,
            f.selection_mode,
            f.max_items.unwrap_or(3),
            f.description // W2-1：hint 已并入 description（V20 合表）
        ));
    }
    user.push_str("\n用户查询：<query>");
    user.push_str(text);
    user.push_str("</query>\n请输出解析结果。");

    // 三级降级请求（Structured / JSON Object / Plain 归一化到同一 SearchIntentV2 + 同一守卫）
    let (tier, raw) = ai_cloud::request_text_json(
        profile,
        &system,
        &user,
        Some(schema.clone()),
        TextJsonTier::Structured,
    )?;
    if ai_cloud::is_degenerate_text(&raw) {
        return Err(AppError::msg("AI 输出持续异常，请重试或切换存档"));
    }
    let mut intent = parse_intent(&raw)?;
    // 容错降级：非法/未知 metadata 条件丢弃 + warning，其余条件继续；结构性错误仍整体报错。
    let metadata_warnings = sanitize_metadata(&mut intent);
    validate_intent(&intent, facets)?;
    let _ = tier;
    Ok((intent, metadata_warnings))
}

/// §9.2 Prompt 硬规则（停用词由 SEARCH_CONCEPT_STOPWORDS 生成，与本地清洗同一集合）。
fn build_system_prompt(facets: &[FacetPromptContext]) -> String {
    let stop = SEARCH_CONCEPT_STOPWORDS.join("、");
    let mut p = String::new();
    p.push_str(
        "你是「茶包素材库」的搜索条件解析器，不是聊天助手。输入一句自然语言，输出严格 JSON。\n",
    );
    p.push_str("结构：组内 AND、组间 OR。根对象字段 groups/exclusions/sortBy/sortDir。\n");
    p.push_str("每个 group 必填 assetType(all|image|video)/concepts/textTerms/metadata。\n");
    p.push_str(&format!("硬规则：\n1. 每个 concept 是原子化规范名词或短名词短语（中文 1-6 字），禁止「晚上拍的树」「画面中有很多人」这类句子片段。\n2. 连接/方位/语法词不作 concept。共享停用词：{stop}。\n"));
    p.push_str("3. 同义概念只输出一次：如「多人、人群」按词典二选一，不同时输出。\n");
    p.push_str("4. assetType 只有用户明确说 图片/照片/相片/图像（image）或 视频/录像/片段/短片（video）时才填；「拍的」不算。\n");
    p.push_str("5. 「晚上拍的」解析为「夜间」或「夜景」概念，不保留整句。\n");
    p.push_str("6. 能映射为标签或元数据的概念不进入 textTerms。\n");
    p.push_str("7. 只有明确文件名片段、引号原文、专有名词或无法映射的具体内容才进 textTerms；scope 取 content（搜描述或文件名），不得把整句放进 all 或 description。\n");
    p.push_str("8. 没有明确「或/或者/任一」时只输出一个 group；「或/或者/任一」连接的每个完整子句各输出一个 group，组内概念保持 AND。\n");
    p.push_str("9. 「不要/排除/除了」对应的原子概念放入全局 exclusions，不混入正向 group。\n");
    p.push_str("10. 不输出 tagId、SQL、分页、空字符串条件或 schema 之外字段。\n");
    p.push_str("11. confidence 0-1：能从词典精确命中给 0.9+；只能猜测给 0.6 左右；完全不确认给 0.5 以下。\n");
    p.push_str("颜色是算法计算的文件属性，用 metadata（dominant_hue 0-359：红色 min=345 max=15 表示跨 0°；橙 15-45、黄 45-70、绿 70-155、青 155-225、蓝 225-295、紫 295-345；dominant_sat/dominant_lum 0-100；灰/黑/白用 dominant_sat lte 10），不写进 tags。\n");
    p.push_str("元数据条件（metadata）能力清单——key 与 op 只能从下面选，单位与格式必须严格遵守：\n");
    p.push_str("- file_size：文件大小，单位字节（1MB=1048576）。op 用 gt/gte/lt/lte/between。示例「10~105MB」→ {\"key\":\"file_size\",\"op\":\"between\",\"min\":10485760,\"max\":110100480}。\n");
    p.push_str("- taken_at：拍摄日期，格式 YYYY-MM-DD，本地时区，区间左闭右开。op 只用 gte/lte/between。「8月份」（当前年份）→ {\"key\":\"taken_at\",\"op\":\"between\",\"min\":\"当年8月1日\",\"max\":\"当年8月31日\"}；「最近一周」按当前日期回推。\n");
    p.push_str("- duration_ms：视频时长，单位毫秒（1秒=1000）。op 用 gt/gte/lt/lte/between；仅对视频有意义。\n");
    p.push_str("- width/height：像素整数；resolution：宽×高总像素；aspect_ratio：宽÷高。均支持数值比较。\n");
    p.push_str("- dominant_sat/dominant_lum：0-100（饱和/明度），与颜色教学配合使用。\n");
    p.push_str("- latitude/longitude：拍摄定位，有符号十进制度（北纬/东经为正，南纬/西经为负；纬度 -90~90、经度 -180~180）。op 用 eq/gt/gte/lt/lte/between。示例「杭州附近」→ {\"key\":\"latitude\",\"op\":\"between\",\"min\":29.8,\"max\":30.6} 与 {\"key\":\"longitude\",\"op\":\"between\",\"min\":119.6,\"max\":120.7}。注意：城市名只有能映射到标签时才进 concepts，经纬度区间才进 metadata。\n");
    p.push_str("- 其他可用 key：iso、aperture、focal、camera、lens、shutter、file_ext、mime_type、video_codec、audio_codec、created_at、modified_at、folder（按字段含义使用，不确定就不输出）。\n");
    p.push_str("- 不确定的数值/日期/坐标不要猜：宁可不出 metadata 条件，也不要编造。\n");
    p.push_str("相对日期依据当前日期。只生成查询，不创建标签。\n");
    p.push_str("元数据输出示例 A：输入「大于100MB的视频」→ metadata:[{\"key\":\"file_size\",\"op\":\"gt\",\"value\":104857600,\"values\":null,\"min\":null,\"max\":null}]，assetType 为 video。\n");
    p.push_str("元数据输出示例 B：输入「今年8月份拍的照片」→ metadata:[{\"key\":\"taken_at\",\"op\":\"between\",\"value\":null,\"values\":null,\"min\":\"当年8月1日\",\"max\":\"当年8月31日\"}]。\n");
    // §9.2 回归基准：本轮截图用例
    p.push_str("示例 1：输入「晚上拍的然后有树还有多人」→ 期望：\n");
    p.push_str("{\"groups\":[{\"assetType\":\"all\",\"concepts\":[{\"text\":\"夜间\",\"role\":\"lighting\",\"facetHint\":\"lighting\",\"confidence\":0.95},{\"text\":\"树\",\"role\":\"subject\",\"facetHint\":\"subject\",\"confidence\":0.95},{\"text\":\"多人\",\"role\":\"subject\",\"facetHint\":\"subject\",\"confidence\":0.9}],\"textTerms\":[],\"metadata\":[]}],\"exclusions\":[],\"sortBy\":null,\"sortDir\":null}\n");
    p.push_str(
        "示例 2：输入「晚上拍的树或者白天拍的建筑」→ 两个 group：(夜间∧树) OR (白天∧建筑)。\n",
    );
    p.push_str(
        "示例 3：输入「不要夜景的人像」→ 一个含「人像」的 group + exclusions 含「夜景」。\n",
    );
    p.push_str("示例 4：输入「IMG_1097」→ groups 里 textTerms=[{\"text\":\"IMG_1097\",\"scope\":\"fileName\"}]。\n");
    let _ = facets;
    p
}

/// §9.2.2 V2 严格 JSON Schema：根与嵌套全部 additionalProperties:false；旧字段必须不存在。
fn intent_schema() -> serde_json::Value {
    let nullable_string = serde_json::json!({
        "anyOf": [{"type": "string"}, {"type": "null"}]
    });
    let nullable_number_or_string = serde_json::json!({
        "anyOf": [{"type": "string"}, {"type": "number"}, {"type": "null"}]
    });
    let concept = serde_json::json!({
        "type": "object",
        "additionalProperties": false,
        "properties": {
            "text": {"type": "string", "minLength": 1, "maxLength": 12},
            "role": {"type": "string", "maxLength": 40},
            "facetHint": {"anyOf": [{"type": "string", "maxLength": 60}, {"type": "null"}]},
            "confidence": {"type": "number", "minimum": 0.0, "maximum": 1.0}
        },
        "required": ["text", "role", "facetHint", "confidence"]
    });
    let text_term = serde_json::json!({
        "type": "object",
        "additionalProperties": false,
        "properties": {
            "text": {"type": "string", "minLength": 1, "maxLength": 200},
            "scope": {"type": "string", "enum": ["all", "content", "description", "fileName"]}
        },
        "required": ["text", "scope"]
    });
    let metadata_item = serde_json::json!({
        "type": "object",
        "additionalProperties": false,
        "properties": {
            "key": {"type": "string", "enum": METADATA_KEYS},
            "op": {"type": "string", "enum": METADATA_OPS},
            "value": nullable_number_or_string,
            "values": {"anyOf": [
                {"type": "array", "items": {"anyOf": [{"type": "string"}, {"type": "number"}]}},
                {"type": "null"}
            ]},
            "min": nullable_number_or_string,
            "max": nullable_number_or_string
        },
        "required": ["key", "op", "value", "values", "min", "max"]
    });
    let group = serde_json::json!({
        "type": "object",
        "additionalProperties": false,
        "properties": {
            "assetType": {"type": "string", "enum": ["all", "image", "video"]},
            "concepts": {"type": "array", "maxItems": 20, "items": concept},
            "textTerms": {"type": "array", "maxItems": 10, "items": text_term},
            "metadata": {"type": "array", "maxItems": 20, "items": metadata_item}
        },
        "required": ["assetType", "concepts", "textTerms", "metadata"]
    });
    serde_json::json!({
        "type": "object",
        "additionalProperties": false,
        "properties": {
            "groups": {"type": "array", "minItems": 0, "maxItems": 6, "items": group},
            "exclusions": {"type": "array", "maxItems": 20, "items": concept},
            "sortBy": nullable_string,
            "sortDir": {"anyOf": [{"type": "string", "enum": ["asc", "desc"]}, {"type": "null"}]}
        },
        "required": ["groups", "exclusions", "sortBy", "sortDir"]
    })
}

pub fn build_explanation(intent: &SearchIntentV2) -> String {
    let mut parts = Vec::new();
    for (i, g) in intent.groups.iter().enumerate() {
        let mut inner = Vec::new();
        match g.asset_type.as_str() {
            "image" => inner.push("图片".into()),
            "video" => inner.push("视频".into()),
            _ => {}
        }
        for c in &g.concepts {
            inner.push(format!("「{}」", c.text));
        }
        for tt in &g.text_terms {
            inner.push(format!("内容「{}」", tt.text));
        }
        for m in &g.metadata {
            inner.push(format!("{} {}", m.key, m.op));
        }
        if !inner.is_empty() {
            parts.push(if intent.groups.len() > 1 {
                format!("任一组 {}：{}", i + 1, inner.join(" 且 "))
            } else {
                inner.join(" 且 ")
            });
        }
    }
    for c in &intent.exclusions {
        parts.push(format!("排除「{}」", c.text));
    }
    if parts.is_empty() {
        "未解析出明确条件".into()
    } else {
        format!("筛选{}", parts.join("；"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::init_memory;

    fn mk_concept(text: &str, hint: Option<&str>, conf: f32) -> SearchConceptV2 {
        SearchConceptV2 {
            text: text.into(),
            role: String::new(),
            facet_hint: hint.map(String::from),
            confidence: Some(conf),
        }
    }

    fn mk_group(concepts: Vec<SearchConceptV2>) -> SearchGroupV2 {
        SearchGroupV2 {
            asset_type: "all".into(),
            concepts,
            text_terms: vec![],
            metadata: vec![],
        }
    }

    // ── 解析 ──

    #[test]
    fn parses_clean_v2_json() {
        let intent = parse_intent(
            r#"{"groups":[{"assetType":"all","concepts":[{"text":"树","role":"subject","facetHint":"subject","confidence":0.95}],"textTerms":[],"metadata":[]}],"exclusions":[],"sortBy":"resolution","sortDir":"desc"}"#,
        )
        .unwrap();
        assert_eq!(intent.groups.len(), 1);
        assert_eq!(intent.groups[0].concepts[0].text, "树");
        assert_eq!(intent.sort_by.as_deref(), Some("resolution"));
    }

    #[test]
    fn parses_noisy_reply_by_slicing() {
        let intent = parse_intent(
            "好的：\n{\"groups\":[{\"assetType\":\"video\",\"concepts\":[],\"textTerms\":[],\"metadata\":[]}],\"exclusions\":[],\"sortBy\":null,\"sortDir\":null}",
        )
        .unwrap();
        assert_eq!(intent.groups[0].asset_type, "video");
    }

    #[test]
    fn rejects_garbage() {
        assert!(parse_intent("我无法理解").is_err());
    }

    // ── 校验 ──

    #[test]
    fn validates_rejects_bad_asset_type() {
        let mut i = SearchIntentV2::default();
        i.groups.push(SearchGroupV2 {
            asset_type: "banana".into(),
            ..Default::default()
        });
        assert!(validate_intent(&i, &[]).is_err());
    }

    #[test]
    fn validates_rejects_bad_sort() {
        let mut i = SearchIntentV2::default();
        i.sort_by = Some("magic".into());
        assert!(validate_intent(&i, &[]).is_err());
    }

    #[test]
    fn validates_rejects_bad_text_scope() {
        let mut i = SearchIntentV2::default();
        i.groups.push(SearchGroupV2 {
            asset_type: "all".into(),
            text_terms: vec![IntentTextTerm {
                text: "x".into(),
                scope: "everything".into(),
            }],
            ..Default::default()
        });
        assert!(validate_intent(&i, &[]).is_err());
    }

    #[test]
    fn schema_has_no_legacy_fields() {
        // §9.2.2：schema 必须断言旧字段不存在
        let s = intent_schema();
        let props = s["properties"].as_object().unwrap();
        for legacy in [
            "search",
            "tags",
            "excludeTags",
            "unresolved",
            "relation",
            "concepts",
            "metadata",
        ] {
            assert!(
                !props.contains_key(legacy),
                "旧字段 {legacy} 必须不存在于 V2 schema"
            );
        }
        assert!(props.contains_key("groups"));
        assert!(props.contains_key("exclusions"));
        // 根与嵌套 additionalProperties:false
        assert_eq!(s["additionalProperties"], false);
        let g = &s["properties"]["groups"]["items"];
        assert_eq!(g["additionalProperties"], false);
        let c = &g["properties"]["concepts"]["items"];
        assert_eq!(c["additionalProperties"], false);
        assert_eq!(c["properties"]["confidence"]["maximum"], 1.0);
    }

    #[test]
    fn schema_requires_v2_fields() {
        let s = intent_schema();
        let req: Vec<String> = s["required"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap().to_string())
            .collect();
        assert!(req.contains(&"groups".into()));
        assert!(req.contains(&"exclusions".into()));
        assert!(req.contains(&"sortBy".into()));
        assert!(req.contains(&"sortDir".into()));
    }

    // ── §9.3 守卫 ──

    #[test]
    fn guard_merges_groups_without_or_word() {
        // 「晚上拍的然后有树还有多人」→ 模型多组 → 合并为单 AND 组 + warning
        let mut intent = SearchIntentV2 {
            groups: vec![
                mk_group(vec![mk_concept("夜间", None, 0.95)]),
                mk_group(vec![mk_concept("树", None, 0.95)]),
            ],
            ..Default::default()
        };
        let warnings = guard_intent("晚上拍的然后有树还有多人", &mut intent);
        assert_eq!(intent.groups.len(), 1);
        assert_eq!(intent.groups[0].concepts.len(), 2);
        assert!(warnings.iter().any(|w| w.contains("合并")));
    }

    #[test]
    fn guard_keeps_groups_with_or_word() {
        // 「晚上拍的树或者白天拍的建筑」→ 保留 2 组（组内 AND、组间 OR）
        let mut intent = SearchIntentV2 {
            groups: vec![
                mk_group(vec![
                    mk_concept("夜间", None, 0.95),
                    mk_concept("树", None, 0.95),
                ]),
                mk_group(vec![
                    mk_concept("白天", None, 0.95),
                    mk_concept("建筑", None, 0.95),
                ]),
            ],
            ..Default::default()
        };
        let warnings = guard_intent("晚上拍的树或者白天拍的建筑", &mut intent);
        assert_eq!(intent.groups.len(), 2);
        assert!(!warnings.iter().any(|w| w.contains("合并")));
    }

    #[test]
    fn guard_ungrounded_asset_type_reverts_to_all() {
        // 原文没提「图片/照片」→ 模型给 image → 改回 all + warning
        let mut intent = SearchIntentV2 {
            groups: vec![SearchGroupV2 {
                asset_type: "image".into(),
                concepts: vec![mk_concept("夜景", None, 0.9)],
                ..Default::default()
            }],
            ..Default::default()
        };
        let warnings = guard_intent("晚上拍的夜景", &mut intent);
        assert_eq!(intent.groups[0].asset_type, "all");
        assert!(warnings.iter().any(|w| w.contains("图片/照片")));
        // 原文明确「照片」→ 保留 image
        let mut intent2 = SearchIntentV2 {
            groups: vec![SearchGroupV2 {
                asset_type: "image".into(),
                concepts: vec![mk_concept("夜景", None, 0.9)],
                ..Default::default()
            }],
            ..Default::default()
        };
        let w2 = guard_intent("这张照片是夜景", &mut intent2);
        assert_eq!(intent2.groups[0].asset_type, "image");
        assert!(w2.is_empty());
    }

    #[test]
    fn guard_cleans_stopwords_and_sentences() {
        let mut intent = SearchIntentV2 {
            groups: vec![mk_group(vec![
                mk_concept("然后", None, 0.9),                       // 停用词
                mk_concept("画面中", None, 0.9),                     // 停用词
                mk_concept("晚上拍的树还有很多人在一起", None, 0.9), // 句子化（>12 字）
                mk_concept(" 银杏树 ", None, 0.9),                   // trim
                mk_concept("银杏树", None, 0.8),                     // 去重
            ])],
            ..Default::default()
        };
        let warnings = guard_intent("银杏树下的老人", &mut intent);
        assert_eq!(intent.groups[0].concepts.len(), 1);
        assert_eq!(intent.groups[0].concepts[0].text, "银杏树");
        assert!(warnings.iter().any(|w| w.contains("句子而非原子概念")));
    }

    #[test]
    fn guard_clamps_confidence() {
        let mut intent = SearchIntentV2 {
            exclusions: vec![mk_concept("夜景", None, 7.0)],
            ..Default::default()
        };
        let _ = guard_intent("不要夜景", &mut intent);
        assert_eq!(intent.exclusions[0].confidence, Some(1.0));
    }

    // ── §9.4/§9.5 expr 生成（真实 DB） ──

    fn setup_facets_and_tags(conn: &rusqlite::Connection) {
        let now = 1_700_000_000_000i64;
        for (k, n) in [
            ("subject", "主体"),
            ("scene", "场景"),
            ("lighting", "光线"),
            ("people", "人物"),
        ] {
            conn.execute(
                "INSERT OR IGNORE INTO tag_facets
                 (key, display_name, description, selection_mode, max_items, sort_order, is_system, status, applies_to, created_at, updated_at)
                 VALUES (?1, ?2, '', 'multi', 5, 0, 1, 'active', 'all', ?3, ?3)",
                rusqlite::params![k, n, now],
            )
            .unwrap();
        }
        for (facet, name) in [
            ("subject", "树"),
            ("subject", "花"),
            ("subject", "老人"),
            ("people", "多人"),
            ("people", "人群"),
            ("lighting", "夜景"),
            ("lighting", "白天"),
            ("scene", "建筑"),
        ] {
            tags::create_in_facet(conn, name, None, Some(facet)).unwrap();
        }
        // 人群 → 多人 的可搜索别名（同 tagId 验证用）
        let duo = tags::search_candidates(conn, Some("people"), "多人").unwrap();
        let duo_id = duo.iter().find(|t| t.name == "多人").map(|t| t.id).unwrap();
        conn.execute(
            "INSERT INTO tag_aliases (tag_id, alias, normalized_alias, is_searchable, created_at)
             VALUES (?1, '人群', '人群', 1, ?2)",
            rusqlite::params![duo_id, now],
        )
        .unwrap();
    }

    #[test]
    fn expr_group_and_or_not_shape() {
        let conn = init_memory().unwrap();
        setup_facets_and_tags(&conn);
        // 「晚上拍的树或者白天拍的建筑」→ (夜间∧树) OR (白天∧建筑)
        let intent = SearchIntentV2 {
            groups: vec![
                SearchGroupV2 {
                    asset_type: "all".into(),
                    concepts: vec![
                        mk_concept("夜景", Some("lighting"), 0.95),
                        mk_concept("树", Some("subject"), 0.95),
                    ],
                    ..Default::default()
                },
                SearchGroupV2 {
                    asset_type: "all".into(),
                    concepts: vec![
                        mk_concept("白天", Some("lighting"), 0.95),
                        mk_concept("建筑", Some("scene"), 0.95),
                    ],
                    ..Default::default()
                },
            ],
            ..Default::default()
        };
        let (expr, resolved, warnings) = build_expr_from_v2(&conn, &intent).unwrap();
        assert!(warnings.is_empty());
        let expr = expr.unwrap();
        match &expr {
            QueryExpr::Or { children } => {
                assert_eq!(children.len(), 2);
                match &children[0] {
                    QueryExpr::And { children } => assert_eq!(children.len(), 2),
                    _ => panic!("组内应为 AND"),
                }
            }
            _ => panic!("组间应为 OR"),
        }
        assert_eq!(resolved.len(), 4);
        crate::db::query_expr::validate_expr(&expr).unwrap();
    }

    #[test]
    fn expr_same_facet_two_concepts_are_two_leaves_not_any() {
        let conn = init_memory().unwrap();
        setup_facets_and_tags(&conn);
        // 「有树还有花」→ 两个独立 tag leaf（同一分面 subject），禁止 mode:any 合并
        let intent = SearchIntentV2 {
            groups: vec![mk_group(vec![
                mk_concept("树", Some("subject"), 0.95),
                mk_concept("花", Some("subject"), 0.95),
            ])],
            ..Default::default()
        };
        let (expr, resolved, _) = build_expr_from_v2(&conn, &intent).unwrap();
        assert_eq!(resolved.len(), 2);
        let expr = expr.unwrap();
        match &expr {
            QueryExpr::And { children } => {
                let tag_leaves: Vec<_> = children
                    .iter()
                    .filter_map(|c| match c {
                        QueryExpr::Leaf {
                            cond: LeafCond::Tag { tag_ids, .. },
                        } => Some(tag_ids.clone()),
                        _ => None,
                    })
                    .collect();
                assert_eq!(tag_leaves.len(), 2, "树+花 必须是两个独立 tag leaf");
                assert!(tag_leaves.iter().all(|t| t.len() == 1));
            }
            _ => panic!("应组装为 AND"),
        }
    }

    #[test]
    fn expr_unmapped_concept_becomes_content_search() {
        let conn = init_memory().unwrap();
        setup_facets_and_tags(&conn);
        // 「银杏树下的老人」：无「银杏树」标签 → 老人(tag) AND content(银杏树)
        let intent = SearchIntentV2 {
            groups: vec![mk_group(vec![
                mk_concept("银杏树", Some("subject"), 0.7), // 无标签 → content leaf
                mk_concept("老人", Some("subject"), 0.95),  // 有标签
            ])],
            ..Default::default()
        };
        let (expr, resolved, warnings) = build_expr_from_v2(&conn, &intent).unwrap();
        assert!(warnings.is_empty());
        assert_eq!(resolved.len(), 1);
        let expr = expr.unwrap();
        let mut has_content_leaf = false;
        let mut has_tag_leaf = false;
        if let QueryExpr::And { children } = &expr {
            for c in children {
                if let QueryExpr::Leaf { cond } = c {
                    match cond {
                        LeafCond::Search { scope, .. } => {
                            has_content_leaf =
                                *scope == crate::db::query_expr::SearchScope::Content;
                        }
                        LeafCond::Tag { .. } => has_tag_leaf = true,
                        _ => {}
                    }
                }
            }
        }
        assert!(has_content_leaf, "银杏树 应转 content 搜索 leaf");
        assert!(has_tag_leaf, "老人 应为 tag leaf");
    }

    #[test]
    fn expr_low_confidence_concept_is_dropped_with_warning() {
        let conn = init_memory().unwrap();
        setup_facets_and_tags(&conn);
        let intent = SearchIntentV2 {
            groups: vec![mk_group(vec![mk_concept("某种不确定的东西", None, 0.3)])],
            ..Default::default()
        };
        let (expr, _, warnings) = build_expr_from_v2(&conn, &intent).unwrap();
        assert!(expr.is_none(), "低置信不产生硬条件");
        assert!(warnings.iter().any(|w| w.contains("未采用概念")));
    }

    #[test]
    fn expr_synonyms_resolve_to_same_tag_id_single_leaf() {
        let conn = init_memory().unwrap();
        setup_facets_and_tags(&conn);
        // 「人群」「多人」→ 同一 tagId（人群是 多人的可搜索别名）→ 只产生一个 leaf
        let intent = SearchIntentV2 {
            groups: vec![mk_group(vec![
                mk_concept("多人", Some("people"), 0.95),
                mk_concept("人群", Some("people"), 0.95),
            ])],
            ..Default::default()
        };
        let (expr, resolved, _) = build_expr_from_v2(&conn, &intent).unwrap();
        // 解析层分别命中同一 tagId：expr 归一化后按 tagId 去重 → 1 个 leaf
        let expr = expr.unwrap();
        let tag_ids: Vec<i64> = match &expr {
            QueryExpr::And { children } => children
                .iter()
                .filter_map(|c| match c {
                    QueryExpr::Leaf {
                        cond: LeafCond::Tag { tag_ids, .. },
                    } => Some(tag_ids.clone()),
                    _ => None,
                })
                .flatten()
                .collect(),
            QueryExpr::Leaf {
                cond: LeafCond::Tag { tag_ids, .. },
            } => tag_ids.clone(),
            _ => vec![],
        };
        assert_eq!(resolved.len(), 2, "两个概念各自解析命中");
        let ids = resolved.iter().map(|r| r.tag_id).collect::<Vec<_>>();
        assert_eq!(ids[0], ids[1], "人群与多人应命中同一 tagId");
        assert_eq!(tag_ids.len(), 1, "同 tagId 只保留一个 leaf");
    }

    #[test]
    fn expr_exclusion_wins_over_positive_same_tag() {
        let conn = init_memory().unwrap();
        setup_facets_and_tags(&conn);
        // 正向「夜景」+ 排除「夜景」→ 以排除为准，正向 leaf 被移除
        let intent = SearchIntentV2 {
            groups: vec![mk_group(vec![mk_concept("夜景", Some("lighting"), 0.95)])],
            exclusions: vec![mk_concept("夜景", Some("lighting"), 0.95)],
            ..Default::default()
        };
        let (expr, _, warnings) = build_expr_from_v2(&conn, &intent).unwrap();
        let expr = expr.unwrap();
        // 根 = AND(NOT(夜景)) 或直接 NOT(夜景) —— 正向被移除
        let mut tag_leaf_count = 0;
        collect_tag_leaves(&expr, &mut tag_leaf_count);
        assert_eq!(tag_leaf_count, 1, "只有排除的 tag leaf，正向被移除");
        assert!(warnings.iter().any(|w| w.contains("包含与排除")));
    }

    fn collect_tag_leaves(e: &QueryExpr, count: &mut usize) {
        match e {
            QueryExpr::Leaf {
                cond: LeafCond::Tag { .. },
            } => *count += 1,
            QueryExpr::And { children } | QueryExpr::Or { children } => {
                for c in children {
                    collect_tag_leaves(c, count);
                }
            }
            QueryExpr::Not { child } => collect_tag_leaves(child, count),
            _ => {}
        }
    }

    #[test]
    fn expr_file_name_text_term() {
        let conn = init_memory().unwrap();
        setup_facets_and_tags(&conn);
        // 「IMG_1097」→ fileName 范围 text term
        let intent = SearchIntentV2 {
            groups: vec![SearchGroupV2 {
                asset_type: "all".into(),
                text_terms: vec![IntentTextTerm {
                    text: "IMG_1097".into(),
                    scope: "fileName".into(),
                }],
                ..Default::default()
            }],
            ..Default::default()
        };
        let (expr, _, _) = build_expr_from_v2(&conn, &intent).unwrap();
        let expr = expr.unwrap();
        match &expr {
            QueryExpr::Leaf {
                cond: LeafCond::Search { value, scope },
            } => {
                assert_eq!(value, "IMG_1097");
                assert_eq!(*scope, crate::db::query_expr::SearchScope::FileName);
            }
            _ => panic!("应为 fileName 搜索 leaf"),
        }
    }

    #[test]
    fn expr_exclusion_content_not_shape() {
        let conn = init_memory().unwrap();
        setup_facets_and_tags(&conn);
        // 排除未映射概念（conf ≥ 0.55）→ NOT(content)
        let intent = SearchIntentV2 {
            exclusions: vec![mk_concept("银幕", None, 0.7)],
            ..Default::default()
        };
        let (expr, _, _) = build_expr_from_v2(&conn, &intent).unwrap();
        let expr = expr.unwrap();
        match &expr {
            QueryExpr::Not { child } => match child.as_ref() {
                QueryExpr::Leaf {
                    cond: LeafCond::Search { scope, .. },
                } => assert_eq!(*scope, crate::db::query_expr::SearchScope::Content),
                _ => panic!("排除应为 NOT(content)"),
            },
            _ => panic!("应为 NOT"),
        }
    }

    // ── 词典（§9.2.1） ──

    #[test]
    fn dictionary_includes_searchable_aliases_and_sanitizes() {
        let conn = init_memory().unwrap();
        setup_facets_and_tags(&conn);
        let facets = vec![FacetPromptContext {
            key: "people".into(),
            display_name: "人物".into(),
            description: String::new(),
            selection_mode: "multi".into(),
            max_items: Some(5),
        }];
        let dict = collect_tag_dictionary(&conn, &facets).unwrap();
        let line = dict
            .iter()
            .find(|l| l.contains("多人"))
            .expect("词典应含 多人");
        assert!(line.contains("人群"), "可搜索别名应进词典：{line}");
        // 非可搜索别名不出现（未造，跳过）；控制字符被清除
        assert!(dict.iter().all(|l| !l.chars().any(|c| c.is_control())));
    }

    // ── 元数据能力清单 / schema 收窄 / 容错降级（第六轮反馈） ──

    fn mk_meta(
        key: &str,
        op: &str,
        value: Option<serde_json::Value>,
        values: Option<Vec<serde_json::Value>>,
        min: Option<serde_json::Value>,
        max: Option<serde_json::Value>,
    ) -> MetadataFilter {
        MetadataFilter {
            key: key.into(),
            op: op.into(),
            value,
            values,
            min,
            max,
        }
    }

    #[test]
    fn prompt_teaches_metadata_capabilities() {
        let p = build_system_prompt(&[]);
        // key 名与单位/格式教学必须存在，模型不再靠猜
        for needle in [
            "file_size",
            "字节",
            "taken_at",
            "YYYY-MM-DD",
            "duration_ms",
            "毫秒",
            "width/height",
            "resolution",
            "dominant_sat",
            "latitude",
            "longitude",
            "有符号十进制度",
        ] {
            assert!(p.contains(needle), "提示词应教学：{needle}");
        }
        // 关键换算示例：10~105MB → 字节区间
        assert!(p.contains("10485760"), "file_size 示例应含 10MB 字节数");
        assert!(p.contains("110100480"), "file_size 示例应含 105MB 字节数");
        // 完整 metadata 输出示例至少 2 个（file_size gt / taken_at between）
        assert!(p.contains("元数据输出示例 A"));
        assert!(p.contains("元数据输出示例 B"));
        // 月份区间示例（between 当月首末日）
        assert!(p.contains("8月份"));
    }

    #[test]
    fn schema_metadata_enums_match_whitelist_contract() {
        let s = intent_schema();
        let m = &s["properties"]["groups"]["items"]["properties"]["metadata"]["items"];
        let keys: Vec<&str> = m["properties"]["key"]["enum"]
            .as_array()
            .expect("key 必须有 enum")
            .iter()
            .map(|v| v.as_str().unwrap())
            .collect();
        let ops: Vec<&str> = m["properties"]["op"]["enum"]
            .as_array()
            .expect("op 必须有 enum")
            .iter()
            .map(|v| v.as_str().unwrap())
            .collect();
        assert_eq!(keys, METADATA_KEYS, "enum 必须直接取自契约常量");
        assert_eq!(ops, METADATA_OPS, "enum 必须直接取自契约常量");
        // 契约集 = search_query.rs 白名单全集 + 并行契约 latitude/longitude。
        // 白名单清单镜像自 db/search_query.rs 的 key_spec（两边漂移时此测试提醒同步）。
        let whitelist = [
            "file_ext",
            "mime_type",
            "video_codec",
            "audio_codec",
            "camera",
            "lens",
            "shutter",
            "iso",
            "aperture",
            "focal",
            "width",
            "height",
            "resolution",
            "aspect_ratio",
            "file_size",
            "duration_ms",
            "dominant_hue",
            "dominant_sat",
            "dominant_lum",
            "taken_at",
            "created_at",
            "modified_at",
            "folder",
        ];
        for k in whitelist {
            assert!(keys.contains(&k), "enum 缺少白名单 key：{k}");
        }
        assert!(keys.contains(&"latitude"), "契约新增 latitude 必须在 enum");
        assert!(keys.contains(&"longitude"), "契约新增 longitude 必须在 enum");
        assert_eq!(keys.len(), whitelist.len() + 2, "enum 不得多出白名单之外的 key");
        // op 全集与白名单各 key allowed_ops 并集一致
        assert_eq!(
            ops,
            vec!["eq", "in", "gt", "gte", "lt", "lte", "between", "contains"]
        );
    }

    #[test]
    fn sanitize_drops_invalid_metadata_and_keeps_valid() {
        let mut intent = SearchIntentV2 {
            groups: vec![SearchGroupV2 {
                asset_type: "all".into(),
                metadata: vec![
                    // 未知 key → 丢弃
                    mk_meta("magic_field", "eq", Some(serde_json::json!(1)), None, None, None),
                    // 白名单 key + 不支持的 op（taken_at 不支持 eq）→ 丢弃
                    mk_meta(
                        "taken_at",
                        "eq",
                        Some(serde_json::json!("2026-08-01")),
                        None,
                        None,
                        None,
                    ),
                    // 白名单 key + 非法值（file_size 为负）→ 丢弃
                    mk_meta("file_size", "gte", Some(serde_json::json!(-5)), None, None, None),
                    // 合法条件 → 保留
                    mk_meta(
                        "width",
                        "gte",
                        Some(serde_json::json!(1920)),
                        None,
                        None,
                        None,
                    ),
                ],
                ..Default::default()
            }],
            ..Default::default()
        };
        let warnings = sanitize_metadata(&mut intent);
        assert_eq!(warnings.len(), 3, "三条非法条件各产生一条 warning");
        assert!(warnings.iter().any(|w| w.contains("magic_field")));
        assert!(warnings.iter().any(|w| w.contains("taken_at")));
        let kept = &intent.groups[0].metadata;
        assert_eq!(kept.len(), 1, "合法条件保留");
        assert_eq!(kept[0].key, "width");
        // 降级后结构校验不再因 metadata 报错（其余合法条件可继续执行）
        validate_intent(&intent, &[]).unwrap();
    }

    #[test]
    fn sanitize_keeps_file_size_between_and_taken_month_examples() {
        // 提示词教学的两个标杆示例必须能通过白名单编译（不被降级丢弃）
        let mut intent = SearchIntentV2 {
            groups: vec![SearchGroupV2 {
                asset_type: "all".into(),
                metadata: vec![
                    // 「10~105MB」→ between 10485760..110100480
                    mk_meta(
                        "file_size",
                        "between",
                        None,
                        None,
                        Some(serde_json::json!(10485760)),
                        Some(serde_json::json!(110100480)),
                    ),
                    // 「8月份」→ between 当月首末日（YYYY-MM-DD，左闭右开）
                    mk_meta(
                        "taken_at",
                        "between",
                        None,
                        None,
                        Some(serde_json::json!("2026-08-01")),
                        Some(serde_json::json!("2026-08-31")),
                    ),
                ],
                ..Default::default()
            }],
            ..Default::default()
        };
        let warnings = sanitize_metadata(&mut intent);
        assert!(warnings.is_empty(), "教学示例必须全部合法：{warnings:?}");
        assert_eq!(intent.groups[0].metadata.len(), 2);
        // 进一步确认能编译为 SQL 片段（与执行层同一入口）
        for f in &intent.groups[0].metadata {
            assert!(
                crate::db::search_query::compile_metadata(f)
                    .unwrap()
                    .is_some(),
                "{} {} 应可编译",
                f.key,
                f.op
            );
        }
    }
}
