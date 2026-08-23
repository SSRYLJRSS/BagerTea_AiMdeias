use std::sync::atomic::Ordering;

use tauri::{AppHandle, Emitter, State};

use crate::db::assets::ImportResult;
use crate::db::settings;
use crate::services::importer::{self, ImportOptions, ImportProgress};
use crate::services::thumbnail::ThumbnailService;
use crate::state::AppState;
use crate::error::{AppError, AppResult};

/// 入库：async + spawn_blocking 工作线程（不堵主线程 IPC，取消即时生效）；
/// collection/rename 来自入库页选项；总库位置以设置为准（R-32，单一事实源）
#[tauri::command]
pub async fn import_files(
    app: AppHandle,
    state: State<'_, AppState>,
    paths: Vec<String>,
    collection: Option<String>,
    rename_pattern: Option<String>,
) -> AppResult<ImportResult> {
    if paths.is_empty() {
        return Err(AppError::msg("未选择任何文件"));
    }
    state.import_cancel.store(false, Ordering::Relaxed);
    let db = std::sync::Arc::clone(&state.db);
    let data_dir = state.data_dir.clone();
    let cancel = std::sync::Arc::clone(&state.import_cancel);

    tauri::async_runtime::spawn_blocking(move || {
        let thumbs = ThumbnailService::new(&data_dir)?;
        let library_root = {
            let conn = db.lock().map_err(|_| AppError::msg("数据库锁中毒"))?;
            settings::get_settings(&conn)?.library_root
        };
        let opts = ImportOptions {
            library_root: if library_root.trim().is_empty() { None } else { Some(library_root) },
            collection,
            rename_pattern: rename_pattern.filter(|p| !p.trim().is_empty()),
        };
        importer::import_paths(&db, &thumbs, &paths, &opts, &cancel, |p: ImportProgress| {
            let _ = app.emit("import://progress", p);
        })
    })
    .await
    .map_err(|e| AppError::msg(format!("入库线程异常: {e}")))?
}

/// 扫描路径生成待入库清单统计（两段式入库，不落库）
/// B07：改 async + spawn_blocking，大目录扫描不卡主线程
#[tauri::command]
pub async fn inspect_import(paths: Vec<String>) -> AppResult<importer::ImportPlan> {
    tauri::async_runtime::spawn_blocking(move || Ok(importer::inspect_paths(&paths)))
        .await
        .map_err(|e| AppError::msg(format!("扫描线程异常: {e}")))?
}

#[tauri::command]
pub fn cancel_import(state: State<AppState>) {
    state.import_cancel.store(true, Ordering::Relaxed);
}

/// 改名模板预览（前端 RenameBuilder 实时预览用）：直调后端 render_name，
/// 消除前后端双实现的规则 drift（单一事实源）
#[tauri::command]
pub fn preview_rename(
    template: String,
    collection: String,
    orig_stem: String,
    seq: Option<usize>,
) -> String {
    importer::preview_rename(&template, &collection, &orig_stem, seq.unwrap_or(1))
}
