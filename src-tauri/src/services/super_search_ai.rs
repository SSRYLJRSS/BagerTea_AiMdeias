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

/// 解析单条标签条件，返回 (resolved, warning)
fn resolve_tag_condition(
    conn: &Connection,
    t: &IntentTag,
) -> AppResult<(Option<ResolvedTag>, Option<String>)> {
    // 未指定 facet_key 时：全分面搜索；仍按精确优先、唯一候选采用的策略
    if t.facet_key.is_empty() {
        let candidates = tags::search_candidates(conn, None, &t.text)?;
        let exact = candidates.iter().find(|c| {
            c.normalized_name == tags::normalize_name(&t.text)
                || c.aliases
                    .iter()
                    .any(|a| tags::normalize_name(a) == tags::normalize_name(&t.text))
        });
        let picked = exact.or_else(|| {
            if candidates.len() == 1 {
                candidates.first()
            } else {
                None
            }
        });
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

/// SearchIntent → ResolvedQuery（标签解析 + 未知/歧义 warning；强制不查回收站）。
pub fn resolve_query(
    conn: &Connection,
    intent: &SearchIntent,
) -> AppResult<(ResolvedQuery, Vec<ResolvedTag>, Vec<String>)> {
    let mut warnings = Vec::new();
    let mut resolved_tags = Vec::new();
    let mut facet_filters: Vec<ResolvedFacet> = Vec::new();
    let mut exclude_tag_ids: Vec<i64> = Vec::new();

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
        missing_facet_keys: Vec::new(),
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
         只使用给定字段（search/assetType/tags/excludeTags/metadata/sortBy/sortDir）。\
         标签只写文字和分面key，不写 id、不写 SQL、不写分页。\
         排除表达（不要/排除/除了）进 excludeTags。横图/竖图用 composition 或 aspect_ratio。\
         相对日期依据当前日期。不确定的概念放进 search。只生成查询，不创建标签。",
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
            ]}
        },
        "required": ["search", "assetType", "tags", "excludeTags", "metadata", "sortBy", "sortDir"]
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
}
