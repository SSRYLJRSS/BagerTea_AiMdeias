//! 茶包素材 BagerTea AiMdeias V2 —— Tauri 应用入口
//! T03：核心服务 + 全部 M1 commands 注册（AI/网盘命令 T05a/T05b 注册）

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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tracing_subscriber::fmt::init();

    // 应用数据目录：$APP_DATA_DIR/bagertea_ai_media_v2/library.db
    let data_dir = dirs::data_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("."))
        .join("bagertea_ai_media_v2");
    let db_path = data_dir.join("library.db");

    let conn = db::init(&db_path).unwrap_or_else(|e| {
        tracing::error!(?db_path, "数据库初始化失败: {e}");
        panic!("数据库初始化失败: {e}");
    });
    if let Err(e) = db::tags::retire_unused_presets(&conn) {
        tracing::warn!("旧预置标签清理失败: {e}");
    }

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
            // B05：启动时执行一次 LRU 清理（读 settings 短锁 → 锁外清理）
            let state = app.state::<AppState>();
            let cache_mb = {
                let conn = state.db.lock().map_err(|_| AppError::msg("数据库锁中毒"));
                match conn {
                    Ok(c) => settings::get_settings(&c)
                        .ok()
                        .map(|s| s.thumbnail_cache_mb),
                    Err(_) => None,
                }
            };
            if let Some(max_mb) = cache_mb {
                if let Ok(thumbs) = ThumbnailService::new(&scope_dir) {
                    let _ = thumbs.cleanup_lru(max_mb);
                }
            }
            // R-22：启动时清理超期回收站（不常驻定时器；文件 IO 后台线程不堵启动）
            let trash_days = {
                let conn = state.db.lock().map_err(|_| AppError::msg("数据库锁中毒"));
                match conn {
                    Ok(c) => settings::get_settings(&c)
                        .ok()
                        .map(|s| s.trash_retention_days),
                    Err(_) => None,
                }
            };
            if let Some(days) = trash_days {
                if days > 0 {
                    let db = std::sync::Arc::clone(&state.db);
                    let dir = scope_dir.clone();
                    std::thread::spawn(move || {
                        if let Err(e) = commands::purge_expired_trash(&db, &dir, days) {
                            tracing::warn!("回收站自动清理失败: {e}");
                        }
                    });
                }
            }
            // 阶段 5 §8.2：应用重启时把遗留 processing 批次标记为 interrupted（可一键续跑）
            {
                let conn = state.db.lock().map_err(|_| AppError::msg("数据库锁中毒"));
                if let Ok(c) = conn {
                    if let Err(e) = db::ai::mark_interrupted_batches(&c) {
                        tracing::warn!("标记中断批次失败: {e}");
                    }
                }
            }
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
            // 超级搜索
            commands::ai_parse_search_query,
            // 入库
            commands::import_files,
            commands::inspect_import,
            commands::cancel_import,
            commands::preview_rename,
            // 标签
            commands::list_tags,
            commands::list_tag_facets,
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
            commands::ai_list_models,
            commands::ai_apply_tags,
            // Ollama 一键配置（方案 A2）+ 一键安装（方案 A3）
            commands::ollama_ping,
            commands::ollama_probe_hardware,
            commands::ollama_pull,
            commands::ollama_open_download_page,
            commands::ollama_install_status,
            commands::ollama_download_install,
            commands::ollama_start_service,
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
