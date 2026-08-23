use tauri::State;

use crate::db::tag_ops::TagOp;
use crate::db::tags::{Tag, TagNode};
use crate::db::{asset_tags, tag_ops, tags};
use crate::error::{AppError, AppResult};
use crate::state::AppState;

fn lock_db(state: &AppState) -> AppResult<std::sync::MutexGuard<'_, rusqlite::Connection>> {
    state.db.lock().map_err(|_| AppError::msg("数据库锁中毒"))
}

#[tauri::command]
pub fn list_tags(state: State<AppState>) -> AppResult<Vec<TagNode>> {
    let conn = lock_db(&state)?;
    tags::list_tree(&conn)
}

#[tauri::command]
pub fn create_tag(state: State<AppState>, name: String, parent_id: Option<i64>) -> AppResult<Tag> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err(AppError::msg("标签名不能为空"));
    }
    // B25：长度上限 64 字符 + 拒绝控制字符
    if name.chars().count() > 64 {
        return Err(AppError::msg("标签名不能超过 64 字符"));
    }
    if name.chars().any(|c| c.is_control()) {
        return Err(AppError::msg("标签名不能包含控制字符"));
    }
    let conn = lock_db(&state)?;
    tags::create(&conn, &name, parent_id)
}

#[tauri::command]
pub fn update_tag(
    state: State<AppState>,
    id: i64,
    name: Option<String>,
    parent_id: Option<Option<i64>>,
) -> AppResult<()> {
    // B25：name 分支校验（trim + 长度 + 控制字符）
    let name = name.map(|n| n.trim().to_string());
    if let Some(n) = &name {
        if n.is_empty() {
            return Err(AppError::msg("标签名不能为空"));
        }
        if n.chars().count() > 64 {
            return Err(AppError::msg("标签名不能超过 64 字符"));
        }
        if n.chars().any(|c| c.is_control()) {
            return Err(AppError::msg("标签名不能包含控制字符"));
        }
    }
    let conn = lock_db(&state)?;
    tags::update(&conn, id, name.as_deref(), parent_id)
}

#[tauri::command]
pub fn delete_tag(state: State<AppState>, id: i64) -> AppResult<()> {
    let conn = lock_db(&state)?;
    tags::delete(&conn, id)
}

#[tauri::command]
pub fn tag_merge(state: State<AppState>, src_id: i64, dst_id: i64) -> AppResult<()> {
    let conn = lock_db(&state)?;
    tags::merge(&conn, src_id, dst_id)
}

#[tauri::command]
pub fn assign_tags(
    state: State<AppState>,
    asset_ids: Vec<i64>,
    tag_ids: Vec<i64>,
) -> AppResult<()> {
    let conn = lock_db(&state)?;
    asset_tags::assign(&conn, &asset_ids, &tag_ids, "manual")
}

#[tauri::command]
pub fn remove_tags(
    state: State<AppState>,
    asset_ids: Vec<i64>,
    tag_ids: Vec<i64>,
) -> AppResult<()> {
    let conn = lock_db(&state)?;
    asset_tags::remove(&conn, &asset_ids, &tag_ids)
}

#[tauri::command]
pub fn get_asset_tags(state: State<AppState>, asset_id: i64) -> AppResult<Vec<Tag>> {
    let conn = lock_db(&state)?;
    asset_tags::get_asset_tags(&conn, asset_id)
}

/// R-25 最近打标流水（打标页「最近打标」列表）
#[tauri::command]
pub fn tag_recent_ops(state: State<AppState>, limit: Option<i64>) -> AppResult<Vec<TagOp>> {
    let conn = lock_db(&state)?;
    tag_ops::recent(&conn, limit.unwrap_or(100))
}

/// R-25 批次撤销：按流水反向操作，返回实际生效条数（幂等）
#[tauri::command]
pub fn tag_undo_batch(state: State<AppState>, batch_id: i64) -> AppResult<u64> {
    let conn = lock_db(&state)?;
    tag_ops::undo_batch(&conn, batch_id)
}
