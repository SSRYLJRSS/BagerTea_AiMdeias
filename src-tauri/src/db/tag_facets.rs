//! 稳定标签分面：分面 key 是协议和数据边界，显示名称可以本地化。
//! 生命周期（指导书 §12.2）：创建 → active → 停用(inactive) → 恢复；key 创建后不可改。

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::db::settings::AiFacetConfig;
use crate::error::{AppError, AppResult};

/// AI 打标/搜索共享的 FacetPromptContext：稳定 key + 人类可读信息 + 数据库规则
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FacetPromptContext {
    pub key: String,
    pub display_name: String,
    pub description: String,
    pub hint: String,
    pub selection_mode: String,
    pub max_items: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TagFacet {
    pub key: String,
    pub display_name: String,
    pub description: String,
    pub selection_mode: String,
    pub max_items: Option<i64>,
    pub sort_order: i64,
    pub is_system: bool,
    pub status: String,
    pub applies_to: String,
    pub created_at: i64,
    pub updated_at: i64,
}

/// 停用/治理前的引用与影响范围（指导书 §12.3）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FacetImpact {
    pub tag_count: i64,
    pub asset_count: i64,
    pub ai_config_count: i64,
}

/// 校验稳定 key：小写 snake_case，2–64 字符，只允许字母/数字/下划线，不以数字开头（指导书 §12.3）。
pub fn validate_key(key: &str) -> AppResult<String> {
    let k = key.trim().to_lowercase();
    let valid = k.len() >= 2
        && k.len() <= 64
        && k.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
        && k.as_bytes()[0].is_ascii_lowercase();
    if !valid {
        return Err(AppError::msg(
            "分面 key 需为小写 snake_case，长度 2–64，仅字母/数字/下划线，且不以数字开头",
        ));
    }
    Ok(k)
}

fn facet_from_row(r: &rusqlite::Row) -> rusqlite::Result<TagFacet> {
    Ok(TagFacet {
        key: r.get(0)?,
        display_name: r.get(1)?,
        description: r.get(2)?,
        selection_mode: r.get(3)?,
        max_items: r.get(4)?,
        sort_order: r.get(5)?,
        is_system: r.get::<_, i64>(6)? != 0,
        status: r.get(7)?,
        applies_to: r.get(8)?,
        created_at: r.get(9)?,
        updated_at: r.get(10)?,
    })
}

const FACET_COLS: &str =
    "key, display_name, description, selection_mode, max_items, sort_order, is_system, status, applies_to, created_at, updated_at";

pub fn list(conn: &Connection) -> AppResult<Vec<TagFacet>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {FACET_COLS} FROM tag_facets
          WHERE status = 'active' ORDER BY sort_order, key"
    ))?;
    let rows = stmt
        .query_map([], facet_from_row)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

/// 列出全部（含 inactive），供设置页分面管理展示。
pub fn list_all(conn: &Connection) -> AppResult<Vec<TagFacet>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {FACET_COLS} FROM tag_facets ORDER BY sort_order, key"
    ))?;
    let rows = stmt
        .query_map([], facet_from_row)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

pub fn get(conn: &Connection, key: &str) -> AppResult<TagFacet> {
    Ok(conn.query_row(
        &format!("SELECT {FACET_COLS} FROM tag_facets WHERE key = ?1"),
        [key],
        facet_from_row,
    )?)
}

/// 创建用户分面（is_system=false）。key 校验唯一并规范化为小写；selection_mode/max_items 校验。
pub fn create(
    conn: &Connection,
    key: &str,
    display_name: &str,
    description: &str,
    selection_mode: &str,
    max_items: Option<i64>,
    applies_to: &str,
) -> AppResult<TagFacet> {
    let key = validate_key(key)?;
    let display_name = display_name.trim().to_string();
    if display_name.is_empty() {
        return Err(AppError::msg("显示名不能为空"));
    }
    if selection_mode != "single" && selection_mode != "multi" {
        return Err(AppError::msg("selection_mode 只允许 single | multi"));
    }
    // single 强制 max_items 语义为 1；multi 必须为正整数或 NULL
    let max_items = match selection_mode {
        "single" => Some(1),
        _ => match max_items {
            Some(n) if n >= 1 => Some(n),
            Some(_) => return Err(AppError::msg("多选分面的 max_items 必须为正整数或为空")),
            None => None,
        },
    };
    if applies_to != "all" && applies_to != "image" && applies_to != "video" {
        return Err(AppError::msg("applies_to 只允许 all | image | video"));
    }
    let exists: Option<i64> = conn
        .query_row("SELECT 1 FROM tag_facets WHERE key = ?1", [&key], |r| r.get(0))
        .optional()?;
    if exists.is_some() {
        return Err(AppError::msg("分面 key 已存在（创建后不可修改）"));
    }
    let now = chrono::Utc::now().timestamp_millis();
    let sort_order: i64 = conn.query_row("SELECT COALESCE(MAX(sort_order), 0) + 10 FROM tag_facets", [], |r| {
        r.get(0)
    })?;
    conn.execute(
        "INSERT INTO tag_facets
         (key, display_name, description, selection_mode, max_items, sort_order, is_system, status, applies_to, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, 'active', ?7, ?8, ?8)",
        params![key, display_name, description, selection_mode, max_items, sort_order, applies_to, now],
    )?;
    get(conn, &key)
}

/// 修改显示属性（显示名/描述）；key 不可改。
pub fn update_display(conn: &Connection, key: &str, display_name: &str, description: &str) -> AppResult<()> {
    let display_name = display_name.trim().to_string();
    if display_name.is_empty() {
        return Err(AppError::msg("显示名不能为空"));
    }
    let now = chrono::Utc::now().timestamp_millis();
    let n = conn.execute(
        "UPDATE tag_facets SET display_name=?1, description=?2, updated_at=?3 WHERE key=?4",
        params![display_name, description, now, key],
    )?;
    if n == 0 {
        return Err(AppError::msg("分面不存在"));
    }
    Ok(())
}

/// 修改规则（selection_mode / max_items / applies_to）。
pub fn update_rules(
    conn: &Connection,
    key: &str,
    selection_mode: &str,
    max_items: Option<i64>,
    applies_to: &str,
) -> AppResult<()> {
    let (selection_mode, max_items) = normalize_selection_mode(selection_mode, max_items)?;
    if applies_to != "all" && applies_to != "image" && applies_to != "video" {
        return Err(AppError::msg("applies_to 只允许 all | image | video"));
    }
    let now = chrono::Utc::now().timestamp_millis();
    let n = conn.execute(
        "UPDATE tag_facets SET selection_mode=?1, max_items=?2, applies_to=?3, updated_at=?4 WHERE key=?5",
        params![selection_mode, max_items, applies_to, now, key],
    )?;
    if n == 0 {
        return Err(AppError::msg("分面不存在"));
    }
    Ok(())
}

fn normalize_selection_mode(selection_mode: &str, max_items: Option<i64>) -> AppResult<(String, Option<i64>)> {
    if selection_mode != "single" && selection_mode != "multi" {
        return Err(AppError::msg("selection_mode 只允许 single | multi"));
    }
    let max_items = match selection_mode {
        "single" => Some(1),
        _ => match max_items {
            Some(n) if n >= 1 => Some(n),
            Some(_) => return Err(AppError::msg("多选分面的 max_items 必须为正整数或为空")),
            None => None,
        },
    };
    Ok((selection_mode.to_string(), max_items))
}

/// 重新排序（传入完整的有序 key 列表）。
pub fn reorder(conn: &Connection, ordered_keys: &[String]) -> AppResult<()> {
    // 只更新传入的 key；未传入的不动（幂等）。按索引递增 sort_order。
    for (i, k) in ordered_keys.iter().enumerate() {
        conn.execute(
            "UPDATE tag_facets SET sort_order=?1, updated_at=?2 WHERE key=?3",
            params![(i + 1) as i64 * 10, chrono::Utc::now().timestamp_millis(), k],
        )?;
    }
    Ok(())
}

/// 停用（软停用，保留历史引用）。系统分面默认拒绝停用（可提供 force 以仅停止展示）。
pub fn deactivate(conn: &Connection, key: &str) -> AppResult<()> {
    let f = get(conn, key)?;
    if f.is_system {
        return Err(AppError::msg("系统分面不能停用（仅允许停用展示能力）"));
    }
    let now = chrono::Utc::now().timestamp_millis();
    let n = conn.execute(
        "UPDATE tag_facets SET status='inactive', updated_at=?1 WHERE key=?2 AND status='active'",
        params![now, key],
    )?;
    if n == 0 && f.status != "inactive" {
        return Err(AppError::msg("分面不存在或已停用"));
    }
    Ok(())
}

/// 恢复。
pub fn restore(conn: &Connection, key: &str) -> AppResult<()> {
    let now = chrono::Utc::now().timestamp_millis();
    let n = conn.execute(
        "UPDATE tag_facets SET status='active', updated_at=?1 WHERE key=?2",
        params![now, key],
    )?;
    if n == 0 {
        return Err(AppError::msg("分面不存在"));
    }
    Ok(())
}

/// 停用前的影响范围（指导书 §12.3）：标签数量、引用素材数量、AI 配置数量。
pub fn get_impact(conn: &Connection, key: &str) -> AppResult<FacetImpact> {
    let tag_count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM tags WHERE facet_key = ?1",
        [key],
        |r| r.get(0),
    )?;
    let asset_count: i64 = conn.query_row(
        "SELECT COUNT(DISTINCT at.asset_id) FROM asset_tags at
          JOIN tags t ON t.id = at.tag_id WHERE t.facet_key = ?1",
        [key],
        |r| r.get(0),
    )?;
    let ai_config_count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM settings WHERE key = 'ai_facet_configs' AND value LIKE ?1",
        [format!("%{key}%")],
        |r| r.get(0),
    )?;
    Ok(FacetImpact {
        tag_count,
        asset_count,
        ai_config_count,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::init_memory;

    fn conn() -> Connection {
        init_memory().unwrap()
    }

    #[test]
    fn validate_key_enforces_snake_case() {
        assert_eq!(validate_key("clothing_color").unwrap(), "clothing_color");
        assert!(validate_key("镜头语言").is_err());
        assert!(validate_key("1bad").is_err());
        assert!(validate_key("a").is_err()); // 太短
        assert!(validate_key("has space").is_err());
        assert!(validate_key("UPPER").is_ok()); // 自动小写
    }

    #[test]
    fn create_sets_user_facet_and_rejects_duplicate() {
        let c = conn();
        let f = create(&c, "clothing_color", "衣服颜色", "描述", "multi", Some(3), "image").unwrap();
        assert_eq!(f.key, "clothing_color");
        assert!(!f.is_system);
        assert_eq!(f.applies_to, "image");
        assert_eq!(f.max_items, Some(3));
        // duplicate key rejected
        assert!(create(&c, "clothing_color", "重复", "", "multi", Some(3), "all").is_err());
        // bad selection mode rejected
        assert!(create(&c, "another", "名", "", "singlex", Some(3), "all").is_err());
    }

    #[test]
    fn single_mode_forces_max_items_one() {
        let c = conn();
        let f = create(&c, "pick_one", "单选", "", "single", Some(5), "all").unwrap();
        assert_eq!(f.selection_mode, "single");
        assert_eq!(f.max_items, Some(1)); // single 强制 1
    }

    #[test]
    fn deactivate_restore_roundtrip_and_system_protected() {
        let c = conn();
        let f = create(&c, "mood", "氛围", "", "multi", None, "all").unwrap();
        deactivate(&c, &f.key).unwrap();
        assert_eq!(get(&c, &f.key).unwrap().status, "inactive");
        // 停用后 list()（active）不含它
        assert!(!list(&c).unwrap().iter().any(|x| x.key == "mood"));
        restore(&c, &f.key).unwrap();
        assert_eq!(get(&c, &f.key).unwrap().status, "active");
        // 系统分面（is_system=1）不能停用
        let sys = get(&c, "subject").unwrap();
        assert!(deactivate(&c, &sys.key).is_err());
    }

    #[test]
    fn impact_counts_tags_and_assets() {
        let c = conn();
        let f = create(&c, "impact_facet", "影响", "", "multi", None, "all").unwrap();
        // 造一个 tag 挂在分面下（tags 表需要 name/facet_key）
        c.execute(
            "INSERT INTO tags (name, normalized_name, canonical_name, facet_key, is_system, status, sort_order)
             VALUES ('红', '红', '红', ?1, 0, 'active', 0)",
            [&f.key],
        )
        .unwrap();
        let impact = get_impact(&c, &f.key).unwrap();
        assert_eq!(impact.tag_count, 1);
        assert_eq!(impact.asset_count, 0);
    }

    #[test]
    fn update_display_and_rules() {
        let c = conn();
        let f = create(&c, "rules_facet", "旧名", "旧描述", "multi", Some(2), "all").unwrap();
        update_display(&c, &f.key, "新名", "新描述").unwrap();
        let updated = get(&c, &f.key).unwrap();
        assert_eq!(updated.display_name, "新名");
        assert_eq!(updated.description, "新描述");
        // key 不可改（update 不提供 key 变更）
        update_rules(&c, &f.key, "single", None, "video").unwrap();
        let updated2 = get(&c, &f.key).unwrap();
        assert_eq!(updated2.selection_mode, "single");
        assert_eq!(updated2.max_items, Some(1));
        assert_eq!(updated2.applies_to, "video");
    }
}

/// 兼容旧 AI 分类显示名，所有新协议应直接使用稳定 key。
pub fn key_for_legacy_name(name: &str) -> &'static str {
    match name.trim() {
        "subject" => "subject",
        "scene" => "scene",
        "purpose" => "purpose",
        "style" => "style",
        "color" => "color",
        "composition" => "composition",
        "lighting" => "lighting",
        "people" => "people",
        "technical" => "technical",
        "custom" => "custom",
        "主体" | "主体/对象" | "物体" => "subject",
        "场景" | "场景/地点" => "scene",
        "用途" | "用途/项目类型" => "purpose",
        "风格" | "风格/氛围" | "色彩风格" | "氛围情绪" => "style",
        "色彩" | "色调" => "color",
        "构图" | "构图视角" | "构图/视角" => "composition",
        "光线" | "时间" | "光线/时间" | "光线/时间氛围" => "lighting",
        "人物" | "人物属性" | "人物/主体属性" => "people",
        "技术" | "可用性/技术特征" => "technical",
        _ => "custom",
    }
}

pub fn display_name_for_key(key: &str) -> &'static str {
    match key {
        "subject" => "主体/对象",
        "scene" => "场景/地点",
        "purpose" => "用途",
        "style" => "风格/氛围",
        "color" => "色彩",
        "composition" => "构图/视角",
        "lighting" => "光线/时间",
        "people" => "人物属性",
        "technical" => "可用性/技术特征",
        _ => "自定义",
    }
}

/// 由设置中的 ai_facet_configs 与数据库 tag_facets 合并出 AI 提示词上下文。
/// tag_facets 是唯一事实源：selection_mode / max_items / 描述 以数据库为准；
/// hint / display_name（可选覆盖）来自设置；只保留 enabled_for_ai = true 的分面。
pub fn build_prompt_context(
    conn: &Connection,
    configs: &[AiFacetConfig],
) -> AppResult<Vec<FacetPromptContext>> {
    let db_facets: std::collections::BTreeMap<String, TagFacet> = list(conn)?
        .into_iter()
        .map(|f| (f.key.clone(), f))
        .collect();
    let mut out = Vec::new();
    for cfg in configs {
        if !cfg.enabled_for_ai {
            continue;
        }
        let Some(dbf) = db_facets.get(&cfg.facet_key) else {
            // 设置在数据库无此分面：跳过（防陈旧配置）
            continue;
        };
        let display_name = cfg
            .display_name
            .clone()
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| dbf.display_name.clone());
        out.push(FacetPromptContext {
            key: cfg.facet_key.clone(),
            display_name,
            description: dbf.description.clone(),
            hint: cfg.hint.clone(),
            selection_mode: dbf.selection_mode.clone(),
            max_items: dbf.max_items,
        });
    }
    Ok(out)
}
