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
use crate::db::{
    assets,
    settings::{AiSettings, ApiProfile, TagCategory},
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

/// 单张图片请求标签（纯函数易测部分之外的网络调用）
/// 按分类组装提示词（PRD 5.5）：分类名 + hint + 单/多选约束
fn build_prompt(categories: &[TagCategory]) -> String {
    let mut lines = String::from("请为这张图片按以下分类生成简短中文标签。分类与要求：\n");
    for c in categories {
        let rule = if c.single {
            "（单选，最多 1 个）".to_string()
        } else {
            format!("（可多选，1-{} 个）", c.max.max(1))
        };
        lines.push_str(&format!(
            "- {}{}{}\n",
            c.name,
            rule,
            if c.hint.is_empty() {
                String::new()
            } else {
                format!("：{}", c.hint)
            }
        ));
    }
    lines.push_str("只返回 JSON 对象，键为分类名、值为标签字符串数组，无合适标签的分类给空数组，不要其他内容。");
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

/// 解析模型回复并要求非空（v2.12）：空结果视为失败——通常意味着模型不支持图片输入或未遵循提示词
fn parse_tags_strict(content: &str) -> AppResult<CategorizedTags> {
    let tags = parse_categorized(content);
    if tags.is_empty() {
        return Err(AppError::msg(
            "模型未返回可解析的标签（模型可能不支持图片输入，或未按提示词返回 JSON）",
        ));
    }
    Ok(tags)
}

fn request_tags(
    client: &reqwest::blocking::Client,
    cfg: &ApiProfile,
    categories: &[TagCategory],
    image_path: &std::path::Path,
) -> AppResult<CategorizedTags> {
    let bytes = std::fs::read(image_path)?;
    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    let mime = if image_path.extension().map(|e| e == "png").unwrap_or(false) {
        "image/png"
    } else {
        "image/jpeg"
    };

    let prompt = build_prompt(categories);
    let base = cfg.base_url.trim_end_matches('/');

    if cfg.api_mode == "anthropic" {
        // Anthropic Messages：x-api-key 鉴权 + base64 source 图片块
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
            .map_err(|e| AppError::msg(format!("云端请求失败: {e}")))?
            .json()
            .map_err(|e| AppError::msg(format!("响应解析失败: {e}")))?;
        let content = extract_anthropic_text(&resp)
            .ok_or_else(|| AppError::msg("Anthropic 返回缺少 text 内容块"))?;
        return parse_tags_strict(&content);
    }

    // OpenAI 兼容（默认）：Bearer 鉴权 + data:image base64
    let body = serde_json::json!({
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

    let resp: serde_json::Value = client
        .post(format!("{base}/chat/completions"))
        .bearer_auth(&cfg.api_key)
        .json(&body)
        .send()
        .map_err(|e| AppError::msg(format!("云端请求失败: {e}")))?
        .json()
        .map_err(|e| AppError::msg(format!("响应解析失败: {e}")))?;

    let content = resp["choices"][0]["message"]["content"]
        .as_str()
        .ok_or_else(|| AppError::msg("云端返回缺少 content"))?;
    parse_tags_strict(content)
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

/// 从模型回复中提取标签数组（宽容解析：先整串 JSON，再退化找 [...] 片段）
pub fn extract_tags(content: &str) -> Vec<String> {
    let trimmed = content.trim();
    let parsed = serde_json::from_str::<Vec<String>>(trimmed)
        .ok()
        .or_else(|| {
            let start = trimmed.find('[')?;
            let end = trimmed.rfind(']')?;
            serde_json::from_str::<Vec<String>>(&trimmed[start..=end]).ok()
        });
    parsed
        .unwrap_or_default()
        .into_iter()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty() && s.chars().count() <= 20)
        .take(8)
        .collect()
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

/// 执行批次：逐条「读库 → 网络请求 → 写库」，进度回调 + 取消；
/// 每次 DB 操作短锁即用即放，网络等待期间不持锁，避免阻塞全应用其它 DB 读写
pub fn run_cloud_batch<F: Fn(AiProgress)>(
    db: &Arc<Mutex<Connection>>,
    batch_id: i64,
    cfg: &AiSettings,
    categories: &[TagCategory],
    limit: Option<i64>,
    cancel: &Arc<AtomicBool>,
    progress: F,
) -> AppResult<()> {
    let lock = || db.lock().map_err(|_| AppError::msg("数据库锁中毒"));

    let profile = cfg
        .active()
        .ok_or_else(|| AppError::msg("请先在设置页添加 API 配置（中转站）"))?;
    if profile.base_url.trim().is_empty() || profile.api_key.trim().is_empty() {
        return Err(AppError::msg("当前 API 配置缺少 base_url 或 API Key"));
    }
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(60))
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
    let pending: Vec<_> = suggestions
        .into_iter()
        .filter(|s| s.status == "pending")
        .collect();
    let todo: Vec<_> = match limit {
        Some(n) => pending.into_iter().take(n.max(0) as usize).collect(),
        None => pending,
    };
    let total = todo.len() as i64;

    for (i, s) in todo.iter().enumerate() {
        if cancel.load(Ordering::Relaxed) {
            let conn = lock()?;
            ai::set_batch_status(&conn, batch_id, "cancelled")?;
            return Ok(());
        }
        let asset = {
            let conn = lock()?;
            assets::get(&conn, s.asset_id)?
        };
        // 网络请求（可能耗时数十秒）：不持 DB 锁
        let tags = request_tags(&client, profile, categories, &pick_image(&asset));
        {
            let conn = lock()?;
            match tags {
                Ok(t) => ai::set_suggestion_tags(&conn, s.id, &t)?,
                Err(e) => {
                    // 单条失败不阻塞批次：建议置 rejected 并记录空标签
                    tracing::warn!("asset {} 打标失败: {e}", s.asset_id);
                    ai::reject_suggestion(&conn, s.id)?;
                }
            }
            ai::inc_batch_processed(&conn, batch_id)?;
        }
        let processed = i as i64 + 1;
        progress(AiProgress {
            batch_id,
            processed,
            total,
            current_asset_id: s.asset_id,
        });
    }

    {
        let conn = lock()?;
        ai::set_batch_status(&conn, batch_id, "done")?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{extract_anthropic_text, extract_tags, parse_categorized, parse_model_ids};

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
        assert!(super::parse_tags_strict("我无法查看这张图片").is_err());
    }

    #[test]
    fn strict_valid_object_ok() {
        let r = super::parse_tags_strict("{\"场景\": [\"公园\"]}").unwrap();
        assert_eq!(r.get("场景").unwrap(), &vec!["公园".to_string()]);
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
    fn extract_clean_json() {
        assert_eq!(extract_tags("[\"人像\", \"宠物\"]"), vec!["人像", "宠物"]);
    }

    #[test]
    fn extract_from_noisy_reply() {
        let r = extract_tags("好的，标签如下：\n[\"风景\", \"海边\"]\n希望对你有帮助");
        assert_eq!(r, vec!["风景", "海边"]);
    }

    #[test]
    fn extract_garbage_gives_empty() {
        assert!(extract_tags("无法识别").is_empty());
    }

    #[test]
    fn overlong_and_blank_filtered() {
        let r =
            extract_tags("[\"\", \"  \", \"这是一个非常非常非常长的标签超过二十个字符限制了吧\"] ");
        assert!(r.is_empty());
    }
}
