# 阶段 2 报告：RAW 真实样本验收与小范围修复

> 依据：《入库标签与素材库改造开发指导书-2026-08-25.md》第 5 节（阶段 2）
> 日期：2026-08-25

## 阶段
阶段 2——RAW 真实样本验收与小范围修复

## 目标
先 spike 再决定是否改动（禁止重写解码器）；代码检查 imaging.rs 六项；对 `marker_scan_jpeg` 做有界分块读取修复；真实样本基准记录。

## 修改文件
- `src-tauri/src/services/imaging.rs`：`marker_scan_jpeg` 由无界 `std::fs::read(src)` 改为有界、分块读取——新增常量 `MARKER_SCAN_MAX_BYTES`（64MB，含注释说明）与 `MARKER_SCAN_BLOCK`（256KB）；超出上限即封顶，只扫描文件前部（内嵌预览通常位于头部），找不到返回 None 走通用占位图；不再把整个（可能数 GB 的）RAW 载入内存。保持 `embedded_preview` 策略链顺序不变（tiff → CR3 → 标记扫描）。

## 新增文件
- `src-tauri/src/services/imaging.rs` `mod tests` 追加 `marker_scan_finds_jpeg_spanning_blocks`（验证分块读取仍能完整提取跨块 JPEG）。
- `src-tauri/tests/perf_probe.rs` 追加 `probe_raw_benchmark`（§5.2 基准记录：format/file_size/resolution/embedded_preview_found/embedded_preview_ms/placeholder_ms/hd_preview_ms/failure_reason；读环境变量 `RAW_SAMPLES_DIR`，真实样本到位后跑即产出基准记录）。

## 删除文件
无。

## 前端协议变化
无。

## Rust 协议变化
无对外协议变化（仅函数内部实现）。

## 数据库迁移变化
无。

## UI 变化
无。

## 代码检查结论（指导书 §5.3）
1. **TIFF IFD 路径使用 seek + 局部读取**：`tiff_embedded_jpeg` / `locate_tiff_base` 用 `seek(SeekFrom::Start(...))` + `read_exact` 只读需要的 IFD 条目/偏移，不整读。
2. **CR3 box 路径使用 seek 跳过大 box**：`walk_isobmff` 对 mdat 等大 volume box 直接按声明长度 `seek` 跳过，绝不逐字节扫。
3. **`marker_scan_jpeg` 使用 `std::fs::read` 整文件读入**：✅ 已按指导书 §5.4 改为有界、分块读取（本阶段修改点）。
4. **高清 RAW 真解码只在 max_px>320 时执行**：`decode_thumb` 中 `if max_px > 320 { special_decode }`，占位层（≤320px）不触发真解码。
5. **全局 4 许可仍有效**：`DECODE_SEM`（MAX_PERMITS=4）保留，解码并发有界。
6. **入库占位层不误触发真解码**：占位层 max_px ≤ 320，`decode_thumb` 走 `embedded_preview`（内嵌图或占位），不进入 `special_decode`。

## 测试命令
```
cd src-tauri; cargo test --lib imaging
```

## 测试结果
- `cargo test --lib imaging`：5 项全部通过（semaphore、marker_scan_picks_largest_jpeg、marker_scan_finds_jpeg_spanning_blocks、cut_jpeg_validates_markers、cr3_walk_finds_embedded_jpeg）。

## 手动验收 / 性能探针（真实样本）
**本环境无法完成真实 RAW 样本基准**：工作区无任何真实 RAW 文件（检索 `*.cr3/*.nef/*.arw/*.raf/*.rw2/*.dng/*.cr2/*.orf/*.pef` 均为空）。指导书 §5.5 明确规定「禁止用合成 JPEG 样本代替真实 RAW 验收」，因此：
- 内嵌预览命中率、45MP 高清预览 ≤3s、六种真实 RAW 格式基准、损坏样本等，**无法在不提供真实样本的情况下记录**。
- 待提供真实 RAW 样本目录（20~30 个，覆盖 CR3/NEF/ARW/RAF/RW2/DNG，含内嵌大/小/无预览、>40MP、损坏样本）后，再一次性补全基准报告（按 §5.2 逐项记录 format/size/resolution/embedded_preview_found/ms/hd_ms/source_strategy/cache_hit/failure_reason）。

## 已知问题 / 限制
- 真实 RAW 样本基准**探针已就绪**（`probe_raw_benchmark`，按 §5.2 逐项记录），但当前环境无真实 RAW（工作区检索为空），指导书明令禁止合成样本代验，故基准记录无法实际产出。
- `cargo test` 全量并行时 `ollama_service_integration` 的 localhost MockServer 用例偶发失败（预存环境问题，与本阶段无关）。

## 下一阶段前置条件
阶段 2 代码检查 + 有界修复已完成；真实样本基准待样本到位后补做，不阻塞后续阶段。进入阶段 3（视频播放 spike）。
