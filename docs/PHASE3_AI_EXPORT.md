# 第三阶段开发计划：AI 与体验增强（本地打标 / 视频打标 / 体验完善）

> 版本 v1.0 ｜ 2026-08-18 ｜ 定位：Phase 3（v2.14~v2.16）总纲
> 依据：老板 2026-08-18 拍板「先不做网盘的东西，其他的按计划开始」——网盘导出（R-11/R-16）整体暂缓入机动项。
> 本文档 = 调研结论 + 任务拆解 + 验收标准。进度跟踪见 [PROGRESS.md](PROGRESS.md)，里程碑见 [PROJECT_PLAN.md](PROJECT_PLAN.md)。

---

## 一、调研结论（影响方案的关键事实）

1. **本地打标速赢路线成立**：`services/ai_cloud.rs` 已是标准 OpenAI 兼容客户端（base_url + Key + 多档案），Ollama/LM Studio 本地服务原生兼容该协议（/v1/chat/completions + vision message）。「本地模式」= 档案 kind=local，管线零改动。
2. **百度/夸克网盘暂缓**：调研实测百度开放平台分享链接接口仅企业开发者可用、token 30 天过期无 refresh；老板拍板暂缓，结论与实现预案保留在机动项，恢复时直接启用。
3. **ort 内嵌模型为机动项**：R-07 原文「应用内自动安装模型」的正解是 ort（ONNX Runtime Rust 绑定，2.0 版 load-dynamic 分发）+ Chinese-CLIP 零样本标签匹配；编译/体积风险未消除前不进承诺范围，速赢路线先交付。
4. **开源借鉴**：Immich（模型注册/按需下载形态）、PhotoPrism（分类阈值防污染）、digiKam（去重向导/watch folder/人工确认流）、Eagle/Lightroom（标签合并、排序菜单、最近删除交互）、alist（网盘 driver，机动项启用时参考）。

## 二、任务拆解

### v2.14（S1 Phase 3 核心）

| ID | 任务 | 验收关键项 |
|---|---|---|
| **P3-01a** | 本地兼容端点打标 | profiles 加 `kind: cloud\|local`（serde default=cloud 旧数据零感知）；前端档案编辑支持本地端点（默认 Ollama 地址 + 引导文案，API Key 可选）；`ai_start_batch` 放开 local mode（按激活档案 kind 校验一致性）；本地服务不可达时报错含安装引导；Ollama + 视觉模型全链路跑通 |
| **P3-02** | 视频 AI 打标（R-15） | `video_tagging` 开关生效（默认关）；开启后批次纳入视频；ffmpeg 抽头/中/尾三帧；逐帧请求后按频次合并（≥2 帧命中才进建议）；抽帧失败置 rejected 不阻塞批次 |

### v2.15（S2 M3 体验完善）

| ID | 任务 | 验收关键项 |
|---|---|---|
| **M3-01** | 标签管理（R-19） | merge（asset_tags 改挂 + 删源标签，单事务）、reparent（递归 CTE 防环）；前端管理视图：重命名/合并到/移动到/删除；删除有关联素材二次确认；合并后计数/FTS/树一致 |
| **M3-02** | 重复素材检测（R-20） | hash GROUP BY 扫描 + 分页分组；前端分组卡片（保留最早高亮、其余可勾选批量移出库）；删除走现有双策略 |
| **M3-03** | 详情页增强（R-18） | ViewerPage 右侧抽屉：标签增删改 + 元数据面板（EXIF + 时长/分辨率/编码）；不新建路由 |
| **M3-04** | 批量操作增强（R-17） | 「移动到目录」入口（复用 export copy\|move）；BottomBar 全局任务条聚合现有进度事件 |

### v2.16（S3 P2 打包）

| ID | 任务 | 验收关键项 |
|---|---|---|
| **R-21** | 排序/多标签筛选 | AssetFilter 加 sort_by（created_at/taken_at/size/resolution）+ tags_mode（any\|all，AND 用 EXISTS 子查询）；新排序列有索引；taken_at 缺值排最后 |
| **R-22** | 回收站 | assets.deleted_at 软删；list 默认过滤；恢复/彻底删除；N 天自动清理（启动时检查） |
| **R-24** | 主题切换 | data-theme（light/dark/system）；组件零改动（var(--color-*) 架构已就位） |
| **R-25** | 打标历史/撤销 | tag_ops 流水表（ai\|manual）；按批次反向撤销；打标页左栏「最近打标」 |
| **R-26** | 导出增强 | layout: flat\|by_tag\|by_date 子目录；CSV 清单（UTF-8 BOM） |

### 机动项（不进承诺，PoC 后定）

- **P3-01b** ort 内嵌模型：MSVC load-dynamic PoC + Chinese-CLIP 单图 ≤500ms；通过后补 db/models.rs 注册表 + 断点续传下载 + ai_local.rs。
- **R-11/R-16 网盘导出**：老板 2026-08-18 拍板暂缓；预案：provider trait 适配层 + 分片上传 + OAuth 本地回调。
- **R-23 目录监控**：notify crate + 事件去抖 PoC。

## 三、横向约束（所有任务遵守）

- 分层铁律 commands→services→db；service 注入 `Arc<Mutex<Connection>>` + 回调，不碰 AppHandle。
- AI 管线只按 mode/kind 分发，禁止复制批次循环。
- DB 变更走 migrations.rs；短锁规范（跨 IO 不持锁）；新命令进 capabilities/default.json。
- 重活全部 spawn_blocking + 有界并发（信号量模式），严禁堵 IPC 主线程。
- 三关全绿（cargo test / tsc / vite build）缺一不交。

## 四、风险登记

| 风险 | 等级 | 应对 |
|---|---|---|
| ort/ONNX MSVC 分发体积 | 中 | load-dynamic + PoC 先行；失败仅保留 P3-01a |
| Chinese-CLIP 中文自定义标签效果未验 | 中 | PoC 用真实标签体系测 top-k 命中率 |
| 视频抽帧依赖 ffmpeg PATH | 低 | 探测 + 优雅降级；无 ffmpeg 置 rejected |
| Ollama 本地模型视觉能力参差 | 低 | 引导文案列推荐模型（llava/qwen2.5-vl）；空解析即失败已兜底 |
