//! 媒体元数据回填命令（指导书 §7.5）：全部视频 / 选中素材 / 仅缺字段 三种范围；
//! 运行在 spawn_blocking（不阻塞 UI 主线程），带进度事件 + 取消；单个坏文件不阻塞批次。

use std::sync::atomic::Ordering;
use std::sync::Arc;

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::db::assets;
use crate::error::{AppError, AppResult};
use crate::services::media_refill;
use crate::state::AppState;

/// 回填结果 JSON（camelCase 序列化）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RescanResult {
    pub total: i64,
    pub success: i64,
    pub failed: i64,
    pub skipped: i64,
}

#[tauri::command]
pub async fn rescan_asset_metadata(
    app: AppHandle,
    state: State<'_, AppState>,
    ids: Option<Vec<i64>>,
    scope: Option<String>,
) -> AppResult<RescanResult> {
    let scope = scope.unwrap_or_else(|| "missing".to_string());
    if scope != "all" && scope != "missing" && scope != "ids" {
        return Err(AppError::msg("scope 只允许 all | missing | ids"));
    }
    if scope == "ids" && ids.as_ref().map_or(true, |v| v.is_empty()) {
        return Err(AppError::msg("未选择任何素材"));
    }
    let db = Arc::clone(&state.db);
    let cancel = Arc::clone(&state.media_refill_cancel);
    cancel.store(false, Ordering::Relaxed); // 新一轮重置取消标志

    tauri::async_runtime::spawn_blocking(move || -> AppResult<RescanResult> {
        // 锁外探测，只短锁读/写每行
        let resolved = {
            let conn = db.lock().map_err(|_| AppError::msg("数据库锁中毒"))?;
            match scope.as_str() {
                "ids" => ids.clone().unwrap_or_default(),
                "missing" => assets::list_video_ids_needing_metadata(&conn)?,
                _ => assets::list_video_ids(&conn)?,
            }
        };
        let summary = media_refill::rescan_assets(&db, &resolved, &cancel, |p| {
            let _ = app.emit("media_refill://progress", p);
        })?;
        Ok(RescanResult {
            total: summary.total,
            success: summary.success,
            failed: summary.failed,
            skipped: summary.skipped,
        })
    })
    .await
    .map_err(|e| AppError::msg(format!("回填线程异常: {e}")))?
}

/// 取消正在进行的媒体元数据回填。
#[tauri::command]
pub fn cancel_media_refill(state: State<AppState>) -> AppResult<()> {
    state.media_refill_cancel.store(true, Ordering::Relaxed);
    Ok(())
}
