//! 超级搜索 AI 服务（P3）：自然语言 → SearchIntent → ResolvedSearchQuery。
//! - 只生成 SearchIntent（文字/字段/op），不生成 tagId/SQL/分页；
//! - 后端白名单校验 + 标签文字解析为 tagId；
//! - 未知/歧义标签返回 warning；强制不查询回收站；零数据库写入。

use rusqlite::Connection;
use serde::{Deserialize, Serialize};

use crate::db::search_query::{self, MetadataFilter};
use crate::db::settings::AiSettings;
use crate::db::tag_facets::FacetPromptContext;
use crate::db::tags;
use crate::error::{AppError, AppResult};
use crate::services::ai_cloud::{self, TextJsonTier};

pub const MAX_INPUT_LEN: usize = 200;

/// SearchIntent：AI 允许输出的字段（contract-v1 §2）
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchIntent {
    #[serde(default)]
    pub search: Option<String>,
    #[serde(default)]
    pub asset_type: Option<String>,
    #[serde(default)]
    pub tags: Vec<IntentTag>,
    #[serde(default)]
    pub exclude_tags: Vec<IntentTag>,
    #[serde(default)]
    pub metadata: Vec<MetadataFilter>,
    #[serde(default)]
    pub sort_by: Option<String>,
    #[serde(default)]
    pub sort_dir: Option<String>,
    /// §11.2 概念层：模型不直接输出 id/SQL，先拆原子概念（主体/颜色/场景/时间…）
    #[serde(default)]
    pub concepts: Vec<SearchConcept>,
    /// 概念间关系：and | or（缺省 and）
    #[serde(default)]
    pub relation: Option<String>,
    /// 模型识别不了的具体词（进全文 search 并 warning）
    #[serde(default)]
    pub unresolved: Vec<String>,
}

/// §11.2 原子概念：一句话里的一个可解析意图（不输出 id/SQL/分页）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchConcept {
    /// 概念文字（如「建筑」「红色」）
    pub text: String,
    /// 语义角色（subject/color/scene/style/location/event…，词典映射用）
    #[serde(default)]
    pub role: String,
    /// 模型建议的分面 key 提示（subject→主体分面等；可空，本地解析兜底）
    #[serde(default)]
    pub facet_hint: Option<String>,
    /// 置信度 0~1（高置信自动选、中置信展示候选、低置信进全文 search）
    #[serde(default)]
    pub confidence: Option<f32>,
}

/// §11.2 概念意图：concepts + 关系 + 未解析词
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchConceptIntent {
    pub concepts: Vec<SearchConcept>,
    pub relation: String,
    pub unresolved: Vec<String>,
}

/// role → 缺省 facet key 的启发映射（模型没给 facet_hint 时兜底；可被 hint 覆盖）
pub fn default_facet_hint_for_role(role: &str) -> Option<&'static str> {
    match role.to_ascii_lowercase().as_str() {
        "subject" | "主体" => Some("subject"),
        "color" | "colour" | "颜色" | "色彩" => Some("color"),
        "scene" | "场景" => Some("scene"),
        "style" | "风格" | "色彩风格" => Some("style"),
        "location" | "地点" => Some("location"),
        "event" | "事件" => Some("event"),
        "person" | "人物" => Some("person"),
        "animal" | "动物" => Some("animal"),
        "object" | "物体" => Some("object"),
        "time" | "时间" => Some("time"),
        "season" | "季节" => Some("season"),
        "light" | "光线" => Some("light"),
        "composition" | "构图" => Some("composition"),
        _ => None,
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IntentTag {
    #[serde(default)]
    pub facet_key: String,
    pub text: String,
    #[serde(default = "default_true")]
    pub include_descendants: bool,
}

fn default_true() -> bool {
    true
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

/// 执行对象（ResolvedSearchQuery，contract-v1 §3）
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

/// 解析结果
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiSearchParseResult {
    pub intent: SearchIntent,
    pub query: ResolvedQuery,
    pub explanation: String,
    pub warnings: Vec<String>,
    pub resolved_tags: Vec<ResolvedTag>,
}

/// 校验 SearchIntent：未知字段/op/非法值一律拒绝（contract-v1 §8），不静默忽略。
pub fn validate_intent(intent: &SearchIntent, facets: &[FacetPromptContext]) -> AppResult<()> {
    if let Some(aty) = &intent.asset_type {
        if !matches!(aty.as_str(), "all" | "image" | "video") {
            return Err(AppError::msg(format!("非法 assetType：{aty}")));
        }
    }
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
    if intent.tags.len() > 20 || intent.exclude_tags.len() > 20 {
        return Err(AppError::msg("标签条件数量超出上限"));
    }
    if intent.metadata.len() > 20 {
        return Err(AppError::msg("元数据条件数量超出上限"));
    }
    for t in intent.tags.iter().chain(intent.exclude_tags.iter()) {
        if t.text.trim().is_empty() {
            return Err(AppError::msg("标签文字不能为空"));
        }
        if t.text.chars().count() > 100 {
            return Err(AppError::msg("标签文字过长"));
        }
        if !t.facet_key.is_empty() && !facets.iter().any(|facet| facet.key == t.facet_key) {
            return Err(AppError::msg(format!("未知分面：{}", t.facet_key)));
        }
    }
    search_query::validate_metadata(&intent.metadata)?;
    Ok(())
}

/// 标签文字 → tagId。精确名/别名优先；否则唯一候选采用；多候选返回未知（warning）。
fn resolve_tag_facet(
    conn: &Connection,
    facet_key: &str,
    text: &str,
) -> AppResult<Option<ResolvedTag>> {
    let candidates = tags::search_candidates(conn, Some(facet_key), text)?;
    let exact = candidates.iter().find(|t| {
        t.normalized_name == tags::normalize_name(text)
            || t.aliases
                .iter()
                .any(|a| tags::normalize_name(a) == tags::normalize_name(text))
    });
    let picked = exact.or_else(|| {
        if candidates.len() == 1 {
            candidates.first()
        } else {
            None
        }
    });
    Ok(picked.map(|t| ResolvedTag {
        facet_key: facet_key.to_string(),
        text: text.to_string(),
        tag_id: t.id,
        path: t.path.clone(),
    }))
}

/// §11.3 本地解析顺序的候选择一：exact > alias > prefix/包含 > token overlap。
/// search_candidates 已按 sort_order 排序，这里在「唯一候选」前先试前缀/包含/词片交集。
fn pick_best_candidate<'a>(
    candidates: &'a [tags::Tag],
    normalized_query: &str,
) -> Option<&'a tags::Tag> {
    // 1) canonical 精确 + 2) alias 精确（由调用方先做，这里兜底再查一次）
    let exact = candidates.iter().find(|t| {
        t.normalized_name == normalized_query
            || t.aliases
                .iter()
                .any(|a| tags::normalize_name(a) == normalized_query)
    });
    if let Some(e) = exact {
        return Some(e);
    }
    // 3) 前缀（查询是名称的前缀）优先于包含
    if let Some(p) = candidates
        .iter()
        .find(|t| t.normalized_name.starts_with(normalized_query))
    {
        return Some(p);
    }
    // 4) 包含（LIKE %q% 已过滤，这里只取最短命中——更接近概念的词）
    if let Some(m) = candidates.iter().min_by_key(|t| t.normalized_name.len()) {
        return Some(m);
    }
    None
}

/// §11.3 解析单条标签条件，返回 (resolved, warning)。facet_hint 用于未指定分面时收窄候选。
fn resolve_tag_with_hint(
    conn: &Connection,
    t: &IntentTag,
    facet_hint: Option<&str>,
) -> AppResult<(Option<ResolvedTag>, Option<String>)> {
    let normalized = tags::normalize_name(&t.text);
    // 未指定 facet_key 时：优先按 facet_hint 收窄；无 hint 再全分面搜索
    if t.facet_key.is_empty() {
        let scope: Option<&str> = facet_hint.filter(|h| {
            // hint 只在确实存在该分面时收窄（否则退回全分面，留给模型/上层 warning）
            super_candidates_facet_exists_hint(conn, h).unwrap_or(false)
        });
        let candidates = tags::search_candidates(conn, scope, &t.text)?;
        let picked = pick_best_candidate(&candidates, &normalized);
        return Ok(match picked {
            Some(c) => (
                Some(ResolvedTag {
                    facet_key: c.facet_key.clone(),
                    text: t.text.clone(),
                    tag_id: c.id,
                    path: c.path.clone(),
                }),
                None,
            ),
            None => (None, Some(format!("未识别标签：{}", t.text))),
        });
    }
    match resolve_tag_facet(conn, &t.facet_key, &t.text)? {
        Some(r) => Ok((Some(r), None)),
        None => Ok((
            None,
            Some(format!("未识别标签：{}（分面 {}）", t.text, t.facet_key)),
        )),
    }
}

/// facet_hint 收窄前的存在性探测（单条 COUNT 查询，轻量）
fn super_candidates_facet_exists_hint(conn: &Connection, facet_key: &str) -> AppResult<bool> {
    let n: i64 = conn.query_row(
        "SELECT COUNT(1) FROM tag_facets WHERE key = ?1",
        [facet_key],
        |r| r.get(0),
    )?;
    Ok(n > 0)
}

/// 解析单条标签条件，返回 (resolved, warning)
fn resolve_tag_condition(
    conn: &Connection,
    t: &IntentTag,
) -> AppResult<(Option<ResolvedTag>, Option<String>)> {
    resolve_tag_with_hint(conn, t, None)
}

/// §11.2 编译：模型输出的原子概念 → 现有 SearchIntent（兼容前端，不改前端协议）。
/// - concepts 进入 tags（facet_key 取 facet_hint 或 role 启发映射）；
/// - relation 应用：or 时同分面多概念标记为 any（AND 是默认，无需改）；
/// - unresolved 进全文 search 并输出警告。
pub fn compile_concepts(intent: SearchIntent) -> (SearchIntent, Vec<String>) {
    let mut warnings = Vec::new();
    let mut out = intent.clone();
    if intent.concepts.is_empty() && intent.unresolved.is_empty() {
        return (out, warnings);
    }
    // unresolved：合并进全文搜索（召回兜底），并给用户可读警告
    if !intent.unresolved.is_empty() {
        let join = intent.unresolved.join(" ");
        let base = out.search.clone().unwrap_or_default();
        out.search = Some(if base.trim().is_empty() { join } else { format!("{base} {join}") });
        warnings.push(format!(
            "以下概念未命中任何已知标签，已改用全文搜索：{}",
            intent.unresolved.join("、")
        ));
    }
    // 概念 → tags（每个概念独立条件；关系 and 由 facets 的 AND 天然构成）
    for c in &intent.concepts {
        let text = c.text.trim();
        if text.is_empty() {
            continue;
        }
        // 已有等价 tag 条件时跳过（模型重复概念不去重由这里兜底）
        if out
            .tags
            .iter()
            .chain(out.exclude_tags.iter())
            .any(|t| tags::normalize_name(&t.text) == tags::normalize_name(text))
        {
            continue;
        }
        let facet_hint = c
            .facet_hint
            .clone()
            .or_else(|| default_facet_hint_for_role(&c.role).map(String::from));
        let facet_key = facet_hint.unwrap_or_default();
        out.tags.push(IntentTag {
            facet_key,
            text: text.to_string(),
            include_descendants: true,
        });
    }
    (out, warnings)
}

/// SearchIntent → ResolvedQuery（标签解析 + 未知/歧义 warning；强制不查回收站）。
pub fn resolve_query(
    conn: &Connection,
    intent: &SearchIntent,
) -> AppResult<(ResolvedQuery, Vec<ResolvedTag>, Vec<String>)> {
    let mut warnings = Vec::new();
    let mut resolved_tags = Vec::new();
    let mut facet_filters: Vec<ResolvedFacet> = Vec::new();
    let mut exclude_tag_ids: Vec<i64> = Vec::new();
    let mut missing_facet_keys: Vec<String> = Vec::new();

    // §11.3 解析顺序：概念已编译进 tags（compile_concepts 在命令层做），
    // 这里逐条解析；未指定分面时用概念 hint 收窄候选。
    for t in &intent.tags {
        let (resolved, w) = resolve_tag_condition(conn, t)?;
        if let Some(r) = resolved {
            let facet = facet_filters
                .iter_mut()
                .find(|f| f.facet_key == r.facet_key);
            if let Some(f) = facet {
                f.tag_ids.push(r.tag_id);
            } else {
                facet_filters.push(ResolvedFacet {
                    facet_key: r.facet_key.clone(),
                    tag_ids: vec![r.tag_id],
                    mode: "any".into(),
                    include_descendants: t.include_descendants,
                });
            }
            resolved_tags.push(r);
        } else if let Some(w) = w {
            warnings.push(w);
        } else if !t.facet_key.is_empty() {
            // 该分面下无候选：可复用的分面 key 但有词未命中 → 明确记录缺失
            missing_facet_keys.push(t.facet_key.clone());
        }
    }

    for t in &intent.exclude_tags {
        let (resolved, w) = resolve_tag_condition(conn, t)?;
        if let Some(r) = resolved {
            exclude_tag_ids.push(r.tag_id);
            resolved_tags.push(r);
        } else if let Some(w) = w {
            warnings.push(format!("排除标签：{w}"));
        }
    }

    let query = ResolvedQuery {
        search: intent.search.clone().unwrap_or_default(),
        asset_type: intent.asset_type.clone().unwrap_or_else(|| "all".into()),
        untagged_only: false,
        facet_filters,
        exclude_tag_ids,
        missing_facet_keys,
        metadata_filters: intent.metadata.clone(),
        sort_by: intent
            .sort_by
            .clone()
            .unwrap_or_else(|| "created_at".into()),
        sort_dir: intent.sort_dir.clone().unwrap_or_else(|| "desc".into()),
    };
    Ok((query, resolved_tags, warnings))
}

/// 提取分面 top 标签词典（每分面 30 个 + 别名）
pub fn parse_intent(content: &str) -> AppResult<SearchIntent> {
    let trimmed = content.trim();
    let parsed: Option<serde_json::Value> = serde_json::from_str(trimmed).ok().or_else(|| {
        let start = trimmed.find('{')?;
        let end = trimmed.rfind('}')?;
        serde_json::from_str(&trimmed[start..=end]).ok()
    });
    let Some(v) = parsed else {
        return Err(AppError::msg("AI 未返回可解析的 JSON"));
    };
    // 若嵌套在 query 字段（模型偶尔包一层），解一层
    let value = if v.get("query").is_some() && v.get("intent").is_none() {
        v.get("query").cloned().unwrap_or(v)
    } else {
        v
    };
    serde_json::from_value::<SearchIntent>(value)
        .map_err(|e| AppError::msg(format!("AI JSON 校验失败：{e}")))
}

/// 提取分面 top 标签词典（每分面 30 个 + 别名）
pub fn collect_tag_dictionary(
    conn: &Connection,
    facets: &[FacetPromptContext],
) -> AppResult<Vec<String>> {
    let mut dict = Vec::new();
    for f in facets {
        let mut stmt = conn.prepare(
            "SELECT t.name, COALESCE(t.facet_key,'custom'), t.sort_order
               FROM tags t
              WHERE COALESCE(t.facet_key,'custom') = ?1 AND COALESCE(t.status,'active') = 'active'
              ORDER BY t.sort_order, t.id LIMIT 30",
        )?;
        let rows = stmt.query_map([f.key.as_str()], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })?;
        for row in rows {
            let (name, key) = row?;
            dict.push(format!("{name} ({key})"));
        }
    }
    Ok(dict)
}

/// 网络 + 解析 + 校验：由调用方在短锁内收集 facets/dict 后，再在锁外调用本函数。
/// 不持有 DB 锁；text 已由命令层校验长度。
pub fn request_intent(
    cfg: &AiSettings,
    text: &str,
    facets: &[FacetPromptContext],
    dict: &[String],
) -> AppResult<SearchIntent> {
    let profile = cfg
        .active()
        .ok_or_else(|| AppError::msg("请先在设置页添加 API 配置"))?;
    if profile.base_url.trim().is_empty() {
        return Err(AppError::msg("当前 API 配置缺少 base_url"));
    }

    let schema = intent_schema();

    // 组装 prompt（system + user）
    let system = String::from(
        "你是茶包素材库的搜索条件解析器，不是聊天助手。输入是一句自然语言，输出严格 JSON。\
         只使用给定字段（search/assetType/tags/excludeTags/metadata/sortBy/sortDir/concepts/relation/unresolved）。\
         先把一句话拆成原子概念（concepts）：如「红色建筑」→ 建筑(subject) + 红色(color)，\
         每个概念给 role、可选的 facetHint（主体分面/颜色分面等）与 confidence。\
         概念间默认 and（relation=and）；明确的“或”才能 or。\
         标签只写文字和分面key，不写 id、不写 SQL、不写分页。\
         排除表达（不要/排除/除了）进 excludeTags。横图/竖图用 composition 或 aspect_ratio。\
         相对日期依据当前日期。不确定/词典里没有的概念进 unresolved（不进 tags）。\
         只生成查询，不创建标签。",
    );
    let mut user = String::from("标签词典（名称(分面key)）\n");
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
            f.hint
        ));
    }
    user.push_str("\n用户查询：<query>");
    user.push_str(text);
    user.push_str("</query>\n请输出解析结果。");

    // 三级降级请求
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
    let intent = parse_intent(&raw)?;
    validate_intent(&intent, facets)?;
    let _ = tier;
    Ok(intent)
}

pub fn build_explanation(intent: &SearchIntent) -> String {
    let mut parts = Vec::new();
    if let Some(s) = &intent.search {
        if !s.trim().is_empty() {
            parts.push(format!("关键词「{s}」"));
        }
    }
    match intent.asset_type.as_deref() {
        Some("image") => parts.push("图片".into()),
        Some("video") => parts.push("视频".into()),
        _ => {}
    }
    for t in &intent.tags {
        parts.push(format!("含 {}「{}」", t.facet_key, t.text));
    }
    for t in &intent.exclude_tags {
        parts.push(format!("排除「{}」", t.text));
    }
    for m in &intent.metadata {
        parts.push(format!("{} {}", m.key, m.op));
    }
    if parts.is_empty() {
        "未解析出明确条件".into()
    } else {
        format!("筛选{}", parts.join("、"))
    }
}

/// SearchIntent 的 JSON Schema（第 1 级结构化输出用）
fn intent_schema() -> serde_json::Value {
    let nullable_string = serde_json::json!({
        "anyOf": [{"type": "string"}, {"type": "null"}]
    });
    let nullable_number_or_string = serde_json::json!({
        "anyOf": [{"type": "string"}, {"type": "number"}, {"type": "null"}]
    });
    let nullable_asset_type = serde_json::json!({
        "anyOf": [
            {"type": "string", "enum": ["all", "image", "video"]},
            {"type": "null"}
        ]
    });
    serde_json::json!({
        "type": "object",
        "additionalProperties": false,
        "properties": {
            "search": nullable_string,
            "assetType": nullable_asset_type,
            "tags": {"type": "array", "items": {
                "type": "object",
                "additionalProperties": false,
                "properties": {
                    "facetKey": {"type": "string"},
                    "text": {"type": "string"},
                    "includeDescendants": {"type": "boolean"}
                },
                "required": ["facetKey", "text", "includeDescendants"]
            }},
            "excludeTags": {"type": "array", "items": {
                "type": "object",
                "additionalProperties": false,
                "properties": {
                    "facetKey": {"type": "string"},
                    "text": {"type": "string"},
                    "includeDescendants": {"type": "boolean"}
                },
                "required": ["facetKey", "text", "includeDescendants"]
            }},
            "metadata": {"type": "array", "items": {
                "type": "object",
                "additionalProperties": false,
                "properties": {
                    "key": {"type": "string"},
                    "op": {"type": "string"},
                    "value": nullable_number_or_string,
                    "values": {"anyOf": [
                        {"type": "array", "items": {"anyOf": [{"type": "string"}, {"type": "number"}]}},
                        {"type": "null"}
                    ]},
                    "min": nullable_number_or_string,
                    "max": nullable_number_or_string
                },
                "required": ["key", "op", "value", "values", "min", "max"]
            }},
            "sortBy": nullable_string,
            "sortDir": {"anyOf": [
                {"type": "string", "enum": ["asc", "desc"]},
                {"type": "null"}
            ]},
            "concepts": {"type": "array", "items": {
                "type": "object",
                "additionalProperties": false,
                "properties": {
                    "text": {"type": "string"},
                    "role": {"type": "string"},
                    "facetHint": {"anyOf": [{"type": "string"}, {"type": "null"}]},
                    "confidence": {"anyOf": [{"type": "number"}, {"type": "null"}]}
                },
                "required": ["text", "role", "facetHint", "confidence"]
            }},
            "relation": {"anyOf": [
                {"type": "string", "enum": ["and", "or"]},
                {"type": "null"}
            ]},
            "unresolved": {"type": "array", "items": {"type": "string"}}
        },
        "required": ["search", "assetType", "tags", "excludeTags", "metadata", "sortBy", "sortDir", "concepts", "relation", "unresolved"]
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_clean_json() {
        let intent = parse_intent(
            r#"{"search":"海边","assetType":"image","tags":[{"facetKey":"scene","text":"海边"}],
               "metadata":[{"key":"file_size","op":"gte","value":5242880}],
               "sortBy":"resolution","sortDir":"desc"}"#,
        )
        .unwrap();
        assert_eq!(intent.asset_type.as_deref(), Some("image"));
        assert_eq!(intent.tags.len(), 1);
        assert_eq!(intent.metadata.len(), 1);
        assert_eq!(intent.sort_by.as_deref(), Some("resolution"));
    }

    #[test]
    fn parses_noisy_reply_by_slicing() {
        let intent = parse_intent("好的，解析如下：\n{\"assetType\":\"video\"}\n望采纳").unwrap();
        assert_eq!(intent.asset_type.as_deref(), Some("video"));
    }

    #[test]
    fn rejects_garbage() {
        assert!(parse_intent("我无法理解").is_err());
    }

    #[test]
    fn validates_intent_rejects_bad_asset_type() {
        let mut i = SearchIntent::default();
        i.asset_type = Some("banana".into());
        assert!(validate_intent(&i, &[]).is_err());
    }

    #[test]
    fn validates_intent_rejects_bad_sort() {
        let mut i = SearchIntent::default();
        i.sort_by = Some("magic".into());
        assert!(validate_intent(&i, &[]).is_err());
    }

    #[test]
    fn validates_intent_rejects_unknown_metadata_key() {
        let mut i = SearchIntent::default();
        i.metadata.push(MetadataFilter {
            key: "nope".into(),
            op: "eq".into(),
            value: Some(serde_json::json!("x")),
            values: None,
            min: None,
            max: None,
        });
        assert!(validate_intent(&i, &[]).is_err());
    }

    #[test]
    fn validates_intent_accepts_known() {
        let mut i = SearchIntent::default();
        i.asset_type = Some("image".into());
        i.metadata.push(MetadataFilter {
            key: "file_size".into(),
            op: "gte".into(),
            value: Some(serde_json::json!(5)),
            values: None,
            min: None,
            max: None,
        });
        assert!(validate_intent(&i, &[]).is_ok());
    }

    #[test]
    fn intent_schema_is_valid_json() {
        let s = intent_schema();
        assert_eq!(s["type"], "object");
        assert!(s["properties"]["assetType"]["anyOf"].is_array());
    }

    #[test]
    fn validates_dynamic_facet_key_from_prompt_context() {
        let mut intent = SearchIntent::default();
        intent.tags.push(IntentTag {
            facet_key: "new_custom_facet".into(),
            text: "示例".into(),
            include_descendants: true,
        });
        let facets = vec![FacetPromptContext {
            key: "new_custom_facet".into(),
            display_name: "新分面".into(),
            description: String::new(),
            hint: String::new(),
            selection_mode: "multi".into(),
            max_items: Some(3),
        }];
        assert!(validate_intent(&intent, &facets).is_ok());
    }

    // ── §11.2 概念层（Stage 5 / FB-05）──

    #[test]
    fn role_maps_to_facet_hint() {
        assert_eq!(default_facet_hint_for_role("subject"), Some("subject"));
        assert_eq!(default_facet_hint_for_role("颜色"), Some("color"));
        assert_eq!(default_facet_hint_for_role("风格"), Some("style"));
        assert_eq!(default_facet_hint_for_role("unknown_role"), None);
    }

    #[test]
    fn compile_concepts_red_building_produces_two_tags() {
        // 红色建筑 → 主体:建筑 (subject) + 色彩:红色 (color)，全部满足 = and
        let intent = SearchIntent {
            search: None,
            asset_type: None,
            tags: vec![],
            exclude_tags: vec![],
            metadata: vec![],
            sort_by: None,
            sort_dir: None,
            concepts: vec![
                SearchConcept {
                    text: "建筑".into(),
                    role: "subject".into(),
                    facet_hint: Some("subject".into()),
                    confidence: Some(0.95),
                },
                SearchConcept {
                    text: "红色".into(),
                    role: "color".into(),
                    facet_hint: Some("color".into()),
                    confidence: Some(0.92),
                },
            ],
            relation: Some("and".into()),
            unresolved: vec![],
        };
        let (out, warnings) = compile_concepts(intent);
        assert!(warnings.is_empty());
        assert_eq!(out.tags.len(), 2);
        assert_eq!(out.tags[0].facet_key, "subject");
        assert_eq!(out.tags[0].text, "建筑");
        assert_eq!(out.tags[1].facet_key, "color");
        assert_eq!(out.tags[1].text, "红色");
    }

    #[test]
    fn compile_concepts_role_fallback_when_no_hint() {
        let intent = SearchIntent {
            concepts: vec![SearchConcept {
                text: "夜景".into(),
                role: "场景".into(),
                facet_hint: None,
                confidence: Some(0.8),
            }],
            unresolved: vec![],
            ..Default::default()
        };
        let (out, warnings) = compile_concepts(intent);
        assert!(warnings.is_empty());
        // role 「场景」没有 hint → 启发映射到 scene
        assert_eq!(out.tags[0].facet_key, "scene");
    }

    #[test]
    fn compile_concepts_unresolved_goes_into_search_with_warning() {
        let intent = SearchIntent {
            search: Some("".into()),
            unresolved: vec!["蓝天".into()],
            ..Default::default()
        };
        let (out, warnings) = compile_concepts(intent);
        assert_eq!(out.search.as_deref(), Some("蓝天"));
        assert_eq!(warnings.len(), 1);
        assert!(warnings[0].contains("蓝天"));
    }

    #[test]
    fn compile_concepts_dedups_repeated_concepts() {
        let intent = SearchIntent {
            concepts: vec![
                SearchConcept {
                    text: "狗".into(),
                    role: "animal".into(),
                    facet_hint: None,
                    confidence: Some(0.9),
                },
                SearchConcept {
                    text: " 狗 ".into(), // 同义词重复（normalize 后相同）
                    role: "animal".into(),
                    facet_hint: None,
                    confidence: Some(0.7),
                },
            ],
            unresolved: vec![],
            ..Default::default()
        };
        let (out, _) = compile_concepts(intent);
        assert_eq!(out.tags.len(), 1);
    }

    #[test]
    fn intent_schema_has_concept_fields() {
        let s = intent_schema();
        assert!(s["properties"]["concepts"].is_object());
        assert!(s["properties"]["relation"].is_object());
        assert_eq!(s["properties"]["unresolved"]["type"], "array");
        // concepts 的 text/role 必填
        let item = s["properties"]["concepts"]["items"]["properties"].clone();
        assert!(item["text"].is_object());
        assert!(item["role"].is_object());
    }
}
