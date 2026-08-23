//! AI 打标命令（T05a）：批次创建/执行/取消 + 建议确认流

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use tauri::{AppHandle, Emitter, State};

use crate::db::ai::{AiBatch, AiSuggestion, CategorizedTags};
use crate::db::{ai, settings};
use crate::error::{AppError, AppResult};
use crate::services::ai_cloud::{self, AiProgress};
use crate::state::AppState;

fn lock_db(state: &AppState) -> AppResult<std::sync::MutexGuard<'_, rusqlite::Connection>> {
    state.db.lock().map_err(|_| AppError::msg("数据库锁中毒"))
}

/// 拉取服务商可用模型列表（网络请求走 spawn_blocking，不堵主线程）
#[tauri::command]
pub async fn ai_list_models(
    base_url: String,
    api_key: String,
    api_mode: String,
) -> AppResult<Vec<String>> {
    tauri::async_runtime::spawn_blocking(move || {
        ai_cloud::list_models(&base_url, &api_key, &api_mode)
    })
    .await
    .map_err(|e| AppError::msg(format!("模型列表任务失败: {e}")))?
}

/// 用选中素材创建批次（pending 建议占位）
/// mode：cloud/local/manual/auto（auto = 按激活档案 kind 解析，P3-01a）
#[tauri::command]
pub fn ai_create_batch(
    state: State<AppState>,
    asset_ids: Vec<i64>,
    mode: String,
) -> AppResult<AiBatch> {
    if asset_ids.is_empty() {
        return Err(AppError::msg("未选择任何素材"));
    }
    if !["cloud", "local", "manual", "auto"].contains(&mode.as_str()) {
        return Err(AppError::msg("非法打标模式"));
    }
    let conn = lock_db(&state)?;
    let s = settings::get_settings(&conn)?;
    // auto/cloud 统一按激活档案 kind 落实际模式：本地档案 → local，否则 cloud
    let mode = if mode == "manual" {
        mode
    } else {
        match s.ai.active().map(|p| p.is_local()).unwrap_or(false) {
            true => "local".to_string(),
            false => "cloud".to_string(),
        }
    };
    // 批量上限（PRD 风险控制：防 API 成本失控）
    let limit = s.ai.batch_limit;
    let ids: Vec<i64> = asset_ids.into_iter().take(limit.max(1) as usize).collect();
    ai::create_batch(&conn, &ids, &mode)
}

/// 执行批次（云端）：spawn_blocking 工作线程跑，进度走 ai://progress 事件；
/// 预检短锁即用即放，批次执行期间不持 DB 锁（网络等待不阻塞全应用 DB 读写）
#[tauri::command]
pub async fn ai_start_batch(
    app: AppHandle,
    state: State<'_, AppState>,
    batch_id: i64,
    limit: Option<i64>,
) -> AppResult<AiBatch> {
    let db = std::sync::Arc::clone(&state.db);
    let registry = std::sync::Arc::clone(&state.ai_cancel);
    let cancel = Arc::new(AtomicBool::new(false));

    tauri::async_runtime::spawn_blocking(move || {
        // 预检与配置读取：短锁作用域，读完即放
        let all = {
            let conn = db.lock().map_err(|_| AppError::msg("数据库锁中毒"))?;
            let batch = ai::get_batch(&conn, batch_id)?;
            // 手动模式（v2.10）：不请求 AI，批次直接就绪，pending 建议留待人工编辑
            if batch.mode == "manual" {
                ai::set_batch_status(&conn, batch_id, "done")?;
                return ai::get_batch(&conn, batch_id);
            }
            // v2.12：仅执行中拒绝；done/cancelled 允许续跑剩余 pending 建议
            if batch.status == "processing" {
                return Err(AppError::msg("批次正在执行中"));
            }
            // F15a（2026-08-22）：待打标 = pending 且尚无候选（set_suggestion_tags 不改 status，
            // 只看 status 会把「已生成候选未确认」的条目误判为待处理 → 续跑重复请求）
            let has_pending = ai::list_suggestions(&conn, batch_id)?
                .iter()
                .any(|s| s.status == "pending" && s.suggested_tags.is_empty());
            if !has_pending {
                return Err(AppError::msg("当前没有待打标的建议（已全部处理或确认）"));
            }
            let s = settings::get_settings(&conn)?;
            // P3-01a：本地批次要求激活档案为本地端点（cloud/local 管线同构，只做一致性校验）
            let profile_is_local = s.ai.active().map(|p| p.is_local()).unwrap_or(false);
            if batch.mode == "local" && !profile_is_local {
                return Err(AppError::msg(
                    "该批次为本地打标：请在设置页把激活档案切换为本地端点（kind=本地，如 Ollama）后重试",
                ));
            }
            s
        };
        let cfg = all.ai;
        let categories = all.tag_categories;
        registry
            .lock()
            .map_err(|_| AppError::msg("锁中毒"))?
            .insert(batch_id, Arc::clone(&cancel));

        let r = ai_cloud::run_cloud_batch(&db, batch_id, &cfg, &categories, limit, &cancel, |p: AiProgress| {
            let _ = app.emit("ai://progress", p);
        });
        // B12：收尾清理 flag——锁中毒不再静默吞
        match registry.lock() {
            Ok(mut m) => {
                m.remove(&batch_id);
            }
            Err(_) => tracing::error!("取消注册表锁中毒，batch {} 的 flag 未清理", batch_id),
        }
        if let Err(e) = r {
            // 批次级异常（DB/配置等）收尾：置 cancelled 防卡死在 processing 无法重试
            // （单条失败已在 run_cloud_batch 内部置 rejected，不进这里）
            tracing::warn!("批次 {} 执行异常，标记 cancelled: {e}", batch_id);
            if let Ok(conn) = db.lock() {
                let _ = ai::set_batch_status(&conn, batch_id, "cancelled");
            }
            return Err(e);
        }
        let conn = db.lock().map_err(|_| AppError::msg("数据库锁中毒"))?;
        ai::get_batch(&conn, batch_id)
    })
    .await
    .map_err(|e| AppError::msg(format!("打标线程异常: {e}")))?
}

#[tauri::command]
pub fn ai_cancel_batch(state: State<AppState>, batch_id: i64) -> AppResult<()> {
    // B11：不再静默吞锁中毒
    let m = state
        .ai_cancel
        .lock()
        .map_err(|_| AppError::msg("取消注册表锁中毒，无法取消任务"))?;
    if let Some(flag) = m.get(&batch_id) {
        flag.store(true, Ordering::Relaxed);
    }
    Ok(())
}

#[tauri::command]
pub fn ai_list_batches(state: State<AppState>) -> AppResult<Vec<AiBatch>> {
    let conn = lock_db(&state)?;
    ai::list_batches(&conn)
}

#[tauri::command]
pub fn ai_list_suggestions(state: State<AppState>, batch_id: i64) -> AppResult<Vec<AiSuggestion>> {
    let conn = lock_db(&state)?;
    ai::list_suggestions(&conn, batch_id)
}

/// 确认单条建议（tags 为最终值，含人工修改）
#[tauri::command]
pub fn ai_confirm_suggestion(
    state: State<AppState>,
    id: i64,
    tags: CategorizedTags,
) -> AppResult<()> {
    let conn = lock_db(&state)?;
    ai::confirm_suggestion(&conn, id, &tags)
}

/// 撤销拒绝（v2.11）：恢复为待确认
#[tauri::command]
pub fn ai_restore_suggestion(state: State<AppState>, id: i64) -> AppResult<()> {
    let conn = lock_db(&state)?;
    ai::restore_suggestion(&conn, id)
}

#[tauri::command]
pub fn ai_reject_suggestion(state: State<AppState>, id: i64) -> AppResult<()> {
    let conn = lock_db(&state)?;
    ai::reject_suggestion(&conn, id)
}

/// 批量确认该批次全部 pending 建议（按 AI 原建议写入）
/// 批量套用标签到任意素材（PRD 5.3：胶片条多选套用）
#[tauri::command]
pub fn ai_apply_tags(
    state: State<AppState>,
    asset_ids: Vec<i64>,
    tags: CategorizedTags,
) -> AppResult<()> {
    let conn = lock_db(&state)?;
    ai::apply_tags(&conn, &asset_ids, &tags)
}

#[tauri::command]
pub fn ai_confirm_all(state: State<AppState>, batch_id: i64) -> AppResult<()> {
    let conn = lock_db(&state)?;
    ai::confirm_all_pending(&conn, batch_id)
}
