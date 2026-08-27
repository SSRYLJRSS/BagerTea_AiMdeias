# 超级搜索查询协议 V1（SearchIntent / ResolvedSearchQuery）

> 版本：v1 冻结版  
> 日期：2026-08-25  
> 依据：`超级搜索最终执行开发路径说明书-2026-08-25.md` P0  
> 性质：机器协议，不可在后续阶段随意变更；变更必须同步改 schema / TS / Rust / 测试矩阵。

本文档定义超级搜索一期使用的两层查询协议、稳定分面映射、操作符、日期与单位语义。它是后续所有 AI 与前端实现的唯一依据。

---

## 1. 两层查询对象

```
SearchIntent            ← AI 生成（只能含标签文字/分面提示/元数据条件/排序意图）
   ↓ 后端解析校验
ResolvedSearchQuery     ← 后端/前端执行对象（含已解析 tagId、合法字段、规范单位）
```

- AI 只生成 `SearchIntent`，**不生成** `tagId`、`assetId`、SQL、列名、limit、offset、trashOnly。
- 后端负责把 `SearchIntent` 解析成 `ResolvedSearchQuery`，标签文字解析为 tagId。
- 前端只消费 `ResolvedSearchQuery`，不识别 AI 原始输出。

---

## 2. SearchIntent（AI 允许输出的形状）

```json
{
  "search": "",
  "assetType": "all",
  "tags": [
    { "facetKey": "scene", "text": "海边", "includeDescendants": true }
  ],
  "excludeTags": [
    { "facetKey": "lighting", "text": "夜景" }
  ],
  "metadata": [
    { "key": "file_size", "op": "gte", "value": 5242880 }
  ],
  "sortBy": "resolution",
  "sortDir": "desc"
}
```

字段语义：

| 字段 | 类型 | 说明 |
|---|---|---|
| `search` | string | 关键词；进入现有 FTS/LIKE 链路 |
| `assetType` | `"all"\|"image"\|"video"` | 类型过滤 |
| `tags[]` | array | 标签条件（含分面提示 + 文字）；同分面默认 OR |
| `excludeTags[]` | array | 排除标签（文字）；默认排除后代 |
| `metadata[]` | array | 元数据比较条件（key + op + 值） |
| `sortBy` | string | 排序意图 |
| `sortDir` | `"asc"\|"desc"` | 排序方向 |

AI **禁止**输出：

```text
tagId
assetId
SQL / SQL 片段
列名（columnName）
limit / offset / trashOnly
schema 之外的任意字段
```

标签的 `text` 只允许是**规范名称或别名文字**，不允许是 ID。

---

## 3. ResolvedSearchQuery（执行对象）

```json
{
  "search": "",
  "assetType": "all",
  "untaggedOnly": false,
  "facetFilters": [
    { "facetKey": "scene", "tagIds": [8], "mode": "any", "includeDescendants": true }
  ],
  "excludeTagIds": [44],
  "missingFacetKeys": [],
  "metadataFilters": [
    { "key": "file_size", "op": "gte", "value": 5242880 }
  ],
  "sortBy": "created_at",
  "sortDir": "desc"
}
```

分页（offset / limit）**不属于该对象**，由前端调用查询命令时另行携带。`trashOnly` 永远不进入该对象，超级搜索默认不查询回收站。

字段语义：

| 字段 | 类型 | 说明 |
|---|---|---|
| `search` | string | 关键词 |
| `assetType` | `"all"\|"image"\|"video"` | 类型 |
| `untaggedOnly` | boolean | 是否只查未打标 |
| `facetFilters[]` | array | 已解析的分面标签条件（tagIds 为后端解析结果） |
| `excludeTagIds[]` | array | 排除标签 id（含后代） |
| `missingFacetKeys[]` | array | 「缺少某分面标签」的治理条件（二期可扩展） |
| `metadataFilters[]` | array | 元数据比较条件 |
| `sortBy` | string | 排序字段 |
| `sortDir` | `"asc"\|"desc"` | 排序方向 |

---

## 4. 元数据操作符

一期只保留以下操作符（已删除 `neq` 与通用 `prefix`）：

```text
eq
in
contains
gt
gte
lt
lte
between
```

每个 key 只开放必要操作：

| key 类型 | 允许操作 |
|---|---|
| 格式、编码 | `eq`、`in` |
| 相机、镜头 | `eq`、`in`、`contains` |
| 数值 | `eq`、`gt`、`gte`、`lt`、`lte`、`between` |
| 时间 | `gte`、`lte`、`between` |
| 文件夹 | 内部专用路径前缀，**不开放通用 prefix** |

### 字段白名单与允许操作

| key | 值类型 | 允许 op | 底层表达式 |
|---|---|---|---|
| `file_ext` | string | eq，in | `lower(a.file_ext)` |
| `mime_type` | string | eq，in | `a.mime_type` |
| `camera` | string | eq，in，contains | `a.camera`（contains 小写） |
| `lens` | string | eq，in，contains | `a.lens` |
| `video_codec` | string | eq，in，contains | `lower(a.video_codec)` |
| `audio_codec` | string | eq，in，contains | `lower(a.audio_codec)` |
| `shutter` | string | eq，in，contains | `a.shutter` |
| `iso` | number | eq，gt，gte，lt，lte，between | `a.iso` |
| `aperture` | number | eq，gt，gte，lt，lte，between | `a.aperture` |
| `focal` | number | eq，gt，gte，lt，lte，between | `a.focal` |
| `width` | number | eq，gt，gte，lt，lte，between | `a.width` |
| `height` | number | eq，gt，gte，lt，lte，between | `a.height` |
| `resolution` | number | eq，gt，gte，lt，lte，between | `a.width * a.height` |
| `aspect_ratio` | number | eq，gt，gte，lt，lte，between | `CAST(a.width AS REAL)/a.height` |
| `file_size` | number（字节） | eq，gt，gte，lt，lte，between | `a.file_size` |
| `duration_ms` | number（毫秒） | eq，gt，gte，lt，lte，between | `a.duration_ms` |
| `taken_at` | date | gte，lte，between | `a.taken_at` |
| `created_at` | date | gte，lte，between | `a.created_at` |
| `modified_at` | date | gte，lte，between | `a.modified_at` |
| `folder` | 路径 | 内部路径前缀 | `a.file_path` |

如果后续继续裁剪操作符，必须同时修改 schema、TS、Rust 与测试矩阵。

---

## 5. 稳定分面映射

`tag_facets.key` 是稳定机器协议。分面显示名称可本地化，稳定 key 不可修改。

| 旧名称 | 目标 key |
|---|---|
| 主体 | `subject` |
| 物体 | `subject` |
| 场景 | `scene` |
| 用途 | `purpose` |
| 风格 | `style` |
| 色彩风格 | `style` |
| 色彩 | `color` |
| 氛围情绪 | `style` |
| 构图视角 | `composition` |
| 光线 | `lighting` |
| 人物 | `people` |
| 技术 | `technical` |
| 未知分类 | `custom` |

一期保持现有映射，**不新增 mood 分面**（「氛围情绪」已映射到 `style`，避免无意义重分面）。

标签配置最终规则：

- `tag_facets` 是唯一事实源；
- `selection_mode` / `max_items` 以数据库为准（设置页不再存第二份副本）；
- 设置只保存 `facetKey`、`hint`、`enabledForAi`、可选本地化名称；
- 旧 `TagCategory.name` 仅作为迁移输入；
- 设置页不能修改 `facetKey`；
- AI 打标与 AI 搜索读取同一 `FacetPromptContext`。

---

## 6. 日期、单位与 NULL 语义（必须冻结）

- 日期范围使用**左闭右开**：`[min, max)`。
- `2025 年` = `2025-01-01` 至 `2026-01-01`。
- 相对日期使用**当前本地时区**。
- `taken_at` 缺失时不回退 `created_at`。
- 文件大小内部单位为**字节**。
- 视频时长内部单位为**毫秒**。
- `5MB` 按 `5 * 1024 * 1024` 解释。
- `resolution` 为 `width * height`（像素面积）。
- `aspect_ratio` 为 `width / height`。
- `width`/`height` 为 NULL，或 `height = 0` 时不参与宽高比比较。
- 比较字段为 NULL 时**不命中**。

---

## 7. 查询语义（后端编译）

- 同一分面内默认 OR（`mode=any`），可切换 ALL。
- 不同分面之间用 AND。
- 父标签默认包含后代，可切换仅当前节点。
- 排除标签默认包含后代。
- 比较字段为 NULL 时不命中。
- 超级搜索默认不查询回收站。
- 排序最后必须加入 `a.id DESC`（保证分页稳定）。
- 所有查询值参数绑定；列名与操作符来自白名单编译，不接受外部输入拼接。
- AI 解析失败不能破坏当前查询状态。

---

## 8. AI 语义

- AI 输出 `SearchIntent`；后端输出 `ResolvedSearchQuery`。
- 默认用 AI 结果**替换**当前条件；追加条件必须由用户明确选择。
- AI 返回的所有条件都要回填到 UI。
- warning 是可恢复状态，不是致命错误。
- 删除条件后只重新执行查询，不重新调用 AI。
- AI 搜索零数据库写入（不创建标签、不修改素材）。
