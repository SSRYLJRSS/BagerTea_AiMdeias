# 项目计划

> 更新日期：2026-09-24
>
> 本文档记录当前阶段、交付状态和下一阶段范围。产品行为见 [PRD.md](PRD.md)，技术结构见 [ARCHITECTURE.md](ARCHITECTURE.md)。

## 1. 项目目标

构建一个能在数万级本地素材上长期使用、维护成本可控的个人素材管理系统：

- 入库可托管、可追踪、可取消。
- 浏览和搜索在大数据量下仍稳定、可解释。
- 标签和 AI 打标形成可治理、可撤销的闭环。
- 删除、移动、导出和备份不产生静默数据风险。
- 代码结构和文档上下文足够稳定，便于持续迭代和 AI 协作。

## 2. 当前交付状态

### 2.1 已完成的功能基线

下表的“已完成”仅指已有实现，不代表当前集成代码已通过最终门禁、已合并或可发布。当前阶段冻结产品功能，执行范围见第 4 节。

| 领域 | 状态 |
|---|---|
| 核心桌面壳、数据库迁移、日志、主题、错误隔离 | 已完成 |
| 两段式入库、总库/分库托管、改名、任务反馈 | 已完成 |
| 虚拟网格、批量选择、排序筛选、分面标签、查看器 | 已完成 |
| 双层缩略图、全局 imaging、多格式与 RAW/HEIC 解码 | 已完成，真实样本仍需持续验证 |
| 普通中文搜索、超级搜索 SearchPlanV3、AI 搜索 | 已完成 |
| 标签分面 V2、治理、别名、合并、撤销、数值分面 | 已完成 |
| 云端 AI、手动打标、Ollama 本地模型和视频抽帧 | 已完成 |
| 回收站、双策略删除、哈希去重、感知去重、同源组 | 已完成 |
| 本地导出、CSV、数据库备份恢复、运行日志 | 已完成 |

### 2.2 当前发布阻塞

以下项目完成前，不能把当前版本标记为“可放行”：

1. **真实素材 UAT**：超级搜索 relevance 排序、mustNot 排除、should 全不命中仍保留、位置权重和 hydrate 后 plan JSON 需要真实数据证据。
2. **核心用户旅程**：使用真实素材走通导入、浏览、AI 打标、搜索、查看器、评级、导出、删除恢复和备份恢复。
3. **格式与性能**：在目标机器上复测 RAW/HEIC、视频播放、3 万级搜索和网格滚动。
4. **工作区交付边界**：所有应发布改动必须完成审查、测试并形成可回退提交。
5. **发布门禁**：`scripts/smoke.ps1`、严格 Rust 门禁、前端门禁和人工 UAT 必须全部有结果记录。
6. **三端远端门禁**：产品代码提交 `b9ac04ff2b07414c7c963440a51aff6b694eb165` 的 code-gate 首次运行由 Linux x64、macOS Apple Silicon、Windows x64 和前端 job 全部通过（[workflow run 35965863783](https://github.com/SSRYLJRSS/BagerTea_AiMdeias/actions/runs/35965863783)）。其后的仅文档提交 `ca3bd72386f4ad7bbf457210d5f5478720497e48` 在 workflow run `35969019646` 首次尝试的 frontend 单测有一项失败，失败 job 单独复跑后该 run 最终 success；该一次性失败尚未定位根因，不能隐去或视为已修复。但 `main` 当前没有有效分支保护/规则集：branch protection API 返回 `Branch not protected`，仓库 rulesets 与 main 的有效规则均为空；Required checks 尚未被设置为合并硬门禁。
7. **macOS/Linux 真机验收**：当前没有这两类目标设备的验收证据；自动构建成功也不能标记为支持。
8. **媒体依赖合规**：FFmpeg/HEIF/RAW 相关二进制的来源、对应源码/再分发材料和最终许可义务尚未完成独立复核；HEIF 的三目标归档、解压后静态库 SHA256、源码提交和 LGPL/GPL 许可证摘要已固定并随候选附带，但这不替代法律审查，许可证文本本身不足以解除分发阻塞。

当前项目计划不把“自动化全绿”等同于“产品可发布”。真实素材验收仍是独立门禁。

### 2.3 三端统一开发收口状态

| 范围 | 当前状态 | 完成证据/剩余动作 |
|---|---|---|
| 平台契约、AI 协作入口、路径与能力边界 | 已提交并推送到 `codex/platform-integration` | 当前集成提交已完成代码级审查与三端 code-gate；尚未合并，且 Required checks 未设置 |
| Windows/macOS/Linux 平台能力、UTF-8 路径告警、视频代理变体 | 工作分支已有实现与回归测试 | 最新提交在三端 clippy、全量 Rust 测试及原生 Tauri 构建通过；目标设备人工验收仍未完成 |
| Rust 1.98.1、统一桌面构建入口、SHA256 sidecar/HEIF manifest | 工作分支已配置 | 三端 HEIF 资源准备及原生应用构建通过；Windows strict media check 通过。MSI/NSIS 曾从旧的未提交源码树生成，不是当前候选包；本轮未安装/UAT |
| 三目标 code-gate 与手动候选包 workflow | code-gate 已由工作分支 push 触发 | 当前提交三端 code-gate 全绿；GitHub `main` 无有效保护规则，因此 CI 现在还不是合并阻断门禁。候选包 workflow 未运行 |
| 三端版本/提交/安装包摘要一致性校验 | manifest 包含 runner OS/架构、逐包大小/SHA256、必需包类型、HEIF 来源/许可证材料及逐目标构建日志 SHA256；本地合成三端产物的聚合校验测试通过，真实三端候选尚未生成 | 需在同一提交的三端 runner 生成并验证真实产物 |
| 固定五步人工验收 | 操作脚本已纳入 QA 手册 | 仍需 Windows、Apple Silicon、Ubuntu 目标设备逐一执行 |
| 候选包交付给熟人测试 | 暂不允许 | 完成媒体许可复核，且目标平台核心五步通过后再发知情测试者 |

当前集成改动已整理为可回退提交并推送到 `origin/codex/platform-integration`；最新 HEAD 为文档提交 `ca3bd72386f4ad7bbf457210d5f5478720497e48`，其产品代码与已通过三端 CI 的 `b9ac04f` 相同。远端 `main` 仍为 `683628ae25feb610fdd84aeb37b036e18187a5fe`，本轮没有创建 PR 或合并。之前在独立临时目录生成的 Windows MSI/NSIS 来自未提交工作树，未安装或分发，不能作为当前提交的候选包。

### 2.4 当前审计结论与证据边界

- 2026-09-24 P0 审计起点只读核对：当时集成 HEAD、本地 `main` 与 `ls-remote` 返回的远端 `main` 都为 `683628ae25feb610fdd84aeb37b036e18187a5fe`。本地 `origin/main` 缓存较旧，不能用其 ahead 数量推断实时远端进度。
- P0 审计起点工作区有 193 条 porcelain 状态记录（不是 193 个源码文件）：72 项暂存、120 项未暂存，其中 25 项同时有两类状态；另有 26 个未跟踪文件。36 项 `heif-bin/` 暂存删除对应的本地原文件仍在磁盘（被忽略，不在 Git 索引中），本轮没有删除或覆盖它们。此为提交前状态，不代表当前工作区。
- 按 Git clean/filter 后的 blob 对照固定快照：167 个 tracked 变化路径中，61 个与 Windows 快照内容相同、7 个与平台快照内容相同、99 个不同于两个快照；26 个未跟踪文件中，4 个与 Windows 快照相同、6 个是对快照既有路径的集成修改、16 个是新建的文档/构建门禁/候选校验/回归测试文件。这里的“相同”只说明来源，不代表语义已通过审查；`.cargo` 旧配置删除包含在 tracked 变化路径统计中。不同 Git 状态维度不可相加成文件数。
- **P0 逐路径来源对账于 2026-09-24 完成。** 路径分组结论：快照相同项是既有行为保留；集成差异归为统一平台能力/路径/原生依赖与三端门禁、既有连接/恢复/媒体/SearchPlan 缺陷修复、契约与权威文档同步及其回归测试。逐项检查未发现新增用户入口、AI 能力、搜索语法、数据含义或其他产品功能；SearchIntent V3、AI 图像输入规范化，以及导入阶段“不支持缩略图则拦截、有限预览则提示”的状态与 UI 均可在 Windows 恢复快照中核实，当前 PRD R-02/R-07 是对齐该既有行为而非新增产品能力。高风险核验覆盖 AI 限流、搜索/分面、恢复、凭据、视频缓存、HEIF/媒体构建脚本；无未决产品选择。具体快照哈希和本轮路径/行为分类在任务输出中，不另建第二份长期账本。
- Windows 恢复快照 `4c2e140` 已含 AI 连接限流字段、V25、帮助页入口和搜索协议调整；当前 `ai_rate_limit.rs` 的 Git blob 与该快照完全相同，两份搜索协议文档也无差异。这些不能仅因未进入 main 就判为本轮新增功能，更不能擅自删除。
- 当前能力层、非 Windows 托管 Ollama 禁用、发布 sidecar 校验、路径处理及视频代理兼容属于既定平台治理方向。恢复安全和凭据补偿属于已有功能可靠性修复；新文件或追加迁移本身不等于新增产品功能，但必须保留缺陷与测试依据。
- 先前执行记录中前端 702 项通过、2 项跳过，tooling 15 项通过；完整 Rust 曾通过 788 项、忽略 8 项，Windows smoke 和构建也曾通过。这些均为历史结果，不是当前最终门禁。
- P1 阶段历史记录：恢复已发布 V15 原逻辑后的历史完整 Rust 测试曾出现 `ai_adversarial_sim::http_429_stops_batch_and_preserves_pending` 期望 `pending`、实际 `rejected`。2026-09-24 该单项通过，默认并行 adversarial 目标连续 3 次各 14/14 通过，之后完整 `cargo test --all-features` 退出码 0：708 passed、7 ignored（485 lib、14 adversarial、13 AI、78 DB、12 Ollama、3 perf、54 QA、15 search、10 services、16 V24、8 W7）。失败的历史根因仍未知，不能说已修复；P1 当时未发现可稳定复现的 429 缺陷。该阶段 fmt/clippy、完整 smoke、前端全门禁和最新安装包尚未验证；之后的 P4/最终记录见本节后文。
- 以上 P0 结论不等于逐行证明所有代码无缺陷，也不替代三端 runner、真机 UAT、许可复核或完整合并审查；它关闭的是范围与来源冻结出口，未发现需要用户裁决的产品选择。
- 2026-09-24 P4 最终源码复验（包含平台 DTO 注释校正）：tooling 15/15、typecheck、Rust fmt、clippy、build、strict media check 均退出码 0；前端 80/80 文件、702 passed、2 skipped；Rust all-features 为 788 passed、8 ignored。Smoke 命令最终退出码 0，但 AI 集成组首轮 `empty_tags_marks_rejected_and_batch_continues` 曾失败，报第二项建议因 `打标 V2 缺少 description` 被拒；脚本既有重试整组 13/13，通过后独立串行重跑及之后连续 3 次串行重跑均 13/13。根因未定位，保留首轮失败事实，不据重试覆盖；后续未稳定复现，也未改业务逻辑。此前 ViewerPage 异步断言调整仅等待实际卸载，没有改变查看器行为。
- lint 退出码 0，有 5 条警告：`PendingList.tsx` 的 `hover` effect 依赖、`AssetInfoPanel.tsx` 的 `asset` effect 依赖、`Thumbnail.tsx` 清理函数读取 `gen.current`、`QueryBuilder.test.tsx` 的显式 `any`、`AiTaggingPage.tsx` 的 `currentSuggestion` effect 依赖。逐个核对警告行与相对 main 的 diff：警告行均未被本批改动触及；`PendingList` 与搜索测试文件其他位置虽有改动，但不包含对应警告行。依 P3 单批边界暂不扩成 lint 清债批：测试 `any` 归入类型规范债务；其余 effect/ref 告警须在独立批次证明不重置用户编辑状态、不放过过期请求后再处理。Vite 构建成功，当前主 JS chunk 664.48 kB，高于 500 kB 提示值；本阶段未做全局拆包。
- P0 后的测试保护补充只增加 `ServiceManagement.test.tsx` 用例，确认选择本机模型不会覆盖仍有效的打标服务绑定；前端定向测试 5/5、`npm run typecheck`、`npm run lint` 和 `npm run test:unit` 均在该改动后退出码 0，unit 为 703 passed/2 skipped。lint 仍有上述 5 条警告。Rust/原生代码未变，Rust、smoke、build 和安装包命令没有因该测试文件改动而重跑；其结果仍按前述历史证据标注。
- 最终源码 Windows x64 release bundle 在新建独立临时目录 `bagertea-platform-final-9c407c2f8a4741198f4a6bdc96c0ce48` 构建成功：MSI 110,690,304 bytes，SHA256 `211EBAC2298F2A3C16C46437F4C7BE360679BC3103A1311D1E1E6E9A3E164E37`；NSIS 81,124,045 bytes，SHA256 `D48412097CF4E811DBFABE01705483701F7CA3733CD4E982608CC6A40607FA4E`。未安装或分发。包在未提交工作树上生成，**不是候选包**。
- P0 审计记录的主线/脏工作区状态是当时状态。此后按用户授权将集成改动提交并推送到工作分支；最新状态见下方 2026-09-24 收口记录。macOS/Linux runner 已通过代码级 CI，但真机 UAT、Required checks 阻断和许可复核仍未证明。
- **2026-09-24 当前源码本机收口（HEAD `b9ac04ff2b07414c7c963440a51aff6b694eb165`）：** `npm run test:tooling` 15/15、`npm run typecheck`、`npm run lint`（0 errors，5 条既有警告）、`npm run test:unit` 705 passed/2 skipped、`npm run build`、`cargo fmt --check`、严格 all-targets/all-features `cargo clippy -D warnings`、`cargo test --all-features`（788 passed/8 ignored）、完整 `pwsh ./scripts/smoke.ps1`、`npm run desktop:check:strict -- --target x86_64-pc-windows-msvc` 均退出码 0。Vite 仍提示 JS 主 chunk 664.48 kB 超过 500 kB 建议值；这不是构建失败，本轮未扩大为全局拆包。此前一次 smoke 运行中的 AI 本地 mock TCP 测试失败且整组重试未恢复；后续增加服务器 IO 失败计数诊断/准确分类后，当前源码完整 smoke 全部通过。该历史失败保留，不宣称网络 mock 已无任何瞬态风险。
- **2026-09-24 当前源码三端 CI：** [code-gate run 35965863783](https://github.com/SSRYLJRSS/BagerTea_AiMdeias/actions/runs/35965863783)，HEAD `b9ac04ff2b07414c7c963440a51aff6b694eb165`，frontend、Linux x64、macOS Apple Silicon、Windows x64 jobs 全部 success；三端均完成 strict clippy、全量 Rust 测试、原生 Tauri release binary build 与桌面目标/版本检查。较早的两次 push workflow 曾按门禁失败：先后暴露 rfd Linux 互斥后端、Unix 条件导入、macOS 不支持创建非法 UTF-8 文件名的三项文件系统测试。对应提交只修正依赖 feature、平台 cfg/lint 与测试适用平台；没有改产品功能。最新 run 对三端均全绿。
- **2026-09-24 文档提交后的 CI 复验：** HEAD `ca3bd72386f4ad7bbf457210d5f5478720497e48` 仅变更 `docs/PROJECT_PLAN.md`。 [workflow run 35969019646](https://github.com/SSRYLJRSS/BagerTea_AiMdeias/actions/runs/35969019646) 第一次尝试中，三个平台的 Rust/clippy/native-build/target-check jobs 全部通过；frontend 在 `SettingsPage.test.tsx:478` 的“初始未修改不显示脏状态”断言失败，前端 build 随之跳过。本机该测试文件 37 passed/2 skipped，完整前端单测 705 passed/2 skipped；仅复跑失败的 frontend job 后 run attempt 2 全部 success。未改应用代码，也未定位该单测一次性失败的根因；因此把它记录为未解释的不稳定信号，而非业务缺陷已修复或 CI 从未失败。
- **合并保护状态只读检查：** `GET /branches/main/protection` 返回 `Branch not protected`；仓库 rulesets 列表和 `GET /rules/branches/main` 均为空。因此当前 CI 结果真实，但 GitHub 尚未把这些 job 设为 main 的 required checks。没有修改保护规则，也没有创建 PR 或合并。
- **仍未完成：** 安装包候选（本轮只构建三端 release executable，未运行手动候选包 workflow）、Windows 安装与五步 UAT、macOS/Linux 真机五步 UAT、三端安装包 manifest/摘要一致性实产验证、媒体依赖再分发许可复核。CI 绿不等于发布或平台支持等级已升级。

## 3. 里程碑

### M1 基础闭环

状态：已完成。

范围：

- 入库、素材库、查看器、标签、搜索、AI 打标、导出、删除、设置。
- 数据库迁移、日志、错误处理和基础自动化测试。

### M2 检索与标签成熟

状态：已完成，等待发布级 UAT。

范围：

- FTS5 中文搜索强化。
- 超级搜索条件树、AI 意图解析、诊断和筛选持久化。
- 分面 V2、标签治理、数值分面和打标撤销。

### M3 媒体与工作流增强

状态：已完成，等待真实媒体验证。

范围：

- RAW/HEIC/TIFF 等格式链路。
- 视频播放代理、悬浮预览、视频 AI 抽帧。
- 感知去重、同源文件组、颜色属性、评级和查看器。

### M4 本地 AI 与数据安全

状态：已完成，等待目标机器验证。

范围：

- Ollama 检测、安装、启动、模型推荐、拉取和配置。
- 数据库备份恢复、运行日志、缓存和本地模型占用管理。

### M5 1.0 发布收口

状态：进行中。

出口条件：

- 真实素材 UAT 完成。
- P0/P1 缺陷清零。
- 性能、格式、视频和备份恢复复测通过。
- 文档、版本号、安装包和恢复流程一致。

### M6 三端统一候选

状态：实施中，尚未完成平台验收。

范围：

- 只以 `main` 为长期主线，用 Rust 平台能力、target 依赖和跨端测试管理差异。
- Windows 10/11 x64 为首发完整功能目标；Apple Silicon macOS 与 Ubuntu 24.04 x64 为知情测试预览目标，须先在目标设备完成核心五步闭环。
- 同一候选版本的各平台包必须来自同一 Git 提交；安装包可分日生成，但不得混用版本和提交。
- App 管理的 Ollama 只在 Windows；macOS/Linux 保留外部兼容 AI 连接，不提供托管安装/启动入口。
- 第一阶段不承诺跨系统搬迁素材库。

该里程碑的 workflow 文件和本地实现不等于远端门禁已启用；当前提交的首次三端 runner 已全绿，但 GitHub Required checks 未配置，媒体依赖再分发复核和真实真机 UAT 也未完成。

## 4. 下一阶段：现有功能冻结与质量收口

### 4.1 本阶段授权和边界

用户当前要求：**不新增功能，只优化、规范已有代码，修复适配与可靠性问题，达到单 main、三端门禁约束下可审查合并的状态。** 用户已明确授权将当前集成改动整理为可回退提交、推送工作分支并运行三端 CI；该授权已用于 `codex/platform-integration`，不包含创建 PR、合并 `main`、改 branch protection、安装/分发或发布。文档中的其他未来方向不是开发授权。

产品基线是 `main` 已有行为加 Windows 恢复快照中既有行为，不是把所有平台分支或旧计划内容无条件搬入。平台差异按 [PLATFORM.md](PLATFORM.md) 收敛；相对 Windows 的行为改变必须能对应既定能力限制或可复现缺陷。

允许：修复现有行为、补回归测试、必要的局部解耦、移出锁内阻塞工作、统一已有平台边界、修正文档与构建门禁。默认保持现有页面、设置项、搜索语义和数据含义。优化需有实际问题和前后证据。

本阶段不开发新入口、新 AI 能力、新搜索语法、网盘、音频、语义搜索、同步、跨系统搬库或批量治理工具；也不进行全仓重构、无关依赖升级或设计系统重做。大组件拆分只在阻碍本次缺陷修复且能证明行为不变时局部实施。自动化先保留固定五步人工脚本；桌面 E2E 框架建设不作为本次收口前置。

### 4.2 每批共同约束

1. 先读取 AGENTS 与相关权威文档，并核对工作树、分支、HEAD、暂存/未暂存/未跟踪项。只在集成工作树施工，两个恢复快照仅作证据。
2. 开工列出一个具体问题、预期行为、文件白名单、三端影响、回归测试和不改项。新增文件或迁移须说明其如何服务现有行为，而非扩展产品。
3. 一次只处理一批；如果发现另一问题，记录后排队，不顺手修复。需要改变产品含义时暂停并请求决策。
4. 保留用户所有既有改动和暂存区；不用 reset/checkout/clean。未经明确任务级授权，不 stage/commit/push；本轮的授权只适用于当前集成分支提交、推送和 CI，不延伸为建 PR、改保护规则、合并或发布。恢复快照授权不延伸为这些权限。
5. 回改已发布迁移、减少测试断言、跳过失败测试、全局串行化来掩盖失败、放宽三端门禁均不属于可接受修复。
6. 每批交付：实际 diff、基线来源、验证命令及退出码、未执行项、剩余风险。失败结果不得被之后一次成功覆盖。

### 4.3 执行批次与出口

#### P0：冻结范围和逐路径对账（首先执行，只读）

输入固定为 main `683628a`、Windows 快照 `4c2e140`、平台快照 `b59188a` 及当前集成 WIP。若基线改变，先重新确认来源。

- 列出 `git diff main --name-status`、`git diff --cached --name-status`、`git diff --name-status` 和 `git ls-files --others --exclude-standard`；分别检查快照相对 main 的差异。
- 对变化路径逐项归类：已有 Windows 行为保留 / 必要平台兼容 / 已有缺陷修复 / 行为不变规范化 / 来源或用途待确认。记录对应快照、具体行为、测试和处置建议，账本放任务输出，不新增长期进度文档。
- 未跟踪文件必须直接读取或计算 blob，不能仅凭 `git diff <快照>` 的“deleted”判断文件被删除；普通 diff 不含未跟踪文件内容。
- 对 AI 限流、搜索/分面、恢复、凭据、视频缓存、构建脚本这些高风险组逐 hunk 核对；已有快照内容保留不等于宣称无缺陷。
- 对“待确认”项先隔离结论，不删除文件、不回滚用户改动。若发现无需求来源的新功能，提出最小排除方案，待明确选择后实施。

出口：当前每个变化路径有分类，高风险行为有证据；未决产品选择为零，或明确停在决策点。路径数量和旧报告结论不能代替账本。

#### P1：修复最近已知的 429 测试失败

入口：P0 已确认相关 AI 行为是既有基线。先检查 `src-tauri/tests/ai_adversarial_sim.rs`、`tests/common/`、`services/ai_cloud.rs`、`db/ai.rs`；只有证据指向共享限流或凭据时才扩大到对应服务。

- 固定失败契约：429 中断批次、保留 pending、不继续发送、不泄露 Key。
- 记录默认并行下复现、单项和串行对照，定位 mock、全局状态、记录排序、连接共享或业务错误的实际原因；这些只是调查方向，不预设根因。
- 添加能稳定击中原因的回归测试，再作最小修复。不得为通过测试把 pending 改成 rejected，也不得用生产代码重试掩盖测试隔离问题。
- 验证单项、整个 adversarial 目标及相邻 AI 集成测试；默认并行整目标至少连续三次通过作为稳定性证据，仍需 P4 完整回归。未复现时记录“未定位”，不标已修复。

2026-09-24 当前结果：429 单项通过；默认并行 adversarial 目标连续 3 次 14/14；完整 all-features Rust 套件 708 passed、7 ignored。检查的 429 分支按 `AI_RATE_LIMITED` 提前返回，在写入 `last_error` 后将批次标为 `interrupted`，没有调用拒绝建议的路径。本轮没有业务代码改动。

出口规则：若失败复现，继续定位根因并红绿修复；若单项、默认并行目标三次及完整 Rust 套件均通过且无法复现，不制造无证据的代码更改，记录历史根因未知和复验结果，P1 以“未复现、无当前修复项”暂结并继续 P2/P4；P4 任何一次复现即重开 P1。不得将“未复现”表述为“历史问题已修复”。

#### P2：复核现有平台与数据安全实现，按缺陷逐项处理

不重写已有实现，先证明是否仍有缺口：

| 检查域 | 重点落点 | 验收不变量 |
|---|---|---|
| 数据恢复 | `state.rs`、`services/backup_restore.rs`、`commands/settings_cmd.rs` | 任务进行中拒绝恢复；失败不损坏原库；保留恢复点；重开失败不假成功 |
| 凭据 | `services/credentials.rs`、`commands/ai_connections_cmd.rs` | keyring/网络不占 DB 锁；数据库或凭据失败可补偿；不可用不等于未配置 |
| 路径与导入 | `utils/path.rs`、`services/importer.rs`、前端路径显示工具 | 非 UTF-8 原文件不动且明确告警；显示字符串不回流成操作路径 |
| 视频 | `services/video.rs`、`services/video_proxy.rs`、`db/video_proxy.rs` | release 不回退 PATH；失效缓存重建；保持现有变体范围；不新增转码产品能力 |
| 平台与窗口 | `services/platform.rs`、platform store、TitleBar、Ollama 管理入口 | 非支持能力明确禁用；Windows 既有功能保持；不实现跨系统搬库 |
| 原生依赖/CI | Cargo target 表、desktop/prepare 脚本、两个 workflow | 原生目标正确；资源来源/摘要匹配；所有目标失败都阻止合并 |

V25 为 Windows 基线；V26 为现有代理缓存判新修复，复核全新库、旧库和重复迁移，不追加无必要 schema。代理指纹含有界样本，不得宣传为完整内容校验。

每发现一个实质缺陷，单独开一个小批修复和测试；若未发现缺陷只记录证据，不为“优化”制造 diff。涉及数据库、文件或凭据测试使用临时目录/测试库，不操作真实素材库。

出口：上述域没有未处理的合并阻塞；macOS/Linux 尚缺实测的项目明确保留，不能用 Windows 结果关闭。

2026-09-24 首轮复核：全量 Rust 测试中的恢复失败注入、凭据模拟、视频代理指纹和平台能力测试均通过；当时未发现可证明的 P2 行为缺陷。后续针对既有网格批量选择路径的异步时序继续复查时，发现普通素材库没有向通用网格传入筛选 revision，筛选变化清空选择后，旧的在途全选/反选请求仍可能重新写入旧 ID。该缺口已在现有 `selectionRevision` 守卫上修复并为全选、反选分别增加回归测试；这是保护既有筛选与选择语义，不增加用户能力。Windows 测试通过；Unix 非 UTF-8 路径和 macOS/Linux 原生后端仍不能由当前 Windows 主机证明，保留为三端 runner/UAT 门禁。

P3 文档收口：将 `services/platform.rs` 和 `src/types/platform.ts` 中过时的跨系统搬库注释改为“当前不承诺、字段保留且恒为 None/null”，没有启用能力、改动 DTO 或类型；P2 检查表中的 `Database` 落点更正为 `state.rs`。

#### P3：局部规范与文档收口

- 核对本批新增/修改的 SQL 是否留在 db 层、业务是否留在 services、前端是否经 api 调用；既有 commands SQL 债务按独立小批评估，不能混成全仓架构迁移。
- 处理与本批有关的 lint 警告，先核对来源；原有警告如不影响正确性单列，不能无证据宣称全部是历史问题。
- 清理误导后续 AI 的旧进度/未来功能指令。例如 `platform.rs` 的“迁移协议 M4 后开启”与本阶段不承诺搬库不符，只校正文案，不启用能力或随意删 DTO 字段。
- 文档只同步实际行为和证据；架构中的迁移说明核对 V25/V26，开发命令核对实际根级工具链配置。当前状态只维护本文。

出口：无新增行为、无无关格式化、协议字段未擅改、引用与命令有效，`git diff --check` 和暂存区检查通过。

#### P4：同一最终源码的完整本地验证

按 [DEVELOPMENT.md](DEVELOPMENT.md) 准备本机 HEIF/媒体资源，然后依次验证：

```powershell
npm run test:tooling
npm run typecheck
npm run lint
npm run test:unit
npm run build
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --all-features -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml --all-features
pwsh ./scripts/smoke.ps1
npm run desktop:check:strict -- --target x86_64-pc-windows-msvc
```

Windows 原生安装包按现有 desktop 入口生成到独立输出目录，验证 MSI/NSIS 存在且记录摘要；不覆盖用户现有包，不安装或分发。命令参数以实际脚本为准，避免为测试另造构建系统。

记录 HEAD、工作树 diff/未跟踪文件摘要、工具链、目标、命令与退出码。源码变动后相关证据失效；最终收口必须基于固定的同一源码状态。失败则回到对应问题批，不继续“带红”完成后续表格。

出口：本地可交付审查的证据齐备，但仍不等于可合并或可发布。

2026-09-24 P4 首轮最终结果：`npm run test:tooling` 15/15、`npm run typecheck`、`npm run lint`（0 errors/5 个已登记警告）、`npm run test:unit` 702 passed/2 skipped、`npm run build`、`cargo fmt --check`、按 DEVELOPMENT 设置已校验 `HEIF_BINARIES_DIR` 后的 all-targets/all-features clippy、all-features cargo test 788 passed/8 ignored、`scripts/smoke.ps1` 和 Windows strict media check 均最终退出码 0。Smoke 首轮 AI 集成目标失败后按脚本策略重试通过，之后独立串行复跑及连续 3 次串行复跑均 13/13；根因未知，详见 §2，不隐藏首轮结果。Windows x64 MSI/NSIS 在 `%TEMP%/bagertea-platform-final-9c407c2f8a4741198f4a6bdc96c0ce48/cargo-target/.../bundle` 生成并完成 SHA256 校验；它们来自未提交工作树，不得登记为共同提交候选。

后续 2026-09-24 当前工作树复验：在上述门禁之后仅增加普通素材库筛选变更时的过期全选/反选结果保护及两项回归测试。定向与完整前端测试、typecheck、lint、build 均在此代码状态通过，unit 更新为 705 passed/2 skipped；Rust fmt/clippy/all-features test（788 passed/8 ignored）、strict media check 和完整 `scripts/smoke.ps1` 也在当前代码状态通过，smoke 五阶段全部通过。最新 MSI/NSIS 在独立临时 Cargo target 下生成并完成摘要复核：MSI 110,690,304 bytes，SHA256 `2F140DD7C9CDC398C52BC45F2C9D615140E67CB8E5C2DD5C460433172E56BC77`；NSIS 81,134,237 bytes，SHA256 `50633B836BE7EBA69AAE6DCF91F4494B79E57F2EA225B5FF06AB3A468EB40AB3`。输出位于 `%TEMP%/bagertea-platform-current-2b265ccfce774514983af1aa6c8061a3/cargo-target/.../bundle`，未安装或分发，仍来自未提交工作树，**不是候选包**。工作区增加的两个未暂存文件状态使当前 porcelain 记录从 P0 审计时 193 条变为 195 条；P0 来源分类仍是固定审计时点的结论，不把这两项本任务回归测试改动伪装成基线内容。
- 当前工作树 workflow 复核：本机没有 `actionlint`；用 PyYAML BaseLoader 对 3 个 workflow 文件做 YAML 解析，并断言 code-gate 的 `frontend`/`rust` job 与候选 workflow 的 `bundle -> verify` 依赖存在，检查通过。该静态解析不是 GitHub Actions schema 校验，也不替代 Required checks 实际阻断验证；远端 runner 结果另见本节当前源码记录。

2026-09-24 提交/推送后的最终源码状态：集成基线及三项平台 CI/测试修正提交至 `codex/platform-integration`（代码 HEAD `b9ac04f`；之后 `ca3bd72` 仅更新计划文档），本地工作树干净；P4 所列全部本机门禁退出码为 0。GitHub run `35965863783` 对代码 HEAD `b9ac04f` 的 frontend、Linux x64、macOS Apple Silicon、Windows x64 jobs 首次运行全部成功；文档提交后的 run `35969019646` 首次 frontend 单测失败，复跑失败 job 后 attempt 2 全绿。先前平台兼容失败均已定位并以最小依赖/条件编译/测试平台修正；`SettingsPage` 这项间歇失败根因未定位且未改代码。所有失败与复跑事实见 §2.4，不把复跑绿灯反写成从未失败。GitHub 当前没有对 `main` 生效的保护规则/Required checks；这一项、真机验收、候选安装包与再分发许可仍未完成。

剩余：GitHub Required checks 尚未配置为 main 的硬门禁；macOS/Linux 真机五步 UAT、Windows 安装与五步 UAT、同版本/同提交实际安装包 manifest 验证、媒体依赖再分发许可复核未完成。当前代码级三端 CI 通过，不得据此声称已合并、可发布或已达到平台支持级别。

下一步顺序：不再为“凑绿”新增功能或扩展代码优化范围；先由用户决定是否授权把三端 job 配成 `main` Required checks（当前 branch protection 与 rulesets 均为空），再安排 Windows 安装及五步 UAT、macOS/Linux 知情测试者真机五步 UAT，并完成候选安装包同提交 manifest 校验和媒体依赖许可复核。未安排到目标设备时保留为未验收、不升级平台承诺。现有 5 条 lint 警告保持独立小批。用户已要求本轮不合并 `main`；PR、合并、安装/分发与发布仍须另行明确授权。

#### P5：主线合并与候选验收（独立授权边界）

当前集成提交/推送及三端 CI 授权已完成，工作分支代码提交 `b9ac04f` 的 code-gate 首次全绿，文档提交 `ca3bd72` 的 run 经 frontend 失败 job 复跑后全绿；`SettingsPage.test.tsx:478` 的一次性失败根因尚不明，详见 §2.4。用户明确要求暂不合并 `main`。下一步若要让三端门禁成为硬阻断，先取得配置 branch protection/ruleset 的明确授权；PR、合并以及候选包安装/分发仍分别要求用户授权。完成平台 UAT、许可与候选包证据前不得进入发布。

三端包须同版本、同提交；Windows 完整回归，macOS/Linux 以固定五步人工脚本验收。没有设备/测试者就如实停在构建证据，不升级支持等级。对外分发还需符合平台文档的许可、签名及知情测试要求。

**本阶段结束条件：**范围账本清楚、没有新功能夹带、现有缺陷与规范收口完成、本地和三端合并门禁通过、审查完成。合并操作和发布操作分别需要授权。之后的新功能只能由用户另行提出，不能从旧候选列表自动启动。

## 5. 交付流程

每个功能按以下顺序推进：

1. 确认 PRD 和协议，不接受口头隐含需求。
2. 写清验收标准、失败路径和数据不变量。
3. 实现代码和测试。
4. 跑定向测试与完整门禁。
5. 真实桌面环境走查。
6. 更新权威文档、版本和发布说明。
7. 形成可独立回退的提交。

## 6. 质量目标

| 维度 | 目标 |
|---|---|
| 正确性 | 数据层、文件系统和 UI 状态保持一致 |
| 稳定性 | 长任务可取消/恢复；重启不留下永久 processing |
| 性能 | 3 万素材可浏览；搜索目标 ≤500ms；图像解码有限流 |
| 安全 | 本地优先、凭据进 keyring、路径防穿越、SQL 参数绑定 |
| 可维护性 | commands/services/db 分层；契约集中；无历史文档冲突 |
| 可交付性 | smoke、Rust/前端门禁、真实 UAT 全部可复验 |

## 7. 风险登记

| 风险 | 影响 | 控制 |
|---|---|---|
| 真实素材样本不足 | 自动化通过但产品语义未验收 | 把真实 UAT 作为独立发布门禁 |
| 搜索协议多入口漂移 | 列表、总数、诊断结果不一致 | SearchPlanV3 作为唯一执行计划 |
| 分面双事实源 | AI、手工和筛选结果不同步 | tag_facets 唯一事实源 |
| 长任务和脏工作区 | 出错后难以回滚 | 小批提交、幂等迁移、备份保底 |
| RAW/HEIC 许可和分发 | 对外发布存在合规风险 | 分发前法务复核并保留替换方案 |
| 本地模型环境差异 | 安装成功但推理不可用 | 检测、就绪复检、推荐模型和错误引导 |
| 大组件持续膨胀 | 修改风险和维护成本增加 | 独立治理批次拆分，不与功能混改 |

## 8. 文档维护

- 产品范围变化改 [PRD.md](PRD.md)。
- 阶段状态和排期变化改本文。
- 架构或机制变化改 [ARCHITECTURE.md](ARCHITECTURE.md)。
- 机器协议变化改 [contracts](contracts/)。
- 日期化任务说明不新增长期文档，提交和 PR 即为过程记录。
