//! AI 打标命令（T05a）：批次创建/执行/取消 + 建议确认流

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use tauri::{AppHandle, Emitter, State};

use crate::db::ai::{AiBatch, AiSuggestion, AiSuggestionItem, CategorizedTags};
use crate::db::{ai, settings};
use crate::error::{AppError, AppResult};
use crate::services::ai_cloud::{self, AiProgress};
use crate::state::AppState;

fn lock_db(state: &AppState) -> AppResult<std::sync::MutexGuard<'_, rusqlite::Connection>> {
    state.db.lock().map_err(|_| AppError::msg("数据库锁中毒"))
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
    let mut s = settings::get_settings(&conn)?;
    // §4.4：打标用途绑定优先（影响 auto/cloud 的本地/云端判定）
    let _ =
        crate::db::ai_connections::apply_usage_binding(&conn, "tagging", &mut s.ai).map_err(|e| {
            tracing::warn!("打标读取用途绑定失败，回退默认档案: {e}");
            e
        });
    // auto/cloud 统一按激活档案 kind 落实际模式：本地档案 → local，否则 cloud
    let mode = if mode == "manual" {
        mode
    } else {
        match s.ai.active().map(|p| p.is_local()).unwrap_or(false) {
            true => "local".to_string(),
            false => "cloud".to_string(),
        }
    };
    // 指导书阶段 5 §8.1/§8.3：用户选择的素材**完整**进入逻辑批次，不做静默截断。
    // 「批量上限」不再作为总批次截断——执行层按「分块大小」内存分块、限流、重试。
    // 若确需保护上限，必须在提交前明确展示与阻断，而非默认取前 N 张。
    let ids: Vec<i64> = asset_ids;
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
            let mut s = settings::get_settings(&conn)?;
            // §4.4：打标按用途绑定读取连接档案（含 keyring 密钥解析）；无绑定时回退默认 active 档案。
            //       绑定修改不写 settings JSON，复用现有 AI HTTP service（run_cloud_batch 只读 cfg）。
            let _ = crate::db::ai_connections::apply_usage_binding(&conn, "tagging", &mut s.ai).map_err(
                |e| {
                    tracing::warn!("打标读取用途绑定失败，回退默认档案: {e}");
                    e
                },
            );
            // P3-01a：本地批次要求激活档案为本地端点（cloud/local 管线同构，只做一致性校验）
            let profile_is_local = s.ai.active().map(|p| p.is_local()).unwrap_or(false);
            if batch.mode == "local" && !profile_is_local {
                return Err(AppError::msg(
                    "该批次为本地打标：请在设置页把激活档案切换为本地端点（kind=本地，如 Ollama）后重试",
                ));
            }
            // FB-03 §9.3 视频批次预检（前后端一致；后端为最终校验，service 层兜底保留）：
            // 待打标条目是否含视频 → 开关/ffmpeg/本地视觉模型三项检查，启动前阻断而非逐条启动后失败。
            {
                let suggestions = ai::list_suggestions(&conn, batch_id)?;
                let pending_items: Vec<_> = suggestions
                    .iter()
                    .filter(|s| s.status == "pending" && s.suggested_tags.is_empty())
                    .collect();
                let has_video = pending_items.iter().any(|s| {
                    let by_mime = s
                        .mime_type
                        .as_deref()
                        .map(|m| m.starts_with("video/"))
                        .unwrap_or(false);
                    let by_ext = {
                        let lower = s.asset_path.to_ascii_lowercase();
                        [".mp4", ".mov", ".avi", ".mkv", ".webm", ".m4v", ".wmv", ".flv", ".ts"]
                            .iter()
                            .any(|ext| lower.ends_with(ext))
                    };
                    by_mime || by_ext
                });
                if has_video {
                    if !s.ai.video_tagging {
                        return Err(AppError::msg(
                            "视频 AI 打标未开启。请打开「设置 → AI 设置 → 自动打标 → 视频 AI 打标」，保存后重新开始批次。",
                        ));
                    }
                    if !crate::services::video::ffmpeg_available() {
                        return Err(AppError::msg(
                            "本批次包含视频，但未检测到 ffmpeg：无法抽帧打标。请安装 ffmpeg 并加入 PATH，或在设置中关闭「视频 AI 打标」后重试。",
                        ));
                    }
                    // 本地模型视觉能力启发式检查（仅本地档案；云端默认支持，不做此检）
                    if profile_is_local {
                        if let Some(active) = s.ai.active() {
                            if !crate::services::ai_cloud::model_supports_vision(&active.model) {
                                return Err(AppError::msg(format!(
                                    "本批次包含视频，但当前本地模型「{}」不支持视觉（图片/视频抽帧）输入。请更换支持图片输入的视觉模型（如 qwen2.5vl、llava、moondream），保存后重新开始批次。",
                                    active.model
                                )));
                            }
                        }
                    }
                }
            }
            s
        };
        let cfg = all.ai;
        // W2-1：提示词上下文直接从 tag_facets 读（V20 合表后不再需要 configs 参数；短锁立即释放）
        let facets = {
            let conn = db.lock().map_err(|_| AppError::msg("数据库锁中毒"))?;
            crate::db::tag_facets::build_prompt_context(&conn)?
        };
        registry
            .lock()
            .map_err(|_| AppError::msg("锁中毒"))?
            .insert(batch_id, Arc::clone(&cancel));

        let r = ai_cloud::run_cloud_batch(&db, batch_id, &cfg, &facets, limit, &cancel, |p: AiProgress| {
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

#[tauri::command]
pub fn ai_list_suggestion_items(
    state: State<AppState>,
    suggestion_id: i64,
) -> AppResult<Vec<AiSuggestionItem>> {
    let conn = lock_db(&state)?;
    ai::list_suggestion_items(&conn, suggestion_id)
}

#[tauri::command]
pub fn ai_decide_suggestion_item(
    state: State<AppState>,
    item_id: i64,
    decision: String,
    replacement_tag_id: Option<i64>,
    replacement_name: Option<String>,
    reason: Option<String>,
) -> AppResult<()> {
    let conn = lock_db(&state)?;
    ai::decide_suggestion_item(
        &conn,
        item_id,
        &decision,
        replacement_tag_id,
        replacement_name.as_deref(),
        reason.as_deref(),
    )
}

/// 确认单条建议（tags 为最终值，含人工修改）
/// FB5-05（§7.6）：description 为审核后的最终描述；同一事务内写入素材。
#[tauri::command]
pub fn ai_confirm_suggestion(
    state: State<AppState>,
    id: i64,
    tags: CategorizedTags,
    description: Option<String>,
) -> AppResult<()> {
    let conn = lock_db(&state)?;
    ai::confirm_suggestion_with_description(&conn, id, &tags, description.as_deref())
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
