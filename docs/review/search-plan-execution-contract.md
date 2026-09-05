# SearchPlanV3 执行契约（Phase 1 交付物 · 冻结版）

> 日期：2026-09-04 · 依据：《超级搜索三区改造与数值打标开发计划-2026-09-03.md》§4（v4）
> 本文件是 §4.1–4.8 + §3.7 + §3.9 的可执行版本。Phase 2 的接线实现必须与本契约逐条一致；
> 35 条契约测试（§4.7）是「契约已冻结」的可检验定义。

## 已拍板的决策（§10）

| 决策 | 结论 |
|---|---|
| B6（filter 空 + should 非空 + min=0） | **A**：允许全库软排序，去掉 `.max(1)`；UI 明示「显示全部 N 张，仅调整顺序」 |
| B9（优先条件与字段排序） | **A**：字段为主键 + `score DESC` 次级（`ORDER BY sortv {dir}, score DESC, id DESC`） |
| 数值分面同源扇出 | **B**：不扇出，每素材独立填（Phase 7） |

---

## 1. 单一事实源（§4.1）

一次搜索的下列六项，必须由**同一个 `SearchPlanV3`** 经**同一套编译器**产出，任何一项另开一条路即为违约：

| 项 | 命令 | 返回 | 现状 |
|---|---|---|---|
| 结果列表（分页） | `list_assets_by_plan(plan, offset, limit)` | `AssetPage { items, total, hasMore, warnings }` | 待建 |
| 总数 | 同上的 `total`（`count_plan` 改 `pub`） | — | 待建 |
| 全选 / 反选 ID | `list_asset_ids_by_plan(plan)` | `PlanIdsResult { ids, total, truncated, warnings }` | 待建 |
| 排序 | `plan.ranking` | — | 已有，未接 |
| warning | 两个命令都返回 `SearchWarning[]` | — | 类型待升级 |
| 逐条件诊断 | `diagnose_search_plan_cmd(plan)` | `PlanDiagnostics { leaves, should, warnings }` | 分母错集（B3） |

补充约定：

- **warning 类型统一为 `SearchWarning { source, zone?, message }`**。`prune_invalid` 知道自己在删哪个区，不许降级成裸 `String` 让前端猜。
- **全选返回一路到底不降级**：`PlanIdsResult`（上限 100000，沿用 `assets.rs:663`），store 的 `fetchAllIds(): Promise<FetchAllIdsResult>` 与它同形，不许中途退化成 `number[]`。
- 两个 plan 命令顺序都是 **validate → prune → 执行**（校验在剔除之前，否则非法 weight 会被剔除逻辑先碰到）。
- 排序两条路一致：ID 版必须复用 `compile_search_plan`，`Relevance` 走同一个 `run_relevance_fused`（内存 RRF + 分页），不许自拼。
- `Ranking::Field` 的 `ORDER BY`：`sortv {dir}, score DESC, id DESC`（尾缀唯一列 → 分页稳定）。
- **`retrievers` 单一来源 = `SearchPlanV3.retrievers`**；`Ranking::Relevance` 无载荷（B10）。
- 范围限制：本轮只有超级搜索页换 plan 执行链；素材库页继续走扁平 `AssetFilter`，`list_assets` / `list_asset_ids` 保留。

## 2. `ResolvedSearchQuery → SearchPlanV3`（§4.1a）

新增 `resolvedQueryToPlan(q): SearchPlanV3`：

| `ResolvedSearchQuery` 字段 | 去向 | 产出 `LeafCond` | 备注 |
|---|---|---|---|
| `search` | `plan.filter` | `{ type: "search", value }` | 空串跳过 |
| `assetType` | `plan.filter` | `{ type: "assetType", value }` | `"all"` 跳过 |
| `untaggedOnly` | `plan.filter` | `{ type: "untagged" }` | `false` 跳过 |
| `facetFilters[]` | `plan.filter` | `{ type: "tag", facetKey, tagIds, mode, includeDescendants }` | mode/descendants 原样带；空 tagIds 跳过 |
| **`excludeTagIds[]`** | **`plan.mustNot`** | `{ type: "tag", facetKey: "", tagIds: [id], mode: "any", includeDescendants: true }` | **正向 Tag**，不是 excludeTag；多个 → `mustNot = Or([...])` |
| `metadataFilters[]` | `plan.filter` | `{ type: "metadata", filter }` | 原样 |
| `sortBy` / `sortDir` | `plan.ranking` | `Ranking::Field { key, dir }` | B9 方案 A |

`plan.filter` 组合：多个叶子 → `AND`；单个 → 直接叶子；零个 → `None`。

## 3. `must_not` 极性契约（§4.1b · P0）

**`must_not` 里只放正向条件，计划层统一负责那一层 NOT。** `ExcludeTag` 与 `QueryExpr::Not` 禁止进入。

等价性：`ExcludeTag{a,b}` ≡ `NOT EXISTS(a) AND NOT EXISTS(b)`；`must_not = Or([Tag a, Tag b])` ≡ `NOT(EXISTS(a) OR EXISTS(b))` ≡ 德摩根同形。两侧都走同一递归 CTE 取后代 → 后代语义等价。

白名单（写入 `validate_search_plan`）：

| `LeafCond` | 进 `must_not` |
|---|---|
| `Tag` / `AssetType` / `Metadata` / `Search` / `FacetHasAny` | ✅ |
| `Untagged`（`NOT EXISTS(任何标签)` = 素材特征「无标签」） | ✅ |
| `FacetMissing` | ✅ |
| **`ExcludeTag`**（本身就是「排除」动作） | ❌ 拒绝 |
| **`QueryExpr::Not`**（三重否定不可读） | ❌ 拒绝 |

`ExcludeTag` 在 `filter` 里仍然完全合法。UI 排除区不提供「排除标签」字段 —— 否定只在区一级表达一次。

## 4. warning 的上下文相关剔除（§4.2）

`prune_invalid(plan) -> (SearchPlanV3, Vec<SearchWarning>)`，编译前在 AST 层结构性删除，不在 SQL 层折叠常量：

| 位置 | 无效叶子处置 |
|---|---|
| `filter` | 删除该叶子；父变空一并删；整树空 → `None` |
| `must_not` | 删除该排除项；整树空 → `None`（折叠 `1=1` 会 `NOT(1=1)` 清库；`1=0` 会静默消失） |
| `should` | 删除整条 `ShouldClause`；`minimum_should_match` 收敛到新长度 |

每删一条产出一句带区名的人话 warning（`source="plan"`，`zone` 尽量给）。
`1=0` 保留但只在 `filter`/`should` 内合法（term_query 明确零命中 = 用户搜了不存在的词）；在 `must_not` 里出现 `1=0` → 转「删项 + warning」。

## 5. 校验清单（§4.3）

`validate_search_plan` 新增五类：

1. `should[].weight ∈ {0.5, 1.0, 2.0}` 且有限
2. `minimum_should_match ≤ should.len()`
3. `Ranking::Field.dir ∈ {asc, desc}`
4. `retrievers[].weight` 有限且 > 0
5. `plan_schema_version > 当前` → Err「来自更新版本」

## 6. 版本矩阵（§4.4）

| 版本号 | 当前值 | 读到旧值 | 读到新值 |
|---|---|---|---|
| `planSchemaVersion` | 3 | 本轮不会遇到（已清库） | **拒绝 + 提示「保存的搜索条件来自更新版本，已重置」** |
| `normalizationVersion` | 1（保持） | 同上 | 同上 |
| `compilerVersion` | 1 | 无需处理 | 无需处理 |

保留版本号机器的意义：用户装了新版本又回退旧版本时，localStorage 里的 plan 必须丢弃而非照常执行。
hydrate 链路：`superSearchStore` 的 `onRehydrateStorage` **无条件**跑一次 `migratePlanV3`（现在 `migrate` 只在 `version !== 1` 时触发而 version 恒 1 → 降级场景永不触发，必须修）。

## 7. 诊断同链（§4.5）

1. 诊断入口先 `validate` → `prune`，用**剔除后的 plan** 做全部诊断。
2. 诊断返回值带 `warnings`，与列表命令返回**同一批**。
3. 被剔除的条件不再诊断（用户通过 warning 得知「被忽略」，而不是一条 `selfCount=0`）。
4. `count_plan` 复用 `compile_search_plan`，不许另写 SQL。

```rust
pub struct PlanDiagnostics {
    pub leaves: Vec<LeafDiagnostic>,     // 带 zone
    pub should: Vec<ShouldDiagnostic>,   // 带 index
    pub warnings: Vec<SearchWarning>,    // 与列表命令同批
}
```

诊断交集（B3）：`solo.filter = AND(plan.filter, leaf)` + 带 `plan.must_not`，`should` 置空、`min=0`。
诊断异步返回带 `planRevision`，过期整批丢弃（§3.7 第 9 条）。

## 8. 全选截断策略（§4.6）

| 操作 | `truncated = true` 时 |
|---|---|
| 删除（移入回收站） | **禁止**。置灰 + 提示「当前结果超过 100000 张，请先收窄条件再删除」 |
| 导出 / 移动 | 允许但二次确认（「将导出已选中的 100000 张（共 N 张）。继续？」） |
| 批量打标 / 送 AI | 允许但二次确认 |
| 收藏 / 评分 | 允许，只提示不拦 |
| 反选 | **禁止**（截断集合上反选无定义） |
| 计数显示 | 恒显示 `已选 100000 / N` |

落点：`fetchAllIds(): Promise<FetchAllIdsResult>` → `AssetGridView` 决定菜单 `disabled` 与确认弹窗；`selectionStore` 记 `truncated` + `total`。

## 9. AI「追加模式」合并（§4.8）

| 字段 | 合并规则 |
|---|---|
| `filter` | **AND 合并，保留内部 OR**（`mergeQueryExpr`），按序列化去重相同叶子 |
| `mustNot` | **OR 合并**（同样去重） |
| `should` | 拼接，按 `serialize(cond)` 去重；超 `MAX_SHOULD_CLAUSES = 12` 按权重降序保留前 12，丢的记 warning |
| `minimumShouldMatch` | `old.should 空 ? new_min : old_min`，最后 `clamp(0, len)`；与保留值不同记 info warning |
| `ranking` | **append 恒保留用户的**；AI 建议不同 → warning。**replace 才采纳 AI 的** |
| `retrievers` | append 保留旧的；replace 采纳新的 |
| 版本号 | 取当前常量值 |
| `aiWarnings` | 替换为本次解析 + 合并产生的 warning |
| `executionWarnings` | 不参与（生命周期跟每次 refresh） |
| `resolvedTags` | 按 tagId 合并去重 |
| `evidence` | 随各自 ShouldClause（**`ShouldClause` 新增 `evidence: Option<String>`**，build_plan_from_v3 现在把原文拼进 label 丢了） |

replace 与 append 只差 `ranking` 与 `retrievers`。合并成功 `planRevision + 1`。

## 10. warning 双通道（B7）

```ts
export type PlanWarningSource = "ai" | "plan";
export interface SearchWarning {
  source: PlanWarningSource;
  zone?: "filter" | "should" | "mustNot";
  message: string;
}
```

store：`aiWarnings`（生命周期跟 AI 解析）/ `executionWarnings`（生命周期跟每次 refresh：请求开始清空、响应写入）。渲染合并、按来源分组、`source="plan"` 带区名前缀。两者永不互相清空。

## 11. store 九条不变式与 zone 路径（§3.7）

1. 手工改必须区不清 AI 优先项（`setPlanFilter` 只动 `plan.filter`）
2. 排除条件只存在于 `plan.mustNot`（AI 摄入剥 exclusions）
3. 清空某一区 ≠ 清空 plan（三区全空才 `plan = null`）
4. `min = clamp(min, 0, should.len())`，should 空时 `min = 0`
5. 持久化只存 `plan` + `query.sortBy/sortDir`
6. `FilterChips` 删除路径带区标识：`removeAtZonePath(zone, path)`
7. 两条 warning 通道互不清空
8. 字段排序为主键 + score 次级；UI 明示「优先条件仅用于同值时的先后」
9. 诊断自带 `zone` + `planRevision`（过期整批丢弃）

## 12. 折叠态摘要（§3.9）

折叠时保留：三区摘要徽标（`必须 3 · 优先 2 · 排除 1`，点击展开并滚到对应区）、warning 黄条（不随折叠隐藏）、排序说明、`＋` 快速添加。不保留条件行与诊断数字。实现只改 `SuperSearchPage` header 区结构，`QueryBuilder` 本体不动。

---

## 13. 契约测试清单（§4.7 · 35 条）

| 来源 | 条数 | 测试 |
|---|---|---|
| §4.1a | 3 | `resolved_query_to_plan_covers_all_flat_fields` / `exclude_tag_ids_become_positive_tag_in_must_not` / `facet_filter_mode_and_descendants_survive` |
| §4.1b | 4 | `must_not_single_exclusion_excludes_not_includes` / `must_not_multiple_exclusions_are_or_semantics` / `validate_rejects_exclude_tag_in_must_not` / `validate_rejects_not_node_in_must_not` |
| §4.2 | 4 | `must_not_invalid_leaf_is_removed_not_negated` / `should_invalid_clause_is_removed_not_always_true` / `min_should_converges_after_should_pruned` / `prune_reports_zone_in_warning` |
| §4.3 | 5 | `validate_rejects_bad_weight` / `validate_rejects_min_gt_should_len` / `validate_rejects_bad_dir` / `validate_rejects_nonpositive_retriever_weight` / `validate_rejects_future_schema_version` |
| §4.4 | 4 | `plan_missing_version_defaults_to_current` / `diagnose_also_rejects_future_version` / `future_plan_discarded_on_hydrate` / `persisted_plan_hydrates_and_executes` |
| §4.5 | 2 | `diagnose_uses_same_pruned_plan_as_list` / `pruned_leaf_is_not_diagnosed` |
| §4.6 | 3 | `truncated_ids_block_delete_and_invert` / `truncated_ids_require_confirm_for_export` / `selection_bar_shows_partial_count` |
| §4.8 | 4 | `append_and_merges_filter_keeps_inner_or` / `append_or_merges_must_not` / `append_concats_should_and_caps_at_12` / `append_never_changes_user_ranking` |
| B2 | 2 | `plan_list_and_ids_return_same_set` / `plan_ids_respect_ranking_order` |
| B3 | 1 | `should_hit_count_is_intersection_with_result_set` |
| B6 | 1 | `empty_filter_with_should_min_zero_returns_all` |
| B9 | 1 | `field_ranking_uses_should_score_as_tiebreak` |
| §3.7 | 1 | `leaf_diagnostic_carries_zone_and_revision` |
| **合计** | **35** | |
