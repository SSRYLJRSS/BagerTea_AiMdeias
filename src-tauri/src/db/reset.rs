//! 分类重置应用数据（设置页「数据与缓存 → 重置数据」）
//! 原则：只清数据库记录与本软件派生缓存文件，绝不触碰素材原文件与代码。
//! FTS 一致性依赖既有触发器（删 assets / asset_tags / tag_aliases 会同步 fts_content），
//! 外键 CASCADE 已开启（db::configure），删主表即可级联清理关联表。

use std::path::Path;

use rusqlite::Connection;
use serde::{Deserialize, Serialize};

use crate::error::AppResult;
use crate::services::credentials;

/// 要重置的数据分类（前端勾选传入；false = 保留）
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResetSelection {
    /// 素材库记录（assets + 搜索索引 + 导出任务 + 视频代理记录）
    pub assets: bool,
    /// 标签与分类（tags / tag_facets / tag_aliases / tag_ops）
    pub tags: bool,
    /// AI 打标任务（批次 + 建议 + 词条级建议）
    pub ai_tasks: bool,
    /// AI 服务配置（连接档案 + 用途绑定 + 系统凭据中的密钥）
    pub ai_connections: bool,
    /// 偏好设置（settings 表恢复默认）
    pub preferences: bool,
    /// 缓存文件（thumbnails/ previews/ proxies/ 目录）
    pub caches: bool,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResetReport {
    pub assets_deleted: i64,
    pub tags_deleted: i64,
    pub ai_tasks_deleted: i64,
    pub connections_deleted: i64,
    pub preferences_reset: bool,
    pub cache_files_deleted: u64,
}

impl ResetSelection {
    pub fn any(&self) -> bool {
        self.assets || self.tags || self.ai_tasks || self.ai_connections || self.preferences || self.caches
    }
}

/// 执行分类重置。DB 变更在单事务内完成；缓存文件在事务提交后删除（失败不回滚 DB，
/// 只在报告中如实计数——缓存文件是派生数据，下次浏览会按需重建）。
pub fn reset(
    conn: &mut Connection,
    data_dir: &Path,
    sel: &ResetSelection,
) -> AppResult<ResetReport> {
    let mut report = ResetReport::default();
    let tx = conn.transaction()?;

    // 素材库：先删派生记录再删主表（FK 级联 asset_tags / ai_suggestions / video_proxies，
    // 触发器同步清 fts_content + assets_fts，不留幻影命中）
    if sel.assets {
        tx.execute("DELETE FROM export_tasks", [])?;
        tx.execute("DELETE FROM video_proxies", [])?;
        tx.execute("DELETE FROM assets", [])?;
        report.assets_deleted = tx.changes() as i64;
    }

    // 标签与分类：tag_ops 是打标流水，随标签一起清才有「全新开始」的语义。
    // 用户标签/分面清空，但系统分面必须重建——否则 AI 提示词无分面上下文（build_prompt_context
    // 跳过库里不存在的分面），模型返回的一切都会归到 custom（曾导致「只打出 custom 标」的线上事故）。
    if sel.tags {
        tx.execute("DELETE FROM tags", [])?;
        tx.execute("DELETE FROM tag_facets", [])?;
        tx.execute("DELETE FROM tag_ops", [])?;
        report.tags_deleted = tx.changes() as i64;
        super::tag_facets::seed_system_facets(&tx)?;
        // V16 语义：color 分面停用（颜色由算法主色呈现，AI 侧摘除）
        let now = chrono::Utc::now().timestamp_millis();
        tx.execute(
            "UPDATE tag_facets SET status = 'inactive', updated_at = ?1 WHERE key = 'color'",
            rusqlite::params![now],
        )?;
    }

    // AI 打标任务：batches → suggestions → suggestion_items 级联，逐层删确保无残留
    if sel.ai_tasks {
        tx.execute("DELETE FROM ai_suggestion_items", [])?;
        tx.execute("DELETE FROM ai_suggestions", [])?;
        tx.execute("DELETE FROM ai_batches", [])?;
        report.ai_tasks_deleted = tx.changes() as i64;
    }

    // AI 服务配置：先读出连接 id，逐个删除系统凭据里的 API Key（keyring 非事务，先删后清表：
    // 若中途失败最多留下孤儿凭据，不会出现「表里还有连接但密钥已丢」）
    if sel.ai_connections {
        let ids: Vec<String> = {
            let mut stmt = tx.prepare("SELECT id FROM ai_connections")?;
            let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
            rows.filter_map(|r| r.ok()).collect()
        };
        for id in &ids {
            let _ = credentials::delete_api_key(id);
        }
        tx.execute("DELETE FROM ai_usage_bindings", [])?;
        tx.execute("DELETE FROM ai_connections", [])?;
        report.connections_deleted = tx.changes() as i64;
    }

    // 偏好设置：settings 是单 key JSON（app_settings），整表清空后 get_settings 走默认值
    if sel.preferences {
        tx.execute("DELETE FROM settings", [])?;
        tx.execute("DELETE FROM cloud_accounts", [])?;
        report.preferences_reset = true;
    }

    // 缓存文件对应的 DB 字段/记录：缓存被清时必须回写，否则 DB 指向已删文件导致破图（B27 语义）
    let clear_cache_db = sel.caches || sel.assets;
    if clear_cache_db {
        tx.execute(
            "UPDATE assets SET placeholder_path = NULL, hd_thumbnail_path = NULL",
            [],
        )?;
        tx.execute("DELETE FROM video_proxies", [])?;
    }

    tx.commit()?;

    // 缓存文件删除（锁外文件 IO，事务已提交）
    if clear_cache_db {
        report.cache_files_deleted = clear_cache_dirs(data_dir)?;
    }

    Ok(report)
}

/// 清空缩略图/预览/视频代理缓存目录（整个目录删除后重建空目录），返回删除的文件数
fn clear_cache_dirs(data_dir: &Path) -> AppResult<u64> {
    let mut removed = 0u64;
    for name in ["thumbnails", "previews", "proxies"] {
        let dir = data_dir.join(name);
        if !dir.exists() {
            continue;
        }
        removed += count_files(&dir);
        if let Err(e) = std::fs::remove_dir_all(&dir) {
            tracing::warn!("清空缓存目录 {} 失败: {e}", dir.display());
        }
        if let Err(e) = std::fs::create_dir_all(&dir) {
            tracing::warn!("重建缓存目录 {} 失败: {e}", dir.display());
        }
    }
    Ok(removed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::init_memory;

    /// 重置标签后系统分面必须重建（color 停用），否则 AI 提示词失去分面上下文，
    /// 模型返回的所有标签都会归入 custom（「只打出 custom 标」事故的根因）。
    #[test]
    fn reset_tags_reseeds_system_facets_with_color_inactive() {
        let mut conn = init_memory().unwrap();
        let dir = std::env::temp_dir();
        let sel = ResetSelection {
            tags: true,
            ..Default::default()
        };
        let report = reset(&mut conn, &dir, &sel).unwrap();
        assert_eq!(report.tags_deleted, 0); // 库里本无 tag_ops 行

        let facets = crate::db::tag_facets::list(&conn).unwrap();
        let keys: Vec<&str> = facets.iter().map(|f| f.key.as_str()).collect();
        assert!(keys.contains(&"subject"), "系统分面应重建：{keys:?}");
        assert!(!keys.contains(&"color"), "color 应保持 inactive 不进 active 列表");
        let color = crate::db::tag_facets::get(&conn, "color").unwrap();
        assert_eq!(color.status, "inactive");
        // 重置后重启自愈不应再改动（幂等）
        crate::db::tag_facets::seed_system_facets_if_empty(&conn).unwrap();
        assert_eq!(crate::db::tag_facets::list(&conn).unwrap().len(), facets.len());
    }
}

fn count_files(dir: &Path) -> u64 {
    let mut n = 0u64;
    if let Ok(rd) = std::fs::read_dir(dir) {
        for entry in rd.flatten() {
            if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                n += count_files(&entry.path());
            } else {
                n += 1;
            }
        }
    }
    n
}
