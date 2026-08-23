# 第二阶段开发计划：多格式支持（RAW / TIFF / HEIC / 现代格式）

> 版本 v1.0 ｜ 2026-08-17 ｜ 定位：下一阶段（Phase 2）总纲，优先级高于原 M2（本地小模型/网盘）
> 依据：老板拍板"最重要的还是多格式支持"。本文档 = 调研结论 + 任务拆解 + 验收标准。
> 原 M2 内容（R-07 本地模型 / R-11 网盘导出）顺延为 Phase 3，见 [PROJECT_PLAN.md](PROJECT_PLAN.md)。

---

## 一、现状核查（写本文档前实测）

### 1.1 已有的底子（v2.7 全局 imaging 引擎，Phase 2 的地基）

[imaging.rs](../src-tauri/src/services/imaging.rs) 已实现**内嵌预览三级策略链**（对标 ExifTool/FastRawViewer 的做法）：

1. EXIF IFD1 ThumbnailImage（kamadak-exif，微秒级）
2. 手写 TIFF 遍历：任意 IFD 的 0x0201/0x0202 + Panasonic JpgFromRaw(0x2E)（RW2/DNG/CR2 通吃）
3. FFD8..FFD9 标记扫描兜底（取最大 JPEG 块）

双层缩略图（占位 320px / 高清 512px+）+ 4 许可解码信号量 + dev O3 profile 均已就位。

### 1.2 发现的缺口（Phase 2 要修的）

| # | 缺口 | 现状 | 影响 |
|---|---|---|---|
| D1 | **TIFF 白名单有名无实** | Cargo.toml 里 image 只有 `jpeg/png/webp` feature，**tiff feature 未启用** | .tif/.tiff 只能靠内嵌 JPEG 预览兜底；无内嵌预览的 TIFF（扫描版/PS 导出 LZW/Deflate）**完全黑图** |
| D2 | **HEIC/HEIF 同样无法解码** | image crate 根本没有 heif 解码器；仅 iPhone HEIC 常带内嵌 JPEG 可兜底 | 安卓/导出工具生成的纯 HEIC 黑图 |
| D3 | RAW 白名单不全 | 只有 raw/cr2/cr3/nef/arw/dng；**缺 raf/orf/rw2/pef/srw/x3f/mrw/nrw/iiq/3fr** 等 | 富士/奥巴/宾得等用户入库直接被拒（老板自己用的 RW2 也在缺失名单，靠硬编码路径才过的） |
| D4 | **RAW 无真解码** | 高清层只能靠内嵌预览；内嵌图缺失/过小的 RAW，高清图质量差或无图 | 查看器大图体验上限低；AI 打标用的图质量受限 |
| D5 | 无现代格式 | AVIF / JPEG XL / BMP / TGA 不支持 | iPhone 17/网页下载素材进不来 |

> 结论：**内嵌预览链是"快"的护城河，缺的是"全"——真解码兜底层**。这正是业界两级方案的形状。

---

## 二、业界调研结论（别人是怎么解决的）

### 2.1 共识：两级解码架构（所有成熟软件同款）

| 软件 | 做法 |
|---|---|
| FastRawViewer / Eagle | 秒开靠**相机内嵌预览**（相机厂商自己渲染的 JPEG，含色彩配置），不做全解码 |
| nomacs / digiKam / Magick.NET 讨论区 | LibRaw `has_thumbnail() → get_thumb()` 先出图（毫秒级），后台再全解码；"预览图对绝大多数用途已经足够" |
| RawLib（Rust 社区工具） | 只提内嵌缩略图：100 张 RAW 8 秒（12.5 张/秒），比 Lightroom 快 **10~100 倍** |
| darktable / RawTherapee | 需要真解码时用 rawspeed/LibRaw 全管线（去马赛克+白平衡+色彩矩阵） |

**与本项目的映射**：占位图 = 内嵌预览（已有，毫秒级）；高清图/查看器大图 = 真解码兜底（Phase 2 补齐）。架构不用动，只补解码器。

### 2.2 RAW 真解码候选方案对比

| 方案 | 语言/依赖 | 格式覆盖 | 许可 | 结论 |
|---|---|---|---|---|
| **rawler**（darktable 团队的 rawspeed Rust 重写，dnglab/RapidRAW 在用） | 纯 Rust | CR2/CR3/NEF/ARW/RAF/ORF/RW2/PEF/DNG/IIQ 等 25+ 厂商格式，**含 X-Trans** | GPL-3.0/LGPL-3.0 双许可 | ✅ **首选**：零 C 依赖、MSVC 直接编译、社区活跃；API 未稳定需锁版本 |
| rawloader（同作者旧作） | 纯 Rust | 较老格式，无 CR3/X-Trans | LGPL | ⚠️ 兜底补充，非主力 |
| LibRaw + Rust 绑定 | C/C++（MSVC 静态库） | 500+ 相机，业界最全 | LGPL-2.1/CDDL 双许可 | ⚠️ 备选：rawler 覆盖不了的机型再上；Windows 编译/分发成本高 |
| zenraw（imazen，2026 新） | 纯 Rust，可换后端 | 依赖 rawler/rawloader | **AGPL/商业双许可** | ❌ 许可不适合闭源分发，排除 |

> **决策记录（待 PoC 确认后定稿）**：主选 rawler；PoC 用老板真实相机样本（RW2 优先）跑通 demosaic→sRGB→缩略图全链路，并实测单张耗时。rawler 单张 45MP RAW 全解码+去马赛克预期 0.5~2s（CPU），**必须放在高清按需层，严禁进占位图路径**。

### 2.3 TIFF 方案

- **image-rs/tiff crate（纯 Rust）**：Baseline + LZW + PackBits + Deflate + 多页 + BigTIFF，随 image crate 开 `tiff` feature 即可，零新增依赖。
- 缺口：JPEG-in-TIFF、CCITT 传真压缩不支持 → 策略链兜底（TIFF 容器里的 JPEG 本来就能被现有 `tiff_embedded_jpeg` 抠出来）。
- 16bit/浮点 TIFF：解码后映射到 8bit 显示（素材库场景够用，不做 HDR 渲染）。

### 2.4 HEIC/HEIF/AVIF 方案

| 方案 | 说明 | 结论 |
|---|---|---|
| **libheif-rs**（libheif + libde265 绑定） | HEIC 解码事实标准；Windows 走 vcpkg 或 `embedded-libheif` 静态编译 feature；libde265 为 LGPL-3 可动态链接分发 | ✅ HEIC 首选 |
| Windows 系统 HEIF 解码器 | 需用户装微软扩展，不可控 | ❌ 排除 |
| AVIF：image crate `avif` feature（dav1d） | 纯 Rust 生态，8bit 解码生产可用 | ✅ 直接开 feature |

### 2.5 性能数据锚点（来自调研，验收参考）

- 内嵌缩略图提取：≤0.1s/张（RawLib 实测）——本项目策略链同量级，已有 RW2 57ms 实测
- RAW 全解码：百毫秒~秒级（机型/分辨率相关）→ 必须异步 + 信号量限流（现有 4 许可复用）
- 内存红线：50MP RAW 全解码内存占用可达数百 MB → 解码完立即缩图释放，`max_pixels` 上限防护

---

## 三、任务拆解（依赖顺序：F01 → F02 ∥ F03 → F04 → F05 → F06）

### F01：TIFF 解码 + 白名单补齐（0.5~1 天，低风险速赢）✅ 代码完成 2026-08-17

**落地实况**
- `Cargo.toml`：image features 已加 `"tiff"`、`"bmp"`、`"tga"`（**avif 缓议**：dav1d 需 NASM，同 HEIC 类编译风险，待 F02 稳定后再开）
- `utils/mime.rs`：已补 25 个 RAW 扩展名（raf/orf/rw2/pef/srw/x3f/mrw/nrw/iiq/3fr/kdc/dcr/mos/mef/erf + crw/nrw/srf/sr2/fff 等）+ bmp/tga；avif 未放行（无解码器防黑图）
- `services/imaging.rs`：无需改动（`image::open` 自动识别新格式），验证即可

**验收**（待样本）
- LZW/Deflate/无压缩 TIFF 各一张样本：缩略图正常生成
- 新扩展名文件可入库、有占位图、可搜索、可导出

### F02：HEIC / AVIF 解码接入（1~2 天）✅ 代码完成 2026-08-17（选型改道，见下）

**选型改道（实测后）**
- ❌ libheif-rs（原方案）：Windows 走 vcpkg，crate 作者自述 Windows 测试失败，风险实锤 → 放弃
- ✅ **heif-rs 26.7**（落地方案）：Apache-2.0 封装，首次构建下载预编译静态 libheif/x265/libde265（免 vcpkg）；`heif::decode(&bytes) -> DynamicImage` 与 image crate 无缝
- ❌ 纯 Rust `heic` crate：技术最优（SIMD/流式/零 C）但 **AGPL-3.0**，闭源红线一票否决
- ⚠️ heif-oxide（MIT/Apache 纯 Rust）备选：12MP 需 ~1s、Nokia 合规 44/63，仅作 heif-rs 失效时降级

**落地环境（本机 Windows，已验证编译链接全通）**
1. 预编译包 `static_windows_x64.zip` 解压到仓库根 `heif-bin/`（本机 GitHub 不通，gh-proxy 分段续传）；`src-tauri/.cargo/config.toml` 设 `HEIF_BINARIES_DIR`（relative）
2. winget 装 LLVM 22.1.8（bindgen 需要 libclang）
3. `msvc_stl_shim.cpp`（build.rs 用 cc 编译）：补 heif.lib（MSVC 14.45+ 构建）引用的 `__std_rotate`/`__std_max_element_4i`/`__std_unique_4`（本机 Build Tools 14.44 STL 缺失）；Build Tools 升级后可删

**代码**
- 新增 `services/heic_decode.rs`：128MB 大小护栏 + `heif::decode`，失败降级 None
- `imaging.rs::special_decode`：按扩展名分派（heic/heif → libheif；其余 → rawler），接在 `image::open` 失败后，仅高清层（max_px>320）

**验收**（待样本）
- iPhone HEIC（带内嵌预览）与纯 HEIC（工具生成）各一张均出图；解码耗时 ≤1s/张（12MP 基准）
- AVIF 待 image avif feature 后续开启

### F03：RAW 内嵌预览链加固（1 天，现有策略链扩展）✅ 代码完成 2026-08-17

- CR3（ISOBMFF 容器，非 TIFF）：已落地 `cr3_embedded_jpeg`——ftyp 魔数识别 → box 树遍历（moov/meta/iprp/ipco 递归，meta 为 FullBox 跳 4 字节）→ 叶子 box 验 FFD8 后抠最大 JPEG；**大 box（mdat）按声明长度 seek 跳过绝不逐字节扫**；支持 64bit largesize；深度≤8 防死循环；带合成结构单测
- 策略链现为四级：TIFF 遍历 → CR3 ISOBMFF → （jpg 禁用）标记扫描 → 真解码
- 索尼 ARW / 尼康 NEF 内嵌图偏移校验（现有 0x0201 路径应已覆盖，用真实样本验证）

**验收**（待样本）：CR3/ARW/NEF/RAF/ORF 真实样本各至少一张，占位图 320px 全部出图且 ≤100ms/张。

### F04：RAW 真解码兜底层（核心，3~5 天）✅ 代码完成 2026-08-17（PoC 过，实现简化见下）

**PoC 结论**：rawler 0.7.2 在 Windows MSVC 直编通过（零 C 依赖，无需 NASM/cmake）；Cargo.toml 锁精确版本 `=0.7.2`。

**落地实现（`services/raw_decode.rs`，与原规划的差异已记决策日志）**
- 解马赛克用 **2×2 Bayer binning**（块内按 CFA 通道归组均值）替代 AHD/Malvar 全插值：缩略图场景半分辨率足够、零伪影、内存 1/4；X-Trans（6×6）降级灰度预览
- 色彩管线：黑/白电平（`as_bayer_array()` 按块内位置查表）→ wb_coeffs（G 归一，无效回中性）→ `cam_to_xyz_normalized()` × XYZ→sRGB 矩阵 → gamma 2.2；非专业级简化显影，够用
- cpp==3 线性 RGB DNG 直转；>150MP 拒绝（内存红线）；Float RAW 降级
- `imaging.rs::decode_thumb` 第 4 级：内嵌预览不达标 → `special_decode` 按扩展名分派；**占位层（≤320px）禁用真解码**（红线已落实）
- 高清层（`get_or_create_hd`）自动受益，无需改动 thumbnail.rs

**约束（红线）**
- RAW 全解码只存在于高清按需层与查看器大图，**严禁进占位图路径**（会打爆入库速度）
- 走现有 4 许可信号量；单张解码内存上限防护（>150MP 拒绝并提示）

**验收**
- 内嵌图缺失的 RAW（构造样本）高清图由真解码生成，色彩正常（不偏色/不发灰）
- 45MP 级 RAW 高清缩略图生成 ≤3s/张（CPU，O3）；失败优雅降级不 panic

### F05：元数据与 UI 配套（1~2 天）✅ 代码完成 2026-08-17

**落地实况**
- `exif_meta.rs`：kamadak-exif 主链不变；新增 `raw_fallback`——CR3（ISOBMFF）/RW2（非标 TIFF 魔数 0x55）等 kamadak 读不到的容器，用 rawler 轻量识别（`get_decoder`+`raw_metadata`，只解元数据不解像素）补相机/镜头/ISO/光圈/快门/焦距/拍摄时间；`merge_missing` 只填 None 字段不覆盖；带垃圾数据/合并语义 3 个单测
- `AssetCard.tsx`：右上角格式角标（RAW/TIFF/HEIC，25 个 RAW 扩展名与后端 `mime.rs is_raw_ext` 同源），常见格式不打扰
- `TROUBLESHOOTING.md`：新增条目 9「某格式黑图排查路径」+ 条目 10「RAW EXIF 兜底」+ 条目 20/21（heif 环境/工具写入坑）
- 查看器 EXIF 行（`ViewerPage exifLine`）原样复用，RAW 字段自动显示，无需改动
- 设置页格式清单（原可选项）不做：白名单在 mime.rs 单点维护，不引入双数据源

**验收**（待样本）：RAW 素材详情（查看器）能显示相机/镜头/ISO；卡片有格式角标。

### F06：性能回归 + 格式矩阵测试 + 收尾（1~2 天）✅ 代码完成 2026-08-17（真实数据走查待样本）

**落地实况**
- `tests/format_matrix.rs` 6 用例全绿：白名单×is_raw_ext 一致性；6 种可编码格式×占位/高清双层出图；占位层垃圾 RAW 快速 None（红线护栏）；高清层坏文件（nef/heic/cr3）优雅降级；heic/raw 解码器护栏；截断 JPEG 不 panic；用例间临时目录隔离（并行测试踩坑已修）
- `perf_probe.rs` 新增两探针（手动 ignored）：100 张混合格式占位层吞吐；真实素材目录逐文件占位/高清走查汇总零黑图
- 三关已过：cargo test 123 通过（42 单元+13 DB+6 矩阵+53 边界+9 服务）/ tsc / vite build 2.03s
- 真实 RAW/HEIC 样本无法合成，fixtures 大文件方案改为 perf_probe 直读老板素材目录（不入库不污染）

**验收**（待样本）：格式矩阵全绿 ✅；老板真实数据集走查零黑图（`probe_raw_library_walk`）。

---

## 四、排期与里程碑

| 里程碑 | 内容 | 估时 |
|---|---|---|
| P2-M1 速赢 | F01（TIFF+白名单）| 1 天 |
| P2-M2 手机格式 | F02（HEIC/AVIF）| 1~2 天 |
| P2-M3 RAW 快通道 | F03（内嵌链加固）| 1 天 |
| P2-M4 RAW 真解码 | F04（rawler 兜底层，含 PoC）| 3~5 天 |
| P2-M5 体验配套 | F05（元数据+UI）| 1~2 天 |
| P2-M6 出口 | F06（矩阵测试+性能回归+真实数据走查）| 1~2 天 |

**总计约 2~2.5 周**。出口标准：格式矩阵测试全绿 + 老板真实素材库零黑图 + 三关通过。

## 五、风险登记（追加进 PROGRESS 第四节）

| 风险 | 等级 | 缓解/状态 |
|---|---|---|
| ~~libheif-rs Windows 编译卡壳~~ | ~~中~~ | ✅ 已消解：改道 heif-rs 预编译静态库，免 vcpkg；环境三件套见 F02 落地环境 |
| rawler API 不稳定（不守 SemVer） | 中 | ✅ 已落实：Cargo.toml 锁 `=0.7.2`；封装层隔离，只暴露 `raw_decode.rs` 一个口子 |
| RAW 全解码内存/CPU 打爆（50MP+） | 中 | ✅ 已落实：150MP 上限 + 4 许可信号量 + binning 半分辨率；入库占位路径禁用真解码 |
| X-Trans/新机型 rawler 覆盖不到 | 低 | ✅ 已落实：X-Trans 降级灰度预览 + 内嵌链兜底；极端机型再评估 LibRaw 备选 |
| GPL/LGPL 合规（rawler LGPL-3、libheif/libde265 LGPL-3 静态链接） | 中 | 内部自用可接受；**对外分发前须法务确认或改动态链接**（已记 PROGRESS 决策日志） |
| heif-rs 预编译库与本机 STL ABI 错位（未来 Build Tools 升级后 shim 符号重复） | 低 | shim 头注已写删除条件；升级 14.45+ 后删 msvc_stl_shim.cpp + build.rs cc 段 |

## 六、决策日志条目（已同步到 PROGRESS 第三节）

- 2026-08-17 ｜ Phase 2 改为多格式支持优先（老板拍板），原 M2（本地模型/网盘）顺延 Phase 3
- 2026-08-17 ｜ 多格式两级架构定案：内嵌预览链（快）+ 真解码兜底层（全），对齐 FastRawViewer/Eagle/nomacs 业界共识
- 2026-08-17 ｜ 修复 D1：image crate tiff feature 此前未启用，TIFF 白名单形同虚设
- 2026-08-17 ｜ F02 选型改道 libheif-rs → heif-rs；AGPL `heic` crate 一票否决
- 2026-08-17 ｜ F04 demosaic 简化为 2×2 Bayer binning（缩略图场景最优）；AVIF 缓议（dav1d/NASM）

## 七、S0 真实样本验收走查清单（待老板提供样本）

自动化探针已就位（均手动 ignored，样本到位后执行）：

```powershell
# 真实素材库逐文件走查（占位/高清耗时 + 零黑图汇总，默认目录 F:\pictures\20260726）
cargo test -p bagertea_ai_media_v2 --test perf_probe probe_raw_library_walk -- --ignored --nocapture
# 100 张混合格式占位层吞吐
cargo test -p bagertea_ai_media_v2 --test perf_probe probe_mixed_decode_throughput -- --ignored --nocapture
```

人工走查（每格式一条记录入 PROGRESS 决策日志）：

| 格式 | 检查项 |
|---|---|
| RW2 / CR3 / NEF / ARW | 占位图 ≤100ms；高清层出图；色彩不偏灰；卡片 RAW 角标；查看器 EXIF（相机/ISO/镜头） |
| HEIC（含无内嵌 JPEG 的纯 HEIC） | 出图不黑；无内嵌时 heif 解码生效 |
| TIFF（LZW/Deflate，无内嵌预览） | 出图不黑；16bit 映射 8bit 显示正常 |
| 全格式 | 入库零黑图；损坏文件优雅降级不崩 |

失败样本归因登记走 TROUBLESHOOTING.md；全部通过后 PROGRESS 看板勾选并关闭 Phase 2。

## 八、引用（调研来源）

- rawler / dnglab：https://github.com/dnglab/dnglab （支持格式清单 SUPPORTED_CAMERAS）
- RapidRAW（rawler 生产应用案例，Tauri+Rust）：https://github.com/CyberTimon/RapidRAW
- LibRaw 官方：https://www.libraw.org/ （许可 LGPL-2.1/CDDL；内嵌预览 API）
- RawLib（Rust+LibRaw 内嵌缩略图性能数据）：https://lib.rs/crates/rawlib
- image-rs 0.25 格式矩阵：https://github.com/image-rs/image
- heif-rs（F02 落地选型）：https://lib.rs/crates/heif-rs ；预编译二进制：https://github.com/vegidio/binaries-heif
- heic（纯 Rust，AGPL 排除）：https://docs.rs/heic ；heif-oxide（备选）：https://lib.rs/crates/heif-oxide
- nomacs RAW 两级预览实现分析（CSDN 项目实战系列）
