//! 数据层入口：连接初始化（WAL + foreign_keys + cjk_bigram 注册 + 迁移）

pub mod ai;
pub mod asset_tags;
pub mod assets;
pub mod cloud;
pub mod dedup;
pub mod export;
pub mod migrations;
pub mod search;
pub mod settings;
pub mod tag_ops;
pub mod tags;

use std::path::Path;

use rusqlite::Connection;

use crate::error::AppResult;
use crate::utils::bigram;

fn configure(conn: &Connection) -> AppResult<()> {
    // CASCADE 删除依赖外键开关（rusqlite 默认关闭）
    conn.pragma_update(None, "foreign_keys", true)?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    bigram::register(conn)?;
    Ok(())
}

/// 打开（必要时创建）指定路径的库并完成迁移
pub fn init(path: &Path) -> AppResult<Connection> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let conn = Connection::open(path)?;
    configure(&conn)?;
    migrations::migrate(&conn)?;
    Ok(conn)
}

/// 内存库（单元测试用）
pub fn init_memory() -> AppResult<Connection> {
    let conn = Connection::open_in_memory()?;
    configure(&conn)?;
    migrations::migrate(&conn)?;
    Ok(conn)
}
