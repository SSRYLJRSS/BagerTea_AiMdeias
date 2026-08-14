//! 本地导出：复制/移动 + 进度回调 + 取消 + export_tasks 持久化（架构 §4.4）

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use rusqlite::Connection;
use serde::Serialize;

use crate::db::{assets, export};
use crate::error::{AppError, AppResult};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportProgress {
    pub task_id: i64,
    pub done: i64,
    pub total: i64,
}

/// 逐文件「短锁读库 → 锁外复制/移动 → 短锁写进度」，文件 IO 期间不持 DB 锁，
/// 避免大文件导出长时间阻塞全应用 DB 读写
pub fn export_local<F: Fn(ExportProgress)>(
    db: &Arc<Mutex<Connection>>,
    task_id: i64,
    asset_ids: &[i64],
    dest_dir: &str,
    mode: &str, // copy|move
    cancel: &Arc<AtomicBool>,
    progress: F,
) -> AppResult<()> {
    let lock = || db.lock().map_err(|_| AppError::msg("数据库锁中毒"));
    let dest = PathBuf::from(dest_dir);
    fs::create_dir_all(&dest)?;
    {
        let conn = lock()?;
        export::update_progress(&conn, task_id, 0, "running")?;
    }

    let total = asset_ids.len() as i64;
    let mut done = 0i64;
    for &id in asset_ids {
        if cancel.load(Ordering::Relaxed) {
            let conn = lock()?;
            export::finish_task(&conn, task_id, "cancelled", None, None)?;
            return Ok(());
        }
        let asset = {
            let conn = lock()?;
            assets::get(&conn, id)?
        };
        let src = PathBuf::from(&asset.file_path);
        // BUG-QA-1：unique_dest 失败不走 ?（会跳过 finish_task 导致任务卡 running），
        // 纳入 r 让下方 if let Err(e) = r 捕获后正常 finish_task("failed")
        let r = match unique_dest(&dest, &asset.file_name) {
            Ok(dst) if mode == "move" => {
                // 文件移动（可能耗时）：不持 DB 锁
                match move_file(&src, &dst) {
                    Ok(()) => {
                        // B04：move 成功后更新库记录指向新路径 + 新文件名
                        // （unique_dest 可能加了 (1) 后缀，file_name 需同步）
                        let norm = crate::utils::path::normalize_path(&dst.to_string_lossy());
                        let new_name = dst
                            .file_name()
                            .and_then(|n| n.to_str())
                            .unwrap_or(&asset.file_name)
                            .to_string();
                        // UPDATE 失败不用 ?（会跳过下方 finish_task），而是作为 r=Err 让 finish_task 正常执行
                        match lock().and_then(|conn| {
                            assets::update_file_path_and_name(&conn, id, &norm, &new_name)
                        }) {
                            Ok(()) => Ok(()),
                            Err(e) => {
                                tracing::error!(
                                    "move 后更新库记录失败（文件已移动到 {}）: {e}",
                                    dst.display()
                                );
                                Err(AppError::msg(format!(
                                    "文件已移动但库记录未更新，请重新入库: {e}"
                                )))
                            }
                        }
                    }
                    Err(e) => Err(e),
                }
            }
            Ok(dst) => {
                // 文件复制（可能耗时）：不持 DB 锁
                fs::copy(&src, &dst).map(|_| ()).map_err(AppError::from)
            }
            Err(e) => Err(e),
        };
        if let Err(e) = r {
            let conn = lock()?;
            export::finish_task(
                &conn,
                task_id,
                "failed",
                None,
                Some(&format!("{}: {e}", asset.file_name)),
            )?;
            return Err(e);
        }
        done += 1;
        {
            let conn = lock()?;
            export::update_progress(&conn, task_id, done, "running")?;
        }
        progress(ExportProgress {
            task_id,
            done,
            total,
        });
    }
    {
        let conn = lock()?;
        export::finish_task(&conn, task_id, "done", None, None)?;
    }
    Ok(())
}

/// 同名冲突自动加 (1)(2) 后缀；B06b：冲突超限(999)时报错而非回退覆盖
fn unique_dest(dir: &Path, name: &str) -> AppResult<PathBuf> {
    let candidate = dir.join(name);
    if !candidate.exists() {
        return Ok(candidate);
    }
    let stem = Path::new(name)
        .file_stem()
        .unwrap_or_default()
        .to_string_lossy()
        .into_owned();
    let ext = Path::new(name)
        .extension()
        .map(|e| format!(".{}", e.to_string_lossy()))
        .unwrap_or_default();
    for i in 1..1000 {
        let c = dir.join(format!("{stem}({i}){ext}"));
        if !c.exists() {
            return Ok(c);
        }
    }
    Err(AppError::msg(format!("目标目录同名文件过多: {name}")))
}

/// 跨盘 rename 失败时降级 copy+remove；B04：remove 失败不阻塞（文件已在新位置，源残留记录日志）
fn move_file(src: &Path, dst: &Path) -> AppResult<()> {
    match fs::rename(src, dst) {
        Ok(()) => Ok(()),
        Err(_) => {
            fs::copy(src, dst)?;
            // B04：remove 失败不阻塞——文件已在新位置，源残留记录日志
            if let Err(e) = fs::remove_file(src) {
                tracing::warn!("move 降级 copy 后删除源文件失败: {e}");
            }
            Ok(())
        }
    }
}
