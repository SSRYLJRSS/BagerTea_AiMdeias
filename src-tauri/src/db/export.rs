//! 导出任务持久化（本地/网盘统一模型，断点续传基础）

use rusqlite::Connection;
use serde::{Deserialize, Serialize};

use crate::error::AppResult;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportTask {
    pub id: i64,
    pub target: String, // local|baidu|quark
    pub status: String, // pending|running|done|failed|cancelled
    pub total: i64,
    pub done: i64,
    pub dest_dir: Option<String>,
    pub share_url: Option<String>,
    pub error: Option<String>,
    pub created_at: i64,
    /// P1-04：status=done 时携带的软提示（如「N 个源文件未能清理」）；成功但有注意事项
    #[serde(default)]
    pub warning: Option<String>,
}

fn from_row(r: &rusqlite::Row) -> rusqlite::Result<ExportTask> {
    Ok(ExportTask {
        id: r.get(0)?,
        target: r.get(1)?,
        status: r.get(2)?,
        total: r.get(3)?,
        done: r.get(4)?,
        dest_dir: r.get(5)?,
        share_url: r.get(6)?,
        error: r.get(7)?,
        created_at: r.get(8)?,
        warning: r.get(9).unwrap_or(None),
    })
}

const COLS: &str =
    "id, target, status, total, done, dest_dir, share_url, error, created_at, warning";

pub fn create_task(
    conn: &Connection,
    target: &str,
    total: i64,
    dest_dir: Option<&str>,
    account_id: Option<i64>,
) -> AppResult<ExportTask> {
    let now = chrono::Utc::now().timestamp_millis();
    conn.execute(
        "INSERT INTO export_tasks (target, status, total, dest_dir, account_id, created_at)
         VALUES (?1, 'pending', ?2, ?3, ?4, ?5)",
        rusqlite::params![target, total, dest_dir, account_id, now],
    )?;
    get_task(conn, conn.last_insert_rowid())
}

pub fn get_task(conn: &Connection, id: i64) -> AppResult<ExportTask> {
    Ok(conn.query_row(
        &format!("SELECT {COLS} FROM export_tasks WHERE id = ?1"),
        [id],
        from_row,
    )?)
}

pub fn list_tasks(conn: &Connection) -> AppResult<Vec<ExportTask>> {
    let mut stmt = conn.prepare(&format!("SELECT {COLS} FROM export_tasks ORDER BY id DESC"))?;
    let rows = stmt
        .query_map([], from_row)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

pub fn update_progress(conn: &Connection, id: i64, done: i64, status: &str) -> AppResult<()> {
    conn.execute(
        "UPDATE export_tasks SET done = ?1, status = ?2 WHERE id = ?3",
        rusqlite::params![done, status, id],
    )?;
    Ok(())
}

pub fn finish_task(
    conn: &Connection,
    id: i64,
    status: &str,
    share_url: Option<&str>,
    error: Option<&str>,
) -> AppResult<()> {
    conn.execute(
        "UPDATE export_tasks SET status = ?1, share_url = ?2, error = ?3, warning = NULL WHERE id = ?4",
        rusqlite::params![status, share_url, error, id],
    )?;
    Ok(())
}

/// P1-04：任务「成功但带注意事项」——status 置 done，warning 列写入软提示，
/// error 列保持 NULL（区别于失败），前端可据此展示「完成但请留意」消息
pub fn finish_task_with_warning(conn: &Connection, id: i64, warning: &str) -> AppResult<()> {
    conn.execute(
        "UPDATE export_tasks SET status = 'done', share_url = NULL, error = NULL, warning = ?1 WHERE id = ?2",
        rusqlite::params![warning, id],
    )?;
    Ok(())
}
