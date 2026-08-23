//! 扩展名 → 素材类型 / MIME 判定

/// 素材类型："image" | "video" | None（不支持）
pub fn asset_type_from_ext(ext: &str) -> Option<&'static str> {
    match ext.to_ascii_lowercase().as_str() {
        // 通用格式（Phase 2：补 bmp/tga，tiff 解码随 image crate tiff feature 落地）
        "jpg" | "jpeg" | "png" | "webp" | "gif" | "bmp" | "tga" | "tif" | "tiff" | "heic" | "heif"
        // RAW（Phase 2 F01：补齐主流厂商格式，真解码见 raw_decode）
        | "raw" | "cr2" | "cr3" | "crw" | "nef" | "nrw" | "arw" | "srf" | "sr2" | "dng"
        | "raf" | "orf" | "rw2" | "pef" | "srw" | "x3f" | "mrw" | "iiq" | "3fr" | "fff"
        | "kdc" | "dcr" | "mos" | "mef" | "erf" => Some("image"),
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

/// 是否 RAW 系扩展名（Phase 2 F05：EXIF rawler 兜底判定用，与白名单同源）
pub fn is_raw_ext(ext: &str) -> bool {
    matches!(
        ext.to_ascii_lowercase().as_str(),
        "raw"
            | "cr2"
            | "cr3"
            | "crw"
            | "nef"
            | "nrw"
            | "arw"
            | "srf"
            | "sr2"
            | "dng"
            | "raf"
            | "orf"
            | "rw2"
            | "pef"
            | "srw"
            | "x3f"
            | "mrw"
            | "iiq"
            | "3fr"
            | "fff"
            | "kdc"
            | "dcr"
            | "mos"
            | "mef"
            | "erf"
    )
}
