# 茶包素材 V2 — 开发规范与指南

> 版本 v1.0 ｜ 2026-08-12
> 定位：怎么搭环境、怎么写代码、怎么提交。**违反本文规范的 PR/改动一律打回。**

---

## 一、环境搭建（Windows）

| 依赖 | 安装/位置 | 验证 |
|---|---|---|
| Rust (stable-msvc) | rustup 默认安装 | `cargo --version` |
| VS Build Tools | C++ 生成工具工作负荷 | 链接器可用 |
| Node.js | 便携版：`C:\Users\33887\AppData\Roaming\WPS 灵犀\portable-node\node-v24.17.0-win-x64`（或自装 LTS） | `node -v` |

**PATH 配置**（Git Bash 单次生效）：

```bash
export PATH="/c/Users/33887/.cargo/bin:$PATH"
# 便携 Node 如需手动加：
export PATH="/c/Users/33887/AppData/Roaming/WPS 灵犀/portable-node/node-v24.17.0-win-x64:$PATH"
```

VSCode/其他编辑器终端若报 `npm : 无法将"npm"项识别…`，需在系统环境变量或该终端 profile 里加 Node 路径。

## 二、日常开发命令

```bash
cd /f/vibecode/chabaosucai
npm run tauri dev        # 开发模式（前端 1420 端口 HMR；Rust 改动 watcher 自动重编译）
npm run typecheck        # tsc --noEmit
npm run build            # tsc + vite build
cd src-tauri && cargo test          # Rust 全量测试
cargo test --lib                    # 只跑单元测试
cargo test --test perf_probe -- --ignored   # 真实文件性能探针（默认 ignore）
```

**三关交付线**（每次交付前必须全过）：`cargo test` 全绿 ＋ `npm run typecheck` 零报错 ＋ `npm run build` 通过。

### 2.1 UI 开发规范

界面开发必须遵循 [UI_DESIGN_SYSTEM.md](./UI_DESIGN_SYSTEM.md)。新增页面和组件应优先复用 `src/styles/theme.css` 的语义变量，以及 `src/styles/index.css` 中的基础控件、区块标题和导航状态类，不在业务组件内另建一套无语义灰色、圆角和选中态。

## 三、铁律（不可协商）

### 3.1 文档先行

任何偏离 PRD/架构的实现决策：**先记 PROGRESS.md 决策日志 + 改 PRD 修订号，再动代码**。勾选任务 = 验收标准全部通过才算。

### 3.2 分层解耦

```
commands（薄壳：校验/锁/事件）→ services（业务逻辑，可单测）→ db（SQL）
```

- 禁止在 command 里写业务、在 service 里拼 SQL、在 page 里写请求细节（走 api/ 层）
- 一个文件一个职责；页面只编排，交互细节沉到 components
- 前端改 Rust 结构体字段 → 必须同步 `src/types/`

### 3.3 性能红线

- **图像解码只走 `services/imaging.rs`**（全局唯一引擎），禁止另起解码
- 新增图像相关 crate → 必须加进 `Cargo.toml` 的 dev O3 列表
- DB 锁内禁止耗时操作（解码/网络/大文件 IO）
- 网络请求必须 `spawn_blocking`，事件用 `app.emit`

### 3.4 UI 规范

- 黑白灰；主 CTA 黑色实心，其余幽灵文字按钮；不用"特殊颜色框框"突出普通操作
- 动效简约自然（苹果式）；新界面背景不透明
- 右键菜单用 `ContextMenu` 组件（点外关闭的捕获监听**必须排除菜单内部**，历史 bug）

## 四、代码风格细则

### Rust

- 错误统一 `AppError::msg(...)` / `AppResult<T>`；不裸 `unwrap()`（测试除外）
- 日志用 `tracing`（warn 级别记单条失败，不刷屏）
- 新增表结构 → `migrations.rs` 加版本迁移，禁止手改旧迁移
- 配置兼容 → `settings.rs` 的 `normalize()` 只读迁移，禁止双数据源

### TypeScript / React

- 严格类型，`any` 需注释理由；`tsc --noEmit` 必须零报错
- Store 动作异步错误统一 `set({ error })` 并在页面展示
- React `onWheel` 拦不住浏览器默认行为——需要 preventDefault 的滚轮交互用**原生监听 `passive: false`**（查看器缩放的历史坑）
- 列表/网格大数据必须虚拟滚动（@tanstack/react-virtual）

### 文件与提交

- 源码文件行尾 **CRLF**（Windows 仓库现状），不要全量转 LF 造成巨型 diff
- 命名：Rust snake_case、TS 组件 PascalCase、其余 camelCase
- 分支：主分支保持三关全绿；功能分支合并前跑三关

## 五、测试要求

| 层 | 要求 |
|---|---|
| Rust 单测 | services/db 的纯逻辑必须配单测（解析、迁移、状态机边界） |
| 集成测试 | `src-tauri/tests/`：入库/导出/删除清理/缩略图缓存链路 |
| 性能探针 | `perf_probe.rs`（#[ignore]）：真实文件解码基准，改 imaging 后必跑 |
| 前端 | tsc + build + 手动冒烟（页面跳转/热更新/右键菜单逐项点） |

**验收标准写完再写实现**（T02 起的惯例）。新功能先想"怎么证明它对了"。

## 六、依赖管理

- Rust：`src-tauri/Cargo.toml`，加依赖需评估体积与编译时间；图像类必加 dev O3
- 前端：`package.json`，UI 交互优先自研小组件（黑白灰体系），重组件先看现有 common/
- 已移除的依赖不要再引入：`jpeg-decoder`（实测 1.5s 慢于 zune-jpeg O3 全解码 0.37s，决策日志有依据）

## 七、给 AI 协作者的补充约定（vibe coding 场景）

1. 改代码前先读 ARCHITECTURE.md 第四节「关键机制」与第六节「设计约束」
2. 多行精确替换注意 CRLF 行尾；shell heredoc 含特殊字符易断裂——复杂补丁写 .py 脚本执行
3. 每轮改动结束更新 PROGRESS.md（勾选/决策日志），PRD 修订号递增
4. 遇到"看不懂为什么这么写"的代码，先查 TROUBLESHOOTING.md——大概率是踩过坑的防御性写法
