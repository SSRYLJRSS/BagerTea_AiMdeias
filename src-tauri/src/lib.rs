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
    if let Err(e) = db::tags::seed_presets(&conn) {
        tracing::warn!("预置标签播种失败: {e}");
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
            if let Err(e) = app.asset_protocol_scope().allow_directory(&thumbs_dir, true) {
                tracing::warn!("asset 协议放行缩略图目录失败: {e}");
            }
            if let Err(e) = app.asset_protocol_scope().allow_directory(&previews_dir, true) {
                tracing::warn!("asset 协议放行预览目录失败: {e}");
            }
            // B05：启动时执行一次 LRU 清理（读 settings 短锁 → 锁外清理）
            let state = app.state::<AppState>();
            let cache_mb = {
                let conn = state.db.lock().map_err(|_| AppError::msg("数据库锁中毒"));
                match conn {
                    Ok(c) => settings::get_settings(&c).ok().map(|s| s.thumbnail_cache_mb),
                    Err(_) => None,
                }
            };
            if let Some(max_mb) = cache_mb {
                if let Ok(thumbs) = ThumbnailService::new(&scope_dir) {
                    let _ = thumbs.cleanup_lru(max_mb);
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
            commands::get_asset,
            commands::delete_assets,
            commands::get_asset_urls,
            commands::reveal_in_folder,
            // 入库
            commands::import_files,
            commands::inspect_import,
            commands::cancel_import,
            // 标签
            commands::list_tags,
            commands::create_tag,
            commands::update_tag,
            commands::delete_tag,
            commands::assign_tags,
            commands::remove_tags,
            commands::get_asset_tags,
            // 缩略图
            commands::get_thumbnail,
            commands::clear_thumbnail_cache,
            commands::get_preview,
            // 导出
            commands::export_local_files,
            commands::list_export_tasks,
            commands::cancel_export,
            // AI 打标
            commands::ai_create_batch,
            commands::ai_start_batch,
            commands::ai_cancel_batch,
            commands::ai_list_batches,
            commands::ai_list_suggestions,
            commands::ai_confirm_suggestion,
            commands::ai_reject_suggestion,
            commands::ai_restore_suggestion,
            commands::ai_confirm_all,
            commands::ai_list_models,
            commands::ai_apply_tags,
            // 设置
            commands::get_settings,
            commands::save_settings,
            commands::get_data_dir,
            commands::open_data_dir,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
