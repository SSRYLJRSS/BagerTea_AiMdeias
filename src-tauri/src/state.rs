//! 全局状态：单写连接 + WAL（架构共享知识 #9）
//! T03 扩展：数据目录（缩略图服务定位）+ 入库/导出取消标志
//! T04 修订：db / import_cancel 改 Arc，长任务命令 spawn_blocking 时可 Move 进工作线程

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};

use rusqlite::Connection;

use crate::services::ollama_runtime::OllamaRuntimeState;

pub struct AppState {
    pub db: Arc<Mutex<Connection>>,
    /// 应用数据目录（$APP_DATA_DIR/bagertea_ai_media_v2）
    pub data_dir: PathBuf,
    /// 入库取消标志
    pub import_cancel: Arc<AtomicBool>,
    /// 导出任务取消标志注册表（task_id → flag）
    pub export_cancel: Arc<Mutex<HashMap<i64, Arc<AtomicBool>>>>,
    /// AI 批次取消标志注册表（batch_id → flag）
    pub ai_cancel: Arc<Mutex<HashMap<i64, Arc<AtomicBool>>>>,
    /// 媒体元数据回填任务取消标志（单槽，同一时刻一个回填）
    pub media_refill_cancel: Arc<AtomicBool>,
    /// 视频兼容代理取消标志注册表（"asset_id:variant" → flag）
    pub video_proxy_cancel: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>,
    /// Ollama 本地服务运行态（L2 ownership，§8.2）：External 永不停 / AppOwned 可停
    pub ollama_runtime: Arc<Mutex<OllamaRuntimeState>>,
}

impl AppState {
    pub fn new(conn: Connection, data_dir: PathBuf) -> Self {
        Self {
            db: Arc::new(Mutex::new(conn)),
            data_dir,
            import_cancel: Arc::new(AtomicBool::new(false)),
            export_cancel: Arc::new(Mutex::new(HashMap::new())),
            ai_cancel: Arc::new(Mutex::new(HashMap::new())),
            media_refill_cancel: Arc::new(AtomicBool::new(false)),
            video_proxy_cancel: Arc::new(Mutex::new(HashMap::new())),
            ollama_runtime: Arc::new(Mutex::new(OllamaRuntimeState::new())),
        }
    }
}
