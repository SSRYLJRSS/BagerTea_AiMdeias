//! AI 云端打标服务层集成测试（TEST_STRATEGY M5 / G3）
//! 覆盖 run_cloud_batch 全链路：成功写建议 / Anthropic 模式 / 空解析置 rejected（v2.12）/
//! 非 200 降级 / 取消 / limit 续跑 / 无 pending 空转 / list_models / 连接拒绝本地提示。
//! HTTP mock 用 tests/common 的同步 mock（见其文件头选型说明）。
//! 网络类用例统一持 common::NET_LOCK 串行执行，消除 Windows 并行偶发连接失败。
//! 运行：cargo test --test ai_service_integration

mod common;

use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use bagertea_ai_media_v2_lib::db::ai::{self, AiSuggestion};
use bagertea_ai_media_v2_lib::db::settings::{AiSettings, ApiProfile, TagCategory};
use bagertea_ai_media_v2_lib::db::{self, assets};
use bagertea_ai_media_v2_lib::error::AppResult;
use bagertea_ai_media_v2_lib::services::thumbnail::ThumbnailService;
use bagertea_ai_media_v2_lib::services::{ai_cloud, importer};

use common::{HttpResponse, MockServer, RecordedRequest};

// ───────────────────────── 测试设施 ─────────────────────────

/// 连接层失败特征（Windows 本机回环瞬态问题，实测 ~5-15% 频率，见下）：
/// - "error sending request"：reqwest 发送/连接阶段失败
/// - "connection closed" / "os error 10053/10054"：对端中止/重置（WSAECONNABORTED/RESET）
/// - "error decoding response body" / "error reading a body"：响应在传输中被中止
/// - "io_failures="：服务器侧读请求失败计数（请求到达但连接中断；任何断言消息中
///   出现该字段都视为环境噪声——若为正常 0 值则测试不会失败到此处）
/// 其余错误（5xx、解析失败、业务错误）不属于连接层特征，不会触发重试。
fn is_conn_err_text(s: &str) -> bool {
    s.contains("error sending request")
        || s.contains("connection closed")
        || s.contains("os error 1005")
        || s.contains("os error 10054")
        || s.contains("error decoding response body")
        || s.contains("error reading a body")
        || s.contains("io_failures=")
}

/// Windows 本地回环瞬态连接失败（mock + reqwest blocking 大 body POST 实测
/// 失败率 ~13-19%，探针 2026-08-23 复现；可能与本机安全软件挂钩 socket 有关）的
/// 用例级重试外壳：
/// - 仅当「连接层特征错误」出现时整体重建环境（DB/tempdir/mock）重跑，最多 2 次重试；
/// - 覆盖两种出现形态：① 用例以连接层 Err 返回；② 断言 panic 的消息中带连接层错误
///   （被测代码把连接失败降级为「建议 rejected」，断言会因标签缺失而 panic）；
/// - 业务错误（401/无待打标/解析失败）与不带连接特征的断言失败**不重试**——
///   不掩盖被测状态机真错。
///
/// 用法：把 `#[test] fn name() -> AppResult<()> { body }` 换成
/// `conn_retry_test!(name, { body });`
macro_rules! conn_retry_test {
    ($name:ident, $body:block) => {
        #[test]
        fn $name() -> AppResult<()> {
            let attempt = || {
                std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| -> AppResult<()> { $body }))
            };
            for n in 0..=2u32 {
                match attempt() {
                    Ok(Ok(())) => return Ok(()),
                    Ok(Err(e)) => {
                        let text = e.to_string();
                        if is_conn_err_text(&text) && n < 2 {
                            eprintln!("[conn-retry {}] 连接层错误，重建环境重跑: {text}", n + 1);
                            continue;
                        }
                        return Err(e);
                    }
                    Err(payload) => {
                        let msg = payload
                            .downcast_ref::<String>()
                            .cloned()
                            .or_else(|| payload.downcast_ref::<&str>().map(|s| s.to_string()))
                            .unwrap_or_default();
                        if is_conn_err_text(&msg) && n < 2 {
                            let shown: String = msg.chars().take(200).collect();
                            eprintln!("[conn-retry {}] 断言含连接层错误特征，重建环境重跑: {shown}", n + 1);
                            continue;
                        }
                        std::panic::resume_unwind(payload);
                    }
                }
            }
            unreachable!()
        }
    };
}

fn make_image(dir: &Path, name: &str, salt: u32) {
    let img = image::RgbImage::from_fn(8, 8, |x, y| {
        image::Rgb([x as u8, (y + salt) as u8, 128])
    });
    image::DynamicImage::ImageRgb8(img)
        .save_with_format(dir.join(name), image::ImageFormat::Jpeg)
        .expect("生成测试图失败");
}

/// 入库 N 张真实小图，返回 asset ids（file_path 均指向真实文件，request_tags 可读）
fn import_images(
    dbm: &Arc<Mutex<rusqlite::Connection>>,
    thumbs: &ThumbnailService,
    n: usize,
) -> AppResult<Vec<i64>> {
    let tmp = tempfile::tempdir()?;
    let src = tmp.path().join("src");
    std::fs::create_dir_all(&src)?;
    for i in 0..n {
        // salt 保证每张内容不同：否则相同像素内容会被哈希去重成 1 张
        make_image(&src, &format!("a{i:03}.jpg"), i as u32 + 1);
    }
    let r = importer::import_paths(
        dbm,
        thumbs,
        &[src.to_string_lossy().into_owned()],
        &Default::default(),
        &AtomicBool::new(false),
        |_| {},
    )?;
    assert_eq!(r.imported, n as i64, "导入应全部成功: {:?}", r.errors);
    let page = assets::list(
        &dbm.lock().unwrap(),
        &assets::AssetFilter {
            limit: 1000,
            ..Default::default()
        },
    )?;
    Ok(page.items.iter().map(|a| a.id).collect())
}

fn profile(base_url: &str, api_mode: &str, kind: &str) -> ApiProfile {
    ApiProfile {
        id: "p1".into(),
        name: "测试档案".into(),
        api_mode: api_mode.into(),
        kind: kind.into(),
        base_url: base_url.into(),
        api_key: "test-key".into(),
        model: "qwen-vl-plus".into(),
    }
}

fn settings_with(profile: ApiProfile) -> AiSettings {
    AiSettings {
        profiles: vec![profile.clone()],
        active_profile: profile.id.clone(),
        api_mode: String::new(),
        base_url: String::new(),
        api_key: String::new(),
        model: String::new(),
        auto_tagging: false,
        video_tagging: false,
        local_model_tier: "light".into(),
        batch_limit: 500,
        ollama_source_id: "auto".into(),
    }
}

fn categories() -> Vec<TagCategory> {
    vec![TagCategory {
        name: "场景".into(),
        hint: String::new(),
        single: true,
        max: 3,
    }]
}

fn progress_sink() -> (
    Arc<Mutex<Vec<ai_cloud::AiProgress>>>,
    impl Fn(ai_cloud::AiProgress),
) {
    let sink: Arc<Mutex<Vec<ai_cloud::AiProgress>>> = Arc::new(Mutex::new(Vec::new()));
    let sink2 = Arc::clone(&sink);
    (sink, move |p| sink2.lock().unwrap().push(p))
}

fn suggestion_tags(conn: &rusqlite::Connection, batch_id: i64) -> Vec<AiSuggestion> {
    ai::list_suggestions(conn, batch_id).expect("list_suggestions 失败")
}

fn assert_ok_json_req(req: &RecordedRequest, path: &str, auth_prefix: &str) {
    assert_eq!(req.method, "POST");
    assert_eq!(req.path, path);
    let auth = req
        .header_authorization
        .as_ref()
        .expect("应带 authorization 头");
    assert!(auth.starts_with(auth_prefix), "authorization 应为 {auth_prefix}…，实际 {auth}");
}

fn openai_ok_body(tags_json: &str) -> String {
    // content 必须是 JSON 字符串（模型回复文本）：用 serde 序列化做转义
    let content = serde_json::to_string(tags_json).expect("提示词 JSON 序列化失败");
    format!(r#"{{"choices":[{{"message":{{"content":{content}}}}}]}}"#)
}

// ───────────────────────── 用例 ─────────────────────────

// OpenAI 兼容模式：批次 pending→processing→done，建议 tags 落库，progress 回调推进
conn_retry_test!(openai_success_writes_suggestions_and_progress, {
    let _g = common::net_lock_guard();
    let srv = MockServer::start(|_req| {
        HttpResponse::ok_json(&openai_ok_body(r#"{"场景":["公园"]}"#))
    });
    let dbm = Arc::new(Mutex::new(db::init_memory()?));
    let tmp = tempfile::tempdir()?;
    let thumbs = ThumbnailService::new(&tmp.path().join("data"))?;
    let ids = import_images(&dbm, &thumbs, 1)?;

    let batch = ai::create_batch(&dbm.lock().unwrap(), &ids, "cloud")?;
    assert_eq!(batch.status, "pending");
    let (sink, progress) = progress_sink();
    let cancel = Arc::new(AtomicBool::new(false));

    ai_cloud::run_cloud_batch(
        &dbm,
        batch.id,
        &settings_with(profile(&srv.url(), "openai", "cloud")),
        &categories(),
        None,
        &cancel,
        progress,
    )?;

    let b = ai::get_batch(&dbm.lock().unwrap(), batch.id)?;
    assert_eq!(b.status, "done");
    assert_eq!(b.processed, 1);
    let sug = suggestion_tags(&dbm.lock().unwrap(), batch.id);
    assert_eq!(sug.len(), 1);
    let got = sug[0].suggested_tags.get("场景").cloned();
    assert_eq!(
        got,
        Some(vec!["公园".to_string()]),
        "建议 tags 应为公园；status={} last_error={:?}",
        sug[0].status,
        sug[0].last_error,
    );
    assert_eq!(sug[0].status, "pending", "status={} last_error={:?}", sug[0].status, sug[0].last_error); // 仅候选，未确认

    let events = sink.lock().unwrap().clone();
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].total, 1);
    assert_eq!(events[0].processed, 1);
    assert_eq!(events[0].current_asset_id, ids[0]);

    let reqs = srv.requests();
    assert_eq!(reqs.len(), 1, "accepts={} io_failures={}", srv.accepts(), srv.io_failures());
    assert_ok_json_req(&reqs[0], "/chat/completions", "Bearer test-key");
    Ok(())
});

// Anthropic Messages 模式：POST {base}/messages，x-api-key + anthropic-version 头
conn_retry_test!(anthropic_mode_sends_messages_and_key_header, {
    let _g = common::net_lock_guard();
    let srv = MockServer::start(|req| {
        assert_eq!(req.header_x_api_key.as_deref(), Some("test-key"));
        assert_eq!(req.path, "/messages");
        HttpResponse::ok_json(r#"{"content":[{"type":"text","text":"{\"光线\":[\"逆光\"]}"}]}"#)
    });
    let dbm = Arc::new(Mutex::new(db::init_memory()?));
    let tmp = tempfile::tempdir()?;
    let thumbs = ThumbnailService::new(&tmp.path().join("data"))?;
    let ids = import_images(&dbm, &thumbs, 1)?;
    let batch = ai::create_batch(&dbm.lock().unwrap(), &ids, "cloud")?;

    let (_, progress) = progress_sink();
    ai_cloud::run_cloud_batch(
        &dbm,
        batch.id,
        &settings_with(profile(&srv.url(), "anthropic", "cloud")),
        &categories(),
        None,
        &Arc::new(AtomicBool::new(false)),
        progress,
    )?;

    let sug = suggestion_tags(&dbm.lock().unwrap(), batch.id);
    assert_eq!(
        sug[0].suggested_tags.get("光线"),
        Some(&vec!["逆光".to_string()]),
        "status={} last_error={:?}",
        sug[0].status,
        sug[0].last_error,
    );
    let reqs = srv.requests();
    assert_eq!(reqs.len(), 1, "accepts={} io_failures={}", srv.accepts(), srv.io_failures());
    assert_eq!(reqs[0].header_x_api_key.as_deref(), Some("test-key"));
    Ok(())
});

// v2.12 核心：空解析 = 单条失败置 rejected（不写空标签冒充成功），批次不中断
conn_retry_test!(empty_tags_marks_rejected_and_batch_continues, {
    let _g = common::net_lock_guard();
    let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let calls2 = Arc::clone(&calls);
    let srv = MockServer::start(move |_| {
        let n = calls2.fetch_add(1, Ordering::SeqCst);
        if n == 0 {
            HttpResponse::ok_json(&openai_ok_body("{}")) // 第 1 张：模型返回空对象
        } else {
            HttpResponse::ok_json(&openai_ok_body(r#"{"场景":["海边"]}"#))
        }
    });
    let dbm = Arc::new(Mutex::new(db::init_memory()?));
    let tmp = tempfile::tempdir()?;
    let thumbs = ThumbnailService::new(&tmp.path().join("data"))?;
    let ids = import_images(&dbm, &thumbs, 2)?;
    let batch = ai::create_batch(&dbm.lock().unwrap(), &ids, "cloud")?;

    let (_, progress) = progress_sink();
    ai_cloud::run_cloud_batch(
        &dbm,
        batch.id,
        &settings_with(profile(&srv.url(), "openai", "cloud")),
        &categories(),
        None,
        &Arc::new(AtomicBool::new(false)),
        progress,
    )?;

    let conn = dbm.lock().unwrap();
    let b = ai::get_batch(&conn, batch.id)?;
    assert_eq!(b.status, "done", "空解析不得中断整批");
    assert_eq!(b.processed, 2);
    let sug = ai::list_suggestions(&conn, batch.id)?;
    // 空解析那条：rejected + 失败详情落库；tags 保持空（不冒充成功）
    assert_eq!(sug[0].status, "rejected");
    assert_eq!(sug[0].suggested_tags.len(), 0);
    let err = sug[0].last_error.as_ref().expect("应记录失败原因");
    assert!(err.contains("未返回可解析"), "错误应带模型原始内容提示: {err}");
    // 其余条正常出建议
    assert_eq!(
        sug[1].suggested_tags.get("场景"),
        Some(&vec!["海边".to_string()]),
        "第 2 条建议未收到标签：status={} last_error={:?}",
        sug[1].status,
        sug[1].last_error,
    );
    Ok(())
});

// 非 200（5xx）：该条 rejected，批次继续走完 done
conn_retry_test!(http_500_marks_rejected_and_batch_done, {
    let _g = common::net_lock_guard();
    let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let calls2 = Arc::clone(&calls);
    let srv = MockServer::start(move |_| {
        let n = calls2.fetch_add(1, Ordering::SeqCst);
        if n == 0 {
            HttpResponse::status_only(500)
        } else {
            HttpResponse::ok_json(&openai_ok_body(r#"{"场景":["街景"]}"#))
        }
    });
    let dbm = Arc::new(Mutex::new(db::init_memory()?));
    let tmp = tempfile::tempdir()?;
    let thumbs = ThumbnailService::new(&tmp.path().join("data"))?;
    let ids = import_images(&dbm, &thumbs, 2)?;
    let batch = ai::create_batch(&dbm.lock().unwrap(), &ids, "cloud")?;

    let (_, progress) = progress_sink();
    ai_cloud::run_cloud_batch(
        &dbm,
        batch.id,
        &settings_with(profile(&srv.url(), "openai", "cloud")),
        &categories(),
        None,
        &Arc::new(AtomicBool::new(false)),
        progress,
    )?;

    let conn = dbm.lock().unwrap();
    let b = ai::get_batch(&conn, batch.id)?;
    assert_eq!(b.status, "done", "last_error 见下");
    assert_eq!(b.processed, 2);
    let sug = ai::list_suggestions(&conn, batch.id)?;
    assert_eq!(sug[0].status, "rejected", "status={} last_error={:?}", sug[0].status, sug[0].last_error);
    assert!(sug[0].last_error.as_ref().is_some());
    assert_eq!(
        sug[1].status,
        "pending",
        "status={} last_error={:?} accepts={} io_failures={}",
        sug[1].status,
        sug[1].last_error,
        srv.accepts(),
        srv.io_failures(),
    );
    Ok(())
});

// 取消（B11）：进度回调中触发 → 批次 cancelled、未完成保持 pending、不 panic
conn_retry_test!(cancel_mid_batch_keeps_remaining_pending, {
    let _g = common::net_lock_guard();
    let srv = MockServer::start(|_| HttpResponse::ok_json(&openai_ok_body(r#"{"场景":["公园"]}"#)));
    let dbm = Arc::new(Mutex::new(db::init_memory()?));
    let tmp = tempfile::tempdir()?;
    let thumbs = ThumbnailService::new(&tmp.path().join("data"))?;
    let ids = import_images(&dbm, &thumbs, 3)?;
    let batch = ai::create_batch(&dbm.lock().unwrap(), &ids, "cloud")?;

    let cancel = Arc::new(AtomicBool::new(false));
    let cancel_ref = Arc::clone(&cancel);
    let progress = move |_p: ai_cloud::AiProgress| {
        cancel_ref.store(true, Ordering::Relaxed); // 第一张处理完立即取消
    };

    ai_cloud::run_cloud_batch(
        &dbm,
        batch.id,
        &settings_with(profile(&srv.url(), "openai", "cloud")),
        &categories(),
        None,
        &cancel,
        progress,
    )?;

    let conn = dbm.lock().unwrap();
    let b = ai::get_batch(&conn, batch.id)?;
    assert_eq!(b.status, "cancelled");
    assert_eq!(b.processed, 1, "只应处理第一张");
    let sug = ai::list_suggestions(&conn, batch.id)?;
    for (i, s) in sug.iter().enumerate() {
        assert_eq!(
            s.status, "pending",
            "第 {} 条 status={} last_error={:?}",
            i + 1, s.status, s.last_error,
        );
    }
    Ok(())
});

// v2.12 续跑核心 + F15a 修复验证（2026-08-22）：
// limit=2 先处理前 2 条，批 done 后再跑**仅处理剩余 3 条**——
// 修复前：todo 只看 status=="pending"，前 2 条（已生成候选）被重复送 AI，
//         processed 虚增 2+5=7、请求 7 次；
// 修复后：待处理 = pending 且 suggested_tags 为空 → 第二轮只请求 3 次、processed 累计 5。
conn_retry_test!(limit_two_then_resume_rest, {
    let _g = common::net_lock_guard();
    let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let calls2 = Arc::clone(&calls);
    let srv = MockServer::start(move |_| {
        calls2.fetch_add(1, Ordering::SeqCst);
        HttpResponse::ok_json(&openai_ok_body(r#"{"场景":["续跑"]}"#))
    });
    let dbm = Arc::new(Mutex::new(db::init_memory()?));
    let tmp = tempfile::tempdir()?;
    let thumbs = ThumbnailService::new(&tmp.path().join("data"))?;
    let ids = import_images(&dbm, &thumbs, 5)?;
    let batch = ai::create_batch(&dbm.lock().unwrap(), &ids, "cloud")?;
    let cfg = settings_with(profile(&srv.url(), "openai", "cloud"));

    // 第一轮：只处理前 2 条
    let (_, progress) = progress_sink();
    ai_cloud::run_cloud_batch(&dbm, batch.id, &cfg, &categories(), Some(2), &Arc::new(AtomicBool::new(false)), progress)?;
    {
        let conn = dbm.lock().unwrap();
        let b = ai::get_batch(&conn, batch.id)?;
        assert_eq!(b.status, "done");
        assert_eq!(b.processed, 2);
        let sug = ai::list_suggestions(&conn, batch.id)?;
        assert_eq!(
            sug[0].suggested_tags.get("场景"),
            Some(&vec!["续跑".to_string()]),
            "第 1 条建议未收到标签：status={} last_error={:?}",
            sug[0].status,
            sug[0].last_error,
        );
        // 第 3 条仍未处理
        assert_eq!(sug[2].suggested_tags.len(), 0);
    }
    assert_eq!(
        calls.load(Ordering::SeqCst),
        2,
        "第一轮应只有 2 次请求：accepts={} io_failures={} requests={:?}",
        srv.accepts(),
        srv.io_failures(),
        srv.requests(),
    );

    // 第二轮：续跑剩余 3 条（F15a 修复后不重复处理前 2 条）
    let (_, progress) = progress_sink();
    ai_cloud::run_cloud_batch(&dbm, batch.id, &cfg, &categories(), None, &Arc::new(AtomicBool::new(false)), progress)?;
    {
        let conn = dbm.lock().unwrap();
        let b = ai::get_batch(&conn, batch.id)?;
        assert_eq!(b.status, "done");
        assert_eq!(b.processed, 5, "修复后 processed 累计应为 5（不虚增）");
        let sug = ai::list_suggestions(&conn, batch.id)?;
        for s in &sug {
            // 带诊断上下文：偶发失败时区分「请求未到达/IO 失败」（mock 侧计数）
            // 与「被测状态机真错」（last_error 内容）
            assert_eq!(
                s.suggested_tags.get("场景"),
                Some(&vec!["续跑".to_string()]),
                "第 {} 条建议未收到标签：status={} last_error={:?}",
                s.id,
                s.status,
                s.last_error,
            );
        }
    }
    assert_eq!(
        calls.load(Ordering::SeqCst),
        5,
        "两轮合计应 5 次请求：accepts={} io_failures={} requests={:?}",
        srv.accepts(),
        srv.io_failures(),
        srv.requests(),
    );
    assert_eq!(calls.load(Ordering::SeqCst), 5, "修复后总请求应 5 次（第二轮仅 3 次）");
    Ok(())
});

// F15b 修复验证：全部确认后再开跑 → 明确报错「没有待打标项」，
// 且批次状态复位为 done（不留 processing 僵尸态），不产生请求。
conn_retry_test!(no_pending_run_errors_with_clear_message, {
    let _g = common::net_lock_guard();
    let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let calls2 = Arc::clone(&calls);
    let srv = MockServer::start(move |_| {
        calls2.fetch_add(1, Ordering::SeqCst);
        HttpResponse::ok_json(&openai_ok_body(r#"{"场景":["公园"]}"#))
    });
    let dbm = Arc::new(Mutex::new(db::init_memory()?));
    let tmp = tempfile::tempdir()?;
    let thumbs = ThumbnailService::new(&tmp.path().join("data"))?;
    let ids = import_images(&dbm, &thumbs, 1)?;
    let batch = ai::create_batch(&dbm.lock().unwrap(), &ids, "cloud")?;
    let cfg = settings_with(profile(&srv.url(), "openai", "cloud"));

    let (_, progress) = progress_sink();
    ai_cloud::run_cloud_batch(&dbm, batch.id, &cfg, &categories(), None, &Arc::new(AtomicBool::new(false)), progress)?;
    assert_eq!(
        calls.load(Ordering::SeqCst),
        1,
        "accepts={} io_failures={} requests={:?}",
        srv.accepts(),
        srv.io_failures(),
        srv.requests(),
    );

    // 确认掉唯一一条 → 无待打标项
    {
        let conn = dbm.lock().unwrap();
        let sug = ai::list_suggestions(&conn, batch.id)?;
        ai::confirm_suggestion(&conn, sug[0].id, &sug[0].suggested_tags)?;
    }

    // 再次开跑：明确报错，不空跑、不发请求、状态不留 processing
    let (_, progress) = progress_sink();
    let r = ai_cloud::run_cloud_batch(&dbm, batch.id, &cfg, &categories(), None, &Arc::new(AtomicBool::new(false)), progress);
    let err = r.expect_err("应报「无待打标」").to_string();
    assert!(err.contains("没有待打标"), "错误应可操作: {err}");
    let b = ai::get_batch(&dbm.lock().unwrap(), batch.id)?;
    assert_eq!(b.status, "done", "批次状态应复位，不留 processing 僵尸态");
    assert_eq!(b.processed, 1);
    assert_eq!(
        calls.load(Ordering::SeqCst),
        1,
        "不应产生新请求：accepts={} io_failures={}",
        srv.accepts(),
        srv.io_failures(),
    );
    Ok(())
});

// F15a 边界：取消中途续跑时，已生成候选的条目被跳过、只处理剩余
conn_retry_test!(resume_after_cancel_skips_generated, {
    let _g = common::net_lock_guard();
    let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let calls2 = Arc::clone(&calls);
    let srv = MockServer::start(move |_| {
        calls2.fetch_add(1, Ordering::SeqCst);
        HttpResponse::ok_json(&openai_ok_body(r#"{"场景":["公园"]}"#))
    });
    let dbm = Arc::new(Mutex::new(db::init_memory()?));
    let tmp = tempfile::tempdir()?;
    let thumbs = ThumbnailService::new(&tmp.path().join("data"))?;
    let ids = import_images(&dbm, &thumbs, 3)?;
    let batch = ai::create_batch(&dbm.lock().unwrap(), &ids, "cloud")?;
    let cfg = settings_with(profile(&srv.url(), "openai", "cloud"));

    // 第一轮：第 1 张处理完立即取消 → cancelled，processed=1
    let cancel = Arc::new(AtomicBool::new(false));
    let cancel_ref = Arc::clone(&cancel);
    let progress = move |_p: ai_cloud::AiProgress| cancel_ref.store(true, Ordering::Relaxed);
    ai_cloud::run_cloud_batch(&dbm, batch.id, &cfg, &categories(), None, &cancel, progress)?;
    {
        let conn = dbm.lock().unwrap();
        let b = ai::get_batch(&conn, batch.id)?;
        assert_eq!(b.status, "cancelled");
        assert_eq!(b.processed, 1);
    }
    assert_eq!(
        calls.load(Ordering::SeqCst),
        1,
        "accepts={} io_failures={} requests={:?}",
        srv.accepts(),
        srv.io_failures(),
        srv.requests(),
    );

    // 第二轮：续跑跳过第 1 张（已有候选），只处理 2、3 张
    let (_, progress) = progress_sink();
    ai_cloud::run_cloud_batch(&dbm, batch.id, &cfg, &categories(), None, &Arc::new(AtomicBool::new(false)), progress)?;
    {
        let conn = dbm.lock().unwrap();
        let b = ai::get_batch(&conn, batch.id)?;
        assert_eq!(b.status, "done");
        assert_eq!(b.processed, 3);
        let sug = ai::list_suggestions(&conn, batch.id)?;
        for s in &sug {
            assert_eq!(
                s.suggested_tags.get("场景"),
                Some(&vec!["公园".to_string()]),
                "第 {} 条建议未收到标签：status={} last_error={:?}",
                s.id,
                s.status,
                s.last_error,
            );
        }
    }
    assert_eq!(
        calls.load(Ordering::SeqCst),
        3,
        "修复后第 1 张不被重复请求：accepts={} io_failures={}",
        srv.accepts(),
        srv.io_failures(),
    );
    Ok(())
});

// list_models：OpenAI /models 解析 + 鉴权头
conn_retry_test!(list_models_parses_openai_response, {
    let _g = common::net_lock_guard();
    let srv = MockServer::start(|req| {
        assert_eq!(req.path, "/models");
        HttpResponse::ok_json(r#"{"object":"list","data":[{"id":"qwen-vl-plus"},{"id":"qwen-vl-max"}]}"#)
    });
    let models = ai_cloud::list_models(&srv.url(), "k", "openai")?;
    assert_eq!(models, vec!["qwen-vl-plus", "qwen-vl-max"]);
    let reqs = srv.requests();
    assert_eq!(reqs[0].method, "GET");
    assert_eq!(reqs[0].header_authorization.as_deref(), Some("Bearer k"));
    Ok(())
});

// list_models：401 → 明确 Err，不 panic
conn_retry_test!(list_models_error_propagates, {
    let _g = common::net_lock_guard();
    let srv = MockServer::start(|_| HttpResponse::status_only(401));
    let r = ai_cloud::list_models(&srv.url(), "k", "openai");
    assert!(r.is_err(), "401 应返回 Err");
    Ok(())
});

// 连接拒绝（本地档案）：错误信息含「无法连接本地服务」引导（P3-01a）
conn_retry_test!(connection_refused_local_profile_hint, {
    let _g = common::net_lock_guard();
    // 127.0.0.1:1 基本必拒绝（无需 mock）
    let dbm = Arc::new(Mutex::new(db::init_memory()?));
    let tmp = tempfile::tempdir()?;
    let thumbs = ThumbnailService::new(&tmp.path().join("data"))?;
    let ids = import_images(&dbm, &thumbs, 1)?;
    let batch = ai::create_batch(&dbm.lock().unwrap(), &ids, "cloud")?;

    let (_, progress) = progress_sink();
    ai_cloud::run_cloud_batch(
        &dbm,
        batch.id,
        &settings_with(profile("http://127.0.0.1:1", "openai", "local")),
        &categories(),
        None,
        &Arc::new(AtomicBool::new(false)),
        progress,
    )?;

    let conn = dbm.lock().unwrap();
    let sug = ai::list_suggestions(&conn, batch.id)?;
    assert_eq!(sug[0].status, "rejected");
    let err = sug[0].last_error.as_ref().expect("应记录失败原因");
    assert!(err.contains("无法连接本地服务"), "本地档案提示应可操作: {err}");
    Ok(())
});