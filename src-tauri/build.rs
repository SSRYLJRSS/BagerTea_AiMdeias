fn main() {
    verify_heif_binaries();

    // heif-rs 预编译库在旧版 MSVC STL 上需要 ABI 垫片；新 STL 已提供这些符号时不重复定义。
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

fn verify_heif_binaries() {
    use std::path::PathBuf;

    use serde_json::Value;
    use sha2::{Digest, Sha256};

    const MARKER: &str = ".bagertea-heif-verified-v2.json";
    println!("cargo:rerun-if-env-changed=HEIF_BINARIES_DIR");

    let target = std::env::var("TARGET").expect("Cargo did not set TARGET");
    let manifest_path =
        PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR missing"))
            .join("native")
            .join("heif-manifest.json");
    println!("cargo:rerun-if-changed={}", manifest_path.display());

    let failure = || {
        format!(
            "HEIF native libraries for {target} are missing or unverified. Run `npm run prepare-heif-libraries -- --target {target}` before Cargo build/test, then set HEIF_BINARIES_DIR to `src-tauri/native/heif/{target}`."
        )
    };
    let heif_dir = std::env::var_os("HEIF_BINARIES_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| panic!("{}", failure()));
    let manifest: Value = serde_json::from_slice(
        &std::fs::read(&manifest_path).unwrap_or_else(|_| panic!("{}", failure())),
    )
    .unwrap_or_else(|_| panic!("{}", failure()));
    let expected = manifest["targets"]
        .get(&target)
        .unwrap_or_else(|| panic!("{}", failure()));
    let marker: Value = serde_json::from_slice(
        &std::fs::read(heif_dir.join(MARKER)).unwrap_or_else(|_| panic!("{}", failure())),
    )
    .unwrap_or_else(|_| panic!("{}", failure()));

    if marker["schemaVersion"].as_u64() != Some(2)
        || marker["target"].as_str() != Some(target.as_str())
        || marker["releaseVersion"].as_str() != manifest["release"]["version"].as_str()
        || marker["assetName"].as_str() != expected["assetName"].as_str()
        || marker["assetSha256"].as_str() != expected["assetSha256"].as_str()
        || marker["assetSizeBytes"].as_u64() != expected["assetSizeBytes"].as_u64()
        || !heif_dir.join("include").is_dir()
        || !heif_dir.join("lib").is_dir()
    {
        panic!("{}", failure());
    }

    let libraries = expected["staticLibraries"]
        .as_array()
        .unwrap_or_else(|| panic!("{}", failure()));
    let expected_hashes = expected["staticLibrarySha256s"]
        .as_object()
        .unwrap_or_else(|| panic!("{}", failure()));
    let recorded_hashes = marker["staticLibrarySha256s"]
        .as_object()
        .unwrap_or_else(|| panic!("{}", failure()));
    if expected_hashes.len() != libraries.len() || recorded_hashes.len() != libraries.len() {
        panic!("{}", failure());
    }

    for library in libraries {
        let name = library.as_str().unwrap_or_else(|| panic!("{}", failure()));
        let path = heif_dir.join("lib").join(name);
        let metadata = std::fs::symlink_metadata(&path).unwrap_or_else(|_| panic!("{}", failure()));
        if !metadata.file_type().is_file() || metadata.len() == 0 {
            panic!("{}", failure());
        }
        let expected_hash = expected_hashes[name]
            .as_str()
            .unwrap_or_else(|| panic!("{}", failure()));
        if recorded_hashes[name].as_str() != Some(expected_hash) {
            panic!("{}", failure());
        }
        let contents = std::fs::read(&path).unwrap_or_else(|_| panic!("{}", failure()));
        let actual_hash = format!("{:x}", Sha256::digest(contents));
        if actual_hash != expected_hash {
            panic!("{}", failure());
        }
    }
    for library in manifest["libraries"]
        .as_array()
        .unwrap_or_else(|| panic!("{}", failure()))
    {
        let name = library["licenseFileName"]
            .as_str()
            .unwrap_or_else(|| panic!("{}", failure()));
        let expected_hash = library["licenseSha256"]
            .as_str()
            .unwrap_or_else(|| panic!("{}", failure()));
        let contents = std::fs::read(heif_dir.join("licenses").join(name))
            .unwrap_or_else(|_| panic!("{}", failure()));
        let actual_hash = format!("{:x}", Sha256::digest(contents));
        if actual_hash != expected_hash {
            panic!("{}", failure());
        }
    }
    if let Some(headers) = manifest["headerChecks"].as_object() {
        for (relative, expected_text) in headers {
            let header = std::fs::read_to_string(heif_dir.join(relative))
                .unwrap_or_else(|_| panic!("{}", failure()));
            let expected_text = expected_text
                .as_str()
                .unwrap_or_else(|| panic!("{}", failure()));
            if !header.contains(expected_text) {
                panic!("{}", failure());
            }
        }
    } else {
        panic!("{}", failure());
    }
}
