//! 茶包素材 BagerTea AiMdeias V2 —— Tauri 应用入口
//! T03：核心服务 + M1 commands 注册（网盘已移除，见 §6.8）
//! 指导书 阶段 1 §5.2：setup 关键路径只保留「建目录 → 开库 → 迁移 → 注册状态/命令/协议」；
//! 缩略图 LRU、旧标签整理、历史任务状态修复全部移入具名后台线程（不阻塞窗口显示）。

pub mod commands;
pub mod db;
pub mod error;
pub mod services;
pub mod state;
pub mod utils;

use crate::db::settings;
use crate::error::AppError;
use crate::services::thumbnail::ThumbnailService;
use state::AppState;
use tauri::Manager;

/// W0-9：日志目录（stdout + 滚动文件双出口）。初始化失败降级纯 stdout，不阻断启动。
fn init_logging(data_dir: &std::path::Path) -> Option<tracing_appender::non_blocking::WorkerGuard> {
    use tracing_appender::non_blocking;
    use tracing_appender::rolling;
    use tracing_subscriber::layer::SubscriberExt;
    use tracing_subscriber::util::SubscriberInitExt;
    use tracing_subscriber::{fmt, layer::Layer as _, EnvFilter};

    let logs_dir = data_dir.join("logs");
    // 滚动 appender 自带保留策略：max_log_files(7)，超期自动清理
    let file_appender = match rolling::Builder::new()
        .max_log_files(7)
        .filename_prefix("app.log")
        .rotation(rolling::Rotation::DAILY)
        .build(logs_dir.clone())
    {
        Ok(a) => a,
        Err(e) => {
            // 降级：纯 stdout，不阻断启动
            let _ = fmt::Subscriber::builder()
                .with_ansi(false)
                .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")))
                .try_init();
            eprintln!("日志文件初始化失败（降级为 stdout）: {e}");
            return None;
        }
    };
    let (file_writer, guard) = non_blocking(file_appender);
    let env_filter =
        EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));
    let stdout_layer = fmt::layer().with_ansi(false);
    let file_layer = fmt::layer()
        .with_writer(file_writer)
        .with_ansi(false)
        .with_filter(env_filter);
    let result = tracing_subscriber::registry()
        .with(stdout_layer)
        .with(file_layer)
        .try_init();
    if result.is_err() {
        // 已有全局 subscriber（如测试环境）：文件层装不上，只能降级
        eprintln!("tracing subscriber 已初始化，文件日志未接入");
        return Some(guard);
    }
    tracing::info!(?logs_dir, "文件日志已启用（保留 7 天）");
    Some(guard)
}

/// W0-10：迁移/初始化失败给用户可见出路（发布版无控制台，panic 等于静默崩溃）。
/// 先在 tauri app 启动前用 rfd 弹原生 dialog（plugin dialog 需要 AppHandle，此时还没有），
/// 弹失败（无桌面环境）时退回 eprintln + panic。
fn fatal_db_error(db_path: &std::path::Path, logs_dir: &std::path::Path, e: &AppError) -> ! {
    let msg = format!(
        "数据库升级失败：{e}。\n\n请把日志目录打包发给支持：\n{}",
        logs_dir.display()
    );
    tracing::error!(?db_path, "数据库初始化失败: {e}");
    // tauri-plugin-dialog 2.7 依赖 rfd 0.15：直接用它做无 AppHandle 的阻塞弹窗
    let _shown = rfd::MessageDialog::new()
        .set_level(rfd::MessageLevel::Error)
        .set_title("数据库升级失败")
        .set_description(&msg)
        .show();
    eprintln!("{msg}");
    panic!("{msg}");
}

/// 具名后台线程：setup 中的非关键维护任务统一入口。
/// 失败只记录 warning，绝不阻塞窗口显示；任务有明确名字便于日志定位。
fn spawn_maintenance(name: &'static str, f: impl FnOnce() + Send + 'static) {
    let builder = std::thread::Builder::new().name(format!("maintenance::{name}"));
    match builder.spawn(move || {
        if let Err(e) = std::panic::catch_unwind(std::panic::AssertUnwindSafe(f)) {
            tracing::warn!("后台维护任务 {name} panic: {e:?}");
        }
    }) {
        Ok(_) => tracing::info!("后台维护任务已启动: {name}"),
        Err(e) => tracing::warn!("后台维护任务 {name} 启动失败: {e}"),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // W0-9：数据目录计算提前到日志初始化之前（文件日志要写 data_dir/logs）
    let data_dir = dirs::data_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("."))
        .join("bagertea_ai_media_v2");
    // WorkerGuard 必须绑定 run() 栈生命周期：绑到局部会立即 drop → 文件日志一条不写
    let _log_guard = init_logging(&data_dir);

    // 应用数据目录：$APP_DATA_DIR/bagertea_ai_media_v2/library.db
    let db_path = data_dir.join("library.db");

    // 关键路径（保留）：创建数据目录 + 打开数据库 + 必要迁移。
    // W0-10：迁移失败弹原生 dialog 给用户可见出路，不再裸 panic 静默崩溃
    let conn = match db::init(&db_path) {
        Ok(c) => c,
        Err(e) => fatal_db_error(&db_path, &data_dir.join("logs"), &e),
    };

    // asset 协议放行用（data_dir 稍后会 move 进 AppState）
    let scope_dir = data_dir.clone();

    tauri::Builder::default()
        // B05：先 manage(AppState)，setup 闭包中 app.state::<AppState>() 才可用
        .manage(AppState::new(conn, data_dir))
        // asset 协议按需放行（安全收敛）：
        // B08：只放行 thumbnails/ + previews/ 子目录，不放行 data_dir 根（含 library.db）
        // 素材原文件由 list/get 命令逐路径放行
        .setup(move |app| {
            let thumbs_dir = scope_dir.join("thumbnails");
            let previews_dir = scope_dir.join("previews");
            let proxies_dir = scope_dir.join("proxies");
            if let Err(e) = app
                .asset_protocol_scope()
                .allow_directory(&thumbs_dir, true)
            {
                tracing::warn!("asset 协议放行缩略图目录失败: {e}");
            }
            if let Err(e) = app
                .asset_protocol_scope()
                .allow_directory(&previews_dir, true)
            {
                tracing::warn!("asset 协议放行预览目录失败: {e}");
            }
            // §8.3：放行视频兼容代理目录（原文件不兼容时的按需转码产物）
            if let Err(e) = app
                .asset_protocol_scope()
                .allow_directory(&proxies_dir, true)
            {
                tracing::warn!("asset 协议放行视频代理目录失败: {e}");
            }
            // 关键路径之外的非关键维护：旧预置标签整理（§5.2 移出关键路径）
            let state = app.state::<AppState>();
            // FX-14：SQLite 无统计信息时不会选用 dominant_* 等窄索引（实测：按主色筛选会退化成
            // idx_assets_deleted 全扫）。PRAGMA optimize 增量更新 sqlite_stat1，成本与库规模成正比、
            // 259 项量级是毫秒级。放后台维护线程：它不在启动关键路径上（§5.2）。
            let opt_db = std::sync::Arc::clone(&state.db);
            spawn_maintenance("sqlite-optimize", move || {
                if let Ok(c) = opt_db.lock().map_err(|_| AppError::msg("数据库锁中毒")) {
                    // PRAGMA optimize 只统计"本连接使用过的表"：启动瞬间没有任何查询跑过时
                    // optimize 是 no-op（实测 sqlite_stat1 未生成）。先跑一组代表性查询
                    // 把 assets 纳入本连接的使用集合，optimize 才会为它生成统计。
                    let _ = c.execute_batch(
                        "SELECT COUNT(*) FROM assets WHERE deleted_at IS NULL;

                         SELECT id FROM assets WHERE dominant_hue BETWEEN 200 AND 250 AND dominant_hue IS NOT NULL LIMIT 1;

                         SELECT id FROM assets WHERE dominant_sat <= 10 LIMIT 1;

                         SELECT id FROM assets WHERE dominant_lum BETWEEN 10 AND 90 LIMIT 1;",
                    );
                    if let Err(e) = c.execute_batch("PRAGMA optimize;") {
                        tracing::warn!("PRAGMA optimize 失败（不影响功能，仅查询计划可能次优）: {e}");
                    }
                }
            });

            let preset_db = std::sync::Arc::clone(&state.db);
            spawn_maintenance("preset-tags-cleanup", move || {
                let conn = preset_db.lock().map_err(|_| AppError::msg("数据库锁中毒"));
                if let Ok(c) = conn {
                    if let Err(e) = db::tags::retire_unused_presets(&c) {
                        tracing::warn!("旧预置标签清理失败: {e}");
                    }
                }
            });

            // B05：启动时执行一次 LRU 清理（读 settings 短锁 → 锁外清理）。
            // §5.2：移出关键路径——缩略图清理是纯文件系统 IO，放后台线程不阻塞窗口显示。
            let lru_db = std::sync::Arc::clone(&state.db);
            let lru_dir = scope_dir.clone();
            spawn_maintenance("thumbnail-lru-cleanup", move || {
                let cache_mb = {
                    let conn = lru_db.lock().map_err(|_| AppError::msg("数据库锁中毒"));
                    match conn {
                        Ok(c) => settings::get_settings(&c)
                            .ok()
                            .map(|s| s.thumbnail_cache_mb),
                        Err(_) => None,
                    }
                };
                if let Some(max_mb) = cache_mb {
                    if let Ok(thumbs) = ThumbnailService::new(&lru_dir) {
                        let _ = thumbs.cleanup_lru(max_mb);
                    }
                }
            });

            // R-22：启动时清理超期回收站（不常驻定时器；文件 IO 后台线程不堵启动）
            let trash_db = std::sync::Arc::clone(&state.db);
            let trash_dir = scope_dir.clone();
            spawn_maintenance("trash-purge", move || {
                let days = {
                    let conn = trash_db.lock().map_err(|_| AppError::msg("数据库锁中毒"));
                    match conn {
                        Ok(c) => settings::get_settings(&c)
                            .ok()
                            .map(|s| s.trash_retention_days),
                        Err(_) => None,
                    }
                };
                if let Some(days) = days {
                    if days > 0 {
                        if let Err(e) = commands::purge_expired_trash(&trash_db, &trash_dir, days) {
                            tracing::warn!("回收站自动清理失败: {e}");
                        }
                    }
                }
            });

            // 阶段 5 §8.2：应用重启时把遗留 processing 批次标记为 interrupted（可一键续跑）
            // §5.2：历史任务状态修复属可延迟维护，移入后台线程。
            let ai_db = std::sync::Arc::clone(&state.db);
            spawn_maintenance("batch-interrupt-mark", move || {
                let conn = ai_db.lock().map_err(|_| AppError::msg("数据库锁中毒"));
                if let Ok(c) = conn {
                    if let Err(e) = db::ai::mark_interrupted_batches(&c) {
                        tracing::warn!("标记中断批次失败: {e}");
                    }
                }
            });

            Ok(())
        })
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            // 素材
            commands::list_assets,
            commands::list_asset_ids,
            commands::list_metadata_facets,
            commands::get_asset,
            commands::delete_assets,
            commands::trash_restore,
            commands::dedup_scan,
            commands::get_asset_urls,
            commands::reveal_in_folder,
            // 媒体元数据回填（指导书 §7.5）
            commands::rescan_asset_metadata,
            commands::cancel_media_refill,
            // FB2-08：算法色板回算（独立的 rescan_*）
            commands::rescan_asset_palette,
            // V18：GPS 定位 + 视频拍摄时间存量回填（独立的 rescan_*）
            commands::rescan_asset_geo_taken,
            // W1-4：图片宽高存量回填（RAW 分辨率修复）
            commands::rescan_image_dimensions,
            // FB4-03：色板状态查询 + 定向补丁（设置页状态行 / 局部同步）
            commands::get_palette_status,
            commands::get_asset_palette_patches,
            // 视频兼容代理（指导书 §8.3）
            commands::ensure_video_proxy,
            commands::get_video_proxy_status,
            commands::cancel_video_proxy,
            commands::clear_video_proxy,
            commands::video_proxy_cache_stats,
            commands::clear_all_video_proxies,
            // 超级搜索
            commands::ai_parse_search_query,
            // 入库
            commands::import_files,
            commands::inspect_import,
            commands::cancel_import,
            commands::preview_rename,
            commands::open_file_external,
            // 标签
            commands::list_tags,
            commands::list_tag_facets,
            commands::list_all_tag_facets,
            commands::create_tag_facet,
            commands::update_tag_facet_display,
            commands::update_tag_facet_rules,
            commands::reorder_tag_facets,
            commands::deactivate_tag_facet,
            commands::restore_tag_facet,
            commands::get_tag_facet_impact,
            commands::list_tags_by_facet,
            commands::list_tag_governance,
            commands::search_tag_candidates,
            commands::create_canonical_tag,
            commands::add_tag_alias,
            commands::create_tag,
            commands::update_tag,
            commands::delete_tag,
            commands::deactivate_tag,
            commands::tag_merge,
            commands::merge_tags_preserve_alias,
            commands::assign_tags,
            commands::remove_tags,
            commands::get_asset_tags,
            commands::tag_recent_ops,
            commands::tag_undo_batch,
            // 缩略图
            commands::get_thumbnail,
            commands::clear_thumbnail_cache,
            commands::get_preview,
            // 导出
            commands::export_local_files,
            commands::export_csv_manifest,
            commands::list_export_tasks,
            commands::cancel_export,
            // AI 打标
            commands::ai_create_batch,
            commands::ai_start_batch,
            commands::ai_cancel_batch,
            commands::ai_list_batches,
            commands::ai_list_suggestions,
            commands::ai_list_suggestion_items,
            commands::ai_decide_suggestion_item,
            commands::ai_confirm_suggestion,
            commands::ai_reject_suggestion,
            commands::ai_restore_suggestion,
            commands::ai_confirm_all,
            commands::ai_apply_tags,
            // Ollama 一键配置（方案 A2）+ 一键安装（方案 A3）
            commands::ollama_ping,
            commands::ollama_probe_hardware,
            commands::ollama_pull,
            commands::ollama_open_download_page,
            commands::ollama_install_status,
            commands::ollama_download_install,
            commands::ollama_start_service,
            commands::ollama_runtime_status,
            commands::ollama_stop_service,
            commands::ollama_remove_installer,
            // 下载源自选/测速（改造方案）
            commands::ollama_list_sources,
            commands::ollama_probe_sources,
            commands::ollama_add_custom_source,
            commands::ollama_remove_custom_source,
            // 本地打标：模型管理（列表/删除/目录）
            commands::ollama_list_local_models,
            commands::ollama_delete_model,
            commands::ollama_model_dir,
            commands::ollama_open_model_dir,
            // 设置
            commands::get_settings,
            commands::save_settings,
            commands::get_data_dir,
            commands::open_data_dir,
            // W0-9：设置页「关于」打开日志目录（tracing-appender 滚动文件）
            commands::open_logs_dir,
            commands::reset_app_data,
            // AI 连接档案 + 用途绑定（指导书 §6.3/§4.4）
            commands::list_ai_connections,
            commands::save_ai_connection,
            commands::delete_ai_connection,
            commands::set_ai_usage_binding,
            commands::get_ai_usage_bindings,
            commands::get_legacy_active_profile,
            commands::test_ai_connection,
            commands::discover_ai_models,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            // L2（§8.2）：应用退出只停止 AppOwned；External（用户自启）永不杀
            if let tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit = event {
                if let Some(state) = app_handle.try_state::<AppState>() {
                    let rt = std::sync::Arc::clone(&state.ollama_runtime);
                    {
                        let mut runtime = rt.lock().ok();
                        if let Some(r) = runtime.as_mut() {
                            r.stop_app_owned();
                        }
                    }
                }
            }
        });
}
