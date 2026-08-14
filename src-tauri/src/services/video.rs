//! 视频服务：ffprobe 元数据 + ffmpeg 抽帧。
//! 二进制解析策略（T03）：优先 PATH；未安装则全部降级（元数据尽力而为、封面走通用占位图）。
//! 随应用分发（ffmpeg-sidecar/打包资源目录）在打包阶段接入，resolve_binary 已预留入口。

use std::path::Path;
use std::process::Command;

use serde::Deserialize;

/// 解析二进制路径：PATH → （预留）应用资源目录
fn resolve_binary(name: &str) -> Option<String> {
    Command::new(name)
        .arg("-version")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .ok()
        .filter(|s| s.success())
        .map(|_| name.to_string())
}

pub fn ffprobe_available() -> bool {
    resolve_binary("ffprobe").is_some()
}

pub fn ffmpeg_available() -> bool {
    resolve_binary("ffmpeg").is_some()
}

#[derive(Debug, Clone, Default)]
pub struct VideoMeta {
    pub width: Option<i64>,
    pub height: Option<i64>,
    pub duration_ms: Option<i64>,
    pub video_codec: Option<String>,
    pub audio_codec: Option<String>,
}

#[derive(Deserialize)]
struct FfprobeOutput {
    streams: Option<Vec<FfprobeStream>>,
    format: Option<FfprobeFormat>,
}

#[derive(Deserialize)]
struct FfprobeStream {
    codec_type: Option<String>,
    codec_name: Option<String>,
    width: Option<i64>,
    height: Option<i64>,
}

#[derive(Deserialize)]
struct FfprobeFormat {
    duration: Option<String>,
}

/// ffprobe 提取元数据；ffprobe 不可用或解析失败返回 None（调用方降级）
pub fn probe(path: &Path) -> Option<VideoMeta> {
    let ffprobe = resolve_binary("ffprobe")?;
    let out = Command::new(ffprobe)
        .args([
            "-v", "quiet",
            "-print_format", "json",
            "-show_format",
            "-show_streams",
        ])
        .arg(path)
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let parsed: FfprobeOutput = serde_json::from_slice(&out.stdout).ok()?;
    let mut meta = VideoMeta::default();
    if let Some(streams) = &parsed.streams {
        for s in streams {
            match s.codec_type.as_deref() {
                Some("video") => {
                    meta.video_codec = s.codec_name.clone();
                    meta.width = s.width;
                    meta.height = s.height;
                }
                Some("audio") => meta.audio_codec = s.codec_name.clone(),
                _ => {}
            }
        }
    }
    if let Some(f) = &parsed.format {
        if let Some(d) = &f.duration {
            meta.duration_ms = d.parse::<f64>().ok().map(|v| (v * 1000.0) as i64);
        }
    }
    Some(meta)
}

/// ffmpeg 抽帧（缩放到指定边长，输出 webp/jpg 由 out 扩展名决定）
pub fn extract_frame(path: &Path, time_ms: i64, out: &Path, size: u32) -> bool {
    let Some(ffmpeg) = resolve_binary("ffmpeg") else {
        return false;
    };
    let secs = format!("{:.3}", time_ms as f64 / 1000.0);
    Command::new(ffmpeg)
        .args([
            "-y",
            "-ss", &secs,
            "-i",
        ])
        .arg(path)
        .args([
            "-frames:v", "1",
            "-vf", &format!("scale={size}:{size}:force_original_aspect_ratio=decrease"),
            "-loglevel", "error",
        ])
        .arg(out)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success() && out.exists())
        .unwrap_or(false)
}
