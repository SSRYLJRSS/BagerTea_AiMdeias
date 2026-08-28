//! 媒体元数据后台回填（指导书 §7.5）：对批量素材「重新读取媒体属性」，可取消、可失败隔离、有进度。
//! 探测在锁外进行（ffprobe/图片解码不持 DB 锁）；只对单行做短锁回写。
//! 单个坏文件不回退整个批次（记录 metadata_error）。

use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use rusqlite::Connection;
use serde::Serialize;

use super::{exif_meta, video};
use crate::db::assets::{self, Asset, MediaProbeUpdate};
use crate::error::{AppError, AppResult};

/// 一次探测的归一化结果（图片/视频共用）。error 非空 = 读取失败（可辨识原因）。
#[derive(Debug, Default, Clone)]
pub struct MediaMetadata {
    pub media_kind: String,
    pub width: Option<i64>,
    pub height: Option<i64>,
    pub duration_ms: Option<i64>,
    pub video_codec: Option<String>,
    pub audio_codec: Option<String>,
    pub container_format: Option<String>,
    pub video_profile: Option<String>,
    pub pixel_format: Option<String>,
    pub frame_rate: Option<f64>,
    pub rotation: Option<i64>,
    pub media_metadata_json: Option<String>,
    pub camera: Option<String>,
    pub lens: Option<String>,
    pub iso: Option<i64>,
    pub aperture: Option<f64>,
    pub shutter: Option<String>,
    pub focal: Option<f64>,
    pub taken_at: Option<i64>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RefillProgress {
    pub done: i64,
    pub total: i64,
    pub success: i64,
    pub failed: i64,
    pub skipped: i64,
    pub current_id: i64,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RefillSummary {
    pub total: i64,
    pub success: i64,
    pub failed: i64,
    pub skipped: i64,
}

/// 探测单个素材（视频走 ffprobe；图片读尺寸 + EXIF；其余无法识别 → error）。
pub fn probe_asset(asset: &Asset) -> MediaMetadata {
    if asset.mime_type.starts_with("video/") {
        match video::probe(Path::new(&asset.file_path)) {
            Ok(vm) => MediaMetadata {
                media_kind: "video".into(),
                width: vm.width,
                height: vm.height,
                duration_ms: vm.duration_ms,
                video_codec: vm.video_codec,
                audio_codec: vm.audio_codec,
                container_format: vm.container_format,
                video_profile: vm.video_profile,
                pixel_format: vm.pixel_format,
                frame_rate: vm.frame_rate,
                rotation: vm.rotation,
                media_metadata_json: vm.raw_json,
                error: None,
                ..Default::default()
            },
            Err(e) => MediaMetadata {
                media_kind: "video".into(),
                error: Some(e.to_string()),
                ..Default::default()
            },
        }
    } else if asset.mime_type.starts_with("image/") {
        let mut m = MediaMetadata {
            media_kind: "image".into(),
            ..Default::default()
        };
        if let Ok((w, h)) = image::image_dimensions(Path::new(&asset.file_path)) {
            m.width = Some(w as i64);
            m.height = Some(h as i64);
        }
        let ex = exif_meta::extract(Path::new(&asset.file_path));
        m.camera = ex.camera;
        m.lens = ex.lens;
        m.iso = ex.iso;
        m.aperture = ex.aperture;
        m.shutter = ex.shutter;
        m.focal = ex.focal;
        m.taken_at = ex.taken_at;
        if m.width.is_none() {
            m.error = Some("无法读取图片尺寸".into());
        }
        m
    } else {
        MediaMetadata {
            media_kind: "unknown".into(),
            error: Some("无法识别的媒体类型".into()),
            ..Default::default()
        }
    }
}

fn to_probe_update(m: &MediaMetadata) -> MediaProbeUpdate {
    MediaProbeUpdate {
        media_kind: Some(m.media_kind.clone()),
        width: m.width,
        height: m.height,
        duration_ms: m.duration_ms,
        video_codec: m.video_codec.clone(),
        audio_codec: m.audio_codec.clone(),
        container_format: m.container_format.clone(),
        video_profile: m.video_profile.clone(),
        pixel_format: m.pixel_format.clone(),
        frame_rate: m.frame_rate,
        rotation: m.rotation,
        media_metadata_json: m.media_metadata_json.clone(),
        metadata_version: if m.error.is_none() { Some(1) } else { None },
        error: m.error.clone(),
    }
}

/// 对一组素材做回填（可注入 probe 以便单测）。取消检查在每个素材之间。
/// 探测在锁外进行：每行只短暂加锁读素材 + 回写结果，ffprobe/图片解码不持 DB 锁。
/// 单个素材失败不终止整个批次：记录 metadata_error，计入 failed。
pub fn rescan_assets_with(
    db: &Arc<Mutex<Connection>>,
    asset_ids: &[i64],
    cancel: &AtomicBool,
    probe: impl Fn(&Asset) -> MediaMetadata,
    mut on_progress: impl FnMut(&RefillProgress),
) -> AppResult<RefillSummary> {
    let mut summary = RefillSummary {
        total: asset_ids.len() as i64,
        ..Default::default()
    };
    for (i, &id) in asset_ids.iter().enumerate() {
        if cancel.load(Ordering::Relaxed) {
            break;
        }
        // 短锁读素材
        let asset = {
            let conn = db.lock().map_err(|_| AppError::msg("数据库锁中毒"))?;
            assets::get(&conn, id).ok() // 素材被删/不可读 → skipped
        };
        let Some(asset) = asset else {
            summary.skipped += 1;
            continue;
        };
        let meta = probe(&asset); // 锁外探测（ffprobe / 图片解码）
        let update = to_probe_update(&meta);
        let ok = {
            let conn = db.lock().map_err(|_| AppError::msg("数据库锁中毒"))?;
            let r = assets::update_media_metadata(&conn, id, &update).is_ok();
            if r && meta.error.is_none() && meta.media_kind == "image" {
                let ex = assets::ExifPatch {
                    camera: meta.camera.as_deref(),
                    lens: meta.lens.as_deref(),
                    iso: meta.iso,
                    aperture: meta.aperture,
                    shutter: meta.shutter.as_deref(),
                    focal: meta.focal,
                    taken_at: meta.taken_at,
                };
                let _ = assets::set_exif(&conn, id, &ex);
            }
            r
        };
        if ok {
            if meta.error.is_none() {
                summary.success += 1;
            } else {
                summary.failed += 1;
            }
        } else {
            summary.failed += 1;
        }
        on_progress(&RefillProgress {
            done: (i + 1) as i64,
            total: summary.total,
            success: summary.success,
            failed: summary.failed,
            skipped: summary.skipped,
            current_id: id,
        });
    }
    Ok(summary)
}

/// 实际回填：用 `probe_asset` 探测（ffprobe / 图片解码，需真实文件）。
pub fn rescan_assets(
    db: &Arc<Mutex<Connection>>,
    asset_ids: &[i64],
    cancel: &AtomicBool,
    on_progress: impl FnMut(&RefillProgress),
) -> AppResult<RefillSummary> {
    rescan_assets_with(db, asset_ids, cancel, probe_asset, on_progress)
}

/// FB2-08（§14.6/14.7）：存量色板回算。复用 rescan_assets_with 的骨架（短锁读/写 + 取消 + 进度）。
/// 取材：placeholder（256px 入库即生成）优先，其次 hd 缩略图，最次原图；全都不行则该行 failed。
/// 色板为空（如全黑图极端像素丢光）→ 计 skipped、不覆盖；成功写入 palette_json + dominant_*。
pub fn rescan_assets_palette(
    db: &Arc<Mutex<Connection>>,
    asset_ids: &[i64],
    cancel: &AtomicBool,
    mut on_progress: impl FnMut(&RefillProgress),
) -> AppResult<RefillSummary> {
    const PALETTE_VERSION: i64 = 1;
    let lock = || db.lock().map_err(|_| crate::error::AppError::msg("数据库锁中毒"));
    let mut summary = RefillSummary {
        total: asset_ids.len() as i64,
        ..Default::default()
    };
    for (i, &id) in asset_ids.iter().enumerate() {
        if cancel.load(Ordering::Relaxed) {
            break;
        }
        let asset = {
            let conn = lock()?;
            assets::get(&conn, id).ok()
        };
        let Some(asset) = asset else {
            summary.skipped += 1;
            continue;
        };
        // 取材路径（§14.6）
        let src = asset
            .placeholder_path
            .as_deref()
            .map(std::path::PathBuf::from)
            .or_else(|| asset.hd_thumbnail_path.as_deref().map(std::path::PathBuf::from))
            .unwrap_or_else(|| std::path::PathBuf::from(&asset.file_path));

        // 锁外计算（解码走 imaging::decode_thumb；acquire 取全局并发闸）
        let palette = {
            let _permit = crate::services::imaging::acquire();
            crate::services::imaging::decode_thumb(&src, 100)
                .map(|img| crate::services::palette::compute_palette(&img))
        };

        let ok = match palette {
            Some(palette) if !palette.is_empty() => {
                let entries: Vec<serde_json::Value> = palette
                    .iter()
                    .map(|e| {
                        serde_json::json!({
                            "hex": e.hex, "r": e.r, "g": e.g, "b": e.b, "ratio": e.ratio
                        })
                    })
                    .collect();
                let json = serde_json::to_string(&entries).unwrap_or_else(|_| "[]".to_string());
                let p0 = &palette[0];
                let (hue, sat, lum) = crate::services::palette::dominant_from_rgb(p0.r, p0.g, p0.b);
                let conn = lock()?;
                assets::set_palette(&conn, id, &json, PALETTE_VERSION, hue, sat, lum).is_ok()
            }
            // 色板为空（全黑/全白被丢光）或解码失败 → 未计算，不覆盖
            _ => false,
        };
        if ok {
            summary.success += 1;
        } else {
            summary.failed += 1;
        }
        on_progress(&RefillProgress {
            done: (i + 1) as i64,
            total: summary.total,
            success: summary.success,
            failed: summary.failed,
            skipped: summary.skipped,
            current_id: id,
        });
    }
    Ok(summary)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::init_memory;

    fn db() -> Arc<Mutex<Connection>> {
        Arc::new(Mutex::new(init_memory().unwrap()))
    }

    fn insert_asset(c: &Connection, id_name: &str, mime: &str, duration: Option<i64>) -> i64 {
        c.execute(
            "INSERT INTO assets (file_path, file_name, file_ext, file_size, mime_type, duration_ms, created_at, modified_at)
             VALUES (?1, ?2, ?3, 100, ?4, ?5, 1, 1)",
            rusqlite::params![id_name, "a", "mp4", mime, duration],
        )
        .unwrap();
        c.query_row("SELECT id FROM assets WHERE file_path=?1", [id_name], |r| r.get(0))
            .unwrap()
    }

    #[test]
    fn list_video_ids_needing_metadata_only_videos() {
        let db = db();
        let c = db.lock().unwrap();
        let vid = insert_asset(&c, "/v1.mp4", "video/mp4", None); // 缺 metadata
        let vid2 = insert_asset(&c, "/v2.mp4", "video/mp4", Some(5000)); // 已有 duration 但 video_codec=null
        let img = insert_asset(&c, "/i.jpg", "image/jpeg", None);
        let ids = assets::list_video_ids_needing_metadata(&c).unwrap();
        assert!(ids.contains(&vid));
        assert!(ids.contains(&vid2));
        assert!(!ids.contains(&img));
    }

    #[test]
    fn rescan_success_and_failed_counting() {
        let db = db();
        let c = db.lock().unwrap();
        let vid = insert_asset(&c, "/v1.mp4", "video/mp4", None);
        let img = insert_asset(&c, "/i.jpg", "image/jpeg", None);
        let ids = vec![vid, img];
        drop(c);
        let cancel = AtomicBool::new(false);
        // 注入 probe：video 模拟成功有 duration，图片模拟失败
        let summary = rescan_assets_with(&db, &ids, &cancel, |a| {
            if a.mime_type.starts_with("video/") {
                MediaMetadata { media_kind: "video".into(), duration_ms: Some(12345), width: Some(1920), height: Some(1080), error: None, ..Default::default() }
            } else {
                MediaMetadata { media_kind: "image".into(), error: Some("图片损坏".into()), ..Default::default() }
            }
        }, |_| {}).unwrap();
        assert_eq!(summary.total, 2);
        assert_eq!(summary.success, 1);
        assert_eq!(summary.failed, 1);
        assert_eq!(summary.skipped, 0);
        // 视频写回持久化
        let c = db.lock().unwrap();
        let a = assets::get(&c, vid).unwrap();
        assert_eq!(a.duration_ms, Some(12345));
        assert_eq!(a.media_kind.as_deref(), Some("video"));
        assert_eq!(a.metadata_error.as_deref(), None);
        // 图片写回失败原因
        let b = assets::get(&c, img).unwrap();
        assert_eq!(b.metadata_error.as_deref(), Some("图片损坏"));
    }

    #[test]
    fn cancel_stops_after_current() {
        let db = db();
        let c = db.lock().unwrap();
        let a = insert_asset(&c, "/v1.mp4", "video/mp4", None);
        let b = insert_asset(&c, "/v2.mp4", "video/mp4", None);
        let ids = vec![a, b];
        drop(c);
        let cancel = AtomicBool::new(false);
        let mut calls = 0;
        let summary = rescan_assets_with(&db, &ids, &cancel, |_| {
            cancel.store(true, Ordering::Relaxed); // 处理第一个后即取消
            MediaMetadata { media_kind: "video".into(), duration_ms: Some(1), error: None, ..Default::default() }
        }, |_| calls += 1).unwrap();
        // 取消后只探了第一个
        assert_eq!(summary.success, 1);
        assert_eq!(calls, 1);
    }
}
