# QA 回归验证报告 — BagerTea V2（BUG-A/B/D/E 修复后独立验证）

- **日期**：2026-08-14
- **QA**：严过关（software-qa-engineer-2，fresh eyes 独立回归）
- **项目路径**：`F:\vibecode\chabaosucai`
- **输入**：`docs/review/fix-plan-2026-08-14.md`（修复计划）、工程师改动 9 个文件、`src-tauri/tests/qa_edge_tests.rs`（历史回归测试）
- **约束**：未修改 `src/` 与 `src-tauri/src/` 任何源码；仅向 `qa_edge_tests.rs` **新增** 6 个测试（未删除/弱化既有断言）
- **结论速览**：**回归通过（96/96 全绿）**；未发现新的源码 Bug；3 处工程师偏离全部判定合理；发现 3 项非阻塞遗留问题（含 1 项环境问题）

---

## 1. 测试结果

### 1.1 全量测试（`cargo test`，src-tauri）

| 测试集 | 用例数 | 结果 |
|---|---|---|
| src 单元测试（lib.rs unittests） | 33 | ✅ 33/33 |
| db_integration.rs | 13 | ✅ 13/13 |
| qa_edge_tests.rs | 45（39 既有 + 6 本次新增） | ✅ 45/45 |
| services_integration.rs | 5 | ✅ 5/5 |
| dev_maintenance / perf_probe | 3 | ignore（手动维护/探针） |
| **合计** | **96 执行** | **✅ 96/96（100%），0 failed** |

**关键用例转绿（4 个原失败 Bug 断言）**：
- `fts_ascii_partial_token_substring`（BUG-A）✅
- `fts_ascii_partial_token_photo`（BUG-A）✅
- `fts_special_char_percent_query`（BUG-B）✅
- `fts_asset_tag_join_order_independent`（BUG-D）✅

**工程师新增 6 用例**：`fts_ascii_middle_substring`、`fts_cjk_ascii_mixed_substring`、`fts_tag_order_both_orders`、`fts_tag_order_three_tags`、`list_ids_matches_list_filter`、`v3_rebuild_normalizes_fts_content` — 全部 ✅。

**回归守卫全部保持绿**：`fts_cjk_phrase_3char_no_false_positive`、`fts_cjk_prefix_tokens_ok`、`fts_cjk_phrase_no_false_positive_4char`、`fts_filename_with_double_quote`、`fts_filename_with_star`、`fts_punctuation_only_no_crash`、`like_escape_*`、`fts_consistency_tag_rename`、`fts_consistency_asset_rename` 等。

### 1.2 前端

| 步骤 | 命令 | 结果 | 备注 |
|---|---|---|---|
| TS 类型检查 | `npm run typecheck` | ✅ PASS | tsc --noEmit 无错误 |
| 前端生产构建 | `npm run build` | ✅ PASS | 首次失败为**环境问题**（WorkBuddy safe-delete shim 无法 trash 陈旧 dist/，非代码问题）；清空 dist 后 `✓ built in 3.65s`，90 modules，JS 319.46 kB / CSS 29.03 kB |

---

## 2. 代码审查结论（fresh eyes，逐修复点）

### 2.1 `utils/bigram.rs`（BUG-B 写入侧）— ✅
- `is_cjk` 提升为 `pub`，`search.rs` 复用，无重复实现。
- 新逻辑 `if p || cur_cjk`（前后任一为 CJK 即插空格）同时满足三项要求：
  - **CJK 逐字**：`海边日落` → `海 边 日 落`（CJK↔CJK 插空格）✅
  - **边界分离**：`进度100%.jpg` → `进 度 100%.jpg`、`IMG_海边合照01.jpg` → `IMG_ 海 边 合 照 01.jpg`（双向边界插空格）✅
  - **纯非 CJK 不插空格**：`photo001.jpg` → 原样（前后均非 CJK 不插）✅
- 单元测试 `bigram_splits_cjk` / `bigram_boundary_spaces` 断言与实现一致。

### 2.2 `db/search.rs`（BUG-A/B/D 查询侧）— ✅
- 路由分支：`≤2 字 → LIKE` / `>2 字含非 CJK → FTS ∪ LIKE 并集` / `纯 CJK ≥4 字 → 2 字块 AND` / `纯 CJK 3 字 → FTS 短语`。
- **输入类型覆盖核对**（逐一推演 + 实测）：
  - 仅符号串（`!!!`/`@@@`/`!@#`…）：并集分支，FTS 短语全分隔符 → 空；LIKE 无命中 → 空，不崩溃 ✅（新增测试）
  - 空格串（`"   "`/`"\t"`）：trim 后为空 → 提前返回空，不崩溃 ✅（新增测试）
  - emoji（`😀😀😀`、`a😀b`）：非 CJK → 并集；unicode61 视 emoji 为分隔符 → 空/不崩溃 ✅（新增测试）
  - 混合查询（`海边100`/`海边1`/`100`）：并集路由正确，子串语义一致 ✅（新增测试）
  - 引号/星号/`%`：既有守卫用例保持绿 ✅
- `union_dedup` 去重正确；`like_search` 转义顺序（`\`→`%`→`_`）与既有用例一致；`fts_search` 双引号转义正确。
- 唯一未断言边界：查询以**孤立前导引号**开头（如 `"abc`）→ 走并集，FTS 转义后按短语处理，预计不崩溃（与修复前行为一致，非本次回归）。见 §5 遗留 3。

### 2.3 `db/migrations.rs`（SCHEMA_V3）— ✅
- **幂等**：`migrate()` 先执行 V3 重建（DROP 触发器 → 回源重算 → rebuild）**再**提交 `user_version=3`；中途崩溃重启可重跑。`DELETE + INSERT SELECT + rebuild` 天然幂等。验证：`migrate_twice_is_idempotent`（v=3 重复 migrate 无副作用）、`v3_rebuild_normalizes_fts_content`（V2 旧产物 → V3 回源重算 `进 度100%.jpg` → `进 度 100%.jpg`，再 migrate 幂等）。
- **ORDER BY 与展示排序一致性**：V3 三个 tag 触发器 `group_concat` 子查询 `ORDER BY t.sort_order, t.id`；`assets.rs fill_tags`（assets.rs:235）与 `asset_tags.rs get_asset_tags`（asset_tags.rs:48）均为 `ORDER BY t.sort_order, t.id` — **三方一致** ✅。并做了**实证测试**（新增 `v3_tag_names_follow_sort_order`）：改 sort_order 后经改名触发器强制重算，SQLite 确实按子查询 ORDER BY 聚合（乙排到甲前）——写入侧加固真实生效。
- 注意：`trg_tags_au` 只在 `UPDATE OF name` 触发；若未来开放 sort_order 编辑，需同步扩展触发列（当前 `tags::update` 不暴露 sort_order，不可达，见 §5 遗留 2）。

### 2.4 `db/assets.rs::list_ids`（BUG-E 后端）— ✅
- 复用私有 `build_where` + `search::search_asset_ids`，仅 `SELECT a.id`，`ORDER BY a.created_at DESC, a.id DESC` 与 `list()` 完全一致。
- 与 `list()` 的 WHERE 完全同源（类型/untagged_only/标签递归 CTE/搜索 IN 列表），参数绑定方式一致。
- 验证：既有 `list_ids_matches_list_filter` + 新增 `list_ids_matches_list_tag_subtree_and_combined`（父标签子树连带、子标签、tagId+search 组合、tagId+搜索不命中、untagged+search、untagged+tagId 空、type+tagId）全部与 `list()` id 集合一致 ✅。

### 2.5 `commands/assets_cmd.rs` / `lib.rs`（BUG-E）— ✅
- `list_asset_ids` 只 `SELECT id`、**不调 `allow_asset`**，天然消除 asset 协议 scope 随全选无界增长；已注册进 `lib.rs` invoke_handler。

### 2.6 前端 `api/assets.ts` / `stores/libraryStore.ts`（BUG-E）— ✅
- `listAssetIds(filter): Promise<number[]>` 调 `list_asset_ids`；`fetchAllIds` 改调它并去除 total/limit 依赖。
- **调用方类型兼容核对**：唯一调用方 `AssetGrid.tsx`（全选/反选）→ `setAll(ids: number[])` / `invert(allIds: number[])`，与 `number[]` 完全匹配；`tsc --noEmit` 通过佐证 ✅。

---

## 3. 工程师 3 处偏离判定（独立复核）

| # | 偏离 | 判定 | 依据 |
|---|---|---|---|
| 1 | `cjk_bigram` 由计划伪代码 `if p != cur_cjk` 改为 `if p \|\| cur_cjk` | ✅ **合理且必要** | 计划伪代码会在 CJK↔CJK 之间**不插空格**，直接破坏逐字切分（`海边日落` → 无空格），导致纯 CJK 短语搜索全部失效。工程师版本 `p\|\|cur_cjk` 等价于「前后任一为 CJK 即插空格」，同时覆盖 CJK 逐字 + 边界分离 + 纯非 CJK 不插三项要求。 |
| 2 | `migrate_twice_is_idempotent` 断言 version 2→3 | ✅ **必然结果** | V3 迁移存在，`setup()` 走 `migrate()` 后 `user_version` 必为 3；该断言是迁移正确性的必要验收。 |
| 3 | `bigram_boundary_spaces` 期望值 `"IMG_ 海 边 合 照 01.jpg"`（计划写 `"IMG_ 海边合照 01.jpg"`） | ✅ **工程师值正确** | 计划 §2.2「效果」示例与其自身规则自相矛盾（忽略了 CJK↔CJK 逐字空格）。按边界规则 + 逐字规则实际产物必须为 `IMG_ 海 边 合 照 01.jpg`；该期望值也是保证逐字搜索一致性的前提。 |

> 结论：3 处偏离均合理，无掩盖 Bug 之嫌。

---

## 4. 新增断言结果（QA fresh-eyes 补充，仅加测试）

| 新增测试 | 验证点 | 结果 |
|---|---|---|
| `fts_pure_symbols_no_false_positive` | 纯符号串（`!!!`/`@@@`/`$$$`/`^^^`/`(((`/`~~~`/`!@#`/`~!@#$%^&*()`）不崩溃不误报；符号夹真实子串（`b!c`）仍命中 | ✅ |
| `fts_space_only_no_crash` | 纯空格/`\t`/`\n` trim 后空返回；尾随空白被忽略仍命中 | ✅ |
| `fts_emoji_query_no_false_positive` | 纯 emoji 与 emoji 夹 ASCII 不崩溃不误报 | ✅ |
| `fts_mixed_cjk_ascii_routing` | 混合查询路由：`海边100` 只命中海边100；`海边1` 命中海边100+海边10（子串）；`100` 命中；纯 CJK `上海公园` 仍走 2 字块 AND 命中 | ✅ |
| `list_ids_matches_list_tag_subtree_and_combined` | list_ids 在父标签子树/子标签/tagId+search/untagged+search/untagged+tagId/type+tagId 下与 list 完全一致 | ✅ |
| `v3_tag_names_follow_sort_order` | V3 触发器 group_concat 按 `sort_order,id` 排序实证（改 sort_order 后重算，乙排前） | ✅（首跑失败为**断言自身**把空格数写死，已修正为只断言顺序；源码行为正确） |

**qa_edge_tests 总计 45 用例全绿。**

---

## 5. 遗留问题清单（非阻塞）

1. **【环境，非代码】`npm run build` 在陈旧 `dist/` 存在时可能失败**：WorkBuddy "safe-delete" shim 拦截 vite 清理 dist（genie-trash abort / COM 回退失败），报 `[safe-delete] 操作失败`。清空 dist 后构建正常。建议团队后续构建前手动清 dist 或调整 shim 策略，避免误判为代码失败。
2. **【潜在，当前不可达】`trg_tags_au` 仅监听 `UPDATE OF name`**：若未来开放标签 `sort_order` 编辑，tag_names 顺序不会随 sort_order 变化刷新（与展示排序不一致）。当前 `tags::update` 不暴露 sort_order，无触发路径，暂不处理；建议排期时记录。
3. **【潜在，非本次回归】孤立前导引号查询（如 `"abc`）**：走并集分支，FTS 侧按短语处理（预计不崩溃、不误报），与修复前行为一致；未纳入断言。如后续要收紧，可考虑对 FTS 短语构造增加前置 sanitize。
4. **【文档】`fts_content.tag_names` 存在 CJK 标签间双空格**（如 `"甲  乙"`）：`cjk_bigram` 会对 group_concat 的分隔空格再次插空格。**搜索无影响**（unicode61 折叠空白；已实测 chunk/短语匹配不受影响），仅直接查看 fts_content 时观感；不改代码，记录备查。

---

## 6. 结论

- **回归判定：通过**。全量 96/96 通过，4 个原 Bug 断言全部转绿，6 个工程师新增用例通过，6 个 QA 补充边界用例通过；前端 typecheck + build 通过。
- **未发现新的源码 Bug**；无需交回工程师。
- **3 处偏离全部合理**（其中 #1 与 #3 属工程师修正了计划自身的错误，值得肯定）。
- **未修改任何源码**；测试文件仅新增 6 用例。
