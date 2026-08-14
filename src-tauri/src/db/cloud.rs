//! 网盘账号绑定（P1 二期；token/cookie 本地存储，架构 §5.6）

use rusqlite::Connection;
use serde::{Deserialize, Serialize};

use crate::error::AppResult;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudAccount {
    pub id: i64,
    pub provider: String, // baidu|quark
    pub name: String,
    pub bound: bool,
    pub expires_at: Option<i64>,
}

fn from_row(r: &rusqlite::Row) -> rusqlite::Result<CloudAccount> {
    Ok(CloudAccount {
        id: r.get(0)?,
        provider: r.get(1)?,
        name: r.get::<_, Option<String>>(2)?.unwrap_or_default(),
        bound: true,
        expires_at: r.get(3)?,
    })
}

const COLS: &str = "id, provider, name, expires_at";

pub fn list_accounts(conn: &Connection) -> AppResult<Vec<CloudAccount>> {
    let mut stmt = conn.prepare(&format!("SELECT {COLS} FROM cloud_accounts ORDER BY id"))?;
    let rows = stmt
        .query_map([], from_row)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

pub fn bind(
    conn: &Connection,
    provider: &str,
    name: &str,
    access_token: Option<&str>,
    refresh_token: Option<&str>,
    cookie: Option<&str>,
    expires_at: Option<i64>,
) -> AppResult<i64> {
    let now = chrono::Utc::now().timestamp_millis();
    conn.execute(
        "INSERT INTO cloud_accounts (provider, name, access_token, refresh_token, cookie, expires_at, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        rusqlite::params![provider, name, access_token, refresh_token, cookie, expires_at, now],
    )?;
    Ok(conn.last_insert_rowid())
}

pub fn unbind(conn: &Connection, id: i64) -> AppResult<()> {
    conn.execute("DELETE FROM cloud_accounts WHERE id = ?1", [id])?;
    Ok(())
}

/// 网盘账号凭证（M2 导出服务用）
pub struct Credentials {
    pub provider: String,
    pub access_token: Option<String>,
    pub refresh_token: Option<String>,
    pub cookie: Option<String>,
}

/// 取凭证（导出服务内部用）
pub fn get_credentials(conn: &Connection, id: i64) -> AppResult<Credentials> {
    Ok(conn.query_row(
        "SELECT provider, access_token, refresh_token, cookie FROM cloud_accounts WHERE id = ?1",
        [id],
        |r| {
            Ok(Credentials {
                provider: r.get(0)?,
                access_token: r.get(1)?,
                refresh_token: r.get(2)?,
                cookie: r.get(3)?,
            })
        },
    )?)
}
