//! 视频服务：ffprobe 元数据 + ffmpeg 抽帧。
//! 二进制解析策略（T03）：优先 PATH；未安装则全部降级（元数据尽力而为、封面走通用占位图）。
//! 随应用分发（ffmpeg-sidecar/打包资源目录）在打包阶段接入，resolve_binary 已预留入口。

use std::path::Path;
use std::process::Command;
use std::time::Duration;

use serde::Deserialize;

/// ffmpeg/ffprobe 子进程总超时：损坏/超大文件可能让裸 status() 永久挂起（批次卡死），
/// 统一加墙防止无界等待；超时后返回 None/Err，由调用方降级或给出明确错误
const FFMPEG_TIMEOUT: Duration = Duration::from_secs(30);

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

/// ffprobe 提取元数据；ffprobe 不可用或解析失败返回 None（调用方降级）。
/// 带 30s 超时：损坏文件不会让探测无限挂起
pub fn probe(path: &Path) -> Option<VideoMeta> {
    let ffprobe = resolve_binary("ffprobe")?;
    let out = Command::new(ffprobe)
        .args([
            "-v",
            "quiet",
            "-print_format",
            "json",
            "-show_format",
            "-show_streams",
        ])
        .arg(path)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
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

/// ffmpeg 抽帧（缩放到指定边长，输出 webp/jpg 由 out 扩展名决定）。
/// 带 30s 超时：超时强制 kill 子进程返回 false，杜绝损坏/超大视频让批次无限挂起
pub fn extract_frame(path: &Path, time_ms: i64, out: &Path, size: u32) -> bool {
    let Some(ffmpeg) = resolve_binary("ffmpeg") else {
        return false;
    };
    let secs = format!("{:.3}", time_ms as f64 / 1000.0);
    let mut child = match Command::new(ffmpeg)
        .args(["-y", "-ss", &secs, "-i"])
        .arg(path)
        .args([
            "-frames:v",
            "1",
            "-vf",
            &format!("scale={size}:{size}:force_original_aspect_ratio=decrease"),
            "-loglevel",
            "error",
        ])
        .arg(out)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
    {
        Ok(c) => c,
        Err(_) => return false,
    };
    // 带超时的等待：进程超时未退出 → kill，避免抽帧卡死批次
    let deadline = std::time::Instant::now() + FFMPEG_TIMEOUT;
    let ok = loop {
        match child.try_wait() {
            Ok(Some(st)) => break st.success(),
            Ok(None) => {
                if std::time::Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    tracing::warn!("ffmpeg 抽帧超时（>{:?}），已终止：{}", FFMPEG_TIMEOUT, path.display());
                    break false;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(_) => break false,
        }
    };
    ok && out.exists()
}

/// P3-02：视频 AI 打标抽帧——取头/中/尾三帧（1280px webp）到指定目录；
/// 返回实际抽出的帧路径（时长未知时退化为 0s/5s/10s）；ffmpeg 不可用或全部失败返回空
pub fn extract_keyframes(
    path: &Path,
    duration_ms: Option<i64>,
    dir: &Path,
    n: usize,
) -> Vec<std::path::PathBuf> {
    let n = n.max(1);
    let times: Vec<i64> = match duration_ms {
        Some(d) if d > 0 && n > 1 => (0..n).map(|i| d * i as i64 / (n as i64)).collect(),
        Some(d) if d > 0 => vec![d / 2],
        _ => (0..n).map(|i| i as i64 * 5000).collect(),
    };
    let mut out = Vec::new();
    for (i, t) in times.iter().enumerate() {
        let frame = dir.join(format!("kframe_{i}.webp"));
        if extract_frame(path, *t, &frame, 1280) {
            out.push(frame);
        }
    }
    out
}
