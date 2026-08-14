//! 路径规范化与安全校验

/// Windows 规范化：统一小写盘符 + 反斜杠转正斜杠（架构共享知识 #4）
pub fn normalize_path(p: &str) -> String {
    let mut s = p.replace('\\', "/");
    // 小写盘符：C:/... → c:/...
    let bytes = s.as_bytes();
    if bytes.len() >= 2 && bytes[1] == b':' && bytes[0].is_ascii_uppercase() {
        let drive = (bytes[0] as char).to_ascii_lowercase();
        s.replace_range(0..1, &drive.to_string());
    }
    // 去掉末尾斜杠
    while s.len() > 3 && s.ends_with('/') {
        s.pop();
    }
    s
}

/// 安全校验：拒绝空路径与 UNC 以外的相对路径（防越权，T03 文件操作前调用）
pub fn ensure_absolute(p: &str) -> bool {
    let s = p.replace('\\', "/");
    (s.len() >= 3 && s.as_bytes()[1] == b':' && s.as_bytes()[2] == b'/') || s.starts_with("//")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_windows_path() {
        assert_eq!(normalize_path("D:\\Photos\\A.JPG"), "d:/Photos/A.JPG");
        assert_eq!(normalize_path("e:/dcim/"), "e:/dcim");
    }

    #[test]
    fn absolute_check() {
        assert!(ensure_absolute("C:/a/b.jpg"));
        assert!(ensure_absolute("D:\\x"));
        assert!(!ensure_absolute("a/b.jpg"));
        assert!(!ensure_absolute(""));
    }
}
