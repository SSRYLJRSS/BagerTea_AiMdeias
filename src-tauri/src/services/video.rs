//! 视频服务：ffprobe 元数据 + ffmpeg 抽帧。
//! 二进制解析策略（T03）：优先 PATH；未安装则全部降级（元数据尽力而为、封面走通用占位图）。
//! 随应用分发（ffmpeg-sidecar/打包资源目录）在打包阶段接入，resolve_binary 已预留入口。
//!
//! 指导书 阶段 2 §7.2：ffprobe stdout 必须 `piped` 并读取（历史 bug 是 `.stdout(Stdio::null())` 后再解析空 buffer，
//! 导致所有视频元数据探测静默失败）；stderr 保留到错误摘要；探测有真实墙钟超时并返回可识别错误。

use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::atomic::Ordering;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Deserialize;

/// ffmpeg/ffprobe 子进程总超时：损坏/超大文件可能让裸 status() 永久挂起（批次卡死），
/// 统一加墙防止无界等待；超时后 kill + wait 并返回 `ProbeError::Timeout`。
const FFMPEG_TIMEOUT: Duration = Duration::from_secs(30);

/// ffprobe 可用性探测的短期缓存有效期（指导书 §7.2：PATH 探测不能每次素材请求都无界阻塞）
const BINARY_CACHE_TTL: Duration = Duration::from_secs(60);

/// ffmpeg/ffprobe 可用性结果缓存（短 TTL）。静态全局，进程内共享。
static BINARY_CACHE: Mutex<Option<(String, Instant, bool)>> = Mutex::new(None);

/// 解析二进制路径：PATH → （预留）应用资源目录
fn resolve_binary(name: &str) -> Option<String> {
    Command::new(name)
        .arg("-version")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .ok()
        .filter(|s| s.success())
        .map(|_| name.to_string())
}

/// 带短 TTL 缓存的 ffprobe 可用性探测：避免每次素材请求都 spawn `ffprobe -version`。
pub fn ffprobe_available() -> bool {
    binary_available("ffprobe")
}

/// 带短 TTL 缓存的 ffmpeg 可用性探测。
pub fn ffmpeg_available() -> bool {
    binary_available("ffmpeg")
}

fn binary_available(name: &str) -> bool {
    if let Ok(cache) = BINARY_CACHE.lock() {
        if let Some((cached_name, at, val)) = &*cache {
            if cached_name == name && at.elapsed() < BINARY_CACHE_TTL {
                return *val;
            }
        }
    }
    let val = resolve_binary(name).is_some();
    if let Ok(mut cache) = BINARY_CACHE.lock() {
        *cache = Some((name.to_string(), Instant::now(), val));
    }
    val
}

/// ffprobe 探测错误：不同失败原因必须可区分（指导书 §7.2）。
#[derive(Debug, thiserror::Error)]
pub enum ProbeError {
    #[error("ffprobe 不可用")]
    BinaryMissing,
    #[error("启动 ffprobe 失败: {0}")]
    Spawn(#[source] std::io::Error),
    #[error("ffprobe 探测超时（>{FFMPEG_TIMEOUT:?}），已终止")]
    Timeout,
    #[error("ffprobe 退出码非 0（code={code}）：{stderr}")]
    NonZeroExit { code: i32, stderr: String },
    #[error("ffprobe 输出解析失败: {0}")]
    Parse(#[source] serde_json::Error),
}

#[derive(Debug, Clone, Default)]
pub struct VideoMeta {
    pub width: Option<i64>,
    pub height: Option<i64>,
    pub duration_ms: Option<i64>,
    pub video_codec: Option<String>,
    pub audio_codec: Option<String>,
    // 指导书 §7.3 结构化字段（对高频筛选列结构化，长尾进 raw_json）
    pub container_format: Option<String>,
    pub video_profile: Option<String>,
    pub pixel_format: Option<String>,
    pub bit_depth: Option<i64>,
    pub frame_rate: Option<f64>,
    pub video_bit_rate: Option<i64>,
    pub color_range: Option<String>,
    pub color_space: Option<String>,
    pub color_transfer: Option<String>,
    pub color_primaries: Option<String>,
    pub rotation: Option<i64>,
    pub audio_sample_rate: Option<i64>,
    pub audio_channels: Option<i64>,
    pub audio_layout: Option<String>,
    /// 原始 ffprobe JSON 保留（未来补字段无需重读文件）
    pub raw_json: Option<String>,
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
    profile: Option<String>,
    width: Option<i64>,
    height: Option<i64>,
    pix_fmt: Option<String>,
    bit_depth: Option<i64>,
    #[serde(rename = "avg_frame_rate")]
    avg_frame_rate: Option<String>,
    #[serde(rename = "r_frame_rate")]
    r_frame_rate: Option<String>,
    #[serde(rename = "bit_rate")]
    bit_rate: Option<String>,
    #[serde(rename = "color_range")]
    color_range: Option<String>,
    #[serde(rename = "color_space")]
    color_space: Option<String>,
    #[serde(rename = "color_transfer")]
    color_transfer: Option<String>,
    #[serde(rename = "color_primaries")]
    color_primaries: Option<String>,
    #[serde(rename = "sample_rate")]
    sample_rate: Option<String>,
    channels: Option<i64>,
    tags: Option<std::collections::HashMap<String, serde_json::Value>>,
    side_data_list: Option<Vec<FfprobeSideData>>,
}

#[derive(Deserialize)]
struct FfprobeSideData {
    #[serde(rename = "side_data_type")]
    side_data_type: Option<String>,
    rotation: Option<serde_json::Value>,
}

#[derive(Deserialize)]
struct FfprobeFormat {
    #[serde(rename = "format_name")]
    format_name: Option<String>,
    duration: Option<String>,
    #[serde(rename = "bit_rate")]
    bit_rate: Option<String>,
}

/// 把 `2/1`、`30000/1001` 之类的分数解析为 f64；非分数/无效返回 None。
fn parse_rate(s: &str) -> Option<f64> {
    let s = s.trim();
    if s.is_empty() || s == "0/0" || s == "N/A" {
        return None;
    }
    if let Some((num, den)) = s.split_once('/') {
        let n: f64 = num.trim().parse().ok()?;
        let d: f64 = den.trim().parse().ok()?;
        if d == 0.0 {
            return None;
        }
        Some(n / d)
    } else {
        s.parse::<f64>().ok()
    }
}

/// 旋转值：ffprobe 在 side_data.displaymatrix 里是数字（90/-90），在 tags.rotate 里是字符串（"90"），
/// 需同时接受数字与数字字符串并归一化到 0..360。
fn as_rotation(v: &serde_json::Value) -> Option<i64> {
    let n = if let Some(n) = v.as_i64() {
        n as f64
    } else if let Some(n) = v.as_f64() {
        n
    } else {
        v.as_str()?.trim().parse::<f64>().ok()?
    };
    Some((n.rem_euclid(360.0)) as i64)
}

/// 从 ffprobe JSON 字节流解析出 `VideoMeta`（导出的纯函数，便于 fixture 单测）。
/// - 主视频流：codec/profile/pixel/bit depth/分辨率/帧率/码率/色彩/旋转。
/// - 第一条音频轨：codec/采样率/声道/声道布局。
/// - 容器：format_name + duration + bit_rate。
pub fn parse_ffprobe_json(bytes: &[u8]) -> Result<VideoMeta, ProbeError> {
    let parsed: FfprobeOutput = serde_json::from_slice(bytes).map_err(ProbeError::Parse)?;
    let mut meta = VideoMeta::default();
    if let Some(streams) = &parsed.streams {
        let mut video_seen = false;
        for s in streams {
            match s.codec_type.as_deref() {
                Some("video") if !video_seen => {
                    video_seen = true;
                    meta.video_codec = s.codec_name.clone();
                    meta.video_profile = s.profile.clone();
                    meta.width = s.width;
                    meta.height = s.height;
                    meta.pixel_format = s.pix_fmt.clone();
                    meta.bit_depth = s.bit_depth;
                    meta.frame_rate = s
                        .avg_frame_rate
                        .as_deref()
                        .and_then(parse_rate)
                        .or_else(|| s.r_frame_rate.as_deref().and_then(parse_rate));
                    meta.video_bit_rate = s.bit_rate.as_deref().and_then(|b| b.parse::<i64>().ok());
                    meta.color_range = s.color_range.clone();
                    meta.color_space = s.color_space.clone();
                    meta.color_transfer = s.color_transfer.clone();
                    meta.color_primaries = s.color_primaries.clone();
                    // 旋转：优先 side_data（displaymatrix），退化到 tags.rotate
                    if let Some(sd) = &s.side_data_list {
                        for d in sd {
                            if d.side_data_type.as_deref() == Some("Display Matrix") {
                                if let Some(rot) = &d.rotation {
                                    meta.rotation = as_rotation(rot);
                                }
                            }
                        }
                    }
                    if meta.rotation.is_none() {
                        if let Some(r) = s
                            .tags
                            .as_ref()
                            .and_then(|t| t.get("rotate"))
                        {
                            meta.rotation = as_rotation(r);
                        }
                    }
                }
                Some("audio") => {
                    // 只取第一条音轨作为主音轨摘要（多音轨完整信息保留在 raw_json）
                    if meta.audio_codec.is_none() {
                        meta.audio_codec = s.codec_name.clone();
                        meta.audio_sample_rate = s.sample_rate.as_deref().and_then(|v| v.parse::<i64>().ok());
                        meta.audio_channels = s.channels;
                        meta.audio_layout = s
                            .tags
                            .as_ref()
                            .and_then(|t| t.get("language"))
                            .and_then(|v| v.as_str())
                            .map(str::to_string)
                            .or_else(|| {
                                s.tags
                                    .as_ref()
                                    .and_then(|t| t.get("title"))
                                    .and_then(|v| v.as_str())
                                    .map(str::to_string)
                            });
                    }
                }
                _ => {}
            }
        }
    }
    if let Some(f) = &parsed.format {
        meta.container_format = f.format_name.clone();
        if let Some(d) = &f.duration {
            meta.duration_ms = d.parse::<f64>().ok().map(|v| (v * 1000.0) as i64);
        }
        if meta.video_bit_rate.is_none() {
            meta.video_bit_rate = f.bit_rate.as_deref().and_then(|b| b.parse::<i64>().ok());
        }
    }
    if let Ok(text) = std::str::from_utf8(bytes) {
        meta.raw_json = Some(text.to_string());
    }
    Ok(meta)
}

/// ffprobe 提取元数据（指导书 §7.2 修复版）：
///  - stdout 必须 `piped` 并读取（历史 bug 是 `Stdio::null()`，导致解析空 buffer 而静默失败）；
///  - stderr 保留到错误摘要，不无条件丢弃；
///  - 真实墙钟超时，超时 kill + wait，返回 `ProbeError::Timeout`；
///  - 二进制缺失/启动失败/退出码非 0/解析失败/超时各有可识别错误。
pub fn probe(path: &Path) -> Result<VideoMeta, ProbeError> {
    // 需要解析 stdout，所以 ffprobe 必须存在
    if !ffprobe_available() {
        return Err(ProbeError::BinaryMissing);
    }
    let ffprobe = resolve_binary("ffprobe").ok_or(ProbeError::BinaryMissing)?;

    let mut child = Command::new(ffprobe)
        .args([
            "-v",
            "error",
            "-print_format",
            "json",
            "-show_format",
            "-show_streams",
            "-show_programs",
            "-show_chapters",
        ])
        .arg(path)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(ProbeError::Spawn)?;

    // 用线程并行读取 stdout/stderr（避免输出阻塞子进程导致无法退出）
    let mut stdout_pipe = child.stdout.take();
    let mut stderr_pipe = child.stderr.take();
    let stdout_reader = std::thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(mut o) = stdout_pipe.take() {
            let _ = o.read_to_end(&mut buf);
        }
        buf
    });
    let stderr_reader = std::thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(mut e) = stderr_pipe.take() {
            let _ = e.read_to_end(&mut buf);
        }
        buf
    });

    // 真实墙钟超时：轮询 try_wait，超时 kill + wait
    let deadline = Instant::now() + FFMPEG_TIMEOUT;
    let status = loop {
        match child.try_wait() {
            Ok(Some(st)) => break Some(st),
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    // 先 join 读线程避免资源泄漏
                    let _ = stdout_reader.join();
                    let _ = stderr_reader.join();
                    tracing::warn!("ffprobe 探测超时（>{:?}），已终止：{}", FFMPEG_TIMEOUT, path.display());
                    return Err(ProbeError::Timeout);
                }
                std::thread::sleep(Duration::from_millis(20));
            }
            Err(_) => {
                let _ = stdout_reader.join();
                let _ = stderr_reader.join();
                return Err(ProbeError::Spawn(std::io::Error::new(
                    std::io::ErrorKind::Other,
                    "等待 ffprobe 失败",
                )));
            }
        }
    };

    let stdout = stdout_reader.join().unwrap_or_default();
    let stderr_bytes = stderr_reader.join().unwrap_or_default();

    let status = status.ok_or_else(|| {
        ProbeError::Spawn(std::io::Error::new(std::io::ErrorKind::Other, "ffprobe 未返回状态"))
    })?;
    if !status.success() {
        let stderr = String::from_utf8_lossy(&stderr_bytes).trim().to_string();
        return Err(ProbeError::NonZeroExit {
            code: status.code().unwrap_or(-1),
            stderr,
        });
    }

    // 指导书：stdout 被丢弃/为空时不得静默通过
    if stdout.is_empty() {
        return Err(ProbeError::NonZeroExit {
            code: status.code().unwrap_or(-1),
            stderr: String::from_utf8_lossy(&stderr_bytes).trim().to_string(),
        });
    }

    parse_ffprobe_json(&stdout)
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
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
    {
        Ok(c) => c,
        Err(_) => return false,
    };
    // 带超时的等待：进程超时未退出 → kill，避免抽帧卡死批次
    let deadline = Instant::now() + FFMPEG_TIMEOUT;
    let ok = loop {
        match child.try_wait() {
            Ok(Some(st)) => break st.success(),
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    tracing::warn!(
                        "ffmpeg 抽帧超时（>{:?}），已终止：{}",
                        FFMPEG_TIMEOUT,
                        path.display()
                    );
                    break false;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(_) => break false,
        }
    };
    ok && out.exists()
}

/// 把视频转码为 H.264/AAC MP4（指导书 §8.3 兼容代理）。带真实墙钟超时 + 可选取消；stderr 保留到错误摘要。
/// 注意：输出格式由 out 扩展名决定（.mp4）。返回不同的可辨识错误（ffmpeg 缺失/启动/超时/取消/非 0 退出）。
pub fn transcode_to_h264(
    src: &Path,
    out: &Path,
    cancel: Option<&std::sync::atomic::AtomicBool>,
) -> crate::error::AppResult<()> {
    let Some(ffmpeg) = resolve_binary("ffmpeg") else {
        return Err(crate::error::AppError::msg("ffmpeg 不可用"));
    };
    let mut child = Command::new(ffmpeg)
        .args(["-y", "-i"])
        .arg(src)
        .args([
            "-c:v",
            "libx264",
            "-preset",
            "fast",
            "-crf",
            "23",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            "-b:a",
            "128k",
            "-movflags",
            "+faststart",
        ])
        .arg(out)
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| crate::error::AppError::msg(format!("启动 ffmpeg 失败: {e}")))?;

    // stderr 读线程，避免管道缓冲阻塞子进程
    let mut stderr_pipe = child.stderr.take();
    let stderr_reader = std::thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(mut e) = stderr_pipe.take() {
            let _ = e.read_to_end(&mut buf);
        }
        buf
    });

    let deadline = Instant::now() + FFMPEG_TIMEOUT;
    let status = loop {
        match child.try_wait() {
            Ok(Some(st)) => break Some(st),
            Ok(None) => {
                if Instant::now() >= deadline || cancel.map_or(false, |c| c.load(Ordering::Relaxed)) {
                    let _ = child.kill();
                    let _ = child.wait();
                    let _ = stderr_reader.join();
                    return Err(crate::error::AppError::msg("转码超时或已取消"));
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(_) => break None,
        }
    };
    let stderr = String::from_utf8_lossy(&stderr_reader.join().unwrap_or_default())
        .trim()
        .to_string();
    let Some(st) = status else {
        return Err(crate::error::AppError::msg("转码进程异常"));
    };
    if !st.success() {
        return Err(crate::error::AppError::msg(format!(
            "转码失败（退出码 {:?}）：{}",
            st.code(),
            stderr
        )));
    }
    Ok(())
}

/// P3-02：视频 AI 打标抽帧——取每段中点帧（1280px webp）到指定目录；
/// 返回实际抽出的帧路径（时长未知时退化为 2s/7s/12s，跳过第 0 秒）；ffmpeg 不可用或全部失败返回空
///
/// FB2-07（§13.5）：帧位取每段中点。原公式 d*i/n 的第一帧恒为第 0ms（相机视频开头常是黑场/自动曝光未稳定），
/// 取中点避开片头黑场与片尾字幕/淡出 —— n=3 → 16.7% / 50% / 83%。抽帧走全局解码并发闸，避免批量打标拉满 CPU。
pub fn extract_keyframes(
    path: &Path,
    duration_ms: Option<i64>,
    dir: &Path,
    n: usize,
) -> Vec<std::path::PathBuf> {
    let n = n.max(1);
    // FB2-07：帧位取每段中点（n==1 时自然给出 d*0.5，与原 vec![d/2] 分支行为一致，已合并删除）
    let times: Vec<i64> = match duration_ms {
        Some(d) if d > 0 => (0..n)
            .map(|i| ((d as f64) * (i as f64 + 0.5) / (n as f64)) as i64)
            .collect(),
        // 时长未知：退化为固定间隔，跳过第 0 秒
        _ => (0..n).map(|i| 2000 + i as i64 * 5000).collect(),
    };
    let mut out = Vec::new();
    for (i, t) in times.iter().enumerate() {
        let frame = dir.join(format!("kframe_{i}.webp"));
        // FB2-07：每帧申请一次全局解码/抽帧并发闸 permit（acquire 返回 RAII guard，作用域内持有）。
        // 绝不能 `let _ = acquire()` —— 那会立即 drop，permit 白拿；也不能提到循环外（会降低整段吞吐）。
        let _permit = crate::services::imaging::acquire();
        if extract_frame(path, *t, &frame, 1280) {
            out.push(frame);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn json(s: &str) -> Vec<u8> {
        s.as_bytes().to_vec()
    }

    #[test]
    fn parses_h264_with_duration_and_color() {
        let j = r#"
        {
          "streams": [
            {"index":0,"codec_type":"video","codec_name":"h264","profile":"High",
             "width":1920,"height":1080,"pix_fmt":"yuv420p","avg_frame_rate":"30000/1001",
             "bit_rate":"5000000","color_range":"tv","color_space":"bt709",
             "color_transfer":"bt709","color_primaries":"bt709",
             "tags":{"rotate":"90"}},
            {"index":1,"codec_type":"audio","codec_name":"aac","sample_rate":"44100","channels":2,
             "tags":{"language":"eng","title":"Main"}}
          ],
          "format": {"format_name":"mov,mp4,m4a,3gp,3g2,mj2","duration":"12.345","bit_rate":"5100000"}
        }"#;
        let meta = parse_ffprobe_json(&json(j)).unwrap();
        assert_eq!(meta.video_codec.as_deref(), Some("h264"));
        assert_eq!(meta.video_profile.as_deref(), Some("High"));
        assert_eq!(meta.width, Some(1920));
        assert_eq!(meta.height, Some(1080));
        assert_eq!(meta.pixel_format.as_deref(), Some("yuv420p"));
        assert_eq!(meta.duration_ms, Some(12345));
        assert_eq!(meta.frame_rate, Some(30000.0 / 1001.0));
        assert_eq!(meta.video_bit_rate, Some(5000000));
        assert_eq!(meta.color_space.as_deref(), Some("bt709"));
        assert_eq!(meta.rotation, Some(90));
        assert_eq!(meta.audio_codec.as_deref(), Some("aac"));
        assert_eq!(meta.container_format.as_deref(), Some("mov,mp4,m4a,3gp,3g2,mj2"));
        assert!(meta.raw_json.is_some());
    }

    #[test]
    fn parses_hevc_main10_with_bit_depth_no_rot() {
        let j = r#"
        {
          "streams": [
            {"index":0,"codec_type":"video","codec_name":"hevc","profile":"Main 10",
             "width":3840,"height":2160,"pix_fmt":"yuv420p10le","bit_depth":10,
             "avg_frame_rate":"24000/1001","bit_rate":"12000000"}
          ],
          "format": {"format_name":"mov,mp4,m4a,3gp,3g2,mj2","duration":"600.5"}
        }"#;
        let meta = parse_ffprobe_json(&json(j)).unwrap();
        assert_eq!(meta.video_codec.as_deref(), Some("hevc"));
        assert_eq!(meta.video_profile.as_deref(), Some("Main 10"));
        assert_eq!(meta.bit_depth, Some(10));
        assert_eq!(meta.pixel_format.as_deref(), Some("yuv420p10le"));
        assert_eq!(meta.duration_ms, Some(600500));
        assert_eq!(meta.audio_codec, None);
        assert_eq!(meta.rotation, None);
    }

    #[test]
    fn parses_multi_audio_keeps_first_track() {
        let j = r#"
        {
          "streams": [
            {"index":0,"codec_type":"video","codec_name":"vp9","width":1280,"height":720},
            {"index":1,"codec_type":"audio","codec_name":"opus","channels":2},
            {"index":2,"codec_type":"audio","codec_name":"aac","channels":6}
          ],
          "format": {"format_name":"matroska,webm","duration":"30","bit_rate":"800000"}
        }"#;
        let meta = parse_ffprobe_json(&json(j)).unwrap();
        assert_eq!(meta.audio_codec.as_deref(), Some("opus")); // 第一条音轨
        assert_eq!(meta.container_format.as_deref(), Some("matroska,webm"));
        assert_eq!(meta.video_codec.as_deref(), Some("vp9"));
    }

    #[test]
    fn handles_vfr_rate_zero_denominator() {
        let j = r#"
        {
          "streams": [
            {"index":0,"codec_type":"video","codec_name":"h264","avg_frame_rate":"0/0","r_frame_rate":"25/1"}
          ],
          "format": {"format_name":"matroska,webm","duration":"10.0"}
        }"#;
        let meta = parse_ffprobe_json(&json(j)).unwrap();
        // 0/0 应被丢弃，退化到 r_frame_rate=25
        assert_eq!(meta.frame_rate, Some(25.0));
    }

    #[test]
    fn corrupted_json_returns_parse_error() {
        let err = parse_ffprobe_json(&json("{ not valid json "));
        assert!(matches!(err, Err(ProbeError::Parse(_))));
    }
}
