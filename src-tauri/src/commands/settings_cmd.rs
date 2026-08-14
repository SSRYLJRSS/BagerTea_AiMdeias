use tauri::State;

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
