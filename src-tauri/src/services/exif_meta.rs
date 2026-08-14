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
    let s = ex.get_field(tag, exif::In::PRIMARY)?.display_value().to_string();
    let s = s.trim().trim_matches('"').trim().to_string();
    if s.is_empty() { None } else { Some(s) }
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
    Some(chrono::Local.from_local_datetime(&naive).single()?.timestamp_millis())
}

/// 光圈 f/2.8 风格的整洁显示：1.8 → "1.8"，4.0 → "4"
pub fn fmt_f_number(v: f64) -> f64 {
    (v * 10.0).round() / 10.0
}

pub fn extract(path: &Path) -> ExifData {
    let Ok(file) = std::fs::File::open(path) else { return ExifData::default() };
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exif_datetime_parses() {
        let ts = parse_exif_datetime("2024:03:15 14:30:00").unwrap();
        assert!(ts > 0);
        // 解析回本地时间应还原同一时刻
        let dt = chrono::DateTime::from_timestamp_millis(ts).unwrap();
        assert_eq!(dt.with_timezone(&chrono::Local).format("%Y:%m:%d %H:%M:%S").to_string(), "2024:03:15 14:30:00");
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
}
