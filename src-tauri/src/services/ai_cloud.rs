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

/// A2：提示词版本（手工维护常量）—— 改提示词时必须递增，随 request_config 一起落库溯源。
pub const PROMPT_VERSION: &str = "w5a-2026-09";

/// A2：请求配置的稳定序列化（递归按键排序）后 sha256 前 16 位 hex。
/// 同输入同 hash、改任一项则变（request_config_hash_is_stable 守护）。
pub fn stable_config_hash(v: &serde_json::Value) -> String {
    use sha2::{Digest, Sha256};
    // 稳定序列化：对象键排序（serde_json 在 preserve_order 特性下保持插入序，
    // 不做显式排序的话同内容不同构建序会得到不同 hash）
    fn canon(v: &serde_json::Value) -> serde_json::Value {
        match v {
            serde_json::Value::Object(m) => {
                let mut sorted: Vec<(String, serde_json::Value)> = m
                    .iter()
                    .map(|(k, val)| (k.clone(), canon(val)))
                    .collect();
                sorted.sort_by(|a, b| a.0.cmp(&b.0));
                serde_json::Value::Object(sorted.into_iter().collect())
            }
            serde_json::Value::Array(a) => {
                serde_json::Value::Array(a.iter().map(canon).collect())
            }
            other => other.clone(),
        }
    }
    let canonical = serde_json::to_string(&canon(v)).unwrap_or_default();
    let mut hasher = Sha256::new();
    hasher.update(canonical.as_bytes());
    let out = hasher.finalize();
    out.iter().take(8).map(|b| format!("{b:02x}")).collect()
}

/// A2：批次请求配置（溯源用，六项）—— promptVersion / systemPrompt / facets /
/// topTagsSnapshot / modelParams / mediaKind / imagePreprocess。model = 激活档案模型。
pub fn build_batch_request_config(
    system_prompt: &str,
    facets: &[FacetPromptContext],
    top_tags: &[(String, String)],
    model: &str,
    media_kind: &str,
    max_tokens: i64,
    is_local: bool,
) -> serde_json::Value {
    let facet_items: Vec<serde_json::Value> = facets
        .iter()
        .map(|f| {
            serde_json::json!({
                "key": f.key,
                "displayName": f.display_name,
                "description": f.description,
                "selectionMode": f.selection_mode,
                "maxItems": f.max_items,
                "appliesTo": "all",
                // V24（§6.4）：数值分面配置随批次溯源
                "facetKind": f.facet_kind,
                "numMin": f.num_min,
                "numMax": f.num_max,
                "numUnit": f.num_unit,
            })
        })
        .collect();
    let tag_items: Vec<serde_json::Value> = top_tags
        .iter()
        .map(|(facet, words)| serde_json::json!({ "facet": facet, "words": words }))
        .collect();
    // modelParams 忠实记录实际发出的请求：response_format json_object 与 keep_alive
    // 仅本地档案会附加（见 request_analysis 两个协议分支），云端按服务商而定不记录。
    let mut model_params = serde_json::json!({ "model": model, "maxTokens": max_tokens });
    if is_local {
        model_params["responseFormat"] = serde_json::json!("json_object");
        model_params["keepAlive"] = serde_json::json!("5m");
    }
    serde_json::json!({
        "promptVersion": PROMPT_VERSION,
        "systemPrompt": system_prompt,
        "facets": facet_items,
        "topTagsSnapshot": tag_items,
        "modelParams": model_params,
        "mediaKind": media_kind,
        "imagePreprocess": { "maxPx": 1024, "format": "jpeg", "quality": 85 },
    })
}
use crate::error::{AppError, AppResult};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiProgress {
    pub batch_id: i64,
    pub processed: i64,
    pub total: i64,
    pub current_asset_id: i64,
}

/// FB5-05（§7.4）+ A1：AI 分析结果 = 一句话描述 + 分类标签 + 强类型提议。
/// 描述为空但标签非空 / 标签为空但描述非空，都算一次有效分析。
#[derive(Debug, Clone, Default)]
pub struct MediaAnalysis {
    /// 画面内容的一句话中文描述（已规范化，最多 20 Unicode 字符；可为空）
    pub description: String,
    pub tags: CategorizedTags,
    /// A1：typed 提议（facet_key/raw_name/confidence）——与 tags 对齐（同序、同裁剪）。
    /// 纯字符串回退时 confidence=None。
    pub proposals: Vec<ai::TagProposal>,
    /// V24（§6.3④）：数值分面提议（平行字段；当前解析层暂不产出，链路预留）
    pub numbers: Vec<ai::NumberProposal>,
    /// A2：解析层告警（未知分面 key 等），随 AnalysisResult 的 analysis_json 一并落库溯源。
    pub warnings: Vec<String>,
    /// A2：该次请求的模型原始返回（逐字存储，不做任何清洗/剥围栏）
    pub raw_response: String,
    /// A2：该次请求的配置 JSON（溯源；批次级另存 request_config_json）
    pub request_config_json: Option<String>,
    /// A2：AnalysisResult 的序列化（desc + proposals + warnings）
    pub analysis_json: Option<String>,
}

/// 按分面组装提示词（P1B + C-3）：使用稳定英文 facetKey 作为 JSON 键，中文显示名仅作说明；
/// 避免模型返回中文分类名导致归类不稳定，也确保 color 独立于 style。
/// FB5-05（§7.4）：同时要求输出 description（一句话描述，最多 20 字，规则见下）。
fn build_system_prompt() -> String {
    let mut sys = String::from(
        "你是图片素材打标助手。分析用户提供的图片，返回一句话描述与分面标签。\n",
    );
    sys.push_str("输出格式（严格遵守）：\n");
    sys.push_str("- 只返回一个 JSON 对象，不要任何其他文字、解释或代码围栏；\n");
    sys.push_str("- 结构：{\"description\": \"一句话描述\", \"tags\": {\"分面key\": [\"标签\"]}}。\n");
    sys.push_str("description 规则：\n");
    sys.push_str("- 一句话中文描述画面内容（如「夜晚树下多人合影」），最多 20 个字符；\n");
    sys.push_str("- 不写文件质量、摄影建议，不以「这是一张」「这张图片展示」开头；\n");
    sys.push_str("- 不堆砌逗号标签；description 不得复制进任何 tags 数组。\n");
    sys.push_str("标签规则：\n");
    sys.push_str("- 每个标签为中文 2–6 字（如「海边」「人像」「逆光」）；\n");
    sys.push_str("- 标签必须描述画面中可观察到的内容，不确定的分面给空数组，不要猜；\n");
    sys.push_str("- 一个标签只归入一个分面；\n");
    sys.push_str("- 多值如实输出：一张图既是「海边」又是「日落」时，scene 里两个都写，不要只挑一个；\n");
    sys.push_str("- 用户给出候选词时，含义相同必须用已有词，不要造近义词（已有「海边」就不要写「海滨」）。\n");
    // W5a（a9）+ A1：置信度强类型协议 —— 标签可带置信度，写成 {"t":"标签","c":0.9}
    // （c 为 0 到 1 的数字；纯字符串仍是合法回退）。A1 起解析层强类型处理，不再吞标签。
    sys.push_str("- 标签可带置信度：写成 {\"t\":\"标签\",\"c\":0.9}（c 为 0 到 1 的数字；纯字符串也接受）。\n");
    // V24（§6.4）：数值分面输出协议 —— numbers 对象，值为原文（字符串或数字都接受）。
    // 歧义表达（范围/约数）如实输出，由解析层判定（绝不取首个数字）。
    sys.push_str("- 数值分类输出到 \"numbers\" 对象：{\"numbers\": {\"分面key\": \"原文\"}}；");
    sys.push_str("原文如实写（如 \"5\" 或 \"5人\"），画不出数字的分面不要出现在 numbers 里。\n");
    sys
}

/// W5a（a2/a3/a5）：user 段 —— 每分面拼 description + 规则 + Top-N 候选词 + 真实 few-shot。
/// top_tags 来自 W2-9 top_tags_per_facet（按使用次数降序，高频词优先 → 标签收敛）。
pub fn build_user_prompt(facets: &[FacetPromptContext], top_tags: &[(String, String)]) -> String {
    // V24（§6.4）：数值分面独立成段 —— 不发词表（无候选词可给），发「输出一个数字 + 值域 + 单位」
    let number_facets: Vec<&FacetPromptContext> =
        facets.iter().filter(|f| f.facet_kind == "number").collect();
    let tag_facets: Vec<&FacetPromptContext> =
        facets.iter().filter(|f| f.facet_kind != "number").collect();
    let mut user = String::from("请为这张图片打标。可用的分类（key 为英文标识）：\n");
    for c in tag_facets {
        let rule = if c.selection_mode == "single" {
            "单选，最多 1 个".to_string()
        } else {
            match c.max_items {
                Some(n) => format!("可多选，最多 {n} 个"),
                None => "可多选，数量不限".to_string(),
            }
        };
        user.push_str(&format!(
            "- {}（key: {}，{rule}）{}\n",
            c.display_name,
            c.key,
            if c.description.trim().is_empty() {
                String::new()
            } else {
                format!("：{}", c.description)
            },
        ));
    }
    if !number_facets.is_empty() {
        user.push_str("\n数值分类（输出到 numbers 对象，不进 tags）：\n");
        for c in &number_facets {
            let range = match (c.num_min, c.num_max) {
                (Some(lo), Some(hi)) => format!("{lo}–{hi} 的"),
                (Some(lo), None) => format!("不小于 {lo} 的"),
                (None, Some(hi)) => format!("不大于 {hi} 的"),
                (None, None) => String::new(),
            };
            let unit = if c.num_unit.trim().is_empty() {
                String::new()
            } else {
                format!("，单位：{}", c.num_unit)
            };
            user.push_str(&format!(
                "- {}（key: {}）：输出一个{}数字{unit}；画面中数不出来就不输出该 key，不要猜{}\n",
                c.display_name,
                c.key,
                range,
                if c.description.trim().is_empty() {
                    String::new()
                } else {
                    format!("（{}）", c.description)
                },
            ));
        }
    }
    if !top_tags.is_empty() {
        user.push_str("\n已有标签候选词（含义相同就用已有的词，不要造近义词）：\n");
        for (facet, words) in top_tags {
            user.push_str(&format!("- {facet}: {words}\n"));
        }
    }
    // R3-2：a3 真实 few-shot —— 不输出「示例词」占位符，而是完整「画面 → JSON」对。
    // 示例用词表里的真实词，且画面描述与 tags 自洽；不在画面里的分面给空数组（示范
    // 「不确定就空，不要猜」），不重复候选词清单（上面已列出）。
    let ex_keys: Vec<&str> = facets.iter().take(3).map(|c| c.key.as_str()).collect();
    if !ex_keys.is_empty() {
        let real_word = |key: &str, alt: bool| -> Option<String> {
            let table: &[(&str, &str, &str)] = &[
                ("scene", "海边", "城市"),
                ("subject", "树", "建筑"),
                ("people", "多人", "单人"),
                ("lighting", "夜景", "白天"),
            ];
            table
                .iter()
                .find(|(k, _, _)| *k == key)
                .map(|(_, a, b)| (if alt { *b } else { *a }).to_string())
        };
        let tags_json = |alt: bool| -> String {
            // 示例 A：黄昏海边，树下多人 → scene=海边、subject=树、people=多人…
            // 示例 B：清晨城市建筑，单人 → 对应 alt 词。画面没有的分面输出空数组。
            let pairs: Vec<String> = ex_keys
                .iter()
                .map(|k| {
                    let w = real_word(k, alt).unwrap_or_default();
                    format!("\"{k}\": {}", if w.is_empty() { "[]".to_string() } else { format!("[\"{w}\"]") })
                })
                .collect();
            format!("{{{}}}", pairs.join(", "))
        };
        user.push_str(&format!(
            "\n输出示例（真实输入→输出对，结构参考；tags 只含该图真实可观察到的分类）：\n"
        ));
        user.push_str(&format!(
            "示例 A：输入「黄昏的海边，树下有一群人散步」→ 输出 {{\"description\": \"黄昏海边多人散步\", \"tags\": {}}}\n",
            tags_json(false)
        ));
        user.push_str(&format!(
            "示例 B：输入「清晨的城市建筑，天空晴朗，只有一个行人」→ 输出 {{\"description\": \"清晨城市建筑\", \"tags\": {}}}\n",
            tags_json(true)
        ));
    } else {
        user.push_str("\n输出示例：{\"description\": \"黄昏海边有人散步\", \"tags\": {}}\n");
    }
    user
}

/// W5a（a7）：动态 max_tokens —— 固定 500 在分面多时会把 JSON 截断 → 解析失败 → 整条 rejected。
fn dynamic_max_tokens(facet_count: usize) -> i64 {
    (300 + 120 * facet_count as i64).clamp(500, 1600)
}

/// 数组元素 → 标签名（A1：支持纯字符串 与 {"t":"标签","c":0.9} 对象两种形态；对象取 t）。
/// 置信度由调用方在 typed 路径单独取（parse_media_analysis 的 proposals）。
fn elem_name(v: &serde_json::Value) -> Option<String> {
    match v {
        serde_json::Value::String(s) => {
            let t = s.trim().to_string();
            if t.is_empty() { None } else { Some(t) }
        }
        serde_json::Value::Object(o) => o
            .get("t")
            .and_then(|t| t.as_str())
            .map(|t| t.trim().to_string())
            .filter(|t| !t.is_empty()),
        _ => None,
    }
}

/// A1：数组元素 → (标签名, 置信度)。纯字符串 / {"t","c"} 对象 / 内联对象字符串都接受。
fn elem_name_conf(v: &serde_json::Value) -> (String, Option<f32>) {
    match v {
        serde_json::Value::String(s) => {
            let t = s.trim();
            // 兼容旧协议把 {"t","c"} 整个塞成字符串元素
            if let Ok(inner) = serde_json::from_str::<serde_json::Value>(t) {
                if let Some(o) = inner.as_object() {
                    if let Some(name) = o.get("t").and_then(|x| x.as_str()).map(|x| x.trim().to_string()) {
                        if !name.is_empty() {
                            let c = o.get("c").and_then(|x| x.as_f64()).map(|f| f.clamp(0.0, 1.0) as f32);
                            return (name, c);
                        }
                    }
                }
            }
            (t.to_string(), None)
        }
        serde_json::Value::Object(o) => {
            let name = o.get("t").and_then(|x| x.as_str()).unwrap_or("").trim().to_string();
            let c = o.get("c").and_then(|x| x.as_f64()).map(|f| f.clamp(0.0, 1.0) as f32);
            (name, c)
        }
        _ => (String::new(), None),
    }
}

/// A1：与 parse_categorized_checked_ex 一致的「正向」分面 key 解析（不含 manual/停用分支——
/// 那些 label 本就不会出现在最终 tags 里）。
fn resolve_label_key(label: &str, valid_keys: &[&str]) -> Option<String> {
    let t = label.trim();
    let m = crate::db::tag_facets::key_for_legacy_name(t);
    if valid_keys.contains(&t) {
        Some(t.to_string())
    } else if valid_keys.contains(&m) {
        Some(m.to_string())
    } else if m == "custom" {
        Some("custom".to_string())
    } else {
        None
    }
}

/// A1：从 tags JSON 内容里为最终（已裁剪）标签补置信度 → typed 提议。
/// 按「label 解析到的分面 key == 目标 key 且元素名一致」匹配（跨分面同名不会串）。
fn collect_proposals(tags_content: &str, tags: &CategorizedTags, valid_keys: &[&str]) -> Vec<ai::TagProposal> {
    let mut proposals = Vec::new();
    let Ok(v) = serde_json::from_str::<serde_json::Value>(tags_content) else {
        return proposals;
    };
    let Some(obj) = v.as_object() else {
        return proposals;
    };
    // label → (元素名, 置信度) 原始表
    let mut raw: Vec<(String, Vec<(String, Option<f32>)>)> = Vec::new();
    for (label, val) in obj {
        if let Some(key) = resolve_label_key(label, valid_keys) {
            let elems: Vec<(String, Option<f32>)> = match val {
                serde_json::Value::Array(arr) => arr.iter().map(elem_name_conf).collect(),
                serde_json::Value::String(s) => vec![(s.trim().to_string(), None)],
                _ => Vec::new(),
            };
            raw.push((key, elems));
        }
    }
    for (key, names) in tags {
        for name in names {
            let mut conf: Option<f32> = None;
            'outer: for (raw_key, elems) in &raw {
                if raw_key != key {
                    continue;
                }
                for (ename, c) in elems {
                    if ename == name {
                        conf = *c;
                        break 'outer;
                    }
                }
            }
            proposals.push(ai::TagProposal {
                facet_key: key.clone(),
                raw_name: name.clone(),
                confidence: conf,
            });
        }
    }
    proposals
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
                serde_json::Value::Array(arr) => arr.iter().filter_map(elem_name).collect(),
                serde_json::Value::String(s) => vec![s.trim().to_string()],
                _ => Vec::new(),
            }
            .into_iter()
            .filter(|s| !s.is_empty() && s.chars().count() <= 20)
            .take(5)
            .collect();
            if !tags.is_empty() {
                out.insert(k.trim().to_string(), tags);
            }
        }
    } else if let Some(arr) = v.as_array() {
        let tags: Vec<String> = arr.iter().filter_map(elem_name).collect();
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
    parse_categorized_checked_ex(content, valid_keys, &[])
}

/// W5a（a10）：manual_only_keys 区分「分面已停用」与「该分类不参与 AI 打标」——
/// 旧文案对 manual_only 分面也说「已停用」，语义不准（用户会以为要去恢复它）。
pub fn parse_categorized_checked_ex(
    content: &str,
    valid_keys: &[&str],
    manual_only_keys: &[String],
) -> (CategorizedTags, Vec<String>) {
    let raw = parse_categorized(content);
    let mut warnings = Vec::new();
    let mut out = CategorizedTags::new();
    for (k, list) in &raw {
        let trimmed = k.trim();
        let mapped = crate::db::tag_facets::key_for_legacy_name(trimmed);
        // R0-3：先判「原样 key」—— 自建分面（如 clothing_color）必须原样走这条。
        // 若先判 mapped，key_for_legacy_name 的 `_ => "custom"` 兜底会把任何自建 key
        // 变成 "custom"，而 custom 又是 active + ai_and_manual，必然在 valid_keys 里，
        // 导致自建分面在解析阶段就被整体旁路（resolve_facet_key 被跳过）。
        // 语义对齐 resolve_facet_key：① 原样（自建分面）② 中文旧名 ③ 兜底/停用。
        let target = if valid_keys.contains(&trimmed) {
            trimmed.to_string()
        } else if valid_keys.contains(&mapped) {
            mapped.to_string()
        } else if mapped == "custom" {
            warnings.push(format!(
                "未知分面 key「{trimmed}」已归入自定义，建议改用稳定 facetKey"
            ));
            "custom".to_string()
        } else if manual_only_keys.iter().any(|m| m == trimmed) || manual_only_keys.iter().any(|m| m == mapped) {
            warnings.push(format!(
                "分类「{trimmed}」不参与 AI 自动打标（只手工填写），本次返回的标签已丢弃"
            ));
            continue;
        } else {
            warnings.push(format!("分面「{trimmed}」已停用，本次返回的标签已丢弃"));
            continue;
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
                let done = v.get("done_reason").and_then(|d| d.as_str()).unwrap_or("?");
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
        "vl",
        "vision",
        "llava",
        "moondream",
        "minicpm-v",
        "minicpmv",
        "gemma3",
        "internvl",
        "intern-vl",
        "qwen2.5-vl",
        "qwen2-vl",
        "glm-4v",
        "cogvlm",
        "bunny",
        "llava-phi",
    ];
    if vision_markers.iter().any(|x| m.contains(x)) {
        return true;
    }
    let text_only_markers = [
        "llama3", "llama-3", "llama2", "llama-2", "deepseek", "mistral", "phi-4", "phi4", "phi-3",
        "phi3", "gemma2", "gemma-2", "qwen3", "qwen-3", "qwen2.5", "qwen2", "qwen-2.5", "qwen-2",
        "kimi", "glm-4-", "gemma-1", "gpt-oss",
    ];
    if text_only_markers.iter().any(|x| m.contains(x)) {
        return false;
    }
    true
}

/// FB5-05（§7.4/§7.5）：解析模型回复为 MediaAnalysis（一句话描述 + 分面标签）。
/// 兼容形态：
///  1. 新协议：{"description": "…", "tags": {"subject": ["…"]}}
///  2. 旧协议：{"subject": ["…"]}（整个对象即标签对象，无 description）
///  3. 扁平数组 → 由 parse_categorized 收进「未分类」
/// description 经 normalize_content_description（最多 20 字）；
/// tags 经 parse_categorized_checked（未知 key → custom + warning，绝不静默丢）。
/// 「标签为空但描述非空」= 有效分析（旧 parse_tags_strict 会直接拒绝，FB5-05 放宽）。
pub fn parse_media_analysis(
    content: &str,
    valid_keys: &[&str],
    facets: &[FacetPromptContext],
    manual_keys: &[String],
) -> AppResult<MediaAnalysis> {
    let trimmed = content.trim();
    // FX-02：本地模型（gemma3 等）常把 JSON 包在 ```json … ``` 代码围栏里。
    // 整串解析失败时先剥围栏（取首个 { 到末个 }），否则顶层键 "description"/"tags"
    // 会被当成分面 key —— 一句话描述整句落进 custom、真实分面标签全部丢失。
    let json_candidate: &str = match serde_json::from_str::<serde_json::Value>(trimmed) {
        Ok(_) => trimmed,
        Err(_) => match (trimmed.find('{'), trimmed.rfind('}')) {
            (Some(s), Some(e)) if s < e => &trimmed[s..=e],
            _ => trimmed,
        },
    };
    let (raw_desc, tags_content): (String, String) =
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(json_candidate) {
            match &v {
                serde_json::Value::Object(map) if map.contains_key("tags") => {
                    // 新协议：描述 + tags 子对象
                    let desc = map
                        .get("description")
                        .and_then(|d| d.as_str())
                        .unwrap_or("")
                        .to_string();
                    let tags = serde_json::to_string(&v["tags"]).unwrap_or_else(|_| "{}".into());
                    (desc, tags)
                }
                serde_json::Value::Object(_) => (String::new(), json_candidate.to_string()),
                _ => (String::new(), json_candidate.to_string()),
            }
        } else {
            // 非完整 JSON：宽容解析（截取 {} 片段等）交给 parse_categorized，描述无从提取
            (String::new(), trimmed.to_string())
        };
    let description = normalize_content_description(&raw_desc);
    let (mut tags, mut warnings) = parse_categorized_checked_ex(&tags_content, valid_keys, manual_keys);
    // V24（§6.4）：数值分面解析 —— 从 numbers 对象收集 NumberProposal（原文原样保留，
    // 歧义判定与越界校验统一在落库层 parse_number_proposal / validate_number_in_range）。
    let (mut numbers, mut num_warnings): (Vec<ai::NumberProposal>, Vec<String>) = (Vec::new(), Vec::new());
    let kind_of = |key: &str| -> Option<&str> {
        facets
            .iter()
            .find(|f| f.key == key)
            .map(|f| f.facet_kind.as_str())
    };
    if let Ok(v) = serde_json::from_str::<serde_json::Value>(json_candidate) {
        if let Some(nums) = v.get("numbers").and_then(|n| n.as_object()) {
            for (key, val) in nums {
                let raw = match val {
                    serde_json::Value::String(s) => s.trim().to_string(),
                    serde_json::Value::Number(n) => n.to_string(),
                    _ => continue,
                };
                if raw.is_empty() {
                    continue;
                }
                match kind_of(key) {
                    Some("number") => numbers.push(ai::NumberProposal {
                        facet_key: key.clone(),
                        raw_text: raw,
                        value: 0.0,
                        confidence: None,
                    }),
                    _ => num_warnings.push(format!("数值提议的分面「{key}」不存在或不是数值型。")),
                }
            }
        }
    }
    // 模型把数值误写进 tags（如 tags.people_count=["5"]）→ 摘出来转成 NumberProposal
    let number_keys: Vec<String> = facets
        .iter()
        .filter(|f| f.facet_kind == "number")
        .map(|f| f.key.clone())
        .collect();
    for key in &number_keys {
        if let Some(vals) = tags.remove(key) {
            for val in vals {
                let raw = val.trim().to_string();
                if !raw.is_empty() {
                    numbers.push(ai::NumberProposal {
                        facet_key: key.clone(),
                        raw_text: raw,
                        value: 0.0,
                        confidence: None,
                    });
                }
            }
            num_warnings.push(format!("数值分面「{key}」的输出误写在 tags 里，已转入数值提议。"));
        }
    }
    warnings.extend(num_warnings);
    // W5a（a8）：按 selection_mode / max_items 强制裁剪（替换无差别 take(5)）。
    // single 恒 1 个；multi 裁到 max_items（None = 不限）；超量记 warning。
    {
        let rule_for = |key: &str| -> (bool, Option<usize>) {
            facets
                .iter()
                .find(|f| f.key == key)
                .map(|f| (f.selection_mode == "single", f.max_items.map(|n| n as usize)))
                // R3-4：分面不在列表 → 该分面不参与 AI，不该裁到 5（max_items=NULL = 不限）
                .unwrap_or((false, None))
        };
        for (key, list) in tags.iter_mut() {
            let (single, max) = rule_for(key);
            let cap = if single { Some(1) } else { max };
            if let Some(cap) = cap {
                if list.len() > cap {
                    tracing::warn!("分面 {key} 标签超量（{} 个 > 上限 {cap}），已裁剪", list.len());
                    list.truncate(cap);
                }
            }
        }
        tags.retain(|_, v| !v.is_empty());
    }
    for w in &warnings {
        tracing::warn!("AI 打标未知分面 key：{w}");
    }
    if tags.is_empty() && description.is_empty() {
        let snippet: String = content.chars().take(300).collect();
        let shown = if snippet.chars().count() < content.chars().count() {
            format!("{snippet}…")
        } else {
            snippet
        };
        return Err(AppError::msg(format!(
            "模型未返回可解析的标签或描述（可能不支持图片输入或未按提示词输出 JSON）。模型原始返回：{shown}"
        )));
    }
    // A1：typed 提议（与 tags 同序同裁剪；纯字符串回退 confidence=None）
    let proposals = collect_proposals(&tags_content, &tags, valid_keys);
    Ok(MediaAnalysis {
        description,
        tags,
        proposals,
        numbers,
        warnings,
        // A2 溯源字段由调用方（request_analysis 的 enrich）补写，纯解析层置空
        raw_response: String::new(),
        request_config_json: None,
        analysis_json: None,
    })
}

fn request_analysis(
    client: &reqwest::blocking::Client,
    cfg: &ApiProfile,
    facets: &[FacetPromptContext],
    top_tags: &[(String, String)],
    manual_keys: &[String],
    image_path: &std::path::Path,
    system_override: &str,
) -> AppResult<MediaAnalysis> {
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

    // W5a：system + user 双段（Anthropic 分支用顶层 system 参数；OpenAI 兼容走 messages[0]）
    // 用户可在设置页覆盖 system prompt（非空优先；空 = 内置默认）
    let system = if system_override.trim().is_empty() {
        build_system_prompt()
    } else {
        system_override.to_string()
    };
    let user = build_user_prompt(facets, top_tags);
    let max_tokens = dynamic_max_tokens(facets.len()); // a7：动态上限防 JSON 截断
    let base = cfg.base_url.trim_end_matches('/');
    // A2 溯源用（fetch 闭包会 move 走 system，先 clone 一份）
    let prov_system = system.clone();

    // 发起一次请求并取回模型文本回复（不同协议分支各自组包）
    let fetch: Box<dyn Fn() -> AppResult<String>> = if cfg.api_mode == "anthropic" {
        // Anthropic Messages：x-api-key 鉴权 + base64 source 图片块
        Box::new(move || {
            let body = serde_json::json!({
                "model": cfg.model,
                "max_tokens": max_tokens,
                "system": system, // W5a-a1：Anthropic 顶层 system 参数
                "messages": [{
                    "role": "user",
                    "content": [
                        { "type": "text", "text": user },
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
                    "role": "system",
                    "content": system,
                }, {
                    "role": "user",
                    "content": [
                        { "type": "text", "text": user },
                        { "type": "image_url", "image_url": { "url": format!("data:{mime};base64,{b64}") } }
                    ]
                }],
                "max_tokens": max_tokens
            });
            // W5a-a6：本地档案加 response_format json_object（仿 request_text_raw:670）。
            // 云端不加（部分中转站对视觉请求的 response_format 支持不稳）；剥围栏容错链保留作降级。
            if cfg.is_local() {
                body["response_format"] = serde_json::json!({ "type": "json_object" });
            }
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
    // A2：成功解析后补溯源（raw_response 逐字 + 请求配置 + analysis_json）
    let enrich = |mut a: MediaAnalysis, used_content: String| -> MediaAnalysis {
        a.raw_response = used_content;
        a.request_config_json = Some(
            build_batch_request_config(&prov_system, facets, top_tags, &cfg.model, "image", max_tokens, cfg.is_local())
                .to_string(),
        );
        a.analysis_json = Some(
            serde_json::to_string(&ai::AnalysisResult {
                description: a.description.clone(),
                proposals: a.proposals.clone(),
                numbers: a.numbers.clone(),
                warnings: a.warnings.clone(),
            })
            .unwrap_or_default(),
        );
        a
    };
    if let Ok(a) = parse_media_analysis(&content, &valid_keys, facets, manual_keys) {
        return Ok(enrich(a, content));
    }
    // 本地档案失败自愈：任何解析失败（@@@@ 退化 / 乱码 / 答非所问）都先卸载重载一次再重试。
    // Ollama 长驻 runner 状态损坏会污染其后全部请求，卸载重载即恢复（ollama/ollama#8235/#17587 已验证）
    if cfg.is_local() {
        unload_ollama_model(cfg);
        if let Ok(c) = fetch() {
            if let Ok(a) = parse_media_analysis(&c, &valid_keys, facets, manual_keys) {
                return Ok(enrich(a, c));
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
    let a = parse_media_analysis(&content, &valid_keys, facets, manual_keys)?;
    Ok(enrich(a, content))
}

/// 从 Anthropic Messages 响应中取第一个 text 内容块
pub fn extract_anthropic_text(v: &serde_json::Value) -> Option<String> {
    v["content"]
        .as_array()?
        .iter()
        .find(|b| b["type"].as_str() == Some("text"))
        .and_then(|b| b["text"].as_str().map(String::from))
}

/// 从模型列表响应中提取模型 id（宽容解析三种形态，FB5-04 §13.5）：
///  1. OpenAI 兼容：{"data": [{"id": "..."}]}
///  2. 扁平列表：{"models": ["a", "b"]}
///  3. 顶层数组：["a", "b"]
pub fn parse_model_ids(v: &serde_json::Value) -> Vec<String> {
    let collect = |arr: &Vec<serde_json::Value>| -> Vec<String> {
        arr.iter()
            .filter_map(|m| {
                m.as_str()
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(String::from)
                    .or_else(|| {
                        m["id"]
                            .as_str()
                            .map(str::trim)
                            .filter(|s| !s.is_empty())
                            .map(String::from)
                    })
            })
            .collect()
    };
    if let Some(arr) = v["data"].as_array() {
        return collect(arr);
    }
    if let Some(arr) = v["models"].as_array() {
        return collect(arr);
    }
    if let Some(arr) = v.as_array() {
        return collect(arr);
    }
    Vec::new()
}

/// FB5-05（§7.5）：一句话描述规范化，最多 20 个 Unicode 字符（不按 UTF-8 bytes）。
/// 顺序：1. trim → 2. 换行/连续空白折叠为单空格 → 3. 去除开头无信息套话
/// （「这是一张/这张图片展示/画面中有」等）→ 4. 取第一个句段并去掉句末 。！？
/// → 5. 按 chars 截断到 20。
/// 描述为空/全是空白时返回空串；调用方不得因此让有效标签整条失败。
pub fn normalize_content_description(raw: &str) -> String {
    const MAX_CHARS: usize = 20;
    const FILLERS: &[&str] = &[
        "这是一张",
        "这是一幅",
        "这张图片展示",
        "这张图片显示",
        "这张图片是",
        "这张照片",
        "图片展示",
        "图片中",
        "画面中有",
        "画面中",
        "画面是",
        "图中是",
        "照片中",
        "图中有",
    ];

    // 1-2. trim + 折叠空白（Unicode 空白统一为单个普通空格）
    let mut folded = String::with_capacity(raw.len());
    let mut prev_space = false;
    for ch in raw.trim().chars() {
        if ch.is_whitespace() {
            if !prev_space {
                folded.push(' ');
                prev_space = true;
            }
        } else {
            folded.push(ch);
            prev_space = false;
        }
    }
    let mut s = folded;

    // 3. 去开头套话（任一命中即停；命中后清掉剩余前导空白）
    for f in FILLERS {
        if let Some(rest) = s.strip_prefix(f) {
            s = rest.trim_start().to_string();
            break;
        }
    }

    // 4. 取第一个完整句段，去掉句末标点
    if let Some(idx) = s.find(&['。', '！', '？', '.', '!', '?'][..]) {
        s = s[..idx].trim_end().to_string();
    }

    // 5. 按 Unicode 字符截断（不按 bytes）
    s.chars().take(MAX_CHARS).collect()
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

/// 拼模型列表 URL：去尾斜杠后接 /models；地址已以 /models 结尾时不重复拼接（FB5-04 §13.5）。
pub fn models_url(base_url: &str) -> String {
    let trimmed = base_url.trim_end_matches('/');
    if trimmed.to_ascii_lowercase().ends_with("/models") {
        trimmed.to_string()
    } else {
        format!("{trimmed}/models")
    }
}

/// FB5-04（§3.6）：拉取服务商可用模型列表（GET {base_url}/models）。
/// 错误分类为可读提示（不把「无模型列表」误报成服务完全不可用）：
///  - 401/403 → 密钥无效或无模型列表权限
///  - 404/405 → 该服务未提供模型列表，请手动输入（提示可能缺 /v1 前缀，但不自动补）
///  - 429 → 请求过于频繁
///  - 超时/网络 → 连接问题
///  - 200 但无可解析模型 → 同 404 文案
/// 模型去重 + 不区分大小写排序；错误与 debug 输出不含 API Key（请求带 key，消息只用 base_url/status）。
pub fn discover_models(
    base_url: &str,
    api_key: &str,
    protocol: &str,
    is_local: bool,
) -> AppResult<Vec<String>> {
    if base_url.trim().is_empty() {
        return Err(AppError::msg("请先填写服务地址"));
    }
    let url = models_url(base_url);
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|e| AppError::msg(format!("HTTP 客户端初始化失败: {e}")))?;
    let mut req = client.get(&url);
    let anthropic = protocol == "anthropic_messages" || protocol == "anthropic";
    if anthropic {
        req = req
            .header("x-api-key", api_key)
            .header("anthropic-version", "2023-06-01");
    } else if !api_key.trim().is_empty() {
        req = req.bearer_auth(api_key);
    }
    let resp = match req.send() {
        Ok(r) => r,
        Err(e) => {
            if e.is_timeout() {
                return Err(AppError::msg("模型列表请求超时，请检查服务地址或网络"));
            }
            return Err(AppError::msg(if is_local {
                format!("无法连接本地服务 {url}：请确认 Ollama/LM Studio 已启动")
            } else {
                "无法连接服务，请检查服务地址或网络".to_string()
            }));
        }
    };
    if !resp.status().is_success() {
        let code = resp.status().as_u16();
        let msg = match code {
            401 | 403 => "密钥无效或无模型列表权限".to_string(),
            404 | 405 => {
                "该服务未提供模型列表，请手动输入。若服务地址缺少 /v1 前缀，可在末尾补全 /v1 后重试。"
                    .to_string()
            }
            429 => "请求过于频繁（HTTP 429），请稍后重试".to_string(),
            _ => format!("模型列表请求失败（HTTP {code}）"),
        };
        return Err(AppError::msg(msg));
    }
    let json: serde_json::Value = resp
        .json()
        .map_err(|e| AppError::msg(format!("模型列表解析失败: {e}")))?;
    let mut models = parse_model_ids(&json);
    if models.is_empty() {
        return Err(AppError::msg("该服务未提供模型列表，请手动输入"));
    }
    // 去重 + 不区分大小写排序（§3.6）
    models.sort_by(|a, b| a.to_lowercase().cmp(&b.to_lowercase()));
    models.dedup_by(|a, b| a.to_lowercase() == b.to_lowercase());
    Ok(models)
}

// ── FB3-08（§10.2）：连接测试（按协议分支，密钥只在 Rust 侧从 keyring 读取） ──

/// 连接测试结果（camelCase 给前端；错误信息脱敏——不含密钥与完整 URL query）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiConnectionTestResult {
    pub ok: bool,
    pub status_code: Option<u16>,
    pub latency_ms: u64,
    pub protocol: String,
    pub model: String,
    pub message: String,
}

/// 拼测试 URL：base_url 去尾斜杠后接 path（用户已含 /v1 或不含都兼容）
fn join_url(base_url: &str, path: &str) -> String {
    format!("{}{}", base_url.trim_end_matches('/'), path)
}

/// 连接测试主入口（阻塞网络请求，命令层包 spawn_blocking）。
/// protocol: openai_chat | anthropic_messages；local 部署优先走 openai_chat 的 /models 无鉴权探测。
pub fn test_connection(
    base_url: &str,
    api_key: &str,
    protocol: &str,
    model: &str,
    is_local: bool,
) -> AiConnectionTestResult {
    let started = std::time::Instant::now();
    let client = match reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            return AiConnectionTestResult {
                ok: false,
                status_code: None,
                latency_ms: started.elapsed().as_millis() as u64,
                protocol: protocol.to_string(),
                model: model.to_string(),
                message: format!("无法初始化网络请求: {e}"),
            }
        }
    };

    let (ok, status_code, message) = match protocol {
        // Anthropic Messages：不假设 /models 可用，用最小 /messages 请求验证鉴权与路径
        "anthropic_messages" => {
            let url = join_url(base_url, "/messages");
            let body = serde_json::json!({
                "model": if model.is_empty() { "claude-3-haiku-20240307" } else { model },
                "max_tokens": 1,
                "messages": [{"role": "user", "content": "hi"}],
            });
            let resp = client
                .post(&url)
                .header("x-api-key", api_key)
                .header("anthropic-version", "2023-06-01")
                .header("content-type", "application/json")
                .body(body.to_string())
                .send();
            match resp {
                Ok(r) => {
                    let code = r.status().as_u16();
                    let ok = r.status().is_success();
                    let msg = if ok {
                        format!("连接成功（Anthropic Messages，HTTP {code}）")
                    } else {
                        anthropic_fail_message(code)
                    };
                    (ok, Some(code), msg)
                }
                Err(e) => (false, None, network_error_message(&e, &url)),
            }
        }
        // OpenAI 兼容 / 本地：GET /models（带 Bearer；本地通常无 Key 不带鉴权头）
        _ => {
            let url = join_url(base_url, "/models");
            let mut req = client.get(&url);
            if !api_key.trim().is_empty() {
                req = req.bearer_auth(api_key);
            }
            match req.send() {
                Ok(r) => {
                    let code = r.status().as_u16();
                    let ok = r.status().is_success();
                    let msg = if ok {
                        // 校验指定模型是否在列表中（有模型名时给出更精确的结论）
                        let listed = r.json::<serde_json::Value>().ok();
                        let models = listed.as_ref().map(parse_model_ids).unwrap_or_default();
                        if !model.is_empty()
                            && !models.is_empty()
                            && !models.iter().any(|m| m == model)
                        {
                            format!("服务可达（HTTP {code}），但模型列表中没有「{model}」。请核对该服务实际可用的模型名。")
                        } else if models.is_empty() {
                            format!("连接成功（HTTP {code}，未返回模型列表）")
                        } else {
                            format!("连接成功（HTTP {code}，共 {} 个模型）", models.len())
                        }
                    } else {
                        openai_fail_message(code, is_local)
                    };
                    let result_ok = ok && (model.is_empty() || !msg.contains("模型列表中没有"));
                    return finish(result_ok, Some(code), msg, started, protocol, model);
                }
                Err(e) => (false, None, network_error_message(&e, &url)),
            }
        }
    };
    finish(ok, status_code, message, started, protocol, model)
}

fn finish(
    ok: bool,
    status_code: Option<u16>,
    message: String,
    started: std::time::Instant,
    protocol: &str,
    model: &str,
) -> AiConnectionTestResult {
    AiConnectionTestResult {
        ok,
        status_code,
        latency_ms: started.elapsed().as_millis() as u64,
        protocol: protocol.to_string(),
        model: model.to_string(),
        message,
    }
}

/// HTTP 层错误 → 可读建议（脱敏：不回显完整 URL/密钥）
fn network_error_message(e: &reqwest::Error, url: &str) -> String {
    if e.is_timeout() {
        return "请求超时（20 秒）。服务可能未启动、地址/端口错误或被防火墙拦截。".to_string();
    }
    if e.is_connect() {
        // DNS/TCP 连接失败：给出地址核对建议，但只提示 host 而非完整 URL
        let host = url
            .trim_start_matches("https://")
            .trim_start_matches("http://")
            .split('/')
            .next()
            .unwrap_or("");
        return format!("无法连接到 {host}。请核对服务地址是否正确（在线服务通常以 https:// 开头并以 /v1 结尾）、网络是否可达。");
    }
    if e.is_decode() {
        return "服务响应了，但返回内容不是有效的 JSON。请确认地址指向 API 而不是网页。"
            .to_string();
    }
    format!("请求失败: {e}")
}

fn openai_fail_message(code: u16, is_local: bool) -> String {
    match code {
        401 | 403 => {
            "服务可达，但密钥无效或没有权限（401/403）。请检查 API 密钥是否正确、是否过期。"
                .to_string()
        }
        404 => {
            "路径不存在（404）。请检查服务地址是否已包含正确的路径（如 /v1），或去掉多余的路径。"
                .to_string()
        }
        429 => "请求频率受限（429）。服务可达，稍后重试即可。".to_string(),
        _ if is_local => format!("本地服务返回 HTTP {code}。请确认引擎已启动且端口正确。"),
        _ => format!("服务返回 HTTP {code}。请核对该服务是否为 OpenAI 兼容接口。"),
    }
}

fn anthropic_fail_message(code: u16) -> String {
    match code {
        401 => "密钥无效（401）。请检查 Anthropic API 密钥。".to_string(),
        403 => "没有权限（403）。密钥可能无权访问该模型。".to_string(),
        404 => "路径或模型不存在（404）。请检查地址是否以 /v1 结尾、模型名是否可用。".to_string(),
        _ => format!("Anthropic 服务返回 HTTP {code}。"),
    }
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

/// P3-02 + FB2-07 + FB5-05（§7.7）：视频抽帧打标（frames 模式）——抽 n 段中点帧逐帧请求后频次合并。
/// 标签按现有频次规则合并；描述取时间上最接近视频中点的成功帧描述（抽帧本身按段中点时间序采样，
/// 成功帧序列的中间帧即近似中点；不为合并描述额外发第二次 AI 请求）。
/// 抽帧/识别全失败返回 Err（单条置 rejected）；所有帧描述为空时保持空描述，不影响标签结果。
fn analyze_video_frames(
    client: &reqwest::blocking::Client,
    cfg: &ApiProfile,
    facets: &[FacetPromptContext],
    top_tags: &[(String, String)],
    manual_keys: &[String],
    asset: &assets::Asset,
    frame_count: usize,
    system_override: &str,
) -> AppResult<MediaAnalysis> {
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
    let mut results: Vec<MediaAnalysis> = Vec::new();
    for f in &frames {
        if let Ok(a) = request_analysis(client, cfg, facets, top_tags, manual_keys, f, system_override) {
            results.push(a);
        }
    }
    let _ = std::fs::remove_dir_all(&dir);
    if results.is_empty() {
        return Err(AppError::msg("视频全部帧 AI 识别失败"));
    }
    let merged = {
        let tag_frames: Vec<CategorizedTags> = results.iter().map(|a| a.tags.clone()).collect();
        merge_frame_tags(&tag_frames)
    };
    if merged.is_empty() && results.iter().all(|a| a.description.is_empty()) {
        return Err(AppError::msg(
            "视频帧标签未达命中阈值（帧数少时需多数帧共同命中）",
        ));
    }
    // §7.7：描述 = 时间上最接近视频中点的成功帧描述
    let description = results[results.len() / 2].description.clone();
    Ok(MediaAnalysis {
        description,
        tags: merged,
        proposals: Vec::new(),
        numbers: Vec::new(),
        warnings: Vec::new(),
        // 视频合并路径：单帧溯源已被逐帧 enrich 捕获，合并结果不再重复存储
        raw_response: String::new(),
        request_config_json: None,
        analysis_json: None,
    })
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
    facets_video: &[FacetPromptContext],
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
    // W5a（a2/a5）：Top-20 候选词（按使用次数降序 → 标签收敛）进 user 段提示词
    let top_tags: Vec<(String, String)> = {
        let conn = lock()?;
        crate::db::tags::top_tags_per_facet(&conn, 20).unwrap_or_default()
    };
    // W5a（a10）：manual_only 分面清单（warning 文案区分「不参与 AI」与「已停用」）
    let manual_keys: Vec<String> = {
        let conn = lock()?;
        conn.prepare(
            "SELECT key FROM tag_facets WHERE status = 'active' AND input_mode = 'manual_only'",
        )
        .and_then(|mut stmt| {
            stmt.query_map([], |r| r.get::<_, String>(0))
                .map(|rows| rows.filter_map(|r| r.ok()).collect())
        })
        .unwrap_or_default()
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
    // F4：图片条目用 facets（all+image），视频条目用 facets_video（all+video）
    let compute = |asset: &crate::db::assets::Asset| -> AppResult<MediaAnalysis> {
        let is_video = asset.mime_type.starts_with("video/");
        let kind_facets: &[FacetPromptContext] = if is_video { facets_video } else { facets };
        if is_video && !cfg.video_tagging {
            return Err(AppError::msg(
                "视频 AI 打标未开启。请打开\"设置 → AI 设置 → 自动打标 → 视频 AI 打标\"，保存后重新开始批次。",
            ));
        }
        if is_video {
            // FB2-07（§13.4/§13.5）：cover 模式走与图片完全相同的 pick_image+request_analysis 路径
            //（零 ffmpeg、零额外解码、1 次请求）；frames 模式抽 N 段中点帧逐帧识别后合并（§7.7）。
            match cfg.video_tagging_mode.as_str() {
                "frames" => analyze_video_frames(
                    &client,
                    profile,
                    kind_facets,
                    &top_tags,
                    &manual_keys,
                    asset,
                    (cfg.video_frame_count as usize).clamp(2, 8),
                    &cfg.system_prompt_tagging,
                ),
                // cover（默认）：复用入库时生成的视频封面，needs 高清图优先
                _ => request_analysis(&client, profile, kind_facets, &top_tags, &manual_keys, &pick_image(asset), &cfg.system_prompt_tagging),
            }
        } else {
            // 网络请求（可能耗时数十秒）：不持 DB 锁
            request_analysis(&client, profile, kind_facets, &top_tags, &manual_keys, &pick_image(asset), &cfg.system_prompt_tagging)
        }
    };

    let mut processed = 0i64;
    // W5a（a12）：连续失败计数（成功清零；≥3 熔断）
    let mut consecutive_failures = 0u32;
    // A2：批次级请求溯源只写一次（取本批首个成功请求的配置；视频帧合并不携带配置，等待后续成功项）
    let mut batch_config_written = false;
    // A4：置信度策略（读设置；默认 = 指导书：min 0.30 / 精确命中自动接收 / 绝不自动建词）
    let policy = ai::ConfidencePolicy {
        min_suggest: cfg.confidence_min_suggest,
        auto_accept_exact_terms: cfg.auto_accept_exact_terms,
        auto_adopt_new_terms: cfg.auto_adopt_new_terms,
    };
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
                    Ok(a) => {
                        // W5a（a12）：成功清零连续失败计数（单条内的退避重试不计入熔断）
                        consecutive_failures = 0;
                        // A1/A4：typed 写建议（confidence 经 proposals 落库；精确命中按策略
                        // 自动接收写 asset_tags(ai_unreviewed)，新词/近似词走 pending）
                        ai::set_suggestion_result_policy(
                            &conn,
                            s.id,
                            &a.tags,
                            &a.proposals,
                            &a.description,
                            &policy,
                        )?;
                        // V24（§6.4）：数值提议落库（歧义进 pending 待人工填数；越界/无数字丢弃 + warning）
                        let number_warnings =
                            ai::record_number_proposals_for_suggestion(&conn, s.id, &a.numbers)?;
                        for w in number_warnings {
                            tracing::info!("asset {} 数值提议: {w}", s.asset_id);
                        }
                        // A2：逐字存模型原始返回 + AnalysisResult 序列化（analysis_schema_version 恒 1）
                        ai::set_suggestion_provenance(
                            &conn,
                            s.id,
                            &a.raw_response,
                            a.analysis_json.as_deref().unwrap_or(""),
                        )?;
                        // A2：批次级溯源（prompt 版本 + 配置 JSON + 稳定 hash + 档案标识）——只写一次
                        if !batch_config_written {
                            if let Some(rcj) = &a.request_config_json {
                                let cfg_val =
                                    serde_json::from_str::<serde_json::Value>(rcj).unwrap_or_default();
                                let hash = stable_config_hash(&cfg_val);
                                ai::set_batch_provenance(
                                    &conn,
                                    batch_id,
                                    &profile.model,
                                    None,
                                    &profile.id,
                                    PROMPT_VERSION,
                                    &hash,
                                    rcj,
                                )?;
                                batch_config_written = true;
                            }
                        }
                    }
                    Err(e) => {
                        // 单条失败不阻塞批次：建议置 rejected 并记录空标签与失败原因（v6 详情落库）
                        let err = e.to_string();
                        tracing::warn!("asset {} 打标失败: {err}", s.asset_id);
                        let _ = ai::set_suggestion_error(&conn, s.id, &err);
                        ai::reject_suggestion(&conn, s.id)?;
                        // W5a（a12）：熔断 —— 连续失败 ≥3 说明是配置/网络级问题
                        //（key 无效/额度耗尽/断网），继续跑只会浪费请求与时间。
                        consecutive_failures += 1;
                        if consecutive_failures >= 3 {
                            ai::set_batch_status(&conn, batch_id, "interrupted")?;
                            return Err(AppError::msg(format!(
                                "连续 {consecutive_failures} 条打标失败，已中断批次（大概率是配置或网络问题，最近错误：{err}）。修复后可在打标页继续未完成的条目。"
                            )));
                        }
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
    use super::{anthropic_fail_message, join_url, models_url, openai_fail_message};
    use super::{
        apply_keep_alive, extract_anthropic_text, parse_categorized, parse_model_ids,
        KEEP_ALIVE_IDLE,
    };
    use crate::db::tag_facets::FacetPromptContext;

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
        // FB5-05：parse_media_analysis 取代 parse_tags_strict；垃圾输入仍判失败
        assert!(super::parse_media_analysis("我无法查看这张图片", &[], &[], &[]).is_err());
    }

    #[test]
    fn strict_valid_object_ok() {
        let valid = ["scene", "style"];
        let r = super::parse_media_analysis("{\"场景\": [\"公园\"]}", &valid, &[], &[]).unwrap();
        assert_eq!(r.tags.get("scene").unwrap(), &vec!["公园".to_string()]);
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
        let valid = ["subject", "scene"];
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
        // C-4：兼容旧中文 key 且不产生 warning（color 已从 AI 体系摘除，此处不再含 color）
        let valid = ["subject", "scene", "lighting"];
        let (tags, warnings) = super::parse_categorized_checked(
            "{\"光线/时间\":[\"黄昏\"],\"主体\":[\"树\"]}",
            &valid,
        );
        assert_eq!(tags.get("lighting").unwrap(), &vec!["黄昏".to_string()]);
        assert_eq!(tags.get("subject").unwrap(), &vec!["树".to_string()]);
        assert!(warnings.is_empty(), "已知中文 key 不应产生 warning");
    }

    /// R0-3：valid_keys 含 custom 时，自建分面 key（clothing_color）必须原样保留，
    /// 不能被 key_for_legacy_name 的 `_ => "custom"` 兜底吞掉。
    /// 真实配置里 custom 是 active + ai_and_manual，必然在 valid_keys 中 ——
    /// 旧分支顺序（先判 mapped）恰好因此被整体旁路。
    #[test]
    fn custom_in_valid_keys_does_not_swallow_user_facet() {
        let valid = ["subject", "scene", "custom", "clothing_color"];
        let (tags, warnings) = super::parse_categorized_checked(
            "{\"clothing_color\":[\"红色\"],\"subject\":[\"人\"]}",
            &valid,
        );
        assert_eq!(
            tags.get("clothing_color").unwrap(),
            &vec!["红色".to_string()],
            "自建分面 key 必须原样保留（R0-3）"
        );
        assert_eq!(tags.get("subject").unwrap(), &vec!["人".to_string()]);
        assert!(warnings.is_empty(), "自建分面命中不应产生 warning：{:?}", warnings);
    }

    // FB2-08（§14.3② / §14.14）：color 分面停用后，模型返回 color/色彩 key → 丢弃 + warning，不落回 color 分面。
    #[test]
    fn checked_deactivated_color_key_is_discarded_with_warning() {
        let valid = ["subject", "scene"]; // color 不在 valid_keys
        let (tags, warnings) = super::parse_categorized_checked(
            "{\"subject\":[\"人\"],\"color\":[\"青橙\"],\"色彩\":[\"蓝\"]}",
            &valid,
        );
        assert!(tags.get("color").is_none(), "停用分面 color 的标签应被丢弃");
        assert_eq!(tags.get("scene"), None);
        assert_eq!(tags.get("subject").unwrap(), &vec!["人".to_string()]);
        assert!(!warnings.is_empty());
        assert!(
            warnings.iter().any(|w| w.contains("已停用")),
            "应有「已停用」warning：{:?}",
            warnings
        );
    }

    // ── FB3-08：连接测试的纯函数部分（网络路径在真机验收） ──

    #[test]
    fn join_url_trims_trailing_slash() {
        // 用户地址带不带尾斜杠、带不带 /v1 都拼出正确路径
        assert_eq!(
            join_url("https://api.example.com/v1", "/models"),
            "https://api.example.com/v1/models"
        );
        assert_eq!(
            join_url("https://api.example.com/v1/", "/models"),
            "https://api.example.com/v1/models"
        );
        assert_eq!(
            join_url("http://localhost:11434/v1", "/models"),
            "http://localhost:11434/v1/models"
        );
        assert_eq!(
            join_url("https://api.example.com", "/messages"),
            "https://api.example.com/messages"
        );
    }

    #[test]
    fn openai_fail_messages_are_actionable() {
        let m401 = openai_fail_message(401, false);
        assert!(m401.contains("密钥"), "401 应指向密钥问题：{m401}");
        let m404 = openai_fail_message(404, false);
        assert!(m404.contains("路径"), "404 应指向路径问题：{m404}");
        let local = openai_fail_message(500, true);
        assert!(
            local.contains("本地"),
            "本地部署的失败信息应指向引擎/端口：{local}"
        );
    }

    #[test]
    fn anthropic_fail_messages_are_actionable() {
        assert!(anthropic_fail_message(401).contains("密钥"));
        assert!(anthropic_fail_message(404).contains("路径"));
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

    // ── FB5-04（§13.5）：模型发现 —— 三种响应形态 / 去重排序 / URL 不重复 /models ──

    #[test]
    fn parse_model_ids_three_shapes() {
        // 1. OpenAI 兼容 {data:[{id}]}
        let data = serde_json::json!({"data": [{"id": "a"}, {"id": "b"}]});
        assert_eq!(parse_model_ids(&data), vec!["a", "b"]);
        // 2. 扁平 {models:["a","b"]}
        let flat = serde_json::json!({"models": ["a", "b"]});
        assert_eq!(parse_model_ids(&flat), vec!["a", "b"]);
        // 3. 顶层数组
        let top = serde_json::json!(["a", "b"]);
        assert_eq!(parse_model_ids(&top), vec!["a", "b"]);
        // 空/坏数据 → 空
        assert!(parse_model_ids(&serde_json::json!({})).is_empty());
        assert!(parse_model_ids(&serde_json::json!([])).is_empty());
    }

    #[test]
    fn models_url_never_duplicates() {
        assert_eq!(
            models_url("https://api.example.com/v1"),
            "https://api.example.com/v1/models"
        );
        assert_eq!(
            models_url("https://api.example.com/v1/"),
            "https://api.example.com/v1/models"
        );
        // 已以 /models 结尾：不重复拼接（§13.5「URL 不重复 /models」）
        assert_eq!(
            models_url("https://api.example.com/v1/models"),
            "https://api.example.com/v1/models"
        );
        assert_eq!(
            models_url("https://api.example.com/v1/models/"),
            "https://api.example.com/v1/models"
        );
        assert_eq!(
            models_url("http://localhost:11434/v1"),
            "http://localhost:11434/v1/models"
        );
    }

    #[test]
    fn discover_models_dedupes_and_sorts_ci() {
        // 无法发真实网络请求：通过 parse_model_ids + 排序/去重纯逻辑等价验证（网络路径在真机验收）
        let raw = serde_json::json!({"data": [
            {"id": "qwen-VL-Max"}, {"id": "qwen-vl-max"}, {"id": "gpt-4.1"}, {"id": "gpt-4.1"}
        ]});
        let mut models = parse_model_ids(&raw);
        models.sort_by(|a, b| a.to_lowercase().cmp(&b.to_lowercase()));
        models.dedup_by(|a, b| a.to_lowercase() == b.to_lowercase());
        // 不区分大小写排序 + 去重：大小写变体只保留输入顺序中的第一个
        assert_eq!(models, vec!["gpt-4.1", "qwen-VL-Max"]);
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

    // ── FB5-05（§7.5）：一句话描述规范化 ──

    #[test]
    fn normalize_description_trims_whitespace_and_folds() {
        assert_eq!(
            super::normalize_content_description("  夜晚树下多人合影  "),
            "夜晚树下多人合影"
        );
        assert_eq!(
            super::normalize_content_description("夜晚树下\n多人合影"),
            "夜晚树下 多人合影"
        );
        assert_eq!(
            super::normalize_content_description("夜晚树下\t\t多人  合影"),
            "夜晚树下 多人 合影"
        );
        assert_eq!(super::normalize_content_description(""), "");
        assert_eq!(super::normalize_content_description("   "), "");
    }

    // ── FB5-05（§7.4）：MediaAnalysis 解析 ──

    #[test]
    fn parse_media_analysis_new_protocol() {
        let valid = ["subject", "scene", "lighting"];
        let a = super::parse_media_analysis(
            r#"{"description":"这是一张夜晚树下多人合影。","tags":{"subject":["树"],"lighting":["夜间"],"people":["多人"]}}"#,
            &valid,
            &[],
            &[],
        )
        .unwrap();
        assert_eq!(a.description, "夜晚树下多人合影");
        assert_eq!(a.tags.get("subject").unwrap(), &vec!["树".to_string()]);
    }

    #[test]
    fn parse_media_analysis_old_protocol_no_description() {
        let valid = ["subject"];
        let a = super::parse_media_analysis(r#"{"subject":["树"]}"#, &valid, &[], &[]).unwrap();
        assert_eq!(a.description, "");
        assert_eq!(a.tags.get("subject").unwrap(), &vec!["树".to_string()]);
    }

    /// V24（§6.4）：numbers 对象 → NumberProposal（原文原样）；数值分面 key 不得留在 tags。
    #[test]
    fn parse_media_analysis_extracts_numbers_object() {
        let valid = ["subject", "people_count"];
        let facets = vec![FacetPromptContext {
            key: "people_count".into(),
            display_name: "人数".into(),
            description: String::new(),
            selection_mode: "single".into(),
            max_items: None,
            facet_kind: "number".into(),
            num_min: Some(0.0),
            num_max: Some(50.0),
            num_unit: "人".into(),
        }];
        let a = super::parse_media_analysis(
            r#"{"description":"树下五人合影","tags":{"subject":["树"]},"numbers":{"people_count":"5人"}}"#,
            &valid,
            &facets,
            &[],
        )
        .unwrap();
        assert_eq!(a.numbers.len(), 1, "numbers 提议应收集 1 条：{:?}", a.numbers);
        assert_eq!(a.numbers[0].facet_key, "people_count");
        assert_eq!(a.numbers[0].raw_text, "5人");
        assert!(a.tags.get("people_count").is_none(), "数值分面不得留在 tags");
    }

    /// V24：模型把数值误写进 tags（tags.people_count=["5"]）→ 摘出转成数值提议 + warning。
    #[test]
    fn parse_media_analysis_number_in_tags_is_moved_to_numbers() {
        let valid = ["people_count"];
        let facets = vec![FacetPromptContext {
            key: "people_count".into(),
            display_name: "人数".into(),
            description: String::new(),
            selection_mode: "single".into(),
            max_items: None,
            facet_kind: "number".into(),
            num_min: None,
            num_max: None,
            num_unit: String::new(),
        }];
        let a = super::parse_media_analysis(
            r#"{"description":"五人合影","tags":{"people_count":["5"]}}"#,
            &valid,
            &facets,
            &[],
        )
        .unwrap();
        assert_eq!(a.numbers.len(), 1);
        assert_eq!(a.numbers[0].raw_text, "5");
        assert!(
            a.warnings.iter().any(|w| w.contains("误写")),
            "应有「误写已转」warning：{:?}",
            a.warnings
        );
    }

    #[test]
    fn parse_media_analysis_description_only_is_valid() {
        // 标签为空但描述非空 = 有效分析（§7.5 放宽）
        let valid = ["subject"];
        let a =
            super::parse_media_analysis(r#"{"description":"纯红底色","tags":{}}"#, &valid, &[], &[]).unwrap();
        assert_eq!(a.description, "纯红底色");
        assert!(a.tags.is_empty());
        // 扁平旧数组也兼容（无描述；未知 key 归 custom）
        let a2 = super::parse_media_analysis(r#"["人像"]"#, &valid, &[], &[]).unwrap();
        assert_eq!(a2.description, "");
        assert!(
            a2.tags.values().flatten().any(|t| t == "人像"),
            "扁平数组标签应收进某分面桶"
        );
    }

    #[test]
    fn parse_media_analysis_both_empty_fails() {
        let valid = ["subject"];
        let err =
            super::parse_media_analysis(r#"{"description":"","tags":{}}"#, &valid, &[], &[]).unwrap_err();
        assert!(err.to_string().contains("模型未返回"));
        let err2 = super::parse_media_analysis("not json", &valid, &[], &[]).unwrap_err();
        assert!(err2.to_string().contains("模型未返回"));
    }

    // FX-02：模型回复包 ```json 围栏（gemma3 等本地模型实测形态）。
    // 此前整串解析失败 → 顶层键 "description" 被当成分面 key，
    // 描述整句落 custom、真实 tags 全丢（线上「只打出 custom 标」第二层根因）。
    #[test]
    fn parse_media_analysis_fenced_json_new_protocol() {
        let valid = ["subject", "scene", "style", "people", "composition", "lighting"];
        let raw = "```json\n{\n  \"description\": \"女孩斜站街旁\",\n  \"tags\": {\n    \"scene\": [\"街道\"],\n    \"style\": [\"清新\"],\n    \"people\": [\"女\", \"青少年\"],\n    \"subject\": [\"女孩\"],\n    \"composition\": [\"特写\"],\n    \"lighting\": [\"柔光\"]\n  }\n}\n```";
        let a = super::parse_media_analysis(raw, &valid, &[], &[]).unwrap();
        assert_eq!(a.description, "女孩斜站街旁");
        assert_eq!(a.tags.get("scene").unwrap(), &vec!["街道".to_string()]);
        assert_eq!(a.tags.get("people").unwrap(), &vec!["女".to_string(), "青少年".to_string()]);
        assert!(a.tags.get("custom").is_none(), "围栏剥除后不得再把描述落进 custom");
    }

    #[test]
    fn parse_media_analysis_fenced_with_prose_around() {
        // 围栏 + 前后闲话（宽容截取首个 { 到末个 }）
        let valid = ["subject"];
        let raw = "好的，以下是整理好的并符合规格的JSON格式：\n```json\n{\"description\":\"夜晚树下自拍\",\"tags\":{\"subject\":[\"树\"]}}\n```";
        let a = super::parse_media_analysis(raw, &valid, &[], &[]).unwrap();
        assert_eq!(a.description, "夜晚树下自拍");
        assert_eq!(a.tags.get("subject").unwrap(), &vec!["树".to_string()]);
    }

    #[test]
    fn parse_media_analysis_fenced_old_protocol_no_description() {
        // 围栏包裹的旧协议（无 description 字段）：标签按分面归位，描述为空
        let valid = ["scene"];
        let raw = "```json\n{\"场景\": [\"公园\"]}\n```";
        let a = super::parse_media_analysis(raw, &valid, &[], &[]).unwrap();
        assert_eq!(a.description, "");
        assert_eq!(a.tags.get("scene").unwrap(), &vec!["公园".to_string()]);
    }

    #[test]
    fn normalize_description_strips_fillers_and_sentence() {
        // 开头套话去除
        assert_eq!(
            super::normalize_content_description("这是一张夜晚树下多人合影。"),
            "夜晚树下多人合影"
        );
        assert_eq!(
            super::normalize_content_description("这张图片展示夜晚的海滩！"),
            "夜晚的海滩"
        );
        assert_eq!(
            super::normalize_content_description("画面中有树和多人，氛围温馨。"),
            "树和多人，氛围温馨"
        );
        // 只取第一个句段（逗号不在截断范围，但句号截断）
        assert_eq!(
            super::normalize_content_description("夜晚树下多人合影，氛围温馨。整体色调偏冷。"),
            "夜晚树下多人合影，氛围温馨"
        );
        // 无套话/无标点原样保留
        assert_eq!(
            super::normalize_content_description("夜晚树下多人合影"),
            "夜晚树下多人合影"
        );
    }

    #[test]
    fn normalize_description_truncates_to_20_unicode_chars() {
        let long = "一个阳光明媚的海边沙滩上人们正在散步的场景十分美好";
        assert_eq!(long.chars().count(), 25);
        let out = super::normalize_content_description(long);
        assert_eq!(out.chars().count(), 20, "必须按 Unicode 字符截断：{out}");
        // 中文按字符而非字节（每字 3 bytes，20 字 ≠ 20 bytes）
        assert!(out.len() <= 20 * 3 + 32);
        // 表情符号（多字节）也不被切坏
        let emoji = "🌅海边日落很美很浪漫的景色";
        let out2 = super::normalize_content_description(emoji);
        assert!(out2.chars().count() <= 20);
        assert!(!out2.is_empty());
    }
}
