# 茶包素材 BagerTea AiMdeias V2 — 开发进度跟踪

> **基线版本**：PRD v2.3 ｜ 架构 v1.3（均已冻结，改动须先改文档再改代码）
> **本文档定位**：唯一进度事实来源。每完成一个任务/子项就更新勾选与日期；每个偏离文档的决策先记「决策日志」再动手。
> **更新规则**：① 勾选 = 验收标准全部通过才算；② 日期 + 一句话备注；③ 新增风险随时登记；④ 每次开工前先看「当前焦点」。

---

## 一、当前焦点

- **正在做**：Phase 3 AI 与体验增强（老板 2026-08-18 拍板：网盘暂缓，其余按计划开工），总纲见 [PHASE3_AI_EXPORT.md](PHASE3_AI_EXPORT.md)
- **已完成**：Phase 2 代码层全部完成（F01~F06，三关全绿）
- **下一步**：P3-01a（本地 Ollama 兼容端点打标）→ P3-02（视频抽帧打标）→ v2.15 M3 体验完善 → v2.16 P2 打包
- **阻塞项**：Phase 2 真实样本验收需老板提供样本；云端端到端需视觉模型 Key

---

## 二、任务看板（依赖：T01→T02→T03→{T04 ∥ T05a}→T05b）

### M1 核心闭环（P0）

| 任务 | 内容 | 验收关键项 | 状态 | 完成日期 |
|---|---|---|---|---|
| **T01** | 项目基础设施 | `npm run tauri dev` 空壳启动；底栏 3 文字按钮占位；`cargo check` 通过；Tailwind v4（@tailwindcss/vite，无 config 文件） | ☑ 已完成 | 2026-08-08 |
| **T02** | 数据层（DB+类型+API 封装） | 建表迁移含 **fts_content + 9 个触发器 + cjk_bigram 注册 + PRAGMA foreign_keys=ON**；`cargo test` 覆盖 tags 递归计数/assets 分页/FTS 查询（含中文：词中子串可查、短语无误命中、摘标签无幻影）；`tsc` 通过 | ☑ 已完成 | 2026-08-08（13/13 通过） |
| **T03** | 核心服务 + Commands | 导入 100 图+视频后**每张立即有占位图**；搜索并入 list_assets；删除双策略同步清理两层缩略图；滚动触发高清生成且二次命中缓存；导出文件完整 | ☑ 已完成 | 2026-08-08（服务集成 4/4 通过，总计 17/17） |
| **T04** | 前端核心 UI | 符合 PRD 5.2 信息架构；3 万素材滚动流畅；搜索防抖；删除/导出弹窗交互完整；双层缩略图淡入替换 | ☑ 已完成 | 2026-08-08（tsc+build+冒烟通过；3 万条性能验收待真实数据集回归） |
| **T05a** | 云端 AI 打标 + 确认流（R-06 提前） | 云端跑通「建批次→建议→确认→可检索」；确认后新标签可被 FTS 搜到 | ☑ 已完成 | 2026-08-08（链路+测试 24/24 通过；真实 API 端到端待老板配置 Key 后走查） |

### M2 AI 与导出增强（P1，顺延 Phase 3）

| 任务 | 内容 | 验收关键项 | 状态 | 完成日期 |
|---|---|---|---|---|
| **T05b** | 本地小模型 + 网盘导出 + 端到端 | 模型下载断点续传 + sha256 校验（HF 镜像/国内 CDN）；本地模式全链路；百度 OAuth（如资质允许）；端到端回归 | ☐ 未开始 | |

### Phase 2 多格式支持（老板拍板提前，依赖：F01 → F02∥F03 → F04 → F05 → F06）

| 任务 | 内容 | 验收关键项 | 状态 | 完成日期 |
|---|---|---|---|---|
| **F01** | TIFF 解码 + 格式白名单补齐 | image 加 tiff/bmp/tga feature（avif 因 dav1d/NASM 风险缓议）；mime.rs 补 25 个 RAW 扩展名；LZW/Deflate TIFF 出图 | ☑ 代码完成（样本待验） | 2026-08-17 |
| **F02** | HEIC/AVIF 解码接入 | 方案改 heif-rs（预编译静态库，免 vcpkg）；纯 HEIC 出图；AVIF 随 image avif feature 后续 | ☑ 代码完成（样本待验） | 2026-08-17 |
| **F03** | RAW 内嵌预览链加固 | CR3（ISOBMFF）分支落地 + 单测；ARW/NEF/RAF/ORF 真实样本占位图 ≤100ms | ☑ 代码完成（样本待验） | 2026-08-17 |
| **F04** | RAW 真解码兜底层 | rawler 0.7.2 PoC 过（MSVC 直编）；raw_decode.rs（2×2 Bayer binning+色彩管线）；只进高清层；45MP ≤3s；色彩不偏灰 | ☑ 代码完成（样本待验） | 2026-08-17 |
| **F05** | 元数据与 UI 配套 | RAW EXIF 验证；卡片格式角标；排查文档 | ☑ 代码完成（样本待验） | 2026-08-17 |
| **F06** | 格式矩阵测试 + 性能回归 | format_matrix.rs 全绿；老板真实素材库零黑图；三关通过 | ☑ 代码完成（矩阵全绿+三关过，真实数据走查待样本） | 2026-08-17 |

### Phase 3 AI 与体验增强（老板 2026-08-18 拍板，网盘暂缓，依赖：P3-01a → P3-02 → M3 系 → P2 系）

| 任务 | 内容 | 验收关键项 | 状态 | 完成日期 |
|---|---|---|---|---|
| **P3-01a** | 本地 Ollama 兼容端点打标 | profiles 加 kind（cloud/local）；前端档案编辑支持本地端点；ai_start_batch 放开 local；无服务报错含引导 | ☑ 代码完成 | 2026-08-18 |
| **P3-02** | 视频 AI 打标（R-15） | 开关默认关；抽头/中/尾三帧；≥2 帧命中才进建议；抽帧失败置 rejected | ☑ 代码完成 | 2026-08-18 |
| **M3-01** | 标签管理（R-19） | merge/reparent 防环；前端管理视图；计数/FTS 一致 | ☑ 代码完成 | 2026-08-18 |
| **M3-02** | 重复素材检测（R-20） | hash 分组扫描 + 前端去重面板 | ☑ 代码完成 | 2026-08-18 |
| **M3-03** | 详情页增强（R-18） | ViewerPage 抽屉：标签 + EXIF/元数据 | ☑ 代码完成 | 2026-08-18 |
| **M3-04** | 批量操作增强（R-17） | 移动入口 + BottomBar 任务条 | ☑ 代码完成 | 2026-08-18 |
| **S3** | P2 打包（R-21/22/24/25/26） | 排序筛选/回收站/主题/打标历史/导出增强，见 PHASE3 拆解 | ☑ 代码完成（三关全绿：cargo test 128 过/tsc/vite 1.6s） | 2026-08-18 |
| **A2** | Ollama 一键配置（P3-01a 体验增强） | 检测 + 显存推荐 + 一键 pull + 自动写回 model，见 LOCAL_MODEL_AUTOCONFIG_A2.md | ☑ 代码完成（三关全绿：cargo test 131 过/tsc/vite） | 2026-08-19 |
| **A3** | 本地模型应用内全自动一键部署（A2 增强版） | 设置页独立入口 + 应用内下载 Ollama（多源降级/断点续传）→ 静默安装 → 就绪复检 → 一键拉取配置，见 LOCAL_MODEL_SETUP_A3.md | ☑ 代码完成（三关全绿：cargo test 136 过/tsc/vite） | 2026-08-20 |

**M1 出口标准**（全部满足才算 M1 交付）：T01~T05a 全勾 + PRD P0 需求（R-01~R-06、R-08~R-10、R-12~R-14、R-31）逐条走查通过。

---

## 三、决策日志（新决策追加在顶部）

| 日期 | 决策 | 原因/依据 |
|---|---|---|
| 2026-08-20 | **A3 本地模型应用内一键部署交付**：设置页左侧新增「本地模型」独立分组（GROUPS 第二项，向导卡片三态：未安装→一键安装 Ollama；已装未运行→启动并复检；就绪→显存推荐一键拉取并配置、自动建本地档案并置激活）；后端 services/ollama_installer.rs（detect_installed 查默认目录+PATH、resolve_sources 官方→gh-proxy→GitHub 三源降级、download 带 Range 断点续传+500ms 节流进度+体积校验（无稳定 sha256）、install_silent 静默参数集中常量、wait_ready 轮询 /api/version 最长 30s、start_service 无窗口拉起 serve）+ 四命令 ollama_install_status/download_install/start_service/remove_installer（事件 `ollama://install-progress`）；拉取状态机抽 useOllamaPull 供档案编辑区与向导卡片共用同一套事件；安装包落 $APP_DATA_DIR/bagertea_ai_media_v2/ollama/ 保留供离线重装，「数据与缓存」分组显示占用可清理 | 老板 2026-08-20 两点反馈：入口太深（藏在档案编辑表单）要独立入口；不要用户官网下载要应用内全自动。取舍：选 Setup.exe 路线（免管理员+装完自启+官方自升级）而非便携 zip（生命周期/自启/托盘全自管成本高）；安装退出码 0/1 均视为可接受（1=重启挂起），最终以 wait_ready 复检为准；复用 A2 的 ollama_setup 全部能力零重复开发 |
| 2026-08-19 | A2 Ollama 一键配置交付：services/ollama_setup.rs（api_root 剥离 /v1 + ping/probe_gpu/recommend/pull 纯函数）+ ollama_cmd 四命令（事件 `ollama://pull-progress`）；推荐档 qwen2.5vl:3b/7b；拉取成功由前端写回 draft（后端不碰 settings 表单数据源）；设置页删 switchKind 硬编码 llava 预填；评审否决方案 A 并留档 LOCAL_MODEL_AUTOCONFIG_A2.md §9（修正三硬伤：模型名 qwen2.5-vl→qwen2.5vl、/api/* 在根路径非 /v1 下、Win32 AdapterRAM 32 位上限 4GB 改 nvidia-smi 优先探不到不猜） | 老板要求小白一键部署本地模型；方案 A 评审实测硬伤；tauri-plugin-opener 走 OpenerExt trait 方法（非自由函数），Rust 直调免 capabilities |
| 2026-08-18 | S3 P2 打包五项交付：R-21 AssetFilter 加 sort_by/sort_dir/tags_mode（any\|all，EXISTS 子查询防 JOIN 爆炸），taken_at/resolution 缺值排最后；R-22 回收站改软删（assets.deleted_at，「仅移出库」走软删保留缩略图，启动时后台线程按 trashRetentionDays 清超期，彻底删除文件失败保留 DB 记录沿用 B03）；R-24 主题落 data-theme（light/dark/system，media query 只管 system/缺失，组件零改动兑现 T01 架构承诺）；R-25 新表 tag_ops 流水（挂/摘都记，actor 溯源 AI/manual，撤销=按 batch_id 倒序反向且幂等、反向操作不再写流水）；R-26 导出 layout（flat/by_tag/by_date 子目录）+ CSV 清单（UTF-8 BOM 保 Excel）；收尾同步旧测试（export_local 补 layout 参、AssetFilter 字面量补 default、user_version 断言 3→5），全套 128 项全绿 | 计划 S3 拆解；关键取舍：回收站复用 trashOnly 筛选不建独立页、彻底删除复用 DeleteDialog purgeOnly 模式、撤销不写新流水保持幂等 |
| 2026-08-18 | M3 体验完善四项交付：M3-01 标签管理（merge 单事务改挂+删除、reparent 递归 CTE 防环）；M3-02 重复检测（hash GROUP BY HAVING>1 扫描 + 分组去重面板，保留最早高亮）；M3-03 ViewerPage 详情抽屉（标签增删 + EXIF/元数据三段式）；M3-04 批量移动入口 + BottomBar 全局任务条聚合既有事件 | 计划 M3 拆解；均无新后端依赖面，复用现有事件/确认流 |
| 2026-08-18 | P3-01a/P3-02 交付：本地打标走档案 kind 字段（迁移默认 cloud 旧数据零感知），ai_cloud.rs 零改动靠 OpenAI 兼容协议直通 Ollama；视频打标设置开关默认关，抽头/中/尾三帧、≥2 帧命中标签才进建议，抽帧失败置 rejected 不阻塞批次 | P3-01a 速赢路线调研结论；P3-02 频次合并防单帧噪声 |
| 2026-08-18 | Phase 3 开工：本地打标走「Ollama 兼容端点速赢（P3-01a）+ ort 内嵌机动（P3-01b）」两步；网盘导出（R-11/R-16）整体暂缓入机动项；v2.15 M3 体验完善、v2.16 P2 打包排入承诺 | 老板拍板「先不做网盘的东西，其他的按计划开始」；调研：ai_cloud.rs 已是 OpenAI 兼容客户端，Ollama/LM Studio 零改动接入；百度分享接口仅企业开发者可用，详见 PHASE3_AI_EXPORT.md |
| 2026-08-17 | F05/F06 代码层完成：EXIF 兜底用 rawler 轻量识别（get_decoder+raw_metadata，只解元数据不解像素，只填 None 字段）；AssetCard 右上角格式角标（RAW/TIFF/HEIC，与 mime.rs 同源）；format_matrix 6 用例（白名单/格式×层级/占位层红线/降级护栏/截断宽容）+ perf_probe 新增混合吞吐与真实库走查探针；三关全绿（cargo test 123 通过/tsc/vite 2.03s） | Phase 2 仅剩真实样本验收；测试并行踩坑（共享临时目录）已改用例隔离并记 TROUBLESHOOTING |
| 2026-08-17 | F02 选型改道：放弃 libheif-rs（vcpkg，作者自述 Windows 测试失败），改用 **heif-rs**（Apache-2.0 封装 + 预编译静态 libheif/x265/libde265，免 vcpkg）；纯 Rust `heic` crate 技术最优但 **AGPL-3.0 一票否决**（与 zenraw 同红线）；heif-oxide（MIT/Apache）12MP 需 ~1s 且 44/63 合规率，备选 | 调研实测：heif-rs 提供 static_windows_x64.zip；AGPL 传染闭源桌面软件不可接受 |
| 2026-08-17 | heif-rs 环境三件套：① 二进制手动下载（本机 GitHub 不通，gh-proxy 分段续传）解压到 `heif-bin/`，`.cargo/config.toml` 设 HEIF_BINARIES_DIR；② winget 装 LLVM 22.1.8 供 bindgen（libclang）；③ **msvc_stl_shim.cpp** 补齐 heif.lib（MSVC 14.45+ 构建）引用的 `__std_rotate`/`__std_max_element_4i`/`__std_unique_4`（本机 Build Tools 14.44 STL 缺失），Build Tools 升 14.45+ 后可删 | 链接实测 LNK2019；shim 按 MSVC STL ABI 语义实现，见文件头注 |
| 2026-08-17 | F04 缩略图解码用 **2×2 Bayer binning**（块内按 CFA 通道归组均值）替代完整 demosaic：半分辨率零插值伪影、1/4 内存，512/1920px 目标绰绰有余；X-Trans 降级灰度预览；色彩管线简化显影（黑白电平→wb_coeffs→cam2xyz→sRGB→gamma 2.2）非专业级 | 缩略图场景不需 AHD/Malvar 全插值；binning 天然抗锯齿 |
| 2026-08-17 | F01 AVIF 缓议：image 0.25 的 avif feature 依赖 dav1d（C 库，Windows 需 NASM），与 HEIC 同类编译风险，待 F02 稳定后再开；白名单不放行 avif（防黑图入库） | D5 降级处理，风险登记见 PHASE2_FORMATS.md |
| 2026-08-17 | LGPL-3 静态链接合规登记：heif.lib/libde265/x265 静态链入闭源应用，合规需「提供目标文件/允许用户替换库」；内部自用工具风险可接受，**对外分发前须法务确认**（或改动态链接分发） | LGPL-3 静态链接条款；rawler 为 GPL-3/LGPL-3 同样登记 |
| 2026-08-17 | Phase 2 改为多格式支持优先（RAW/TIFF/HEIC/AVIF），原 M2（本地模型/网盘）顺延 Phase 3 | 老板拍板"最重要的还是多格式支持"；调研结论与任务拆解见 PHASE2_FORMATS.md |
| 2026-08-17 | 多格式两级架构定案：内嵌预览链（快，已有）+ 真解码兜底层（全，新建 raw_decode.rs），对齐 FastRawViewer/Eagle/nomacs 业界共识 | 调研：业界清一色"内嵌预览秒开 + 后台真解码"；RawLib 实测内嵌提取比全解码快 10~100 倍 |
| 2026-08-17 | RAW 真解码选型：rawler（darktable 系，纯 Rust）首选，LibRaw 备选，zenraw 因 AGPL 排除；需 PoC 验证 MSVC 编译 + LGPL 静态链接合规 | 调研对比：格式覆盖（含 CR3/X-Trans）、零 C 依赖、RapidRAW/dnglab 生产验证 |
| 2026-08-17 | 发现并登记 D1：image crate tiff feature 未启用，TIFF/HEIC 白名单形同虚设（只能靠内嵌 JPEG 兜底） | Phase 2 现状核查实测；F01 修复 |
| 2026-08-12 | PRD v2.12 打标执行修复：ai_start_batch 仅 processing 拒绝，done/cancelled 可续跑 pending（现场：批次8 done/processed=1/16条永pending，再点开始打标被 Err 吞掉）；request_tags 空解析改 Err 走单条失败路径（现场：mimo-v2.5 经中转站返回不可解析文本被写成 {} 冒充成功） | 老板报 bug：按了打标没结果；DB 现场取证定位 |
| 2026-08-12 | PRD v2.11 打标页细节：ai_start_batch 加 limit（仅前 N 张）；ai_restore_suggestion 撤销拒绝；TagCategory.max 自定义数量上限入提示词；标签面板两列；大图区底部居中悬浮导航条（含跳页） | 老板反馈：按钮 UI 突兀、一排一个分类太空、误拒绝无法恢复 |
| 2026-08-10 | PRD v2.10 打标流程：底栏更名「打标」；跳转即自动创建批次（pendingAssetIds>0 且非运行中触发，running 同步置真防重入）；新增手动模式——后端 mode=manual 建批后直接置 done 不调 AI，工作台从空标签起步纯人工 | 老板要求：去掉创建按钮一步到位；手动模式服务不入 API 的场景 |
| 2026-08-10 | PRD v2.9 全屏查看器：替代半透明 PreviewDialog；滚轮缩放用原生监听 passive:false（React onWheel 防不了默认滚动）；高清 1920 优先原图兑底；右键按住放大=存现场/松手恢复 | 老板要求：不透明新界面+胶片条切换+Alt缩放/中键平移 |
| 2026-08-10 | PRD v2.8 素材库交互：单击取消选中（独占选中时）、操作条去色框统一文字按钮、「打标」悬停二级（AI/手动）、全选反选收进右键菜单；新增通用 ContextMenu 组件 | 老板要求：右键接管对标 Eagle；「复制」先按复制路径实现，若老板要复制文件本体再换方案 |
| 2026-08-09 | PRD v2.7 素材库布局：选中操作条并入顶栏（删浮层）；类型筛选移入左侧栏；侧栏删导入/导出/网盘操作区；TagTree 去掉「全部素材/未打标」固定入口（已由类型区承担） | 老板逐页走查第 3 站；标签折叠复用现有 flattenVisible 骨架 |
| 2026-08-09 | 全局统一图像引擎 imaging.rs：诊断老板真实文件（JPG 有 160px EXIF 缩略图；RW2 无 IFD1 缩略图但有 1920px JpgFromRaw@0x2E）；内嵌三级策略链（自写 TIFF 遍历，IFD 偏移相对 TIFF 基准——kamadak 不吐基准才自写；cut_jpeg 宽容裁剪因该机内嵌图有填充字节）+ 4 许可信号量；**dev 下图像 crate 强制 O3**（debug 全解码 12.7s→0.37s）；jpeg-decoder DCT 缩放实测 1.5s 慢于 zune-jpeg O3 全解码 0.37s 已移除。实测：JPG 320px **17.9s→1.9ms**，RW2 320px 57ms/1280px 81ms | 老板要求：全局公用一个解码、参考开源看图软件（ExifTool/FastRawViewer/Eagle 缓存） |
| 2026-08-09 | 入库页修正：序号位数按钮合并为「序号+手输位数」；预览缩略图提速——所有文件先抽 EXIF 内嵌 ThumbnailImage（调研 ExifTool/FastRawViewer/Lightroom 同法），全图解码仅为兑底 | 老板反馈：位数按钮冗长；23 张只出 2 张因全图解码串行排队 |
| 2026-08-09 | PRD v2.6 入库页改造：改名模板改按钮构造器（token 点选排序/取消，模板=join('_')）、清单加预览缩略图（RAW 用 JPEGInterchangeFormat 偏移抽内嵌 JPEG，320px webp 缓存+IntersectionObserver 懒加载+静态串行闸）、列表/网格双视图；页面拆 RenameBuilder/PendingList/编排三层 | 老板要求：构造器替代手输模板；性能要求不卡，解耦要求不一文件全写 |
| 2026-08-08 | PRD v2.5 打标工作台 2.0：胶片条四段式 + 标签体系分层（EXIF 只读参考 vs AI 分类标签，分类=父标签可自定义，出厂 7 类）+ AI 按分类出标签 + 批量套用；批量上限 100→500；EXIF 展示与上限两点老板授权按建议执行 | 老板按达芬奇调色胶片条描述需求；两点待拍板项老板拍「听你的」 |
| 2026-08-08 | AiSettings 重构为多配置档案：profiles[] + active_profile，旧扁平字段仅作迁移输入（skip_serializing + normalize 合成「默认配置」）；打标只走激活档案，打标页左栏可快速切换 | 老板有多个中转站需自由切换；拒绝双数据源，扁平字段只读不存 |
| 2026-08-08 | 新增 API Mode 设置（openai / anthropic）：请求体、鉴权头（Bearer vs x-api-key+anthropic-version）、响应解析按模式分支；模型列表两模式同构解析 | 老板要求：参考竞品 API Mode 下拉，兼容 Anthropic 原生接口 |
| 2026-08-08 | 模型自动获取：新增 ai_list_models 命令（GET {base_url}/models，OpenAI 兼容），设置页下拉选择+手输兑底，打标页左栏同步可选（切换即保存） | 老板要求：手输模型名易错且不知道服务商有哪些模型 |
| 2026-08-08 | 选图补齐竞品标准套件：Ctrl+A 全选当前筛选全部（fetchAllIds 提升到 libraryStore 共享，一次查询只取 id）、Ctrl+I 反选、操作条加「全选/反选」按钮；Ctrl/Shift 点选原已实现 | 老板体感只能单选：缺快捷键与按钮入口；3 万条也只是 id 数组，不新增后端命令 |
| 2026-08-08 | AI 打标页改工作台三栏：左数据栏（统计+批次）/中大图/底部标签编辑，单张过片+快捷键 | 老板要求：列表式确认流效率低，要看一张定一张 |
| 2026-08-08 | 高清缩略图生成加全局串行闸（Mutex）：滚动时几十个 10MB JPEG 并发解码（每个 ~70MB 内存）会打爆 CPU/内存整机卡死；缓存优先+锁内二次检查，二次浏览零成本 | 老板实测 59 张仍卡死；异步≠限流，重活必须有界 |
| 2026-08-08 | get_thumbnail 也改 spawn_blocking：同步高清解码堵主线程会饿死 asset 协议，表现为缩略图全白+整窗卡死 | 老板实测素材库卡死；主线程上任何重活都是连锁反应 |
| 2026-08-08 | 批量改名升级为自定义模板：`{分库}` `{原名}` `{日期}` `{序号:N}`，默认 `{分库}_{序号:3}`，非法字符转下划线，前端实时预览 | 老板要求可自定义各种方式 |
| 2026-08-08 | 长任务命令（入库/导出/AI打标）改 async + spawn_blocking 工作线程；入库管线三段式：并行算 hash → 单事务批量写库 → 并行生成占位图后统一回写 | 老板实测 205×10MB 卡死：同步命令堵主线程 IPC（取消都排不上队）；单文件自提交+全尺寸解码串行太慢 |
| 2026-08-08 | 老板 UI 走查拍板（PRD v2.4）：黑白灰配色去蓝色；入库两段式手动确认 + 左侧统计栏；总库/分库托管入库（R-32，复制式）；设置页左侧分组导航 + 数据目录/清缓存（R-33）；顶栏去应用名，设置按钮可返回 | 老板走查截图逐条反馈，共 9 项 |
| 2026-08-08 | 云端打标用 reqwest blocking 同步风格（与 importer/export 一致），进度走 ai://progress 事件；图片优先用高清缩略图省流量 | 避免跨 await 持 DB 锁；异步化留待 M2 本地模型（ort）统一评估 |
| 2026-08-08 | 批次受 batch_limit 截断；单条打标失败置 rejected 不阻塞批次 | PRD 风险控制：防 API 成本失控、防单点失败拖死整批 |
| 2026-08-08 | AssetFilter 手写 Default（limit=200），不用派生 Default | 派生 Default 无视 serde(default) 属性，limit=0 被钳到 1 导致导出漏文件（T03 测试抓获） |
| 2026-08-08 | ffmpeg 走 PATH 探测 + 优雅降级；kamadak-exif 弃用（不提供 EXIF 缩略图字节提取，image crate 解码 256px 足够）；sidecar 分发留打包阶段 | 减少 M1 依赖面，视频元数据尽力而为不阻塞导入 |
| 2026-08-08 | 服务层进度用回调（Fn(Progress)）而非直接 AppHandle，command 层包 app.emit | 服务与 IPC 解耦可单测（T03 集成测试直接验证回调） |
| 2026-08-08 | 嵌套事务拆分：asset_tags::assign 拆 assign_inner（无事务）+ 外包装 | ai::confirm_suggestion 外层事务套内层事务会报错（T02 测试抓获） |
| 2026-08-08 | @tauri-apps/api 事件模块用单数 `@tauri-apps/api/event`（非 events） | v2 API 变更，复数模块不存在 |
| 2026-08-08 | Cargo 依赖分批引入：T01 只装核心集（tauri+插件+serde+tokio 等），rusqlite/sha2 等 T02 加，image/ffmpeg-sidecar/kamadak-exif T03 加，reqwest/ort T05 加 | 避免 T01 编译 ort/ffmpeg 等重依赖拖慢脚手架验证（架构第 6 节是全集，非 T01 必需） |
| 2026-08-08 | npm 补充 @vitejs/plugin-react + @types/node（架构清单未列） | Vite React 必需插件；@types/node 供 vite.config 路径别名用 |
| 2026-08-08 | vite server.watch 忽略 `**/src-tauri/**` | cargo 编译占用 target 下 exe 导致 chokidar EBUSY 崩溃（T01 冒烟实测踩坑） |
| 2026-08-08 | assetProtocol scope 暂为 `**`，T03 引入缩略图/原图协议访问时收紧到具体目录 | T01 无文件协议访问需求，先放行减少配置面 |
| 2026-08-08 | 主题机制定案：组件只引用 var(--color-*)，硬编码颜色零容忍（已审查通过）；暗色变量随系统（media query）先生效，P2 手动切换迁 data-theme 即可，组件零改动 | 老板明确要求深色模式/主题定制能力；R-24 手动切换属 P2，但变量驱动架构 T01 就落地 |
| 2026-08-08 | FTS 最终方案：独立 fts_content 中间表 + 索引触发器挂 fts_content 三段式；业务表触发器只维护 fts_content | FTS5 delete 必须提供原始值，先 UPDATE 再 delete 会产生幻影命中（实测复现） |
| 2026-08-08 | 中文搜索：逐字切分（unigram）+ 查询加双引号拼短语 + ≤2 字 LIKE（EXISTS）兜底 | unicode61 不分词中文；不加引号空格被当 AND 误命中；trigram 2 字查询零结果（均实测） |
| 2026-08-08 | AI 打标「云端 M1（T05a）+ 本地 M2（T05b）」：R-06 保 P0，R-07 降 P1 | 老板拍板；消除 PRD/架构里程碑矛盾 |
| 2026-08-08 | 视频播放 M1：双击卡片内嵌播放 H.264，失败降级系统播放器；完整详情页随 R-18 于 M3 | R-09（P0）与 R-18（P1）的落点对齐 |
| 2026-08-08 | Tailwind 升 v4（@tailwindcss/vite，CSS @theme，无 tailwind.config.ts） | 与 V1 已验证技术栈一致 |
| 2026-08-08 | 状态管理选 Zustand（不沿用 V1 的 Redux Toolkit） | 极简定位，3 页 5 store 足够（架构 1.3 节评估表） |
| 2026-08-08 | 本地模型下载源：HF 镜像/国内 CDN + 断点续传 + sha256 校验 | 国内直连 HuggingFace 不可靠 |
| 2026-08-08 | 仓库名沿用旧拼写 BagerTea_AiMdeias（将错就错），项目名统一 bagertea_ai_media_v2 | 历史仓库不重名 |

---

## 四、风险登记（PRD 第六章摘要 + 跟踪状态）

| 风险 | 等级 | 当前状态 |
|---|---|---|
| 夸克网盘私有接口（cookie 模拟登录） | 高 | 未启动（M2）；适配层独立封装 + 实验性标注 + 二次确认 |
| 本地小模型体积/准确率权衡 | 中 | M2 排期前锁定选型（架构假设 mobileclip S2 ONNX ~200MB） |
| 云端 API 成本失控 | 中 | 默认手动批量确认 + batch_limit=100 + 打标前预估提示 |
| 万级素材性能 | 中 | T03/T04 验收绑指标（搜索 ≤500ms、3 万条滚动流畅） |
| 视频编码兼容性（HEVC/ProRes） | 中 | 已收敛：H.264 必过，其余尽力而为 + 系统播放器兜底 |
| 百度网盘 API 资质（个人开发者限额） | 中 | **M2 排期前必须确认**；默认按 4MB 分片设计 |
| 数据安全（本地唯一副本） | 低-中 | 删除文件二次确认；备份导出 P2 |

---

## 五、开工检查单（每次开工前 30 秒过一遍）

1. 当前焦点是不是还准确？不是先更新。
2. 要动的东西在 PRD/架构里有依据吗？没有 → 先改文档 + 记决策日志。
3. 涉及 FTS/搜索？回去看架构 1.4/1.5 + 共享知识 #6/#12（幻影命中、短语引号两个坑都在那）。
4. 验收标准写完再写实现（T02 起每个任务都有明确验收项）。
