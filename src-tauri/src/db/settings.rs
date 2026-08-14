//! 设置：SQLite 键值表存储，整体 JSON 读写（架构 §5.6：首版本地明文）

use rusqlite::Connection;
use serde::{Deserialize, Serialize};

use crate::error::AppResult;

/// 一套 API 配置档案（一个中转站/服务商）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiProfile {
    pub id: String,
    pub name: String,
    /// 接口协议模式：openai（/chat/completions）| anthropic（/messages）
    #[serde(default = "default_api_mode")]
    pub api_mode: String,
    #[serde(default)]
    pub base_url: String,
    #[serde(default)]
    pub api_key: String,
    #[serde(default = "default_model")]
    pub model: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiSettings {
    /// 多套 API 配置（中转站），打标只走激活那套
    #[serde(default)]
    pub profiles: Vec<ApiProfile>,
    /// 当前激活档案 id
    #[serde(default)]
    pub active_profile: String,
    // ---- 以下为旧版扁平字段：仅作迁移输入，不再序列化 ----
    #[serde(default, skip_serializing)]
    pub api_mode: String,
    #[serde(default, skip_serializing)]
    pub base_url: String,
    #[serde(default, skip_serializing)]
    pub api_key: String,
    #[serde(default = "default_model", skip_serializing)]
    pub model: String,
    #[serde(default)]
    pub auto_tagging: bool,
    #[serde(default)]
    pub video_tagging: bool,
    #[serde(default = "default_tier")]
    pub local_model_tier: String,
    #[serde(default = "default_batch_limit")]
    pub batch_limit: i64,
}

impl AiSettings {
    /// 旧版扁平配置迁移：无档案但有 base_url/api_key 时合成「默认配置」
    pub fn normalize(&mut self) {
        if self.profiles.is_empty() && (!self.base_url.is_empty() || !self.api_key.is_empty()) {
            self.profiles.push(ApiProfile {
                id: "default".into(),
                name: "默认配置".into(),
                api_mode: if self.api_mode.is_empty() {
                    default_api_mode()
                } else {
                    self.api_mode.clone()
                },
                base_url: self.base_url.clone(),
                api_key: self.api_key.clone(),
                model: self.model.clone(),
            });
            self.active_profile = "default".into();
        }
    }

    /// 当前激活档案（找不到时回退第一套）
    pub fn active(&self) -> Option<&ApiProfile> {
        self.profiles
            .iter()
            .find(|p| p.id == self.active_profile)
            .or(self.profiles.first())
    }
}

fn default_api_mode() -> String {
    "openai".into()
}
fn default_model() -> String {
    "qwen-vl-plus".into()
}
fn default_tier() -> String {
    "light".into()
}
fn default_batch_limit() -> i64 {
    500 // v2.5：胶片条方案下放宽（老板拍板）
}

/// 标签分类（PRD 5.5）：分类=父标签；hint 参与 AI 提示词，single 控制单/多选
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TagCategory {
    pub name: String,
    #[serde(default)]
    pub hint: String,
    #[serde(default)]
    pub single: bool,
    /// 每类标签数量上限（v2.11，写入 AI 提示词）
    #[serde(default = "default_category_max")]
    pub max: i64,
}

fn default_category_max() -> i64 {
    3
}

pub fn default_tag_categories() -> Vec<TagCategory> {
    [
        ("场景", "如公园/街道/室内，选最主要的一个", true),
        ("色彩风格", "如胶片感/低饱和/高对比/清新", false),
        ("人物", "人物数量、年龄段、动作姿态，无人物则留空", false),
        ("物体", "画面中的关键物体", false),
        ("氛围情绪", "如宁静/热烈/孤独/治愈", false),
        ("构图视角", "如特写/全景/俯拍/对称", true),
        ("光线", "只描述光线方向与质感，如逆光/柔光/黄昏金调", false),
    ]
    .into_iter()
    .map(|(name, hint, single)| TagCategory {
        name: name.into(),
        hint: hint.into(),
        single,
        max: if single { 1 } else { 3 },
    })
    .collect()
}

impl Default for AiSettings {
    fn default() -> Self {
        Self {
            profiles: Vec::new(),
            active_profile: String::new(),
            api_mode: String::new(),
            base_url: String::new(),
            api_key: String::new(),
            model: default_model(),
            auto_tagging: false,
            video_tagging: false,
            local_model_tier: default_tier(),
            batch_limit: default_batch_limit(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    #[serde(default)]
    pub ai: AiSettings,
    #[serde(default = "default_theme")]
    pub theme: String, // system|light|dark
    #[serde(default = "default_cache_mb")]
    pub thumbnail_cache_mb: i64,
    /// 标签分类（PRD 5.5，设置页可管理）
    #[serde(default = "default_tag_categories")]
    pub tag_categories: Vec<TagCategory>,
    /// 总库位置（R-32）；空 = 原位索引模式
    #[serde(default)]
    pub library_root: String,
}

fn default_theme() -> String {
    "system".into()
}
fn default_cache_mb() -> i64 {
    2048
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            ai: AiSettings::default(),
            theme: default_theme(),
            thumbnail_cache_mb: default_cache_mb(),
            tag_categories: default_tag_categories(),
            library_root: String::new(),
        }
    }
}

const KEY: &str = "app_settings";

pub fn get_settings(conn: &Connection) -> AppResult<Settings> {
    let mut stmt = conn.prepare("SELECT value FROM settings WHERE key = ?1")?;
    let mut rows = stmt.query([KEY])?;
    if let Some(row) = rows.next()? {
        let raw: String = row.get(0)?;
        let mut s: Settings = serde_json::from_str(&raw).unwrap_or_default();
        s.ai.normalize();
        return Ok(s);
    }
    Ok(Settings::default())
}

pub fn save_settings(conn: &Connection, s: &Settings) -> AppResult<()> {
    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        rusqlite::params![KEY, serde_json::to_string(s)?],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legacy_flat_config_migrates_to_profile() {
        let mut ai: AiSettings = serde_json::from_str(
            r#"{"baseUrl":"https://a.com/v1","apiKey":"sk-x","model":"m1","apiMode":"anthropic"}"#,
        )
        .unwrap();
        ai.normalize();
        assert_eq!(ai.profiles.len(), 1);
        let p = ai.active().unwrap();
        assert_eq!(p.base_url, "https://a.com/v1");
        assert_eq!(p.api_mode, "anthropic");
        assert_eq!(p.model, "m1");
        assert_eq!(ai.active_profile, "default");
    }

    #[test]
    fn empty_config_stays_empty() {
        let mut ai = AiSettings::default();
        ai.normalize();
        assert!(ai.active().is_none());
    }

    #[test]
    fn active_falls_back_to_first() {
        let mut ai = AiSettings::default();
        ai.profiles.push(ApiProfile {
            id: "p1".into(),
            name: "A".into(),
            api_mode: "openai".into(),
            base_url: "u".into(),
            api_key: "k".into(),
            model: "m".into(),
        });
        ai.active_profile = "not-exist".into();
        assert_eq!(ai.active().unwrap().id, "p1");
    }
}
