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
    /// 代理生成时源素材的稳定指纹；旧记录为 None，必须重新生成。
    pub source_fingerprint: Option<String>,
    /// 代理编码策略版本；codec/码率/容器参数变化时递增。
    pub encoder_version: Option<i64>,
    /// FFmpeg 版本和目标二进制身份指纹。
    pub tool_fingerprint: Option<String>,
    /// 生成时源路径；路径变化时代理缓存失效。
    pub source_path: Option<String>,
}

/// 将 ready 代理的全部缓存有效性字段作为一组写入，避免遗漏其中任一输入身份。
pub struct ReadyFingerprint<'a> {
    pub source_path: &'a str,
    pub source_fingerprint: &'a str,
    pub encoder_version: i64,
    pub tool_fingerprint: &'a str,
}

/// 读取某个素材 + 变体的代理记录；不存在返回 None。
pub fn get(conn: &Connection, asset_id: i64, variant: &str) -> AppResult<Option<VideoProxy>> {
    Ok(conn
        .query_row(
            "SELECT asset_id, variant, status, path, error, updated_at,
                    source_fingerprint, encoder_version, tool_fingerprint, source_path
               FROM video_proxies WHERE asset_id=?1 AND variant=?2",
            params![asset_id, variant],
            |r| {
                Ok(VideoProxy {
                    asset_id: r.get(0)?,
                    variant: r.get(1)?,
                    status: r.get(2)?,
                    path: r.get(3)?,
                    error: r.get(4)?,
                    updated_at: r.get(5)?,
                    source_fingerprint: r.get(6)?,
                    encoder_version: r.get(7)?,
                    tool_fingerprint: r.get(8)?,
                    source_path: r.get(9)?,
                })
            },
        )
        .optional()?)
}

/// 写入 ready 状态并同时保存缓存有效性指纹。只有完成生成或验证为新鲜的文件才能调用。
pub fn upsert_ready(
    conn: &Connection,
    asset_id: i64,
    variant: &str,
    path: &str,
    fingerprint: &ReadyFingerprint<'_>,
) -> AppResult<()> {
    let now = chrono::Utc::now().timestamp_millis();
    conn.execute(
        "INSERT INTO video_proxies
           (asset_id, variant, status, path, error, created_at, updated_at,
            source_fingerprint, encoder_version, tool_fingerprint, source_path)
         VALUES (?1, ?2, 'ready', ?3, NULL, ?4, ?4, ?5, ?6, ?7, ?8)
         ON CONFLICT(asset_id, variant) DO UPDATE SET
           status='ready', path=excluded.path, error=NULL, updated_at=excluded.updated_at,
           source_fingerprint=excluded.source_fingerprint,
           encoder_version=excluded.encoder_version,
           tool_fingerprint=excluded.tool_fingerprint,
           source_path=excluded.source_path",
        params![
            asset_id,
            variant,
            path,
            now,
            fingerprint.source_fingerprint,
            fingerprint.encoder_version,
            fingerprint.tool_fingerprint,
            fingerprint.source_path,
        ],
    )?;
    Ok(())
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
        assert_eq!(p.source_fingerprint, None);

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

    #[test]
    fn ready_rows_persist_fingerprints_and_non_ready_updates_keep_them() {
        let c = init_memory().unwrap();
        c.execute(
            "INSERT INTO assets (file_path, file_name, file_ext, file_size, mime_type, created_at, modified_at)
             VALUES ('/v.mp4', 'v.mp4', 'mp4', 1, 'video/mp4', 1, 1)",
            [],
        )
        .unwrap();
        let id: i64 = c
            .query_row("SELECT id FROM assets", [], |r| r.get(0))
            .unwrap();

        upsert_ready(
            &c,
            id,
            "h264_mp4",
            "/proxy/v.mp4",
            &ReadyFingerprint {
                source_path: "/v.mp4",
                source_fingerprint: "source-fp",
                encoder_version: 3,
                tool_fingerprint: "tool-fp",
            },
        )
        .unwrap();
        let ready = get(&c, id, "h264_mp4").unwrap().unwrap();
        assert_eq!(ready.status, "ready");
        assert_eq!(ready.source_fingerprint.as_deref(), Some("source-fp"));
        assert_eq!(ready.encoder_version, Some(3));
        assert_eq!(ready.tool_fingerprint.as_deref(), Some("tool-fp"));
        assert_eq!(ready.source_path.as_deref(), Some("/v.mp4"));

        upsert(&c, id, "h264_mp4", "running", None, None).unwrap();
        let running = get(&c, id, "h264_mp4").unwrap().unwrap();
        assert_eq!(running.status, "running");
        assert_eq!(running.source_fingerprint.as_deref(), Some("source-fp"));
        assert_eq!(running.encoder_version, Some(3));
        assert_eq!(running.tool_fingerprint.as_deref(), Some("tool-fp"));
    }
}
