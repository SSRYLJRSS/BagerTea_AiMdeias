# 茶包素材 BagerTea AiMedias — 测试策略与测试设计文档

| 项 | 内容 |
|---|---|
| 文档编号 | TEST_STRATEGY v1.0 |
| 日期 | 2026-08-21 |
| 作者 | 严过关（QA 工程师） |
| 适用版本 | 茶包素材 BagerTea AiMedias v1.0.1（demo） |
| 项目路径 | `F:\vibecode\chabaosucai` |
| 定位 | 全模块测试策略 + 测试设计（用例级）+ 专项测试 + 手工走查清单 + 执行计划 |
| 依据 | README.md / ARCHITECTURE.md / prd_bagertea_v2.md（R-01~R-33）/ PERFORMANCE.md / qa-test-report-2026-08-14.md / qa-regression-batch2-2026-08-14.md / src-tauri/tests/ 既有用例 |
| 约束 | 本文档为「仅测试」工作流产物，不含任何源码修改建议的实施方案 |

---

## TL;DR

1. **现状一句话**：后端（Rust/SQLite）已有 **147 个活跃 cargo 用例 + 5 个 ignored 探针**（2026-08-22 实测全绿），核心数据层（搜索/标签/级联删除/迁移幂等/分页边界）覆盖良好；**前端 0 组件测试、0 E2E 测试**（仅 typecheck + vite build），命令层（Tauri command）仅靠代码审查覆盖；GUI 交互（拖拽/虚拟滚动/缩略图渲染/打标工作台）完全依赖人工。
2. **最大风险面**（2026-08-22 复测更新）：① 中文搜索历史 Bug（BUG-A ASCII 子串 / BUG-B CJK+数字粘连 / BUG-D 多标签顺序相关）**已修复，5 个回归标记用例全部转绿**（搜索路由 fix-plan-2026-08-14 查询侧 + V3 写入侧根治，详见 §3.1.1 跟踪列）；② AI 打标状态机与续跑/恢复逻辑只测了 DB 层，服务层 + UI 层断链（**仍空白**）；③ Ollama 下载安装链路（多源降级/断点续传/静默安装）纯函数已测但端到端未验证（**仍空白**）；④ 性能指标（JPG ≤5ms / RW2 ≤100ms / 3 万滚动 / 搜索 <300ms）只有手动探针，无守门机制（**仍空白**）。
3. **策略一句话**：守住「cargo test 全绿 + 历史Bug回归矩阵」底线（P0），补「服务集成 + 命令层」中坚（P1），前端用最小代价的 vitest + testing-library 组件测试 + Playwright 冒烟 E2E 补 GUI 空洞（P1~P2），性能探针纳入 CI 定时跑（P2）。
4. **建议执行顺序**：P0 冒烟集（既有 93 集成用例 + 59 src 单元跑通即绿；2026-08-22 已实测通过）→ 专项回归矩阵（搜索/格式）→ 服务层补测（AI 打标状态机 / 导出 / Ollama）→ 前端组件测试 → E2E 冒烟 → 性能守门。
5. **测试数据是前置依赖**：真实 RAW/HEIC 样本、损坏文件、特殊字符文件名、超长文件名、大体积视频等样本集必须先建（见第五节清单），否则格式矩阵与边界用例无法执行。

---

## 覆盖率现状评估表

> 统计口径：`grep '#[test]'` 静态计数。2026-08-21 初版统计 151（146 活跃 + 5 ignored）；**2026-08-22 复测 grep 到 152 个 `#[test]`（db_integration.rs 实际 20 而非 19），活跃 = 152 − 5 ignored = 147，`cargo test` 实测 147 全绿**。README.md 中「108 用例」为历史数字，当前代码已增长。

| 层级 | 测试文件 / 位置 | 用例数 | 覆盖内容 | 覆盖评价 |
|---|---|---|---|---|
| Rust 单元（utils） | `src/utils/bigram.rs` / `path.rs` | 4 | cjk_bigram 切分、路径规范化 | 薄但关键，够用 |
| Rust 单元（services） | `imaging.rs` 4 / `importer.rs` 6 / `ai_cloud.rs` 12 / `exif_meta.rs` 6 / `heic_decode.rs` 2 / `raw_decode.rs` 3 / `ollama_installer.rs` 13 / `ollama_setup.rs` 3 | 49 | 解析函数、改名模板、提示词解析、EXIF 日期解析、Ollama 纯函数 | 纯函数覆盖好，**IO/并发路径未测** |
| Rust 单元（db） | `db/settings.rs` | 6 | settings normalize 迁移 | 够用 |
| DB 集成 | `tests/db_integration.rs` | 20 | FTS 索引/短语/幻影、标签树计数/reparent/merge、去重分组、分页筛选排序、settings 往返、AI 确认流、预置种子、**软删回收站恢复**、**tag_ops 记录撤销**、**suggestion_last_error_roundtrip** | **数据层覆盖优秀** |
| QA 边界回归 | `tests/qa_edge_tests.rs` | 53 | 迁移幂等、级联删除、LIKE 转义（% _ \）、FTS 边界（引号/星号/纯标点/emoji/空格）、批量删除、tag 环校验、分页钳位、FTS 一致性、B19/B20/B27/B37 系列、**BUG-A 强化（token 中部子串）**、**BUG-B 混合子串**、**BUG-D 标签序双用例**、**V3 重建/排序** | **边界覆盖优秀**，BUG-A/B/D 回归标记用例 **5 个全绿**（2026-08-22 实测） |
| 服务集成 | `tests/services_integration.rs` | 9 | 入库 100 张+占位图+去重、高清缩略图缓存、导出 move 同步库、导入取消、B06b 同名耗尽 | **管线级覆盖中**，AI/Ollama/视频未进 |
| 格式矩阵 | `tests/format_matrix.rs` | 6 | 可编码格式（jpg/png/webp/bmp/tga/tif）占位+高清双层、垃圾样本降级、白名单 25 RAW 扩展名 | 合成样本覆盖中，**真实 RAW/HEIC 缺席**（走 perf_probe 手动） |
| 性能探针 | `tests/perf_probe.rs` | 4（ignored） | 真实文件解码耗时、EXIF 诊断、混合格式吞吐 | 手动-only，**无守门** |
| 维护工具 | `tests/dev_maintenance.rs` | 1（ignored） | 真实用户库维护 | 不计覆盖 |
| **命令层（Tauri command）** | 无 | **0** | `assets_cmd` / `import_cmd` / `ai_cmd` 等薄壳：参数校验、锁、事件、spawn_blocking | **空白**，仅代码审查结论 |
| **前端组件** | 无 | **0** | AssetGrid / RenameBuilder / Workbench / Filmstrip / 各 Dialog | **空白** |
| **前端 store** | 无 | **0** | libraryStore / selectionStore / aiStore 等 5 个 Zustand store | **空白** |
| **E2E** | 无 | **0** | 全链路用户旅程 | **空白** |
| 前端构建门禁 | `npm run typecheck` / `npm run build` | — | 类型 + 打包 | 有，但非行为测试 |

**结论**：后端数据层与服务层覆盖 ~80 分，命令层 ~20 分（仅审查），前端 ~10 分（仅构建），E2E 0 分。本策略的重点是把后端优势保持住（回归矩阵化），同时以最小成本补齐命令层与前端的行为验证。

---

## 一、测试总体策略

### 1.1 质量目标与风险驱动

本产品是**本地优先的单机素材库**，最核心的质量承诺按优先级排序：

| # | 质量承诺 | 对应风险 | 测试策略回应 |
|---|---|---|---|
| 1 | **用户素材文件绝不丢失/不被静默破坏** | 删除假删除、导出覆盖、同名冲突、迁移丢数据 | 数据完整性专项 + 删除/导出双策略用例 + 迁移幂等回归（既有 5 用例保持） |
| 2 | **库数据（DB）与磁盘事实一致** | FTS 幻影命中、级联遗漏、move 后 file_path 过期、回收站过期清理 | DB 集成层断言「表+FTS+文件系统」三方一致 |
| 3 | **搜索结果可信** | BUG-A/B/D 三大历史缺陷 | 中文搜索专项回归矩阵（§3.1） |
| 4 | **大数据量可用**（3 万级） | 虚拟滚动卡顿、fetchAllIds 内存爆炸（BUG-E）、锁饿死 | 性能专项（§3.3）对照 PERFORMANCE.md 指标 |
| 5 | **长耗时操作可取消、不冻结 UI** | 网络 spawn_blocking、导入取消、AI 批次取消 | 服务集成取消路径用例 + 手工走查 |
| 6 | **隐私默认安全** | API key 明文、路径穿越、SQL 注入 | 安全专项（§3.5）+ 已知问题清单化 |

### 1.2 测试金字塔分层

```
                    ▲  手工探索性测试 / 验收走查（PRD checklist §四）
                   ▲▲  性能基准 / 崩溃恢复 / 安全（专项 §3.3~3.5，半自动）
                  ▲▲▲  E2E（Playwright/tauri-driver）：4~6 条用户旅程冒烟
                 ▲▲▲▲  前端组件 + store 测试（vitest + testing-library）
                ▲▲▲▲▲  命令层测试（Rust，mock State 或 tauri::test）——当前空白
               ▲▲▲▲▲▲  服务集成（cargo test，tests/*.rs）——当前主力，87 用例
              ▲▲▲▲▲▲▲  DB 集成 + 单元（db::init_memory）——当前主力，78 用例
```

| 层 | 目标 | 现状 | 目标态 | 工具选型建议 |
|---|---|---|---|---|
| L1 单元/DB | 纯函数 + SQL 正确性 | ✅ 79 用例 | 保持 + 补缺口 | `cargo test`（现状即最佳实践：`db::init_memory()` 内存库） |
| L2 服务集成 | 管线级（文件系统 + DB + 并发） | ✅ 88 用例（集中在导入/导出/缩略图） | 补 AI 打标状态机、Ollama 端到端（mock HTTP）、视频抽帧 | `cargo test` + `tempfile` + `wiremock`（HTTP mock，供 ai_cloud/ollama 用） |
| L3 命令层 | 薄壳正确性（参数校验/锁/事件/异步） | ❌ 空白（代码审查替代） | 抽样覆盖高危命令（delete_assets / import / ai_start / export） | 方案 A：tauri 2 的 `tauri::test` mock app runtime；方案 B：把命令逻辑下沉 services 后直接测 services（更符合现有分层铁律） |
| L4 前端组件/store | 交互逻辑（选中态/过滤器/改名构造器/工作台） | ❌ 空白 | 组件 15~25 个用例 + store 10 个用例 | `vitest` + `@testing-library/react` + `@testing-library/user-event`；store 直接实例化测试（Zustand 对测试友好）；`@tauri-apps/api/core` 的 `invoke` 用 `vi.mock` 桩掉 |
| L5 E2E | 端到端用户旅程 | ❌ 空白 | 4~6 条 P0 旅程冒烟 | 首选 `Playwright` + `tauri-driver`（WebDriver）驱动真实窗口；退而求其次 Playwright 驱动 `npm run dev` 的纯 Web 模式（mock invoke 层），两条路线的取舍见 §1.4 |
| L6 手工/专项 | 视觉、性能体感、探索性 | 部分人工（历史 QA 报告） | checklist 化（§四）+ 性能探针 CI 化 | 人工 + `perf_probe` 定时任务 |

### 1.3 工具选型建议（含理由）

| 用途 | 推荐 | 备选 | 理由与注意 |
|---|---|---|---|
| Rust 测试 | `cargo test`（现状） | — | 既有 146 用例零迁移成本；`#[ignore]` 探针模式已验证可行 |
| HTTP mock（AI/Ollama） | `wiremock` crate | `httpmock` | ai_cloud.rs 的 OpenAI/Anthropic 双模式、ollama_setup.rs 的 `/api/tags`/`/api/pull` NDJSON 流都需要可编程 mock；wiremock 支持流式响应 |
| 前端单测 | `vitest` + `@testing-library/react` | jest | 与 vite 同生态零配置；React 19 兼容 |
| invoke 桩 | `vi.mock('@tauri-apps/api/core')` | msw | 前端所有数据都走 `src/api/` 封装层，桩一层即可覆盖全部组件 |
| E2E | `tauri-driver` + Playwright（chromium 后端） | WebDriverIO / WebdriverIO | Tauri 2 官方 E2E 通道即 tauri-driver（WebDriver 协议）；Playwright 可挂 WebDriver endpoint。注意：Windows 上 tauri-driver 需要 WebView2 |
| 性能守门 | `perf_probe` 去 ignore 化 + 阈值断言 | criterion 基准 | 性能手册已定义「JPG 320px ≤5ms、RW2 ≤100ms」可断言化；fixtures 走 gitignore 大文件 + 本地目录 |
| 并发压测 | `cargo test` + `std::thread` + `loom`（可选） | — | 信号量（imaging::acquire）与 DB 锁的竞争用线程压力测试暴露；loom 仅在出现真实数据竞争时引入 |
| 崩溃注入 | 手工 kill -9 / 任务管理器 | — | 崩溃恢复场景（V2 迁移中断）已有 B37 用例模板，扩展靠构造「version 回退 + 部分列」的 DB 文件 |

### 1.4 现状差距分析（Gap Analysis）

| # | 差距 | 影响 | 建议优先级 | 补齐路径 |
|---|---|---|---|---|
| G1 | 历史 Bug（BUG-A/B/D/E）修复状态未知，qa_edge_tests.rs 中的回归标记用例当前红/绿不明 | 搜索是 P0 功能，回归矩阵缺失等于裸奔 | **P0** | 先跑一次 `cargo test --test qa_edge_tests` 确认 4 个回归标记用例状态，建立「修复→转绿」跟踪表（§3.1） |
| G2 | 命令层 0 测试 | delete_assets 等高危命令仅靠审查 | P1 | 优先把「锁外 IO + 短锁写库」的并发契约测起来（方案 B：逻辑已在 services 的直接测 services） |
| G3 | AI 打标服务层无集成测试（run_cloud_batch 全链路：进度回调/取消/空解析置 rejected/视频抽帧合并 merge_frame_tags） | 状态机是 v2.12 修订核心，回归风险高 | **P0~P1** | wiremock mock OpenAI/Anthropic 响应，构造：正常/空标签/超时/非 200/流式中断 五类响应 |
| G4 | Ollama 端到端（下载/断点续传/静默安装/就绪复检/pull）未测 | 涉及安装系统软件，出错代价高 | P1 | 纯函数已测 16 个；补 mock HTTP + 假安装器的集成测试；真机安装走手工走查（§四） |
| G5 | 前端 0 组件测试 | 选中态/改名构造器/工作台等复杂交互全靠手测 | P1 | vitest 起步：先测 5 个 store（无 DOM 依赖，性价比最高），再测 RenameBuilder/Workbench 两个最复杂组件 |
| G6 | E2E 空白 | 无端到端信心 | P2 | Playwright + tauri-driver，4~6 条旅程（入库→搜索→打标→导出） |
| G7 | 性能指标无守门 | 3 万级滚动/搜索 <300ms 会静默劣化 | P2 | perf_probe 加阈值断言 + fixtures 目录约定；CI 每日跑 |
| G8 | 视频（ffprobe/抽帧/双击播放降级）后端测试缺 | 视频是 P0 功能面（R-09） | P1 | 合成小视频（ffmpeg 产物入库 fixtures）+ services_integration 扩展 |
| G9 | 测试数据（真实 RAW/HEIC/损坏文件等）无组织 | 格式矩阵专项无法执行 | **P0（前置）** | 建议建 `src-tauri/tests/fixtures/`（gitignore 大文件）+ `fixtures/README` 登记清单（§五） |
| G10 | CI 状态未知（未见 CI 配置） | 「每次构建必跑」缺少执行载体 | P1 | 建立 CI（GitHub Actions / 本地脚本均可），P0 冒烟集 15 分钟内完成 |

### 1.5 测试环境矩阵

| 维度 | 取值 | 说明 |
|---|---|---|
| OS | Windows 10 / Windows 11（主）/ macOS（次） | README 声明支持 Win10/11 + macOS；历史 QA 仅在 Windows 实测 |
| 构建 | dev（O3 包已配）/ release | 性能断言须注明构建类型（PERFORMANCE.md：debug+O3 下 JPG 1.9ms） |
| ffmpeg | 有 / 无 | 缺省时视频元数据降级占位图（README），必须双态测 |
| Ollama | 未装 / 已装 / 已装未启动 | 三态覆盖安装器 detect_installed 与 ping |
| AI 网络 | 正常 / 超时 / 401 / 5xx / 空响应 | mock 层构造，不依赖真实中转站 |
| 数据规模 | 空库 / 100 条 / 3 万条（性能） | 3 万条数据集用生成脚本（§5.3） |
| 主题 | light / dark / system | 设置页三态 |
| 磁盘异常 | 目标盘只读 / 空间不足 / 网络盘路径 | 导出与入库异常路径（手工） |

### 1.6 准入 / 准出标准

**准入（开始一轮测试前）**：
- `npm run typecheck` 与 `npm run build` 通过
- `cargo build` 通过、`cargo test` 编译通过
- fixtures 数据集就位（专项测试时）

**准出（版本可发布）**：
- P0 冒烟集 100% 通过（含 BUG-A/B/D 回归标记用例状态已知）
- P1 核心回归 ≥98% 通过，失败项均有缺陷单 + 风险评估
- 性能清单（PERFORMANCE.md §四）5 项全过
- 无 P1 级未修复缺陷（历史口径：BUG-A 为 P1）

---

## 二、功能模块测试设计

> 用例编号规则：`模块前缀-NNN`。类型列：N=正常路径，B=边界值，E=异常/降级，R=回归防线（关联历史 Bug/修复项）。每条用例含前置条件/步骤/预期。既有自动化用例标注「已有」避免重复设计。

### M1 入库管线（R-01 / R-32 / R-33）

**被测对象**：`services/importer.rs`（`import_paths` / `inspect_paths` / `preview_rename` / `stage_file`）、`services/exif_meta.rs`（`extract` / `parse_exif_datetime`）、`services/thumbnail.rs`（`extract_placeholder`）、`commands/import_cmd.rs`（`inspect_import`）、前端 `ImportPage` / `RenameBuilder` / `PendingList`。

**测试目标**：
1. 两段式确认语义完整（清单≠入库，用户显式触发才写库写盘）
2. 托管复制不破坏源文件；改名模板输出可预期；非法字符被替换
3. 占位图「每张立即有」；EXIF 提取尽力而为不阻塞
4. 哈希去重识别准确，取消路径零残留
5. 总库/分库路径拼接安全（禁止路径穿越）

| ID | 类型 | 前置条件 | 步骤 | 预期结果 |
|---|---|---|---|---|
| IMP-001 | N | 已有 100 张合成 JPEG 源目录 | 调 `import_paths` 导入 | 100 全成功，每条 placeholder_path 存在且文件落盘，width/height=800/600（已有 `import_100_images_with_placeholders`） |
| IMP-002 | N | 同上已导入一次 | 再次导入同一目录 | duplicates=100、imported=0，不产生新记录（已有） |
| IMP-003 | N | 总库已配置 `D:\lib`，分库名「旅行」 | 入库 3 张图 | 文件复制到 `D:\lib\旅行\`，库记录 file_path 指向新位置 |
| IMP-004 | B | 分库名输入 `..\..\evil` | 入库 | 路径穿越被拒绝或分库名非法字符被替换，最终文件仍在总库内（R-32「禁止路径穿越」） |
| IMP-005 | B | 分库名含 `/:*?"<>|` 等非法字符 | 入库 | 非法字符替换为下划线，入库成功不报错（R-32「非法字符自动替换」） |
| IMP-006 | N | 改名模板 `{分库}_{序号:3}` | 入库 2 张到「旅行」分库 | 文件名 = `旅行_001.jpg`、`旅行_002.jpg`；`preview_rename` 单元已测，此处验管线实际产物 |
| IMP-007 | N | 模板 = 空 / 仅 `{原名}` / 多 token 组合 `{日期}_{原名}_{序号:2}` | 逐个入库 | 文件名与模板一致；日期 token 为合法日期串；序号补零位数正确 |
| IMP-008 | B | 序号位数手输 0 / 9 / 非数字 / 超大 | 构造模板预览 | 不 panic：0 视为默认、9 正常补零、非法输入回退或提示 |
| IMP-009 | E | 源目录混入 1 个损坏 JPEG + 1 个未知扩展名文件 | 导入 | 损坏文件 failed 计数 +1 且 errors 有明细；未知扩展名被白名单拦下（`mime::asset_type_from_ext` 返回 None 不入库） |
| IMP-010 | E | 导入进行中（>50 张时）置 cancel=true | 取消 | imported=0 或部分导入 + 「用户取消（已导入 N 条，重复 M 条）」提示；库内记录与磁盘文件一一对应（已有 `b01_import_cancel_zero_imported`，补「中途取消部分导入」变体） |
| IMP-011 | E | 源文件在清单确认后、执行前被外部删除 | 入库 | 该条计入 failed，其余正常；不产生「库有记录但文件不存在」的悬空记录 |
| IMP-012 | R | 目标分库已存在 999 个同名文件 | 入库同名 | 返回「同名文件过多」Err，不静默覆盖（B06a：`stage_file` 循环 1..1000） |
| IMP-013 | N | 带 EXIF 的相机 JPG（fixtures） | 入库 | assets 表 EXIF 6 列（camera/lens/iso/aperture/shutter/focal/taken_at）填充正确；`parse_exif_datetime` 本地时区转换正确 |
| IMP-014 | E | EXIF 损坏/缺失的 JPG | 入库 | EXIF 列为 NULL，入库不失败（extract 尽力而为） |
| IMP-015 | N | PNG（无内嵌预览） | 入库 | 生成 256px 占位小图（PRD v2.1：PNG 等无内嵌生成 256px 小图） |
| IMP-016 | N | 视频文件（H.264 mp4） | 入库 | 提取内嵌封面帧为占位图；视频元数据（时长/分辨率/编码）入库 |
| IMP-017 | E | 无 ffmpeg 环境 | 入库视频 | 降级为通用占位图，不报错（`ffprobe_available()` false 分支） |
| IMP-018 | N | 前端：拖拽 5 文件入待入库区 | 不点开始入库 | 仅进入清单（统计 5 项、总大小正确），库和磁盘均无变化（两段式核心断言） |
| IMP-019 | N | 前端：清单切换列表/网格视图 | 点右上角图标 | 列表模式纯文字不渲染缩略图；网格模式 LazyThumb 懒加载（性能策略） |
| IMP-020 | R | 导入含中文+数字粘连文件名（如 `进度100%.jpg`） | 入库 | 入库成功；该文件进入 BUG-B 观察集（入库本身不依赖搜索） |
| IMP-021 | E | 同一批清单中含两个内容相同（哈希一致）文件 | 入库 | 后者识别为 duplicate，两条不都落库（哈希去重） |
| IMP-022 | N | 超长文件名（>255 字符 stem） | 入库 | 成功或明确报错，不 panic 不截断成非法名 |

### M2 多格式解码（F01 白名单 / imaging 引擎）

**被测对象**：`services/imaging.rs`（`decode_thumb` / `embedded_preview` / `write_thumb` / `acquire` / `cut_jpeg` / `locate_tiff_base`）、`services/heic_decode.rs`（`decode_heic`）、`services/raw_decode.rs`（`decode_raw`，rawler）、`utils/mime.rs`。

**测试目标**：
1. 白名单 25 个 RAW 扩展名 + HEIC + 可编码格式全部「入库放行 + mime 正确」
2. 三级策略链（内嵌预览 → FFD8 扫描 → 全图解码）各级命中正确
3. RAW 真解码兜底（rawler + Bayer binning）出图且宽高比不失真
4. 损坏/垃圾文件优雅降级不 panic
5. 4 许可信号量并发下无死锁、无内存爆炸

| ID | 类型 | 前置条件 | 步骤 | 预期结果 |
|---|---|---|---|---|
| FMT-001 | N | 合成 6 格式样本（jpg/png/webp/bmp/tga/tif） | `decode_thumb(p,320)` 与 `(p,1024)` | 双层均出图、边长不越界、宽高比保持（已有 `decodable_formats_placeholder_and_hd`） |
| FMT-002 | N | — | 遍历 25 RAW 扩展名 + heic/heif | `asset_type_from_ext` 全放行 image、`is_raw_ext` 判定正确、jpg/tiff 不误判（已有 `whitelist_covers_all_formats`） |
| FMT-003 | B | avif/xyz 等未知扩展名 | 判定 | 返回 None 不入库（已有，防黑图入库） |
| FMT-004 | N | 真实相机 JPG（含 EXIF IFD1 缩略图，fixtures） | `embedded_preview` | 抠出内嵌 JPEG 字节流（非全图）；`decode_thumb(320)` 走内嵌路径出图 |
| FMT-005 | N | 真实 RW2（Panasonic，fixtures） | `embedded_preview` | TIFF 遍历命中：RW2 magic 0x55、tag 0x2E UNDEF count 即长度、0x0201/0x0202 定位；1920×1280 内嵌图被提取 |
| FMT-006 | B | 尾部带 FF 填充字节的内嵌 JPEG（构造样本） | `cut_jpeg` | 宽容裁剪不误杀：前 64 字节内找 SOI、末尾 rfind EOI |
| FMT-007 | R | `.jpg` 扩展名的大图 | `decode_thumb` | FFD8 标记扫描兜底对 .jpg **禁用**——不得把 7.5MB 主图当内嵌预览抓回（PERFORMANCE.md 踩坑点） |
| FMT-008 | N | 真实 RAW：CR2/CR3/NEF/ARW/RAF/ORF（fixtures，至少各 1） | `decode_thumb(320)` | 有内嵌预览走内嵌；无内嵌走 FFD8 扫描；再不行 raw_decode 兜底真解码出图 |
| FMT-009 | N | RAW 无内嵌预览样本 | 强制全解码路径 | rawler 解码 + Bayer binning 出图，宽高比与原 RAW 尺寸一致 |
| FMT-010 | N | HEIC/HEIF 样本（fixtures） | `decode_heic` + `decode_thumb` | 出图且颜色正常（不偏色/不反色）——需人工目检辅助 |
| FMT-011 | E | 垃圾字节文件 / 截断的 JPEG / 0 字节文件 | `decode_thumb` | 返回 None 不 panic（已有 garbage 用例，扩展截断/空文件变体） |
| FMT-012 | E | 伪装扩展名（.jpg 实为 PNG 内容） | `decode_thumb` | 策略链最终全图解码可出图（image crate 按内容嗅探）或优雅 None |
| FMT-013 | N | 8 并发线程同时 `decode_thumb` 大图 | 压测 | 信号量限 4 并发：无死锁、无 panic；总耗时 ≈ 串行的 1/4~1/2（吞吐×4 目标） |
| FMT-014 | B | 极小图（1×1 px）与极端宽高比图（10000×10） | `decode_thumb(320)` | 出图、尺寸钳制正确、宽高比保持 |
| FMT-015 | B | 16bit TIFF / CMYK JPEG / 灰度 PNG | `decode_thumb` | 转 8bit RGB 出图不报错，颜色可接受 |
| FMT-016 | N | 真实 RAW 混合集（多机型） | `probe_mixed_decode_throughput` 扩展 | 100 张混合格式占位层解码吞吐达到可接受阈值（已有探针，建议断言化） |
| FMT-017 | R | 每次 decode 经 `imaging::acquire()` | 代码走查 + 压测 | preview.rs / thumbnail.rs 全部委托 imaging.rs，无第二解码路径（架构铁律 1） |
| FMT-018 | E | 含恶意构造的 TIFF（IFD offset 越界循环） | `embedded_preview` | 遍历有防护：不无限循环、不越界 panic（可用 `#[should_panic]` 反向确认或返回 None） |

### M3 素材库（R-02 / R-03 / R-21 / R-22）

**被测对象**：`db/assets.rs`（`list` / `list_ids` / `soft_delete` / `restore` / `list_expired_trash`）、`db/tags.rs` 树计数、前端 `AssetGrid` / `GridToolbar` / `SideBar` / `libraryStore` / `selectionStore`。

**测试目标**：
1. 筛选（类型/标签/未打标）+ 排序（时间/大小/分辨率）+ 分页组合正确
2. 虚拟滚动 3 万条流畅（性能联动 §3.3）
3. 标签树父子折叠、父标签合计计数联动
4. 回收站软删/恢复/过期清理
5. limit/offset 钳位（历史 AssetFilter limit=0 钳 1 Bug 防线）

| ID | 类型 | 前置条件 | 步骤 | 预期结果 |
|---|---|---|---|---|
| LIB-001 | N | 库内图片/视频/未打标混合 | 依次切类型筛选 全部/图片/视频/未打标 | 计数与实际分布一致（已有 `assets_pagination_and_filters` 基础，补三态组合） |
| LIB-002 | N | 素材带不同拍摄时间/大小/分辨率 | 按各键排序 | 升降序正确；NULL 值排序位置一致（排头或排尾）不抖动 |
| LIB-003 | B | `AssetFilter.limit=0` | `assets::list` | 钳为 1，返回 1 条（历史 Bug 回归，已有 `pagination_limit_zero_clamped`） |
| LIB-004 | B | limit=-5 / offset=-1 / offset=100000 | `list` | 负值钳 0/1、offset 超界返回空页且 has_more=false（已有 3 用例） |
| LIB-005 | B | 插入 1001 条，limit=999999 | `list` | 返回 ≤1000（B19 硬上限，已有 `b19_list_limit_hard_cap_1000`） |
| LIB-006 | B | `list_ids` 传入大库 | `list_ids` | 上限 100000（已有 `b19_list_ids_capped_at_100000`） |
| LIB-007 | N | 素材 A 挂父标签「风景」子标签「海边」 | 点父标签「风景」 | 结果含 A；父标签计数 = 自身+全部子标签合计（已有 `tag_tree_counts`） |
| LIB-008 | N | 父标签下多级子标签 + 折叠态 | 展开/折叠 | ▸/▾ 状态切换，折叠不丢已选筛选 |
| LIB-009 | N | 素材挂 2 个标签 | 多标签 any 组合筛选 | 任一命中即入选；all 组合需全命中（已有 `sort_and_multi_tag_filter`） |
| LIB-010 | R | 筛选条件变化 | `setFilter` | 选中集被清空（B09：`setFilter` 调 `selectionStore.clear()`）——store 测试 |
| LIB-011 | N | 3 万条数据集（§5.3 生成） | 滚动网格 | 无白块卡顿、内存可控（PERFORMANCE.md 指标，E2E/手工） |
| LIB-012 | N | 软删素材 A | `soft_delete` | A 从默认列表消失，进回收站；文件仍在磁盘（已有 `trash_soft_delete_restore`） |
| LIB-013 | N | 回收站内恢复 A | `restore` | A 回到列表，标签/EXIF 数据完整（已有） |
| LIB-014 | N | 软删超过保留期的素材 | `list_expired_trash(cutoff)` | 出现在过期清单；自动清理后记录与缩略图被清除，文件按策略处理 |
| LIB-015 | B | 软删后再次软删 / 恢复已恢复项 | 重复操作 | 幂等：不重复计数、不报错 |
| LIB-016 | E | 库内素材的磁盘文件被外部删除 | 列表渲染 + 打开缩略图 | 列表仍显示（记录在），缩略图 onError 回退占位动画（B27 前端行为），不崩溃 |
| LIB-017 | R | 选中若干素材后执行批量删除 | 删除后 | `removeLocal` 只减当前视图内实际移除数，选中数不出现负数/幽灵（B09：removedInView） |
| LIB-018 | N | 前端：单击选中→再击同张取消 | 网格交互 | 独占选中语义正确（PRD v2.8 选中态规范） |
| LIB-019 | N | 前端：搜索输入 | 防抖后触发查询 | 输入停止 ~300ms 才查询，连续输入不发多次请求（store/组件测试） |
| LIB-020 | E | 空库 / 筛选无结果 | 渲染 | 空状态提示友好，无 JS 错误 |

### M4 中文搜索（R-04）

**被测对象**：`db/search.rs`（FTS5 三策略：cjk_bigram 短语 / 前缀 token / ≤2 字 LIKE 兜底）、`utils/bigram.rs`、`db/migrations.rs`（fts_content + 9 触发器）。

> 完整专项见 §3.1（含 BUG-A/B/D 回归矩阵），此处列功能面主干用例。

| ID | 类型 | 前置条件 | 步骤 | 预期结果 |
|---|---|---|---|---|
| SRCH-001 | N | 库含「海边日落.jpg」 | 搜「海边」 | 命中（已有 `fts_index_on_insert` 系列） |
| SRCH-002 | R | 库含「上海湖边.jpg」 | 搜「海边」 | **不命中**（短语查询防误命中，已有 `fts_phrase_no_false_positive`） |
| SRCH-003 | N | 3 字 CJK 查询 | 搜「山野花」 | 命中「山野花.jpg」（FTS 路径，已有） |
| SRCH-004 | N | 1~2 字查询 | 搜「海」「海边」 | LIKE 兜底命中（已有 `like_fallback_and_tag_search`） |
| SRCH-005 | N | 标签名搜索 | 搜标签词 | 命中挂该标签的素材（tag_names 进 FTS，已有） |
| SRCH-006 | B | 查询串含引号 `"`、星号 `*`、纯标点 `!!!` | 搜索 | 不崩溃、不注入、返回空或合理结果（已有 3 用例） |
| SRCH-007 | R | 文件名含 `%` `_` `\` | 1~2 字 LIKE 查询这些字符 | 转义正确：`%` 只作字面量、`_` 不作通配（已有 4 用例） |
| SRCH-008 | N | 改名素材/标签 | 搜索旧名/新名 | FTS 同步更新：旧名不命中、新名命中（已有 `rename_updates_index` / `fts_consistency_*`） |
| SRCH-009 | R | 删除素材/标签 | 搜索已删词 | 无幻影命中（已有 `delete_asset_clears_index` / `no_phantom_after_tag_removal` / `delete_tag_cascades_assignments_and_refreshes_fts`） |
| SRCH-010 | N | 前端高亮 | 命中项展示 | 命中词高亮（PRD R-04，手工走查） |
| SRCH-011 | B | 空串 / 仅空格查询 | 搜索 | 返回全部或空，不发非法 FTS 查询 |
| SRCH-012 | N | 混合查询「海边 2024」 | 搜索 | 命中同时含两词素材（多词语义，注意 BUG-D 顺序相关性——修复前记录现状） |
| SRCH-013 | R | 外部 python sqlite3 连库 | 执行 DELETE/UPDATE fts 相关表 | 因缺 cjk_bigram 报错被拦（架构约束：外部只读；SELECT 正常可用）——文档化验证 |
| SRCH-014 | B | 3 万条库 | 搜索 | 响应 <300ms（PRD ≤500ms，PERFORMANCE.md 更严） |

### M5 AI 打标（R-06 / R-08 / R-15 / v2.12 状态机）

**被测对象**：`services/ai_cloud.rs`（`run_cloud_batch` / `parse_categorized` / `parse_tags_strict` 语义 / `extract_anthropic_text` / `parse_model_ids` / `list_models` / `merge_frame_tags`）、`db/ai.rs`（批次/建议表、`confirm_suggestion_inner` / `confirm_all_pending`）、`commands/ai_cmd.rs`（`ai_cancel_batch`、进度 `ai://progress` 事件）、前端 `aiStore` / `Workbench` / `Filmstrip`。

**测试目标**：
1. 批次状态机：pending→processing→done/cancelled，done/cancelled 可续跑，processing 拒绝重复启动
2. 建议状态机：pending→confirmed/rejected，rejected 可 `ai_restore_suggestion` 恢复
3. 空解析 = 单条失败置 rejected（v2.12：不写空标签冒充成功）
4. 三通道（OpenAI 兼容 / Anthropic / Ollama 兼容本地）+ manual 模式
5. 视频抽帧（头/中/尾三帧，≥2 帧命中合并 `merge_frame_tags`）
6. profiles 多档案切换、模型列表拉取
7. 进度事件 + 取消 + 限流（batch_limit 500）

| ID | 类型 | 前置条件 | 步骤 | 预期结果 |
|---|---|---|---|---|
| AI-001 | N | 库内 3 张图，云端档案有效（mock） | createBatch → startBatch | 批次 pending→processing→done；3 条建议 tags 写入（DB 层已有 `ai_confirm_flow`，服务层补） |
| AI-002 | N | 批次含 5 条，startBatch(limit=2) | 跑批 | 仅前 2 条出建议；批 done 后再次「开始打标」续跑剩余 3 条（v2.12 续跑修复——核心回归） |
| AI-003 | B | 批次无 pending（全部已处理） | 再次 startBatch | 明确报错「无待打标项」，不空跑（v2.12） |
| AI-004 | B | 批次 processing 中 | 再次 startBatch | 拒绝（仅 processing 拒绝） |
| AI-005 | N | 手动模式 | createBatch | 批次直接 done，无网络请求，纯人工编辑（v2.10） |
| AI-006 | R | mock 返回空标签 `{}` / 非法 JSON / 空字符串 | run_cloud_batch | 单条置 rejected + tracing::warn，批次不中断，其余条正常（v2.12 空解析即失败） |
| AI-007 | N | 建议已生成 | confirm_suggestion | 状态 pending→confirmed；分类名建/复用父标签、标签词建/复用子标签、asset_tags 写入 + tag_ops 流水（actor=ai_cloud） |
| AI-008 | N | 建议已 rejected | ai_restore_suggestion | 恢复为 pending 可再确认（防误触） |
| AI-009 | R | 3 条 pending 建议 | confirm_all_pending | 单事务：全部 confirmed + asset_tags 写入；构造一条失败整批回滚（B20 原子性，已有 2 用例） |
| AI-010 | E | mock 返回 401 / 5xx / 超时（连接挂起） | 跑批 | 对应条目失败置 rejected（或批次失败），错误信息可见；不阻塞 UI（spawn_blocking） |
| AI-011 | E | 批次进行中调用 ai_cancel_batch | 取消 | 批次 cancelled；未完成条目保持 pending 可续跑；锁中毒返回 Err 不 panic（B11） |
| AI-012 | N | 批次 17+ 张（mock 快速响应） | 跑批观察 | `ai://progress` 事件持续推进，UI 可交互（PERFORMANCE.md 清单） |
| AI-013 | N | 视频素材 + 视频打标开关开 | 跑批 | 抽头/中/尾三帧送 AI；≥2 帧同标签才进合并结果（`merge_frame_tags`） |
| AI-014 | B | 三帧标签互相冲突 | 合并 | 只有 ≥2 帧共同命中的标签保留；单帧独有标签被丢弃（单元测 merge_frame_tags 变体） |
| AI-015 | N | 多档案 profiles A/B 配不同 base_url | 切换 active_profile 后跑批 | 请求打到 B 的 base_url；打标只走激活档案 |
| AI-016 | R | settings 含旧扁平字段（无 profiles） | 加载设置 | `normalize()` 迁移为 profiles 结构，旧数据不丢（已有 settings 单元 6 用例，补边界） |
| AI-017 | N | OpenAI 模式 / Anthropic 模式分别 mock | `list_models` + 跑批 | `parse_model_ids` 解析两种响应格式正确；Anthropic 走 `extract_anthropic_text` |
| AI-018 | B | 选中 501 张 | createBatch + startBatch | 受 batch_limit=500 约束：拒绝或拆分并明确提示（架构约束 4） |
| AI-019 | N | Workbench：分类 max=1 的分类 | AI 返回该分类 2 个标签 | UI 按 max 约束提示/截断；提示词中 max 与 UI 一致（架构约束 4） |
| AI-020 | N | 打标页胶片条多选 + 当前张已确认 | 批量套用 | 当前张标签套用到选中张（PRD v2.5 批量套用）——E2E/手工 |
| AI-021 | R | 撤销一次打标操作 | tag_ops undo | 按 batch_id 倒序反向操作且幂等（已有 `tag_ops_record_and_undo`，补 AI actor 场景） |
| AI-022 | E | 网络中断（mock 流式中断） | 跑批 | 已完成条目保留，中断条目可续跑；批次状态不卡 processing |

### M6 Ollama 一键部署（R-07）

**被测对象**：`services/ollama_installer.rs`（`builtin_sources` / `all_sources` / `validate_custom_source` / `validate_custom_count` / `download` / `install_silent` / `wait_ready` / `detect_installed` / `parse_version_output` / `exit_code_ok` / `probe_sources` / `resolve_sources_ordered` / `start_service` / `remove_installer`）、`services/ollama_setup.rs`（`ping` / `probe_gpu` / `recommend` / `pull` / `parse_pull_line` / `api_root`）、`commands/ollama_cmd.rs`。

**测试目标**：
1. 多源降级：内置源 + 自定义源有序探测，失败自动切换
2. 下载断点续传：中断后重下从断点继续
3. 静默安装 + 就绪复检（wait_ready 轮询）
4. 显存探测推荐模型档位
5. pull 模型 NDJSON 进度解析 + 一键建档

| ID | 类型 | 前置条件 | 步骤 | 预期结果 |
|---|---|---|---|---|
| OL-001 | N | mock 源 A 可用、源 B 超时 | `probe_sources` + `resolve_sources_ordered` | 探测结果反映可用性；排序后可用源在前（纯函数已有 13 用例，补集成） |
| OL-002 | E | 全部内置源不可达 | 下载 | 尝试自定义源；全部失败时明确报错并列出各源失败原因 |
| OL-003 | B | 自定义源 URL 非法（非 http/空/含空格） | `validate_custom_source` | 拒绝并给出原因（已有单元） |
| OL-004 | B | 自定义源数量超上限 | `validate_custom_count` | 拒绝（已有单元，验上限值） |
| OL-005 | N | mock 分块下载（本地 HTTP 服务） | `download` | 完整落盘，进度回调累计字节数单调递增至总大小 |
| OL-006 | R | 下载到 50% 中断（杀进程/断开 mock） | 再次 `download` | 断点续传：从已下载偏移继续，最终文件完整（哈希校验） |
| OL-007 | N | 假安装器（脚本模拟静默安装） | `install_silent` | 退出码 0 视为成功（`exit_code_ok`）；非零报错（已有单元） |
| OL-008 | N | mock `/api/version` 先拒绝后接受 | `wait_ready(base_url, max_wait)` | 轮询期内就绪返回版本串；超时返回 None 不 panic |
| OL-009 | N | 系统已装 Ollama | `detect_installed` | 检出 + `parse_version_output` 解析版本号（已有单元） |
| OL-010 | N | 显存 8G / 16G / 未知 | `recommend(vram_gb)` | 各档推荐模型合理（已有单元 3 用例，人工核对推荐表合理性） |
| OL-011 | N | mock `/api/pull` 输出典型 NDJSON 行 | `parse_pull_line` | pulling/downloading/verifying/success 状态与百分比解析正确（已有单元） |
| OL-012 | E | pull 中断（NDJSON 半行/连接断开） | `pull` | 报错或续拉；UI 进度不卡死 |
| OL-013 | N | pull 完成 | 自动建档案 | profiles 新增 Ollama 档案（base_url 指向本地、api_mode 正确），可立即用于打标 |
| OL-014 | E | Ollama 已装但服务未启动 | `ping` | 返回未就绪状态；触发 `start_service` 后转就绪 |
| OL-015 | N | 安装完成 | `remove_installer` | 安装包清理，重复调用幂等（返回 false 不报错） |
| OL-016 | B | 磁盘空间不足（模拟） | 下载 | 明确报错「空间不足」，不留半截文件占空间（或断点文件可续） |
| OL-017 | N | 真机 Windows 全流程 | 设置页一键安装 | 手工走查：下载→静默安装→就绪→pull 小模型→建档→打标一杆进洞（§四 MW-SET） |

### M7 批量操作与删除（R-31 / M2.0 / 回收站）

**被测对象**：`commands/assets_cmd.rs`（`delete_assets` 异步 + 四阶段）、`db/assets.rs`（`delete` / `soft_delete` / `restore`）、前端 `selectionStore` / `ContextMenu` / `DeleteDialog` / `AssetGrid`。

**测试目标**：
1. 多选语义全套（单击/Ctrl/Shift/Ctrl+A/Ctrl+I/右键菜单）
2. 删除双策略语义严格：软删入回收站；物理删二次确认；**磁盘删除失败不产生假删除**
3. 批量删除部分失败的部分成功语义
4. 回收站恢复完整性

| ID | 类型 | 前置条件 | 步骤 | 预期结果 |
|---|---|---|---|---|
| BAT-001 | N | 网格含 10 项 | 单击第 3 项→Ctrl+点第 5、7 项 | 选中 3 项，顶栏「已选中 3 项」（PRD v2.8） |
| BAT-002 | N | 已选中 1 项 | 再次单击该项 | 取消选中（独占选中再击取消） |
| BAT-003 | N | 已单击第 2 项为锚点 | Shift+点第 6 项 | 2~6 连续范围选中 |
| BAT-004 | N | 当前筛选结果 10 项 | Ctrl+A | 10 项全选；输入框聚焦时不拦截（PRD：快捷键不抢输入焦点） |
| BAT-005 | N | 10 项中已选 3 项 | Ctrl+I | 反选为其余 7 项 |
| BAT-006 | N | 网格空白处 / Esc | 点击/按键 | 清空选中 |
| BAT-007 | N | 素材卡片右键 | 打开菜单 | 含 打标(AI/手动二级)/导出/删除/复制路径/打开所在文件夹；空白处右键含 全选/反选/取消选择；Esc 关菜单 |
| BAT-008 | R | 菜单打开后点击菜单内部元素 | 点按钮 | 菜单不提前关闭（架构：捕获关闭必须排除菜单内部）——组件测试重点 |
| BAT-009 | N | 选中 3 项 | 删除→选「仅移出库」 | 3 项软删进回收站，磁盘文件保留，网格即时刷新 |
| BAT-010 | N | 选中 3 项 | 删除→选「删除文件」→二次确认 | 磁盘文件删除 + 记录删除；不确认可取消 |
| BAT-011 | R | 选中 2 项，其中 1 项磁盘文件已被外部占用/删除 | 物理删除 | 失败项**不从库删**（消除假删除，B02/B03）；DeleteDialog 显示失败明细不关弹窗 |
| BAT-012 | R | 批量删除混合存在/不存在 id | `assets::delete` | 已有 `batch_delete_mixed_existing_and_missing`：只删存在的，计数准确 |
| BAT-013 | B | 批量删除空数组 / 重复 id | `delete` | 空数组 0 影响；重复 id 只删一次（已有 2 用例） |
| BAT-014 | N | 回收站内 2 项 | 全选恢复 | 2 项回列表，标签/EXIF/缩略图路径完整；已生成过的高清缩略图可直接复用或重新生成 |
| BAT-015 | N | 软删项在回收站保留期内 | 重启应用 | 仍在回收站；过保留期后自动清理（`list_expired_trash` + 清理任务） |
| BAT-016 | E | 删除 1000 项 | 物理删除 | 异步执行 UI 不冻结；进度/结果反馈；缩略图目录同步清理（`delete_for_asset`） |
| BAT-017 | R | 删除含失败项后弹窗状态 | 观察 | OBS-2 已知瑕疵：失败时选中集已清空无法直接重试——验证失败项仍在库中可重新选择（数据正确性兜底） |
| BAT-018 | N | 前端选中后切换筛选 | setFilter | 选中清空（B09 回归，与 LIB-010 同源，此处验 UI 行为） |

### M8 导出（R-10 / R-26）

**被测对象**：`services/export_local.rs`（`export_local` / `unique_dest` / `write_csv_manifest`）、`db/assets.rs`（`update_file_path_and_name`）、`db/export.rs`（任务表）、`commands/export_cmd.rs`（`cancel_export`）。

**测试目标**：
1. 复制/移动双模式文件行为 + move 模式库记录同步（file_path/file_name）
2. 同名避让（后缀 (1)~(999)）+ 耗尽报错
3. layout 子目录组织（flat/by_tag/by_date）
4. CSV 清单（UTF-8 BOM，Excel 打开不乱码）
5. 任务状态机与取消

| ID | 类型 | 前置条件 | 步骤 | 预期结果 |
|---|---|---|---|---|
| EXP-001 | N | 库内 3 项，导出到空目录（复制） | `export_local(copy)` | 3 文件复制到位，库内 file_path 不变，任务 done（已有基础用例） |
| EXP-002 | R | 同上（移动） | `export_local(move)` | 文件移动 + DB `update_file_path_and_name` 同步，源文件消失，前端预览不失效（B04，已有 2 用例） |
| EXP-003 | N | 目标目录已有同名文件 | 导出 | 自动加 `(1)` 后缀；file_name 同步更新（已有 `b04_export_move_same_name_suffix_updates_db`） |
| EXP-004 | R | 目标目录已造 999 个同名占位 | 导出 | 返回「同名文件过多」Err 且任务 status=**failed**（BUG-QA-1 回归：不得停留 running，已有 `b06b_export_same_name_exhaustion_errors`） |
| EXP-005 | N | 素材带标签 A/B | by_tag layout | 生成 `A/`、`B/` 子目录各放一份（或多标签策略按主标签——以实际实现为准） |
| EXP-006 | N | 素材有拍摄时间 | by_date layout | 按 `YYYY-MM-DD`（或实际格式）归档子目录 |
| EXP-007 | N | flat layout | 导出 | 全部平铺目标根目录 |
| EXP-008 | N | 导出含中文名素材 | 完成 + 检查 CSV | CSV 为 UTF-8 **带 BOM**（Excel 直接打开中文不乱码）；文件名字段完整 |
| EXP-009 | N | 导出 2 项 | move 模式中 cancel_export | 任务取消；已移动的项库记录已同步（无悬空），未处理的保持原状（B11/B12 cancel 加固） |
| EXP-010 | E | 目标目录只读 / 跨盘移动 | 导出 | 只读报错任务 failed；跨盘 move 降级 copy+remove（B04：remove 失败记日志不阻塞） |
| EXP-011 | B | 导出空选中 / 选中项含已外部删除文件 | 导出 | 空选中拒绝；缺失项跳过或报明细，任务最终状态正确 |
| EXP-012 | N | 复制完成 | 校验 | 复制完整性校验（源/目标哈希或大小一致）（export_local.rs 含校验逻辑） |
| EXP-013 | E | 导出中目标盘拔出 | 导出 | 任务 failed 不卡 running；重试可用 |
| EXP-014 | N | move 后搜索原文件名 | 搜索 | 命中新路径记录（FTS 随 file_name 更新刷新，联动 SRCH-008） |

### M9 标签管理（R-05 / R-19 / R-25）

**被测对象**：`db/tags.rs`（create/update/delete/merge/reparent、递归 CTE 防环）、`db/asset_tags.rs`（assign/assign_inner）、`db/tag_ops.rs`（record/recent/undo）、`commands/tags_cmd.rs`（B25 限长校验）。

**测试目标**：
1. 父子层级 CRUD 与树计数联动
2. reparent 防环（自环/深环）、merge 防并入后代
3. 删除级联（子标签/关联/FTS 刷新无幻影）
4. tag_ops 流水完整、按 batch_id 倒序撤销且幂等
5. 命令层校验：trim/空/64 字符上限/控制字符拒绝

| ID | 类型 | 前置条件 | 步骤 | 预期结果 |
|---|---|---|---|---|
| TAG-001 | N | — | 创建父标签→创建子标签 | parent_id 正确；树导航显示层级（已有 `tag_tree_counts` 基础） |
| TAG-002 | R | 标签「风景→海边→日出」 | reparent「日出」到「风景」（自环场景：reparent到自己/后代） | 自环与深环被递归 CTE 拒绝（已有 4 用例：self/deep cycle/valid moves/nonexistent） |
| TAG-003 | N | 标签 A(3 素材) B(2 素材) | merge A→B | A 的素材与子标签转移给 B，A 删除（已有 `tag_merge_moves_assets_and_children`） |
| TAG-004 | R | A 是 B 的祖先 | merge A→B | 拒绝（已有 `tag_merge_into_descendant_rejected`） |
| TAG-005 | R | 父标签带子标签与素材 | 删除父标签 | 子标签级联删、asset_tags 清、FTS 刷新无幻影（已有 2 用例） |
| TAG-006 | B | 命令层：名称 64 字 / 65 字 / 空 / 纯空格 / 含控制字符 | create/update | 超长、空、控制字符拒绝；64 字正常（B25，代码审查已确认——补命令层测试） |
| TAG-007 | N | 素材挂标签（manual） | 查 tag_ops | 流水含 asset/tag/op=add/actor=manual/batch_id=NULL（已有 `tag_ops_record_and_undo`） |
| TAG-008 | N | AI 批次确认 3 条 | 查流水 + 撤销 | actor=ai_cloud + batch_id 记录；undo 按 batch_id 反向摘除全部 3 条且幂等（重复 undo 无副作用） |
| TAG-009 | B | 撤销时标签已被手动删除 | undo | 优雅处理：跳过/部分成功 + 明确结果，不 panic 不脏数据 |
| TAG-010 | N | EXIF 自身标签与 AI 分类标签并存 | 查看素材标签 | 两类分离展示；EXIF 标签只读、不进打标流（PRD v2.5） |
| TAG-011 | N | 同一素材重复挂同一标签 | assign | 幂等：关联不重复，计数不虚增 |
| TAG-012 | N | 分类=父标签复用（零新表） | AI 确认含新分类「情绪」 | 自动创建父标签「情绪」+子标签；再次确认同名复用不重复建 |
| TAG-013 | B | 标签名含特殊字符 `%` `_` `\` 空格 | 创建 + 搜索 | 创建成功；搜索转义正确命中（已有 `like_tag_name_with_special_char`） |
| TAG-014 | N | recent 流水查询 limit 0 / 501 / 100 | `tag_ops::recent` | 钳位 [1,500]（实现即有钳制） |
| TAG-015 | N | 删除标签后 recent 流水 | 查流水 | JOIN 后已删标签行不再返回（或保留历史——以实现为准，验证不报错） |

### M10 详情页 / 查看器（R-18 / v2.9）

**被测对象**：前端 `ViewerPage`（全屏查看器）、`Thumbnail.tsx`（双层缩略图 onError 回退）、`services/thumbnail.rs`（`get_or_create_hd`）、`services/video.rs`（双击播放）。

**测试目标**：
1. 双击进入全屏查看器，三段布局（大图/信息栏/胶片条）
2. 缩放平移手势语义（Alt+滚轮 0.2~10×、中键平移、右键临时 2.5×）
3. ←→ 过片、近尾自动翻页、Esc 退出
4. 高清缩略图优先 + 原图兑底；视频 H.264 内嵌播放、其他编码降级系统播放器
5. get_or_create_hd 锁契约（解码在锁外——历史饿死 Bug 防线）

| ID | 类型 | 前置条件 | 步骤 | 预期结果 |
|---|---|---|---|---|
| VW-001 | N | 网格有图 | 双击卡片 | 进入全屏查看器：不透明背景、淡入缩放动画、大图+信息栏+胶片条三段 |
| VW-002 | N | 查看器内 | Alt+滚轮向光标位置缩放 | 缩放范围 0.2×~10×，锚点为光标；纯 transform 不重排（性能策略） |
| VW-003 | N | 查看器内 | 中键按住拖拽 / 右键按住 | 中键平移；右键临时放大 2.5× 松开恢复（PRD v2.9） |
| VW-004 | N | 胶片条多张 | ←/→ 键与点击胶片条 | 切换素材，计数 n/N 正确；近尾自动翻页加载后续 |
| VW-005 | N | 查看器内 | Esc | 退出返回网格，选中态合理 |
| VW-006 | R | 高清缩略图已缓存 | 再次打开 | 缓存命中秒出（`api/preview.ts` 模块级缓存 + hd 文件缓存，已有 services 用例基础） |
| VW-007 | R | 高清未生成 | 滚动到可见区 | 按需生成 512px；期间占位图先显示后淡入替换（双层策略） |
| VW-008 | R | 并发请求 8 张高清 | `get_or_create_hd` 并发调用 | 全部返回且无死锁；解码期间其他 DB 请求不被饿死（**历史 Bug：大图解码期间持 DB 锁**——PERFORMANCE.md §2.3 病根，专项并发用例覆盖） |
| VW-009 | N | H.264 mp4 | 双击卡片 | 内嵌播放器播放（M1 必过路径） |
| VW-010 | E | HEVC/ProRes/损坏视频 | 双击卡片 | 降级调起系统播放器；无可用播放器时明确报错不崩溃 |
| VW-011 | N | 详情抽屉 | 打开 | 标签 + EXIF 元数据（相机/镜头/ISO/光圈/快门/焦距/拍摄时间）展示；无 EXIF 时字段缺省不显示占位乱码 |
| VW-012 | E | 占位图文件损坏/缺失 | 渲染缩略图 | `placeholderFailed` 回退 pulse 动画并触发 hd 生成（B27 前端行为） |
| VW-013 | B | 超大图（如 1 亿像素 RAW） | 查看器打开 | 高清层（受限边长）正常显示；原图兑底不 OOM |
| VW-014 | N | 查看器内视频 | 原生 controls | 播放/暂停/进度可控（PRD：视频走原生 controls） |
| VW-015 | E | 快速连续 ←→ 切换 20 次 | 快速操作 | 无内存泄漏/无请求堆积（取消过期请求或队列化）——性能联动手工项 |

### M11 设置页（R-12 / R-24 / R-32 / R-33）

**被测对象**：`db/settings.rs`（profiles/TagCategory/normalize）、`commands/settings_cmd.rs`、`commands/thumbnail_cmd.rs`（`clear_thumbnail_cache`）、前端 `SettingsPage` / `settingsStore`。

**测试目标**：
1. 分组导航 + 保存按钮位置规范（最后）
2. 多 API 档案 CRUD + active_profile 切换
3. 主题三态
4. 数据目录展示 / 打开文件夹 / 清缓存（文件删除 + DB 字段回写 NULL）
5. 设置加载失败不静默（B28：loadError 链路）

| ID | 类型 | 前置条件 | 步骤 | 预期结果 |
|---|---|---|---|---|
| SET-001 | N | — | 打开设置页 | 左侧分组导航（AI 打标/入库与总库/网盘/通用外观/数据与缓存）；保存按钮在最后一项后 |
| SET-002 | N | — | 新增档案→填 base_url/key/model→保存 | profiles[] 新增；列表可见可切换 active_profile（已有 `settings_roundtrip` DB 层基础） |
| SET-003 | N | 已有 2 档案 | 删除当前激活档案 | 拒绝或自动切换到其余档案（以实现为准），不得出现空激活态 |
| SET-004 | R | settings JSON 为旧扁平结构 | 加载 | `normalize()` 迁移；`skip_serializing` 只读旧字段，无双数据源（已有单元 6 用例） |
| SET-005 | B | settings JSON 损坏/缺字段 | 加载 | 不 panic；走默认值或明确错误（B28：Store 层 loadError 已设，UI 消费为 OBS-1 已知缺口——手工验证卡加载页而非误保存） |
| SET-006 | N | — | 主题切 light/dark/system | 立即生效；system 跟随 OS 切换；CSS 变量驱动（架构 4.5） |
| SET-007 | N | — | 数据与缓存页 | 展示数据库/缩略图目录；「打开所在文件夹」能打开 |
| SET-008 | R | 缩略图缓存有文件 | 清除缓存 | 缩略图文件删除 + DB placeholder/hd 路径回写 NULL（B27，已有 `b27_clear_all_thumbnail_paths_writes_null`）；网格重新懒生成 |
| SET-009 | N | 总库位置未配置 | 配置总库路径 | 保存后入库页分库名生效（联动 IMP-003） |
| SET-010 | B | 总库路径填网络盘/不存在路径/U盘后拔出 | 保存 + 入库 | 保存可存；入库时明确报错不崩溃 |
| SET-011 | N | TagCategory 管理 | 新增分类（name/hint/single/max） | 保存后打标页分类面板出现；max 写入提示词（联动 AI-019） |
| SET-012 | N | 打标时机开关 默认手动 | 切自动 | 行为符合 R-08（自动模式语义）；默认值手动 |
| SET-013 | N | 网盘分组 | 查看 | 显示但置灰/标注「二期开放 M2」（PRD R-12） |
| SET-014 | E | 保存时 DB 忙/失败 | 保存 | 错误提示可见，不静默丢配置 |
| SET-015 | N | API key 输入 | 保存后重开设置 | key 回显（明文存储为**已知问题**，安全专项 SP-SEC-01 跟踪，不作为功能缺陷） |

---

## 三、专项测试

### 3.1 中文搜索专项（含历史 BUG 回归矩阵）

**背景**：搜索是本产品投入最重的功能（README「真下过功夫」），也是历史缺陷最集中的模块（BUG-A/B/D 全在搜索链路）。历史 QA 报告（qa-test-report-2026-08-14.md §4）给出根因与修复方向；qa_edge_tests.rs 已埋 4 个回归标记用例。

#### 3.1.1 BUG 回归矩阵

> **2026-08-22 实测结论**：`cargo test --test qa_edge_tests` 53 用例全过，BUG-A/B/D 回归标记用例 **5 个全部转绿**（含后续追加的 `fts_ascii_middle_substring` token 中部子串、`fts_cjk_ascii_mixed_substring` BUG-B 正式用例、`fts_tag_order_both_orders` / `fts_tag_order_three_tags` BUG-D 双用例）。修复已在 2026-08-14 fix-plan（查询侧三路由：≤2 字 LIKE / 含非 CJK 走 FTS∪LIKE 并集 / 纯 CJK ≥4 字 2 字块 AND，见 `db/search.rs` 头部注释）+ V3 迁移（写入侧 cjk_bigram 边界插空格 + FTS 重建，`db/migrations.rs`）落地。下表「修复跟踪」列据此更新。

| Bug | 描述 | 回归用例（qa_edge_tests.rs） | 修复跟踪 | 验证数据集 |
|---|---|---|---|---|
| BUG-A（P1） | ASCII 3+ 字 token 内部子串搜索静默失败（搜 `202` 不命中 `IMG_2024_001.jpg`） | `fts_ascii_partial_token_substring` / `fts_ascii_partial_token_photo` / `fts_ascii_middle_substring`（中部子串 `024`/`oto`） | ✅ **已修复转绿**（2026-08-22 实测）——查询侧 FTS∪LIKE 并集 | `IMG_2024_001.jpg`、`photo001.jpg` |
| BUG-B（P2） | CJK 与数字/字母粘连合并单 token（`进度100%.jpg` 搜 `100%`/`度` 失败） | `fts_cjk_ascii_mixed_substring`（`100%`/`100`/`进度10`/`度` 四断言） | ✅ **已修复转绿**（2026-08-22 实测）——写入侧 V3：cjk_bigram 在 CJK↔非CJK 边界插空格 | `进度100%.jpg`、`IMG_海边合照01.jpg` |
| BUG-D（P2） | 多标签搜索命中依赖 group_concat 分配顺序（搜 `海边日落` 顺序相关） | `fts_asset_tag_join_order_independent` / `fts_tag_order_both_orders` / `fts_tag_order_three_tags` | ✅ **已修复转绿**（2026-08-22 实测）——查询侧 2 字块 AND 顺序无关 + 写入侧 V3 tag_names 排序 | 素材挂「日落+海边」两标签，两种分配顺序 |
| BUG-E（P2） | 前端 fetchAllIds 拉全量完整对象（内存/协议 scope 膨胀） | 前端无测试；**代码走查（2026-08-22）已修**——`libraryStore.fetchAllIds` 走 `api/assets.ts` 的 `list_asset_ids` 仅取 `number[]` id，后端 `b19_list_ids_capped_at_100000` 钳位 10 万 | ✅ 已修复（代码走查结论）；store 回归测试仍缺（G5） | 10 万条 mock 列表 |

#### 3.1.2 行为一致性矩阵（修复验收标准）

修复验收的黄金标准是「**同一素材的搜索行为不随查询字数/字符类型漂移**」：

| 查询 | 索引内容 | 期望 | 当前路径（FTS/LIKE） |
|---|---|---|---|
| `20`（2字） | `IMG_2024_001.jpg` | 命中 | LIKE ✓ |
| `202`（3字） | 同上 | **命中**（BUG-A：当前空） | FTS |
| `2024`（完整 token） | 同上 | 命中 | FTS ✓ |
| `photo`（token 前缀） | `photo001.jpg` | **命中**（BUG-A：当前空） | FTS |
| `海边`（2字 CJK） | `海边日落.jpg` | 命中 | LIKE ✓ |
| `海边日落`（4字短语） | 同上 | 命中且有序 | FTS 短语 ✓ |
| `海边` | `上海湖边.jpg` | **不命中**（短语防误命中设计） | ✓ |
| `度`（孤立 CJK） | `进度100%.jpg` | **命中**（BUG-B：当前空） | FTS/LIKE |
| `100` | 同上 | **命中**（BUG-B：当前空） | FTS |
| `100%` | 同上 | **命中**（BUG-B：当前空 + FTS `%` 语法风险） | FTS |
| `合照0`（跨 CJK-数字边界） | `IMG_海边合照01.jpg` | **命中**（BUG-B） | FTS |
| `海边日落`（标签序：日落先挂） | tag_names=`日 落 海 边` | **命中**（BUG-D：当前顺序相关） | FTS 短语 |
| `!!!`（纯标点） | 任意 | 空结果不崩溃 | ✓（已有） |
| `海边"落日`（含引号） | 含引号文件名 | 无注入、合理结果 | ✓（已有） |

#### 3.1.3 补充专项用例

| ID | 类型 | 内容 |
|---|---|---|
| SP-SRCH-01 | B | 查询长度 1/2/3/4/10 的 CJK 串分别走 LIKE/FTS 路径，断言路由正确且结果一致语义 |
| SP-SRCH-02 | B | 混合查询「海2024」「2024海」等 CJK+ASCII 组合，断言命中符合直觉（依赖 BUG-B 修复） |
| SP-SRCH-03 | R | group_concat 固化顺序回归：构造 5 种分配顺序，同一查询结果一致（BUG-D 修复验收） |
| SP-SRCH-04 | R | FTS 语法注入面：查询含 `"``*``(``NEAR` 等 FTS 保留字，不报 `fts5: syntax error`（历史发现：未加引号的 `%` 会触发语法错——当前代码统一加引号，守卫这条防线） |
| SP-SRCH-05 | N | 触发器全量回归：INSERT/UPDATE(改名/改标签)/DELETE(素材/标签/关联) 后 fts_content 与主表行数一致（防幻影/防漏索引），已有分散用例，建议合并为一致性探针 |
| SP-SRCH-06 | N | 外部工具直连约束：python sqlite3 对 fts_content 执行 DELETE 报错（缺 cjk_bigram）——文档化 + 手册化验证（TROUBLESHOOTING 联动） |
| SP-SRCH-07 | B | 3 万条库 + 短语查询 + LIKE 兜底双路径计时 <300ms（性能联动） |
| SP-SRCH-08 | N | 多标签 any/all 组合 × 搜索框共存：筛选结果内再搜索，交集正确（前端 store 用例） |

### 3.2 图像格式矩阵专项（结合 format_matrix.rs 扩展）

**现状**：format_matrix.rs 6 用例覆盖「可合成格式 × 双层」+「垃圾降级」+「白名单」；真实 RAW/HEIC 依赖 perf_probe 手动探针 + 老板素材走查（fixtures gitignore）。

**扩展方向**：真实样本 fixtures 化 + 矩阵补全。

#### 3.2.1 格式 × 层级 × 路径矩阵

| 格式 | 样本来源 | 占位层(320) | 高清层(512/1024) | 预期策略路径 | 断言 |
|---|---|---|---|---|---|
| JPG（EXIF 含缩略图） | 真实相机 | ✓ | ✓ | TIFF 遍历内嵌 | 出图+边长钳制+性能 ≤5ms |
| JPG（无 EXIF 缩略图） | 合成 | ✓ | ✓ | 全图解码 | 出图 |
| PNG | 合成 | ✓ | ✓ | 全图解码（256px 生成） | 出图 |
| WebP | 合成 | ✓ | ✓ | 全图解码 | 出图 |
| TIFF | 合成 | ✓ | ✓ | 全图解码 | 出图 |
| BMP / TGA | 合成 | ✓ | ✓ | 全图解码 | 出图（已有） |
| HEIC / HEIF | 真实 iPhone 样本 | ✓ | ✓ | heic_decode | 出图不偏色（目检） |
| CR2 / CR3（Canon） | 真实样本 | ✓ | ✓ | 内嵌预览 → FFD8 → rawler | 出图 |
| NEF（Nikon） | 真实样本 | ✓ | ✓ | 同上 | 出图 |
| ARW（Sony） | 真实样本 | ✓ | ✓ | 同上 | 出图 |
| RAF（Fuji） | 真实样本 | ✓ | ✓ | 同上 | 出图 |
| ORF（Olympus） | 真实样本 | ✓ | ✓ | 同上 | 出图 |
| RW2（Panasonic） | 真实样本（perf_probe 同款） | ✓ | ✓ | TIFF 遍历（magic 0x55 + tag 0x2E） | 出图 + ≤100ms |
| DNG | 真实样本 | ✓ | ✓ | 内嵌 → rawler | 出图 |
| 垃圾字节 / 截断 JPEG / 0 字节 | 构造 | 降级 | 降级 | 全部失败返回 None | 不 panic（已有，补变体） |
| 伪装扩展名 | 构造 | 尽力 | 尽力 | 内容嗅探 | 不 panic |

#### 3.2.2 专项用例

| ID | 类型 | 内容 |
|---|---|---|
| SP-FMT-01 | N | 上表全矩阵跑通（fixtures 就位后，参数化一条用例循环全部格式） |
| SP-FMT-02 | R | `.jpg` 禁用 FFD8 扫描的守卫用例：构造一个「正文里嵌了第二张小 JPEG」的 jpg，断言占位层不误抓（对应 PERFORMANCE.md 踩坑 4） |
| SP-FMT-03 | R | `cut_jpeg` 宽容裁剪：构造尾部 FF 填充的内嵌 JPEG，断言不误杀（踩坑 3） |
| SP-FMT-04 | R | IFD 偏移相对 TIFF 基准：用 APP1 前有字节的容器 JPG 验证 `locate_tiff_base` 定位正确（踩坑 1） |
| SP-FMT-05 | B | 并发解码压力：8 线程 × 大图，断言信号量（4 许可）生效、无死锁、峰值内存有界（FMT-013 的强化版，加内存采样） |
| SP-FMT-06 | N | HEIC 颜色回归：同一场景 HEIC vs 导出 JPG 对比直方图相似度（防解码偏色静默回归） |
| SP-FMT-07 | E | RAW 解码失败（rawler 不支持的机型）：优雅落到占位生成或明确失败标记，不 panic |
| SP-FMT-08 | N | 视频封面帧：mp4(mkv/mov 容器) × 内嵌封面有/无 × ffmpeg 有/无，六象限矩阵断言占位图产出与降级路径 |

### 3.3 并发与性能专项（对照 PERFORMANCE.md）

**基准（PERFORMANCE.md 实测，回归阈值取其整）**：

| 指标 | 实测值 | 回归阈值 | 守门方式 |
|---|---|---|---|
| JPG 320px 占位解码（debug+O3） | 1.9ms | **≤5ms** | perf_probe 断言化 |
| RW2 320px | 57ms | **≤100ms** | 同上 |
| RW2 1280px 高清 | 81ms | ≤150ms（建议） | 同上 |
| 3 万素材网格滚动 | 流畅 | 无白块卡顿、内存可控 | E2E + 手工（录屏佐证） |
| 搜索响应（3 万条） | — | **<300ms**（PRD ≤500ms） | DB 集成计时断言 |
| 入库 100 图 | — | 每张立即有占位图、页面不卡死 | 已有 `import_100_images_with_placeholders`（补 UI 不卡死观察项） |
| 打标批次 17+ 张 | — | 进度持续推进、UI 可交互 | 服务集成 + 手工 |

**专项用例**：

| ID | 类型 | 内容 |
|---|---|---|
| SP-PERF-01 | R | perf_probe 去 ignore/加阈值：`probe_real_files` 对 fixtures JPG/RW2 断言 ≤5ms/≤100ms；文件缺失时 skip（保留现状语义） |
| SP-PERF-02 | R | dev O3 清单守卫：测试读取 `Cargo.toml` 断言 image/zune-jpeg/png/kamadak-exif/rayon 均在 `[profile.dev.package]` opt-level=3（防「新增依赖忘加 O3」静默回归——PERFORMANCE.md 明确要求） |
| SP-PERF-03 | N | DB 锁契约压测：一线程长跑 `get_or_create_hd`（大图解码）+ 并发线程做 `assets::list`，断言 list 不被饿死（历史锁饿死病根回归） |
| SP-PERF-04 | N | 导入并发：100 张 rayon 并行（②a 锁外）+ 期间并发查询列表，无长阻塞 |
| SP-PERF-05 | B | 3 万条数据集生成脚本（§5.3）+ `list`/`list_ids`/搜索计时断言 |
| SP-PERF-06 | R | BUG-E 回归：前端 store 测试 mock 10 万条，断言 `fetchAllIds` 只传 id 轻量参数（若已实现 list_asset_ids）或记录现状 |
| SP-PERF-07 | N | 高清缩略图 LRU：设置容量上限后连续生成 > 上限的 hd，断言 `cleanup_lru`（启动 + 每 100 次节流触发）清到限内 |
| SP-PERF-08 | N | 前端性能走查（手工）：3 万网格滚动 FPS 观察、快速输入搜索防抖、查看器快速过片无堆积 |
| SP-PERF-09 | B | 冷启动：3 万条库启动应用，首屏网格可交互时间可接受（记录基线） |

### 3.4 数据完整性与崩溃恢复专项

**测试目标**：任何时点断电/杀进程后，重启应用库可打开、数据不丢、不脏；迁移可重入。

| ID | 类型 | 内容 |
|---|---|---|
| SP-INT-01 | R | 迁移幂等（已有 `migrate_twice_is_idempotent` / `migrate_after_data_preserves_rows` 保持） |
| SP-INT-02 | R | V2 崩溃恢复三态（已有 3 用例）：全新安装全列 / version 回退列全在 / 部分列缺失补回。**注（2026-08-22）**：schema 已推进至 V6（migrate_v2/v3/v5/v6，`migrations.rs`），崩溃恢复用例只覆盖 V2；V3（FTS 重建）的「重建中崩溃→重跑收敛」语义靠 `v3_rebuild_normalizes_fts_content` 维持，V5/V6 无专项用例，建议扩展 |
| SP-INT-03 | B | 迁移中断注入：在 migrate_v2 各 ALTER 之间模拟中断（构造中间态 DB 文件），重跑 migrate 收敛 |
| SP-INT-04 | E | 导入中途杀进程：重启后库内记录与磁盘托管文件一一对应（无「有记录无文件」/「有文件无记录」），重复导入可继续 |
| SP-INT-05 | E | 导出（copy/move）中途杀进程：move 半途素材的库记录与文件位置一致（要么旧要么新，不出现「两边都没有」） |
| SP-INT-06 | E | AI 批次 processing 中杀进程：重启后批次可续跑或可取消，无永久 processing 僵尸批 |
| SP-INT-07 | E | WAL 断电语义：写事务进行中断电，重启库可打开（SQLite WAL 自保证，用 kill -9 模拟验证打开成功 + `PRAGMA integrity_check` 通过） |
| SP-INT-08 | N | 回收站过期清理中断重启：清理任务幂等，不重复删/漏删 |
| SP-INT-09 | N | 磁盘文件外部删除/移动后库自愈：列表不崩、缩略图回退、导出报缺失明细（LIB-016/EXP-011 联动，专项汇总验证） |
| SP-INT-10 | B | 外部工具直连只读约束验证（SP-SRCH-06 的完整性视角）：外部误写被 cjk_bigram 缺失拦下后，库文件仍完好 |

### 3.5 安全与隐私专项

| ID | 类型 | 内容 | 现状口径 |
|---|---|---|---|
| SP-SEC-01 | 已知问题 | API key 明文存储于 settings JSON（README 免责声明已披露） | 登记跟踪：文档化「敏感数据不入库」边界；不作为 demo 阻塞项 |
| SP-SEC-02 | N | 路径穿越：分库名 `../`、改名模板注入路径分隔符、导出目标目录构造越界 | IMP-004 联动 + 独立构造：最终路径必须仍在预期根内（R-32「禁止路径穿越」） |
| SP-SEC-03 | N | SQL 注入面：搜索词/标签名含 `'` `%` `_` `\` 引号拼接（已有 LIKE 转义 4 用例 + FTS 引号 2 用例，保持）；参数化查询走查确认无字符串拼接 SQL | 已覆盖良好 |
| SP-SEC-04 | N | FTS 语法注入：查询含 FTS 保留字/操作符不崩溃不报语法错（SP-SRCH-04 联动） | 已有引号守卫，保持 |
| SP-SEC-05 | N | asset 协议 scope：越权 URL 访问未放行路径（thumbnails/previews 外）被拒（B08 scope 收敛回归） | 走查 + E2E |
| SP-SEC-06 | N | `reveal_in_folder` / `get_preview` 路径校验：传入非库内路径被拒（B24：normalize_path + find_by_path / ensure_absolute） | 命令层测试空白——列为 G2 补测重点 |
| SP-SEC-07 | B | 超长输入：标签名 65 字、搜索词 10KB、分库名超长——拒绝或安全截断不 panic | B25 已限标签，其余补 |
| SP-SEC-08 | N | 隐私默认：断网状态下应用全功能可用（除云打标/模型拉取/Ollama 下载明确提示）；无任何遥测上报流量（抓包验证） | 手工 |
| SP-SEC-09 | N | Ollama 自定义源 URL 校验：阻止 `file://` 等非 http(s) scheme（validate_custom_source 已有单元，保持） | 已覆盖 |

---

## 四、手工验收走查清单（按 PRD 页面）

> 勾选项形式；执行环境：Windows 11 + release 构建 + fixtures 数据集。每轮走查全量执行 P0 项（★），P1 项按版本重点抽选。

### MW-IMP 入库页（R-01/R-32）

- [ ] ★ 拖拽图片+视频混合文件入待入库区，仅入清单不执行（库/磁盘无变化）
- [ ] ★ 文件选择器批量加入，清单统计（图片数/视频数/总大小）正确
- [ ] ★ 点「开始入库」执行：进度可见、结果汇总（成功 N、失败 M、重复 K）准确
- [ ] ★ 入库后每张卡片立即有占位图（无空白闪烁）
- [ ] 分库名填写后文件复制进 总库/分库/（源文件保留）
- [ ] 改名构造器：点选 token 变色排序、再点取消、序号位数手输、实时预览首文件名
- [ ] 非法字符分库名自动替换下划线
- [ ] 清单列表/网格双视图切换（列表纯文字、网格懒加载缩略图）
- [ ] 取消入库：已有部分导入时提示「用户取消（已导入 N 条）」
- [ ] 重复导入识别为「重复」不重复入库
- [ ] 入库损坏文件：计失败、错误明细可见、其余继续

### MW-LIB 素材库页（R-02/R-03/R-04/R-14/R-31）

- [ ] ★ 类型筛选 全部/图片/视频/未打标 计数与切换正确
- [ ] ★ 搜索中文文件名/标签名命中且高亮；「海边」不误命中「上海湖边」
- [ ] ★ 选中操作条并入顶栏：「已选中 N 项 | 打标(AI/手动) | 导出 | 删除」
- [ ] 单击选中/再击取消、Ctrl 加减选、Shift 范围选、Ctrl+A、Ctrl+I、空白处/Esc 清选
- [ ] 右键菜单项齐全（打标二级/导出/删除/复制路径/打开所在文件夹；空白：全选/反选/取消）
- [ ] 标签树父级折叠/展开、父标签合计计数、点父连带筛子标签素材、「未打标」入口有效
- [ ] 排序（时间/大小/分辨率）升降序正确
- [ ] 3 万级数据滚动流畅无白块
- [ ] ★ 删除双策略弹窗：仅移出库（文件保留）/ 删除文件（二次确认）；结果即网格即时刷新
- [ ] 回收站恢复后数据完整
- [ ] 双击卡片进入查看器（转 MW-VW）

### MW-AI 打标页（R-06/R-08/v2.10~v2.12）

- [ ] ★ 素材库选图跳转自动建批并立即展示图片（AI 不自动跑）
- [ ] ★ 手动点「开始打标」：云端模式左栏出现按钮、批次进度推进、UI 可交互
- [ ] 范围选项「打标全部 / 仅打标前 N 张」可输 N；剩余素材可续跑
- [ ] 手动模式：批次直接就绪，纯人工编辑
- [ ] 模式切换（云端/本地 Ollama/手动）点选生效；多档案切换生效
- [ ] 工作台：上大图、中胶片条（状态角标 待打标/已建议/已确认、Ctrl 多选）、EXIF 只读行、下分类标签面板（一排两个分类）
- [ ] 拒绝可撤销（已拒绝一键恢复）
- [ ] 确认写入：分类建父标签、标签建子标签、素材库树可钻取
- [ ] 全部确认批量生效；分类 max 上限约束 UI 与提示词一致
- [ ] ←/→/Enter 快捷键与悬浮导航条（位置跳转输入）可用
- [ ] 批量套用：胶片条多选后当前张标签套用到选中张
- [ ] 空解析模型回复：单条置 rejected 不冒充成功，可恢复
- [ ] 视频素材打标（开关开）：抽帧进行、标签合并合理
- [ ] 主 CTA 黑色实心（开始打标/确认写入/全部确认），其余幽灵按钮（UI 规范）

### MW-VW 查看器（R-18/v2.9）

- [ ] 双击进入：不透明新界面、淡入缩放动画
- [ ] Alt+滚轮以光标为锚缩放（0.2~10×）；中键平移；右键按住临时 2.5×
- [ ] ←→ 过片、胶片条点击切换、近尾自动翻页、Esc 退出
- [ ] 底部信息栏：文件名/标签/尺寸/大小/EXIF 齐全
- [ ] 高清图先占位后淡入替换；原图兑底
- [ ] H.264 视频内嵌播放必过；HEVC 降级系统播放器
- [ ] 视频原生 controls 可用

### MW-EXP 导出（R-10/R-26）

- [ ] 复制导出：文件到位、库记录不变、CSV 清单 Excel 打开中文不乱码
- [ ] 移动导出：文件移动、库路径同步、预览不失效
- [ ] 同名避让后缀 (1)…；目标只读/跨盘异常有明确提示
- [ ] layout 子目录 flat/by_tag/by_date 组织正确
- [ ] 导出进度与取消可用

### MW-SET 设置页（R-12/R-24/R-32/R-33）

- [ ] 左侧分组导航五组齐全；保存按钮在最后
- [ ] API 档案增删改、切换激活、模型列表自动拉取（失败可手输兜底）
- [ ] api_mode OpenAI/Anthropic 双模式均可保存
- [ ] 主题 light/dark/system 三态即时生效
- [ ] 数据目录展示 + 打开所在文件夹
- [ ] 清除缩略图缓存后网格重新生成占位
- [ ] 总库位置配置后入库页分库名生效
- [ ] 网盘分组置灰标注「二期开放」
- [ ] TagCategory 分类管理（新增/改名/删除、max 上限）
- [ ] ★ Ollama 一键部署真机全流程：下载（多源）→静默安装→就绪复检→显存推荐→pull 模型→自动建档→本地打标跑通

### MW-GLOBAL 全局

- [ ] 底栏 3 个纯文字按钮居中、当前页高亮、任何状态下底栏内容不变
- [ ] 左上角设置按钮进入/再点返回原页
- [ ] 黑白灰配色、苹果式动效、深色模式完整（CSS 变量无漏网硬编码色）
- [ ] 断网状态：本地功能全部可用，云端功能明确提示
- [ ] 长时间运行（导入 1000 张 + 滚动 + 搜索 + 打标批次）无内存持续增长

---

## 五、测试数据准备

### 5.1 样本文件清单（fixtures）

| 类别 | 清单 | 数量 | 用途 | 来源 |
|---|---|---|---|---|
| 基础可编码 | jpg/png/webp/bmp/tga/tif 各 3 张（大/中/小） | 18 | 格式矩阵、入库管线 | image crate 合成（已有 sample_image 模式） |
| 真实相机 JPG | 含完整 EXIF + IFD1 缩略图（perf_probe 同款 `_1091370.JPG`） | 2 | 内嵌预览路径、EXIF 提取、性能 ≤5ms | 老板素材 |
| 真实 RAW | RW2（必配）+ CR2/CR3/NEF/ARW/RAF/ORF/DNG 各 1 | 8 | RAW 策略链、性能 ≤100ms | 各机型样张（公开样本库可下载） |
| HEIC/HEIF | iPhone 拍摄样张 | 2 | HEIC 解码 + 颜色回归 | iPhone 实拍 |
| 损坏样本 | 截断 JPEG、垃圾字节 .jpg、0 字节、坏 TIFF（IFD 越界） | 4 | 降级不 panic | 脚本构造 |
| 特殊文件名 | `进度100%.jpg`、`IMG_2024_001.jpg`、`photo001.jpg`、`海边"落日".jpg`、`图*片.jpg`、`!!!.jpg`、含 `%_\` 字符名、超长名（>255） | 10 | BUG-A/B/D 回归、LIKE 转义、FTS 注入 | 脚本构造（历史 QA 报告复现集） |
| 视频 | H.264 mp4（小）、HEVC mp4、损坏 mp4、大体积视频（≥1GB）、mkv/mov 容器、含/不含内嵌封面各 1 | 8 | 视频入库/封面帧/播放降级/抽帧打标 | ffmpeg 合成 + 公开样本 |
| 同内容异名 | 两份字节相同文件 | 2 | 哈希去重 | 复制 |
| 中文路径样本 | 深层中文目录中的图片 | 2 | 路径处理 | 脚本构造 |

**组织方式建议**：`src-tauri/tests/fixtures/`（.gitignore 大文件，目录内放 `README` 登记每个样本的机型/用途/来源）；测试用 `env::var("BAGERTEA_FIXTURES")` 定位目录，未设则 skip 真实样本用例（保持 `cargo test` 开箱即绿，与 perf_probe 的「文件不存在跳过」语义一致）。

### 5.2 环境矩阵（执行时勾选）

| 维度 | 必测组合 | 抽测组合 |
|---|---|---|
| OS | Windows 11 + release | Windows 10、macOS |
| ffmpeg | 有、无 | — |
| Ollama | 未安装（全新安装流） | 已安装（detect 流） |
| 网络 | 正常、断网 | 弱网（限速） |
| 数据规模 | 空库、100 条、3 万条 | 10 万条（BUG-E 验证） |
| 构建 | release（性能与走查） | dev+O3（性能探针对照） |

### 5.3 数据生成脚本需求

| 脚本 | 用途 | 说明 |
|---|---|---|
| `gen_bulk_assets.rs`（或 sql 脚本） | 3 万/10 万条 assets + 标签 + FTS 直插 | 供 LIB 性能、SP-PERF-05/06、SRCH-07；直插 DB 需触发器同步 FTS（或走 importer 批量导入小图） |
| `gen_special_filenames.sh/ps1` | 特殊文件名样本集 | BUG-A/B/D 回归数据一键重建 |
| `gen_videos.sh` | ffmpeg 合成 H.264/HEVC/损坏/大视频 | 视频专项 |

---

## 六、优先级与执行计划

### 6.1 P0 冒烟集（每次构建必跑，目标 ≤15 分钟）

| 内容 | 来源 | 说明 |
|---|---|---|
| 既有全部活跃 cargo 用例（147 个） | db_integration 20 + qa_edge_tests 53 + services_integration 9 + format_matrix 6 + src 单元 59 | 现状即冒烟集（2026-08-22 实测 147 全绿）；**BUG-A/B/D 回归标记用例 5 个已转绿并显式记录** |
| 前端 typecheck + vite build | 现有 | 已有门禁保持 |
| 新增：搜索回归矩阵跑批 | SP-SRCH 表 + 3.1.2 一致性矩阵 | 修复验收的唯一裁判 |

### 6.2 P1 核心回归（每版本/每里程碑跑）

| 内容 | 缺口编号 | 工作量级 |
|---|---|---|
| AI 打标服务层集成（wiremock：正常/空解析/401/超时/取消/续跑/视频抽帧） | G3 | 大（~15 用例） |
| Ollama 集成（mock HTTP + 假安装器） | G4 | 中（~10 用例） |
| 视频后端集成（fixtures + ffmpeg 双态） | G8 | 中（~8 用例） |
| 命令层抽样（delete_assets / reveal_in_folder / get_preview 校验路径） | G2/G6 | 中 |
| 前端 store 测试 10 用例（selection/library/ai/settings 核心状态迁移） | G5 | 小-中 |
| fixtures 数据集建立 + 真实 RAW/HEIC 矩阵 | G9 | 中（依赖样本收集） |
| CI 载体搭建（P0 冒烟自动化） | G10 | 中 |

### 6.3 P2 全面回归（大版本/重构后跑）

| 内容 | 缺口编号 |
|---|---|
| 前端组件测试（RenameBuilder / Workbench / AssetGrid / ContextMenu / DeleteDialog 等 15~25 用例） | G5 |
| E2E 冒烟 4~6 条旅程（tauri-driver + Playwright）：入库→浏览→搜索→打标→确认→导出；删除恢复；查看器；设置切换 | G6 |
| 性能守门 CI 化（perf_probe 断言 + 每日跑） | G7 |
| 手工走查清单全量（§四，含 ★ 项） | — |
| 并发压力专项（SP-PERF-03/04/05） | — |

### 6.4 建议落地顺序（1→6）

1. **确认基线**：跑 `cargo test` 全量，登记 BUG-A/B/D/E 回归标记用例红绿状态（半天，零成本，最重要）
2. **搜索专项矩阵**：把 §3.1.2 一致性矩阵落成可执行用例（含 BUG-B/D 补埋用例）（1~2 天）
3. **fixtures 建立 + 格式矩阵扩展**：样本收集 + `SP-FMT` 系列（2~3 天，含样本收集等待）
4. **AI/Ollama/视频服务层补测**：wiremock 引入 + G3/G4/G8（3~5 天）
5. **前端 store + 关键组件测试**：vitest 起步（2~4 天）
6. **E2E + 性能守门 + CI**：tauri-driver 打通后接旅程（3~5 天）

---

## 附录 A：历史 Bug / 修复项 → 回归防线对照总表

| 历史项 | 一句话 | 回归防线用例 | 位置 |
|---|---|---|---|
| BUG-A | ASCII token 内部子串搜索失败 | `fts_ascii_partial_token_substring` / `fts_ascii_partial_token_photo` + SP-SRCH 矩阵 | qa_edge_tests.rs |
| BUG-B | CJK+数字粘连跨边界搜索失败 | 待补正式用例（历史报告 §4 记录）+ SP-SRCH-01/02 | — |
| BUG-D | 多标签搜索顺序相关 | `fts_asset_tag_join_order_independent` + SP-SRCH-03 | qa_edge_tests.rs |
| BUG-E | fetchAllIds 全量拉取 | SP-PERF-06（store 层） | — |
| BUG-QA-1 | unique_dest 耗尽任务卡 running | `b06b_export_same_name_exhaustion_errors` + EXP-004 | services_integration.rs |
| AssetFilter limit=0 | 历史钳位 Bug | `pagination_limit_zero_clamped` + LIB-003 | qa_edge_tests.rs |
| B01/B14/B15 | 导入拆锁/取消 | `b01_import_cancel_zero_imported` + IMP-010 | services_integration.rs |
| B02/B03 | 删除异步化/假删除消除 | BAT-011 + 代码审查结论保持 | assets_cmd |
| B04 | move 同步库 | `b04_export_move_*` ×2 + EXP-002/003 | services_integration.rs |
| B06a/b | 同名不静默覆盖 | IMP-012 + EXP-004 | importer/export_local |
| B08 | 协议 scope 收敛 | SP-SEC-05 | lib.rs |
| B09 | 筛选清选中 | LIB-010/BAT-018 | libraryStore |
| B11/B12 | cancel 锁中毒加固 | AI-011 + EXP-009 | ai_cmd/export_cmd |
| B19 | limit 硬上限 | `b19_list_limit_hard_cap_1000` / `b19_list_ids_capped_at_100000` + LIB-005/006 | qa_edge_tests.rs |
| B20 | 批量确认原子 | `b20_confirm_all_pending_*` + AI-009 | qa_edge_tests.rs |
| B24 | 命令路径校验 | SP-SEC-06 | assets_cmd/thumbnail_cmd |
| B25 | tag 限长 | TAG-006 | tags_cmd |
| B27 | 缩略图 clear 回写 | `b27_clear_all_thumbnail_paths_writes_null` + SET-008/VW-012 | qa_edge_tests.rs |
| B28 | settings 错误状态 | SET-005（OBS-1：UI 未消费 loadError 为已知体验缺口） | settingsStore/SettingsPage |
| B33 | Workbench useEffect deps | 组件测试覆盖项（G5） | Workbench.tsx |
| B37 | V2 迁移容错（schema 现为 V6，见 §3.4 注记） | `b37_*` ×3 + SP-INT-02/03 | qa_edge_tests.rs |
| FTS 幻影命中 | 删除/改名后残留 | SRCH-009 系列（已有 5+ 用例） | 多处 |
| 锁饿死 | 解码持 DB 锁 | SP-PERF-03 + VW-008 | thumbnail.rs |
| O3 清单 | 新依赖忘加 O3 | SP-PERF-02 | Cargo.toml |
| OBS-1/2/3 | 已知 UX 瑕疵 | 走查观察项（不阻塞） | SettingsPage/DeleteDialog/stage_file |

## 附录 B：既有自动化用例清单速查（避免重复设计）

| 文件 | 用例数 | 主题 |
|---|---|---|
| `src-tauri/tests/db_integration.rs` | 20 | FTS 索引/子串/短语防误命中/LIKE 兜底/幻影/改名/删索引/树计数/reparent 环/merge 双向/去重分组/分页筛选/排序多标签/settings 往返/AI 确认流/suggestion_last_error 往返/种子幂等/软删恢复/tag_ops 撤销 |
| `src-tauri/tests/qa_edge_tests.rs` | 53 | 迁移幂等 ×2 / 级联删除 ×3 / LIKE 转义 ×4 / FTS 边界 ×9（引号/星号/纯标点/emoji/空格/混合路由/前缀 token/3-4 字防误命中）/ BUG-A ×3 / BUG-B ×1 / BUG-D ×3 / 批量删除 ×4 / reparent ×4 / 分页 ×4 / FTS 一致性 ×2 / list_ids ×2 / V3 ×2 / B19 ×2 / B20 ×2 / B27 ×1 / B37 ×3 |
| `src-tauri/tests/services_integration.rs` | 9 | 入库 100 张 / 高清缓存 / move 同步 ×2 / 取消 / 同名耗尽 / 导出完整性 / 缩略图清理 / 托管导入 |
| `src-tauri/tests/format_matrix.rs` | 6 | 白名单 / 可编码双层 / 垃圾降级 / 截断 JPEG / 高清层降级 / heic+raw 守卫 |
| `src-tauri/tests/perf_probe.rs` | 4（ignored） | 真实文件探针 / EXIF 诊断 / 混合格式吞吐 / RAW 库走查 |
| `src-tauri/tests/dev_maintenance.rs` | 1（ignored） | 真实库维护工具 |
| src 内单元 | 59 | bigram/path/settings/ai_cloud 解析/importer 改名/exif/heic/raw/imaging/ollama_installer 纯函数/ollama_setup 纯函数 |

---

---

## 附录 C：实测执行记录（2026-08-22，Windows 11 + dev 构建）

> 本节为「按本文档执行一轮 P0 冒烟」的实测快照，作为后续迭代基线；每轮执行按同一模板追加一行。

### C.1 执行环境与命令

| 项 | 值 |
|---|---|
| 执行日期 | 2026-08-22 |
| OS / 构建 | Windows 11（本机）/ cargo dev 构建 |
| 命令 | `cargo test`（全量，src-tauri/）｜`npm run typecheck` ｜`npm run build` |
| 耗时 | cargo test 约 19s（services_integration 15s 占大头）；build 1.7s |

### C.2 结果汇总（P0 冒烟 ✅ 全绿）

| 目标 | 用例数 | 结果 |
|---|---|---|
| src 单元测试（59）+ db_integration（20） | 79 | ✅ 79 passed |
| qa_edge_tests（53） | 53 | ✅ 53 passed（**BUG-A/B/D 回归标记 5 用例全绿**） |
| services_integration（9） | 9 | ✅ 9 passed（15.05s） |
| format_matrix（6） | 6 | ✅ 6 passed |
| perf_probe（4）+ dev_maintenance（1） | 5 | ⏭ 按设计 ignored |
| 前端 typecheck | — | ✅ 通过 |
| 前端 vite build | — | ✅ 通过（96 modules，JS 364KB gzip 108KB，1.70s） |

**结论**：P0 冒烟集 147/147 通过，符合 §1.6 准出标准之「P0 冒烟 100% 通过 + BUG-A/B/D 状态已知（绿）」。

### C.3 本轮实测附带发现（供 P1 计划参考）

| # | 发现 | 级别 | 说明 |
|---|---|---|---|
| C-F1 | G1 已闭合：搜索回归矩阵无红项 | ✅ 正 | BUG-A/B/D/E 修复均落地且已被用例/走查覆盖（详见 §3.1.1 跟踪列） |
| C-F2 | 迁移版本号落后于代码 | 文档 | schema 已 V6（migrate_v2/v3/v5/v6），本策略多处提及「V2 迁移」已修订；B37 崩溃恢复用例仅覆盖 V2，V5/V6 无专项 |
| C-F3 | qa_edge_tests 用例清单较文档更丰富 | 文档 | 追加了 `fts_ascii_middle_substring` / `fts_cjk_ascii_mixed_substring` / `fts_tag_order_both_orders` / `fts_tag_order_three_tags` / `fts_mixed_cjk_ascii_routing` / `fts_emoji_query_no_false_positive` / `fts_cjk_prefix_tokens_ok` / `v3_*` ×2 等（附录 B 已同步） |
| C-F4 | PowerShell 下 `cargo test` 退出码误报 | 工程 | `cargo test 2>&1 \| ...` 因 cargo 向 stderr 写进度在 pwsh 中被置为非零退出码（NativeCommandError），**不是测试失败**；CI 脚本须用 `$LASTEXITCODE` 显式取值或用 bash |
| C-F5 | vite build 依赖 esbuild 子进程 | 环境 | 受限沙箱下 esbuild spawn 报 EPERM；本机正常执行无碍 |
| C-F6 | ~~`vite.config.ts` 注释乱码~~→ **更正：无此问题** | 澄清 | 首次以 read 工具查看时因解码方式（GBK 解 UTF-8）显示乱码；经字节级校验（hex 均合法 UTF-8，如「开」=`E5 BC 80`）确认文件本身是合法 UTF-8，注释「Tauri 开发约定：固定 1420 端口、不清屏」「不监听 Rust 构建产物…」内容完整正确，**无需修改** |
| C-F7 | fixtures 目录未建立（G9 未动） | 前置 | `src-tauri/tests/fixtures/` 不存在，真实 RAW/HEIC/视频矩阵仍是 P1 前置依赖 |
| C-F9 | **新增测试基线**：AI 服务层 11 集成用例 + Ollama 服务层 8 集成用例 | ✅ 正 | `tests/ai_service_integration.rs` / `tests/ollama_service_integration.rs`（共用 `tests/common` 同步 mock），覆盖 G3/G4 核心状态机；本轮发现 2 个真实行为缺陷（F15）并**已修复**（服务层 `run_cloud_batch` + 命令层 `ai_start_batch` 预检），用例已转为修复语义断言，含取消续跑回归 `resume_after_cancel_skips_generated` |
| C-F10 | **前端测试起步**：vitest 24 用例（selection/library/ai 三 store） | ✅ 正 | `npm run test:unit` 全绿；覆盖 B09 回归（筛选清选中/removedInView）、BUG-E 轻量参数、AI 状态机迁移 |
| C-F8 | CI 载体不存在（G10 未动） | P1 | 全仓库无 .github/workflows / 本地 CI 脚本；「每次构建必跑」缺执行载体。**2026-08-22 已补**：`smoke.yml` + `scripts/smoke.ps1`（稳定组并行 + 网络组串行 retry + typecheck/build/vitest），见附录 D.4 |

---

## 附录 D：补全建议（针对 §1.2~§6.4 中「有方向、无落点」处的具化）

> 本附录把策略文档里只给了方向未给落点的地方补齐为可直接执行的内容，全部为「测试设计」产物，不含源码修改。

### D.1 E2E 旅程卡片（§1.2 L5 / §6.3 的「4~6 条」具化）

每张卡片 = 一条完整用户旅程，用 tauri-driver + Playwright（chromium backend）执行，mock 层为真实后端（测试库）。

| # | 旅程名 | 步骤序列 | 断言锚点 |
|---|---|---|---|
| E2E-01 | 入库→浏览→搜索→打标→确认→导出（黄金路径） | 拖 3 张 fixture 图入库 → 网格出现缩略图 → 搜「海边」命中且高亮 → 建 AI 批（manual 模式）→ 手动确认写入 → 导出 copy → 检查目标目录 3 文件 + CSV BOM | 库/磁盘/导出目录三方一致；搜索无误命中 |
| E2E-02 | 删除双策略 + 回收站恢复 | 删 1 项「仅移出库」→ 回收站可见 → 恢复 → 回列表且标签在；再删 1 项「删除文件」→ 磁盘文件不存在 | 软删文件保留、物理删文件消失、恢复完整性 |
| E2E-03 | 查看器交互 | 双击进全屏 → Alt+滚轮缩放 → ←→ 过片 → Esc 退出 | 缩放 0.2~10×、计数 n/N、不残留全屏态 |
| E2E-04 | 设置主题 + 档案切换 | 设置页切 dark → 立即生效；新增档案并设 active → 打标页内档案下拉显示 | CSS 变量切换、档案持久化 |
| E2E-05 | 空库/空结果兜底 | 空库打开 → 打开导入页 → 清空搜索框 → 网格空状态 | 无 JS 错误、空态文案友好 |

### D.2 命令层抽样测试清单（G2 具化，方案 B：逻辑下沉 services 后直测 services）

| 命令（commands/*.rs） | 高危契约 | 建议测试位置 |
|---|---|---|
| `delete_assets`（assets_cmd） | 四阶段异步、锁外 IO、部分失败不从库删（B02/B03）、缩略图清理 | services 层（已有 `delete_cleans_thumbnails`）补「混合存在/缺失 + 磁盘失败」变体 |
| `reveal_in_folder` / `get_preview`（assets_cmd/thumbnail_cmd） | 路径校验：非库内路径拒绝（B24：`normalize_path` + `find_by_path`） | 抽取 `validate_library_path` 纯函数直测（SP-SEC-06 落点） |
| `ai_cancel_batch`（ai_cmd） | 取消时锁状态、未完成条目保 pending、锁中毒 Err 不 panic（B11） | ai_cmd 锁逻辑下沉 `services/ai_cloud.rs` 后复用 wiremock 集成 |
| `cancel_export`（export_cmd） | move 半途取消的库记录一致性（EXP-009） | `export_local` 补取消注入变体 |
| `clear_thumbnail_cache`（thumbnail_cmd） | 删文件 + DB 回写 NULL 原子性（B27） | 已有 `b27_clear_all_thumbnail_paths_writes_null`，补「缓存文件已缺失」变体 |
| `import_paths`（import_cmd） | 清单确认≠入库；取消残留 | 已有 `b01_import_cancel_zero_imported` + IMP-010 中途取消变体 |

### D.3 缺陷跟踪表模板（§3.1.1「修复跟踪」具化为固定登记格式）

```
| 缺陷ID | 模块 | 级别 | 一句话 | 复现路径 | 期望 | 实际 | 关联用例 | 状态(Open/Fixed/Verified/Closed) | 修复版本 | 验证日期 |
```

登记规则：Open 时挂失败用例名 + 提交/分支；Fixed 后由回归用例转绿判定 Verified；红线（P0/P1）不 Closure 必须附风险评估。

### D.4 CI 载体骨架（G10 具化，GitHub Actions 本地等效脚本）

```yaml
# .github/workflows/smoke.yml — P0 冒烟集（目标 ≤15 分钟）
jobs:
  smoke:
    runs-on: windows-latest
    steps:
      - uses: actions/checkout@v4
      - uses: dtolnay/rust-toolchain@stable
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: cargo test --manifest-path src-tauri/Cargo.toml
        # Note: 若 shell 为 pwsh，用 `exit $LASTEXITCODE` 防 C-F4 误报
      - run: npm ci
      - run: npm run typecheck
      - run: npm run build
```

### D.5 fixtures 组织（G9 具化，5.1/5.3 落地示例）

```
src-tauri/tests/fixtures/
├── README.md            # 样本登记：机型/用途/来源/哈希（每个样本一行）
├── generated/           # 可脚本再生的合成样本（18 基础格式 + 4 损坏件 + 特殊文件名集）
├── samples/             # 真实样本（gitignore；老板素材/公开样张，体积大）
│   ├── camera-jpg/  raw/  heic/  video/
└── gen_bulk_assets.rs   # 3 万/10 万条直插生成（§5.3）
```

测试定位规则：`env::var("BAGERTEA_FIXTURES")` 指到 `fixtures/`；**未设置时真实样本用例 `#[ignore]` 或 skip**，保持 `cargo test` 开箱即绿（与 perf_probe 语义一致）。

---

*文档完。本策略为「仅测试」工作流产物，所有修复建议仅供工程师参考，QA 不修改任何源码。*

