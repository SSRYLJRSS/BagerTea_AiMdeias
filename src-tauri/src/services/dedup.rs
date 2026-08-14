//! 去重判定（路径唯一由 assets.file_path UNIQUE 另保）：
//! hash 计算一次、判定一次、入库时写回 assets.hash —— 三步均在 importer 内串联。

use rusqlite::Connection;

use crate::db::assets;
use crate::error::AppResult;

/// 库内是否已存在相同 hash 的素材
pub fn hash_exists(conn: &Connection, hash: &str) -> AppResult<bool> {
    assets::hash_exists(conn, hash)
}
