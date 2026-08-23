# 方案 A3：本地模型「应用内全自动」一键部署规划书

> 定位：v2.x 增量规划（A2 的增强版）。老板 2026-08-20 两点反馈：
> ① 本地模式入口太深（藏在档案编辑表单里），要在设置页左侧**单独列一个入口**；
> ② 不要让用户自己去官网下载 Ollama，**软件内一键下载→安装→启动→拉模型→配置**全自动。
> 依赖：A2 已交付的 ollama_setup.rs（ping / probe_gpu / recommend / pull）全部复用。

---

## 1. 目标用户动线（做完后的样子）

小白用户全程不离开应用、不打开浏览器：

1. 设置页左侧点 **「本地模型」**（新增独立分组）
2. 看到一张大卡片：`未检测到本地引擎` → 点 **「一键安装 Ollama」**
3. 应用内下载安装包（进度条 + 速度 + 断点续传），下载完自动静默安装（无弹窗）
4. 安装完自动启动服务并复检 → 卡片变绿：`✓ Ollama 已就绪` + 显卡信息
5. 下方出现推荐模型（按显存，复用 A2 recommend）→ 点 **「一键拉取并配置」**（复用 A2 pull）
6. 自动建好/更新本地档案并设为激活 → 提示「完成，去打标页选素材开始」

全程只有两个按钮：装引擎、拉模型。

---

## 2. 竞品调研（别人怎么做的）

| 产品 | 做法 | 对我们的启示 |
|---|---|---|
| **AnythingLLM** | 检测到无 Ollama → 应用内下载安装包并拉起安装（用户仍要点安装向导） | 验证了「应用内下载 Ollama 安装包」是主流可行做法；我们更进一步做**静默安装** |
| **LM Studio** | 完全自包含：内置推理引擎 + 应用内模型市场一键下载 | 体验天花板，但等于自造轮子，成本过高，不取 |
| **Jan** | 打包自带推理引擎（llama.cpp），托盘常驻 + 一键下模型 | 同上，引擎自带维护成本高 |
| **Cherry Studio** | 只检测 + 给官网下载链接（≈ 我们 A2 现状） | 老板已明确否决这种半吊子体验 |
| **Open WebUI 桌面整合包** | Docker 捆绑 Ollama | 依赖 Docker，小白更劝退，不取 |

**结论**：业界务实做法 = 应用内下载官方 Ollama 安装包并自动安装（AnythingLLM 路线），模型拉取交给 Ollama 自己的 registry（A2 已实现）。我们在此基础上加静默安装 + 国内加速多源 + 独立设置入口。

---

## 3. 关键技术事实（调研核实）

### 3.1 Ollama Windows 官方分发形态（两种）

| 形态 | 内容 | 体积 | 特点 |
|---|---|---|---|
| **OllamaSetup.exe**（推荐） | Inno Setup 安装包，含 GUI 托盘 + 运行时 | ~800MB–1GB | **免管理员权限**（装到用户目录）；装完**自动后台运行并开机自启**；官方负责升级维护 |
| ollama-windows-amd64.zip | 便携版：CLI + NVIDIA/AMD GPU 库 | 解压需 ≥4GB | 官方定位「嵌入现有应用」；无自启、无托盘，生命周期全要自己管 |

**选 Setup.exe 路线**：装完自动后台运行（省掉我们管进程生命周期）、官方自升级、体积小一半。
Inno Setup 支持的静默参数：`/VERYSILENT /SUPPRESSMSGBOXES /NORESTART`（可加 `/DIR="路径"` 自定义目录，默认用户目录即可）。

### 3.2 下载地址与国内加速

- 官方主源：`https://ollama.com/download/windows`（302 到 GitHub release；国内主站比直连 GitHub 稳）
- GitHub 直链：`https://github.com/ollama/ollama/releases/latest/download/OllamaSetup.exe`
- 加速镜像：`https://gh-proxy.com/https://github.com/ollama/ollama/releases/latest/download/OllamaSetup.exe`
  （gh-proxy.com 项目已在 heif 预编译库下载中验证可用，见既有经验）
- **策略：多源候选顺序降级**（官方 → gh-proxy → GitHub 直连），单源超时/失败自动切下一个；支持 HTTP Range 断点续传；下载完做文件大小校验（官方无稳定 sha256 公布，体积校验 + 安装后 `/api/version` 复检兜底）

### 3.3 模型拉取（复用 A2，无需新开发）

- 模型走 Ollama 官方 registry（`/api/pull`），A2 已实现流式进度 + 写回配置
- 已知国内风险：registry 偶发 TLS handshake timeout → 失败提示「网络波动，点重试（Ollama 断点续传）」，不做自建镜像（无可靠官方镜像源）
- 模型默认存放 `C:\Users\<用户名>\.ollama`（可用 `OLLAMA_MODELS` 环境变量改，首期不动，文案里提示占用约 2–4.5GB）

### 3.4 安装后复检闭环

静默安装进程退出 ≠ 服务就绪。判定链：安装进程退出 → 轮询 `GET /api/version`（最长 30s，2s 间隔）→ 成功即就绪；超时则提示「已安装但服务未启动，点重试」（极少数情况需用户手动启动一次）。

---

## 4. 方案设计

### 4.1 后端（新增 services/ollama_installer.rs + 命令层）

```
services/ollama_installer.rs
├── fn detect_installed() -> bool        // 探测已装 Ollama：where ollama / 常见用户目录 / PATH
├── fn resolve_sources() -> Vec<String>  // 多源候选列表（官方/gh-proxy/GitHub）
├── fn download<F: Fn(DownloadProgress)>(dest, sources, cancel, progress)
│                                        // reqwest 流式写文件；Range 续传；单源失败切下一源
├── fn install_silent(installer_path, progress) -> AppResult<()>
│                                        // Command::new(exe).args(["/VERYSILENT","/SUPPRESSMSGBOXES","/NORESTART"])
│                                        // 等待退出码；非 0/1 视为失败（Inno Setup 1=重启挂起也算成功）
└── fn wait_ready(base_url, timeout) -> bool  // 轮询 /api/version 直到服务就绪

DownloadProgress { phase: "download"|"install"|"verify", downloaded, total, speed_bps, source_idx }
```

commands/ollama_cmd.rs 增补 3 个命令（沿用 A2 命名前缀，注册进 lib.rs）：
- `ollama_install_status()` → `{ installed, running, version, installerPath? }`（探测 + 复用 A2 ping）
- `ollama_download_install(app)` → spawn_blocking 跑 download→install→wait_ready，进度事件 `ollama://install-progress`
- 复用：`ollama_ping` / `ollama_probe_hardware` / `ollama_pull`（A2 已交付）

规范遵循：service 层不碰 AppHandle（进度走回调，command 层 emit）；DB 锁只在写设置时短暂持有（本功能**不写 settings 表**，写回仍走前端 draft→save 单一数据源）。

### 4.2 前端

**① 设置页新增独立分组「本地模型」**（GROUPS 加一项，放在「AI 打标」之后）：

整页一张向导卡片，三态：
- **未安装**：`一键安装 Ollama（约 900MB，自动下载安装并启动）` 按钮 + 下载进度条（阶段文案：下载中 x% xx MB/s → 正在安装 → 正在检测服务）
- **已安装未运行**：`启动并检测` 按钮（拉起 ollama / 复检）
- **就绪**：✓ 版本号 + 显卡/显存 + 推荐模型列表（复用 A2 卡片与「一键拉取并配置」）+ 已装模型清单
- 完成拉取后：自动确保存在本地档案（kind=local、baseUrl 默认值、model=拉取值）并置为激活档案 → 绿字提示「配置完成，去打标页开始」

**② 档案编辑表单内的 Ollama 区块保留**（A2 现状不动），供进阶用户改地址/手输模型名；两处共用同一套 store 状态（抽 hooks/useOllamaSetup.ts 避免重复逻辑）。

**③ 打标页不动**：切本地档案入口保持现状（左栏 API 配置下拉）。

### 4.3 下载产物落盘位置

安装包下载临时文件与安装器：`$APP_DATA_DIR/bagertea_ai_media_v2/ollama/OllamaSetup.exe`，安装成功后保留（供离线重装）并在「数据与缓存」分组显示占用、可清理。

---

## 5. 实施拆解

| 步骤 | 内容 | 验收 |
|---|---|---|
| A3-01 | ollama_installer.rs：detect/resolve_sources/download（多源+续传+进度回调）+ 单测（源列表降级、进度解析） | cargo test 过 |
| A3-02 | install_silent + wait_ready + 3 命令注册 + 事件 | cargo test 过；capabilities 无需新条目（无新插件） |
| A3-03 | 前端 GROUPS 加「本地模型」+ 向导卡片三态 + useOllamaSetup hook 抽取 | tsc + vite 过 |
| A3-04 | 档案编辑区与向导卡片状态打通（同一 hook），完成动线文案 | 走查 |
| A3-05 | 三关回归 + PROGRESS 决策日志 | 全套绿 |

## 6. 测试计划

1. **无 Ollama 机器**：点一键安装 → 进度条走完三阶段 → 卡片变绿 → 拉 3b 模型 → 档案自动激活（完整走查）
2. **已装 Ollama**：进页面直接显示「已就绪」，不重复下载
3. **断网/弱网**：拔线点安装 → 多源降级提示；下载中断再点 → 从断点续传
4. **安装失败注入**（改坏安装包路径）：错误提示可读，不留脏状态
5. **回归**：A2 档案编辑区检测/推荐/拉取不受影响；云端打标不受影响

## 7. 风险与取舍

| 风险 | 对策 |
|---|---|
| OllamaSetup.exe 体积 ~900MB，下载体验依赖网速 | 进度条显示速度/剩余；多源降级；断点续传 |
| 静默安装被杀毒软件拦截 | 失败提示「被安全软件拦截，请手动运行 + 打开所在文件夹」双按钮兜底 |
| 官方未公布稳定 sha256 | 体积校验 + 安装后 /api/version 功能复检代替哈希校验（诚实标注，不伪造安全承诺） |
| Inno Setup 静默参数未来变更 | 参数集中在一个常量；失败退出码有分支处理 |
| 便携版 zip 路线的诱惑 | 明确不取：生命周期/自启/托盘全要自管，维护成本 > 收益（已在 §3.1 对比） |

## 8. 不做的事（首期）

- 不做模型自建镜像/HF-mirror GGUF 自下载（维护重、官方 registry 够用）
- 不做 Ollama 版本升级管理（官方托盘自带升级）
- 不做 Linux/macOS 安装器（当前仅 Windows 平台交付；检测逻辑跨平台无害）
- 不做模型删除/管理页（Ollama 托盘/CLI 可做，应用内首期只读列表）
