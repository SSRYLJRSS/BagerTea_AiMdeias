//! 性能探针：用老板真实文件测图像引擎各路径耗时
//! 运行：cargo test --test perf_probe -- --ignored --nocapture

use std::path::Path;
use std::time::Instant;

use bagertea_ai_media_v2_lib::services::imaging;

#[test]
#[ignore = "手动性能探针"]
fn probe_real_files() {
    let cases = [
        (r"F:\pictures\20260726\_1091370.JPG", "相机 JPG"),
        (r"F:\pictures\20260726\_1091370.RW2", "松下 RW2"),
    ];
    for (path, label) in cases {
        let p = Path::new(path);
        if !p.exists() {
            println!("{label}: 文件不存在，跳过");
            continue;
        }

        let t = Instant::now();
        let emb = imaging::embedded_preview(p);
        println!("{label} 内嵌提取: {:?} → {}", t.elapsed(), emb.as_ref().map(|b| format!("{}KB", b.len() / 1024)).unwrap_or("无".into()));

        let t = Instant::now();
        let thumb = imaging::decode_thumb(p, 320);
        println!("{label} decode_thumb(320): {:?} → {:?}", t.elapsed(), thumb.as_ref().map(image::GenericImageView::dimensions));

        let t = Instant::now();
        let hd = imaging::decode_thumb(p, 1280);
        println!("{label} decode_thumb(1280): {:?} → {:?}", t.elapsed(), hd.as_ref().map(image::GenericImageView::dimensions));

        let t = Instant::now();
        let full = image::open(p).ok();
        println!("{label} 全解码(对照): {:?} → {:?}\n", t.elapsed(), full.as_ref().map(image::GenericImageView::dimensions));
    }
}

#[test]
#[ignore = "手动诊断"]
fn probe_exif_error() {
    let p = r"F:\pictures\20260726\_1091370.JPG";
    let f = std::fs::File::open(p).unwrap();
    match exif::Reader::new().read_from_container(&mut std::io::BufReader::new(f)) {
        Ok(ex) => {
            for tag in [exif::Tag::JPEGInterchangeFormat, exif::Tag::JPEGInterchangeFormatLength] {
                println!("THUMB  {:?}: {:?}", tag, ex.get_field(tag, exif::In::THUMBNAIL).map(|f| &f.value));
                println!("PRIM   {:?}: {:?}", tag, ex.get_field(tag, exif::In::PRIMARY).map(|f| &f.value));
            }
        }
        Err(e) => println!("kamadak 解析失败: {e}"),
    }
}

/// F06：100 张混合格式占位层解码吞吐（合成样本，模拟入库占位图阶段）
#[test]
#[ignore = "手动性能探针"]
fn probe_mixed_decode_throughput() {
    use image::{ImageBuffer, Rgb};
    let dir = std::env::temp_dir().join(format!("bagertea_perf_{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let img = image::DynamicImage::ImageRgb8(ImageBuffer::from_fn(2400, 1600, |x, y| {
        Rgb([(x % 256) as u8, (y % 256) as u8, 128u8])
    }));
    let exts = ["jpg", "png", "webp", "bmp", "tga", "tif"];
    let mut files = Vec::new();
    for i in 0..100 {
        let ext = exts[i % exts.len()];
        let p = dir.join(format!("mix_{i}.{ext}"));
        img.save(&p).unwrap();
        files.push(p);
    }

    let t = Instant::now();
    let mut ok = 0usize;
    for p in &files {
        if imaging::decode_thumb(p, 320).is_some() {
            ok += 1;
        }
    }
    let total = t.elapsed();
    println!(
        "混合占位层解码: {ok}/100 出图，总耗时 {:?}，均 {:?}/张",
        total,
        total / 100
    );
    std::fs::remove_dir_all(&dir).ok();
}

/// F06：真实素材库 RAW 走查（默认 F:\pictures\20260726，不存在则提示）
/// 逐文件：内嵌提取 + 占位层 + 高清层耗时，汇总后验证零黑图
#[test]
#[ignore = "手动性能探针（需真实样本）"]
fn probe_raw_library_walk() {
    let dir = Path::new(r"F:\pictures\20260726");
    if !dir.exists() {
        println!("样本目录不存在: {dir:?}，请老板提供 RW2/CR3/NEF/ARW/HEIC 后再跑");
        return;
    }
    let mut n_ok = 0usize;
    let mut n_fail = 0usize;
    let mut entries: Vec<_> = std::fs::read_dir(dir)
        .map(|rd| rd.filter_map(|e| e.ok()).map(|e| e.path()).collect())
        .unwrap_or_default();
    entries.sort();
    for p in entries {
        let ext = p.extension().and_then(|e| e.to_str()).unwrap_or_default();
        if bagertea_ai_media_v2_lib::utils::mime::asset_type_from_ext(ext) != Some("image") {
            continue;
        }
        let t = Instant::now();
        let ph = imaging::decode_thumb(&p, 320);
        let t_ph = t.elapsed();
        let t = Instant::now();
        let hd = imaging::decode_thumb(&p, 1280);
        let t_hd = t.elapsed();
        match (&ph, &hd) {
            (Some(_), _) => n_ok += 1,
            (None, Some(_)) => n_ok += 1,
            (None, None) => n_fail += 1,
        }
        println!(
            "{} 占位 {:?}({}) 高清 {:?}({})",
            p.file_name().unwrap_or_default().to_string_lossy(),
            t_ph,
            if ph.is_some() { "✓" } else { "×" },
            t_hd,
            if hd.is_some() { "✓" } else { "×" }
        );
    }
    println!("走查汇总: {n_ok} 出图 / {n_fail} 黑图（黑图须逐一归因）");
}
