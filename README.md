# 茶包素材 BagerTea AiMedias

> **v1.0.1 (demo)** — 本地优先的图片/视频素材管理系统
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
- **双层缩略图**：入库即生成 256px 占位图，浏览时按需生成 512px 高清层；高清层 LRU 缓存 + 容量上限控制，不无限吃磁盘
- **虚拟滚动**：基于 `@tanstack/react-virtual`，3 万素材流畅滚动

### 🔍 中文搜索（真下过功夫）
- **FTS5 外部内容表 + 自定义 CJK 逐字分词**（`cjk_bigram`），配合短语查询，解决「海边」误命中「上海湖边」的经典坑
- **混合命名兼容**：ASCII 子串搜索（搜 `202` 命中 `IMG_2024_001.jpg`）、CJK 与数字字母粘连（`进度100%.jpg`）、多标签组合搜索顺序无关
- **≤2 字 LIKE 兜底**，短查询不丢结果

### 🏷️ 标签体系
- **父子层级标签树**（2 级可折叠），素材库页左侧任务栏即选即筛
- **EXIF 自身标签（只读）与 AI 分类标签（可自定义分类/上限）分离**

### 🤖 AI 打标
- **多中转站档案（profiles）自由切换**：OpenAI 兼容 + Anthropic 双模式
- **批量确认工作台**：AI 建议逐条确认 / 一键全确认，支持取消

### ⚡ M2.0 批量操作
- 单击 / `Ctrl` 多选 / `Shift` 范围选 / 全选 / 反选
- 右键上下文菜单 + 快捷键（`Ctrl+A` 全选、`Ctrl+I` 反选）
- 批量删除双策略（仅移出库 / 删除文件）二次确认；磁盘删除失败会明确提示，**不产生假删除**

### 📤 导出
- 复制 / 移动双模式，目标目录同名自动避让；move 模式同步更新库记录，预览不失效

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
| 图像 | **image crate** | Rust 原生解码缩略图，无系统依赖 |
| 并行 | **rayon** | 导入/缩略图并行处理 |

---

## 🚀 快速开始

### 环境要求

| 依赖 | 版本 |
|---|---|
| Node.js | ≥ 20 |
| Rust | stable（≥ 1.80） |
| 系统 | Windows 10/11、macOS |

> 视频元数据提取依赖 `ffmpeg`/`ffprobe`（可选，缺省时自动降级为通用占位图）。

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
# 后端全量测试（108 用例：单元 + DB 集成 + 服务集成 + 搜索/边界回归）
cd src-tauri && cargo test

# 前端类型检查与构建
npm run typecheck
npm run build
```

---

## 📁 项目结构

```
├── src/                      # 前端（React + TS + Zustand）
│   ├── api/                  # Tauri 命令封装层（前端唯一调用入口）
│   ├── stores/               # Zustand 状态（素材库/选中/设置）
│   ├── components/           # 组件（素材网格、标签树、对话框…）
│   ├── pages/                # 页面（素材库/打标/设置）
│   └── types/                # 类型定义
├── src-tauri/                # 后端（Rust）
│   ├── src/
│   │   ├── commands/         # Tauri 命令层
│   │   ├── db/               # SQLite：schema/迁移/素材/标签/搜索/导出
│   │   ├── services/         # 业务服务：缩略图/导入/导出/去重/AI 打标
│   │   ├── utils/            # 工具：CJK 分词/路径/哈希/MIME
│   │   └── state.rs          # 全局状态（DB 连接、取消标志）
│   └── tests/                # 集成测试（108 用例）
└── docs/                     # 项目文档（见下）
```

---

## 📚 文档

- [PROJECT_PLAN.md](docs/PROJECT_PLAN.md) — 项目总纲：目标/里程碑/风险
- [prd_bagertea_v2.md](docs/prd_bagertea_v2.md) — 需求权威（PRD v2.x）
- [ARCHITECTURE.md](docs/ARCHITECTURE.md) — 架构现状：模块职责/数据流/设计约束
- [PROGRESS.md](docs/PROGRESS.md) — 进度唯一事实来源 + 决策日志
- [DEVELOPMENT.md](docs/DEVELOPMENT.md) — 开发规范：环境/铁律/代码风格/测试
- [PERFORMANCE.md](docs/PERFORMANCE.md) — 性能实测基准与回归清单
- [TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) — 踩坑记录（症状→根因→修法）
- [HANDOVER.md](docs/HANDOVER.md) — 交接运维：快速上手/发布/应急预案
- [docs/review/](docs/review/) — 质量评估与修复记录（架构审查 / QA 测试 / 修复计划）

---

## ⚠️ 免责声明

**v1.0.1 (demo)**：当前为演示/重构基线版本，核心功能（入库/搜索/标签/AI 打标/批量操作/导出）已通过 108 项自动化测试，但仍有已知待办（API key 本地明文存储、设置页错误提示 UX 等）。请勿在生产环境存放敏感数据。

---

## 📄 License

MIT
