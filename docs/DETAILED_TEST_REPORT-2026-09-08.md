# 茶包素材 BagerTea AiMedias 详尽测试报告

| 项目 | 内容 |
|---|---|
| 执行日期 | 2026-09-08 |
| 测试依据 | `docs/DETAILED_TEST_GUIDE.md` v1.1 |
| 测试版本 | BagerTea AiMedias v1.0.1，当前工作区 |
| 执行环境 | Windows，Node v24.19.0，npm 11.17.0，Rust/Cargo 1.97.1 |
| 测试方式 | 自动化测试、构建门禁、静态审查、Tauri 原生窗口真机冒烟 |
| 报告结论 | **B：修复后可发布，当前不建议放行** |

## 1. 执行摘要

本轮完成了 Rust 后端全量自动化、前端 Vitest、TypeScript 类型检查、生产构建、Tauri 原生窗口启动和部分关键用户路径走查。Rust 后端 633 个测试全部通过；类型检查和构建通过；原生应用可以启动并渲染已有 118 项素材，入库页、设置页、标签配置页、打标页和查看器均可进入或验证。

当前不满足发布条件：前端 Vitest 有 5 个失败用例，全部集中在超级搜索 `QueryBuilder` 的高级设置、优先条件权重和诊断提示；Rust `cargo clippy -- -D warnings` 与 `cargo fmt --check` 未通过；真实标准素材包、完整导入/导出/删除/备份恢复、超级搜索 UI 全矩阵和长时间性能 soak 未完成。因此本轮评级为 **B**，建议先修复 P1 项并完成依赖真实素材的手工回归后再放行。

## 2. 自动化结果

| 检查项 | 结果 | 证据/说明 |
|---|---:|---|
| Rust 单元测试 | 367 passed | 0 failed |
| Rust DB 集成测试 | 67 passed | 0 failed |
| Rust foundation acceptance | 79 passed | 0 failed |
| Rust AI service integration | 11 passed | 0 failed |
| Rust Ollama integration | 12 passed | 0 failed |
| Rust format matrix | 8 passed | 0 failed |
| Rust QA edge tests | 54 passed，1 ignored | 0 failed |
| Rust services integration | 10 passed | 0 failed |
| Rust numeric facet tests | 14 passed | 0 failed |
| Rust W7 facet tests | 8 passed | 0 failed |
| Rust perf probe | 3 passed，6 ignored | 真实性能探针按指南忽略 |
| Rust maintenance | 1 ignored | 手动维护操作 |
| Rust 汇总 | **633 passed，0 failed，8 ignored** | `cargo test --manifest-path src-tauri/Cargo.toml --no-fail-fast` |
| 前端 Vitest | **610 passed，5 failed，2 skipped** | 71 个测试文件，退出码 1 |
| TypeScript 类型检查 | 通过 | `npm run typecheck` |
| 生产构建 | 通过 | `npm run build`，1948 modules transformed |
| Tauri 开发启动 | 通过 | 原生窗口成功打开并渲染 |

构建有一个非阻塞提示：生产 JS chunk 压缩后约 655 kB，超过 Vite 默认 500 kB 建议阈值，建议后续做代码分割，但不作为本轮发布阻塞项。

## 3. 前端失败用例

| 缺陷编号 | 用例 | 实际结果 | 严重度 | 状态 |
|---|---|---|---|---|
| SS-01 | `queryBuilder_should_section_renders` | 找不到“加分权重”控件 | P1 | Open |
| SS-02 | `queryBuilder_min_should_match_dropdown` | 找不到“高级设置”按钮，无法展开“至少满足” | P1 | Open |
| SS-03 | `queryBuilder_weight_three_tiers` | 找不到“加分权重”控件 | P1 | Open |
| SS-04 | `queryBuilder_diagnostics_marks_zeroing_leaf` | 未渲染“这个条件把结果砍到 0”诊断提示 | P1 | Open |
| SS-05 | `queryBuilder_exclusion_zone_diag` | 排除区未渲染归零诊断提示 | P1 | Open |

关联文件：`src/components/supersearch/QueryBuilder.tsx`、`src/components/supersearch/QueryBuilder.test.tsx`。这些用例属于当前超级搜索改造的验收断言，不能通过删除或放宽断言来关闭；应先明确产品契约，再使实现与测试一致，并回归超级搜索相邻用例及联动矩阵。

## 4. 真机走查结果

| 模块/用例范围 | 结果 | 说明 |
|---|---|---|
| 启动冒烟 | 通过 | Tauri 原生窗口正常启动，无白屏；主库显示 118 项素材 |
| 素材库基础浏览 | 通过 | 缩略图网格、筛选侧栏、标签计数、收藏状态和底部导航可见 |
| 设置页入口和子页 | 通过 | 入库与总库、AI 设置、标签与分类可打开；分面完整性状态可见 |
| 入库页空态 | 通过 | 显示 0 项清单、递归导入说明、选择文件/文件夹入口、改名模板入口 |
| 打标页 | 通过 | AI/手动模式、本地模型、模型列表、历史批次和撤销入口可见 |
| 查看器 F-01/F-02 级路径 | 通过 | 双击进入查看器，属性/EXIF、标签栏、胶片带和 1/118 计数可见；右箭头切换成功 |
| 导入完整链路 A-02~A-14 | 未完成 | 未执行真实拖拽、取消、中断恢复和大批量导入 |
| 超级搜索 C-01~C-22 | 未完成 | 当前构建未在底部/主库状态暴露可直接点击的超级搜索入口；自动化测试已覆盖部分逻辑，但 UI 全矩阵未执行 |
| 删除/回收站 H 组 | 未执行 | 为避免修改用户已有测试库，未执行删除和清空类操作 |
| 导出 G 组 | 未执行 | 未准备独立导出目标目录 |
| 备份恢复 I-03~I-06 | 未执行 | 涉及覆盖现有库，需独立基线库和可恢复备份 |
| J 组新功能 | 部分 | 页面和已有数据可见；真实 dHash 误报、同源组及数值排序未完整走查 |
| L 联动矩阵、SBTM 章程 | 未完成 | 依赖完整人工素材包和独立测试库 |

真机走查期间未执行物理删除、标签合并、批次撤销、备份恢复或文件移动，未改变用户已有库的业务数据。

## 5. 代码健康度（模块 K）

| 检查项 | 结果 | 结论 |
|---|---|---|
| K-0a clippy | 失败 | `-D warnings` 报 54 个错误，包含 doc comment、dead code、too many arguments、map_or、类型复杂度等 |
| K-0b rustfmt | 失败 | `cargo fmt --check` 检出多个文件差异，包含当前工作区新增 `src-tauri/examples/ss_batch.rs` |
| K-0c 前端 ESLint | 未配置 | 当前 package 没有 ESLint 门禁 |
| K-01 commands 薄壳 | 未通过/需治理 | 命令层存在直接 SQL 命中，典型位置为 `settings_cmd.rs`、`tags_cmd.rs`、`ai_connections_cmd.rs` 等 |
| K-02 service 不拼 SQL | 基本通过 | 未发现以 `format!` 拼接 SELECT/INSERT/UPDATE/DELETE 的服务 SQL；命中的 Ollama URL delete 不是 SQL |
| K-03 唯一图像解码引擎 | 不通过字面规则 | `heic_decode`、`raw_decode`、`media_refill`、`thumbnail` 等模块直接引用 `image`/HEIF，这是当前架构的多格式解码路径，规则脚本会产生结构性命中，需人工豁免或更新规则 |
| K-04 不裸 unwrap | 未通过 | `src-tauri/src` 当前字面计数 795，包含大量测试代码；需拆分生产代码与测试代码基线，不宜直接用总数判定恶化 |
| K-05 锁内禁耗时 | 暂未发现 P0 | 抽查 importer/media_refill/export 等服务，主要是短锁读写，图像解码、ffprobe 和文件 IO 位于锁外；需继续完成逐点人工清单 |
| K-06 迁移纪律 | 暂未发现异常 | Git 历史显示迁移按 V1 至 V24/V24a/V24b 递进，未发现本轮回改已发布迁移的证据 |
| K-07 配置双源 | 风险存在 | 源码同时存在 settings/profile 与 connection/binding 路径，行为测试需继续确认读取源唯一性 |
| K-08 前端分层 | 观察项 | `src/pages` 未发现直接 `invoke`；`QueryBuilder.tsx` 1805 行、`SettingsPage.tsx` 1680 行，组件职责过重 |

### K-0 基线补充

静态结果不是功能测试失败，但说明当前分支尚未满足“代码健康度不恶化”的门禁。建议先保存本报告数值作为基线，随后分批修复 clippy/fmt，补充 ESLint，并将 K-01/K-03/K-04 改成可解释、可排除测试代码和合法适配层的规则。

## 6. 三类核心问题结论

**A 类：界面冗余与一致性。** 本轮原生窗口可见页面未发现白屏或明显重叠；设置、入库、打标和查看器均有明确入口。由于未完成 1366×768、1920×1080、150% DPI 和全屏逐屏走查，A 类不能判定全绿。超级搜索条件卡的高级设置/权重控件失败仍是 UI 契约风险。

**B 类：逻辑冲突。** Rust 数据库、搜索计划、标签分面、AI 状态机和导出/导入服务自动化测试全部通过，未发现数据层断言失败。超级搜索优先区和排除区诊断映射的 4 个失败用例说明前端计划展示与测试契约存在不一致，需在发布前修复。

**C 类：看似可行但实际不可用。** 生产构建、原生启动和已有库浏览可用；但真实导入失败明细、断点取消、备份原子恢复、真实 AI 断连降级、万级库 soak 尚未执行，不能排除 C 类问题。浏览器直开 Vite 页面出现 Tauri `invoke` 不可用属于非原生运行方式，不作为桌面应用缺陷。

## 7. 已知问题与遗留风险

| 风险 | 本轮状态 | 影响 |
|---|---|---|
| S1 日志丢失 | 部分验证 | 日志文件已落盘并记录启动/维护任务；崩溃后完整性未验证 |
| S2 V1 迁移幂等 | 自动化部分通过 | 多个 migration idempotent 用例通过；旧真实库升级复演未执行 |
| S3 批次熔断 | 未完成 UI 复演 | 服务层状态机有自动化覆盖；真实 UI/断连过程未复演 |
| S4 配置双源 | 待专项 | 连接档案与旧 profile 路径并存，需要行为级核对 |
| S5~S10 稳定性 | 未核全 | 并发、崩溃恢复、安全隐私专项未完成 |
| P1~P10 本地模型提示词 | 部分 | 已有 Ollama 服务层测试和历史批次；本轮未重新配置断连/慢响应场景 |
| 真实格式包 | 阻塞 | 当前 fixtures 仅有 `camera_sample.jpg`，缺少指南要求的 S1~S5 完整素材包 |
| 过夜/万级 soak | 未执行 | 需要独立压力库和过夜运行窗口 |
| 前端 chunk 较大 | 观察项 | 影响首屏加载和后续维护，不阻塞本轮构建 |

## 8. 上线建议

**当前不放行。** 发布前必须完成以下条件：

1. 修复或明确 SS-01~SS-05 的超级搜索契约，使 `QueryBuilder` 相关测试全绿。
2. 重新执行前端 Vitest、`npm run typecheck`、`npm run build`，并重新执行 Rust `cargo test`。
3. 处理 `cargo fmt --check` 和 clippy 基线，至少保证本轮新增/修改代码不新增告警；明确 K-01/K-03/K-04 的合法例外。
4. 准备独立测试库和 S1~S5 标准素材，完成 A、G、H、I、J、L 关键路径及 SBTM 章程。
5. 完成超级搜索 UI 全矩阵、备份恢复原子性、删除失败不假成功、导出 move 一致性和中断恢复专项。

在上述项目完成前，当前最合理的质量结论是“修复后可发布”，而不是“可直接发布”。

## 附录：执行命令

```text
cargo test --manifest-path src-tauri/Cargo.toml --no-fail-fast
npm run test:unit
npm run typecheck
npm run build
cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
npm run tauri dev
```

