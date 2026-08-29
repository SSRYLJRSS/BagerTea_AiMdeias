//! 媒体元数据回填命令（指导书 §7.5）：全部视频 / 选中素材 / 仅缺字段 三种范围；
//! 运行在 spawn_blocking（不阻塞 UI 主线程），带进度事件 + 取消；单个坏文件不阻塞批次。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::db::assets;
use crate::error::{AppError, AppResult};
use crate::services::media_refill;
use crate::state::AppState;

/// 抢互斥闸：已有回填在跑时明确拒绝，不静默复位对方的取消标志（FX-12）。
/// RAII guard（RefillGateGuard）与抢闸逻辑在 media_refill 内实现，供导入后置（FX-11）复用。
fn acquire_refill_gate(gate: &Arc<AtomicBool>) -> AppResult<media_refill::RefillGateGuard> {
    media_refill::try_acquire_gate(gate).ok_or_else(|| {
        AppError::msg("已有回填任务进行中（媒体元数据回填或色板回算），请等待完成或先取消")
    })
}

/// 开一轮回填：先抢闸，成功后才重置取消标志（FX-12）。
/// 顺序不能反：抢不到闸的调用方若已经复位了标志，正在跑的那一批就丢掉了用户点过的"取消"。
fn begin_refill(
    gate: &Arc<AtomicBool>,
    cancel: &AtomicBool,
) -> AppResult<media_refill::RefillGateGuard> {
    let guard = acquire_refill_gate(gate)?;
    cancel.store(false, Ordering::Relaxed);
    Ok(guard)
}

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
    // FX-12：抢闸失败时明确报错；guard move 进闭包，覆盖所有退出路径。
    // 顺序要紧：先抢闸再重置取消标志（见 begin_refill）。
    let _gate = begin_refill(&state.refill_running, &cancel)?;

    tauri::async_runtime::spawn_blocking(move || -> AppResult<RescanResult> {
        let _gate = _gate;
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

/// FB2-08（§14.7）：算法色板回算（scope = all | missing | ids；复用 media_refill 取消标志与骨架）。
/// 独立命令而非塞进 rescan_asset_metadata：语义与耗时都不同，混在一起用户没法只跑其中一个。
#[tauri::command]
pub async fn rescan_asset_palette(
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
    // FX-12：与元数据回填互斥（抢闸失败时明确报错），先抢闸再重置取消标志。
    let _gate = begin_refill(&state.refill_running, &cancel)?;

    tauri::async_runtime::spawn_blocking(move || -> AppResult<RescanResult> {
        let _gate = _gate;
        let resolved: Vec<i64> = {
            let conn = db.lock().map_err(|_| AppError::msg("数据库锁中毒"))?;
            match scope.as_str() {
                "ids" => ids.unwrap_or_default(),
                "missing" => assets::list_ids_needing_palette(&conn)?,
                _ => assets::list_all_ids(&conn)?,
            }
        };
        let summary = media_refill::rescan_assets_palette(&db, &resolved, &cancel, |p| {
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
    .map_err(|e| AppError::msg(format!("色板回算线程异常: {e}")))?
}

/// 取消正在进行的媒体元数据回填。
#[tauri::command]
pub fn cancel_media_refill(state: State<AppState>) -> AppResult<()> {
    state.media_refill_cancel.store(true, Ordering::Relaxed);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// FX-12：抢闸失败时不得改变闸状态；guard drop 后闸释放。
    #[test]
    fn refill_gate_is_exclusive_and_self_releasing() {
        let gate = Arc::new(AtomicBool::new(false));
        {
            let _g = acquire_refill_gate(&gate).expect("首次抢闸应成功");
            assert!(
                acquire_refill_gate(&gate).is_err(),
                "第二个任务必须抢不到闸"
            );
            assert!(gate.load(Ordering::Acquire), "抢闸失败不得复位闸");
        }
        assert!(!gate.load(Ordering::Acquire), "guard drop 后闸应释放");
    }

    /// FX-12 回归：抢不到闸的调用方不得复位取消标志。
    /// 反例（旧顺序）：用户点"取消"→ 另一处（如 Viewer 单张重算）发起回填 →
    /// 它先 store(false) 再抢闸失败，正在跑的批次就丢掉了取消请求。
    #[test]
    fn losing_gate_does_not_clear_cancel_flag() {
        let gate = Arc::new(AtomicBool::new(false));
        let cancel = AtomicBool::new(false);

        let _running = begin_refill(&gate, &cancel).expect("首轮应抢到闸");
        cancel.store(true, Ordering::Relaxed); // 用户点了取消

        assert!(begin_refill(&gate, &cancel).is_err(), "第二轮必须抢不到闸");
        assert!(
            cancel.load(Ordering::Relaxed),
            "抢闸失败不得复位取消标志，否则正在跑的批次停不下来"
        );
    }

    /// begin_refill 抢到闸时必须重置取消标志：上一轮被取消过时标志仍为 true，
    /// 不重置会让新一轮在第一个素材前就 break。
    #[test]
    fn winning_gate_resets_cancel_flag() {
        let gate = Arc::new(AtomicBool::new(false));
        let cancel = AtomicBool::new(true); // 上一轮被取消后的残留状态
        let _g = begin_refill(&gate, &cancel).expect("应抢到闸");
        assert!(!cancel.load(Ordering::Relaxed), "新一轮应重置取消标志");
    }
}
