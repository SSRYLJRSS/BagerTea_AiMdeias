//! 全局状态：单写连接 + WAL（架构共享知识 #9）
//! T03 扩展：数据目录（缩略图服务定位）+ 入库/导出取消标志
//! T04 修订：db / import_cancel 改 Arc，长任务命令 spawn_blocking 时可 Move 进工作线程

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};

use rusqlite::Connection;

use crate::db::schema_features::SchemaFeatureStatus;
use crate::services::ollama_runtime::OllamaRuntimeState;

pub struct AppState {
    pub db: Arc<Mutex<Connection>>,
    /// 应用数据目录（$APP_DATA_DIR/bagertea_ai_media_v2）
    pub data_dir: PathBuf,
    /// 入库取消标志
    pub import_cancel: Arc<AtomicBool>,
    /// W5c：入库进行中标志（restore_db 用它阻断恢复；取消标志语义不同，不能复用）
    pub import_running: Arc<AtomicBool>,
    /// 导出任务取消标志注册表（task_id → flag）
    pub export_cancel: Arc<Mutex<HashMap<i64, Arc<AtomicBool>>>>,
    /// AI 批次取消标志注册表（batch_id → flag）
    pub ai_cancel: Arc<Mutex<HashMap<i64, Arc<AtomicBool>>>>,
    /// 媒体元数据回填任务取消标志（单槽，同一时刻一个回填）
    pub media_refill_cancel: Arc<AtomicBool>,
    /// 回填类长任务互斥闸（元数据回填 / 色板回算共用一条，同一时刻只允许一个）。
    /// 不拆成两个取消标志：两者都吃解码许可与 DB 锁，并发只会互相拖慢（FX-12）。
    pub refill_running: Arc<AtomicBool>,
    /// 视频兼容代理取消标志注册表（"asset_id:variant" → flag）
    pub video_proxy_cancel: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>,
    /// Ollama 本地服务运行态（L2 ownership，§8.2）：External 永不停 / AppOwned 可停
    pub ollama_runtime: Arc<Mutex<OllamaRuntimeState>>,
    /// F1-e：schema_features 缓存（启动读一次，apply_tag_constraints 后刷新）。
    /// 命令层读它判断 tag_unique_terms 等能力是否生效（设置页展示 + feature gate）。
    pub schema_features: Arc<Mutex<Vec<SchemaFeatureStatus>>>,
}

impl AppState {
    pub fn new(conn: Connection, data_dir: PathBuf) -> Self {
        Self {
            db: Arc::new(Mutex::new(conn)),
            data_dir,
            import_cancel: Arc::new(AtomicBool::new(false)),
            import_running: Arc::new(AtomicBool::new(false)),
            export_cancel: Arc::new(Mutex::new(HashMap::new())),
            ai_cancel: Arc::new(Mutex::new(HashMap::new())),
            media_refill_cancel: Arc::new(AtomicBool::new(false)),
            refill_running: Arc::new(AtomicBool::new(false)),
            video_proxy_cancel: Arc::new(Mutex::new(HashMap::new())),
            ollama_runtime: Arc::new(Mutex::new(OllamaRuntimeState::new())),
            schema_features: Arc::new(Mutex::new(Vec::new())),
        }
    }

    /// F1-e：从库刷新 schema_features 缓存（启动 / apply_tag_constraints 后调用）。
    pub fn refresh_schema_features(&self) {
        let snapshot = {
            let lock = self
                .db
                .lock()
                .map_err(|_| crate::error::AppError::msg("数据库锁中毒"));
            match lock {
                Ok(conn) => crate::db::schema_features::list_features(&conn).ok(),
                Err(_) => None,
            }
        };
        if let Some(list) = snapshot {
            if let Ok(mut cache) = self.schema_features.lock() {
                *cache = list;
            }
        }
    }
}
