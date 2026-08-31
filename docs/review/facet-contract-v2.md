# 分面协议 v2（facet-contract-v2.md）

> 冻结分面协议（W2 分面契约 + V20 合表 + W5 收尾后的唯一事实源）。
> 任何改动必须先更新本文档再动代码。

## 1. 数据模型（V20 合表后）

`tag_facets` 是分面的**唯一事实源**。`settings.aiFacetConfigs` 已在 V20 迁移中废除（JSON 侧数据清空，语义全部搬入 tag_facets）。

| 字段 | 语义 | 约束 |
|---|---|---|
| `key` | 分面唯一标识（AI 打标 / 工作台 / 提示词共用） | 小写字母/数字/下划线，创建后不可修改 |
| `display_name` | 显示名（UI 与提示词） | 非空 |
| `description` | 一句话说明（V20 前为 hint，已并入；提示词据此指导模型） | — |
| `selection_mode` | `single` = 单选（max_items 强制 1）；`multi` = 多选 | 非空 |
| `max_items` | 多选上限；`NULL` = 不限 | multi 下为正整数或 NULL |
| `applies_to` | `all` / `image` / `video`（工作台按媒体类型分组） | 非空 |
| `input_mode` | `ai_and_manual` = 参与 AI 打标 + 手工；`manual_only` = 仅手工 | 非空 |
| `status` | `active` / `inactive`（停用后不进提示词、工作台仍可手工打标） | — |

## 2. `resolve_facet_key` 三条分支（AI 返回 key 的归一化路由）

```
resolve_facet_key(conn, raw) -> (key, display_name)
├─ ① raw 在 tag_facets 表中（含自建分面）→ 原样返回
├─ ② raw 命中中文旧名表 且 映射 key 在 DB → 返回映射 key
└─ ③ 都不中 → 返回 ("custom", "custom") + warning
```

- 自建分面**天然生效**：只要 key 在 DB，分支 ① 直接命中，无需任何配置。
- 中文旧名表（`key_for_legacy_name`）只服务历史 CategorizedTags JSON 的解析，**不再作为路由入口**。
- 分支 ③ 落 `custom` 的语义：该分类不存在、停用或 `manual_only`（AI 输出了不参与 AI 的分类）。

## 3. `input_mode` 语义

| input_mode | 进 AI 提示词 | 工作台 AI 组 | 工作台手工组 | 手工可打标 |
|---|---|---|---|---|
| `ai_and_manual` | ✅ | ✅ | ✅ | ✅ |
| `manual_only` | ❌ | ❌ | ✅ | ✅ |

- `build_prompt_context` 只取 `status='active' AND input_mode='ai_and_manual'`。
- 手工组始终显示 `manual_only` 分面（打标层语义独立于 AI 层）。

## 4. 级联删除规则（delete_facet 顺序）

删除分面按此顺序级联清理（一条事务内）：

```
tag_facets
  └─ asset_tags        （该分面下所有标签的关联）
  └─ tag_ops           （打标流水）
  └─ ai_suggestion_items
  └─ tag_aliases
  └─ tags
```

- 系统分面（subject/scene/purpose/style/color/composition/lighting/people/technical/custom）不可停用、不可删除。
- 删除返回 `FacetImpact { tagCount, assetCount, aiSuggestionItemCount, tagOpCount }`，前端确认弹窗展示精确数字。

## 5. 关键不变量

1. `key` 创建后不可修改（改 key = 重建分面 + 迁移标签）。
2. 新列只允许追加到表尾（rusqlite COLUMNS 位置映射，严禁插中间）。
3. 合并标签只允许同分面内；禁止合并到自身后代。
4. 手工覆盖清 `source_batch_id`（撤销 AI 批次不得误删手工确认标签）。
5. AI 打标建议的标签经 `resolve_facet_key` 归一化后才进 `tag_ops`。

## 6. 相关文件

- 迁移：`src-tauri/src/db/migrations.rs`（V19/V20/V21）
- 路由：`src-tauri/src/db/tag_facets.rs`（resolve_facet_key / build_prompt_context / update_facet / delete_facet）
- 前端工作台：`src/components/ai/Workbench.tsx` + `src/stores/tagStore.ts`（buildWorkbenchFacets）
- 设置管理：`src/components/settings/FacetManagePanel.tsx`
