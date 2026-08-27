//! 设置：SQLite 键值表存储，整体 JSON 读写（架构 §5.6：首版本地明文）

use rusqlite::Connection;
use serde::{Deserialize, Serialize};

use crate::error::AppResult;

/// AI 分面配置（P1B：tag_facets 是唯一事实源，设置只保存 facetKey/hint/enabledForAi/displayName）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiFacetConfig {
    pub facet_key: String,
    #[serde(default)]
    pub hint: String,
    /// 是否参与 AI 打标与 AI 搜索提示词
    #[serde(default = "default_enabled_for_ai")]
    pub enabled_for_ai: bool,
    /// 可选本地化显示名；为空时用 tag_facets.display_name
    #[serde(default)]
    pub display_name: Option<String>,
    /// 是否显示在人工打标工作台（独立于 enabled_for_ai）。
    /// None = 未显式设置（前端按 WORKBENCH_DEFAULT_KEYS 决定默认显示；缺省不序列化）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub visible_in_workbench: Option<bool>,
}

fn default_enabled_for_ai() -> bool {
    true
}

/// 一套 API 配置档案（一个中转站/服务商）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiProfile {
    pub id: String,
    pub name: String,
    /// 接口协议模式：openai（/chat/completions）| anthropic（/messages）
    #[serde(default = "default_api_mode")]
    pub api_mode: String,
    /// 部署类型（P3-01a）：cloud（云端服务商）| local（本机 OpenAI 兼容服务，如 Ollama/LM Studio）；
    /// serde 默认 cloud，旧数据零感知
    #[serde(default = "default_profile_kind")]
    pub kind: String,
    #[serde(default)]
    pub base_url: String,
    #[serde(default)]
    pub api_key: String,
    #[serde(default = "default_model")]
    pub model: String,
}

impl ApiProfile {
    pub fn is_local(&self) -> bool {
        self.kind == "local"
    }
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
    /// 一键安装的下载源偏好（"auto" = 测速选最快；旧数据缺省视为 auto）
    #[serde(default = "default_ollama_source_id")]
    pub ollama_source_id: String,
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
                kind: default_profile_kind(),
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
fn default_ollama_source_id() -> String {
    "auto".into()
}
fn default_custom_sources() -> Vec<CustomSource> {
    Vec::new()
}
fn default_profile_kind() -> String {
    "cloud".into()
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
        ("色彩", "主色、色调与色彩关系，如青橙/暗调/冷调", false),
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
            ollama_source_id: default_ollama_source_id(),
        }
    }
}

/// 用户自定义下载源（改造方案：即时落库资产，独立于 draft）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomSource {
    pub id: String,
    pub label: String,
    pub url: String,
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
    /// 已弃用：机器协议迁移到 ai_facet_configs。保留字段作反序列化兼容，仅作迁移输入。
    #[serde(default, skip_serializing)]
    pub tag_categories: Vec<TagCategory>,
    /// AI 分面配置（P1B 唯一事实源，facet_key 稳定不可修改）
    #[serde(default)]
    pub ai_facet_configs: Vec<AiFacetConfig>,
    /// 总库位置（R-32）；空 = 原位索引模式
    #[serde(default)]
    pub library_root: String,
    /// 回收站保留天数（R-22）；启动时清理超期项，0 = 不自动清理
    #[serde(default = "default_trash_retention_days")]
    pub trash_retention_days: i64,
    /// Ollama 一键下载的自定义源（即时落库；旧数据缺省空）
    #[serde(default = "default_custom_sources")]
    pub custom_download_sources: Vec<CustomSource>,
    /// Ollama 模型下载代理（改造方案·加速项 A：拉起 serve 时注入 HTTPS_PROXY；空 = 不用代理）
    #[serde(default)]
    pub model_download_proxy: String,
}

fn default_theme() -> String {
    "system".into()
}
fn default_cache_mb() -> i64 {
    2048
}
fn default_trash_retention_days() -> i64 {
    30
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            ai: AiSettings::default(),
            theme: default_theme(),
            thumbnail_cache_mb: default_cache_mb(),
            tag_categories: Vec::new(),
            ai_facet_configs: Vec::new(),
            library_root: String::new(),
            trash_retention_days: default_trash_retention_days(),
            custom_download_sources: default_custom_sources(),
            model_download_proxy: String::new(),
        }
    }
}

/// 读取侧：对一份已解析的 Settings 就地新增自定义源（纯逻辑，便于单测/命令复用）
pub fn add_custom_source(s: &mut Settings, src: CustomSource) {
    s.custom_download_sources.push(src);
}

/// 读取侧：按 id 移除自定义源；返回是否移除成功
pub fn remove_custom_source(s: &mut Settings, id: &str) -> bool {
    let before = s.custom_download_sources.len();
    s.custom_download_sources.retain(|c| c.id != id);
    s.custom_download_sources.len() != before
}

const KEY: &str = "app_settings";

/// 把旧的 tag_categories（中文分类名）映射为 ai_facet_configs（稳定 facet_key）。
/// 这是唯一一次迁移：此后业务只读 ai_facet_configs。
fn migrate_tag_categories_to_facets(s: &mut Settings) {
    if s.tag_categories.is_empty() {
        return;
    }
    let mut existing: std::collections::HashSet<String> = s
        .ai_facet_configs
        .iter()
        .map(|c| c.facet_key.clone())
        .collect();
    for cat in &s.tag_categories {
        let facet = super::tag_facets::key_for_legacy_name(&cat.name).to_string();
        if existing.contains(&facet) {
            // 同分面重复：合并 hint（旧 hint 非空则保留）
            if let Some(cfg) = s.ai_facet_configs.iter_mut().find(|c| c.facet_key == facet) {
                if cfg.hint.is_empty() && !cat.hint.is_empty() {
                    cfg.hint = cat.hint.clone();
                }
            }
            continue;
        }
        existing.insert(facet.clone());
        s.ai_facet_configs.push(AiFacetConfig {
            facet_key: facet,
            hint: cat.hint.clone(),
            enabled_for_ai: true,
            display_name: None,
            visible_in_workbench: None,
        });
    }
    s.tag_categories.clear();
}

/// 全新/无配置时，用默认分面清单充实 ai_facet_configs（保证 AI 打标有提示词上下文）。
fn normalize_ai_facet_defaults(s: &mut Settings) {
    if s.ai_facet_configs.is_empty() {
        for cat in default_tag_categories() {
            let facet = super::tag_facets::key_for_legacy_name(&cat.name).to_string();
            if s.ai_facet_configs.iter().any(|c| c.facet_key == facet) {
                continue;
            }
            s.ai_facet_configs.push(AiFacetConfig {
                facet_key: facet,
                hint: cat.hint,
                enabled_for_ai: true,
                display_name: None,
                visible_in_workbench: None,
            });
        }
    }
}

/// C-5/V11：存量库补齐独立 color 分面的 AI 配置 —— 老库可能已把「色彩风格」归 style 而缺少 color。
/// 幂等：已有 color 配置则不变；只补默认，不覆盖用户已有的 style hint 或任何配置内容。
pub fn ensure_color_facet_config(conn: &Connection) -> AppResult<()> {
    let mut stmt = conn.prepare("SELECT value FROM settings WHERE key = ?1")?;
    let mut rows = stmt.query([KEY])?;
    let Some(row) = rows.next()? else {
        return Ok(());
    };
    let raw: String = row.get(0)?;
    let mut s: Settings = serde_json::from_str(&raw).unwrap_or_default();
    if s.ai_facet_configs.iter().any(|c| c.facet_key == "color") {
        return Ok(());
    }
    s.ai_facet_configs.push(AiFacetConfig {
        facet_key: "color".into(),
        hint: "主色、色调与色彩关系，如青橙/暗调/冷调".into(),
        enabled_for_ai: true,
        display_name: None,
        visible_in_workbench: None,
    });
    save_settings(conn, &s)?;
    Ok(())
}

pub fn get_settings(conn: &Connection) -> AppResult<Settings> {
    let mut stmt = conn.prepare("SELECT value FROM settings WHERE key = ?1")?;
    let mut rows = stmt.query([KEY])?;
    if let Some(row) = rows.next()? {
        let raw: String = row.get(0)?;
        let mut s: Settings = serde_json::from_str(&raw).unwrap_or_default();
        // 兼容迁移：旧 tag_categories → ai_facet_configs；全空则用默认分面清单
        migrate_tag_categories_to_facets(&mut s);
        normalize_ai_facet_defaults(&mut s);
        s.ai.normalize();
        return Ok(s);
    }
    let mut d = Settings::default();
    normalize_ai_facet_defaults(&mut d);
    Ok(d)
}

pub fn save_settings(conn: &Connection, s: &Settings) -> AppResult<()> {
    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        rusqlite::params![KEY, serde_json::to_string(s)?],
    )?;
    Ok(())
}

/// V10 迁移：读 settings JSON → 旧 tag_categories 转 ai_facet_configs → 写回。
/// 幂等：已转（tag_categories 为空）则不变。立即落库，保证重启后无需再转。
pub fn normalize_settings_persist(conn: &Connection) -> AppResult<()> {
    let mut stmt = conn.prepare("SELECT value FROM settings WHERE key = ?1")?;
    let mut rows = stmt.query([KEY])?;
    let Some(row) = rows.next()? else {
        return Ok(());
    };
    let raw: String = row.get(0)?;
    let mut s: Settings = serde_json::from_str(&raw).unwrap_or_default();
    // 标记是否需要写回（tag_categories 有值说明未迁移）
    if !s.tag_categories.is_empty() {
        migrate_tag_categories_to_facets(&mut s);
        save_settings(conn, &s)?;
    }
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
    fn legacy_profile_defaults_to_cloud_kind() {
        let p: ApiProfile = serde_json::from_str(
            r#"{"id":"x","name":"旧档案","baseUrl":"http://a/v1","apiKey":"k","model":"m"}"#,
        )
        .unwrap();
        assert_eq!(p.kind, "cloud");
        assert!(!p.is_local());
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
            kind: "cloud".into(),
            base_url: "u".into(),
            api_key: "k".into(),
            model: "m".into(),
        });
        ai.active_profile = "not-exist".into();
        assert_eq!(ai.active().unwrap().id, "p1");
    }

    #[test]
    fn legacy_settings_default_new_fields() {
        // 旧数据无新字段 → serde default 兜底
        let s: Settings =
            serde_json::from_str(r#"{"ai":{"profiles":[]},"theme":"system"}"#).unwrap();
        assert_eq!(s.ai.ollama_source_id, "auto");
        assert!(s.custom_download_sources.is_empty());
        assert_eq!(s.model_download_proxy, "");
    }

    #[test]
    fn custom_source_add_remove_roundtrip() {
        let mut s = Settings::default();
        add_custom_source(
            &mut s,
            CustomSource {
                id: "custom-1".into(),
                label: "NAS".into(),
                url: "https://nas/x".into(),
            },
        );
        assert_eq!(s.custom_download_sources.len(), 1);
        assert!(remove_custom_source(&mut s, "custom-1"));
        assert_eq!(s.custom_download_sources.len(), 0);
        assert!(!remove_custom_source(&mut s, "custom-1"));
    }

    #[test]
    fn legacy_tag_categories_migrate_to_facet_configs() {
        let mut s: Settings = serde_json::from_str(
            r#"{"tagCategories":[{"name":"场景","hint":"如公园/街道","single":true,"max":1},
                {"name":"未知分类","hint":"hint-x","single":false,"max":3}]}"#,
        )
        .unwrap();
        // get_settings 会调用的迁移
        super::migrate_tag_categories_to_facets(&mut s);
        assert!(s.tag_categories.is_empty());
        let scene = s
            .ai_facet_configs
            .iter()
            .find(|c| c.facet_key == "scene")
            .expect("场景应映射到 scene");
        assert_eq!(scene.hint, "如公园/街道");
        assert!(scene.enabled_for_ai);
        // 未知分类 → custom
        let custom = s
            .ai_facet_configs
            .iter()
            .find(|c| c.facet_key == "custom")
            .expect("未知分类应归 custom");
        assert_eq!(custom.hint, "hint-x");
    }

    #[test]
    fn facet_config_roundtrip_json() {
        let c = AiFacetConfig {
            facet_key: "scene".into(),
            hint: "海边".into(),
            enabled_for_ai: true,
            display_name: Some("场景".into()),
            visible_in_workbench: None,
        };
        let json = serde_json::to_string(&c).unwrap();
        let back: AiFacetConfig = serde_json::from_str(&json).unwrap();
        assert_eq!(back.facet_key, "scene");
        assert_eq!(back.display_name.as_deref(), Some("场景"));
        // 未显式设置 visibleInWorkbench 不序列化（前端按白名单兜底）
        assert!(back.visible_in_workbench.is_none());
        assert!(!json.contains("visibleInWorkbench"));
    }

    #[test]
    fn old_serialization_skips_legacy_tag_categories() {
        let mut s = Settings::default();
        s.tag_categories.push(TagCategory {
            name: "场景".into(),
            hint: String::new(),
            single: false,
            max: 3,
        });
        let json = serde_json::to_string(&s).unwrap();
        assert!(
            !json.contains("tagCategories"),
            "tag_categories 不应再序列化"
        );
    }
}
