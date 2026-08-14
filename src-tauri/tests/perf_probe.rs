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
