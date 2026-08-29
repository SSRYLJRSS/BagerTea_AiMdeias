use std::sync::atomic::Ordering;

use tauri::{AppHandle, Emitter, Manager, State};

use crate::db::assets::ImportResult;
use crate::db::settings;
use crate::error::{AppError, AppResult};
use crate::services::importer::{self, ImportOptions, ImportProgress};
use crate::services::{media_refill, thumbnail::ThumbnailService};
use crate::state::AppState;

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

    let result = tauri::async_runtime::spawn_blocking(move || {
        let thumbs = ThumbnailService::new(&data_dir)?;
        let library_root = {
            let conn = db.lock().map_err(|_| AppError::msg("数据库锁中毒"))?;
            settings::get_settings(&conn)?.library_root
        };
        let opts = ImportOptions {
            library_root: if library_root.trim().is_empty() {
                None
            } else {
                Some(library_root)
            },
            collection,
            rename_pattern: rename_pattern.filter(|p| !p.trim().is_empty()),
        };
        importer::import_paths(&db, &thumbs, &paths, &opts, &cancel, |p: ImportProgress| {
            let _ = app.emit("import://progress", p);
        })
    })
    .await
    .map_err(|e| AppError::msg(format!("入库线程异常: {e}")))??;

    // FB2-08（§14.7）：入库完成后自动补算色板。
    // 不塞进 importer 热路径：placeholder 生成是 par_iter 并行块，图像不驻留内存，
    // 要在那里取图得改 extract_placeholder 签名（影响 3 个调用点）。走 missing scope
    // 读 placeholder 文件重算，256px WebP 解码成本可忽略，且天然幂等（FX-11）。
    // 失败不影响入库结果（色板是增强信息）；闸被占用时跳过（下次手动回算补上）；
    // on_progress 传空闭包，不与导入进度事件混淆前端状态机。
    if result.imported > 0 {
        let gate = std::sync::Arc::clone(&state.refill_running);
        let pdb = std::sync::Arc::clone(&state.db);
        let pcancel = std::sync::Arc::clone(&state.media_refill_cancel);
        tauri::async_runtime::spawn_blocking(move || {
            let ids = {
                let conn = match pdb.lock() {
                    Ok(c) => c,
                    Err(_) => return,
                };
                match crate::db::assets::list_ids_needing_palette(&conn) {
                    Ok(v) => v,
                    Err(_) => return,
                }
            };
            if ids.is_empty() {
                return;
            }
            if let Some(Ok(s)) =
                media_refill::try_rescan_palette_exclusive(&gate, &pdb, &ids, &pcancel, |_| {})
            {
                tracing::info!(
                    "入库后置色板补算完成：总数 {} 成功 {} 跳过 {} 失败 {}",
                    s.total,
                    s.success,
                    s.skipped,
                    s.failed
                );
            }
        });
    }
    Ok(result)
}

/// 扫描路径生成待入库清单统计（两段式入库，不落库）
/// B07：改 async + spawn_blocking，大目录扫描不卡主线程
/// FB2-03：对清单内每个原文件逐路径放行 asset 协议，使入库页可在卡片内播放视频。
/// 安全边界与 list_assets 一致——只放行用户主动选择/拖入的路径，只读，不放宽 scope、不用 allow_directory。
#[tauri::command]
pub async fn inspect_import(app: AppHandle, paths: Vec<String>) -> AppResult<importer::ImportPlan> {
    let plan = tauri::async_runtime::spawn_blocking(move || importer::inspect_paths(&paths))
        .await
        .map_err(|e| AppError::msg(format!("扫描线程异常: {e}")))?;
    for item in &plan.items {
        allow_import_asset(&app, &item.path);
    }
    Ok(plan)
}

/// 与 assets_cmd::allow_asset 同语义的本地放行函数（仅在 inspect_import 内使用）
fn allow_import_asset(app: &AppHandle, path: &str) {
    let _ = app.asset_protocol_scope().allow_file(std::path::Path::new(path));
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

/// 用系统默认应用打开待入库原文件（§10 FB-04：PeningItem 双击打开）。
/// 校验路径存在；仅允许打开，不做任何文件修改。
#[tauri::command]
pub fn open_file_external(app: tauri::AppHandle, path: String) -> AppResult<()> {
    if path.trim().is_empty() {
        return Err(AppError::msg("路径为空"));
    }
    let p = std::path::Path::new(&path);
    if !p.exists() {
        return Err(AppError::msg(format!("文件不存在: {path}")));
    }
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .open_path(&path, None::<&str>)
        .map_err(|e| AppError::msg(format!("系统打开文件失败: {e}")))
}
