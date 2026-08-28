//! 云端 AI 打标服务（T05a，R-06）：OpenAI 兼容视觉 API（通义千问 VL / 智谱等）
//! - 同步 blocking 风格（与 importer/export_local 一致，command 层包事件）
//! - 图片优先用高清缩略图（省流量），失败回退占位图/原图
//! - 逐条建议写回 + 批次计数 + 进度回调 + 取消

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::Engine;
use rusqlite::Connection;
use serde::Serialize;

use crate::db::ai::{self, CategorizedTags};
use crate::db::tag_facets::FacetPromptContext;
use crate::db::{
    assets,
    settings::{AiSettings, ApiProfile},
};
use crate::error::{AppError, AppResult};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiProgress {
    pub batch_id: i64,
    pub processed: i64,
    pub total: i64,
    pub current_asset_id: i64,
}

/// 按分面组装提示词（P1B + C-3）：使用稳定英文 facetKey 作为 JSON 键，中文显示名仅作说明；
/// 避免模型返回中文分类名导致归类不稳定，也确保 color 独立于 style。
fn build_prompt(facets: &[FacetPromptContext]) -> String {
    let mut lines = String::from(
        "请为这张图片按以下分面生成简短中文标签。只返回 JSON 对象，键必须为英文分面 key，值为标签字符串数组，无合适标签的分面给空数组，不要其他内容。\n",
    );
    lines.push_str("分面与要求：\n");
    for c in facets {
        let rule = if c.selection_mode == "single" {
            "（单选，最多 1 个）".to_string()
        } else {
            format!("（可多选，1-{} 个）", c.max_items.unwrap_or(3).max(1))
        };
        lines.push_str(&format!(
            "- {}(key: {}){}{}\n",
            c.display_name,
            c.key,
            rule,
            if c.hint.is_empty() {
                String::new()
            } else {
                format!("：{}", c.hint)
            }
        ));
    }
    lines.push_str(
        "示例：{\"subject\":[\"人\"],\"scene\":[\"海边\"],\"color\":[\"青橙\"]}。\
         颜色类标签只归 color，不归 style；时间/光线只归 lighting；构图归 composition；人物归 people。",
    );
    lines
}

/// 从模型回复中提取分类标签对象（宽容：先整串 JSON，再退化找 {...} 片段；旧扁平数组收进「未分类」）
pub fn parse_categorized(content: &str) -> CategorizedTags {
    let trimmed = content.trim();
    let parsed: Option<serde_json::Value> = serde_json::from_str(trimmed).ok().or_else(|| {
        let start = trimmed.find('{')?;
        let end = trimmed.rfind('}')?;
        serde_json::from_str(&trimmed[start..=end]).ok()
    });
    let Some(v) = parsed else {
        return CategorizedTags::new();
    };
    let mut out = CategorizedTags::new();
    if let Some(obj) = v.as_object() {
        for (k, val) in obj {
            let tags: Vec<String> = match val {
                serde_json::Value::Array(arr) => arr
                    .iter()
                    .filter_map(|t| t.as_str().map(String::from))
                    .collect(),
                serde_json::Value::String(s) => vec![s.clone()],
                _ => Vec::new(),
            }
            .into_iter()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty() && s.chars().count() <= 20)
            .take(5)
            .collect();
            if !tags.is_empty() {
                out.insert(k.trim().to_string(), tags);
            }
        }
    } else if let Some(arr) = v.as_array() {
        let tags: Vec<String> = arr
            .iter()
            .filter_map(|t| t.as_str().map(String::from))
            .collect();
        if !tags.is_empty() {
            out.insert("未分类".to_string(), tags);
        }
    }
    out
}

/// C-4：解析并校验 AI 回复的分面键。
/// 返回（稳定 facetKey 归一后的标签, warnings）：稳定 key / 兼容旧中文 key 都归一为稳定 facetKey；
/// 未知 key 记入 warnings 并归入自定义，但绝不静默丢失（调用方应记录/展示 warning）。
pub fn parse_categorized_checked(
    content: &str,
    valid_keys: &[&str],
) -> (CategorizedTags, Vec<String>) {
    let raw = parse_categorized(content);
    let mut warnings = Vec::new();
    let mut out = CategorizedTags::new();
    for (k, list) in &raw {
        let trimmed = k.trim();
        let mapped = crate::db::tag_facets::key_for_legacy_name(trimmed);
        let known = valid_keys.contains(&mapped)
            || valid_keys.contains(&trimmed)
            || trimmed.eq_ignore_ascii_case("custom");
        if !known {
            warnings.push(format!("未知分面 key「{trimmed}」已归入自定义，建议改用稳定 facetKey"));
        }
        let target = if valid_keys.contains(&mapped) {
            mapped.to_string()
        } else if mapped == "custom" {
            "custom".to_string()
        } else {
            mapped.to_string()
        };
        out.entry(target).or_default().extend(list.iter().cloned());
    }
    (out, warnings)
}

/// 退化输出检测（Ollama 长驻状态损坏的已知症状，见 ollama/ollama#8235/#17587）：
/// - 重复单一字符串（@@@@@… / !!!!!…）：采样/分词状态损坏后贪心退化的典型输出；
/// - UTF-8 字节被按 Latin-1 误读的乱码（ä¸æ¯…）：分词器字节错切的典型输出；
///
/// 此类输出重试无意义，应卸载模型重载后重试（社区已验证的恢复手段，#8235 评论）。
fn is_degenerate(content: &str) -> bool {
    let t = content.trim();
    let chars: Vec<char> = t.chars().collect();
    if chars.len() < 6 {
        return false;
    }
    // 全部同字符（@@@@@ / !!!!! …）
    if chars.iter().all(|c| *c == chars[0]) {
        return true;
    }
    // Latin-1 补充区字符占比 >1/3（UTF-8 字节误读为 Latin-1 的乱码特征）
    let latin = chars
        .iter()
        .copied()
        .filter(|c| ('\u{0080}'..='\u{00FF}').contains(c))
        .count();
    latin * 3 > chars.len()
}

/// 本地（Ollama）档案：触发一次模型卸载（keep_alive=0）。
/// 长驻 runner 状态损坏后"卸载重载"即恢复（#8235 作者验证）；失败静默，由上层重试兜底。
/// §8.4：读取响应并记录 done_reason（期望 unload），不再纯 fire-and-forget。
fn unload_ollama_model(cfg: &ApiProfile) {
    // 本地档案 base_url 形如 http://localhost:11434/v1 → 原生端点剥掉 /v1
    let base = cfg.base_url.trim_end_matches('/');
    let native = base.strip_suffix("/v1").unwrap_or(base).to_string();
    let body = serde_json::json!({
        "model": cfg.model,
        "prompt": "",
        "keep_alive": "0",
    });
    let client = match reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(8))
        .build()
    {
        Ok(c) => c,
        Err(_) => return,
    };
    match client
        .post(format!("{native}/api/generate"))
        .json(&body)
        .send()
    {
        Ok(resp) => {
            if let Ok(v) = resp.json::<serde_json::Value>() {
                let done = v
                    .get("done_reason")
                    .and_then(|d| d.as_str())
                    .unwrap_or("?");
                if done == "unload" {
                    tracing::info!("Ollama 模型已卸载（done_reason=unload）：{}", cfg.model);
                } else {
                    tracing::warn!("Ollama 卸载响应 done_reason={done}（期望 unload）");
                }
            }
        }
        Err(e) => {
            tracing::warn!("Ollama 卸载请求失败（签名自愈路径不阻塞）：{e}");
        }
    }
}

/// §8.4：本地（Ollama 原生兼容）请求体统一注入 keep_alive，不依赖服务器默认值。
/// - 仅本地档案注入（云端服务商不接受未知字段）；
/// - 值默认 2m（与服务级 OLLAMA_KEEP_ALIVE 一致；连续批次由 lease 延长是 L3 目标态）。
/// - /v1 兼容端点不保证支持该字段 → 这里注入但不依赖其生效；卸载走原生根地址（见 unload_ollama_model）。
fn apply_keep_alive(body: &mut serde_json::Value, is_local: bool) {
    if is_local {
        body["keep_alive"] = serde_json::json!(KEEP_ALIVE_IDLE);
    }
}

/// 本地服务空闲保留时长常量（§8.1 L1 服务级默认；与 ollama_installer::KEEP_ALIVE_IDLE 一致）
pub const KEEP_ALIVE_IDLE: &str = "2m";

/// 本地模型是否支持视觉/图片输入（启发式短名单；§9.3 视频批次预检用）。
/// 判定顺序：含视觉标记（vl/vision/llava/moondream/minicpm-v/gemma3 等）→ 支持；
/// 命中已知纯文本模型段 → 不支持；未知一律按支持处理（避免误拦自定义视觉模型）。
pub fn model_supports_vision(model: &str) -> bool {
    let m = model.trim().to_ascii_lowercase();
    if m.is_empty() {
        return true;
    }
    let vision_markers = [
        "vl", "vision", "llava", "moondream", "minicpm-v", "minicpmv", "gemma3", "internvl",
        "intern-vl", "qwen2.5-vl", "qwen2-vl", "glm-4v", "cogvlm", "bunny", "llava-phi",
    ];
    if vision_markers.iter().any(|x| m.contains(x)) {
        return true;
    }
    let text_only_markers = [
        "llama3", "llama-3", "llama2", "llama-2", "deepseek", "mistral", "phi-4", "phi4",
        "phi-3", "phi3", "gemma2", "gemma-2", "qwen3", "qwen-3", "qwen2.5", "qwen2", "qwen-2.5",
        "qwen-2", "kimi", "glm-4-", "gemma-1", "gpt-oss",
    ];
    if text_only_markers.iter().any(|x| m.contains(x)) {
        return false;
    }
    true
}

/// 解析模型回复并要求非空（v2.12）：空结果视为失败——通常意味着模型不支持图片输入或未遵循提示词。
/// C-4：通过 parse_categorized_checked 归一化稳定 key 并记录未知 key warning，绝不静默丢到 custom。
/// 失败时把模型原始返回内容（截断）带进错误信息，便于定位“模型没按 JSON 输出”类问题
fn parse_tags_strict(content: &str, valid_keys: &[&str]) -> AppResult<CategorizedTags> {
    let (tags, warnings) = parse_categorized_checked(content, valid_keys);
    for w in &warnings {
        tracing::warn!("AI 打标未知分面 key：{w}");
    }
    if tags.is_empty() {
        let snippet: String = content.chars().take(300).collect();
        let shown = if snippet.chars().count() < content.chars().count() {
            format!("{snippet}…")
        } else {
            snippet
        };
        return Err(AppError::msg(format!(
            "模型未返回可解析的标签（可能不支持图片输入或未按提示词输出 JSON）。模型原始返回：{shown}"
        )));
    }
    Ok(tags)
}

fn request_tags(
    client: &reqwest::blocking::Client,
    cfg: &ApiProfile,
    facets: &[FacetPromptContext],
    image_path: &std::path::Path,
) -> AppResult<CategorizedTags> {
    // 连接失败引导（P3-01a）：本地档案连不上时明示安装/启动本地服务
    let conn_err = |e: reqwest::Error| {
        if cfg.is_local() {
            AppError::msg(format!(
                "无法连接本地服务 {base}：请确认 Ollama/LM Studio 已启动（Ollama 需先 ollama pull 视觉模型，如 llava），或在设置页切回云端档案: {e}",
                base = cfg.base_url
            ))
        } else {
            AppError::msg(format!("云端请求失败: {e}"))
        }
    };
    let bytes = std::fs::read(image_path)?;
    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    // MIME 按扩展名判定：高清/占位缩略图均为 .webp，误标 jpeg 会被严格的服务商拒绝
    let mime = match image_path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .as_deref()
    {
        Some("png") => "image/png",
        Some("webp") => "image/webp",
        Some("gif") => "image/gif",
        _ => "image/jpeg",
    };

    let prompt = build_prompt(facets);
    let base = cfg.base_url.trim_end_matches('/');

    // 发起一次请求并取回模型文本回复（不同协议分支各自组包）
    let fetch: Box<dyn Fn() -> AppResult<String>> = if cfg.api_mode == "anthropic" {
        // Anthropic Messages：x-api-key 鉴权 + base64 source 图片块
        Box::new(move || {
            let body = serde_json::json!({
                "model": cfg.model,
                "max_tokens": 500,
                "messages": [{
                    "role": "user",
                    "content": [
                        { "type": "text", "text": prompt },
                        { "type": "image", "source": { "type": "base64", "media_type": mime, "data": b64 } }
                    ]
                }]
            });
            let resp: serde_json::Value = client
                .post(format!("{base}/messages"))
                .header("x-api-key", &cfg.api_key)
                .header("anthropic-version", "2023-06-01")
                .json(&body)
                .send()
                .map_err(conn_err)?
                .json()
                .map_err(|e| AppError::msg(format!("响应解析失败: {e}")))?;
            extract_anthropic_text(&resp)
                .ok_or_else(|| AppError::msg("Anthropic 返回缺少 text 内容块"))
        })
    } else {
        // OpenAI 兼容（默认）：Bearer 鉴权 + data:image base64
        Box::new(move || {
            let mut body = serde_json::json!({
                "model": cfg.model,
                "messages": [{
                    "role": "user",
                    "content": [
                        { "type": "text", "text": prompt },
                        { "type": "image_url", "image_url": { "url": format!("data:{mime};base64,{b64}") } }
                    ]
                }],
                "max_tokens": 500
            });
            // §8.4：本地请求显式传 keep_alive（不依赖默认值）
            apply_keep_alive(&mut body, cfg.is_local());

            let resp: serde_json::Value = client
                .post(format!("{base}/chat/completions"))
                .bearer_auth(&cfg.api_key)
                .json(&body)
                .send()
                .map_err(conn_err)?
                .json()
                .map_err(|e| AppError::msg(format!("响应解析失败: {e}")))?;

            resp["choices"][0]["message"]["content"]
                .as_str()
                .map(str::to_string)
                .ok_or_else(|| {
                    // 把原始响应（截断）带进错误，便于判断是错误页/限流/空 choices
                    let raw = serde_json::to_string(&resp).unwrap_or_default();
                    let snippet: String = raw.chars().take(300).collect();
                    AppError::msg(format!(
                        "服务未返回可选内容（choices 为空）。原始响应：{snippet}"
                    ))
                })
        })
    };

    let mut content = fetch()?;
    // C-4：有效分面 key 集合（稳定 facetKey），用于校验未知 key 并记录 warning
    let valid_keys: Vec<&str> = facets.iter().map(|f| f.key.as_str()).collect();
    if let Ok(t) = parse_tags_strict(&content, &valid_keys) {
        return Ok(t);
    }
    // 本地档案失败自愈：任何解析失败（@@@@ 退化 / 乱码 / 答非所问）都先卸载重载一次再重试。
    // Ollama 长驻 runner 状态损坏会污染其后全部请求，卸载重载即恢复（ollama/ollama#8235/#17587 已验证）
    if cfg.is_local() {
        unload_ollama_model(cfg);
        if let Ok(c) = fetch() {
            if let Ok(t) = parse_tags_strict(&c, &valid_keys) {
                return Ok(t);
            }
            content = c;
        }
        if is_degenerate(&content) {
            // 重载后仍退化：服务本身已不可用，给用户明确指引
            let snippet: String = content.chars().take(120).collect();
            return Err(AppError::msg(format!(
                "Ollama 模型输出持续异常（原始返回：{snippet}…）：多因长驻服务状态损坏，请重启 Ollama 后重试，或改用云端档案（设置 → AI 打标）。"
            )));
        }
    }
    // 非退化（模型正常回复但没按提示词输出 JSON）：保留原始错误信息便于定位
    parse_tags_strict(&content, &valid_keys)
}

/// 从 Anthropic Messages 响应中取第一个 text 内容块
pub fn extract_anthropic_text(v: &serde_json::Value) -> Option<String> {
    v["content"]
        .as_array()?
        .iter()
        .find(|b| b["type"].as_str() == Some("text"))
        .and_then(|b| b["text"].as_str().map(String::from))
}

/// 从 OpenAI 兼容 /models 响应中提取模型 id 列表（宽容解析）
pub fn parse_model_ids(v: &serde_json::Value) -> Vec<String> {
    let Some(arr) = v["data"].as_array() else {
        return Vec::new();
    };
    arr.iter()
        .filter_map(|m| m["id"].as_str().map(str::trim))
        .filter(|s| !s.is_empty())
        .map(String::from)
        .collect()
}

/// 结构化输出的降级等级（P3 §9.3）：
/// 第 1 级 = API 级结构化输出（Anthropic tool use / OpenAI json_schema）
/// 第 2 级 = json_object + prompt 内嵌 schema
/// 第 3 级 = 纯 prompt + 宽容 JSON 解析（含截取 {} 片段 + 带错误重试一次）
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum TextJsonTier {
    Plain,
    JsonObject,
    Structured,
}

/// 发起一次纯文本 JSON 请求，返回模型文本回复。
/// 统一 OpenAI 兼容与 Anthropic 两种协议；不解析语义，由调用方校验。
/// structured_schema 仅在 Tier::Structured 下使用（OpenAI json_schema 或 Anthropic tool input_schema）。
fn request_text_raw(
    client: &reqwest::blocking::Client,
    cfg: &ApiProfile,
    system: &str,
    user: &str,
    tier: TextJsonTier,
    structured_schema: Option<serde_json::Value>,
) -> AppResult<String> {
    let conn_err = |e: reqwest::Error| {
        if cfg.is_local() {
            AppError::msg(format!(
                "无法连接本地服务 {base}：请确认 Ollama/LM Studio 已启动，或在设置页切回云端档案: {e}",
                base = cfg.base_url
            ))
        } else {
            AppError::msg(format!("云端请求失败: {e}"))
        }
    };
    let base = cfg.base_url.trim_end_matches('/');
    let messages = serde_json::json!([
        { "role": "system", "content": system },
        { "role": "user", "content": user }
    ]);

    let fetch: Box<dyn Fn() -> AppResult<String>> = if cfg.api_mode == "anthropic" {
        Box::new(move || {
            let mut body = serde_json::json!({
                "model": cfg.model,
                "max_tokens": 1024,
                "system": system,
                "messages": [ { "role": "user", "content": user } ]
            });
            // 第 1 级：tool use + 强制 tool_choice（schema 作为工具 input_schema）
            if tier == TextJsonTier::Structured {
                if let Some(sch) = &structured_schema {
                    body["tools"] = serde_json::json!([{
                        "name": "emit_search_intent",
                        "description": "输出自然语言解析后的查询意图。只调用一次，用返回的 JSON 作为最终结果。",
                        "input_schema": sch
                    }]);
                    body["tool_choice"] = serde_json::json!({
                        "type": "tool", "name": "emit_search_intent"
                    });
                }
            }
            let resp: serde_json::Value = client
                .post(format!("{base}/messages"))
                .header("x-api-key", &cfg.api_key)
                .header("anthropic-version", "2023-06-01")
                .json(&body)
                .send()
                .map_err(conn_err)?
                .json()
                .map_err(|e| AppError::msg(format!("响应解析失败: {e}")))?;
            // Anthropic tool use：取 tool_use 块的 input 作为结构化结果
            if tier == TextJsonTier::Structured {
                if let Some(tool_input) = extract_anthropic_tool_input(&resp) {
                    return Ok(tool_input);
                }
            }
            extract_anthropic_text(&resp)
                .ok_or_else(|| AppError::msg("Anthropic 返回缺少 text 内容块"))
        })
    } else {
        // OpenAI 兼容：Bearer 鉴权 + /chat/completions；Tier::Structured 用 response_format json_schema
        Box::new(move || {
            let mut body = serde_json::json!({
                "model": cfg.model,
                "messages": messages,
                "max_tokens": 1024
            });
            if tier == TextJsonTier::Structured {
                if let Some(sch) = &structured_schema {
                    body["response_format"] = serde_json::json!({
                        "type": "json_schema",
                        "json_schema": { "name": "search_intent", "strict": true, "schema": sch }
                    });
                }
            } else if tier == TextJsonTier::JsonObject {
                body["response_format"] = serde_json::json!({ "type": "json_object" });
            }
            // §8.4：本地请求显式传 keep_alive（不依赖默认值）
            apply_keep_alive(&mut body, cfg.is_local());
            let resp: serde_json::Value = if cfg.api_key.trim().is_empty() {
                client
                    .post(format!("{base}/chat/completions"))
                    .json(&body)
                    .send()
                    .map_err(conn_err)?
                    .json()
                    .map_err(|e| AppError::msg(format!("响应解析失败: {e}")))?
            } else {
                client
                    .post(format!("{base}/chat/completions"))
                    .bearer_auth(&cfg.api_key)
                    .json(&body)
                    .send()
                    .map_err(conn_err)?
                    .json()
                    .map_err(|e| AppError::msg(format!("响应解析失败: {e}")))?
            };
            resp["choices"][0]["message"]["content"]
                .as_str()
                .map(str::to_string)
                .ok_or_else(|| {
                    let raw = serde_json::to_string(&resp).unwrap_or_default();
                    let snippet: String = raw.chars().take(300).collect();
                    AppError::msg(format!("服务未返回内容。原始响应：{snippet}"))
                })
        })
    };
    fetch()
}

/// 从 Anthropic 响应中提取 tool_use 块的 input（结构化输出第 1 级）
fn extract_anthropic_tool_input(v: &serde_json::Value) -> Option<String> {
    for block in v["content"].as_array()? {
        if block["type"].as_str() == Some("tool_use") {
            if let Some(input) = block["input"].as_object() {
                // 序列化为紧凑 JSON 字符串（保持与 OpenAI content 路径一致）
                return serde_json::to_string(input).ok();
            }
        }
    }
    None
}

/// 三级降级的文本 JSON 请求：第 1 级结构化 → 第 2 级 json_object → 第 3 级纯文本。
/// 每级失败（含 400/unknown field）自动降级；返回 (tier_used, 模型文本)。
/// 最终仍失败返回最后一次错误。profile 级能力缓存由调用方（super_search_ai）维护。
pub fn request_text_json(
    cfg: &ApiProfile,
    system: &str,
    user: &str,
    structured_schema: Option<serde_json::Value>,
    max_structured_tier: TextJsonTier,
) -> AppResult<(TextJsonTier, String)> {
    let client = reqwest::blocking::Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(90))
        .build()
        .map_err(|e| AppError::msg(format!("HTTP 客户端初始化失败: {e}")))?;

    // 第 3 级失败时带错误重试逻辑单独处理；一级一级降级。
    let mut last_err: Option<String> = None;

    let should_fallback = |message: &str| {
        let lower = message.to_ascii_lowercase();
        !lower.contains("无法连接")
            && !lower.contains("connect")
            && !lower.contains("timed out")
            && !lower.contains("timeout")
            && !lower.contains("401")
            && !lower.contains("403")
            && !lower.contains("unauthorized")
            && !lower.contains("forbidden")
            && !lower.contains("api key")
            && !lower.contains("authentication")
    };

    if max_structured_tier >= TextJsonTier::Structured {
        match request_text_raw(
            &client,
            cfg,
            system,
            user,
            TextJsonTier::Structured,
            structured_schema.clone(),
        ) {
            Ok(t) => return Ok((TextJsonTier::Structured, t)),
            Err(e) => {
                let message = e.to_string();
                if !should_fallback(&message) {
                    return Err(e);
                }
                last_err = Some(message);
            }
        }
    }
    if max_structured_tier >= TextJsonTier::JsonObject {
        match request_text_raw(&client, cfg, system, user, TextJsonTier::JsonObject, None) {
            Ok(t) => return Ok((TextJsonTier::JsonObject, t)),
            Err(e) => {
                let message = e.to_string();
                if !should_fallback(&message) {
                    return Err(e);
                }
                last_err = Some(message);
            }
        }
    }
    match request_text_raw(&client, cfg, system, user, TextJsonTier::Plain, None) {
        Ok(t) => Ok((TextJsonTier::Plain, t)),
        Err(e) => {
            let detail = last_err.unwrap_or_default();
            Err(AppError::msg(format!(
                "AI 请求降级仍失败：{detail}；最后尝试：{e}"
            )))
        }
    }
}

/// 纯文本 JSON 请求的本地退化检测（复用 is_degenerate）
pub fn is_degenerate_text(content: &str) -> bool {
    is_degenerate(content)
}

/// 拉取服务商可用模型列表（GET {base_url}/models；两种模式的响应同为 {data:[{id}]}）
pub fn list_models(base_url: &str, api_key: &str, api_mode: &str) -> AppResult<Vec<String>> {
    if base_url.trim().is_empty() {
        return Err(AppError::msg("请先填写 base_url"));
    }
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| AppError::msg(format!("HTTP 客户端初始化失败: {e}")))?;
    let url = format!("{}/models", base_url.trim_end_matches('/'));
    let req = client.get(&url);
    let req = if api_mode == "anthropic" {
        req.header("x-api-key", api_key)
            .header("anthropic-version", "2023-06-01")
    } else if api_key.trim().is_empty() {
        // 本地兼容端点（Ollama/LM Studio）通常无 Key，不带鉴权头（P3-01a）
        req
    } else {
        req.bearer_auth(api_key)
    };
    let resp: serde_json::Value = req
        .send()
        .map_err(|e| AppError::msg(format!("模型列表请求失败: {e}")))?
        .json()
        .map_err(|e| AppError::msg(format!("模型列表解析失败: {e}")))?;
    let models = parse_model_ids(&resp);
    if models.is_empty() {
        return Err(AppError::msg("服务商未返回可用模型"));
    }
    Ok(models)
}

/// 取用于打标的图片路径：高清缩略图 > 占位图 > 原图
fn pick_image(asset: &assets::Asset) -> PathBuf {
    if let Some(p) = &asset.hd_thumbnail_path {
        return PathBuf::from(p);
    }
    if let Some(p) = &asset.placeholder_path {
        return PathBuf::from(p);
    }
    PathBuf::from(&asset.file_path)
}

/// P3-02：多帧标签频次合并——同分类同标签命中 ≥ ceil(ok/2) 帧才进建议；单帧时阈值 1；
/// 每分类最多保留 5 个（与单帧解析上限一致，防标签体系污染）
pub fn merge_frame_tags(frames: &[CategorizedTags]) -> CategorizedTags {
    let ok = frames.len();
    if ok == 0 {
        return CategorizedTags::new();
    }
    // FB2-07（§13.5②）：阈值随帧数自适应 ceil(n/2)。固定 2 在 n=6 时过松（1/3 帧命中就通过），
    // n=2 时又过严。n=2→1、n=3→2、n=4→2、n=6→3、n=8→4
    let threshold = (ok + 1) / 2;
    let mut counts: std::collections::BTreeMap<(String, String), usize> =
        std::collections::BTreeMap::new();
    for t in frames {
        for (cat, tags) in t {
            for tag in tags {
                *counts.entry((cat.clone(), tag.clone())).or_default() += 1;
            }
        }
    }
    let mut out = CategorizedTags::new();
    for ((cat, tag), c) in counts {
        if c >= threshold {
            let v = out.entry(cat).or_default();
            if v.len() < 5 {
                v.push(tag);
            }
        }
    }
    out
}

/// P3-02 + FB2-07：视频抽帧打标（frames 模式）——抽 n 段中点帧逐帧请求后频次合并；
/// 抽帧/识别全失败返回 Err（单条置 rejected）。帧数由入参驱动（2~8）。
fn tag_video_frames(
    client: &reqwest::blocking::Client,
    cfg: &ApiProfile,
    facets: &[FacetPromptContext],
    asset: &assets::Asset,
    frame_count: usize,
) -> AppResult<CategorizedTags> {
    let dir = std::env::temp_dir().join(format!(
        "bagertea_kframes_{}_{}",
        std::process::id(),
        asset.id
    ));
    std::fs::create_dir_all(&dir)?;
    let frames = super::video::extract_keyframes(
        std::path::Path::new(&asset.file_path),
        asset.duration_ms,
        &dir,
        frame_count,
    );
    if frames.is_empty() {
        let _ = std::fs::remove_dir_all(&dir);
        return Err(AppError::msg(
            "视频抽帧失败：未安装 ffmpeg 或编码不支持（可在设置关闭视频打标）",
        ));
    }
    let mut results: Vec<CategorizedTags> = Vec::new();
    for f in &frames {
        if let Ok(t) = request_tags(client, cfg, facets, f) {
            results.push(t);
        }
    }
    let _ = std::fs::remove_dir_all(&dir);
    if results.is_empty() {
        return Err(AppError::msg("视频全部帧 AI 识别失败"));
    }
    let merged = merge_frame_tags(&results);
    if merged.is_empty() {
        return Err(AppError::msg("视频帧标签未达命中阈值（帧数少时需多数帧共同命中）"));
    }
    Ok(merged)
}

/// 执行批次：逐条「读库 → 网络请求 → 写库」，进度回调 + 取消；
/// 每次 DB 操作短锁即用即放，网络等待期间不持锁，避免阻塞全应用其它 DB 读写
/// 本地模型子批大小（§8.3：按模型能力 10~20；此处取 15）。云端子批大小由「执行分块大小」设置驱动，
/// 执行层内存分块，不新增 chunk 表。
const LOCAL_SUBBATCH_SIZE: usize = 15;
/// 单项失败重试前退避（秒）：指数退避首段
const RETRY_SECONDS: u64 = 1;

pub fn run_cloud_batch<F: Fn(AiProgress)>(
    db: &Arc<Mutex<Connection>>,
    batch_id: i64,
    cfg: &AiSettings,
    facets: &[FacetPromptContext],
    limit: Option<i64>,
    cancel: &Arc<AtomicBool>,
    progress: F,
) -> AppResult<()> {
    let lock = || db.lock().map_err(|_| AppError::msg("数据库锁中毒"));

    let profile = cfg
        .active()
        .ok_or_else(|| AppError::msg("请先在设置页添加 API 配置（中转站）"))?;
    if profile.base_url.trim().is_empty() {
        return Err(AppError::msg("当前 API 配置缺少 base_url"));
    }
    // P3-01a：本地兼容端点（Ollama/LM Studio）通常无需 API Key；云端仍必填
    if !profile.is_local() && profile.api_key.trim().is_empty() {
        return Err(AppError::msg("当前 API 配置缺少 API Key"));
    }
    let client = reqwest::blocking::Client::builder()
        // 连接 15s：本地服务没起来能快速报错；总超时 300s：
        // 本地大模型（7B+纯 CPU）单张响应可能远超 60s，60s 会误杀慢速打标
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(300))
        .build()
        .map_err(|e| AppError::msg(format!("HTTP 客户端初始化失败: {e}")))?;

    {
        // 同一短锁内「检查 + 置位」，防止两次并发启动都通过预检
        let conn = lock()?;
        if ai::get_batch(&conn, batch_id)?.status == "processing" {
            return Err(AppError::msg("批次正在执行中"));
        }
        ai::set_batch_status(&conn, batch_id, "processing")?;
    }
    let suggestions = {
        let conn = lock()?;
        ai::list_suggestions(&conn, batch_id)?
    };
    // v2.11：可选只处理前 N 张（其余保持 pending，可再次启动）
    // F15a（2026-08-22）：筛选仅看 status=="pending" 会把「已生成候选但未确认」的条目重复送 AI
    // （set_suggestion_tags 不改 status）→ 续跑重复请求 + processed 虚增。修复：待处理 = pending 且尚无候选。
    let pending: Vec<_> = suggestions
        .into_iter()
        .filter(|s| s.status == "pending" && s.suggested_tags.is_empty())
        .collect();
    let todo: Vec<_> = match limit {
        Some(n) => pending.into_iter().take(n.max(0) as usize).collect(),
        None => pending,
    };
    // 指导书 §8.2/§8.3：逻辑批次完整保留（用户所选全部素材都在批内），执行层本地分块。
    // 云端子批大小 = 设置「执行分块大小」（batch_limit），限 [10,50]；本地按模型能力用 LOCAL_SUBBATCH_SIZE(15)；
    // 并发 1；单项失败重试 1 次（指数退避），仍失败置 rejected。
    let chunk_size = if profile.is_local() {
        LOCAL_SUBBATCH_SIZE
    } else {
        (cfg.batch_limit as usize).clamp(10, 50)
    };
    let total = todo.len() as i64;
    // F15b（2026-08-22）：无待打标项（全部已处理/已确认/已拒绝）不再空转 done——
    // 明确报错；并先把批次状态复位，避免留下 processing 僵尸态
    // （命令层 ai_start_batch 已预检「无待打标项」；视频批次三检——开关/ffmpeg/本地视觉模型——
    //   也在命令层预检，此处为直接服务层调用与逐条兜底，见 :833 的 video_tagging 逐条校验）
    if todo.is_empty() {
        let conn = lock()?;
        ai::set_batch_status(&conn, batch_id, "done")?;
        return Err(AppError::msg("当前没有待打标的建议（已全部处理或确认）"));
    }

    // 单条打标计算（网络请求不持 DB 锁）；失败由调用方决定重试/降级
    let compute = |asset: &crate::db::assets::Asset| -> AppResult<CategorizedTags> {
        let is_video = asset.mime_type.starts_with("video/");
        if is_video && !cfg.video_tagging {
            return Err(AppError::msg(
                "视频 AI 打标未开启。请打开\"设置 → AI 设置 → 自动打标 → 视频 AI 打标\"，保存后重新开始批次。",
            ));
        }
        if is_video {
            // FB2-07（§13.4/§13.5）：cover 模式走与图片完全相同的 pick_image+request_tags 路径
            //（零 ffmpeg、零额外解码、1 次请求）；frames 模式抽 N 段中点帧逐帧识别后合并。
            match cfg.video_tagging_mode.as_str() {
                "frames" => tag_video_frames(
                    &client,
                    profile,
                    facets,
                    asset,
                    (cfg.video_frame_count as usize).clamp(2, 8),
                ),
                // cover（默认）：复用入库时生成的视频封面，needs 高清图优先
                _ => request_tags(&client, profile, facets, &pick_image(asset)),
            }
        } else {
            // 网络请求（可能耗时数十秒）：不持 DB 锁
            request_tags(&client, profile, facets, &pick_image(asset))
        }
    };

    let mut processed = 0i64;
    for chunk in todo.chunks(chunk_size) {
        for s in chunk {
            if cancel.load(Ordering::Relaxed) {
                let conn = lock()?;
                ai::set_batch_status(&conn, batch_id, "cancelled")?;
                return Ok(());
            }
            let asset = {
                let conn = lock()?;
                assets::get(&conn, s.asset_id)?
            };
            // 单项失败：指数退避后重试 1 次，仍失败置 rejected（不阻塞其他素材）
            let mut tags = compute(&asset);
            if tags.is_err() {
                std::thread::sleep(Duration::from_millis(RETRY_SECONDS * 1000));
                tags = compute(&asset);
            }
            {
                let conn = lock()?;
                match tags {
                    Ok(t) => ai::set_suggestion_tags(&conn, s.id, &t)?,
                    Err(e) => {
                        // 单条失败不阻塞批次：建议置 rejected 并记录空标签与失败原因（v6 详情落库）
                        let err = e.to_string();
                        tracing::warn!("asset {} 打标失败: {err}", s.asset_id);
                        let _ = ai::set_suggestion_error(&conn, s.id, &err);
                        ai::reject_suggestion(&conn, s.id)?;
                    }
                }
                ai::inc_batch_processed(&conn, batch_id)?;
            }
            processed += 1;
            progress(AiProgress {
                batch_id,
                processed,
                total,
                current_asset_id: s.asset_id,
            });
        }
    }

    {
        let conn = lock()?;
        ai::set_batch_status(&conn, batch_id, "done")?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        apply_keep_alive, extract_anthropic_text, parse_categorized, parse_model_ids, KEEP_ALIVE_IDLE,
    };

    #[test]
    fn categorized_clean_object() {
        let r = parse_categorized(
            "{\"场景\": [\"公园\"], \"色彩风格\": [\"胶片感\", \"低饱和\"], \"人物\": []}",
        );
        assert_eq!(r.get("场景").unwrap(), &vec!["公园".to_string()]);
        assert_eq!(r.get("色彩风格").unwrap().len(), 2);
        assert!(!r.contains_key("人物")); // 空数组分类不落地
    }

    #[test]
    fn categorized_noisy_reply() {
        let r = parse_categorized("好的：\n{\"光线\": \"逆光\"}\n望采纳");
        assert_eq!(r.get("光线").unwrap(), &vec!["逆光".to_string()]);
    }

    #[test]
    fn categorized_legacy_array_fallback() {
        let r = parse_categorized("[\"风景\", \"海边\"]");
        assert_eq!(
            r.get("未分类").unwrap(),
            &vec!["风景".to_string(), "海边".to_string()]
        );
    }

    #[test]
    fn categorized_garbage_gives_empty() {
        assert!(parse_categorized("无法识别").is_empty());
    }

    #[test]
    fn strict_garbage_is_err() {
        assert!(super::parse_tags_strict("我无法查看这张图片", &[]).is_err());
    }

    #[test]
    fn strict_valid_object_ok() {
        let valid = ["scene", "style", "color"];
        let r = super::parse_tags_strict("{\"场景\": [\"公园\"]}", &valid).unwrap();
        assert_eq!(r.get("scene").unwrap(), &vec!["公园".to_string()]);
    }

    // §8.4：本地请求体注入 keep_alive；云端不注入
    #[test]
    fn keep_alive_injected_only_for_local() {
        let mut local = serde_json::json!({ "model": "qwen2.5vl:7b" });
        apply_keep_alive(&mut local, true);
        assert_eq!(local["keep_alive"], KEEP_ALIVE_IDLE);

        let mut cloud = serde_json::json!({ "model": "gpt-4o" });
        apply_keep_alive(&mut cloud, false);
        assert!(cloud.get("keep_alive").is_none());
    }

    // §9.3：本地模型视觉能力启发式（含视觉标记 → 支持；已知纯文本 → 不支持；未知 → 支持防误拦）
    #[test]
    fn vision_model_heuristic() {
        assert!(super::model_supports_vision("qwen2.5vl:7b")); // vl 标记
        assert!(super::model_supports_vision("llava:13b"));
        assert!(super::model_supports_vision("moondream:2b"));
        assert!(super::model_supports_vision("gemma3:4b")); // 多模态
        assert!(!super::model_supports_vision("qwen2.5:7b-instruct")); // 纯文本
        assert!(!super::model_supports_vision("deepseek-r1:7b"));
        assert!(super::model_supports_vision("有些自定义视觉模型")); // 未知按支持，避免误拦
        assert!(super::model_supports_vision("")); // 空模型不拦
    }

    #[test]
    fn checked_unknown_key_warns_not_silent_custom() {
        // C-4：未知 key 应产生 warning 并归入自定义，不静默丢失
        let valid = ["subject", "scene", "color"];
        let (tags, warnings) = super::parse_categorized_checked(
            "{\"subject\":[\"人\"],\"foobar\":[\"奇怪\"]}",
            &valid,
        );
        assert_eq!(tags.get("subject").unwrap(), &vec!["人".to_string()]);
        assert_eq!(tags.get("custom").unwrap(), &vec!["奇怪".to_string()]);
        assert_eq!(warnings.len(), 1);
        assert!(warnings[0].contains("foobar"));
    }

    #[test]
    fn checked_legacy_chinese_maps_to_stable_key() {
        // C-4：兼容旧中文 key 且不产生 warning
        let valid = ["subject", "scene", "color", "lighting"];
        let (tags, warnings) = super::parse_categorized_checked(
            "{\"色彩\":[\"蓝\"],\"光线/时间\":[\"黄昏\"],\"主体\":[\"树\"]}",
            &valid,
        );
        assert_eq!(tags.get("color").unwrap(), &vec!["蓝".to_string()]);
        assert_eq!(tags.get("lighting").unwrap(), &vec!["黄昏".to_string()]);
        assert_eq!(tags.get("subject").unwrap(), &vec!["树".to_string()]);
        assert!(warnings.is_empty(), "已知中文 key 不应产生 warning");
    }

    #[test]
    fn anthropic_text_extracted() {
        let v = serde_json::json!({"content": [
            {"type": "thinking", "thinking": "..."},
            {"type": "text", "text": "[\"人像\"]"}
        ]});
        assert_eq!(extract_anthropic_text(&v).as_deref(), Some("[\"人像\"]"));
    }

    #[test]
    fn anthropic_no_text_block_gives_none() {
        assert!(extract_anthropic_text(&serde_json::json!({"content": []})).is_none());
    }

    #[test]
    fn parse_openai_models() {
        let v = serde_json::json!({"object": "list", "data": [
            {"id": "qwen-vl-plus"}, {"id": "qwen-vl-max"}, {"no_id": true}
        ]});
        assert_eq!(parse_model_ids(&v), vec!["qwen-vl-plus", "qwen-vl-max"]);
    }

    #[test]
    fn parse_bad_payload_gives_empty() {
        assert!(parse_model_ids(&serde_json::json!({"error": "unauthorized"})).is_empty());
    }

    #[test]
    fn merge_frames_keeps_majority_tags() {
        use std::collections::BTreeMap;
        let f = |pairs: &[(&str, &[&str])]| -> super::CategorizedTags {
            let mut m = BTreeMap::new();
            for (k, v) in pairs {
                m.insert(k.to_string(), v.iter().map(|s| s.to_string()).collect());
            }
            m
        };
        let frames = vec![
            f(&[("场景", &["公园", "街道"])]),
            f(&[("场景", &["公园"]), ("光线", &["逆光"])]),
            f(&[("场景", &["公园", "海边"])]),
        ];
        let r = super::merge_frame_tags(&frames);
        assert_eq!(r.get("场景").unwrap(), &vec!["公园".to_string()]); // 3 帧命中
        assert!(!r.contains_key("光线")); // 仅 1 帧，不达阈值
    }

    #[test]
    fn merge_single_frame_keeps_all() {
        use std::collections::BTreeMap;
        let mut m = BTreeMap::new();
        m.insert("场景".to_string(), vec!["室内".to_string()]);
        let r = super::merge_frame_tags(&[m]);
        assert_eq!(r.get("场景").unwrap(), &vec!["室内".to_string()]);
        assert!(super::merge_frame_tags(&[]).is_empty());
    }

    #[test]
    fn degenerate_repeated_char_detected() {
        assert!(super::is_degenerate("@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@"));
        assert!(super::is_degenerate("!!!!!!!!!!!!!!!!!!!!!!!!!!!!"));
        assert!(!super::is_degenerate("@@"));
        assert!(!super::is_degenerate(""));
    }

    #[test]
    fn degenerate_mojibake_detected() {
        // UTF-8 中文被按 Latin-1 误读的典型乱码（ollama 分词器字节错切症状，实测样本）
        assert!(super::is_degenerate("å¯¹ä¸èµ·ï¼ææ æ³å¸®å©æ¨è§£è¯»å¾åå®¹ã"));
        assert!(super::is_degenerate("ä»¥ä¸æ¯æ´çå¥½å¹¶è§æ ¼åçJSONæ ¼å¼ï¼"));
    }

    #[test]
    fn normal_replies_not_degenerate() {
        assert!(!super::is_degenerate("这张图片是一张纯红色的图片。"));
        assert!(!super::is_degenerate("{\"场景\": [\"公园\"]}"));
        assert!(!super::is_degenerate(
            "This image shows a bridge in a city."
        ));
        // 中文标点+ASCII 混排不误报
        assert!(!super::is_degenerate("1 + 1 = 2"));
    }
}
