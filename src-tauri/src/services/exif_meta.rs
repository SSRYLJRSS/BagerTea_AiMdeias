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
    /// GPS 定位（度分秒 Rational → 带符号十进制度，北纬东经为正；超出合法范围视为脏数据丢弃）
    pub latitude: Option<f64>,
    pub longitude: Option<f64>,
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

/// GPS 坐标度分秒（度/分/秒三个 Rational，秒可缺省）→ 十进制度。
/// 非数值/分母为零/结果非有限 → None；返回不带符号的绝对值，符号由 Ref 半球字段决定。
pub fn gps_dms_to_decimal(dms: &[exif::Rational]) -> Option<f64> {
    if dms.is_empty() {
        return None;
    }
    let deg = dms[0].to_f64();
    let minutes = if dms.len() > 1 { dms[1].to_f64() } else { 0.0 };
    let seconds = if dms.len() > 2 { dms[2].to_f64() } else { 0.0 };
    let v = deg + minutes / 60.0 + seconds / 3600.0;
    if v.is_finite() && v >= 0.0 {
        Some(v)
    } else {
        None
    }
}

/// 读单个 GPS 坐标分量（Tag::GPSLatitude / Tag::GPSLongitude）并应用半球符号：
/// Ref 为 S/W 取负；缺 Ref 默认正。越界（纬度 >90 / 经度 >180）视为脏数据丢弃。
fn gps_coordinate(ex: &Exif, coord: Tag, ref_tag: Tag, limit: f64) -> Option<f64> {
    let field = ex.get_field(coord, exif::In::PRIMARY)?;
    let dms: Vec<exif::Rational> = match &field.value {
        Value::Rational(v) => v.clone(),
        _ => return None,
    };
    let v = gps_dms_to_decimal(&dms)?;
    let sign = match text(ex, ref_tag).as_deref() {
        Some(r) if r.trim().to_ascii_uppercase().starts_with('S')
            || r.trim().to_ascii_uppercase().starts_with('W') =>
        {
            -1.0
        }
        _ => 1.0,
    };
    let signed = sign * v;
    if signed.abs() <= limit {
        Some(signed)
    } else {
        None
    }
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
        latitude: gps_coordinate(&ex, Tag::GPSLatitude, Tag::GPSLatitudeRef, 90.0),
        longitude: gps_coordinate(&ex, Tag::GPSLongitude, Tag::GPSLongitudeRef, 180.0),
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
        // rawler 兜底不提供 GPS（Exif 结构内无坐标字段），保持 None 由上层合并逻辑处理
        latitude: None,
        longitude: None,
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
    if dst.latitude.is_none() {
        dst.latitude = fb.latitude;
    }
    if dst.longitude.is_none() {
        dst.longitude = fb.longitude;
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

    // ── GPS 定位解析 ──
    // kamadak-exif 0.5 的 Rational 是公开字段无符号结构体（num: u32 / denom: u32），无 new 构造函数
    use exif::Rational;
    fn rat(num: u32, denom: u32) -> Rational {
        Rational { num, denom }
    }

    #[test]
    fn gps_dms_full_triple_converts() {
        // 30°15'30" = 30.2583…
        let dms = [rat(30, 1), rat(15, 1), rat(30, 1)];
        let v = gps_dms_to_decimal(&dms).unwrap();
        assert!((v - 30.258333).abs() < 1e-4);
    }

    #[test]
    fn gps_dms_fractional_rationals_and_missing_seconds() {
        // 120°10.014'（分带小数、无秒）= 120.1669…
        let dms = [rat(120, 1), rat(10014, 1000)];
        let v = gps_dms_to_decimal(&dms).unwrap();
        assert!((v - 120.166900).abs() < 1e-4);
        // 零分母 → None（脏数据容错）
        let bad = [rat(1, 0), rat(0, 1)];
        assert!(gps_dms_to_decimal(&bad).is_none());
        // 空数组 → None
        assert!(gps_dms_to_decimal(&[]).is_none());
    }

    #[test]
    fn gps_dms_degrees_only_and_nonfinite_rejected() {
        // 只有度一个分量 → 直接十进制度
        let d = [rat(45, 1)];
        assert_eq!(gps_dms_to_decimal(&d), Some(45.0));
        // 零分母 → 非有限值 → None（脏数据容错；符号由 Ref 字段承载，Rational 本身无符号）
        let bad = [rat(30, 0)];
        assert!(gps_dms_to_decimal(&bad).is_none());
    }
}
