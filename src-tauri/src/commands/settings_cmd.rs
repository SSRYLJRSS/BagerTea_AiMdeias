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

/// W0-9：打开日志目录（data_dir/logs，tracing-appender 滚动文件所在处）
#[tauri::command]
pub fn open_logs_dir(app: tauri::AppHandle, state: State<AppState>) -> AppResult<()> {
    use tauri_plugin_opener::OpenerExt;
    let logs_dir = state.data_dir.join("logs");
    app.opener()
        .open_path(logs_dir.to_string_lossy().as_ref(), None::<&str>)
        .map_err(|e| AppError::msg(format!("打开日志目录失败: {e}")))
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
        return Err(AppError::msg(
            "正在执行回填/色板任务，请等它结束或取消后再重置",
        ));
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

/// W5c：备份数据库（指导书 §W5c）。短锁内 `VACUUM INTO` 生成单文件快照。
#[tauri::command]
pub async fn backup_db(state: State<'_, AppState>, target: String) -> AppResult<()> {
    let db = std::sync::Arc::clone(&state.db);
    tauri::async_runtime::spawn_blocking(move || {
        let conn = db.lock().map_err(|_| AppError::msg("数据库锁中毒"))?;
        crate::db::backup::backup_to(&conn, std::path::Path::new(&target))
    })
    .await
    .map_err(|e| AppError::msg(format!("备份线程异常: {e}")))?
}

/// W5c：恢复数据库（指导书 §W5c）。
/// 校验（quick_check + user_version 只拒高版本 + 关键表）→ 运行中任务阻断
/// → 现库 `.old` 保底 → 覆盖 → 迁移升级 → 热替换连接 → `app.restart()`（不返回）。
#[tauri::command]
pub async fn restore_db(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    source: String,
) -> AppResult<()> {
    let source = std::path::PathBuf::from(&source);
    // ① 校验备份（锁外；失败直接给用户可读原因）
    crate::db::backup::validate_backup(&source)?;
    // ② 运行中任务阻断（含冷启动自愈后仍可靠的 ai_batches 检查：启动时 processing 已被标记 interrupted）
    {
        let conn = state.db.lock().map_err(|_| AppError::msg("数据库锁中毒"))?;
        guard_no_running_tasks(&state, &conn)?;
    }
    // ③ 换文件 + 换连接（持锁；复制与迁移是文件 IO 重活，spawn_blocking）
    let db = std::sync::Arc::clone(&state.db);
    let data_dir = state.data_dir.clone();
    tauri::async_runtime::spawn_blocking(move || -> AppResult<()> {
        let db_path = data_dir.join("library.db");
        let old_path = data_dir.join("library.db.old");
        let mut guard = db.lock().map_err(|_| AppError::msg("数据库锁中毒"))?;
        // 旧连接收尾：checkpoint 截断 WAL → 换入内存占位连接 → 关闭旧连接释放文件句柄
        //（Windows 上文件被占用时 rename/copy 会失败，必须先关）
        let old = std::mem::replace(
            &mut *guard,
            rusqlite::Connection::open_in_memory()
                .map_err(|e| AppError::msg(format!("占位连接创建失败: {e}")))?,
        );
        let _ = old.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);");
        let _ = old.close();
        // ④ .old 保底：覆盖失败/新库打不开时能回滚回现库
        if old_path.exists() {
            let _ = std::fs::remove_file(&old_path);
        }
        std::fs::rename(&db_path, &old_path)
            .map_err(|e| AppError::msg(format!("现库改名保底失败: {e}")))?;
        if let Err(e) = std::fs::copy(&source, &db_path) {
            let _ = std::fs::rename(&old_path, &db_path);
            return Err(AppError::msg(format!("覆盖库文件失败: {e}")));
        }
        // ⑤ 打开新库（老版本备份在此自动迁移升级）
        match crate::db::init(&db_path) {
            Ok(new_conn) => {
                *guard = new_conn;
            }
            Err(e) => {
                // 回滚：新库打不开 → 还原 .old（保证应用重启后仍是原库）
                let _ = std::fs::remove_file(&db_path);
                let _ = std::fs::rename(&old_path, &db_path);
                if let Ok(recovered) = crate::db::init(&db_path) {
                    *guard = recovered;
                }
                return Err(AppError::msg(format!(
                    "恢复后的库无法打开（已还原原库）：{e}"
                )));
            }
        }
        Ok(())
    })
    .await
    .map_err(|e| AppError::msg(format!("恢复线程异常: {e}")))??;
    // ⑥ 冷启动衔接：恢复成功即重启进程加载新库（restart 不返回）
    app.restart()
}

/// 恢复前运行中任务守卫：入库 / 回填类 / 导出 / AI 批次任一进行中即拒绝
fn guard_no_running_tasks(state: &AppState, conn: &rusqlite::Connection) -> AppResult<()> {
    if state
        .import_running
        .load(std::sync::atomic::Ordering::Relaxed)
    {
        return Err(AppError::msg(
            "文件入库进行中，请等它结束或取消后再恢复备份",
        ));
    }
    if state
        .refill_running
        .load(std::sync::atomic::Ordering::Relaxed)
    {
        return Err(AppError::msg(
            "回填/色板任务进行中，请等它结束或取消后再恢复备份",
        ));
    }
    if !state
        .export_cancel
        .lock()
        .map_err(|_| AppError::msg("锁中毒"))?
        .is_empty()
    {
        return Err(AppError::msg(
            "导出任务进行中，请等它结束或取消后再恢复备份",
        ));
    }
    if !state
        .ai_cancel
        .lock()
        .map_err(|_| AppError::msg("锁中毒"))?
        .is_empty()
    {
        return Err(AppError::msg(
            "AI 打标批次进行中，请等它结束或取消后再恢复备份",
        ));
    }
    let n = crate::db::ai::count_pending_or_processing(conn)?;
    if n > 0 {
        return Err(AppError::msg(
            "有待处理的 AI 打标批次，请先取消批次后再恢复备份",
        ));
    }
    Ok(())
}
