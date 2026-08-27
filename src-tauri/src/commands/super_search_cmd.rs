//! 超级搜索命令（P3）：AI 自然语言解析为查询意图与执行对象。
//! 薄壳：校验输入长度 → 短锁读配置/分面/标签 → 放锁 → spawn_blocking 网络请求 → 短锁解析 tagId → 返回。

use std::sync::Arc;
use tauri::State;

use crate::db::settings;
use crate::db::tag_facets;
use crate::error::{AppError, AppResult};
use crate::services::super_search_ai;
use crate::services::super_search_ai::{AiSearchParseResult, ResolvedQuery};
use crate::state::AppState;

fn lock_db(
    db: &Arc<std::sync::Mutex<rusqlite::Connection>>,
) -> AppResult<std::sync::MutexGuard<'_, rusqlite::Connection>> {
    db.lock().map_err(|_| AppError::msg("数据库锁中毒"))
}

/// AI 自然语言 → SearchIntent → ResolvedSearchQuery。
/// 输入：text（≤200 字），currentQuery（可选上下文，供后续「在现有结果内继续搜」）。
#[tauri::command]
pub async fn ai_parse_search_query(
    state: State<'_, AppState>,
    text: String,
    current_query: Option<ResolvedQuery>,
) -> AppResult<AiSearchParseResult> {
    let db = Arc::clone(&state.db);
    tauri::async_runtime::spawn_blocking(move || {
        // 1. 校验文本长度
        if text.trim().is_empty() {
            return Err(AppError::msg("请输入搜索描述"));
        }
        if text.chars().count() > super_search_ai::MAX_INPUT_LEN {
            return Err(AppError::msg(format!(
                "查询描述过长（最多 {} 字）",
                super_search_ai::MAX_INPUT_LEN
            )));
        }
        // 3-5. 短锁读取 AI 档案（按用途绑定优先）+ 分面 + 标签词典，读取后立即放锁
        let (cfg, facets, dict) = {
            let conn = lock_db(&db)?;
            let mut s = settings::get_settings(&conn)?;
            if s.ai.active().is_none() {
                return Err(AppError::msg("请先在设置页添加 API 配置（中转站）"));
            }
            // §4.4：超级搜索按用途绑定读取连接档案；无绑定时回退默认 active 档案。
            //         绑定连接含 keyring 密钥解析，共用现有 AI HTTP service。
            let _ = crate::db::ai_connections::apply_usage_binding(&conn, "super_search", &mut s.ai)
                .map_err(|e| {
                    tracing::warn!("超级搜索读取用途绑定失败，回退默认档案: {e}");
                    e
                })?;
            let facets = tag_facets::build_prompt_context(&conn, &s.ai_facet_configs)?;
            let dict = super_search_ai::collect_tag_dictionary(&conn, &facets)?;
            (s.ai, facets, dict)
        };
        // 6. 锁外网络请求 + 解析 + 校验（不持 DB 锁）
        let intent = super_search_ai::request_intent(&cfg, &text, &facets, &dict)?;
        // 7-12. 短锁解析 tagId + 生成 warnings + 组装执行对象（不查回收站）
        let (query, resolved_tags, warnings) = {
            let conn = lock_db(&db)?;
            super_search_ai::resolve_query(&conn, &intent)?
        };
        let explanation = super_search_ai::build_explanation(&intent);
        let _ = current_query;
        Ok(AiSearchParseResult {
            intent,
            query,
            explanation,
            warnings,
            resolved_tags,
        })
    })
    .await
    .map_err(|e| AppError::msg(format!("AI 搜索任务失败: {e}")))?
}
