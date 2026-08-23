//! EXIF 元信息提取（PRD 5.5）：入库时自动读取相机/镜头/参数/拍摄时间
//! 尽力而为：任一字段读不到即为 None，绝不阻塞入库

use std::path::Path;

use chrono::TimeZone;
use exif::{Exif, Reader, Tag, Value};

#[derive(Debug, Clone, Default)]
pub struct ExifData {
    pub camera: Option<String>,
    pub lens: Option<String>,
    pub iso: Option<i64>,
    pub aperture: Option<f64>,
    pub shutter: Option<String>,
    pub focal: Option<f64>,
    pub taken_at: Option<i64>,
}

fn text(ex: &Exif, tag: Tag) -> Option<String> {
    let s = ex
        .get_field(tag, exif::In::PRIMARY)?
        .display_value()
        .to_string();
    let s = s.trim().trim_matches('"').trim().to_string();
    if s.is_empty() {
        None
    } else {
        Some(s)
    }
}

fn num(ex: &Exif, tag: Tag) -> Option<f64> {
    match &ex.get_field(tag, exif::In::PRIMARY)?.value {
        Value::Rational(v) if !v.is_empty() => Some(v[0].to_f64()),
        Value::Short(v) if !v.is_empty() => Some(f64::from(v[0])),
        Value::Long(v) if !v.is_empty() => Some(v[0] as f64),
        Value::Float(v) if !v.is_empty() => Some(f64::from(v[0])),
        Value::Double(v) if !v.is_empty() => Some(v[0]),
        _ => None,
    }
}

/// "2024:03:15 14:30:00" → 本地时区毫秒时间戳
pub fn parse_exif_datetime(s: &str) -> Option<i64> {
    let naive = chrono::NaiveDateTime::parse_from_str(s.trim(), "%Y:%m:%d %H:%M:%S").ok()?;
    Some(
        chrono::Local
            .from_local_datetime(&naive)
            .single()?
            .timestamp_millis(),
    )
}

/// 光圈 f/2.8 风格的整洁显示：1.8 → "1.8"，4.0 → "4"
pub fn fmt_f_number(v: f64) -> f64 {
    (v * 10.0).round() / 10.0
}

pub fn extract(path: &Path) -> ExifData {
    let mut data = extract_container(path);
    // RAW 兜底（Phase 2 F05）：CR3（ISOBMFF）/RW2（非标 TIFF 魔数）等容器
    // kamadak-exif 读不到时，用 rawler 轻量识别（只解元数据不解像素）补缺
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or_default();
    if crate::utils::mime::is_raw_ext(ext) && data.camera.is_none() {
        if let Some(fb) = raw_fallback(path) {
            merge_missing(&mut data, fb);
        }
    }
    data
}

/// kamadak-exif 容器读取（JPEG/TIFF/HEIF 及标准 TIFF 魔数的 RAW）
fn extract_container(path: &Path) -> ExifData {
    let Ok(file) = std::fs::File::open(path) else {
        return ExifData::default();
    };
    let Ok(ex) = Reader::new().read_from_container(&mut std::io::BufReader::new(file)) else {
        return ExifData::default();
    };

    let taken_at = text(&ex, Tag::DateTimeOriginal).and_then(|s| parse_exif_datetime(&s));
    ExifData {
        camera: text(&ex, Tag::Model),
        lens: text(&ex, Tag::LensModel),
        iso: num(&ex, Tag::PhotographicSensitivity).map(|v| v as i64),
        aperture: num(&ex, Tag::FNumber).map(fmt_f_number),
        shutter: text(&ex, Tag::ExposureTime).map(|s| s.trim_end_matches(" s").to_string()),
        focal: num(&ex, Tag::FocalLength).map(|v| v.round()),
        taken_at,
    }
}

/// rawler 轻量识别兜底：get_decoder + raw_metadata 只做容器解析与相机识别，
/// 不解码像素，成本远低于全解码；失败返回 None 不阻塞入库
fn raw_fallback(path: &Path) -> Option<ExifData> {
    let src = rawler::rawsource::RawSource::new(path).ok()?;
    let decoder = rawler::get_decoder(&src).ok()?;
    let params = rawler::decoders::RawDecodeParams::default();
    let meta = decoder.raw_metadata(&src, &params).ok()?;
    let ex = &meta.exif;
    // 镜头名优先取 EXIF 原文（含厂商前缀），其次 rawler 库内描述
    let lens = ex
        .lens_model
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .or_else(|| {
            meta.lens
                .as_ref()
                .map(|l| l.lens_model.trim().to_string())
                .filter(|s| !s.is_empty())
        });
    Some(ExifData {
        camera: (!meta.model.trim().is_empty()).then(|| meta.model.trim().to_string()),
        lens,
        iso: ex
            .iso_speed_ratings
            .map(|v| v as i64)
            .or_else(|| ex.recommended_exposure_index.map(|v| v as i64))
            .or_else(|| ex.iso_speed.map(|v| v as i64)),
        aperture: ex
            .fnumber
            .as_ref()
            .map(|r| fmt_f_number(r.n as f64 / r.d.max(1) as f64)),
        shutter: ex.exposure_time.as_ref().map(|r| {
            // 与 kamadak 显示风格对齐：分子≤分母保留分数形（1/125），否则小数
            if r.d > 0 && r.n <= r.d {
                format!("{}/{}", r.n.max(1), r.d)
            } else {
                format!("{}", (r.n as f64 / r.d.max(1) as f64 * 10.0).round() / 10.0)
            }
        }),
        focal: ex
            .focal_length
            .as_ref()
            .map(|r| (r.n as f64 / r.d.max(1) as f64).round()),
        taken_at: ex
            .date_time_original
            .as_deref()
            .and_then(parse_exif_datetime),
    })
}

/// 兜底数据只填补空缺字段，不覆盖 kamadak 已读到的值
fn merge_missing(dst: &mut ExifData, fb: ExifData) {
    if dst.camera.is_none() {
        dst.camera = fb.camera;
    }
    if dst.lens.is_none() {
        dst.lens = fb.lens;
    }
    if dst.iso.is_none() {
        dst.iso = fb.iso;
    }
    if dst.aperture.is_none() {
        dst.aperture = fb.aperture;
    }
    if dst.shutter.is_none() {
        dst.shutter = fb.shutter;
    }
    if dst.focal.is_none() {
        dst.focal = fb.focal;
    }
    if dst.taken_at.is_none() {
        dst.taken_at = fb.taken_at;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exif_datetime_parses() {
        let ts = parse_exif_datetime("2024:03:15 14:30:00").unwrap();
        assert!(ts > 0);
        // 解析回本地时间应还原同一时刻
        let dt = chrono::DateTime::from_timestamp_millis(ts).unwrap();
        assert_eq!(
            dt.with_timezone(&chrono::Local)
                .format("%Y:%m:%d %H:%M:%S")
                .to_string(),
            "2024:03:15 14:30:00"
        );
    }

    #[test]
    fn bad_datetime_gives_none() {
        assert!(parse_exif_datetime("2024-03-15").is_none());
        assert!(parse_exif_datetime("").is_none());
    }

    #[test]
    fn f_number_rounded_to_tenth() {
        assert_eq!(fmt_f_number(2.799999), 2.8);
        assert_eq!(fmt_f_number(4.0), 4.0);
    }

    #[test]
    fn raw_fallback_nonexistent_returns_none() {
        assert!(raw_fallback(std::path::Path::new("不存在的文件.cr3")).is_none());
    }

    #[test]
    fn raw_fallback_garbage_returns_none() {
        // 垃圾数据冒充 CR3：rawler 识别失败应返回 None 而非 panic
        let f = std::env::temp_dir().join(format!("bagertea_exif_{}.cr3", std::process::id()));
        std::fs::write(&f, b"not a real raw file at all").unwrap();
        assert!(raw_fallback(&f).is_none());
        std::fs::remove_file(&f).ok();
    }

    #[test]
    fn merge_missing_keeps_existing_values() {
        let mut dst = ExifData {
            camera: Some("原值".into()),
            iso: Some(100),
            ..Default::default()
        };
        let fb = ExifData {
            camera: Some("兜底".into()),
            iso: Some(200),
            lens: Some("兜底镜头".into()),
            ..Default::default()
        };
        merge_missing(&mut dst, fb);
        assert_eq!(dst.camera.as_deref(), Some("原值"));
        assert_eq!(dst.iso, Some(100));
        assert_eq!(dst.lens.as_deref(), Some("兜底镜头"));
    }
}
