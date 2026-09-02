//! schema_features 能力表（F1-e）：数据库约束能力的登记与自检。
//!
//! 动机：数据库约束（唯一索引/触发器）是「声称生效」还是「真的生效」，二者可能
//! 不一致 —— 迁移中途崩溃、或有人手工改库，都会让登记状态与实际状态漂移。
//! 自检的目的是以**实际为准**修正登记表并 warn（不阻断启动），让设置页能如实展示。
//!
//! 能力清单（feature key）：
//! - `tag_cycle_guard`         环检测/深度上限触发器（V22a 无条件生效）
//! - `tag_unique_terms`        tag_terms 唯一词条（V22b 条件启用）
//! - `tag_facet_fk`            tags.facet_key 引用完整性触发器（V22b）
//! - `tag_facet_restrict_delete` 分面删除 RESTRICT 触发器（V22b）
//!
//! 铁律 9：`tag_unique_terms` 是「tag_terms vs tag_aliases」双表的唯一开关，绝不双写。

use rusqlite::Connection;

use crate::error::AppResult;

/// 一个能力的登记状态（serialize 供设置页展示）。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SchemaFeatureStatus {
    pub feature: String,
    pub enabled: bool,
    pub applied_at: Option<i64>,
    pub blocked_by: Option<String>,
}

/// 读全部能力状态（按 feature 排序，便于 UI 稳定展示）。
pub fn list_features(conn: &Connection) -> AppResult<Vec<SchemaFeatureStatus>> {
    let mut stmt = conn.prepare(
        "SELECT feature, enabled, applied_at, blocked_by
           FROM schema_features ORDER BY feature",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok(SchemaFeatureStatus {
            feature: r.get(0)?,
            enabled: r.get::<_, i64>(1)? != 0,
            applied_at: r.get(2)?,
            blocked_by: r.get(3)?,
        })
    })?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

/// 读单个能力是否启用（未登记 = 未启用）。
pub fn feature_enabled(conn: &Connection, feature: &str) -> AppResult<bool> {
    let enabled: Option<i64> = conn
        .query_row(
            "SELECT enabled FROM schema_features WHERE feature = ?1",
            [feature],
            |r| r.get(0),
        )
        .ok();
    Ok(enabled.unwrap_or(0) != 0)
}

/// 写登记状态（enabled / applied_at / blocked_by）。
/// 供 apply_tag_constraints 启用、以及自检发现漂移时修正用。
pub fn set_feature(
    conn: &Connection,
    feature: &str,
    enabled: bool,
    blocked_by: Option<&str>,
) -> AppResult<()> {
    let now = chrono::Utc::now().timestamp_millis();
    conn.execute(
        "INSERT INTO schema_features (feature, enabled, applied_at, blocked_by)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(feature) DO UPDATE SET
           enabled = excluded.enabled,
           applied_at = excluded.applied_at,
           blocked_by = excluded.blocked_by",
        rusqlite::params![
            feature,
            if enabled { 1 } else { 0 },
            now,
            blocked_by.unwrap_or("")
        ],
    )?;
    Ok(())
}

// ════════════════════════════════════════════════════════════════
// 自检：登记状态 vs 数据库实际结构
// ════════════════════════════════════════════════════════════════

/// 探测一个对象（索引/触发器）是否真实存在。
fn object_exists(conn: &Connection, obj_type: &str, name: &str) -> AppResult<bool> {
    let n: i64 = conn.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type = ?1 AND name = ?2",
        rusqlite::params![obj_type, name],
        |r| r.get(0),
    )?;
    Ok(n > 0)
}

/// 启动自检：schema_features 声称的能力必须与数据库实际状态一致。
/// 不一致 = 有人手工改过库 / 迁移中途崩溃 → 以实际为准修正登记表并 warn（不阻断启动）。
/// 返回差异清单（供设置页展示「标签数据不一致」等）。
pub fn verify_schema_features(conn: &Connection) -> AppResult<Vec<String>> {
    let mut diffs = Vec::new();

    // tag_cycle_guard：三个触发器任一缺失即视为未生效
    let cycle_ok = object_exists(conn, "trigger", "trg_tags_no_cycle")?
        && object_exists(conn, "trigger", "trg_tags_max_depth_au")?
        && object_exists(conn, "trigger", "trg_tags_max_depth_ai")?;
    sync_feature(conn, "tag_cycle_guard", cycle_ok, "cycle_guard_missing", &mut diffs)?;

    // tag_unique_terms：ux_terms 唯一索引 + tag_terms 表
    let terms_ok = object_exists(conn, "table", "tag_terms")?
        && object_exists(conn, "index", "ux_terms")?;
    sync_feature(conn, "tag_unique_terms", terms_ok, "terms_index_missing", &mut diffs)?;

    // tag_facet_fk：两个触发器
    let fk_ok = object_exists(conn, "trigger", "trg_tags_facet_fk_ai")?
        && object_exists(conn, "trigger", "trg_tags_facet_fk_au")?;
    sync_feature(conn, "tag_facet_fk", fk_ok, "facet_fk_missing", &mut diffs)?;

    // tag_facet_restrict_delete：删除拦截触发器
    let restrict_ok = object_exists(conn, "trigger", "trg_facets_restrict_delete")?;
    sync_feature(conn, "tag_facet_restrict_delete", restrict_ok, "restrict_delete_missing", &mut diffs)?;

    Ok(diffs)
}

/// 单能力对齐：实际状态与登记不符时，以实际为准写回登记表并记入差异清单。
fn sync_feature(
    conn: &Connection,
    feature: &str,
    actually_ok: bool,
    reason: &str,
    diffs: &mut Vec<String>,
) -> AppResult<()> {
    let registered = feature_enabled(conn, feature)?;
    if registered != actually_ok {
        // 表可能不存在（V22a 之前的库走不到这里；防御性兜底）
        let now = chrono::Utc::now().timestamp_millis();
        let _ = conn.execute(
            "INSERT INTO schema_features (feature, enabled, applied_at, blocked_by)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(feature) DO UPDATE SET
               enabled = excluded.enabled,
               blocked_by = excluded.blocked_by",
            rusqlite::params![
                feature,
                if actually_ok { 1 } else { 0 },
                now,
                if actually_ok { "" } else { reason }
            ],
        );
        diffs.push(format!(
            "{feature}: 登记 {}，实际 {}（已按实际修正）",
            if registered { "启用" } else { "停用" },
            if actually_ok { "已生效" } else { "缺失" }
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::init_memory;

    #[test]
    fn verify_reports_and_fixes_missing_index() {
        let c = init_memory().unwrap();
        // 全新 V22 库：tag_cycle_guard 已生效、其余按登记
        assert!(feature_enabled(&c, "tag_cycle_guard").unwrap());

        // 手工 DROP 唯一索引 → 自检应把 tag_unique_terms 修正为停用并返回差异
        // （先登记为启用，模拟「声称生效但实际缺失」）
        set_feature(&c, "tag_unique_terms", true, None).unwrap();
        c.execute("DROP TABLE IF EXISTS tag_terms", []).unwrap();
        let diffs = verify_schema_features(&c).unwrap();
        assert!(
            diffs.iter().any(|d| d.contains("tag_unique_terms")),
            "应报告 tag_unique_terms 差异：{diffs:?}"
        );
        assert!(!feature_enabled(&c, "tag_unique_terms").unwrap());
    }
}
