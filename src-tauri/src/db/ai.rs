//! AI 打标：批次与建议 CRUD + 确认流（确认才写 asset_tags，防污染标签体系）

use rusqlite::Connection;
use serde::{Deserialize, Serialize};

use super::{asset_tags, tag_facets, tags};
use crate::error::AppResult;

/// 分类标签：{ 分类名: [标签...] }（PRD 5.5；BTreeMap 保证序列化键序稳定）
pub type CategorizedTags = std::collections::BTreeMap<String, Vec<String>>;

/// 宽容解析历史数据：旧格式是扁平数组 → 收进「未分类」；新格式是分类对象
pub fn parse_tags_json(raw: &str) -> CategorizedTags {
    let v: serde_json::Value = serde_json::from_str(raw).unwrap_or_default();
    if let Some(arr) = v.as_array() {
        let tags: Vec<String> = arr
            .iter()
            .filter_map(|t| t.as_str().map(String::from))
            .collect();
        return if tags.is_empty() {
            CategorizedTags::new()
        } else {
            CategorizedTags::from([("未分类".to_string(), tags)])
        };
    }
    serde_json::from_value(v).unwrap_or_default()
}

/// 分类标签写入标签树：分类建/复用父标签，标签建/复用子标签，返回全部子标签 id
fn categorized_tag_ids(conn: &Connection, tags: &CategorizedTags) -> AppResult<Vec<i64>> {
    let mut ids = Vec::new();
    for (category, names) in tags {
        let category = category.trim();
        if category.is_empty() {
            continue;
        }
        // W2-10：分面 key 路由唯一入口 —— DB 有该 key（自建分面）原样用；
        // 中文旧名命中映射；都不中落 custom。旧代码直接查映射表，自建分面永远落 custom。
        let (facet_key, _resolved) = tag_facets::resolve_facet_key(conn, category)?;
        for name in names {
            let name = name.trim();
            if !name.is_empty() {
                // 旧 AI 协议传中文分类名时保留根节点兼容；新协议传稳定 facet key 时直接创建规范标签。
                if category.trim() == facet_key {
                    ids.push(tags::find_or_create_canonical(conn, &facet_key, name)?);
                } else {
                    let parent = tags::find_or_create_facet_root(conn, &facet_key, category)?;
                    ids.push(tags::find_or_create_child(conn, parent, name)?);
                }
            }
        }
    }
    Ok(ids)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiBatch {
    pub id: i64,
    pub status: String, // pending|processing|done|cancelled
    pub mode: String,   // cloud|local
    pub total: i64,
    pub processed: i64,
    pub confirmed: i64,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiSuggestion {
    pub id: i64,
    pub batch_id: i64,
    pub asset_id: i64,
    pub asset_path: String,
    /// B-3/B-4：素材 MIME（供前端判断批次是否含视频、是否需提示开启视频打标）
    pub mime_type: Option<String>,
    pub suggested_tags: CategorizedTags,
    pub status: String, // pending|confirmed|rejected|modified
    pub confirmed_tags: CategorizedTags,
    /// 单条打标失败原因（v6：失败详情落库，前端可展示，不再只看到 rejected）
    pub last_error: Option<String>,
    pub created_at: i64,
    // FB5-05（§7.6）：一句话描述。AI 建议值 / 审核后确认值 / 素材当前值。
    #[serde(default)]
    pub suggested_description: String,
    pub confirmed_description: Option<String>,
    #[serde(default)]
    pub current_description: String,
}

fn batch_from_row(r: &rusqlite::Row) -> rusqlite::Result<AiBatch> {
    Ok(AiBatch {
        id: r.get(0)?,
        status: r.get(1)?,
        mode: r.get(2)?,
        total: r.get(3)?,
        processed: r.get(4)?,
        confirmed: r.get(5)?,
        created_at: r.get(6)?,
    })
}

const BATCH_COLS: &str = "id, status, mode, total, processed, confirmed, created_at";

pub fn create_batch(conn: &Connection, asset_ids: &[i64], mode: &str) -> AppResult<AiBatch> {
    let now = chrono::Utc::now().timestamp_millis();
    let tx = conn.unchecked_transaction()?;
    // W5h-c：同源组内只保留一个代表（非 RAW 优先——JPG 有内嵌预览、解码快）。
    // 代表确认后标签经 assign_inner 自动同步给 RAW → 最终两条都有标签。
    // 批次 total 记去重后数量（与 ai_suggestions 行数一致）。
    // 复用 sync_tags_to_siblings 同一开关：关掉则不去重不同步（回到独立行为）。
    let effective_ids: Vec<i64> = {
        let sync = super::settings::get_settings(&tx)
            .map(|s| s.appearance.kinship.sync_tags_to_siblings)
            .unwrap_or(true);
        if !sync {
            asset_ids.to_vec()
        } else {
            // 读全部 (id, file_path)，按 kinship_key 分组，每组保留非 RAW（若无非 RAW 保留第一个）
            let mut stmt = tx.prepare(
                "SELECT id, file_path FROM assets WHERE deleted_at IS NULL",
            )?;
            let rows: Vec<(i64, String)> = stmt
                .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
                .filter_map(|r| r.ok())
                .collect();
            drop(stmt);
            let path_by_id: std::collections::HashMap<i64, &str> =
                rows.iter().map(|(id, p)| (*id, p.as_str())).collect();
            let mut group_best: std::collections::HashMap<String, i64> = Default::default();
            for (id, path) in &rows {
                let (key, is_raw) = crate::services::kinship::kinship_key(path);
                let selected = asset_ids.contains(id);
                if !selected {
                    continue;
                }
                match group_best.get(&key) {
                    Some(&cur) => {
                        // 已有代表：非 RAW 优先替换
                        let cur_raw = path_by_id
                            .get(&cur)
                            .map(|p| crate::services::kinship::kinship_key(p).1)
                            .unwrap_or(false);
                        if cur_raw && !is_raw {
                            group_best.insert(key, *id);
                        }
                    }
                    None => {
                        group_best.insert(key, *id);
                    }
                }
            }
            // 保持用户传入顺序（去重不重排）
            asset_ids
                .iter()
                .copied()
                .filter(|id| group_best.values().any(|v| v == id))
                .collect()
        }
    };
    tx.execute(
        "INSERT INTO ai_batches (status, mode, total, created_at) VALUES ('pending', ?1, ?2, ?3)",
        rusqlite::params![mode, effective_ids.len() as i64, now],
    )?;
    let batch_id = tx.last_insert_rowid();
    for &aid in &effective_ids {
        tx.execute(
            "INSERT INTO ai_suggestions (batch_id, asset_id, suggested_tags, created_at)
             VALUES (?1, ?2, '[]', ?3)",
            rusqlite::params![batch_id, aid, now],
        )?;
    }
    tx.commit()?;
    get_batch(conn, batch_id)
}

pub fn get_batch(conn: &Connection, id: i64) -> AppResult<AiBatch> {
    Ok(conn.query_row(
        &format!("SELECT {BATCH_COLS} FROM ai_batches WHERE id = ?1"),
        [id],
        batch_from_row,
    )?)
}

pub fn list_batches(conn: &Connection) -> AppResult<Vec<AiBatch>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {BATCH_COLS} FROM ai_batches ORDER BY id DESC"
    ))?;
    let rows = stmt
        .query_map([], batch_from_row)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

pub fn set_batch_status(conn: &Connection, id: i64, status: &str) -> AppResult<()> {
    conn.execute(
        "UPDATE ai_batches SET status = ?1 WHERE id = ?2",
        rusqlite::params![status, id],
    )?;
    Ok(())
}

/// 应用启动/任务中断时：把遗留的 processing 批次置为 interrupted（指导书阶段 5 §8.2）。
/// 允许一键续跑剩余 pending（避免僵尸 processing 态无法重试）。
pub fn mark_interrupted_batches(conn: &Connection) -> AppResult<()> {
    conn.execute(
        "UPDATE ai_batches SET status = 'interrupted' WHERE status = 'processing'",
        [],
    )?;
    Ok(())
}

pub fn inc_batch_processed(conn: &Connection, id: i64) -> AppResult<()> {
    conn.execute(
        "UPDATE ai_batches SET processed = processed + 1 WHERE id = ?1",
        [id],
    )?;
    Ok(())
}

/// FB5-05（§7.6）：写/覆盖某条建议的 AI 候选结果（标签 + 一句话描述）。
/// tagging_service 用；描述为空也照写（空描述不导致有效标签整条失败）。
pub fn set_suggestion_result(
    conn: &Connection,
    id: i64,
    tags: &CategorizedTags,
    description: &str,
) -> AppResult<()> {
    set_suggestion_tags(conn, id, tags)?;
    conn.execute(
        "UPDATE ai_suggestions SET suggested_description = ?1 WHERE id = ?2",
        rusqlite::params![description, id],
    )?;
    Ok(())
}

/// 写/覆盖某条建议的 AI 候选标签（tagging_service 用，T05；描述由 set_suggestion_result 一并写）
pub fn set_suggestion_tags(conn: &Connection, id: i64, tags: &CategorizedTags) -> AppResult<()> {
    conn.execute(
        "UPDATE ai_suggestions SET suggested_tags = ?1 WHERE id = ?2",
        rusqlite::params![serde_json::to_string(tags)?, id],
    )?;
    conn.execute(
        "DELETE FROM ai_suggestion_items WHERE suggestion_id = ?1",
        [id],
    )?;
    let now = chrono::Utc::now().timestamp_millis();
    for (category, names) in tags {
        let (facet_key, _resolved) = tag_facets::resolve_facet_key(conn, category)?;
        for name in names {
            // W5a（a9）：支持置信度内联格式 {"t":"标签","c":0.9}（纯字符串回退，提示词两种都允许）
            let (raw, confidence): (String, Option<f64>) =
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(name.trim()) {
                    let t = v.get("t").and_then(|t| t.as_str()).unwrap_or("").trim().to_string();
                    let c = v.get("c").and_then(|c| c.as_f64());
                    (t, c)
                } else {
                    (name.trim().to_string(), None)
                };
            if raw.is_empty() {
                continue;
            }
            let normalized = tags::normalize_name(&raw);
            // F3-a：tag_id 反查收敛到 find_by_term（mode=Alias）—— 消灭自写 SQL +
            // ORDER BY t.is_system DESC 兜底；find_by_term 内部按 feature gate 走
            // tag_terms（唯一索引保证最多一行）或旧表。
            let mut decision_reason: Option<String> = None;
            let tag_id: Option<i64> = tags::find_by_term(conn, &facet_key, &normalized, tags::TermMatch::Alias)
                .ok()
                .and_then(|l| l.hits.into_iter().next())
                .map(|h| h.tag_id);
            // F6-b：词表里没有精确命中 → 近似匹配「只提示，不自动改写」——
            // 命中写入 decision_reason（tag_id 仍为 NULL，候选留在 ai_suggestion_items）
            if tag_id.is_none() {
                if let Some((_, owner, reason)) =
                    tags::find_similar_tag(conn, &facet_key, &normalized)?
                {
                    decision_reason = Some(match reason {
                        tags::SimilarReason::Substring => format!("疑似与「{owner}」重复"),
                        tags::SimilarReason::Spell => format!("拼写相近：「{owner}」"),
                    });
                }
            }
            conn.execute(
                "INSERT INTO ai_suggestion_items
                 (suggestion_id, facet_key, raw_name, normalized_name, tag_id, confidence, decision, decision_reason, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'pending', ?7, ?8)",
                rusqlite::params![id, facet_key, raw, normalized, tag_id, confidence, decision_reason, now],
            )?;
        }
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiSuggestionItem {
    pub id: i64,
    pub suggestion_id: i64,
    pub facet_key: String,
    pub raw_name: String,
    pub normalized_name: String,
    pub tag_id: Option<i64>,
    pub confidence: Option<f64>,
    pub decision: String,
    pub decision_reason: Option<String>,
    pub created_at: i64,
}

fn suggestion_from_row(r: &rusqlite::Row) -> rusqlite::Result<AiSuggestion> {
    let suggested: String = r.get(4)?;
    let confirmed: Option<String> = r.get(6)?;
    let last_error: Option<String> = r.get(8)?;
    Ok(AiSuggestion {
        id: r.get(0)?,
        batch_id: r.get(1)?,
        asset_id: r.get(2)?,
        asset_path: r.get(3)?,
        mime_type: r.get(9)?,
        suggested_tags: parse_tags_json(&suggested),
        status: r.get(5)?,
        confirmed_tags: confirmed.map(|s| parse_tags_json(&s)).unwrap_or_default(),
        last_error,
        created_at: r.get(7)?,
        // FB5-05（§7.6）：suggested_description(10) / confirmed_description(11) / current_description(12)
        suggested_description: r.get(10)?,
        confirmed_description: r.get(11)?,
        current_description: r.get(12)?,
    })
}

const SUGG_COLS: &str = "s.id, s.batch_id, s.asset_id, a.file_path, s.suggested_tags, s.status, \
                         s.confirmed_tags, s.created_at, s.last_error, a.mime_type, \
                         s.suggested_description, s.confirmed_description, a.content_description";

pub fn list_suggestions(conn: &Connection, batch_id: i64) -> AppResult<Vec<AiSuggestion>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {SUGG_COLS} FROM ai_suggestions s JOIN assets a ON a.id = s.asset_id
          WHERE s.batch_id = ?1 ORDER BY s.id"
    ))?;
    let rows = stmt
        .query_map([batch_id], suggestion_from_row)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

pub fn list_suggestion_items(
    conn: &Connection,
    suggestion_id: i64,
) -> AppResult<Vec<AiSuggestionItem>> {
    let mut stmt = conn.prepare(
        "SELECT id, suggestion_id, facet_key, raw_name, normalized_name, tag_id,
                confidence, decision, decision_reason, created_at
           FROM ai_suggestion_items
          WHERE suggestion_id = ?1 ORDER BY id",
    )?;
    let rows = stmt
        .query_map([suggestion_id], |r| {
            Ok(AiSuggestionItem {
                id: r.get(0)?,
                suggestion_id: r.get(1)?,
                facet_key: r.get(2)?,
                raw_name: r.get(3)?,
                normalized_name: r.get(4)?,
                tag_id: r.get(5)?,
                confidence: r.get(6)?,
                decision: r.get(7)?,
                decision_reason: r.get(8)?,
                created_at: r.get(9)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

/// F6-d：全库「新词待确认」候选 —— decision='pending' 且 tag_id IS NULL 的条目
/// （词表里没有的词，留在 ai_suggestion_items；设置页据此列出三动作：采纳/合并/拒绝）。
pub fn list_new_word_candidates(conn: &Connection) -> AppResult<Vec<AiSuggestionItem>> {
    let mut stmt = conn.prepare(
        "SELECT id, suggestion_id, facet_key, raw_name, normalized_name, tag_id,
                confidence, decision, decision_reason, created_at
           FROM ai_suggestion_items
          WHERE decision = 'pending' AND tag_id IS NULL
          ORDER BY created_at DESC, id",
    )?;
    let rows = stmt
        .query_map([], |r| {
            Ok(AiSuggestionItem {
                id: r.get(0)?,
                suggestion_id: r.get(1)?,
                facet_key: r.get(2)?,
                raw_name: r.get(3)?,
                normalized_name: r.get(4)?,
                tag_id: r.get(5)?,
                confidence: r.get(6)?,
                decision: r.get(7)?,
                decision_reason: r.get(8)?,
                created_at: r.get(9)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

fn tag_matches_facet(conn: &Connection, tag_id: i64, facet_key: &str) -> AppResult<bool> {
    let found: Option<String> = conn
        .query_row(
            "SELECT facet_key FROM tags WHERE id = ?1 AND status = 'active'",
            [tag_id],
            |r| r.get(0),
        )
        .ok();
    Ok(found.as_deref() == Some(facet_key))
}

/// 逐条处理候选项。这个接口只改变候选审计状态，不提前把标签写入素材；
/// 整条建议仍需通过 confirm_suggestion 才会落入 asset_tags。
pub fn decide_suggestion_item(
    conn: &Connection,
    item_id: i64,
    decision: &str,
    replacement_tag_id: Option<i64>,
    replacement_name: Option<&str>,
    reason: Option<&str>,
) -> AppResult<()> {
    if !matches!(decision, "accepted" | "modified" | "rejected") {
        return Err(crate::error::AppError::msg("无效的候选决策"));
    }
    let tx = conn.unchecked_transaction()?;
    let (facet_key, current_tag_id, raw_name): (String, Option<i64>, String) = tx.query_row(
        "SELECT facet_key, tag_id, raw_name FROM ai_suggestion_items WHERE id = ?1",
        [item_id],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
    )?;
    let merge_name: Option<String> = replacement_name
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(String::from);
    let tag_id = match decision {
        "rejected" => None,
        "accepted" => {
            // 采纳：已选规范标签 → 用它；否则用名称（新词 → find_or_create_canonical 真建标签）
            if let Some(id) = replacement_tag_id.or(current_tag_id) {
                if !tag_matches_facet(&tx, id, &facet_key)? {
                    return Err(crate::error::AppError::msg("候选标签与分面不匹配"));
                }
                Some(id)
            } else if let Some(name) = merge_name.clone().or_else(|| {
                let r = raw_name.trim();
                if r.is_empty() { None } else { Some(r.to_string()) }
            }) {
                Some(tags::find_or_create_canonical(&tx, &facet_key, &name)?)
            } else {
                return Err(crate::error::AppError::msg(
                    "采纳为新词需要有效名称",
                ));
            }
        }
        "modified" => {
            if let Some(id) = replacement_tag_id {
                if !tag_matches_facet(&tx, id, &facet_key)? {
                    return Err(crate::error::AppError::msg("替换标签与分面不匹配"));
                }
                // F6-a/F6-c：用户「合并到已有词」——给目标标签补 synonym 别名（候选词 =
                // 语义等价词，永久可搜；不是 old_name）。撞词（已被占用）静默跳过，不阻断合并。
                let alias_src = raw_name.trim();
                if !alias_src.is_empty() {
                    let _ = tags::add_alias(&tx, id, alias_src, None, "synonym");
                }
                Some(id)
            } else if let Some(name) = merge_name {
                Some(tags::find_or_create_canonical(&tx, &facet_key, &name)?)
            } else {
                return Err(crate::error::AppError::msg(
                    "修改候选时必须提供规范标签或名称",
                ));
            }
        }
        _ => unreachable!(),
    };
    tx.execute(
        "UPDATE ai_suggestion_items
            SET tag_id = ?1, decision = ?2, decision_reason = ?3
          WHERE id = ?4",
        rusqlite::params![tag_id, decision, reason, item_id],
    )?;
    tx.commit()?;
    Ok(())
}

/// 确认建议（内部版，不开事务）：供外层已开事务的调用方使用（confirm_all_pending）
/// B20：拆出 inner 版，与 asset_tags::assign / assign_inner 模式一致
/// FB5-05（§7.6）：description = 审核后的最终描述值；非空 → 同一事务内写入
/// assets.content_description + confirmed_description；空 → 只记 confirmed_description=NULL，
/// 不覆盖素材已有描述（「新建议描述为空：保留素材已有」）。
fn confirm_suggestion_inner(
    conn: &Connection,
    id: i64,
    tags: &CategorizedTags,
    description: Option<&str>,
) -> AppResult<()> {
    let (asset_id, batch_id, mode, status): (i64, i64, String, String) = conn.query_row(
        "SELECT s.asset_id, s.batch_id, b.mode, s.status FROM ai_suggestions s
         JOIN ai_batches b ON b.id = s.batch_id WHERE s.id = ?1",
        [id],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
    )?;
    // 幂等守卫：已确认的建议重复调用直接返回，防止 ai_batches.confirmed 计数虚增
    if status == "confirmed" {
        return Ok(());
    }
    let source = if mode == "cloud" {
        "ai_cloud"
    } else {
        "ai_local"
    };

    let tag_ids = categorized_tag_ids(conn, tags)?;
    let final_pairs: Vec<(String, String, i64)> = tags
        .iter()
        .flat_map(|(category, names)| {
            let facet_key = tag_facets::resolve_facet_key(conn, category)
                .map(|(k, _)| k)
                .unwrap_or_else(|_| "custom".to_string());
            names.iter().filter_map(move |name| {
                let normalized = tags::normalize_name(name);
                if normalized.is_empty() { return None; }
                // F3-a：反查收敛到 find_by_term（mode=Alias）。不需要「跳转」逻辑 ——
                // 合并时旧词已永久归属目标标签，find_by_term 命中即正确 tag。
                let id = tags::find_by_term(conn, &facet_key, &normalized, tags::TermMatch::Alias)
                    .ok()
                    .and_then(|l| l.hits.into_iter().next())
                    .map(|h| h.tag_id)?;
                Some((facet_key.clone(), normalized, id))
            })
        })
        .collect();
    asset_tags::assign_inner(conn, &[asset_id], &tag_ids, source, Some(batch_id))?;
    let original: String = conn.query_row(
        "SELECT suggested_tags FROM ai_suggestions WHERE id = ?1",
        [id],
        |r| r.get(0),
    )?;
    let status = if parse_tags_json(&original) == *tags {
        "confirmed"
    } else {
        "modified"
    };
    conn.execute(
        "UPDATE ai_suggestions SET status = ?1, confirmed_tags = ?2 WHERE id = ?3",
        rusqlite::params![status, serde_json::to_string(tags)?, id],
    )?;
    // FB5-05（§7.6）：同一事务内写描述（确认标签 + 描述原子落库）
    match description.map(str::trim).filter(|d| !d.is_empty()) {
        Some(desc) => {
            conn.execute(
                "UPDATE assets SET content_description = ?1 WHERE id = ?2",
                rusqlite::params![desc, asset_id],
            )?;
            conn.execute(
                "UPDATE ai_suggestions SET confirmed_description = ?1 WHERE id = ?2",
                rusqlite::params![desc, id],
            )?;
        }
        None => {
            conn.execute(
                "UPDATE ai_suggestions SET confirmed_description = NULL WHERE id = ?1",
                [id],
            )?;
        }
    }
    conn.execute(
        "UPDATE ai_batches SET confirmed = confirmed + 1 WHERE id = ?1",
        [batch_id],
    )?;
    let items = list_suggestion_items(conn, id)?;
    for item in items {
        if item.decision != "pending" {
            continue;
        }
        if let Some((_, _, tag_id)) = final_pairs.iter().find(|(facet, normalized, _)| {
            facet == &item.facet_key && normalized == &item.normalized_name
        }) {
            conn.execute(
                "UPDATE ai_suggestion_items SET decision='accepted', decision_reason='confirmed', tag_id=?1 WHERE id=?2",
                rusqlite::params![tag_id, item.id],
            )?;
        } else {
            conn.execute(
                "UPDATE ai_suggestion_items SET decision='rejected', decision_reason='removed during review' WHERE id=?1",
                [item.id],
            )?;
        }
    }
    for (facet, normalized, tag_id) in &final_pairs {
        let exists: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM ai_suggestion_items WHERE suggestion_id=?1 AND facet_key=?2 AND normalized_name=?3)",
            rusqlite::params![id, facet, normalized],
            |r| r.get(0),
        )?;
        if !exists {
            let now = chrono::Utc::now().timestamp_millis();
            conn.execute(
                "INSERT INTO ai_suggestion_items
                 (suggestion_id, facet_key, raw_name, normalized_name, tag_id, decision, decision_reason, created_at)
                 SELECT ?1, ?2, t.name, ?3, ?4, 'modified', 'added during review', ?5 FROM tags t WHERE t.id=?4",
                rusqlite::params![id, facet, normalized, tag_id, now],
            )?;
        }
    }
    Ok(())
}

/// 确认建议：tags 为最终确认值（含人工修改）；写入 asset_tags 并联动批次计数。
/// FB5-05（§7.6）：description 为审核后的最终描述（None = 不修改描述）。
/// B20：公开版开单事务调 inner
pub fn confirm_suggestion_with_description(
    conn: &Connection,
    id: i64,
    tags: &CategorizedTags,
    description: Option<&str>,
) -> AppResult<()> {
    let tx = conn.unchecked_transaction()?;
    confirm_suggestion_inner(&tx, id, tags, description)?;
    tx.commit()?;
    Ok(())
}

/// 确认建议（不传描述，等价于 description=None）：兼容既有调用方
pub fn confirm_suggestion(conn: &Connection, id: i64, tags: &CategorizedTags) -> AppResult<()> {
    confirm_suggestion_with_description(conn, id, tags, None)
}

/// 批量套用标签到任意素材（PRD 5.3：胶片条多选套用；来源 manual）
pub fn apply_tags(conn: &Connection, asset_ids: &[i64], tags: &CategorizedTags) -> AppResult<()> {
    if asset_ids.is_empty() {
        return Ok(());
    }
    let tx = conn.unchecked_transaction()?;
    let tag_ids = categorized_tag_ids(&tx, tags)?;
    asset_tags::assign_inner(&tx, asset_ids, &tag_ids, "manual", None)?;
    tx.commit()?;
    Ok(())
}

/// 撤销拒绝（v2.11）：已拒绝建议恢复为待确认，防误触
pub fn restore_suggestion(conn: &Connection, id: i64) -> AppResult<()> {
    conn.execute(
        "UPDATE ai_suggestions SET status = 'pending' WHERE id = ?1 AND status = 'rejected'",
        rusqlite::params![id],
    )?;
    conn.execute(
        "UPDATE ai_suggestion_items SET decision = 'pending', decision_reason = NULL
          WHERE suggestion_id = ?1 AND decision = 'rejected'",
        [id],
    )?;
    Ok(())
}

/// 记录单条建议打标失败原因（v6）：失败详情落库，前端可展示
pub fn set_suggestion_error(conn: &Connection, id: i64, error: &str) -> AppResult<()> {
    conn.execute(
        "UPDATE ai_suggestions SET last_error = ?1 WHERE id = ?2",
        rusqlite::params![error, id],
    )?;
    Ok(())
}

pub fn reject_suggestion(conn: &Connection, id: i64) -> AppResult<()> {
    let tx = conn.unchecked_transaction()?;
    tx.execute(
        "UPDATE ai_suggestions SET status = 'rejected' WHERE id = ?1",
        [id],
    )?;
    tx.execute(
        "UPDATE ai_suggestion_items SET decision='rejected', decision_reason='suggestion rejected'
          WHERE suggestion_id=?1 AND decision='pending'",
        [id],
    )?;
    tx.commit()?;
    Ok(())
}

/// 批量确认某批次全部 pending 建议（按 AI 原建议写入）
/// B20：外层包裹单事务，保证原子性（部分失败整批回滚）
/// B-2：只处理解析后标签非空的建议——历史数据可能有 `{}`、空数组或空白 JSON，
///     不能只依赖 SQL 字符串比较；空建议不写入、不虚增批次 confirmed 计数。
/// FB5-05（§7.6）：逐条应用各自描述（不得把第一张描述套给整批）；描述为空 → 保留素材已有描述。
pub fn confirm_all_pending(conn: &Connection, batch_id: i64) -> AppResult<()> {
    let pendings: Vec<(i64, CategorizedTags, Option<String>)> = {
        let mut stmt = conn.prepare(
            "SELECT id, suggested_tags, suggested_description
               FROM ai_suggestions WHERE batch_id = ?1 AND status = 'pending'",
        )?;
        let rows = stmt
            .query_map([batch_id], |r| {
                let raw: String = r.get(1)?;
                let desc: String = r.get(2)?;
                let desc_opt = if desc.trim().is_empty() {
                    None
                } else {
                    Some(desc)
                };
                Ok((r.get::<_, i64>(0)?, parse_tags_json(&raw), desc_opt))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        rows
    };
    // B-2：过滤解析后的空标签建议（不把无内容的建议误写成 confirmed）
    let pendings: Vec<(i64, CategorizedTags, Option<String>)> = pendings
        .into_iter()
        .filter(|(_, tags, _)| !tags.is_empty())
        .collect();
    // B-2：没有可确认项目时返回成功空操作，不把批次错误计数
    if pendings.is_empty() {
        return Ok(());
    }
    // B20：外层单事务，部分失败整批回滚
    let tx = conn.unchecked_transaction()?;
    for (id, tags, desc) in pendings {
        confirm_suggestion_inner(&tx, id, &tags, desc.as_deref())?;
    }
    tx.commit()?;
    Ok(())
}
