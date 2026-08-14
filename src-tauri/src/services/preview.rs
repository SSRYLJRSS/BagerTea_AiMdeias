//! 待入库文件预览缩略图（PRD v2.6）：文件未入库也能出小图
//! 瘦壳：缓存键管理 + 视频抽帧；图片解码全部走全局统一引擎 imaging

use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};

use crate::error::{AppError, AppResult};
use crate::services::{imaging, video};
use crate::utils::mime;

const PREVIEW_SIZE: u32 = 320;

pub struct PreviewService {
    dir: PathBuf,
}

impl PreviewService {
    pub fn new(data_dir: &Path) -> AppResult<Self> {
        let dir = data_dir.join("previews");
        std::fs::create_dir_all(&dir)?;
        Ok(Self { dir })
    }

    /// 缓存键：路径 + 大小 + mtime（不读文件内容，秒级）
    fn cache_path(&self, src: &Path) -> PathBuf {
        let mut h = DefaultHasher::new();
        src.hash(&mut h);
        if let Ok(m) = src.metadata() {
            m.len().hash(&mut h);
            if let Ok(mt) = m.modified() {
                mt.hash(&mut h);
            }
        }
        self.dir.join(format!("{:016x}.webp", h.finish()))
    }

    pub fn get_or_create(&self, src: &Path) -> AppResult<PathBuf> {
        let out = self.cache_path(src);
        if out.exists() {
            return Ok(out);
        }
        let ext = src
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or_default()
            .to_ascii_lowercase();
        let ok = if mime::asset_type_from_ext(&ext) == Some("video") {
            let _permit = imaging::acquire();
            video::extract_frame(src, 0, &out, PREVIEW_SIZE)
        } else {
            imaging::write_thumb(src, &out, PREVIEW_SIZE)
        };
        if ok {
            Ok(out)
        } else {
            Err(AppError::msg(format!("无法生成预览: {}", src.display())))
        }
    }
}
