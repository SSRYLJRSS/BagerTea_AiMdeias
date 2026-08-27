//! 双层缩略图（架构 §1.6）：
//! 占位层 = 入库时生成（256px webp；视频抽帧；HEIC/解码失败 → 通用类型占位图，网格永不空白）；
//! 高清层 = 浏览可见区按需生成（512px webp / 视频封面帧）并缓存，LRU 清理。
//! 注：EXIF 内嵌缩略图快速通道已评估放弃（kamadak-exif 不提供字节提取，需手解 TIFF 段，
//! 性价比低；image crate 直接解码缩到 256px 实测可接受）——决策日志 2026-08-08。

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use image::ImageEncoder;
use rusqlite::Connection;

use super::{imaging, video};
use crate::db::assets;
use crate::error::{AppError, AppResult};

pub const PLACEHOLDER_SIZE: u32 = 256;
pub const HD_SIZE: u32 = 512;

/// B05：hd 缩略图生成计数器，每 LRU_CHECK_INTERVAL 次触发一次 LRU 清理
static HD_GEN_COUNT: AtomicU64 = AtomicU64::new(0);
const LRU_CHECK_INTERVAL: u64 = 100;

#[derive(Debug, Clone)]
pub struct ThumbnailService {
    placeholder_dir: PathBuf,
    hd_dir: PathBuf,
}

impl ThumbnailService {
    pub fn new(data_dir: &Path) -> AppResult<Self> {
        let svc = Self {
            placeholder_dir: data_dir.join("thumbnails").join("placeholder"),
            hd_dir: data_dir.join("thumbnails").join("hd"),
        };
        fs::create_dir_all(&svc.placeholder_dir)?;
        fs::create_dir_all(&svc.hd_dir)?;
        Ok(svc)
    }

    pub fn placeholder_path(&self, asset_id: i64) -> PathBuf {
        self.placeholder_dir.join(format!("{asset_id}.webp"))
    }

    // ── 占位层 ──

    /// 提取/生成占位图（永不失败：全链路失败 → 通用类型占位图）
    pub fn extract_placeholder(&self, asset_id: i64, src: &Path, mime_type: &str) -> PathBuf {
        let out = self.placeholder_path(asset_id);
        if out.exists() {
            return out;
        }
        let ok = if mime_type.starts_with("image/") {
            imaging::write_thumb(src, &out, PLACEHOLDER_SIZE)
        } else if mime_type.starts_with("video/") {
            let _permit = imaging::acquire();
            video::extract_frame(src, 0, &out, PLACEHOLDER_SIZE)
        } else {
            false
        };
        if !ok {
            Self::write_generic(&out, mime_type.starts_with("video/"));
        }
        out
    }

    // ── 高清层 ──

    /// 获取或按需生成高清缩略图；命中缓存直接返回（调用方负责回填/已回填 hd_thumbnail_path）
    /// 注意：解码全尺寸大图是重活，全局串行闸防止滚动时几十个并发解码打爆 CPU/内存
    /// 取/生成高清缩略图。DB 锁只在读行/写路径时短暂持有，
    /// 解码期间释放（否则排队生成会饿死列表/打标等一切 DB 请求）
    pub fn get_or_create_hd(
        &self,
        db: &std::sync::Arc<std::sync::Mutex<Connection>>,
        asset_id: i64,
        size: Option<u32>,
    ) -> AppResult<PathBuf> {
        // 并发由 imaging 全局信号量控制（4 许可）；同一 asset 重复生成无害（同产物）
        // 短暂读库（排队期间可能已被前一个任务生成）
        let (asset, out) = {
            let conn = db.lock().map_err(|_| AppError::msg("数据库锁中毒"))?;
            let asset = assets::get(&conn, asset_id)?;
            let size = size.unwrap_or(HD_SIZE);
            let out = if asset.mime_type.starts_with("video/") {
                self.hd_dir.join(format!("{asset_id}_cover.jpg"))
            } else {
                self.hd_dir.join(format!("{asset_id}_{size}.webp"))
            };
            (asset, out)
        }; // 此处释放 DB 锁
        if out.exists() {
            return Ok(out);
        }
        let src = Path::new(&asset.file_path);
        let ok = if asset.mime_type.starts_with("video/") {
            let _permit = imaging::acquire();
            let t = asset.duration_ms.map(|d| d / 10).unwrap_or(0);
            video::extract_frame(src, t, &out, size.unwrap_or(HD_SIZE))
        } else {
            imaging::write_thumb(src, &out, size.unwrap_or(HD_SIZE))
        };
        if ok {
            // B05：回写 hd 路径（短锁）+ 节流触发 LRU 清理（先读 settings 短锁，再锁外清理）
            let cleanup_mb = {
                let conn = db.lock().map_err(|_| AppError::msg("数据库锁中毒"))?;
                assets::set_hd_thumbnail_path(&conn, asset_id, &out.to_string_lossy())?;
                // B05：每生成 100 张触发一次 LRU 清理
                let n = HD_GEN_COUNT.fetch_add(1, Ordering::Relaxed) + 1;
                if n.is_multiple_of(LRU_CHECK_INTERVAL) {
                    crate::db::settings::get_settings(&conn)
                        .ok()
                        .map(|s| s.thumbnail_cache_mb)
                } else {
                    None
                }
            }; // 释放 DB 锁
               // B05：锁外执行 LRU 清理（纯文件系统操作，不持锁）
            if let Some(max_mb) = cleanup_mb {
                let _ = self.cleanup_lru(max_mb);
            }
            Ok(out)
        } else {
            // 高清生成失败降级返回占位图，保证前端有图可显
            Ok(self.placeholder_path(asset_id))
        }
    }

    // ── 缓存管理 ──

    /// 高清层 LRU 清理（mtime 最旧优先）；占位层不清理（架构 §1.6③）
    pub fn cleanup_lru(&self, max_mb: i64) -> AppResult<()> {
        let mut entries: Vec<(PathBuf, u64, std::time::SystemTime)> = Vec::new();
        let mut total: u64 = 0;
        for e in fs::read_dir(&self.hd_dir)?.flatten() {
            let md = e.metadata()?;
            if md.is_file() {
                total += md.len();
                entries.push((e.path(), md.len(), md.modified()?));
            }
        }
        let budget = (max_mb.max(0) as u64) * 1024 * 1024;
        if total <= budget {
            return Ok(());
        }
        entries.sort_by_key(|(_, _, mtime)| *mtime);
        for (path, len, _) in entries {
            if total <= budget {
                break;
            }
            if fs::remove_file(&path).is_ok() {
                total -= len;
            }
        }
        Ok(())
    }

    /// 删除素材联动清理两层文件（架构 §1.6③）
    pub fn delete_for_asset(&self, asset_id: i64) {
        let _ = fs::remove_file(self.placeholder_path(asset_id));
        if let Ok(rd) = fs::read_dir(&self.hd_dir) {
            let prefix = format!("{asset_id}_");
            for e in rd.flatten() {
                if e.file_name().to_string_lossy().starts_with(&prefix) {
                    let _ = fs::remove_file(e.path());
                }
            }
        }
    }

    pub fn clear(&self, kind: Option<&str>) -> AppResult<()> {
        let clear_dir = |dir: &Path| -> AppResult<()> {
            if dir.exists() {
                for e in fs::read_dir(dir)?.flatten() {
                    let _ = fs::remove_file(e.path());
                }
            }
            Ok(())
        };
        match kind {
            Some("placeholder") => clear_dir(&self.placeholder_dir)?,
            Some("hd") => clear_dir(&self.hd_dir)?,
            _ => {
                clear_dir(&self.placeholder_dir)?;
                clear_dir(&self.hd_dir)?;
            }
        }
        Ok(())
    }

    // ── 内部 ──

    /// 通用类型占位图：纯色底 + 深色色块区分图片/视频
    fn write_generic(out: &Path, is_video: bool) {
        let (w, h) = (PLACEHOLDER_SIZE, PLACEHOLDER_SIZE);
        let mut img = image::RgbaImage::from_pixel(w, h, image::Rgba([233, 233, 231, 255]));
        let block = if is_video {
            image::Rgba([35, 131, 226, 255]) // 视频：强调色块
        } else {
            image::Rgba([120, 119, 116, 255]) // 图片：灰色块
        };
        let (bw, bh) = (w / 2, h / 2);
        let (x0, y0) = ((w - bw) / 2, (h - bh) / 2);
        for y in y0..y0 + bh {
            for x in x0..x0 + bw {
                img.put_pixel(x, y, block);
            }
        }
        if let Ok(mut file) = fs::File::create(out) {
            let _ = image::codecs::webp::WebPEncoder::new_lossless(&mut file).write_image(
                img.as_raw(),
                w,
                h,
                image::ExtendedColorType::Rgba8,
            );
        }
    }
}
