# 第二批 21 项隐患修复 — QA 独立回归验证报告

- 报告编号：qa-regression-batch2-2026-08-14
- 验证人：严过关（QA Engineer）
- 日期：2026-08-14
- 范围：第二批 19 项修复（P1×7 + P2×11 + P3×1）独立 fresh-eyes 回归
- 输入：修复计划 `fix-plan-batch2-2026-08-14.md`、第一批 QA 回归 `qa_edge_tests.rs`（45 用例）、19 个改动源文件
- **最终状态：✅ 全量通过（Round 2 回归完成，BUG-QA-1 已修复验证）**

---

## 1. 测试结果总览

### 1.1 全量测试

| 测试套件 | 通过 | 失败 | 忽略 | 备注 |
|---------|------|------|------|------|
| src 单元测试（lib.rs） | 33 | 0 | 0 | |
| db_integration | 13 | 0 | 0 | |
| qa_edge_tests | **53** | 0 | 0 | 45 原有 + **8 新增** |
| services_integration | **9** | 0 | 0 | 5 原有 + **4 新增** |
| dev_maintenance | 0 | 0 | 1 | 手动维护操作 |
| perf_probe | 0 | 0 | 2 | 手动性能探针 |
| **合计** | **108** | **0** | **3** | **全绿** |

> 原有 96 用例全绿 + 新增 12 边界用例全绿 = **108/108 通过**。

### 1.2 前端验证

| 检查项 | 结果 |
|--------|------|
| `npm run typecheck`（tsc --noEmit） | ✅ 通过 |
| `npm run build`（Vite 生产构建） | ✅ 通过（90 模块转换，CSS 29KB + JS 320KB） |

> 注：首次 build 因 Vite `emptyDir` 调用环境 safe-delete shim 失败（非代码问题），`--emptyOutDir false` 重试成功。

### 1.3 路由决策

**Round 1**：Send To: Engineer — 发现 1 个源码 Bug（B06b：unique_dest 失败时任务状态未更新为 failed）。

**Round 2**（工程师修复后独立验证）：**Send To: NoOne — 全部通过。** BUG-QA-1 已修复并验证，108/108 测试全绿。

---

## 2. 新增边界测试（12 用例）

### qa_edge_tests.rs（+8）

| 用例 | 覆盖项 | 验证内容 | 结果 |
|------|--------|---------|------|
| `b19_list_limit_hard_cap_1000` | B19 | 插入 1001 条，limit=999999 → 返回 ≤1000 | ✅ |
| `b19_list_ids_capped_at_100000` | B19 | list_ids 上限 100000，5 条全返回 | ✅ |
| `b37_v2_crash_recovery_all_columns_present` | B37 | version 回退到 1（列已全在）→ 重跑 migrate 不 panic，version→3 | ✅ |
| `b37_v2_partial_columns_recovery` | B37 | DROP 3 列 + version=1 → migrate 补回缺失列 | ✅ |
| `b37_fresh_install_all_v2_columns` | B37 | 全新安装 → 6 个 V2 列全部存在 | ✅ |
| `b20_confirm_all_pending_atomic_success` | B20 | 3 条建议批量确认 → 全 confirmed + asset_tags 写入 | ✅ |
| `b20_confirm_all_pending_no_pending_is_noop` | B20 | 无 pending 时 confirm_all → 无操作不报错 | ✅ |
| `b27_clear_all_thumbnail_paths_writes_null` | B27 | clear_all_placeholder/hd_paths → DB 字段为 NULL | ✅ |

### services_integration.rs（+4）

| 用例 | 覆盖项 | 验证内容 | 结果 |
|------|--------|---------|------|
| `b04_export_move_updates_db_file_path` | B04 | move 后 file_path 指向新目录、源文件已移走、任务 done | ✅ |
| `b04_export_move_same_name_suffix_updates_db` | B04 | 同名冲突加 (1) 后缀 → file_name 同步更新 | ✅ |
| `b01_import_cancel_zero_imported` | B01/B15 | cancel=true → 0 导入 + "用户取消"提示 + 库无记录 + 可重导 | ✅ |
| `b06b_export_same_name_exhaustion_errors` | B06b | 999 同名占位 → 返回 Err "同名文件过多"（⚠ 附源码 Bug 标记） | ✅ |

---

## 3. 逐项代码审查结论（fresh eyes）

### 🔴 高风险（核心数据路径）

#### B01 导入拆锁 — ✅ 通过

**文件**：`services/importer.rs`

审查结论：
- ✅ ②a（锁外 rayon 并行）+ ②b（短锁批量写库）拆分彻底：②a 做 precheck 短锁 + 托管复制 + 元数据提取（`extract_meta`），②b 纯 INSERT/UPDATE（`write_one`），无文件 IO
- ✅ `Processed` 结构携带全部数据（staged/hash/mime_type/norm/file_name/ext/file_size/modified_at/meta），②b 无需再访问文件
- ✅ cancel 在 ②a `par_iter.map` 内首行检查（返回 `Failed("用户取消")`），③ 同理
- ✅ 进度上报用 `AtomicI64 proc_done`，在 ②a 慢阶段上报
- ✅ UNIQUE 约束兜底 TOCTOU：②b `write_one` 用 `match` 逐条处理，单条 INSERT 失败计入 `result.failed` 不中断整批
- ✅ `extract_meta` / `write_meta` / `write_one` 拆分正确，元数据提取（image_dimensions/EXIF/ffprobe）在锁外

验证测试：`b01_import_cancel_zero_imported` ✅

#### B02+B03 delete 异步化 + 假删除修复 — ✅ 通过

**文件**：`commands/assets_cmd.rs`

审查结论：
- ✅ `delete_assets` 改 `async` + `spawn_blocking`，文件 IO 下沉工作线程
- ✅ 返回 `DeleteResult { deleted, failed_files }`，前端 `DeleteDialog.tsx` 适配（camelCase `failedFiles`）
- ✅ 四阶段分离：① 短锁收集路径 → ② 锁外删磁盘 + `failed_set: HashSet` → ③ 短锁只删成功的 → ④ 缩略图清理
- ✅ delete_file 策略下磁盘删除失败的 id **不从库删**（消除假删除）
- ✅ 前端 `DeleteDialog.tsx`：`successIds = ids.filter(!failedFiles)`，仅移除成功的；失败时显示错误不关弹窗

> 次要 UX 观察（非 Bug）：`clear()` 在删除后无条件调用，若存在失败文件则选中集已被清空，用户无法从同一弹窗直接重试。数据正确性不受影响（失败 id 仍在库）。

#### B04 导出 move 同步库 — ✅ 通过

**文件**：`services/export_local.rs`、`db/assets.rs`

审查结论：
- ✅ move 成功后 `UPDATE assets SET file_path, file_name`（`update_file_path_and_name`），unique_dest 加后缀时 file_name 同步
- ✅ UPDATE 失败不用 `?`（会跳过 finish_task），而是作为 `r=Err` 走 `finish_task("failed")` 路径 — **工程师用 match 替代 ? 的偏离合理**
- ✅ `move_file` 跨盘降级 copy+remove，remove 失败记日志不阻塞
- ✅ move 失败 → `finish_task("failed")` + 返回 Err

验证测试：`b04_export_move_updates_db_file_path`、`b04_export_move_same_name_suffix_updates_db` ✅

#### B37 V2 ALTER 容错 — ✅ 通过

**文件**：`db/migrations.rs`

审查结论：
- ✅ `SCHEMA_V2_COLUMNS` 常量数组 + `migrate_v2` 逐列 `PRAGMA table_info` 检查再 ALTER
- ✅ 幂等可重入：已存在列跳过，不存在列添加
- ✅ 三种场景全覆盖：全新安装 / 已升级（version≥2 跳过）/ 中途崩溃（version=1 + 部分列）
- ✅ `migrate` 中 `if version < 2 { migrate_v2(); set version=2 }` 逻辑正确

验证测试：`b37_v2_crash_recovery_all_columns_present`、`b37_v2_partial_columns_recovery`、`b37_fresh_install_all_v2_columns` ✅

### 🟠 中风险

#### B05 LRU 接线 — ✅ 通过

**文件**：`services/thumbnail.rs`、`lib.rs`

审查结论：
- ✅ 启动清理：`lib.rs setup` 读 settings（短锁）→ `ThumbnailService::cleanup_lru`（锁外）
- ✅ 节流触发：`thumbnail.rs get_or_create_hd` 内 `HD_GEN_COUNT: AtomicU64`，每 100 次触发一次 cleanup_lru
- ✅ 节流逻辑在锁内 fetch_add + 读 settings，cleanup_lru 在锁外执行（减少锁持有时间）
- ✅ `.manage(AppState)` 在 `.setup` 之前，`app.state::<AppState>()` 可用

#### B08 scope 收敛 — ✅ 通过

**文件**：`lib.rs`

审查结论：
- ✅ 仅放行 `thumbnails/`（递归覆盖 placeholder+hd）+ `previews/`，不再放行 `data_dir` 根（含 library.db）
- ✅ 素材原文件由 `list/get/get_asset_urls` 中 `allow_asset`（`allow_file`）逐路径放行

> 次要观察（非 Bug）：setup 中 `allow_directory(thumbnails)` 在 `ThumbnailService::new` 之前调用；首装时目录可能尚未创建。但 Tauri scope 按路径前缀注册（不依赖目录存在），且 ThumbnailService::new 在首次缩略图操作时创建目录，不影响功能。

#### B09 筛选清选中 — ✅ 通过

**文件**：`stores/libraryStore.ts`、`selectionStore.ts`、`commands/assets_cmd.rs`

审查结论：
- ✅ `setFilter` 调 `useSelectionStore.getState().clear()`，单向依赖无循环
- ✅ `removeLocal` 改用 `removedInView`（只减当前视图内实际移除数）
- ✅ `get_asset_urls` 改部分成功（跳过不存在 id，不整体 Err）

#### B20 批量确认原子 — ✅ 通过

**文件**：`db/ai.rs`

审查结论：
- ✅ `confirm_suggestion_inner`（不开事务）+ `confirm_suggestion`（开事务调 inner）拆分正确
- ✅ `confirm_all_pending` 外层单事务包裹，部分失败整批回滚
- ✅ 与 `asset_tags::assign / assign_inner` 模式一致

验证测试：`b20_confirm_all_pending_atomic_success`、`b20_confirm_all_pending_no_pending_is_noop` ✅

#### B25 tag 限长 — ✅ 通过（代码审查）

**文件**：`commands/tags_cmd.rs`

审查结论：
- ✅ `create_tag`：trim → 空检查 → `chars().count() > 64` 拒绝 → `chars().any(is_control)` 拒绝
- ✅ `update_tag` name 分支同样校验
- 注：校验在 command 层（需 Tauri State），无法在单元测试中直接调用；底层 `tags::create` 不含校验。代码审查确认逻辑正确。

#### B06 同名报错 — ⚠ 通过（含 1 个源码 Bug）

**文件**：`services/importer.rs`（B06a）、`services/export_local.rs`（B06b）

审查结论：
- ✅ B06a `stage_file`：循环 1..1000，i==999 时返回 Err（不回退覆盖）
- ✅ B06b `unique_dest`：循环 1..1000 耗尽返回 Err（不回退覆盖）
- ❌ **源码 Bug**：B06b `unique_dest` 失败时 `export_local.rs:54` 的 `?` 直接传播错误，**跳过了 line 88 的 `finish_task("failed")` 逻辑**，任务停留在 "running" 状态。详见 §4。

> 边界观察（非 Bug）：循环 1..1000（1-999）在 999 个后缀槽全满时报错，而非尝试第 1000 个。stage_file 与 unique_dest 行为一致。极端场景（999 同名文件），不影响"不静默覆盖"的核心目标。

#### B07 inspect 异步 — ✅ 通过

**文件**：`commands/import_cmd.rs`

审查结论：
- ✅ `inspect_import` 改 `async` + `spawn_blocking`，返回 `AppResult<ImportPlan>`

#### B14/B15 导入取消 — ✅ 通过

**文件**：`services/importer.rs`

审查结论：
- ✅ B14：③ `par_iter.map` 内检查 cancel，取消返回空 PathBuf，回写时跳过
- ✅ B15：②b 后 cancel 检查推送"用户取消（已导入 N 条，重复 M 条）"；③ 后推送"部分占位图待下次浏览时补生成"

验证测试：`b01_import_cancel_zero_imported` ✅

#### B11/B12 cancel 加固 — ✅ 通过

**文件**：`commands/ai_cmd.rs`、`commands/export_cmd.rs`

审查结论：
- ✅ B11：`ai_cancel_batch` / `cancel_export` 用 `.lock().map_err(...)` 替代 `.ok()`，锁中毒返回 Err
- ✅ B12：收尾 `match registry.lock() { Ok → remove, Err → tracing::error! }` 替代 `.ok().map()`

#### B19 limit 上限 — ✅ 通过

**文件**：`db/assets.rs`

审查结论：
- ✅ `list`：`filter.limit.max(1).min(1000)`
- ✅ `list_ids`：`LIMIT 100000`

验证测试：`b19_list_limit_hard_cap_1000`（1001 条 → 返回 1000）、`b19_list_ids_capped_at_100000` ✅

#### B24 路径校验 — ✅ 通过

**文件**：`commands/assets_cmd.rs`、`commands/thumbnail_cmd.rs`

审查结论：
- ✅ `reveal_in_folder`：`normalize_path` + `find_by_path` 校验路径属于已入库素材
- ✅ `get_preview`：`ensure_absolute` + `asset_type_from_ext` 校验
- ✅ `find_by_path` 复用（B24 reveal 与 B01 precheck 共用）— 工程师偏离合理

#### B27 Thumbnail onError + clear 回写 — ✅ 通过

**文件**：`commands/thumbnail_cmd.rs`、`db/assets.rs`、`Thumbnail.tsx`

审查结论：
- ✅ `clear_thumbnail_cache`：删文件后回写 `clear_all_placeholder_paths` / `clear_all_hd_thumbnail_paths`（NULL）
- ✅ `Thumbnail.tsx`：`placeholderFailed` state + `onError` 回退到 pulse + 触发 hd 生成
- ✅ 新增 `clear_all_placeholder_paths` / `clear_all_hd_thumbnail_paths` db 函数 — 工程师偏离合理

验证测试：`b27_clear_all_thumbnail_paths_writes_null` ✅

#### B28 settings 错误状态 — ✅ 通过（Store 层） / ⚠ UI 层未消费

**文件**：`stores/settingsStore.ts`、`pages/SettingsPage.tsx`

审查结论：
- ✅ Store 层：新增 `loadError: string | null`，`load()` 失败时 `set({ loaded: true, loadError })`
- ⚠ UI 层：`SettingsPage.tsx` 未解构 `loadError`，加载失败时页面卡在"加载设置中…"（数据安全——无法到达保存按钮——但无错误提示）

> 次要观察（非 Bug）：Store 层修复完整（核心目标"不静默吞错"已达成）。UI 未消费 loadError 是体验缺口，不影响数据安全（加载失败时 settings=null → draft 不初始化 → 卡在加载页 → 无法误保存）。

#### B33 Workbench deps — ✅ 通过

**文件**：`components/ai/Workbench.tsx`

审查结论：
- ✅ `useEffect` 补依赖数组 `[index, onGoto, handleConfirm]`
- ✅ `handleConfirm` 用 `useCallback` 包裹（依赖 `[onConfirm]`）

---

## 4. 发现的源码 Bug 清单

### BUG-QA-1：B06b unique_dest 失败时导出任务状态未更新为 failed — ✅ 已修复验证

- **严重度**：🟡 低（极端边界场景：目标目录已有 999+ 同名文件）
- **类型**：源码 Bug → 交工程师 → **Round 2 已修复验证通过**
- **文件**：`src-tauri/src/services/export_local.rs:54`
- **复现**：`b06b_export_same_name_exhaustion_errors` 测试

**根因**：

```rust
// export_local.rs:54
let dst = unique_dest(&dest, &asset.file_name)?;  // ← ? 直接传播
```

`unique_dest` 在 B06b 修复后返回 `AppResult<PathBuf>`，同名耗尽时返回 Err。但调用处用 `?` 直接传播错误，**跳过了 line 88 的 `if let Err(e) = r { finish_task("failed") }` 逻辑块**。任务停留在 `update_progress` 设置的 "running" 状态，永不结束。

**影响**：
- 导出任务在同名耗尽时报错返回，但 DB 中 `export_tasks.status` 仍为 "running"
- 用户在任务列表中看到一个永不完成的任务

**回归性**：B06b 修复引入。修复前 `unique_dest` 返回 `PathBuf`（永不 Err），耗尽时返回已存在路径 → `fs::copy` 静默覆盖 → 任务 "done"。修复后返回 Err 但未走 finish_task → 任务 "running"。

**建议修复**：将 `unique_dest` 调用移入 `r` 的计算块，使其错误被 `if let Err(e) = r` 捕获：

```rust
let r = (|| {
    let dst = unique_dest(&dest, &asset.file_name)?;
    if mode == "move" {
        match move_file(&src, &dst) {
            Ok(()) => { /* B04 UPDATE 逻辑 */ Ok(()) }
            Err(e) => Err(e),
        }
    } else {
        fs::copy(&src, &dst).map(|_| ()).map_err(AppError::from)
    }
})();
// 下方 if let Err(e) = r { finish_task("failed") } 即可捕获
```

**当前测试状态**：✅ Round 2 验证通过。`b06b_export_same_name_exhaustion_errors` 断言已更新为 `"failed"`，独立运行通过（79.75s）。全量 108/108 绿。

**Round 2 修复验证**：
- 源码：`unique_dest` 调用从 `?` 改为 `match` 纳入 `r` 计算块，`Err(e) => Err(e)` 分支被 `if let Err(e) = r { finish_task("failed") }` 正确捕获
- 测试断言：`assert_eq!(t.status, "failed", ...)` 严格断言，未弱化
- 全量回归：108 passed, 0 failed, 3 ignored

---

## 5. 工程师偏离评估

| 偏离 | 评估 | 结论 |
|------|------|------|
| B04 用 `match` 替代 `?` 处理 move+UPDATE | 确保 UPDATE 失败也走 finish_task("failed")，比计划中 `?` 更安全 | ✅ 合理 |
| B27 新增 `clear_all_placeholder_paths` / `clear_all_hd_thumbnail_paths` db 函数 | 比内联 SQL 更可测试、可复用 | ✅ 合理 |
| B24 `find_by_path` 复用 | reveal_in_folder 与 importer precheck 共用，DRY | ✅ 合理 |
| B33 `handleConfirm` 用 `useCallback` 包裹 | 满足 useEffect 依赖数组要求 | ✅ 合理 |
| B20 `confirm_suggestion_inner` 拆分 | 与 assign/assign_inner 模式一致 | ✅ 合理 |

---

## 6. 遗留问题与已知限制

| 编号 | 描述 | 严重度 | 处置 |
|------|------|--------|------|
| ~~BUG-QA-1~~ | ~~B06b unique_dest 失败时任务状态 stuck "running"~~ | ~~🟡 低~~ | ✅ **Round 2 已修复验证** |
| OBS-1 | B28 SettingsPage 未消费 loadError（卡在加载页无错误提示） | 🟢 极低 | 数据安全已保障，UI 体验缺口，留后续 |
| OBS-2 | DeleteDialog clear() 无条件调用，失败时选中集已清无法直接重试 | 🟢 极低 | 数据正确，UX 小瑕疵，留后续 |
| OBS-3 | B06a/B06b 循环 1..1000 在 999 槽满时报错（不尝试 1000） | 🟢 极低 | 极端边界，"不静默覆盖"目标已达成 |

---

## 7. 结论

**第二批 21 项隐患修复回归：✅ 全量通过（Round 2 回归完成）**

- 19 项修复全部正确实现，无数据完整性问题
- BUG-QA-1（B06b 任务状态）已由工程师修复，Round 2 独立验证通过
- 108/108 测试全绿（含 12 个新增边界测试）
- 前端 typecheck + build 通过（Round 1 验证，BUG-QA-1 仅涉及 Rust 后端，前端无变更）
- 3 个次要观察项（OBS-1/2/3），均不影响数据安全，留后续优化
- 工程师偏离（B04 match / B27 新增 db 函数 / find_by_path 复用 / Workbench useCallback / B20 inner 拆分）全部合理

**建议**：可发布。所有源码 Bug 已修复验证，无遗留阻塞项。
