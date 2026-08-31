//! 超级搜索命令（FB5-05 §9）：AI 自然语言 → SearchIntentV2 → QueryExpr（唯一执行事实源）。
//! 薄壳：校验输入长度 → 短锁读配置/分面/标签 → 放锁 → spawn_blocking 网络请求
//! → 本地守卫 → 短锁生成 expr（标签解析）→ 返回 expr/排序/解释/warnings。

use std::sync::Arc;
use tauri::State;

use crate::db::settings;
use crate::db::tag_facets;
use crate::error::{AppError, AppResult};
use crate::services::super_search_ai;
use crate::services::super_search_ai::{AiSearchParseResult, SearchIntentV2};
use crate::state::AppState;

fn lock_db(
    db: &Arc<std::sync::Mutex<rusqlite::Connection>>,
) -> AppResult<std::sync::MutexGuard<'_, rusqlite::Connection>> {
    db.lock().map_err(|_| AppError::msg("数据库锁中毒"))
}

/// AI 自然语言 → SearchIntentV2（组内 AND、组间 OR）→ 后端生成 QueryExpr。
/// FB5-05（§9.5）：已删除未使用的 current_query 参数——append 由前端明确合并 expr。
#[tauri::command]
pub async fn ai_parse_search_query(
    state: State<'_, AppState>,
    text: String,
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
        // 2. 短锁读取 AI 档案（用途绑定优先）+ 分面 + 标签词典，读取后立即放锁
        let (cfg, facets, dict) = {
            let conn = lock_db(&db)?;
            let mut s = settings::get_settings(&conn)?;
            if s.ai.active().is_none() {
                return Err(AppError::msg("请先在设置页添加 API 配置（中转站）"));
            }
            // §4.4：超级搜索按用途绑定读取连接档案；无绑定时回退默认 active 档案。
            let _ =
                crate::db::ai_connections::apply_usage_binding(&conn, "super_search", &mut s.ai)
                    .map_err(|e| {
                        tracing::warn!("超级搜索读取用途绑定失败，回退默认档案: {e}");
                        e
                    })?;
            let facets = tag_facets::build_prompt_context(&conn, &s.ai_facet_configs)?;
            let dict = super_search_ai::collect_tag_dictionary(&conn, &facets)?;
            (s.ai, facets, dict)
        };
        // 3. 锁外网络请求 + 解析 + 元数据容错降级 + 结构校验（不持 DB 锁）
        let (mut intent, metadata_warnings): (SearchIntentV2, Vec<String>) =
            super_search_ai::request_intent(&cfg, &text, &facets, &dict)?;
        // 4. 本地确定性守卫（§9.3）：OR/assetType/concept 清洗/去重/confidence 钳制
        let mut warnings = super_search_ai::guard_intent(&text, &mut intent);
        warnings.extend(metadata_warnings);
        // 5. 短锁：标签解析 + QueryExpr 生成 + 校验（AI 结果唯一执行事实源）
        let (expr, resolved_tags, resolve_warnings) = {
            let conn = lock_db(&db)?;
            super_search_ai::build_expr_from_v2(&conn, &intent)?
        };
        warnings.extend(resolve_warnings);
        // §9.7：AI 结果通过后本地再校验一次；失败视为解析错误，不应用部分条件
        if let Some(e) = &expr {
            crate::db::query_expr::validate_expr(e)?;
        }
        let explanation = super_search_ai::build_explanation(&intent);
        let sort_by = intent
            .sort_by
            .clone()
            .unwrap_or_else(|| "created_at".into());
        let sort_dir = intent.sort_dir.clone().unwrap_or_else(|| "desc".into());
        Ok(AiSearchParseResult {
            intent,
            expr,
            sort_by,
            sort_dir,
            explanation,
            warnings,
            resolved_tags,
        })
    })
    .await
    .map_err(|e| AppError::msg(format!("AI 搜索任务失败: {e}")))?
}
