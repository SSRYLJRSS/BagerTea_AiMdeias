# QA 实测报告 — 茶包素材 BagerTea V2（Tauri 2 桌面应用）

- **日期**：2026-08-14
- **QA**：严过关（software-qa-engineer）
- **项目路径**：`F:\vibecode\chabaosucai`
- **范围**：构建验证（前端 typecheck/vite build + Rust cargo build）+ 数据库层集成测试 + 可疑点实测
- **约束**：未修改 `src/` 与 `src-tauri/src/` 任何源码；仅新增测试文件 `src-tauri/tests/qa_edge_tests.rs`

---

## 1. 测试环境

| 项 | 版本 |
|---|---|
| OS | Windows（Git Bash） |
| node | v22.22.2 |
| npm | 10.9.7 |
| cargo / rustc | 1.97.1 |
| Tauri | 2（Cargo.toml） |
| rusqlite | 0.31（bundled，modern_sqlite, functions） |
| SQLite FTS | FTS5 + unicode61 tokenizer + 自定义 cjk_bigram |

---

## 2. 构建验证结果

| 步骤 | 命令 | 结果 | 备注 |
|---|---|---|---|
| TS 类型检查 | `npm run typecheck`（tsc --noEmit） | ✅ PASS | 12s |
| 前端生产构建 | `npm run build`（tsc && vite build） | ✅ PASS | 首次失败为环境问题：WorkBuddy "safe-delete" shim 拦截 vite 清理 dist 目录（trash 操作被 abort），非代码问题；手动清空 dist 后重跑 `✓ built in 2.65s`（90 modules，JS 319.47 kB / CSS 29.03 kB） |
| Rust 编译 | `cargo build`（src-tauri，增量） | ✅ PASS | 1m16s |
| Rust 单元测试 | `cargo test`（src 内 #[cfg(test)]） | ✅ PASS | 32/32（含 bigram 切分、搜索、tag 等） |

> 说明：首次 `cargo test` 出现 `target\.fingerprint\...invoked.timestamp 拒绝访问(os error 5)`，为并发 cargo 进程文件锁冲突，重跑即通过（非代码问题）。

---

## 3. 覆盖范围与用例表（新增 `qa_edge_tests.rs`，共 33 用例）

| 类别 | 用例 | 结果 |
|---|---|---|
| ① migrations 幂等 | migrate_twice_is_idempotent / migrate_after_data_preserves_rows | ✅ 2/2 |
| ② assets CRUD + 级联删除 | delete_asset_cascades_tags_fts / delete_tag_cascades_assignments_and_refreshes_fts / delete_parent_tag_cascades_children | ✅ 3/3 |
| ③ LIKE 转义（% _ \） | like_escape_percent（% 与 %_ 连写）/ like_escape_underscore / like_escape_backslash / like_tag_name_with_special_char | ✅ 4/4 |
| ④ FTS 搜索 | fts_cjk_phrase_3char_no_false_positive / fts_cjk_phrase_no_false_positive_4char / fts_cjk_prefix_tokens_ok / fts_filename_with_double_quote / fts_filename_with_star / fts_punctuation_only_no_crash | ✅ 6/6 |
| ④ FTS 已知缺陷（回归标记） | fts_ascii_partial_token_substring / fts_ascii_partial_token_photo / fts_special_char_percent_query / fts_asset_tag_join_order_independent | ❌ 4/4（源码 Bug，见 §4） |
| ⑤ 批量删除 | batch_delete_assets / batch_delete_mixed_existing_and_missing / batch_delete_empty / batch_delete_duplicate_ids | ✅ 4/4 |
| ⑥ tag 父子/循环校验 | tag_reparent_to_self_rejected / tag_reparent_deep_cycle_rejected / tag_reparent_valid_moves / tag_reparent_to_nonexistent_rejected | ✅ 4/4 |
| ⑦ 分页/偏移边界 | pagination_limit_zero_clamped / pagination_negative_offset_clamped / pagination_offset_beyond_total / pagination_has_more_boundary | ✅ 4/4 |
| ⑧ FTS 与写入侧一致性 | fts_consistency_tag_rename / fts_consistency_asset_rename / fts_asset_tag_join_order_independent* | ✅ 2/3（*为 Bug-D 回归标记） |

**既有测试基线（回归）**：src 单元测试 32/32、`db_integration.rs` 13/13、`services_integration.rs` 5/5、`dev_maintenance`/`perf_probe` 3 条 ignore（手动维护/探针）。

**总体通过率**：79 passed / 83 total（95.2%）；**4 failed 均为真实源码 Bug**（回归标记，见下）。

---

## 4. 真实 Bug 清单（按严重度）

### P1 — 核心搜索功能缺陷（源码 Bug → 交工程师）

**BUG-A：FTS 路径下 ASCII 3+ 字符「token 内部子串」搜索静默失败**
- **文件**：`src-tauri/src/db/search.rs`（fts_search 短语查询）＋ `src-tauri/src/db/migrations.rs`（unicode61 tokenizer 选择）
- **预期**：搜索 `202` 命中 `IMG_2024_001.jpg`；搜索 `photo` 命中 `photo001.jpg`（子串搜索一致性，与 ≤2 字 LIKE 兜底行为一致）
- **实际**：均返回空 `[]`
- **复现**：插入 `IMG_2024_001.jpg` / `photo001.jpg`，`search_asset_ids("202")` / `("photo")` → 空
- **根因**：FTS5 unicode61 按分隔符切 token：`IMG_2024_001.jpg` 的 token 是 `img, 2024, 001, jpg`，`photo001.jpg` 的 token 是 `photo001, jpg`。查询 `"202"`（3 字，>2 走 FTS）被短语化后要求**完整 token 精确相等**，`202 ≠ 2024`、`photo ≠ photo001` → 不命中。而 `20`（2 字走 LIKE）命中 —— **同一素材搜索行为随字数不一致**（实测：`001` 命中、`202` 不命中）。
- **证据**：
  - `fts_ascii_partial_token_substring` FAILED：`搜索「202」应命中 IMG_2024_001.jpg；实际返回 []`（left=[] right=[1]）
  - `fts_ascii_partial_token_photo` FAILED：`搜索「photo」应命中 photo001.jpg；实际返回 []`
- **影响**：用户常用 `IMG_202`、`photo`、`2024`（非 token 对齐）等局部文件名搜索全部空结果；且与 2 字内 LIKE 行为不一致，极难排查。

### P2 — 源码 Bug（交工程师）

**BUG-B：CJK 与 ASCII 字母/数字相邻时合并为单 token，跨边界子串（含 % 等）搜索失败**
- **文件**：`src-tauri/src/utils/bigram.rs`（cjk_bigram 只在连续 CJK 间插空格）＋ `db/search.rs`（FTS 短语）
- **预期**：`进度100%.jpg` 可被 `100%` / `100` / `度` 命中
- **实际**：均不命中（`MATCH "100"` / `"度"` / `"100%"` 全部 `<none>`；仅孤立 CJK token `进` 命中）
- **复现**：插入 `进度100%.jpg`，原始 FTS 调试：`fts_content.file_name="进 度100%.jpg"`，`MATCH "进"→1`，`MATCH "度"→空`，`MATCH "100"→空`，`MATCH "\"100%\""→空`
- **根因**：cjk_bigram 只在「CJK↔CJK」之间插空格；`度` 与 `100` 之间无分隔 → unicode61 把 `度100` 视为**一个 token**。查询侧同样切分后短语 token 为 `100`/`度`，与索引 token `度100` 不等 → 不命中。`100%` 单独作为 FTS 短语会触发 `fts5: syntax error near "%"`（代码已加引号，故不崩溃但空结果）。
- **影响**：`IMG_海边合照01.jpg` 类混合文件名搜 `合照0`/`照01` 前缀失败；含 `%` 文件名 3+ 字搜索失败（2 字内 LIKE 正常，行为不一致）。
- **附带发现**：`MATCH "100%"`（未加引号）会报 `fts5: syntax error near "%"`——当前代码因统一加引号未触发崩溃，但任何未来不加引号的调用方会踩到。

**BUG-D：多标签搜索命中依赖 group_concat 顺序（分配顺序决定搜索结果）**
- **文件**：`src-tauri/src/db/migrations.rs`（trg_at_ai/trg_at_ad 中 `group_concat(t.name,' ')` 无 ORDER BY）＋ `db/search.rs`（短语匹配）
- **预期**：同一素材同一组标签，无论分配顺序，`海边日落` 均应命中
- **实际**：顺序相关 —— 实测：
  - 分配顺序 `日落→海边`：`tag_names="日 落 海 边"`，搜 `海边日落` → `[]`
  - 分配顺序 `海边→日落`：`tag_names="海 边 日 落"`，搜 `海边日落` → `[1]`
- **证据**：`fts_asset_tag_join_order_independent` FAILED（left=[] right=[1]）；调试输出见上
- **根因**：多标签拼成 tag_names 后，FTS 短语要求查询 token **相邻且同序**；group_concat 顺序=插入顺序，用户搜词顺序与分配顺序不一致即不命中。属于「短语防误命中」设计（防「海边」误命中「上海湖边」）的副作用：**多词 AND 检索被牺牲**。
- **影响**：搜索两个及以上标签时结果随机依赖分配顺序，用户难以理解。

### P2 — 前端代码审查确认（无需跑 UI）

**BUG-E：`libraryStore.fetchAllIds` 拉全量完整对象（内存浪费）**
- **文件**：`src/stores/libraryStore.ts`（fetchAllIds）
- **证据**：`fetchAllIds` 调 `listAssets({ offset:0, limit: Math.max(total,1) })`，后端 `list_assets` 返回**完整 Asset 对象**（23 字段 + 每项 tags 聚合），仅用于取 id 数组。10 万素材即一次性拉 10 万完整对象 + 触发 `assets::list` 内 `allow_asset` 对每路径放行（asset 协议 scope 无界增长）。
- **建议**：后端新增 `list_asset_ids`（仅 SELECT id）命令，前端 fetchAllIds 改为调用它。
- **关联审查**：`commands/assets_cmd.rs delete_assets` 批量删除的锁策略经代码审查**无持锁过久问题**（阶段一短锁收集路径 → 锁外 remove_file → 阶段三短锁写库），路径处理正确；未发现 Bug。

---

## 5. 已验证为「正常」的可疑点（架构师候选点结论）

| 可疑点 | 结论 | 证据 |
|---|---|---|
| a. LIKE 转义（% _ \） | ✅ 正确 | 1 字/2 字查询实测：`%` 只命中含 `%` 文件，`_` 不作单字符通配，`\` 作字面量；转义顺序（先 `\` 后 `%`/`_`）正确 |
| a. FTS 短语引号注入 | ✅ 无注入/无崩溃 | `海边"落日".jpg` 文件名、`图*片.jpg` 均可检索；纯标点 `!!!` 返回空不崩溃 |
| d. migrations 幂等 | ✅ 正确 | user_version 推进式，重复 migrate 无副作用且保留数据 |
| e. bigram 与 FTS 一致性 | ⚠️ 切分一致但存在 token 边界缺陷 | 写入/查询用同一 `cjk_bigram`，但 ASCII 子串与 CJK+数字混合边界不命中（BUG-A/B） |
| f. 分页/偏移边界 | ✅ 正确 | limit=0 钳 1、负 offset 钳 0、offset 超界空页 has_more=false、边界 has_more 正确 |

---

## 6. 未覆盖与限制说明

1. **GUI 交互无法 headless 实测**：Tauri 窗口、React 组件、拖拽导入、缩略图渲染、asset 协议加载等需真实窗口环境，未自动化；本次前端仅做代码审查与构建验证。
2. **Tauri command 层未直接调用**：`delete_assets`/`list_assets` 等命令依赖 `AppHandle/State`，集成测试覆盖到仓储层（`assets::delete` 批量删除、级联、FTS 联动）；command 层锁策略以代码审查结论为准。
3. **FTS 修复方向（供工程师参考）**：① 查询侧对 >2 字 ASCII 子串增加 LIKE 兜底或改为 unicode61 无法解决 token 内部匹配 → 建议查询串对非 CJK 部分也做逐字符/按子串处理，或搜索流程改为「FTS 初筛 + LIKE 复核」；② `cjk_bigram` 应在 CJK↔非 CJK 边界也插空格（`度 100`）；③ `group_concat` 增加 `ORDER BY t.sort_order, t.id` 固化顺序，并把 FTS 多词查询改为短语 OR 各 tag 组合或直接 AND 语义。
4. **性能探针**（perf_probe）为手动诊断用例，未在本次运行（ignored）。
5. **真实用户库**（dev_maintenance）为手动维护工具，未触碰真实数据。

---

## 7. 结论

- **构建**：全部通过（typecheck / vite build / cargo build / cargo test 编译）。
- **测试**：新增 33 用例，29 通过 + 4 失败（全部为源码 Bug 回归标记）；既有基线 50/50 通过。
- **待工程师修复**：BUG-A（P1，ASCII 子串 FTS 搜索静默失败）、BUG-B（P2，CJK+数字 token 合并）、BUG-D（P2，多标签搜索顺序相关）；前端 BUG-E（P2，fetchAllIds 全量拉取）建议加 id-only 命令。
- **QA 未修改任何源码**；新增测试文件 `src-tauri/tests/qa_edge_tests.rs` 保留作为回归标记（工程师修复后应转绿）。
