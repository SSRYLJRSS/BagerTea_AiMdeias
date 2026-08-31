//! 视频兼容代理缓存（指导书 §8.3）：按 素材 + 变体 记录生成/查询状态，不替换原文件。
//! 状态机：queued | running | ready | failed | canceled。代理失败原因可展示；清理缓存不影响原文件。

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::error::AppResult;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoProxy {
    pub asset_id: i64,
    pub variant: String,
    pub status: String,
    pub path: Option<String>,
    pub error: Option<String>,
    pub updated_at: i64,
}

/// 读取某个素材 + 变体的代理记录；不存在返回 None。
pub fn get(conn: &Connection, asset_id: i64, variant: &str) -> AppResult<Option<VideoProxy>> {
    Ok(conn
        .query_row(
            "SELECT asset_id, variant, status, path, error, updated_at FROM video_proxies WHERE asset_id=?1 AND variant=?2",
            params![asset_id, variant],
            |r| {
                Ok(VideoProxy {
                    asset_id: r.get(0)?,
                    variant: r.get(1)?,
                    status: r.get(2)?,
                    path: r.get(3)?,
                    error: r.get(4)?,
                    updated_at: r.get(5)?,
                })
            },
        )
        .optional()?)
}

/// 更新某个素材 + 变体的代理状态（insert 或 replace）。只短锁调用。
pub fn upsert(
    conn: &Connection,
    asset_id: i64,
    variant: &str,
    status: &str,
    path: Option<&str>,
    error: Option<&str>,
) -> AppResult<()> {
    let now = chrono::Utc::now().timestamp_millis();
    conn.execute(
        "INSERT INTO video_proxies (asset_id, variant, status, path, error, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)
         ON CONFLICT(asset_id, variant) DO UPDATE SET
           status=excluded.status, path=excluded.path, error=excluded.error, updated_at=excluded.updated_at",
        params![asset_id, variant, status, path, error, now],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::init_memory;

    #[test]
    fn upsert_and_get_roundtrip() {
        let c = init_memory().unwrap();
        // 需要一条 asset 记录（FK）
        c.execute(
            "INSERT INTO assets (file_path, file_name, file_ext, file_size, mime_type, created_at, modified_at)
             VALUES ('/v.mp4', 'v.mp4', 'mp4', 1, 'video/mp4', 1, 1)",
            [],
        )
        .unwrap();
        let asset_id = c
            .query_row("SELECT id FROM assets", [], |r| r.get(0))
            .unwrap();

        upsert(&c, asset_id, "h264_mp4", "running", None, None).unwrap();
        let p = get(&c, asset_id, "h264_mp4").unwrap().unwrap();
        assert_eq!(p.status, "running");
        assert_eq!(p.variant, "h264_mp4");

        upsert(
            &c,
            asset_id,
            "h264_mp4",
            "ready",
            Some("/proxy/v.mp4"),
            None,
        )
        .unwrap();
        let p = get(&c, asset_id, "h264_mp4").unwrap().unwrap();
        assert_eq!(p.status, "ready");
        assert_eq!(p.path.as_deref(), Some("/proxy/v.mp4"));
    }
}
