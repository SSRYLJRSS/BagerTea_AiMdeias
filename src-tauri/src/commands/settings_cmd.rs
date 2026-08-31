use tauri::State;

use crate::db::reset as db_reset;
use crate::db::settings::{self, Settings};
use crate::error::{AppError, AppResult};
use crate::state::AppState;

#[tauri::command]
pub fn get_settings(state: State<AppState>) -> AppResult<Settings> {
    let conn = state.db.lock().map_err(|_| AppError::msg("数据库锁中毒"))?;
    settings::get_settings(&conn)
}

#[tauri::command]
pub fn save_settings(state: State<AppState>, s: Settings) -> AppResult<()> {
    let conn = state.db.lock().map_err(|_| AppError::msg("数据库锁中毒"))?;
    settings::save_settings(&conn, &s)
}

/// 软件数据保存位置（R-33：数据库/缩略图所在目录，便于备份转移）
#[tauri::command]
pub fn get_data_dir(state: State<AppState>) -> String {
    state.data_dir.to_string_lossy().into_owned()
}

/// 在系统文件管理器中打开数据目录
#[tauri::command]
pub fn open_data_dir(app: tauri::AppHandle, state: State<AppState>) -> AppResult<()> {
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .open_path(state.data_dir.to_string_lossy().as_ref(), None::<&str>)
        .map_err(|e| AppError::msg(format!("打开文件夹失败: {e}")))
}

/// 分类重置应用数据（设置页「数据与缓存 → 重置数据」勾选传入）
/// 只清数据库记录与本软件派生缓存文件，不触碰素材原文件。
#[tauri::command]
pub async fn reset_app_data(
    state: State<'_, AppState>,
    selection: db_reset::ResetSelection,
) -> AppResult<db_reset::ResetReport> {
    if !selection.any() {
        return Err(AppError::msg("请先勾选要重置的数据"));
    }
    // 回填/色板回算进行中时重置会和长任务互相踩（FX-12 互斥闸只管这一类，但至少挡住最常见的）
    if state
        .refill_running
        .load(std::sync::atomic::Ordering::Relaxed)
    {
        return Err(AppError::msg("正在执行回填/色板任务，请等它结束或取消后再重置"));
    }
    let db = std::sync::Arc::clone(&state.db);
    let data_dir = state.data_dir.clone();
    // 删大缓存目录是文件 IO 重活，spawn_blocking 防堵主线程
    tauri::async_runtime::spawn_blocking(move || {
        let mut conn = db.lock().map_err(|_| AppError::msg("数据库锁中毒"))?;
        db_reset::reset(&mut conn, &data_dir, &selection)
    })
    .await
    .map_err(|e| AppError::msg(format!("重置线程异常: {e}")))?
}
