# 茶包素材 BagerTea AiMedias

> **v1.0.1 → Phase 3** — 本地优先的图片/视频素材管理系统
> 达芬奇底栏 + Notion 极简风 + LR 式左侧任务栏的桌面素材库

基于 **Tauri 2 + Rust + React 19** 构建的本地桌面素材管理系统。所有素材、标签、搜索索引均存储在本地 SQLite 中，不上传云端，适合个人/团队管理海量图片与视频素材。

![tech-stack](https://img.shields.io/badge/Tauri-2-24c8db)
![rust](https://img.shields.io/badge/Rust-1.80+-orange)
![react](https://img.shields.io/badge/React-19-61dafb)
![typescript](https://img.shields.io/badge/TypeScript-5.5+-3178c6)
![sqlite](https://img.shields.io/badge/SQLite-FTS5-blue)
![license](https://img.shields.io/badge/License-MIT-green)

---

## ✨ 核心特性

### 📦 素材管理
- **图片 / 视频批量入库**：复制或移动托管，入库时自动提取尺寸、EXIF、视频元数据
- **双层缩略图**：入库即生成占位图，浏览时按需生成高清层；高清层 LRU 缓存 + 容量上限控制，不无限吃磁盘
- **虚拟滚动**：基于 `@tanstack/react-virtual`，3 万素材流畅滚动

### 🖼️ 多格式支持（Phase 2）
- **RAW 全家桶**：25+ 扩展名白名单（CR2/CR3/NEF/ARW/RAF/ORF/RW2/PEF/DNG…），三级内嵌预览链毫秒级出图
- **RAW 真解码兜底**：rawler 全管线（2×2 Bayer binning + 色彩管线），内嵌预览缺失时高清层照样出图
- **HEIC/HEIF 解码**：heif-rs + 预编译静态 libheif（离线构建友好），iPhone HEIC 不再黑图
- **TIFF/BMP/TGA 原生解码**：LZW/Deflate 压缩 TIFF 直接出图；卡片右上角 RAW/TIFF/HEIC 格式角标

### 🔍 中文搜索（真下过功夫）
- **FTS5 外部内容表 + 自定义 CJK 逐字分词**（`cjk_bigram`），配合短语查询，解决「海边」误命中「上海湖边」的经典坑
- **混合命名兼容**：ASCII 子串搜索（搜 `202` 命中 `IMG_2024_001.jpg`）、CJK 与数字字母粘连（`进度100%.jpg`）、多标签组合搜索顺序无关
- **≤2 字 LIKE 兜底**，短查询不丢结果

### 🏷️ 标签体系（M3 重构）
- **父子层级标签树**（2 级可折叠），素材库页左侧任务栏即选即筛
- **标签管理视图**：重命名 / 合并到（单事务改挂）/ 移动到（递归 CTE 防环）/ 删除二次确认
- **EXIF 自身标签（只读）与 AI 分类标签（可自定义分类/上限）分离**

### 🤖 AI 打标（云端 + 本地双模式）
- **多中转站档案自由切换**：OpenAI 兼容 + Anthropic 双模式
- **Ollama 本地打标**：档案 `kind=local` 直通 OpenAI 兼容协议，管线零改动
- **应用内全自动部署**：检测 Ollama → 应用内下载安装（多源降级 + 断点续传）→ 静默安装 → 显存推荐模型 → 一键拉取并自动写回配置
- **视频打标**：ffmpeg 抽头/中/尾三帧，≥2 帧命中才进建议，防单帧噪声
- **批量确认工作台**：AI 建议逐条确认 / 一键全确认，支持取消；打标历史流水（AI/manual 溯源）+ 按批次一键撤销

### ⚡ 批量操作与去重
- 单击 / `Ctrl` 多选 / `Shift` 范围选 / 全选 / 反选；右键菜单 + 快捷键
- 批量删除双策略（仅移出库 = 进回收站软删 / 彻底删除文件）二次确认，**不产生假删除**
- **重复素材检测**：hash 分组扫描 + 分组去重面板，保留最早高亮、其余勾选批量处理
- **回收站**：超期自动清理，彻底删除失败保留 DB 记录可恢复

### 📤 导出
- 复制 / 移动双模式，目标目录同名自动避让；move 模式同步更新库记录
- **导出布局增强**：flat / by_tag / by_date 子目录结构 + CSV 清单（UTF-8 BOM，Excel 直开）

### 🎨 其他体验
- **排序与筛选**：创建时间/拍摄时间/体积/分辨率 + 多标签 any/all 模式
- **详情页抽屉**：标签增删 + EXIF/视频元数据面板
- **主题切换**：light / dark / system，组件零改动架构
- **全局任务条**：BottomBar 聚合导入/AI/导出进度事件

---

## 🛠️ 技术栈

| 层 | 选型 | 说明 |
|---|---|---|
| 桌面框架 | **Tauri 2** | 体积小、内存低，Rust 后端直接操作文件系统 |
| 后端 | **Rust** | 分层架构：`commands/`（命令层）→ `db/` `services/` `utils/`（业务/服务/工具），前端禁止直连 `invoke` |
| 数据库 | **SQLite**（rusqlite bundled） | WAL 模式、FTS5 全文索引、触发器维护 |
| 前端 | **React 19 + TypeScript** | 类型安全 |
| 状态 | **Zustand 5** | 轻量、分层清晰 |
| 样式 | **Tailwind CSS v4** | 黑白灰高级感、苹果式简约动效 |
| 列表 | **@tanstack/react-virtual** | 虚拟滚动，万级素材流畅 |
| 图像 | **image crate + heif-rs + rawler** | JPEG/PNG/WebP/TIFF/BMP/TGA 原生解码 + HEIC 静态链接 + RAW 真解码 |
| 并行 | **rayon** | 导入/缩略图并行处理 |
| 测试 | **cargo test + Vitest** | 后端 136 用例 + 前端 store/组件单测 |

---

## 🚀 快速开始

### 环境要求

| 依赖 | 版本 |
|---|---|
| Node.js | ≥ 20 |
| Rust | stable（≥ 1.80） |
| 系统 | Windows 10/11、macOS |

> 视频元数据提取依赖 `ffmpeg`/`ffprobe`（可选，缺省时自动降级为通用占位图）。
> HEIC 解码使用仓库内 `heif-bin/` 预编译静态库（Windows x64），克隆即用，无需额外安装。

### 开发运行

```bash
npm install
npm run tauri dev
```

### 构建安装包

```bash
npm run tauri build
```

### 测试

```bash
# 后端全量测试（136 用例：单元 + DB 集成 + 服务集成 + 格式矩阵 + 搜索/边界回归）
cd src-tauri && cargo test

# 前端单测（stores / 组件）
npx vitest run

# 前端类型检查与构建
npm run typecheck
npm run build
```

---

## 📁 项目结构

```
├── src/                      # 前端（React + TS + Zustand）
│   ├── api/                  # Tauri 命令封装层（前端唯一调用入口）
│   ├── stores/               # Zustand 状态（素材库/选中/任务/设置/AI）
│   ├── components/           # 组件（素材网格、标签树、对话框、设置分组…）
│   ├── pages/                # 页面（素材库/打标/设置）
│   └── types/                # 类型定义
├── src-tauri/                # 后端（Rust）
│   ├── .cargo/config.toml    # HEIF_BINARIES_DIR 指向仓库内预编译库
│   ├── src/
│   │   ├── commands/         # Tauri 命令层（含 ollama_cmd）
│   │   ├── db/               # SQLite：schema/迁移/素材/标签/去重/搜索/导出
│   │   ├── services/         # 缩略图/导入/导出/AI 云端/HEIC 解码/RAW 解码/Ollama 安装与配置
│   │   ├── utils/            # 工具：CJK 分词/路径/哈希/MIME
│   │   └── state.rs          # 全局状态（DB 连接、取消标志）
│   └── tests/                # 集成测试（136 用例）
├── heif-bin/                 # 预编译 libheif/x265/libde265（Windows x64 静态库）
└── docs/                     # 项目文档（见下）
```

---

## 📚 文档

- [PROJECT_PLAN.md](docs/PROJECT_PLAN.md) — 项目总纲：目标/里程碑/风险
- [prd_bagertea_v2.md](docs/prd_bagertea_v2.md) — 需求权威（PRD v2.x）
- [ARCHITECTURE.md](docs/ARCHITECTURE.md) — 架构现状：模块职责/数据流/设计约束
- [PROGRESS.md](docs/PROGRESS.md) — 进度唯一事实来源 + 决策日志
- [DEVELOPMENT.md](docs/DEVELOPMENT.md) — 开发规范：环境/铁律/代码风格/测试
- [PHASE2_FORMATS.md](docs/PHASE2_FORMATS.md) — Phase 2 多格式支持总纲（调研/选型/拆解）
- [PHASE3_AI_EXPORT.md](docs/PHASE3_AI_EXPORT.md) — Phase 3 AI 与体验增强总纲
- [LOCAL_MODEL_SETUP_A3.md](docs/LOCAL_MODEL_SETUP_A3.md) — 本地模型应用内一键部署设计
- [TEST_STRATEGY.md](docs/TEST_STRATEGY.md) — 测试策略
- [PERFORMANCE.md](docs/PERFORMANCE.md) — 性能实测基准与回归清单
- [TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) — 踩坑记录（症状→根因→修法）
- [HANDOVER.md](docs/HANDOVER.md) — 交接运维：快速上手/发布/应急预案
- [USER_TEST_GUIDE.md](docs/USER_TEST_GUIDE.md) — 用户走查指南
- [docs/review/](docs/review/) — 质量评估与修复记录（架构审查 / QA 测试 / 修复计划）

---

## ⚠️ 免责声明

当前版本：Phase 2（多格式）与 Phase 3（AI/体验）**代码层全部完成**，后端 136 项自动化测试三关全绿；但 RAW/HEIC 真实样本验收仍在进行中，另有已知待办（API key 本地明文存储、AVIF 支持缓议等）。请勿在生产环境存放敏感数据。

---

## 📄 License

MIT
