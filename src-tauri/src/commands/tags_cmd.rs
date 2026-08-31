use tauri::State;

use crate::db::tag_facets::{FacetImpact, TagFacet};
use crate::db::tag_ops::TagOp;
use crate::db::tags::TagFacetGovernance;
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
pub fn list_tag_facets(state: State<AppState>) -> AppResult<Vec<TagFacet>> {
    let conn = lock_db(&state)?;
    crate::db::tag_facets::list(&conn)
}

/// 分面管理：列出全部（含 inactive），供设置页分面生命周期 UI。
#[tauri::command]
pub fn list_all_tag_facets(state: State<AppState>) -> AppResult<Vec<TagFacet>> {
    let conn = lock_db(&state)?;
    crate::db::tag_facets::list_all(&conn)
}

/// 分面管理：创建用户分面（is_system=false；key 稳定不可改）。
#[tauri::command]
pub fn create_tag_facet(
    state: State<AppState>,
    key: String,
    display_name: String,
    description: Option<String>,
    selection_mode: String,
    max_items: Option<i64>,
    applies_to: Option<String>,
) -> AppResult<TagFacet> {
    let conn = lock_db(&state)?;
    crate::db::tag_facets::create(
        &conn,
        &key,
        &display_name,
        description.as_deref().unwrap_or(""),
        &selection_mode,
        max_items,
        applies_to.as_deref().unwrap_or("all"),
    )
}

/// W2-2：合并编辑命令（6 字段一个事务）。旧 update_tag_facet_display /
/// update_tag_facet_rules 保留 deprecated 标记，W4 前端切换完再删。
#[tauri::command]
pub fn update_tag_facet(
    state: State<AppState>,
    key: String,
    display_name: String,
    description: String,
    input_mode: String,
    selection_mode: String,
    max_items: Option<i64>,
    applies_to: String,
) -> AppResult<()> {
    let conn = lock_db(&state)?;
    crate::db::tag_facets::update_facet(
        &conn, &key, &display_name, &description, &input_mode,
        &selection_mode, max_items, &applies_to,
    )
}

/// W2-3：物理删除分面 + 全级联（系统分面拒绝）。返回删除报告供确认弹窗对账。
#[tauri::command]
pub fn delete_tag_facet(
    state: State<AppState>,
    key: String,
) -> AppResult<crate::db::tag_facets::FacetDeleteReport> {
    let conn = lock_db(&state)?;
    crate::db::tag_facets::delete_facet(&conn, &key)
}

/// 修改显示属性（显示名/描述；key 不可改）。【deprecated：W2-2 起 W4 前端改走 update_tag_facet】
#[tauri::command]
pub fn update_tag_facet_display(
    state: State<AppState>,
    key: String,
    display_name: String,
    description: Option<String>,
) -> AppResult<()> {
    let conn = lock_db(&state)?;
    crate::db::tag_facets::update_display(
        &conn,
        &key,
        &display_name,
        description.as_deref().unwrap_or(""),
    )
}

/// 修改规则（selection_mode / max_items / applies_to）。
#[tauri::command]
pub fn update_tag_facet_rules(
    state: State<AppState>,
    key: String,
    selection_mode: String,
    max_items: Option<i64>,
    applies_to: Option<String>,
) -> AppResult<()> {
    let conn = lock_db(&state)?;
    crate::db::tag_facets::update_rules(
        &conn,
        &key,
        &selection_mode,
        max_items,
        applies_to.as_deref().unwrap_or("all"),
    )
}

/// 分面排序（传入完整有序 key 列表）。
#[tauri::command]
pub fn reorder_tag_facets(state: State<AppState>, ordered_keys: Vec<String>) -> AppResult<()> {
    let conn = lock_db(&state)?;
    crate::db::tag_facets::reorder(&conn, &ordered_keys)
}

/// 软停用（保留历史引用）；系统分面返回错误。
#[tauri::command]
pub fn deactivate_tag_facet(state: State<AppState>, key: String) -> AppResult<()> {
    let conn = lock_db(&state)?;
    crate::db::tag_facets::deactivate(&conn, &key)
}

/// 恢复分面。
#[tauri::command]
pub fn restore_tag_facet(state: State<AppState>, key: String) -> AppResult<()> {
    let conn = lock_db(&state)?;
    crate::db::tag_facets::restore(&conn, &key)
}

/// 停用前显示影响范围（标签/素材/AI 配置数量）。
#[tauri::command]
pub fn get_tag_facet_impact(state: State<AppState>, key: String) -> AppResult<FacetImpact> {
    let conn = lock_db(&state)?;
    crate::db::tag_facets::get_impact(&conn, &key)
}

#[tauri::command]
pub fn list_tags_by_facet(state: State<AppState>, facet_key: String) -> AppResult<Vec<TagNode>> {
    let conn = lock_db(&state)?;
    crate::db::tag_facets::get(&conn, &facet_key)?;
    tags::list_by_facet(&conn, &facet_key)
}

#[tauri::command]
pub fn list_tag_governance(state: State<AppState>) -> AppResult<Vec<TagFacetGovernance>> {
    let conn = lock_db(&state)?;
    tags::governance(&conn)
}

#[tauri::command]
pub fn search_tag_candidates(
    state: State<AppState>,
    facet_key: Option<String>,
    query: String,
) -> AppResult<Vec<Tag>> {
    let conn = lock_db(&state)?;
    tags::search_candidates(&conn, facet_key.as_deref(), &query)
}

#[tauri::command]
pub fn create_canonical_tag(
    state: State<AppState>,
    name: String,
    facet_key: String,
    parent_id: Option<i64>,
) -> AppResult<Tag> {
    let name = name.trim().to_string();
    if name.is_empty() || name.chars().count() > 64 || name.chars().any(|c| c.is_control()) {
        return Err(AppError::msg("标签名称无效或超过 64 个字符"));
    }
    let conn = lock_db(&state)?;
    crate::db::tag_facets::get(&conn, &facet_key)?;
    if let Some(pid) = parent_id {
        let parent_facet: String = conn.query_row(
            "SELECT facet_key FROM tags WHERE id = ?1 AND status = 'active'",
            [pid],
            |r| r.get(0),
        )?;
        if parent_facet != facet_key {
            return Err(AppError::msg("标签不能挂到其他分面下"));
        }
    }
    if parent_id.is_none() {
        let id = tags::find_or_create_canonical(&conn, &facet_key, &name)?;
        return tags::search_candidates(&conn, Some(&facet_key), &name)?
            .into_iter()
            .find(|tag| tag.id == id)
            .ok_or_else(|| AppError::msg("创建标签后读取失败"));
    }
    tags::create_in_facet(&conn, &name, parent_id, Some(&facet_key))
}

#[tauri::command]
pub fn add_tag_alias(
    state: State<AppState>,
    tag_id: i64,
    alias: String,
    locale: Option<String>,
) -> AppResult<()> {
    let conn = lock_db(&state)?;
    tags::add_alias(&conn, tag_id, &alias, locale.as_deref(), "synonym")
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
    tags::update_preserve_alias(&conn, id, name.as_deref(), parent_id)
}

#[tauri::command]
pub fn delete_tag(state: State<AppState>, id: i64) -> AppResult<()> {
    let conn = lock_db(&state)?;
    tags::delete(&conn, id)
}

#[tauri::command]
pub fn deactivate_tag(state: State<AppState>, id: i64) -> AppResult<()> {
    let conn = lock_db(&state)?;
    let is_system: bool =
        conn.query_row("SELECT is_system != 0 FROM tags WHERE id = ?1", [id], |r| {
            r.get(0)
        })?;
    if is_system {
        return Err(AppError::msg("系统分面根标签不能停用"));
    }
    tags::deactivate(&conn, id)
}

#[tauri::command]
pub fn tag_merge(state: State<AppState>, src_id: i64, dst_id: i64) -> AppResult<()> {
    let conn = lock_db(&state)?;
    tags::merge(&conn, src_id, dst_id)
}

#[tauri::command]
pub fn merge_tags_preserve_alias(
    state: State<AppState>,
    src_id: i64,
    dst_id: i64,
) -> AppResult<()> {
    let conn = lock_db(&state)?;
    tags::merge_preserve_alias(&conn, src_id, dst_id)
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
