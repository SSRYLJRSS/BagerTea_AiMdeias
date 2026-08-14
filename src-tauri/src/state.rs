//! 全局状态：单写连接 + WAL（架构共享知识 #9）
//! T03 扩展：数据目录（缩略图服务定位）+ 入库/导出取消标志
//! T04 修订：db / import_cancel 改 Arc，长任务命令 spawn_blocking 时可 Move 进工作线程

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};

use rusqlite::Connection;

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
}

impl AppState {
    pub fn new(conn: Connection, data_dir: PathBuf) -> Self {
        Self {
            db: Arc::new(Mutex::new(conn)),
            data_dir,
            import_cancel: Arc::new(AtomicBool::new(false)),
            export_cancel: Arc::new(Mutex::new(HashMap::new())),
            ai_cancel: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}
