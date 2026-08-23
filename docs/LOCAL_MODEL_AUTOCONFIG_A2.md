# 茶包素材 · 本地模型一键配置（方案 A2，修订版）开发提示词

> 用途：复制本文件全文，作为任务指令交给 AI 开发 agent。
> 关系：本文件为本地模型一键配置的现行方案（早期「方案 A」文档因 3 处会直接导致功能失败的硬伤——模型名拼写、/v1 路径、AdapterRAM 4GB 上限——与多处项目规范不符，已被本版取代并移除，修正点见 §9）。
> 范围：仅「检测 + 推荐 + 一键拉取 + 自动配置」；**不含** Ollama 二进制 sidecar 打包（方案 B，本期不做）。
> 使用建议：交给 agent 时，先让它阅读 `docs/PROGRESS.md`、`src-tauri/src/services/ai_cloud.rs`、`src/pages/SettingsPage.tsx` 对齐现状再实施。

## 1. 项目与技术栈（必读上下文，已核实）

- 桌面应用「茶包素材 BagerTea AiMedias」：Tauri 2 + Rust（后端）+ React 19 + TypeScript + Zustand + **Tailwind v4 + 自研组件**（Button/Field/TextInput/ProgressBar 等，`src/components/common/`）。**项目没有 shadcn/ui，严禁引入**。
- 本地存储：SQLite + FTS5；迁移走 `db/migrations.rs`（当前 user_version=5）。
- 现有 AI 打标架构：`services/ai_cloud.rs` 是单一 OpenAI 兼容客户端（`POST /chat/completions` + vision message），按档案 `kind`(cloud/local) 切换；`kind=local` 免 Key 校验，连不上时已有安装引导文案（P3-01a 已交付）。**本任务零改动打标主流程**。
- 项目铁律（不可违反）：
  - 分层 commands→services→db：HTTP/解析逻辑进 `services/`，service 只接受注入参数 + 回调，不碰 AppHandle，可单测（参考 imaging/export_local 先例）。
  - 长任务一律 `spawn_blocking` + 有界并发，严禁堵 IPC 主线程。
  - 进度事件命名风格：`ai://progress`、`export://progress`、`import://progress` → 本任务用 **`ollama://pull-progress`**。
  - reqwest 用 blocking 风格（与 ai_cloud.rs / export 一致）。
  - 每版本交付三关全绿：**cargo test（现有 128 项不得回归）+ tsc --noEmit + vite build**。
  - 新命令在 `lib.rs` 的 `invoke_handler` 注册（自定义命令无需 capabilities 条目，项目既有实践）。
  - 交付时在 `docs/PROGRESS.md` 决策日志补记（追加在顶部）。

## 2. 现状缺口（已对代码核实）

`SettingsPage.tsx` 的 `switchKind()`（约 L83-93）切本地时只做「半自动」：
- 自动预填 `base_url = http://localhost:11434/v1` ✓
- 仅当 model 还是云端默认 `qwen-vl-plus` 时改填硬编码 **`llava`**（中文弱；未 pull 时首次打标空解析失败）
- 仅一行引导文案让用户手动 `ollama pull`
- 无存活检测、无一键拉取、无模型推荐

目标：小白用户切到本地后，**一路点按钮就能完成部署**：看到 Ollama 状态 → 没装就点「打开下载页」→ 装好回来看到推荐模型 → 点「一键拉取并配置」→ 进度条走完 → 直接能打标。

## 3. 关键技术事实（方案 A 踩错的，必须照此实现）

1. **模型名**：Ollama 官方库名是 **`qwen2.5vl`（无连字符）**，tag 为 `3b` / `7b`（默认量化即 q4_K_M，不存在 `7b-q4` 这类 tag）。拼错会 pull 失败 "file does not exist"。
2. **API 根地址推导**：档案 base_url 是 OpenAI 兼容层 `http://localhost:11434/v1`，而 `/api/tags`、`/api/pull` 是 Ollama 原生 API，挂在**根路径**。所有原生 API 调用前必须从 base_url 剥离尾部 `/v1`（及尾斜杠）得到 root；剥离失败/格式异常时回退取 `scheme://host:port`。
3. **显存探测不能用 `Win32_VideoController.AdapterRAM`**：该字段是 32 位整数，上限 4GB——24GB 显卡也读成 4GB，会让推荐引擎整体反向。改用 §5.3 的 nvidia-smi 优先策略。
4. **设置写回单一数据源**：后端**不写** settings 表；拉取成功后由前端收到终态事件，经现有 settings API 保存（settingsStore.save），避免前后端两份设置不同步。写回目标 = 当前正在编辑的 local 档案。

## 4. 任务目标（四块，按小白动线组织）

1. **Ollama 存活检测**：打开本地档案编辑即探测，显示「✓ 已检测到 Ollama（N 个模型）/ 未检测到」。
2. **未安装引导**：未检测到时显示「打开 Ollama 下载页」按钮（系统浏览器），并给一句「装好后回到本页自动刷新」文案。
3. **硬件探测 + 模型推荐**：探测显存档位，渲染推荐模型卡片（带「推荐」标记），可点击直接拉取。
4. **一键拉取并配置**：驱动 Ollama pull，UI 流式进度，完成后自动写回 `model` 字段并提示「配置完成，可开始打标」。

## 5. 实现要点

### 5.1 服务层 `src-tauri/src/services/ollama_setup.rs`（新建，纯逻辑可单测）

```rust
pub struct OllamaStatus { pub running: bool, pub models: Vec<String> }
pub struct GpuInfo { pub name: Option<String>, pub vram_gb: Option<f32>, pub source: String } // source: nvidia-smi|unknown
pub struct ModelRec { pub name: String, pub recommended: bool, pub note: String }
pub struct PullProgress { pub model: String, pub status: String, pub total: u64, pub completed: u64, pub done: bool, pub error: Option<String> }

pub fn api_root(base_url: &str) -> String;                          // §3.2 推导，单测覆盖带/不带 /v1、尾斜杠
pub fn ping(base_url: &str) -> AppResult<OllamaStatus>;             // GET {root}/api/tags，2s 超时；连不上 → running=false 不报错
pub fn probe_gpu() -> GpuInfo;                                       // §5.3
pub fn recommend(vram_gb: Option<f32>) -> Vec<ModelRec>;            // §5.4 纯函数，单测覆盖各档位
pub fn pull<F: Fn(PullProgress)>(base_url: &str, model: &str, cancel: &Arc<AtomicBool>, progress: F) -> AppResult<()>;
                                                                      // POST {root}/api/pull {name, stream:true}，逐行读 JSON 回调
```

- pull 的流式响应按行解析 JSON（每行一个对象，字段 `status/total/completed/digest`）；`total=0` 的阶段（如 verifying sha）进度条显示不确定态。
- 网络错误/非 200 → 终态 PullProgress{error}，不 panic。

### 5.2 命令层 `src-tauri/src/commands/ollama_cmd.rs`（新建）

- `ollama_ping(base_url) -> OllamaStatus`（同步短任务，可直接执行）
- `ollama_probe_hardware() -> { gpu: GpuInfo, recommendations: Vec<ModelRec> }`（spawn_blocking，nvidia-smi 是子进程调用）
- `ollama_pull(app, base_url, model)`：async + spawn_blocking；service 回调里 `app.emit("ollama://pull-progress", p)`（模式照抄 ai_cmd.rs 的 `ai://progress`）。**不写 settings**。
- `ollama_open_download_page(app)`：Rust 侧直接调 `tauri_plugin_opener::open_url(&app, "https://ollama.com/download", None)`（插件已在 lib.rs 注册；Rust 直调无需 capabilities 条目）。
- 三个命令注册进 `lib.rs` invoke_handler。

### 5.3 硬件探测策略（修正方案 A 的 AdapterRAM 坑）

按序尝试，取第一个成功的：
1. `nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits`（2s 超时，解析 MB→GB）。
2. 失败（无 N 卡/未装驱动）→ `GpuInfo { name: None, vram_gb: None, source: "unknown" }`，**不猜测**。

不引入 sysinfo 等新依赖；不读系统内存（避免过度设计）。

### 5.4 推荐档位（模型名已修正）

| 探测结果 | 推荐 | 备选/说明 |
|---|---|---|
| vram ≥ 12GB | `qwen2.5vl:7b`（推荐） | `qwen2.5vl:3b`（更快） |
| vram 6–12GB | `qwen2.5vl:3b`（推荐） | `qwen2.5vl:7b`（显存紧、速度慢） |
| vram < 6GB | `qwen2.5vl:3b`（推荐） | 注明「显存偏紧，可能部分走 CPU」 |
| 未知（无 N 卡） | `qwen2.5vl:3b`（推荐） | 注明「未探测到显存，默认轻量档；纯 CPU 可跑但慢，批量建议插电」 |

- 文案不再出现「不满足最低要求，建议云端」的硬劝退——CPU 跑 3b 可用，给诚实预期即可；把「改用云端」放次级提示。
- 拉取前若 `ollama_ping` 的 models 已含目标模型 → 按钮文案变「已安装，直接使用」，点击=直接写回 model，不重复 pull。

### 5.5 前端

- `src/api/ollama.ts`（新建）：`pingOllama / probeOllamaHardware / pullOllamaModel / openOllamaDownloadPage / onOllamaPullProgress`（listen 封装，风格照抄 `api/ai.ts` 的 onAiProgress）。
- `src/pages/SettingsPage.tsx` 本地档案编辑区块：
  - 进入/切换 local 时：`pingOllama` 显示状态；未运行 → 下载按钮 + 「装好后点此重测」。
  - **删除 `switchKind()` 里硬编码 `llava` 预填**（model 留空，由推荐/拉取结果填入）。
  - 运行中 → `probeOllamaHardware` 渲染推荐卡片列表；每项带「拉取 / 已安装」按钮。
  - 拉取中 → ProgressBar + 阶段文案（subscribe `ollama://pull-progress`，用现有 `useTauriEvent` hook）。
  - 终态成功 → `updateProfile(当前档案, { model })` 走现有 settings 保存链路 + 提示「配置完成，可开始打标」；失败 → 显示 error 文案不静默。
- UI 一律用现有组件与 `var(--color-*)` 变量，硬编码颜色零容忍（主题兼容 R-24 已上线）。

### 5.6 兼容与边界

- **LM Studio**：无 `/api/pull`。ping 成功但判定 root 非 Ollama（`/api/version` 404 启发式）时，隐藏拉取区，仅显示「检测到本地服务，直接填模型名即可」。启发式失败不影响主流程（最坏=多显示一个拉取按钮，点击报错有文案兜底）。
- 取消拉取：首期不做，登记为机动项（pull 中断后 Ollama 支持断点续拉，重试即续传）。
- 国内拉取 registry.ollama.ai 可能慢/失败：进度条卡住超 30s 时附提示「下载缓慢？可配置代理后重试」（不做镜像，登记风险）。

## 6. 测试计划

- 单测（services/ollama_setup.rs）：`api_root` 四种输入；`recommend` 五档位；PullProgress 行解析（mock 字符串）。
- 集成测试不强制（依赖真实 Ollama 进程，与现有 ignored 测试同待遇）。
- 走查清单（入 PROGRESS）：
  1. 有 Ollama + 已装模型 → 显示「已安装，直接使用」→ 点击写回成功；
  2. 有 Ollama 未装模型 → 一键拉取 → 进度条 → 完成写回 → 打标出中文标签；
  3. 无 Ollama → 状态正确 + 下载按钮能打开浏览器，应用不崩；
  4. 云端打标 / 批量打标回归不受影响；
  5. 暗色主题下新区块显示正常。

## 7. 验收标准（三关全绿为交付门槛）

- `cargo test` 全过（128+ 项无回归 + 新增单测）；`npx tsc --noEmit` 零报错；`npm run build`（vite）通过。
- §6 走查清单逐条过。
- `docs/PROGRESS.md` 决策日志补记本阶段（含对方案 A 三处硬伤的修正结论）。

## 8. 实施顺序建议

1. 后端 services/ollama_setup.rs（api_root/ping/probe/recommend/pull）+ 单测
2. 命令层 ollama_cmd.rs + lib.rs 注册
3. 前端 api/ollama.ts + SettingsPage 状态区/推荐区
4. 拉取进度链路联调（emit → listen → 写回）
5. 三关验证 + 走查 + PROGRESS 补记

## 9. 附：对方案 A 的修正清单（评审留档）

| # | 方案 A 原文 | 问题 | 本版修正 |
|---|---|---|---|
| 1 | `qwen2.5-vl:3b` / `7b-q4` | 官方库名 `qwen2.5vl` 无连字符；`7b-q4` 非官方 tag → pull 直接失败 | 全文改 `qwen2.5vl:3b` / `qwen2.5vl:7b` |
| 2 | `GET {base_url}/api/tags` | base_url 带 `/v1`，原生 API 在根路径 → 404 | api_root() 剥离 /v1，单测覆盖 |
| 3 | Win32_VideoController AdapterRAM | 32 位上限 4GB，推荐引擎整体反向 | nvidia-smi 优先，探不到不猜测、默认 3b |
| 4 | UI 用 shadcn/ui | 项目无 shadcn，引入违反一致性 | 现有自研组件 + var(--color-*) |
| 5 | 逻辑全放 commands/ollama_setup.rs | 违反 commands→services→db 分层铁律 | services/ollama_setup.rs + 回调，command 只 emit |
| 6 | 事件名 `ollama-pull-progress` | 与既有 `xxx://progress` 风格不一致 | `ollama://pull-progress` |
| 7 | 「kind=local 请求头不带 Bearer」 | 打标主路径实际仍发空 Bearer（Ollama 容忍） | 表述修正；本任务不改 ai_cloud.rs |
| 8 | 验收仅 tsc + cargo build | 项目交付门槛是三关 + 测试无回归 | §7 三关 + 128 项回归 |
| 9 | 后端拉完直接写 settings | 前后端两数据源不同步 | 前端收终态事件后经现有 settings 链路保存 |
| 10 | vram<4 → 劝退云端 | CPU 跑 3b 实际可用 | 改诚实预期文案，云端仅次级提示 |
