# 超级搜索功能调研与设计报告

> 日期：2026-08-24
> 范围：素材库「超级搜索」= 双击底栏中部「素材库」进入，包含「超级筛选」与「AI 智能搜」
> 状态：方案待老板确认，确认后先更新 PRD / PROGRESS 再动代码（项目铁律）

---

## 0. 结论速览

1. **本仓库已经有约六成地基**：多标签分面筛选（`facetFilters`）、标签排除（`excludeTagIds`）、标签稳定分面（`tag_facets`）、标签别名（`tag_aliases`）、多档案 AI 服务（OpenAI 兼容 + Anthropic）、FTS5 中文搜索都已就绪。超级搜索不是从零开始，而是把现有能力从「224px 的窄侧栏」升级成「完整工作台」。
2. **AI 智能搜不建议让模型直接生成并执行 SQL**。建议让 AI 生成一个**受控 JSON 筛选描述（SearchQuery）**，后端做白名单校验、标签解析、参数化 SQL 编译后再查询。这样更安全、可解释、可测试，也更容易让用户在界面上二次修改。
3. **超级筛选与 AI 智能搜必须共用同一条查询链路**：AI 解析出的结果就是一套超级筛选条件，用户可以看到、修改、保存。这样两条能力不会变成两套后端逻辑。
4. **入口成本很低**：`BottomBar` 当前只处理单击导航，补一个「单击延时 + 双击取消」的通用处理即可，不需要改 Tauri 窗口或路由库。
5. **本地查出的两个半成品必须一起补**：
   - 前端已有 `metadataFilters` / `listMetadataFacets()`，但 Rust 的 `AssetFilter` 没有 `metadata_filters` 字段（当前传入会被静默忽略）；
   - `list_metadata_facets` 前端命令封装存在，但 Rust `assets_cmd.rs` 没有对应 command handler（调用会直接报 command not found）。
   所以「超级筛选能筛得更多」的底座需要先把元数据筛选补齐。

---

## 1. 需求理解

### 1.1 入口
- 双击底部中间「素材库」按钮进入超级搜索。
- 单击仍保留现有行为：切到素材库页。
- 从任何页面双击都应能进入；退出后回到进入前的页面或素材库页。

### 1.2 超级筛选
- 相比当前素材库左侧栏（`w-56`，约 224px，只放「类型 + 标签树」），超级搜索拥有整页空间。
- 目标是把已有和可用的筛选维度全部铺开：类型、未打标、标签分面、标签排除、文件格式、尺寸/分辨率、文件大小、拍摄时间、入库时间、修改时间、相机/镜头/ISO/光圈/快门/焦距、视频时长、排序等。
- 所有条件可见、可组合、可一键清除。

### 1.3 AI 智能搜
- 用户在输入框用自然语言描述，例如：
  - 「2025 年拍的横构图海边素材，大小 5MB 以上，不要夜景」
  - 「暖色调、清新风格的人像，按分辨率从高到低」
  - 「去年夏天用 Sony 拍的视频，时长 10 秒以上」
- 系统调用**现有在线 AI 服务配置**，把自然语言转成结构化筛选条件，并执行搜索。
- 提示词、schema、示例由后台自动组装，用户只输入一句话。
- 解析结果要**回填成可见的条件芯片**，用户可微调，而不是黑盒出结果。

### 1.4 风格
- 严格沿用 `docs/UI_DESIGN_SYSTEM.md`：黑白灰高级感、CSS 变量、`.ui-section-title` / `.ui-nav-item` / `.ui-control`、细分隔线、低饱和状态色。
- 页面是完整新界面（类似查看器），不透明，不悬浮半透明窗。

---

## 2. 本地代码现状盘点（调研结果）

### 2.1 入口与页面骨架

| 文件 | 现状 | 与超级搜索的关系 |
|---|---|---|
| `src/App.tsx` | `PageKey = TabKey \| "settings"`，`useState` 管理 4 页，`main` 按 `page` 条件渲染 | 需增加 `"superSearch"` 页；设置页已有「返回上一页」先例可复用 |
| `src/components/layout/BottomBar.tsx` | `TABS` 为入库/素材库/打标，按钮只有 `onClick`；素材库按钮居中 | 给素材库按钮加 `onDoubleClick`；处理双击时避免第一次单击先切页 |
| `src/pages/LibraryPage.tsx` | `GridToolbar + SideBar + AssetGrid + 弹窗组` | 超级搜索页可复用弹窗与批量动作，但网格数据源需要解耦 |

### 2.2 筛选与数据流

| 文件 | 现状 |
|---|---|
| `src/stores/libraryStore.ts` | `LibraryFilter` 已经声明了 `facetFilters / excludeTagIds / metadataFilters`，`setFilter` 已做深度比较、刷新、清选；但**没有 UI 使用 `metadataFilters`** |
| `src/types/asset.ts` | 已有 `FacetTagFilter`、`MetadataFilterKey`、`MetadataFilter {key, values}`、`MetadataFacet`；但 `MetadataFilter` 只有 `key + values`，表达不了「大于 / 小于 / 区间 / 排除」 |
| `src/api/assets.ts` | 已有 `listMetadataFacets()` 封装，调用 `list_metadata_facets` 命令 |
| `src-tauri/src/db/assets.rs` | `AssetFilter` 支持 `tag_id / tag_ids / tags_mode / facet_filters / exclude_tag_ids / search / sort_by / sort_dir / trash_only`；**没有 `metadata_filters` 字段**，前端传了会被 serde 忽略 |
| `src-tauri/src/commands/assets_cmd.rs` | 只有 `list_assets / list_asset_ids / get_asset / delete_assets / ...`；**没有 `list_metadata_facets`** |
| `src-tauri/src/db/search.rs` | FTS5（cjk_bigram 短语 + 纯 CJK 2 字块 AND + LIKE 兜底）；搜索范围当前为 `file_name + 标签名 + 可搜索别名` |
| `src-tauri/src/db/tag_facets.rs` | `tag_facets` 稳定分面表：subject/scene/purpose/style/color/composition/lighting/people/technical/custom |
| `src-tauri/src/db/tags.rs` | 标签有 `normalized_name`、`facet_key`、别名查询 `search_candidates`，非常适合做「AI 返回标签名 → 后端解析成 tagId」 |

### 2.3 素材表里已经可用的元数据字段

`assets` 表（`src-tauri/src/db/migrations.rs` + `assets.rs`）：

- 文件属性：`file_ext / file_size / mime_type / width / height / duration_ms / video_codec / audio_codec`
- 时间：`taken_at / created_at / modified_at`
- EXIF：`camera / lens / iso / aperture / shutter / focal`
- 标签：`asset_tags + tags`（含分面、父子层级、别名）
- 状态：`deleted_at`（回收站）

也就是说，「筛选得更多」的数据基础基本都有了，主要缺的是**结构化查询协议 + 界面**。

### 2.4 AI 服务现状

| 文件 | 现状 | 可复用程度 |
|---|---|---|
| `src-tauri/src/db/settings.rs` | `AiSettings.profiles[] + active_profile`；`ApiProfile` 支持 `kind=cloud/local`、`api_mode=openai/anthropic` | 直接复用，不需要新配置体系 |
| `src-tauri/src/services/ai_cloud.rs` | OpenAI 兼容 `/chat/completions` 与 Anthropic `/messages` 两种请求；`build_prompt` 面向「图片打标」；`parse_categorized` 宽容 JSON 解析 | **需要抽出一个纯文本 JSON 请求函数**，把 HTTP 协议分支与 JSON 解析复用起来，避免复制粘贴 |
| `src-tauri/src/commands/ai_cmd.rs` | `ai_list_models` 已示范网络请求走 `spawn_blocking`；打标批次的 DB 锁纪律是现成模板 | AI 搜索命令照此模板写 |

关键约束（项目铁律）：
- commands 是薄壳，业务放 services，SQL 放 db；
- 网络请求不持 DB 锁，DB 锁要短；
- 前端不直接 `invoke`，一律走 `src/api/`；
- 所有 UI 颜色走 CSS 变量。

### 2.5 两个「半成品」结论

1. `metadataFilters`：类型与 store 已经预留，但 Rust `AssetFilter` 未实现 → 现在是死参数。
2. `listMetadataFacets`：前端封装存在，Rust 命令不存在 → 当前调用会失败。

这两个点应在超级搜索 P0 一起补齐，否则「筛得更多」没有后端支撑。

---

## 3. 竞品调研

本轮调研以官方帮助文档为主，主要看三类：专业素材管理软件、专业摄影管理软件、自托管相册/数据库 AI 查询。

### 3.1 直接竞品

#### Eagle
- 入口：顶部筛选器 + 搜索栏；筛选器支持「+」把常用筛选加入固定位置。
- 筛选维度（官方帮助 `interface-filter`）：关键字、标签、颜色、形状、尺寸、宽高比、格式、评分、时间、文件大小、标注、注释、链接、BPM、已安装字体等。
- 智能文件夹（`smart-folders`）：多组条件组合，组内支持「全部 / 任一项」，可保存为常驻筛选。
- AI Search 插件（2026-03 发布）：
  - 自然语言搜索：针对文件名、描述、备注等**已有文字信息**做语义匹配；
  - 以图搜图：本地运行；
  - 定位很克制：不取代文件夹/标签，而是补一种更直观的查找方式。
- 借鉴点：
  - 「筛选器 = 可叠加条件 + 可保存」；
  - AI 搜索与普通筛选放在同一套筛选器心智里；
  - AI 能力明确说明边界（它搜的是文字信息，不是凭空理解画面）。

#### Billfish
- 官方帮助：顶部搜索框搜文件名、标签、备注、来源；筛选栏支持颜色、形状、导入时间、类型、尺寸、评分、文件大小。
- 搜索范围随左侧选中范围（全部库或指定文件夹）。
- 借鉴点：筛选维度贴近国内设计师习惯，交互比 Eagle 更简单。

#### Pixcall
- 官方文档 `search-and-filter`：
  - 搜索范围 = 左侧选中目录；
  - 关键字、文件名、颜色、文件夹、标签、类型、形状等筛选；
  - 进入筛选模式后排序改为综合因素。
- 官方文档「看板」：
  - 筛选结果可保存为看板；
  - 看板内继续筛选可生成子看板，条件 = 父看板 + 子看板；
  - 支持手动拖入/移出文件，不产生副本。
- 借鉴点：「保存的筛选」作为一等公民，后续做「智能文件夹」时非常值得参考。

### 3.2 摄影管理软件

#### Adobe Lightroom Classic
- 典型模式：图库过滤器（Library Filter）按元数据列叠加筛选；智能收藏集保存多条件组合。
- 借鉴点：元数据筛选不是把几十个控件全堆出来，而是「按维度分组 + 值列表 + 条件叠加 + 可保存」。

#### Immich
- 自托管相册，搜索 = 结构化元数据筛选 + CLIP 自然语言/相似图语义搜索。
- 借鉴点：元数据搜索和语义搜索是**两条互补链路**，不要用 LLM 替代精确元数据筛选。

### 3.3 AI 查询类产品

#### Notion AI Q&A / Airtable AI
- 共同做法：自然语言 → 内部结构化查询/公式 → 展示答案与依据，**不把原始 SQL 暴露给模型自由发挥**。
- 借鉴点：生成受控中间表示（DSL/JSON），后端编译执行，是成熟且安全的路子。

### 3.4 调研结论映射到本项目

| 竞品做法 | 本项目落地建议 |
|---|---|
| Eagle 筛选器多条件叠加、可 Pin、可保存 | 超级搜索页左侧分面面板 + 顶部条件芯片 + 预留「保存筛选」 |
| Pixcall 看板（保存筛选 + 子筛选） | 二期做 `saved_filters` 表，先不做手动拖入 |
| Lightroom 元数据按维度分组 | 元数据筛选器按「文件属性 / 时间 / 拍摄设备 / 视频」分组，不堆平铺 |
| Eagle AI Search 明确边界 | AI 智能搜先做「自然语言 → 标签/元数据/关键字筛选」，不假装理解像素内容；画面理解留给未来 CLIP/embedding |
| Notion/Airtable 中间表示 | AI 输出 `SearchQuery` JSON，后端白名单校验 + 参数化 SQL，禁止 AI 直接生成 SQL |

---

## 4. 推荐总体设计

### 4.1 核心原则

1. **一个查询模型，两条入口**：手动超级筛选和 AI 智能搜都落到同一个 `SearchQuery`；AI 只是「生成 SearchQuery 的一种输入方式」。
2. **AI 不吐 SQL，只吐结构化 JSON**。SQL 永远由 Rust 白名单编译，所有值走参数绑定。
3. **先解析、后执行、可修改**。AI 结果先回填为可见条件芯片，用户确认/修改后执行；或解析后自动执行但保留芯片可改。
4. **沿用现有分页、缩略图、选中、批量操作链路**。不要另写一套网格。
5. **无 AI 配置时超级筛选仍完整可用**。AI 是增强，不是前置依赖。

### 4.2 数据模型：`SearchQuery`

建议新增统一查询协议（Rust serde camelCase 与 TS 对齐），不要把分页字段混进去：

```jsonc
{
  "search": "海边",                  // 关键字，走现有 FTS5 + LIKE
  "assetType": "image",              // all | image | video
  "untaggedOnly": false,
  "trashOnly": false,                // 超级搜索默认永远 false
  "tagIds": [12, 33],                // 多标签，可选 any/all
  "tagsMode": "any",
  "facetFilters": [
    {
      "facetKey": "scene",
      "tagIds": [8],
      "mode": "any",                 // 同一分面内 any/all
      "includeDescendants": true
    }
  ],
  "excludeTagIds": [44],             // 排除某标签及其后代
  "metadataFilters": [
    { "key": "taken_at",     "op": "between", "min": "2024-01-01", "max": "2025-12-31" },
    { "key": "width",        "op": "gte",     "value": 2000 },
    { "key": "file_ext",     "op": "in",      "values": ["png", "webp"] },
    { "key": "camera",       "op": "contains", "value": "Sony" }
  ],
  "sortBy": "resolution",
  "sortDir": "desc"
}
```

说明：
- `facetFilters / excludeTagIds / search / sortBy / sortDir` 直接复用现有 `AssetFilter` 语义，改动最小。
- `metadataFilters` 升级为 `key + op + 值` 结构，替代现在只有 `{key, values}` 的前端类型。
- `tagIds + tagsMode` 是可选的全局标签组合，兼容现有 R-21 多标签筛选能力；若已有 `facetFilters` 可不再重复使用，但保留不影响。
- AI 永远看不到/不生成 `limit / offset`。

### 4.3 元数据筛选白名单

后端按 key 编译成不同 SQL 片段，**列名不做字符串拼接，直接写死分支**：

| key | 允许 op | 值类型 | 现有列/表达式 |
|---|---|---|---|
| `file_ext` | `in` / `eq` | string[] | `a.file_ext` |
| `mime_type` | `in` / `eq` / `prefix` | string[] | `a.mime_type` |
| `width` | `eq / gt / gte / lt / lte / between` | number | `a.width` |
| `height` | 同上 | number | `a.height` |
| `resolution` | `eq / gt / gte / lt / lte / between` | number | `a.width * a.height` |
| `file_size` | 同上 | number（字节） | `a.file_size` |
| `duration_ms` | 同上 | number（毫秒） | `a.duration_ms` |
| `taken_at` | `between / gte / lte / last_n_days` | 日期或相对 | `a.taken_at` |
| `created_at` | 同上 | 日期或相对 | `a.created_at` |
| `modified_at` | 同上 | 日期或相对 | `a.modified_at` |
| `camera` | `eq / in / contains` | string | `a.camera` |
| `lens` | `eq / in / contains` | string | `a.lens` |
| `iso` | `eq / in / between` | number | `a.iso` |
| `aperture` | `eq / between / gte / lte` | number | `a.aperture` |
| `shutter` | `eq / contains / in` | string | `a.shutter` |
| `focal` | `eq / between / gte / lte` | number | `a.focal` |
| `video_codec` | `eq / in / contains` | string | `a.video_codec` |
| `audio_codec` | `eq / in / contains` | string | `a.audio_codec` |

建议再加一个可选项 `rating` 预留（当前 assets 表没有评分列，若老板要「评分筛选」需要 v9 迁移加列；本期可先不做）。

### 4.4 标签解析（AI 输出的标签名如何变 tagId）

AI 输出里只允许出现**标签名或别名文本**，不允许直接输出 tag id（避免幻觉 id）。后端解析顺序：

1. 按 `facet_key` 限定查找；
2. `normalized_name` 精确匹配；
3. `tag_aliases.normalized_alias` 匹配（可搜索别名）；
4. 模糊兜底：`tags::search_candidates(facet, name)` 取 top1；
5. 仍无法解析 → 放进 `warnings`，该条件不生效，并提示用户「未识别标签：xxx」。

这一步可以完全复用现有 `tags.rs` 的 normalize / alias / candidates 能力。

### 4.5 后端模块划分

```
commands/
  super_search_cmd.rs          // 薄壳：ai_parse_search_query + list_metadata_facets + saved filter CRUD(二期)
services/
  super_search_ai.rs           // 组装 prompt、调 AI、解析 JSON、标签解析、校验 SearchQuery
  ai_cloud.rs                  // 抽取 text_json_request()：纯文本请求，两种协议共用
db/
  assets.rs                    // AssetFilter 增加 metadata_filters；build_where 增加参数化编译
  metadata_facets.rs           // 文件格式/相机/镜头/尺寸/时间等分面统计（新）
  saved_filters.rs             // 二期
```

`ai_parse_search_query` 命令流程：

```
1. 校验 query 长度（如 ≤ 200 字）
2. 短锁读 DB：
   - active AI profile 是否存在
   - tag_facets 列表
   - 每个 facet 下 top N 标签（按 total_count 降序，比如每类 30 个）+ 高频别名
   - 当前 SearchQuery（可选，作为「在现有结果内继续搜」的上下文）
3. 放锁
4. spawn_blocking 内调 ai_cloud::request_text_json
   - system prompt：角色、schema、规则、示例
   - user prompt：可用标签词典 + 用户 query + 当前条件
5. 解析 JSON（宽容解析，先整串再截取 {} 片段）
6. 后端校验 + 标签解析，返回：
   {
     "query": SearchQuery,
     "explanation": "一句话解释",
     "warnings": ["未识别标签：夜景"],
     "resolved": {...}
   }
7. 失败时重试一次（把错误原因塞进第二次 prompt），仍失败返回明确错误
```

安全约束：
- 不执行 AI 生成的 SQL；
- 不接受 AI 给的任意字段名、任意列名；
- 值全部参数绑定；
- `trashOnly` 强制 false（超级搜索不搜回收站）；
- `limit/offset` 不由 AI 控制。

### 4.6 前端结构

```
src/
  pages/SuperSearchPage.tsx
  stores/superSearchStore.ts        // 独立于 libraryStore，避免污染素材库当前筛选
  components/supersearch/
    FilterPanel.tsx                 // 左侧完整筛选面板
    TagFacetCard.tsx                // 每个标签分面一张卡
    MetadataFilterCard.tsx          // 文件属性/时间/设备/视频
    ActiveFilterChips.tsx           // 顶部条件芯片（可删）
    AiSearchBar.tsx                 // 自然语言输入 + 示例 + loading/error
    AiParsedSummary.tsx             // AI 解释 + warnings + 应用到筛选
  components/library/AssetGrid.tsx  // 重构为「受控数据源」或抽通用网格
  hooks/useDoubleAction.ts          // 单击/双击互斥 hook
```

#### 页面草图

```
┌─────────────────────────────────────────────────────────────────────────┐
│ [← 返回]  [超级筛选] [AI 智能搜]        AI 输入框 / 普通关键字            │
│ 条件芯片: 海边 × | 横图 × | 2025 年 × | 排除夜景 ×        [清除全部] N 项 │
├──────────────────────────┬──────────────────────────────────────────────┤
│ 左侧 320px                │  素材网格（复用 AssetGrid 虚拟滚动）           │
│ ▸ 类型：全部/图片/视频    │                                              │
│ ▸ 未打标 / 回收站         │                                              │
│ ▸ 标签分面（10 个卡）     │                                              │
│ ▸ 排除标签                │                                              │
│ ▸ 文件属性               │                                              │
│ ▸ 时间范围               │                                              │
│ ▸ 拍摄设备               │                                              │
│ ▸ 排序                   │                                              │
└──────────────────────────┴──────────────────────────────────────────────┘
```

交互要点：
- 切到「AI 智能搜」时，左侧可收起或变成「解析结果/历史」；查询输入框聚焦。
- AI 解析成功后，自动把 `SearchQuery` 写入 store 并执行搜索；同时把可读条件回填为芯片。
- 芯片可删除，删除即从 `SearchQuery` 中移除对应条件并重新查询。
- 所有条件变更走防抖或按钮触发，避免每个滑块都打请求；结果计数即时更新。

#### 数据源解耦

`AssetGrid` 目前直接绑定 `useLibraryStore`。超级搜索页如果也直接用 libraryStore，会覆盖素材库当前筛选。推荐两种方案：

- 方案 A（推荐，改动稍大但干净）：抽一个通用 `AssetGridView` 接收 `items / total / loadMore / fetchAllIds / ...`，原 `AssetGrid` 变成薄封装，超级搜索页复用通用网格。
- 方案 B（改动最小）：超级搜索页复用 libraryStore，进入时保存快照、退出时恢复。不推荐：并发/竞态/退出恢复都容易出 bug。

选中状态 `selectionStore` 是全局的，两个页面共享同一选中集；超级搜索页沿用同一套批量操作（打标/导出/移动/删除），与现有行为一致。

### 4.7 双击入口实现

`BottomBar` 目前是纯按钮。建议：

```ts
// hooks/useDoubleAction.ts 语义
onSingleClick()  -> 延迟 250ms 执行（切到素材库）
onDoubleClick()  -> 取消延迟，打开超级搜索
```

要点：
- 只有「素材库」按钮挂双击；其余按钮行为不变。
- 已在素材库页时，单击本身无副作用，双击直接进入；在其他页时，双击不会先闪到素材库。
- 进入超级搜索后，底栏「素材库」仍保持高亮（`current = page === "superSearch" ? "library" : page`）。
- 退出：页面左上「← 返回」、`Esc`、再次双击「素材库」都回到上一页。
- 建议同时加 `Ctrl+Shift+F` 全局快捷键，作为可发现性兜底；首次进入显示一行提示「双击底部素材库可再次进入」。

### 4.8 AI 提示词设计（后台自动写）

核心原则：提示词完全在 Rust 侧组装，用户只提供一句话。

System prompt 要点：

```
你是茶包素材素材库的搜索条件解析器。
输入是用户的一句自然语言，输出是严格的 JSON，不要输出其他内容。
你的任务不是直接回答，而是把需求翻译成 SearchQuery。

可用字段（摘要）：
- search: 文件名/标签语义关键字
- assetType: all|image|video
- tagIds/tagsMode/facetFilters/excludeTagIds
- metadataFilters: 白名单 key + op
- sortBy/sortDir

规则：
1. 只使用给定 schema 中的字段和值；
2. 标签只写给定词典中的名称或别名，不要编造 id；
3. 时间转成 ISO 日期范围或 last_n_days；
4. 不确定的条件宁可放进 search，也不要伪造；
5. 排除类表达（不要/排除/除了）用 excludeTagIds；
6. 用户说“风格清新”等抽象词时，优先匹配 style 分面标签；
7. 同时输出 explanation：简短中文说明你做了什么。
```

User prompt 动态包含：
- 当前标签词典（每分面 top N 标签 + 别名 + 数量）；
- 当前已选条件；
- 示例 3~5 条（输入 → 输出）；
- 用户原始 query（用 `<query>...</query>` 包住）。

输出示例：

```json
{
  "explanation": "筛选 2025 年拍摄、横构图、包含海边标签、大于 5MB、排除夜景标签的图片。",
  "query": {
    "assetType": "image",
    "facetFilters": [
      { "facetKey": "scene", "tagIds": [8], "mode": "any", "includeDescendants": true }
    ],
    "excludeTagIds": [44],
    "metadataFilters": [
      { "key": "taken_at", "op": "between", "min": "2025-01-01", "max": "2025-12-31" },
      { "key": "width", "op": "gt", "value": 0 },
      { "key": "file_size", "op": "gte", "value": 5242880 }
    ],
    "sortBy": "created_at",
    "sortDir": "desc"
  }
}
```

模型选择：
- 先直接复用当前激活的 AI 档案（`settings.ai.active()`）。
- 文本解析不需要视觉能力，云端 qwen-vl 系列也能做；本地 Ollama 用 7B 级文本模型通常即可，但质量需要实测。
- 二期可在 AiSettings 里加 `search_profile/search_model` 覆盖项，一期不做，减少配置面。

### 4.9 执行与性能

- 查询仍走现有 `assets::list / list_ids`，分页 200/页、虚拟滚动、缩略图链路零改动。
- 元数据筛选要加索引（建议 v9 迁移）：
  - `idx_assets_file_ext ON assets(file_ext)`
  - `idx_assets_camera ON assets(camera)`
  - `idx_assets_lens ON assets(lens)`
  - `idx_assets_width_height ON assets(width, height)`
  - `idx_assets_duration ON assets(duration_ms)`
- AI 解析是网络操作：`spawn_blocking`，期间不持 DB 锁；加 60s 超时（与打标 300s 区分）。
- 防抖/手动触发：不在用户每敲一个字时调 AI；输入后按 Enter 或点「智能搜索」，空输入/相同输入不重复请求。

### 4.10 风格统一

- 新页面背景 `var(--color-bg)`，分组标题用 `.ui-section-title`。
- 左侧筛选卡片不用彩色/圆角卡片：细分隔线 + 区块标题即可。
- 主按钮仅「智能搜索」黑色实心；其他幽灵文字按钮。
- 标签芯片、条件芯片沿用现有 TagChip 视觉语言，尺寸小、状态色仅做小面积。
- 暗色模式自动生效（全部变量驱动，不写死颜色）。

---

## 5. 建议实施拆解

### P0：后端查询底座（约 1~1.5 天）

1. 新增/升级 Rust 查询模型：
   - `MetadataFilter { key, op, min, max, value, values }`；
   - `AssetFilter` 增加 `metadata_filters`；
   - `assets.rs::build_where` 增加白名单编译 + 参数绑定。
2. 实现 `list_metadata_facets`：
   - `file_ext / camera / lens` 等离散值 + count；
   - 时间/尺寸/大小提供 min/max 与常用档位，不强行返回全量值列表。
3. v9 迁移补索引。
4. 测试：
   - Rust 单测覆盖每个 metadata key/op、非法 op 拒绝、参数绑定；
   - 集成测试覆盖「多条件 + FTS + 标签分面 + 元数据 + 排序」组合。

### P1：超级筛选 UI + 双击入口（约 2 天）

1. `SuperSearchPage` + `superSearchStore`（独立筛选状态，200/页分页）。
2. 左侧完整筛选面板：类型/未打标/标签分面/排除标签/文件属性/时间/设备/视频/排序。
3. 顶部条件芯片 + 清除全部。
4. `useDoubleAction` 接入 BottomBar，App 增加 `superSearch` 页。
5. `AssetGrid` 数据源解耦（方案 A）或先做薄封装。
6. 前端单测：store、双击 hook、条件芯片删除、空态/错误态。

### P2：AI 智能搜（约 1~1.5 天）

1. `ai_cloud.rs` 抽出纯文本 JSON 请求函数（OpenAI/Anthropic 复用）。
2. `services/super_search_ai.rs`：
   - 上下文装配（标签词典 top N + 别名 + 当前条件）；
   - prompt 构建 + 示例；
   - 输出解析/校验/标签解析/重试一次。
3. `super_search_cmd` 命令：`ai_parse_search_query`。
4. 前端 AI 输入框、loading/error、解析摘要、warnings、回填条件芯片并执行。
5. 测试：prompt 上下文、JSON 解析、非法字段拒绝、别名解析、未识别标签 warning、无 AI 配置错误提示。

### P3：收尾与体验（约 0.5~1 天）

1. `Esc` 退出、`Ctrl+Shift+F` 快捷键、双击提示。
2. AI 示例查询做成可点击快捷输入。
3. 回归：`cargo test + vitest + npm run typecheck + npm run build` 三关全绿。
4. 更新 `PROGRESS.md`、`ARCHITECTURE.md`、`prd_bagertea_v2.md`。

### 二期（本次不做，预留设计）

- 保存筛选/智能文件夹：`saved_filters(id, name, query_json, created_at, updated_at)`，参考 Pixcall 看板。
- 评分筛选：`assets.rating` 迁移 + UI。
- 画面语义搜索：embedding/CLIP 路线，与 AI 智能搜互补；不建议一期用 LLM 假装理解像素。
- 独立搜索模型配置：`AiSettings.search_profile/search_model`。

---

## 6. 验收标准建议

1. 双击底部「素材库」可从任意页面进入超级搜索；单击仍是切回素材库。
2. 超级筛选至少支持：类型、未打标、标签分面（any/all/包含后代）、排除标签、关键字、格式、尺寸、分辨率、文件大小、拍摄/入库/修改时间、相机/镜头/ISO/光圈/快门/焦距、视频时长、排序。
3. 任意筛选组合结果与素材库现有单条件筛选语义一致；3 万素材下首屏 ≤ 500ms（沿用性能红线）。
4. 无 AI 配置时，超级筛选完整可用；AI 入口显示「请先在设置页配置 API」而不是白屏/报 command not found。
5. AI 示例至少通过：
   - 「2025 年拍的横图海边素材，大于 5MB，不要夜景」
   - 「去年夏天拍的竖版人像，风格清新」
   - 「Sony 拍的视频，时长 10 秒以上，按分辨率排序」
6. AI 返回的条件必须全部通过后端白名单校验；非法字段被丢弃并给 warning；未识别标签不得伪造。
7. UI 暗色/亮色、1366px 与 1920px 下无错位，全部使用主题变量。

---

## 7. 需要老板拍板的 4 个决策

1. **AI 输出中间 JSON，而不是让 AI 直接写 SQL**：强烈建议同意。理由：可解释、可修改、不会注入/幻觉列名，竞品也是同类路线。
2. **AI 解析后自动执行，还是先展示条件再手动执行**：建议「自动执行 + 芯片可改」，体验最顺；如果老板要更可控，可改「生成后先确认」。
3. **本期是否包含「保存筛选」**：建议放二期，一期先保证筛选能力与 AI 链路。
4. **超级搜索页是否沿用全局选中集**：建议沿用，这样批量打标/导出/删除不用重写；退出页面不清空选中。

---

## 8. 参考资料

- 本地代码：`src/App.tsx`、`src/components/layout/BottomBar.tsx`、`src/stores/libraryStore.ts`、`src/components/library/AssetGrid.tsx`、`src-tauri/src/db/assets.rs`、`src-tauri/src/db/search.rs`、`src-tauri/src/db/tag_facets.rs`、`src-tauri/src/db/tags.rs`、`src-tauri/src/services/ai_cloud.rs`
- 本地文档：`docs/ARCHITECTURE.md`、`docs/UI_DESIGN_SYSTEM.md`、`docs/PROGRESS.md`、`docs/prd_bagertea_v2.md`
- Eagle 官方帮助与博客：
  - `https://cn.eagle.cool/support/article/interface-filter`
  - `https://cn.eagle.cool/support/article/smart-folders`
  - `https://cn.eagle.cool/blog/post/eagle-plugin-ai-search`
- Billfish 官方帮助：
  - `https://www.billfish.cn/help/sousuochazhao`
  - `https://www.billfish.cn/help/liaojiejiemian`
- Pixcall 官方文档：
  - `https://docs.pixcall.com/docs/desktop-client/search-and-filter/`
  - `https://docs.pixcall.com/docs/desktop-client/smart-folder/`
- Immich：`https://immich.app/`
- 调研日期：2026-08-24
