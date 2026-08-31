# 超级搜索查询协议 V2（SearchIntentV2 → QueryExpr）

> 版本：v2（W6 健壮化冻结）
> 日期：2026-08-31
> 依据：`开发执行计划书-定稿-2026-08-31.md` W6 + `super-search-contract-v1.md`（历史协议，V1 已由 V2 取代）
> 性质：机器协议，不可随意变更；变更必须同步改 schema / TS / Rust / 测试矩阵。

本文档定义超级搜索二期协议：SearchIntentV2 结构、JSON Schema enum 收窄、三层降级、部分剔除规则、`facet_has_any` / `facet_missing` 语义。

---

## 1. 两层查询对象（V2）

```
SearchIntentV2          ← AI 生成（groups/concepts/textTerms/metadata/exclusions/sortBy/sortDir）
   ↓ 后端解析 + 三层降级 + 校验
QueryExpr               ← 唯一执行事实源（前端从 expr 构建筛选树，不再反推扁平条件）
```

- AI 只生成 `SearchIntentV2`，不生成 tagId / assetId / SQL / 分页。
- 后端 `build_expr_from_v2` 把 intent 解析成 `QueryExpr`；前端只消费 expr。
- 排序单独返回（sortBy / sortDir），与 expr 并列。

## 2. SearchIntentV2（AI 允许输出的形状）

```json
{
  "groups": [
    {
      "assetType": "all",            // all | image | video
      "concepts": [
        { "text": "海边", "role": "scene", "facetHint": "scene", "confidence": 0.9 }
      ],
      "textTerms": [ { "text": "IMG_1097", "scope": "fileName" } ],
      "metadata": [ { "key": "file_size", "op": "between", "min": 10485760, "max": 110100480 } ]
    }
  ],
  "exclusions": [ { "text": "夜景", "role": "lighting", "facetHint": "lighting", "confidence": 0.9 } ],
  "sortBy": "created_at",            // 或 null
  "sortDir": "desc"                  // asc | desc | null
}
```

语义：组内 AND、组间 OR；exclusions 全局 NOT；metadata 用规范 key/op/单位。

### 2.1 JSON Schema enum 收窄（W6-1）

- `facetHint`：enum = **实时分面 key**（新建分面后自动包含；支持 json_schema 的服务商在服务端拒绝非法 key）。
- `metadata.key`：enum = METADATA_KEYS 白名单常量。
- `metadata.op`：enum = METADATA_OPS（eq/in/gt/gte/lt/lte/between/contains）。
- `textTerms.scope`：enum = all/content/description/fileName。
- `assetType`：enum = all/image/video。
- `sortDir`：enum = asc/desc。

## 3. 三层降级（W6-2，永不红字报错）

| 层 | 触发 | 结果 |
|---|---|---|
| ① strict | AI 返回合法 JSON + 全部条件合规 | 正常解析执行 |
| ② lenient | 部分条件非法（未知 facetHint / 非法 op / 非法值 / 空组） | 剔除非法项保留其余 + warning |
| ③ keyword | 非 JSON / 空 groups / 剔除后全空 / 结构校验失败 | `QueryExpr::Leaf{Search{原句}}` + explanation「按关键词搜索」，**永不失败** |

**例外**：`is_config_error`（鉴权 / 连不上 / 超时）仍真报错 —— 配置问题必须让用户知道。

### 3.1 部分剔除规则（W6-3，原则「能救一条算一条」）

| 输入 | 处理 |
|---|---|
| `sortBy` 非法 | → 默认（created_at）+ warning |
| `sortDir` 非法 | → 默认（desc）+ warning |
| `assetType` 非法 | → all + warning |
| 单条 `metadata` 非法 | → 剔除该条保留其他 + warning |
| `concept.facetHint` 未知 | → 清空 hint（降级全分面搜索）+ warning |
| 空 concept / 空 textTerm | → 剔除 |
| 某 group 全空 | → 剔除该 group + warning |
| 全部 group 被剔除 / 结构校验失败 | → 落第 3 层 |

## 4. 执行对象补充（facet_has_any / facet_missing）

除精确标签筛选外，V2 支持两类「缺 / 有」条件（配合 W5g 精准补漏）：

- `facet_has_any(facetKey)`：该分面下**至少有一个**标签的素材（如「有主体标签的图片」）。
- `facet_missing(facetKey)`：该分面下**没有任何**标签的素材（如「没有场景标签的图片」）。

两者进 `QueryExpr` 作为 leaf 条件，前端与精确标签条件混排，后端 `query_expr.rs` 编译。

## 5. 关键不变量

1. `expr` 是唯一执行事实源；前端不得从扁平 query 反推筛选树。
2. AI 结果经本地 `guard_intent` 确定性守卫（OR 合并 / assetType 纠偏 / concept 清洗 / confidence 钳制）后才执行。
3. 解析状态三态（W6-5）：`full`（完全理解）/ `partial`（部分理解 + warning）/ `keyword`（按关键词搜索），前端据此渲染黄字而非红字。
4. metadata 条件校验以 `search_query::compile_metadata` 为唯一判定（sanitize 与执行层同一校验，绝不漂移）。

## 6. 相关文件

- 协议结构：`src-tauri/src/services/super_search_ai.rs`（SearchIntentV2 / intent_schema / degrade_parse / sanitize_all / guard_intent）
- 执行编译：`src-tauri/src/db/query_expr.rs` + `src-tauri/src/db/search_query.rs`
- 命令壳：`src-tauri/src/commands/super_search_cmd.rs`
- 前端：`src/stores/superSearchStore.ts` + `src/components/supersearch/AiSearchBar.tsx`
