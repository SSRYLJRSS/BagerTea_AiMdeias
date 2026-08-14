//! 扩展名 → 素材类型 / MIME 判定

/// 素材类型："image" | "video" | None（不支持）
pub fn asset_type_from_ext(ext: &str) -> Option<&'static str> {
    match ext.to_ascii_lowercase().as_str() {
        "jpg" | "jpeg" | "png" | "webp" | "gif" | "bmp" | "tif" | "tiff" | "heic" | "heif"
        | "raw" | "cr2" | "cr3" | "nef" | "arw" | "dng" => Some("image"),
        "mp4" | "mov" | "avi" | "mkv" | "webm" | "m4v" | "mts" | "m2ts" => Some("video"),
        _ => None,
    }
}

/// 粗略 MIME（入库写入 assets.mime_type）
pub fn mime_from_ext(ext: &str) -> Option<String> {
    let ext = ext.to_ascii_lowercase();
    let sub = match ext.as_str() {
        "jpg" => "jpeg",
        "tif" => "tiff",
        other => other,
    };
    asset_type_from_ext(&ext).map(|t| format!("{t}/{sub}"))
}
