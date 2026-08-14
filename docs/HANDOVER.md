# 茶包素材 V2 — 交接手册

> 版本 v1.0 ｜ 2026-08-12
> 定位：**新人（或新 AI 会话）30 分钟独立上手指南**。按顺序读完本节+ARCHITECTURE.md 即可开工。

---

## 一、30 秒认识这个项目

本地图片/视频素材数据库（摄影/设计素材管理），推倒 V1 重做。Tauri 2 桌面应用：Rust 后端管 SQLite/文件/AI 请求，React 前端管 UI。当前 M1（核心闭环）代码完成、出口走查中；M2（本地小模型+网盘导出）未开工。

## 二、快速上手（10 分钟跑起来）

```bash
# 1. 环境（Windows）：Rust + VS Build Tools + Node
export PATH="/c/Users/33887/.cargo/bin:$PATH"   # Git Bash 下 cargo

# 2. 启动开发模式
cd /f/vibecode/chabaosucai
npm install          # 首次
npm run tauri dev    # 前端 1420 端口；Rust 改动自动重编译

# 3. 交付前三关
cd src-tauri && cargo test && cd ..
npm run typecheck && npm run build
```

**数据位置**（排查问题要用）：

| 内容 | 位置 |
|---|---|
| SQLite 数据库 | `%APPDATA%\bagertea_ai_media_v2\library.db` |
| 素材总库 | 设置页可配（入库文件实际存放地，分库=总库下新建文件夹） |
| 缩略图缓存 | 设置页可查看/手动清除 |

## 三、目录导览

```
chabaosucai/
├── docs/                    # 全部文档（README.md 是文档地图）
├── src/                     # 前端 React
│   ├── pages/               #   4 个页面：入库/素材库/打标/设置
│   ├── components/          #   common·layout·library·import·ai·dialogs
│   ├── stores/              #   Zustand × 5
│   ├── api/                 #   invoke 封装
│   └── types/               #   与 Rust serde 对齐
├── src-tauri/
│   ├── src/
│   │   ├── commands/        #   Tauri 命令（薄壳）
│   │   ├── services/        #   业务逻辑（imaging 是性能命脉）
│   │   ├── db/              #   SQL + migrations
│   │   └── utils/           #   纯函数
│   ├── tests/               #   集成测试 + perf_probe 性能探针
│   └── Cargo.toml           #   注意 dev O3 列表
└── package.json
```

## 四、必读文档顺序

| 顺序 | 文档 | 读完能干什么 |
|---|---|---|
| 1 | 本文 | 跑起来、知道东西在哪 |
| 2 | [ARCHITECTURE.md](ARCHITECTURE.md) 第四/六节 | 不踩设计约束的雷 |
| 3 | [DEVELOPMENT.md](DEVELOPMENT.md) | 按规范写代码 |
| 4 | [prd_bagertea_v2.md](prd_bagertea_v2.md) | 理解需求全貌 |
| 5 | [TROUBLESHOOTING.md](TROUBLESHOOTING.md) | 出问题时速查 |
| 6 | [PROGRESS.md](PROGRESS.md) | 当前焦点 + 决策历史 |

## 五、发布与验证

### 构建发布包

```bash
npm run tauri build    # 产出安装包（src-tauri/target/release/bundle/）
```

### 验收清单（发版前）

- [ ] 三关全过（cargo test / typecheck / build）
- [ ] PROGRESS.md 任务看板勾选与决策日志已更新
- [ ] PRD 修订号递增（如有行为变化）
- [ ] 手动冒烟：入库→浏览→搜索→打标→导出→删除 全链路一遍
- [ ] 性能清单（PERFORMANCE.md 第四节）

## 六、应急预案

| 状况 | 处置 |
|---|---|
| 数据库打不开/查询报错 | 外部工具只能 SELECT（cjk_bigram 限制）；先用应用内功能确认是否真损坏 |
| 打标全部失败 | 看 tracing 日志 warn；多半是模型不支持视觉或中转站截断——换 qwen-vl-max / gpt-4o 级模型实测 |
| 缩略图全黑/加载不出 | 查 imaging 策略链日志；确认不是 DB 锁饿死（TROUBLESHOOTING #1） |
| 配置错乱 | 删 `library.db` 里 `app_settings` 行可重置为默认（会丢 API Key，先备份） |
| 需要清空测试数据 | 应用内删除功能；**不要**直接 SQL DELETE |

## 七、协作约定速记

1. **文档先行**：先改文档再改代码；决策日志只追加
2. **解耦**：command 薄壳 / service 业务 / db SQL；页面只编排
3. **图像解码只有 imaging.rs 一个入口**
4. **黑白灰 UI**：主 CTA 黑实心，其余幽灵按钮
5. **交付三关**：cargo test 全绿 + tsc 零报错 + build 通过
6. 不懂就问老板——老板原话："如果你有什么不懂的，一定要及时问我"

## 八、当前未竟事项（交接时点快照）

- [ ] 老板用**视觉模型**实测 AI 打标端到端（v2.12 修复后复验）
- [ ] M1 出口走查：PRD P0 需求逐条 + 3 万素材性能回归
- [ ] T05b（M2）：本地小模型（断点续传+sha256）+ 百度网盘 OAuth + 端到端
- [ ] 开放问题：本地小模型选型、百度 API 资质（PRD 第七章）
