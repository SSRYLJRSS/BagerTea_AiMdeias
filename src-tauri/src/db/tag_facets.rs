//! 稳定标签分面：分面 key 是协议和数据边界，显示名称可以本地化。

use rusqlite::Connection;
use serde::{Deserialize, Serialize};

use crate::db::settings::AiFacetConfig;
use crate::error::AppResult;

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
}

pub fn list(conn: &Connection) -> AppResult<Vec<TagFacet>> {
    let mut stmt = conn.prepare(
        "SELECT key, display_name, description, selection_mode, max_items,
                sort_order, is_system, status
           FROM tag_facets WHERE status = 'active'
          ORDER BY sort_order, key",
    )?;
    let rows = stmt
        .query_map([], |r| {
            Ok(TagFacet {
                key: r.get(0)?,
                display_name: r.get(1)?,
                description: r.get(2)?,
                selection_mode: r.get(3)?,
                max_items: r.get(4)?,
                sort_order: r.get(5)?,
                is_system: r.get::<_, i64>(6)? != 0,
                status: r.get(7)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

pub fn get(conn: &Connection, key: &str) -> AppResult<TagFacet> {
    Ok(conn.query_row(
        "SELECT key, display_name, description, selection_mode, max_items,
                sort_order, is_system, status FROM tag_facets WHERE key = ?1",
        [key],
        |r| {
            Ok(TagFacet {
                key: r.get(0)?,
                display_name: r.get(1)?,
                description: r.get(2)?,
                selection_mode: r.get(3)?,
                max_items: r.get(4)?,
                sort_order: r.get(5)?,
                is_system: r.get::<_, i64>(6)? != 0,
                status: r.get(7)?,
            })
        },
    )?)
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
