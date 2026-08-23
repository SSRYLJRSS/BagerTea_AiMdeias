fn main() {
    // Phase 2 F02：MSVC STL ABI 垫片——heif-rs 预编译库引用的 __std_rotate 等
    // 符号在本机 Build Tools 14.44 的 STL 中缺失，见 msvc_stl_shim.cpp 头注
    let os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    let env = std::env::var("CARGO_CFG_TARGET_ENV").unwrap_or_default();
    if os == "windows" && env == "msvc" {
        cc::Build::new()
            .cpp(true)
            .file("msvc_stl_shim.cpp")
            .compile("msvc_stl_shim");
    }
    tauri_build::build()
}
