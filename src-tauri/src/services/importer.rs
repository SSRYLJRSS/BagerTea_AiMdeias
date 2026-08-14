//! 入库管线（架构 §4.1）：
//! 扫描（目录递归）→ 路径/hash 去重 → 元数据（图片读头尺寸；视频 ffprobe 尽力而为）
//! → 事务写库（每 500 条 commit，FTS 触发器同步）→ 占位缩略图 → 进度回调。
//! 进度通过回调上报，command 层包成 app.emit 事件（服务与 IPC 解耦，可单测）。
//!
//! B01 重构：阶段②拆为②a（锁外 rayon 并行处理：复制+元数据提取）+ ②b（短锁批量写库）。
//! 慢 IO（fs::copy / ffprobe / EXIF）不再持库锁，导入期间 list/get 等查询不阻塞。

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::Mutex;

use rayon::prelude::*;
use rusqlite::Connection;
use serde::Serialize;
use walkdir::WalkDir;

use super::thumbnail::ThumbnailService;
use super::{dedup, exif_meta, video};
use crate::db::assets::{self, ImportResult};
use crate::error::{AppError, AppResult};
use crate::utils::{mime, path};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportProgress {
    pub current: i64,
    pub total: i64,
    pub file: String,
}

/// 展开输入路径为候选文件列表（目录递归 + 类型过滤）
fn collect_files(paths: &[String]) -> Vec<PathBuf> {
    let mut out = Vec::new();
    for p in paths {
        let pb = PathBuf::from(p);
        if pb.is_dir() {
            for e in WalkDir::new(&pb).follow_links(false).into_iter().flatten() {
                if e.file_type().is_file() && is_supported(e.path()) {
                    out.push(e.path().to_path_buf());
                }
            }
        } else if pb.is_file() && is_supported(&pb) {
            out.push(pb);
        }
    }
    out
}

fn is_supported(p: &Path) -> bool {
    p.extension()
        .and_then(|e| e.to_str())
        .and_then(mime::asset_type_from_ext)
        .is_some()
}

/// 入库选项（R-32 总库/分库托管）
#[derive(Debug, Clone, Default)]
pub struct ImportOptions {
    /// 总库根目录；空 = 原位索引模式
    pub library_root: Option<String>,
    /// 分库名称（总库下新建子文件夹）
    pub collection: Option<String>,
    /// 批量改名模板：{分库} {原名} {日期} {序号} / {序号:N} 补零；None = 不改名
    pub rename_pattern: Option<String>,
}

/// 渲染改名模板（不含扩展名）；非法字符转下划线，空结果回退原名
fn render_name(
    template: &str,
    collection: &str,
    orig_stem: &str,
    mtime_ms: i64,
    seq: usize,
) -> String {
    let date = {
        let secs = mtime_ms / 1000;
        // 本地时区日期（符合用户直觉）
        let dt = chrono::DateTime::from_timestamp(secs, 0)
            .map(|d| d.with_timezone(&chrono::Local))
            .unwrap_or_default();
        dt.format("%Y%m%d").to_string()
    };
    let mut out = template.to_string();
    // {序号:N} 补零格式先于 {序号} 处理（中文占位符多字节，按完整 token 截取）
    while let Some(start) = out.find("{序号:") {
        let rest = out[start..].to_string();
        let Some(rel_end) = rest.find('}') else { break };
        let inner = &rest["{序号:".len()..rel_end];
        let width: usize = inner.parse().unwrap_or(3);
        out = out.replacen(&rest[..rel_end + 1], &format!("{seq:0width$}"), 1);
    }
    out = out
        .replace("{分库}", collection)
        .replace("{原名}", orig_stem)
        .replace("{日期}", &date)
        .replace("{序号}", &seq.to_string());
    // 文件名非法字符净化（含路径分隔符，杜绝穿越）
    let sanitized: String = out
        .chars()
        .map(|c| {
            if "<>:\"/\\|?*..".contains(c) && c != '.' {
                '_'
            } else {
                c
            }
        })
        .collect();
    let sanitized = sanitized
        .replace("..", "_")
        .trim()
        .trim_matches('.')
        .to_string();
    if sanitized.is_empty() {
        orig_stem.to_string()
    } else {
        sanitized
    }
}

/// 校验分库名：禁止路径穿越/分隔符（PRD R-32）
fn validate_collection(name: &str) -> AppResult<()> {
    let n = name.trim();
    if n.is_empty() || n.contains("..") || n.contains('/') || n.contains('\\') || n.contains(':') {
        return Err(AppError::msg("非法分库名称"));
    }
    Ok(())
}

/// 托管模式：复制源文件到 总库/分库/（可选批量改名），返回入库用路径
/// B06a：同名冲突循环耗尽（999）时报错而非静默覆盖已有文件
fn stage_file(file: &Path, opts: &ImportOptions, seq: usize) -> AppResult<PathBuf> {
    let root = opts.library_root.as_deref().unwrap_or_default().trim();
    if root.is_empty() {
        return Ok(file.to_path_buf());
    }
    let collection = opts.collection.as_deref().unwrap_or_default().trim();
    if !collection.is_empty() {
        validate_collection(collection)?;
    }
    let dest_dir = if collection.is_empty() {
        PathBuf::from(root)
    } else {
        PathBuf::from(root).join(collection)
    };
    std::fs::create_dir_all(&dest_dir)?;

    let ext = file
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or_default();
    let base_name = if let Some(tpl) = &opts.rename_pattern {
        let orig_stem = file
            .file_stem()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned();
        let mtime = file
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        format!(
            "{}.{ext}",
            render_name(tpl, collection, &orig_stem, mtime, seq)
        )
    } else {
        file.file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned()
    };
    // 同名冲突加 (n) 后缀
    let mut dest = dest_dir.join(&base_name);
    if dest.exists() {
        let stem = Path::new(&base_name)
            .file_stem()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned();
        for i in 1..1000 {
            let c = dest_dir.join(format!("{stem}({i}).{ext}"));
            if !c.exists() {
                dest = c;
                break;
            }
            // B06a：同名冲突耗尽时报错，不再回退覆盖已有文件
            if i == 999 {
                return Err(AppError::msg(format!("同名文件过多: {base_name}")));
            }
        }
    }
    std::fs::copy(file, &dest)?;
    Ok(dest)
}

// ── B01：元数据提取与回写（拆自原 import_one） ──

/// 锁外提取的元数据（image_dimensions + EXIF + ffprobe）
struct AssetMeta {
    width: Option<i64>,
    height: Option<i64>,
    duration_ms: Option<i64>,
    video_codec: Option<String>,
    audio_codec: Option<String>,
    exif: Option<exif_meta::ExifData>,
}

impl Default for AssetMeta {
    fn default() -> Self {
        Self {
            width: None,
            height: None,
            duration_ms: None,
            video_codec: None,
            audio_codec: None,
            exif: None,
        }
    }
}

/// B01：从已复制文件提取元数据（锁外，②a 阶段调用）
fn extract_meta(file: &Path, mime_type: &str) -> Option<AssetMeta> {
    let mut meta = AssetMeta::default();
    let mut has_any = false;
    if mime_type.starts_with("image/") {
        if let Ok((w, h)) = image::image_dimensions(file) {
            meta.width = Some(w as i64);
            meta.height = Some(h as i64);
            has_any = true;
        }
        let ex = exif_meta::extract(file);
        if ex.camera.is_some() || ex.taken_at.is_some() || ex.aperture.is_some() {
            meta.exif = Some(ex);
            has_any = true;
        }
    } else if mime_type.starts_with("video/") {
        if let Some(vm) = video::probe(file) {
            meta.width = vm.width;
            meta.height = vm.height;
            meta.duration_ms = vm.duration_ms;
            meta.video_codec = vm.video_codec;
            meta.audio_codec = vm.audio_codec;
            has_any = true;
        }
    }
    if has_any {
        Some(meta)
    } else {
        None
    }
}

/// B01：元数据回写库（②b 阶段，事务内调用）
fn write_meta(
    conn: &Connection,
    id: i64,
    meta: &Option<AssetMeta>,
    mime_type: &str,
) -> AppResult<()> {
    let Some(m) = meta else {
        return Ok(());
    };
    if mime_type.starts_with("image/") {
        if let (Some(w), Some(h)) = (m.width, m.height) {
            conn.execute(
                "UPDATE assets SET width = ?1, height = ?2 WHERE id = ?3",
                rusqlite::params![w, h, id],
            )?;
        }
        if let Some(ex) = &m.exif {
            assets::set_exif(
                conn,
                id,
                &assets::ExifPatch {
                    camera: ex.camera.as_deref(),
                    lens: ex.lens.as_deref(),
                    iso: ex.iso,
                    aperture: ex.aperture,
                    shutter: ex.shutter.as_deref(),
                    focal: ex.focal,
                    taken_at: ex.taken_at,
                },
            )?;
        }
    } else if mime_type.starts_with("video/") {
        conn.execute(
            "UPDATE assets SET width=?1, height=?2, duration_ms=?3, video_codec=?4, audio_codec=?5 WHERE id=?6",
            rusqlite::params![
                m.width, m.height, m.duration_ms, m.video_codec, m.audio_codec, id
            ],
        )?;
    }
    Ok(())
}

// ── B01：②a 并行处理结果 ──

/// 锁外处理完成的文件（已复制 + 已提取元数据）
struct Processed {
    staged: PathBuf,
    hash: String,
    mime_type: String,
    norm: String,
    file_name: String,
    ext: String,
    file_size: i64,
    modified_at: i64,
    meta: Option<AssetMeta>,
}

enum ProcResult {
    New(Processed),
    Duplicate,
    Failed(String),
}

/// B01：单文件写库（insert + set_hash + write_meta），事务内调用
fn write_one(conn: &Connection, p: &Processed) -> AppResult<i64> {
    let id = assets::insert(
        conn,
        &p.norm,
        &p.file_name,
        &p.ext,
        p.file_size,
        &p.mime_type,
        p.modified_at,
    )?;
    assets::set_hash(conn, id, &p.hash)?;
    write_meta(conn, id, &p.meta, &p.mime_type)?;
    Ok(id)
}

/// 三段式入库管线（B01 重构）：
/// ① 并行算 hash（IO/CPU 密集，不占库锁）
/// ②a 锁外并行处理（rayon）：precheck 短锁 → 托管复制 → 元数据提取
/// ②b 短锁批量写库（单事务，纯 INSERT/UPDATE，毫秒级）
/// ③ 并行生成占位图（B14：循环内检查 cancel），完成后统一回写路径
pub fn import_paths<F: Fn(ImportProgress) + Sync>(
    db: &Mutex<Connection>,
    thumbs: &ThumbnailService,
    paths: &[String],
    opts: &ImportOptions,
    cancel: &AtomicBool,
    progress: F,
) -> AppResult<ImportResult> {
    // 快速失败：分库名非法直接拒绝整个批次（PRD R-32 禁路径穿越）
    if let Some(c) = &opts.collection {
        if !c.trim().is_empty() {
            validate_collection(c)?;
        }
    }
    let files = collect_files(paths);
    let total = files.len() as i64;
    let mut result = ImportResult {
        imported: 0,
        failed: 0,
        duplicates: 0,
        errors: Vec::new(),
    };
    if files.is_empty() {
        return Ok(result);
    }

    // ① 并行 hash（取消在②③阶段间生效）
    let hashes: Vec<Option<String>> = files
        .par_iter()
        .map(|f| crate::utils::hash::sha256_16(f).ok())
        .collect();

    // ②a：锁外并行处理（复制 + 元数据提取），precheck 用短锁单次查询
    let proc_done = AtomicI64::new(0);
    let processed: Vec<ProcResult> = files
        .par_iter()
        .enumerate()
        .map(|(idx, file)| {
            // B01：cancel 在②a 生效
            if cancel.load(Ordering::Relaxed) {
                return ProcResult::Failed("用户取消".into());
            }
            // 进度在②a上报（处理是慢阶段，写库是快阶段）
            let n = proc_done.fetch_add(1, Ordering::Relaxed) + 1;
            progress(ImportProgress {
                current: n,
                total,
                file: file
                    .file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .into_owned(),
            });
            let hash = match &hashes[idx] {
                None => {
                    return ProcResult::Failed(format!("{}: 读取文件失败", file.display()))
                }
                Some(h) => h.clone(),
            };
            // precheck 用短锁（单次查询，微秒级）；TOCTOU 由 UNIQUE 约束兜底
            // 注意：precheck 返回 true=新文件，false=重复
            let is_new = {
                let conn = db.lock().map_err(|_| AppError::msg("数据库锁中毒"));
                match conn {
                    Ok(c) => precheck(&c, file, &hash).unwrap_or(false),
                    Err(_) => return ProcResult::Failed("数据库锁中毒".into()),
                }
            };
            if !is_new {
                return ProcResult::Duplicate;
            }
            // 锁外：托管复制
            let staged = match stage_file(file, opts, idx + 1) {
                Ok(p) => p,
                Err(e) => return ProcResult::Failed(format!("{}: {e}", file.display())),
            };
            // 锁外：计算 DB 插入所需的路径/文件信息
            let ext = staged
                .extension()
                .and_then(|e| e.to_str())
                .unwrap_or_default()
                .to_ascii_lowercase();
            let mime_type = mime::mime_from_ext(&ext).unwrap_or_default();
            // 锁外：元数据提取（image_dimensions / EXIF / ffprobe）
            let meta = extract_meta(&staged, &mime_type);
            let norm = path::normalize_path(&staged.to_string_lossy());
            let file_name = staged
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned();
            let file_size = staged.metadata().map(|m| m.len() as i64).unwrap_or(0);
            let modified_at = staged
                .metadata()
                .and_then(|m| m.modified())
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as i64)
                .unwrap_or(0);
            ProcResult::New(Processed {
                staged,
                hash,
                mime_type,
                norm,
                file_name,
                ext,
                file_size,
                modified_at,
                meta,
            })
        })
        .collect();

    // 统计②a结果（区分取消与真实失败）
    for r in &processed {
        match r {
            ProcResult::Duplicate => result.duplicates += 1,
            ProcResult::Failed(msg) if msg == "用户取消" => {}
            ProcResult::Failed(msg) => {
                result.failed += 1;
                result.errors.push(msg.clone());
            }
            ProcResult::New(_) => {}
        }
    }

    // ②b：短锁批量写库（单事务，纯 INSERT/UPDATE，毫秒级）
    let mut pending_thumbs: Vec<(i64, PathBuf, String)> = Vec::new();
    {
        let conn = db.lock().map_err(|_| AppError::msg("数据库锁中毒"))?;
        let tx = conn.unchecked_transaction()?;
        for r in &processed {
            if let ProcResult::New(p) = r {
                // B01：UNIQUE 约束兜底 TOCTOU——单条失败不中断整批
                match write_one(&tx, p) {
                    Ok(id) => {
                        pending_thumbs.push((id, p.staged.clone(), p.mime_type.clone()));
                        result.imported += 1;
                    }
                    Err(e) => {
                        result.failed += 1;
                        result.errors.push(format!("{}: {e}", p.staged.display()));
                    }
                }
            }
        }
        tx.commit()?;
    } // 释放库锁：占位图生成不阻塞素材库查询

    // B15：取消后已写库记录仍保留（部分导入语义）
    if cancel.load(Ordering::Relaxed) {
        result.errors.push(format!(
            "用户取消（已导入 {} 条，重复 {} 条）",
            result.imported, result.duplicates
        ));
        return Ok(result);
    }

    // ③ 并行生成占位图（B14：par_iter 内检查 cancel；永不失败，失败落通用占位图）
    let thumb_total = pending_thumbs.len() as i64;
    let thumb_done = AtomicI64::new(0);
    let paths_out: Vec<(i64, PathBuf)> = pending_thumbs
        .par_iter()
        .map(|(id, file, mime_type)| {
            // B14：取消后未开始的任务快速跳过（返回空路径，后续跳过回写）
            if cancel.load(Ordering::Relaxed) {
                return (*id, PathBuf::new());
            }
            let p = thumbs.extract_placeholder(*id, file, mime_type);
            let n = thumb_done.fetch_add(1, Ordering::Relaxed) + 1;
            progress(ImportProgress {
                current: n,
                total: thumb_total,
                file: format!(
                    "缩略图 · {}",
                    file.file_name().unwrap_or_default().to_string_lossy()
                ),
            });
            (*id, p)
        })
        .collect();

    // 统一回写占位图路径（一个事务；跳过取消项的空路径）
    {
        let conn = db.lock().map_err(|_| AppError::msg("数据库锁中毒"))?;
        let tx = conn.unchecked_transaction()?;
        for (id, p) in &paths_out {
            if !p.as_os_str().is_empty() {
                assets::set_placeholder_path(&tx, *id, &p.to_string_lossy())?;
            }
        }
        tx.commit()?;
    }

    // B15：阶段③取消提示（占位图未全部生成，但库记录已写）
    if cancel.load(Ordering::Relaxed) {
        result.errors.push(format!(
            "用户取消（已导入 {} 条，部分占位图待下次浏览时补生成）",
            result.imported
        ));
        return Ok(result);
    }

    Ok(result)
}

/// 重复判定（hash 已由并行阶段算好）：true = 新文件
fn precheck(conn: &Connection, file: &Path, file_hash: &str) -> AppResult<bool> {
    let norm = path::normalize_path(&file.to_string_lossy());
    if assets::find_by_path(conn, &norm)?.is_some() {
        return Ok(false);
    }
    if dedup::hash_exists(conn, file_hash)? {
        return Ok(false);
    }
    Ok(true)
}

/// 待入库清单项（两段式入库的左侧统计，PRD v2.4）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportPlanItem {
    pub path: String,
    pub kind: String, // image|video
    pub size: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportPlan {
    pub items: Vec<ImportPlanItem>,
    pub images: i64,
    pub videos: i64,
    pub total_size: i64,
}

/// 扫描路径展开为待入库清单（不落库，仅统计）
pub fn inspect_paths(paths: &[String]) -> ImportPlan {
    let files = collect_files(paths);
    let mut plan = ImportPlan {
        items: Vec::new(),
        images: 0,
        videos: 0,
        total_size: 0,
    };
    for f in files {
        let ext = f.extension().and_then(|e| e.to_str()).unwrap_or_default();
        let kind = mime::asset_type_from_ext(ext).unwrap_or("image");
        let size = f.metadata().map(|m| m.len() as i64).unwrap_or(0);
        if kind == "video" {
            plan.videos += 1;
        } else {
            plan.images += 1;
        }
        plan.total_size += size;
        plan.items.push(ImportPlanItem {
            path: f.to_string_lossy().into_owned(),
            kind: kind.to_string(),
            size,
        });
    }
    plan
}

#[cfg(test)]
mod tests {
    use super::render_name;

    // 2026-07-27 12:00:00 UTC
    const MTIME: i64 = 1_785_225_600_000;

    #[test]
    fn default_template() {
        assert_eq!(
            render_name("{分库}_{序号:3}", "旅行", "IMG_001", MTIME, 7),
            "旅行_007"
        );
    }

    #[test]
    fn keeps_original_name() {
        assert_eq!(
            render_name("{原名}", "旅行", "IMG_001", MTIME, 1),
            "IMG_001"
        );
    }

    /// 与实现同源的期望日期（本地时区，避免 CI/本机时区差异）
    fn expected_date() -> String {
        chrono::DateTime::from_timestamp(MTIME / 1000, 0)
            .map(|d| d.with_timezone(&chrono::Local))
            .unwrap_or_default()
            .format("%Y%m%d")
            .to_string()
    }

    #[test]
    fn date_and_plain_seq() {
        assert_eq!(
            render_name("{日期}_{序号}", "", "x", MTIME, 12),
            format!("{}_12", expected_date())
        );
    }

    #[test]
    fn combo_template() {
        assert_eq!(
            render_name("{分库}-{日期}-{原名}-{序号:2}", "宠物", "P1001", MTIME, 3),
            format!("宠物-{}-P1001-03", expected_date())
        );
    }

    #[test]
    fn illegal_chars_sanitized() {
        assert_eq!(render_name("a/b\\c:d*e", "", "orig", MTIME, 1), "a_b_c_d_e");
    }

    #[test]
    fn empty_result_falls_back_to_original() {
        assert_eq!(render_name("", "", "orig", MTIME, 1), "orig");
    }
}
