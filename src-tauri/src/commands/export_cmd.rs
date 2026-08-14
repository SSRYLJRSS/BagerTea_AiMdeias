use std::sync::atomic::AtomicBool;
use std::sync::Arc;

use tauri::{AppHandle, Emitter, State};

use crate::db::export::{self, ExportTask};
use crate::error::{AppError, AppResult};
use crate::services::export_local::{self, ExportProgress};
use crate::state::AppState;

/// 本地导出：同步等待 + 事件进度（与入库同模式；任务化优化留后期）
#[tauri::command]
pub async fn export_local_files(
    app: AppHandle,
    state: State<'_, AppState>,
    asset_ids: Vec<i64>,
    dest_dir: String,
    mode: String,
) -> AppResult<ExportTask> {
    if mode != "copy" && mode != "move" {
        return Err(AppError::msg("非法导出模式"));
    }
    if asset_ids.is_empty() {
        return Err(AppError::msg("未选择任何素材"));
    }
    let db = std::sync::Arc::clone(&state.db);
    let registry = std::sync::Arc::clone(&state.export_cancel);
    let cancel = Arc::new(AtomicBool::new(false));

    tauri::async_runtime::spawn_blocking(move || {
        // 建任务短锁即用即放；导出期间不持 DB 锁（文件 IO 在锁外）
        let task = {
            let conn = db.lock().map_err(|_| AppError::msg("数据库锁中毒"))?;
            export::create_task(
                &conn,
                "local",
                asset_ids.len() as i64,
                Some(&dest_dir),
                None,
            )?
        };
        registry
            .lock()
            .map_err(|_| AppError::msg("锁中毒"))?
            .insert(task.id, Arc::clone(&cancel));
        let r = export_local::export_local(
            &db,
            task.id,
            &asset_ids,
            &dest_dir,
            &mode,
            &cancel,
            |p: ExportProgress| {
                let _ = app.emit("export://progress", p);
            },
        );
        // B12：收尾清理 flag——锁中毒不再静默吞
        match registry.lock() {
            Ok(mut m) => {
                m.remove(&task.id);
            }
            Err(_) => tracing::error!("取消注册表锁中毒，task {} 的 flag 未清理", task.id),
        }
        r?;
        let conn = db.lock().map_err(|_| AppError::msg("数据库锁中毒"))?;
        export::get_task(&conn, task.id)
    })
    .await
    .map_err(|e| AppError::msg(format!("导出线程异常: {e}")))?
}

#[tauri::command]
pub fn list_export_tasks(state: State<AppState>) -> AppResult<Vec<ExportTask>> {
    let conn = state.db.lock().map_err(|_| AppError::msg("数据库锁中毒"))?;
    export::list_tasks(&conn)
}

#[tauri::command]
pub fn cancel_export(state: State<AppState>, task_id: i64) -> AppResult<()> {
    // B11：不再静默吞锁中毒
    let m = state
        .export_cancel
        .lock()
        .map_err(|_| AppError::msg("取消注册表锁中毒，无法取消任务"))?;
    if let Some(flag) = m.get(&task_id) {
        flag.store(true, std::sync::atomic::Ordering::Relaxed);
    }
    Ok(())
}
