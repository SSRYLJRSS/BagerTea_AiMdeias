# 茶包素材 BagerTea V2 架构静态审查报告（高见远 / Architect）

- 审查日期：2026-08-14
- 审查方式：**只读静态审查**（未修改任何文件、未运行构建/测试）
- 审查范围：`src-tauri/src/`（Rust 全量 38 文件）+ `src/`（前端 TS/TSX 全量）+ `src-tauri/tests/` + `tauri.conf.json` / `Cargo.toml` / capabilities
- 审查重点：并发/锁、边界条件、错误处理、资源、前端一致性、命令安全、数据正确性

---

## 一、总体架构评估

1. **分层与工程纪律优秀，属生产级水准**。commands（校验/转发）→ services（业务）→ db（仓储）→ utils（工具）四层清晰，页面禁止直接 invoke、统一走 `api/client.ts` 错误封装；迁移用 `PRAGMA user_version` 幂等推进；WAL + `foreign_keys=ON` + FTS 外部内容表 + 触发器维护索引，方案成熟且有测试背书（db_integration 13 项、services_integration 5 项均覆盖关键正确性）。

2. **并发模型方向正确、执行有瑕疵**。`Arc<Mutex<Connection>>` 单写连接 + 短锁即用即放是合理选择；AI 打标/导出/导入长任务均 `spawn_blocking` 且网络/文件 IO 大部分移出锁外，注释里对"锁外解码→再取锁写回"等坑有清醒认知。**但导入阶段②（托管复制 + EXIF/ffprobe 元数据提取）仍在单事务内持锁**，是大规模导入时全库假死的主要隐患（见 B01）。

3. **前端状态一致性是当前最薄弱环节**。selectionStore 与 libraryStore 的联动（筛选切换、跨页删除、全选/反选）存在残留选中与 total 计数失真风险（见 B09）；`fetchAllIds` 全量拉取完整 Asset 只为取 id（见 B18）；`patchLocal` 为死代码。

4. **命令安全整体收敛、仍有 3 处未闭环**。asset 协议从 `"**"` 收敛为"数据目录整目录 + 素材逐路径放行"，方向正确；`normalize_path`/`validate_collection`/LIKE 转义/防环均已落地。但 `ensure_absolute` 定义了从未接入（死代码）；`reveal_in_folder`/`open_data_dir`/`get_preview` 无路径校验；数据目录整目录递归放行包含 `library.db`（明文存 API key/网盘 token），属纵深防御缺口（见 B08）。

5. **测试覆盖与代码质量**。生产代码无 unwrap/expect/panic（仅 lib.rs 启动 panic 合理）；`let _ =` 静默忽略集中在删除/事件上报等"非关键"路径，但其中 2 处掩盖了真实失败（B03/B12）。缓存 LRU 清理代码写好了却从未接入调用（B05），说明存在"写完未接线"的死代码风险。

---

## 二、静态 Bug 候选清单

### 2.1 并发 / 锁（P 类最高）

| 编号 | 位置 | 问题 | 触发条件 | 严重度 | 复现建议 |
|---|---|---|---|---|---|
| B01 | `services/importer.rs:229-273`（阶段②单事务） | **导入长持锁**：`db.lock()` + `unchecked_transaction` 内逐文件执行 `stage_file`（`fs::copy` 整文件复制）、`image_dimensions`（读文件头）、`exif_meta::extract`（打开文件读 EXIF）、`video::probe`（**起 ffprobe 子进程**）。锁持时间 ≈ 全部文件的复制+元数据时间之和，期间 list_assets/get_thumbnail/save_settings 等一切 DB 命令全部排队，应用整体假死 | 配置总库（托管模式）导入大量/大文件，或导入含视频的文件（每视频 ffprobe 子进程 100ms+） | **P1** | 拖 500 个视频进库（配置总库），在导入同时点击「素材库」页：列表刷新将长时间无响应；对比修复后应无感 |
| B02 | `commands/assets_cmd.rs:45-77` | `delete_assets` 是**同步命令在主线程执行**：阶段二锁外逐个 `fs::remove_file` + 阶段四逐个 `thumbs.delete_for_asset`（每 id 2 次 remove_file + 1 次 read_dir），全部同步文件 IO | 全选 3 万素材删除（尤其 delete_file 策略） | **P1** | Ctrl+A 全选 → 删除（仅移出库）→ 观察主窗口在删除期间不可交互/白屏；建议改 async + spawn_blocking |
| B11 | `commands/ai_cmd.rs:94-99`、`commands/export_cmd.rs:73-79` | 取消注册表 `if let Ok(m) = state.ai_cancel.lock()` 锁中毒被**静默吞掉**：registry Mutex 中毒后取消标志永远无法设置，用户点「取消」无效且无任何提示 | 持有 registry 锁的线程 panic（低概率，如 AI 任务线程被强杀） | **P2** | 单测注入 poison（`Mutex::poison` 后调用 `cancel_export`）→ 返回值仍 Ok(()) 但标志未置位 |
| B12 | `commands/ai_cmd.rs:83`、`commands/export_cmd.rs:57` | 任务收尾 `registry.lock().ok().map(...)` 用 `.ok()` 忽略中毒：任务完成后 cancel flag 泄漏在 HashMap（内存增长），且后续同 id 任务 insert 失败被吞 | 同上；或高并发多次启动/取消任务 | **P2** | 连续创建+取消 10 个导出任务后检查 registry 大小（应清空）；ps：当前无观测入口，需加日志 |
| B13 | `services/ai_cloud.rs:281-284,309-320` | AI 打标取消粒度为"每张之间"，单张 `request_tags` 最长 60s（client timeout）内**取消不可中断** | 打标中网络慢/服务商超时，用户点取消需等当前张完成 | **P2** | 打标 1 张大图（构造慢响应服务）→ 点取消 → 观察需等待当前请求超时 |
| B14 | `services/importer.rs:280-298` | 导入阶段③占位图并行生成**不检查 cancel**：用户取消后，已入库素材的占位图仍全部生成（几百上千张解码+写盘） | 导入 1000 张中途取消 | **P2** | 导入 1000 张 → 进度到 20% 取消 → 观察取消后仍持续生成缩略图事件 |

### 2.2 边界条件

| 编号 | 位置 | 问题 | 触发条件 | 严重度 | 复现建议 |
|---|---|---|---|---|---|
| B05 | `services/thumbnail.rs:112-136`（`cleanup_lru`） | **高清缩略图 LRU 清理从未被调用**（grep 全库仅定义处出现）。设置 `thumbnail_cache_mb=2048` 完全无效，hd 目录无限增长，长期运行磁盘失控 | 浏览大量素材生成 hd 缩略图，数周后数据目录膨胀 | **P1** | 设置页把缓存上限调为 1MB → 浏览 200 张 → 检查 `data_dir/thumbnails/hd` 目录大小不回落 |
| B06 | `services/importer.rs:179-186`、`services/export_local.rs:105-111` | 同名冲突循环 `for i in 1..1000` **耗尽后回退到已存在路径**，`fs::copy` 静默覆盖已有文件（导入托管复制/导出 copy 均会覆盖目标，数据丢失） | 目标目录已存在 ≥1000 个同名文件（如 `IMG_001(1).jpg` ~ `IMG_001(999).jpg`）后再导入/导出第 1001 个 | **P1** | 预置 1000 个 `x(1)..x(999)` 同名文件 → 导出第 1001 个 → 检查 `x.jpg` 被覆盖；建议冲突超限时报错而非覆盖 |
| B07 | `commands/import_cmd.rs:51-53` + `services/importer.rs:30-45` | `inspect_import` 是**同步命令**，`collect_files` 递归 WalkDir + 逐文件 `metadata()` 在主线程执行；无文件数/深度上限 | 选择含数万文件的大目录 → 主线程阻塞数秒~数十秒，UI 无响应 | **P1** | 拖入一个 5 万文件的目录 → 立即观察窗口不可交互；建议改 async/spawn_blocking 或加扫描上限 |
| B09 | `stores/libraryStore.ts:38-41` + `stores/selectionStore.ts` | **筛选切换不清空 selected**：`setFilter` 只 refresh 不清选中。跨筛选（如全部→视频）后 selected 仍含不可见 id，后续打标/导出/删除**作用于不可见素材**（用户以为只操作可见项）；删除后 `removeLocal` 用 `total - ids.length`（`libraryStore.ts:102`）对跨筛选 id 多减，total 显示错乱 | 全选若干素材 → 切「视频」筛选 → 点「AI 打标」（实际把全部选中都带过去） | **P1** | ① 全选 5 张（含 3 图 2 视频）→ 切「视频」→ 顶栏仍显示已选 5 项且打标带 5 张；② 再删除 → 库总数跳动 |
| B10 | `db/search.rs:23-32` | FTS 查询将整个关键词包为**短语**（`"..."`），只转义 `"`（`replace('"','""')`）；`*`/`^`/`-`/`(`/`)` 等在短语内按字面处理，但**纯符号输入**（如 `"""`、`()`）可致 FTS5 语法错误；超长输入（如粘贴 10 万字）生成超大 phrase 拖慢查询 | 搜索框粘贴 `"""` 或超长文本 | **P2** | 搜索框输入 `"""`（3 个双引号）→ 观察搜索报错/异常；建议对 FTS 路径加长度上限与失败兜底（降级 LIKE） |
| B17 | `db/assets.rs:148-156,159-198` | 搜索命中后把**全部 id 拼进 IN 列表**（`a.id IN (1,2,3,...)`），FTS 命中 3 万素材时生成 ~200KB SQL，且每次 `total` 与分页查询重复拼接；SQLite 变量/解析开销大 | 搜索常见词命中全库大部分素材 | **P2** | 导入 2 万素材 → 搜索「a」类高频词 → 观察 list_assets 耗时明显上升 |
| B18 | `stores/libraryStore.ts:85-96` | `fetchAllIds` 调 `listAssets` 拉取**全量完整 Asset 对象（含 tags 聚合）**只为取 id，limit=total；3 万素材一次 IPC + JSON 解析浪费数 MB 内存/带宽 | Ctrl+A 全选 3 万素材 | **P2** | Ctrl+A 后 DevTools 观察 IPC payload 大小；建议后端加 ids-only 命令（memory 2026-08-13 已提及） |
| B19 | `db/assets.rs:178-181` | `limit` 仅 `max(1)` 保底、无上限；前端可传任意大 limit，恶意/异常调用一次拉全库 | 前端异常或恶意传 limit=1e9 | **P2** | invoke `list_assets` 传 `{limit: 100000000}` → 观察内存/耗时；建议限 `limit≤1000` 并服务端拒绝 |
| B27 | `commands/thumbnail_cmd.rs:50-53` + `components/library/Thumbnail.tsx:45-54` | `clear_thumbnail_cache(kind="placeholder")` 删占位图文件但**不回写 DB**，`placeholder_path` 仍指向已删文件；Thumbnail 组件对 placeholder `<img>` **无 onError 回退** → 破图显示（hd 生成只在"无 hdUrl"时触发，不检查占位图 404） | 调 clear_thumbnail_cache("placeholder") 后刷新列表 | **P2** | 清占位图缓存 → 回素材库 → 观察卡片破图；建议 img onError 时回退触发 hd/通用占位 |

### 2.3 错误处理

| 编号 | 位置 | 问题 | 触发条件 | 严重度 | 复现建议 |
|---|---|---|---|---|---|
| B03 | `commands/assets_cmd.rs:64-66` | delete_file 策略磁盘删除 `let _ = std::fs::remove_file(p)` **静默忽略失败**，但阶段三照样删库记录 → 库记录已删、磁盘文件残留（"假删除"），用户以为已删实际文件还在 | 文件被其他程序占用/只读/权限不足（如正在预览器中打开）时删除 | **P1** | 用占用工具锁定某文件 → 删除该素材（delete_file）→ 库中已无记录但文件仍在磁盘；建议收集失败列表返回或回滚 |
| B20 | `db/ai.rs:228-244`（`confirm_all_pending`） | 批量确认无外层事务：逐条 `confirm_suggestion`（各自开事务），**中途失败部分提交**，批次状态部分确认/部分 pending | 批量确认中某条标签写入失败（DB 错误/磁盘满） | **P2** | 在 confirm_all 循环中注入失败（如先删 assets 行触发 FK 错误）→ 观察部分确认已提交 |
| B22 | `db/ai.rs:27-43` + `db/tags.rs:142-163` | `categorized_tag_ids` 逐标签 `find_or_create_root/child`（每标签 1-2 次查询），批量确认 500 条×5 标签 ≈ 5000+ 次查询，且每次 `find_or_create` 先 SELECT 后 INSERT；虽在事务内但**N+1 慢路径** | AI 批量确认大批次（500 张） | **P2** | 确认 500 张批次 → 观察耗时；建议批量 upsert 或先查全量标签树再内存匹配 |
| B28 | `stores/settingsStore.ts:23-25` | `load()` catch 后 `set({loaded:true})` **静默吞错**：后端异常时用户看到默认设置页，保存后可能覆盖真实配置 | DB 设置读取异常（损坏 JSON 已被后端默认值兜底，此路径多为 IPC 层错误） | **P2** | 断连/模拟 invoke 失败 → 设置页显示默认值且无任何提示 |
| B29 | `error.rs:7-17,34-47` | `AppError::Db/Io` 序列化直出 `to_string()`，**SQL 语句、文件路径、内部细节随错误消息返回前端** | 任意 DB/IO 错误（如 UNIQUE 冲突） | P3 | 故意触发 UNIQUE 冲突 → 前端错误消息含 SQL 片段；本地应用风险低，建议日志保留、对外消息脱敏 |

### 2.4 资源

| 编号 | 位置 | 问题 | 触发条件 | 严重度 | 复现建议 |
|---|---|---|---|---|---|
| B04 | `services/export_local.rs:56-60,115-124` + `commands/export_cmd.rs` | **导出「移动」模式不更新库**：`move_file` 把原文件移走，但 `assets.file_path` 仍指向旧路径 → 库记录指向不存在的文件，之后缩略图重建/预览/AI 打标全部失败；跨盘降级 copy+remove 中 remove 失败还会残留双份 | 选中素材 → 导出 → 模式选「移动到目标目录」 | **P1** | 导出 move 一个素材 → 回素材库点击它 → 预览 404/缩略图失败；建议 move 后同步 `UPDATE assets SET file_path` 或移除记录 |
| B15 | `services/importer.rs:233-235,276-278` | 导入取消后**已写库记录不回滚**（阶段②循环中逐条已 commit 的部分保留），result 仅 errors=["用户取消"]，UI 不提示"已部分导入 N 条" | 导入中途取消 | **P2** | 导入 1000 张到 50% 取消 → 库中残留 ~500 条且无提示；建议明确"部分导入"语义或整批回滚 |
| B16 | `db/asset_tags.rs:9-42` + `db/migrations.rs:97-117` | 批量挂/删标签 `N×M` 循环逐行触发 `trg_at_ai/ad`：**每行 INSERT/DELETE 都全量重算该 asset 的 tag_names**（group_concat + cjk_bigram），500 素材×5 标签 = 2500 次触发器 × 每次子查询 → O(n²) | 批量挂 5 个标签到 500 素材 | **P2** | 批量挂标签 500 张 → 观察耗时（建议触发器节流/改为应用层批量重算） |
| B34 | `commands/import_cmd.rs:25-28` | `import_cancel` 是**全局单标志**：`import_files` 入口先 `store(false)` 复位。若未来支持并发导入（当前 UI 的 running 防了），后发起者会复位前者的取消失效 | 目前仅代码级风险；与 B02 同类"全局状态"隐患 | P3 | 单测并发两个 import_files（绕过 UI）→ 第二个复位第一个的 cancel |

### 2.5 前端一致性

| 编号 | 位置 | 问题 | 触发条件 | 严重度 | 复现建议 |
|---|---|---|---|---|---|
| B09 | 见 2.2 | 筛选/删除后 selected 残留与 total 失真（含"跨页删除后打标页带已删 id → `get_asset_urls` 整体报错"链路：`assets_cmd.rs:86-93` 任一 id 不存在即整体 Err） | 见 2.2；另：素材在打标页被删后回库页，选中集含已删 id，复制路径失败 | **P1** | 见 2.2 复现步骤；建议：① setFilter 时 clear；② 删除后统一 `clear()`；③ get_asset_urls 改为部分成功 |
| B36 | `components/library/AssetGrid.tsx:58-61` | loadMore 用 `offset: items.length` 做偏移分页，期间若发生删除（removeLocal 只减当前 items）→ 新页 offset 与新库位置错位，**跳页/重复条目**（单用户低概率但存在） | loadMore 加载中另一处删除素材 | P3 | 滚动加载时删除若干素材再继续滚动 → 观察重复/遗漏；建议改为 keyset 分页 |
| B33 | `components/ai/Workbench.tsx:152-161` | 快捷键 `useEffect` **无依赖数组**，每次渲染重绑 keydown 监听（含 cleanup）——性能小问题，且闭包捕获最新状态（本意如此） | 正常使用打标页 | P3 | 无功能影响；建议补依赖数组减少重绑 |

### 2.6 命令安全

| 编号 | 位置 | 问题 | 触发条件 | 严重度 | 复现建议 |
|---|---|---|---|---|---|
| B08 | `lib.rs:38-41` | **asset 协议整目录递归放行 data_dir**（`allow_directory(&scope_dir, true)`）：data_dir 内含 `library.db`（**明文存 API key、网盘 token**）、previews/（待入库照片小图缓存）。与"素材原文件逐路径放行"的收敛策略矛盾，属纵深防御缺口（当前 CSP script-src 'self' 降低可利用性，但任何未来 XSS/插件权限扩大都将直接暴露库文件） | webview 被注入脚本（未来场景）/CSP 调整后 | **P1** | 检查 `convertFileSrc("$DATA_DIR/library.db")` 能否被 img 请求；建议仅放行 `thumbnails/` 与 `previews/` 子目录，DB 不放行 |
| B24 | `commands/assets_cmd.rs:97-103`（reveal_in_folder）、`commands/settings_cmd.rs:27-32`（open_data_dir）、`commands/thumbnail_cmd.rs:36-47`（get_preview） | 路径类命令**无来源校验**：`reveal_in_folder(path)` 接受任意字符串（前端只传库内路径，但命令本身可被任意调用方传入系统目录）；`get_preview(path)` 可读取任意本地文件生成预览 | 受损前端/devtools 手工 invoke | **P2** | 手工 invoke `reveal_in_folder { path: "C:/Windows" }` → 资源管理器打开系统目录；建议服务端校验路径属于已入库文件/数据目录 |
| B25 | `commands/tags_cmd.rs:19-26` | `create_tag` 仅校验非空，**无长度/字符上限**：超长标签（如 10 万字符）入库后树渲染/搜索异常 | 手工 invoke 或粘贴超长文本 | **P2** | invoke `create_tag { name: "x".repeat(100000) }` → 观察标签树卡顿；建议限长（如 ≤64 字符） |
| B26 | `commands/assets_cmd.rs:45-77` | `delete_assets` ids 无数量上限，IN 列表可超大（与 B19 同类） | 手工 invoke 传 10 万 id | P3 | 同 B19 建议服务端上限 |

### 2.7 数据正确性

| 编号 | 位置 | 问题 | 触发条件 | 严重度 | 复现建议 |
|---|---|---|---|---|---|
| B20(补充) | `db/migrations.rs:70-117` | 删除父标签 CASCADE 删除大量子标签+关联时**逐行触发** `trg_at_ad` → 每行全量重算 fts_content（O(n²)）；功能正确（测试 ⑦⑧ 已覆盖）但大标签树删除慢 | 删除挂载 1000+ 素材的父标签 | P3 | 删除大父标签 → 观察耗时；可接受，记录 |
| B37 | `db/migrations.rs:176-183` | SCHEMA_V2 `ALTER TABLE` 无 `IF NOT EXISTS`：若 v1→v2 中途崩溃（user_version 未提交），重启后 v2 重复执行 ALTER 报错 → **应用无法启动**（init panic） | 迁移中途断电/崩溃 | P2 | 模拟：手动把 user_version 置 1 但已执行 V2 的部分 ALTER → 重启 → panic；建议 V2 改用 `ADD COLUMN` 容错或迁移加事务 |
| B38 | `services/importer.rs:246-254` + `utils/hash.rs:12-26` | hash 去重取 **sha256 前 16 字节（128bit）**：碰撞概率极低（~2⁻⁶⁴ 对），但"路径唯一 + hash 去重"双保险中路径比较仅小写盘符（`utils/path.rs:4-17`），路径中段大小写差异（`D:/Photos` vs `d:/photos`）绕过 UNIQUE → 同一文件双记录（hash 可兜底但若文件已外部改名则 hash 不同，双记录成立） | 同一文件经不同大小写路径导入 | P3 | 导入 `D:/Photos/a.jpg` 与 `d:/photos/a.jpg`（目录真实存在大小写变体）→ 观察两条记录；建议 normalize 时统一大小写或比较 canonicalize |
| B39 | `db/tags.rs:94-109`（create） | 防环仅在 `update` 时校验（`tags.rs:120-131`），`create` 时 parent_id 指向自身不存在（id 尚新），FK 会拦截不存在的父；但**同事务内创建父子再互挂**无此路径，实际无环风险 | 无直接触发；记录确认 | P3 | 已由 `tag_reparent_cycle_rejected` 测试覆盖 update 路径；create 无需额外处理 |

---

## 三、风险与改进建议（非 Bug 的隐患）

### 3.1 高优先级（建议尽快处理）

1. **导入管线拆锁（对应 B01）**：将阶段②拆为「锁外托管复制/元数据提取 → 收集结果 → 短锁事务批量写库」。元数据提取（EXIF/ffprobe）可并行（rayon），与 hash 阶段合并，只在写库时短锁。这是当前性能头号瓶颈，也是唯一能让"导入中全库假死"复现的路径。

2. **delete_assets 改为 async + spawn_blocking（对应 B02）**，并将缩略图清理下沉到工作线程；同时把磁盘删除失败收集成 `Vec<String>` 返回（对应 B03），由前端提示"N 个文件删除失败"。

3. **导出 move 同步库记录（对应 B04）**：move 成功后 `UPDATE assets SET file_path = <新路径>`（或删除记录并提示重新入库）；move 失败（copy 成功 remove 失败）应回滚/提示。

4. **接入 LRU 清理（对应 B05）**：在 `get_or_create_hd` 或 `list_assets` 调用点低频触发 `cleanup_lru(settings.thumbnail_cache_mb)`（如每 100 次生成或启动时），并确保占位层不受影响。

### 3.2 安全与配置

5. **asset 协议 scope 进一步收敛（对应 B08）**：只 `allow_directory` 放行 `thumbnails/` 与 `previews/` 子目录；`library.db`、`settings` 等敏感文件不放行。同时考虑 API key 加密存储（当前明文入库，见 `db/cloud.rs` 与 `db/settings.rs`——网盘 token/cookie 同样明文）。

6. **`ensure_absolute` 死代码落地（`utils/path.rs:20-23`）**：在所有路径类命令入口（reveal_in_folder、get_preview、export dest_dir、import paths）校验绝对路径，拒绝相对路径/UNC 以外形式；export `dest_dir` 建议校验为用户选择的目录且非库数据目录。

7. **CSP 再核对**：当前 `connect-src` 不含 `asset:`，img/media 才允许 asset——已能挡住 fetch 直读 DB，保持此约束并在未来插件接入时复查。

### 3.3 性能与可维护性

8. **搜索 IN 列表改造（对应 B17）**：FTS 命中量大时改为「临时表 join」或「分页后按页取 id 子集」；至少限制单次 IN 长度（如 5000）并分片。

9. **`fetchAllIds` 加 ids-only 命令（对应 B18）**：后端新增 `SELECT id FROM assets WHERE ...` 轻量命令，全选/反选不再拉全量 Asset。

10. **触发器批量写入节流（对应 B16）**：批量挂标签场景建议改为应用层先算好 tag_names 再直接 UPDATE fts_content（或接受当前 O(n²) 但记录性能基线）。

11. **死代码清理**：`patchLocal`（libraryStore.ts:106-109）未使用；`utils/mime.rs` 与 `db/cloud.rs` 的 M2 代码属预留——建议标注或移除，避免误导。

### 3.4 测试与验收建议（供 QA）

12. 建议为以下路径补测试（当前测试未覆盖）：① 导入取消的部分提交语义；② delete_file 磁盘删除失败的处理；③ 导出 move 后库路径一致性；④ LRU 清理接入后的行为；⑤ `inspect_import` 大目录性能基线（perf_probe 可扩展）；⑥ FTS 特殊字符（`"""`、超长输入）容错。

---

## 附：统计摘要

- 共记录 **26 项**（含补充行）：**P1 × 9**（B01 B02 B03 B04 B05 B06 B07 B08 B09），**P2 × 14**，**P3 × 7**（去重后计数）
- 重复出现的系统性问题：① 锁外文件 IO 与同步命令主线程执行（B01/B02/B07）；② 静默吞错（B03/B11/B12/B28）；③ 前端选中/总数一致性（B09）；④ 死代码/未接线（B05/B18/patchLocal/ensure_absolute）
- 优点确认：分层清晰、迁移幂等、FTS 触发器正确性有测试背书、短锁设计意识强、错误模型统一、前端虚拟滚动与多选交互完整
