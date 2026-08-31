//! W5c 备份/恢复（指导书 §W5c）
//! 备份：`VACUUM INTO` 单文件快照（自动合并 WAL，与库同盘建议由前端 save 对话框提示）。
//! 恢复：只读连接校验（quick_check + user_version + 关键表）→ 运行中任务阻断在命令层
//! → 现库改名 `.old` 保底 → 覆盖 → `db::init` 走迁移升级 → 热替换连接后立即 restart。
//! 不做运行中热替换全局服务（指导书已拒绝）：换连接只是衔接 restart 的必要步骤。

use std::path::Path;

use rusqlite::Connection;

use crate::error::{AppError, AppResult};

/// 当前库结构版本（migrate 链尾）。恢复校验只拒绝**高于**此版本的备份；
/// 老备份恢复后由 db::init 自动迁移升级。
pub const LATEST_VERSION: i64 = 21;

/// 恢复校验必须存在的关键表（防「中途崩溃的库备份」——quick_check 通过不代表结构完整）
const REQUIRED_TABLES: [&str; 4] = ["assets", "tags", "tag_facets", "assets_fts"];

/// 备份到目标路径。调用方持库锁调用（VACUUM INTO 需要一致的快照点）。
pub fn backup_to(conn: &Connection, target: &Path) -> AppResult<()> {
    if target.exists() {
        return Err(AppError::msg("目标文件已存在，请换一个文件名"));
    }
    conn.execute(
        "VACUUM INTO ?1",
        [target.to_string_lossy().as_ref()],
    )
    .map_err(|e| AppError::msg(format!("备份失败：{e}")))?;
    Ok(())
}

/// 只读打开备份文件做恢复前校验，返回备份的 user_version。
/// 用读写方式打开：FTS5 的 quick_check 索引校验在只读连接上会报
/// "attempt to write a readonly database"（实测），误把好备份判成损坏。
pub fn validate_backup(path: &Path) -> AppResult<i64> {
    if !path.is_file() {
        return Err(AppError::msg("备份文件不存在"));
    }
    let conn = Connection::open(path).map_err(|e| AppError::msg(format!("备份文件无法打开：{e}")))?;
    let status: String = conn
        .query_row("PRAGMA quick_check", [], |r| r.get(0))
        .map_err(|e| AppError::msg(format!("备份完整性检查失败：{e}")))?;
    if status != "ok" {
        return Err(AppError::msg(format!(
            "备份文件损坏（quick_check：{status}），已取消恢复。请换用其他备份"
        )));
    }
    let version: i64 = conn
        .query_row("PRAGMA user_version", [], |r| r.get(0))
        .map_err(|e| AppError::msg(format!("读取备份版本失败：{e}")))?;
    if version > LATEST_VERSION {
        return Err(AppError::msg(format!(
            "备份来自更新版本的软件（库版本 {version} > 当前 {LATEST_VERSION}），请先升级软件再恢复"
        )));
    }
    for table in REQUIRED_TABLES {
        let n: i64 = conn.query_row(
            "SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
            [table],
            |r| r.get(0),
        )?;
        if n == 0 {
            return Err(AppError::msg(format!(
                "备份缺少关键表 {table}（可能是中途崩溃产生的不完整备份），已取消恢复"
            )));
        }
    }
    Ok(version)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::init_memory;

    #[test]
    fn vacuum_into_creates_restorable_snapshot() {
        let conn = init_memory().unwrap();
        conn.execute(
            "INSERT INTO assets (file_path, file_name, file_ext, file_size, mime_type, created_at, modified_at, hash)
             VALUES ('a.jpg', 'a.jpg', '.jpg', 1, 'image/jpeg', 0, 0, 'h1')",
            [],
        )
        .unwrap();
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("snap.db");
        backup_to(&conn, &target).unwrap();
        assert_eq!(validate_backup(&target).unwrap(), LATEST_VERSION);
        // 快照内容完整：能读回资产行
        let snap = Connection::open(&target).unwrap();
        let n: i64 = snap.query_row("SELECT count(*) FROM assets", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 1);
    }

    #[test]
    fn backup_rejects_existing_target() {
        let conn = init_memory().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("snap.db");
        std::fs::write(&target, b"x").unwrap();
        assert!(backup_to(&conn, &target).is_err());
    }

    #[test]
    fn validate_rejects_garbage_file() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("bad.db");
        std::fs::write(&target, b"not a sqlite file at all").unwrap();
        assert!(validate_backup(&target).is_err());
    }

    #[test]
    fn validate_rejects_future_version() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("future.db");
        let conn = init_memory().unwrap();
        conn.execute("VACUUM INTO ?1", [target.to_string_lossy().as_ref()])
            .unwrap();
        let snap = Connection::open(&target).unwrap();
        snap.pragma_update(None, "user_version", LATEST_VERSION + 1).unwrap();
        drop(snap);
        let err = validate_backup(&target).unwrap_err();
        assert!(err.to_string().contains("更新版本"), "{err}");
    }

    #[test]
    fn validate_rejects_missing_key_table() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("incomplete.db");
        let conn = Connection::open(&target).unwrap();
        conn.execute_batch("CREATE TABLE assets (id INTEGER PRIMARY KEY); PRAGMA user_version = 21;")
            .unwrap();
        drop(conn);
        let err = validate_backup(&target).unwrap_err();
        assert!(err.to_string().contains("关键表"), "{err}");
    }

    #[test]
    fn validate_rejects_corrupt_but_real_sqlite() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("corrupt.db");
        let conn = init_memory().unwrap();
        conn.execute("VACUUM INTO ?1", [target.to_string_lossy().as_ref()])
            .unwrap();
        drop(conn);
        // 截断文件（丢掉后半段页）→ 页数与实际大小不一致 → quick_check 报损坏
        let bytes = std::fs::read(&target).unwrap();
        std::fs::write(&target, &bytes[..bytes.len() / 2]).unwrap();
        let err = validate_backup(&target).unwrap_err();
        assert!(
            err.to_string().contains("损坏") || err.to_string().contains("完整性"),
            "{err}"
        );
    }
}
