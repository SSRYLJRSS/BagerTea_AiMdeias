# 标签系统重构设计与修改方案

**项目：** 茶包素材 BagerTea V2  
**文档日期：** 2026-08-23  
**目标：** 为素材标签建立可长期演进、可搜索、可治理、兼容现有数据的稳定地基  
**本轮范围：** 设计和修改方案；本轮不修改业务代码

## 1. 结论先行

当前项目的父子标签树、素材多对多关联、FTS5 搜索、`tag_ops` 撤销和 AI 确认流程都值得保留。真正需要重构的是标签的语义边界：目前“主体、场景、颜色、项目、状态、AI 来源”等概念被迫使用同一种 `tags` 记录，导致分类不稳定、搜索语义不清、AI 容易污染词表。

建议采用以下目标架构：

```text
TagFacet（固定分面）
    └── Tag（规范标签，保留 parent_id 轻量层级）
            ├── TagAlias（别名/多语言/旧名称）
            └── AssetTag（素材当前有效标签）
                    └── TagOp（操作历史，可撤销）

AiBatch / AiSuggestion
    └── AiSuggestionItem（原始候选、规范化候选、置信度、人工决策）
```

核心原则：

1. **分面不是标签。** `主体`、`场景`、`色彩`是稳定的分类维度，不再依赖用户在设置中随意改名来表达。
2. **标签是规范概念。** 每个标签有稳定 ID、所属分面、规范名、规范化名、状态和可选父级。
3. **用户输入不直接成为词表事实。** 新词先经过相似标签/别名检查；AI 新词先进入候选，不直接落正式标签。
4. **文件夹、状态、格式、时间不是普通标签。** 这些信息继续使用字段、项目或智能集合。
5. **搜索使用分面逻辑。** 同一分面默认 OR，不同分面默认 AND；支持全部、任意、排除和别名命中。
6. **兼容优先。** 保留现有 `tags.id`、`asset_tags` 关联和旧命令一段时间，迁移以新增字段/表为主。

## 2. 当前实现与问题定位

### 2.1 当前已有基础

对应代码：

- `src-tauri/src/db/tags.rs`：父子树、移动、防环、合并、删除、预置标签；
- `src-tauri/src/db/asset_tags.rs`：素材与标签多对多关联，关联来源 `source`；
- `src-tauri/src/db/search.rs`：FTS5、CJK bigram、LIKE 回退；
- `src-tauri/src/db/assets.rs`：单标签、多个标签、`any/all` 和后代递归筛选；
- `src-tauri/src/db/ai.rs`：AI 建议独立存储，确认后写入 `asset_tags`；
- `src-tauri/src/db/tag_ops.rs`：打标流水与批次撤销；
- `src-tauri/src/db/migrations.rs`：`PRAGMA user_version` 递进迁移；
- `src/stores/tagStore.ts`、`TagTree.tsx`、`TagAssignDialog.tsx`、`TagManageDialog.tsx`：前端树导航和管理。

这些基础意味着不需要更换数据库，也不需要一次性重写全部前端。

### 2.2 必须解决的结构问题

| 问题 | 当前原因 | 重构结果 |
|---|---|---|
| 分类可被任意改名 | `Settings.tagCategories` 只有显示名，没有稳定 key | 分面进入数据库，使用稳定 `key` |
| 根节点和分面混用 | AI 将分类名写入 `tags` 根节点 | 根节点保留兼容，但由 `tag_facets` 管理 |
| 同义词无法治理 | 只有 `tags.name` | 新增 `tag_aliases` |
| AI 词表会膨胀 | `find_or_create_child()` 对模型输出直接建标签 | 先规范化匹配，再进入候选/人工确认 |
| FTS 无法区分语义 | `tag_names` 是所有标签拼接 | 分面过滤走结构化 SQL，FTS 负责文本召回 |
| AI 来源信息不足 | `asset_tags.source` 只有简单字符串 | 增加置信度、确认状态和模型/批次关联 |
| 管理界面难以扫描 | 全部标签一棵树 | 按分面分组，树只展示分面内部的 2 层 |

## 3. 目标领域模型

### 3.1 `tag_facets`：稳定分面

分面是用户搜索时的维度，不是用户随意创建的普通标签。首版固定以下 key：

| key | 中文名 | 选择语义 | 默认上限 |
|---|---|---|---:|
| `subject` | 主体/对象 | 多选 | 5 |
| `scene` | 场景/地点 | 多选 | 3 |
| `purpose` | 用途 | 多选，推荐人工 | 3 |
| `style` | 风格/氛围 | 多选 | 4 |
| `color` | 色彩 | 多选 | 3 |
| `composition` | 构图/视角 | 多选 | 4 |
| `lighting` | 光线/时间 | 多选 | 3 |
| `people` | 人物属性 | 多选 | 4 |
| `technical` | 可用性/技术特征 | 多选 | 4 |
| `custom` | 自定义 | 多选 | 不限 |

注意：`purpose` 中只放稳定类型，如电商、社交媒体、公众号、海报、包装；客户名、项目名、阶段、待审核等不放进内容标签。

### 3.2 `tags`：规范标签

保留现有表和 ID，新增字段：

```text
id                稳定主键，不改变
name              当前显示名，保留兼容
canonical_name    规范显示名
normalized_name   搜索/去重用规范文本
facet_key         所属分面，根节点也有值
parent_id         分面内部的可选父级
status            active | deprecated | blocked
is_system         是否系统内置
is_preset         兼容旧字段
sort_order        分面内排序
description       给用户和 AI 的定义
```

### 3.3 层级限制

- 用户可见层级最多 2 层：`主体/饮品/茶` 的显示路径可为 3 段，但标签节点最多“分面根 + 一层父子”；
- 数据层不强行拒绝更深层级，以兼容旧数据；
- 新建/移动标签时前端提示超过 2 层，管理 API 可配置为警告而非硬失败；
- 父标签搜索默认包含后代，提供“仅此标签”选项。

### 3.4 `tag_aliases`：别名和多语言

一个别名只映射到一个规范标签；同义词冲突必须进入治理，而不是随机命中。

字段：

```text
id
tag_id
alias
normalized_alias
locale              zh-CN | zh-TW | en | null
alias_type          synonym | old_name | translation | typo
is_searchable
created_at
```

例子：

```text
规范标签：主体/饮品/茶
别名：茶叶、tea、綠茶（仅当语义确实等价时）
```

### 3.5 `asset_tags`：素材当前有效状态

保留主键 `(asset_id, tag_id)`，新增：

```text
source              manual | ai_cloud | ai_local | import | migration
confidence          0..1，可空；人工标签为 NULL
confirmation        confirmed | unconfirmed | overridden
confirmed_at        时间，可空
confirmed_by        manual | ai_auto | migration，可空
source_batch_id     AI 批次，可空
```

写入规则：

- 手动添加：`source=manual, confirmation=confirmed`；
- AI 确认：`source=ai_*`，`confirmation=confirmed`；
- AI 自动模式也必须经过可配置置信度门槛，低于门槛进入未确认状态；
- 手动确认相同标签时，优先级高于 AI，不得被后续 AI 请求覆盖；
- 原有 `source` 值保留，旧数据默认 `confirmation=confirmed`，`confidence=NULL`。

### 3.6 AI 建议规范化

保留 `ai_suggestions` 作为“每个素材一条任务结果”，新增 `ai_suggestion_items` 作为“每个候选一行”：

```text
id
suggestion_id
facet_key
raw_name                 模型原始输出
normalized_name          规范化后的候选名
tag_id                   已匹配的规范标签，可空
confidence               0..1，可空
decision                 pending | accepted | modified | rejected
decision_reason          可空
created_at
```

旧的 `suggested_tags` JSON 保留至少两个版本，用于兼容历史批次和导出；新流程以 `ai_suggestion_items` 为准。

## 4. 数据库迁移方案

建议新增 **V8 标签地基迁移**，不要重写 V1-V7。迁移必须可重入，任何一步中断后重启不会重复插入或破坏原数据。

### 4.1 V8 新增表

```sql
CREATE TABLE IF NOT EXISTS tag_facets (
  key TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  selection_mode TEXT NOT NULL DEFAULT 'multi',
  max_items INTEGER,
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_system INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tag_aliases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  alias TEXT NOT NULL,
  normalized_alias TEXT NOT NULL,
  locale TEXT,
  alias_type TEXT NOT NULL DEFAULT 'synonym',
  is_searchable INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  UNIQUE(tag_id, normalized_alias, locale)
);
CREATE INDEX IF NOT EXISTS idx_tag_aliases_lookup
  ON tag_aliases(normalized_alias, locale);

CREATE TABLE IF NOT EXISTS ai_suggestion_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  suggestion_id INTEGER NOT NULL REFERENCES ai_suggestions(id) ON DELETE CASCADE,
  facet_key TEXT NOT NULL,
  raw_name TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  tag_id INTEGER REFERENCES tags(id) ON DELETE SET NULL,
  confidence REAL,
  decision TEXT NOT NULL DEFAULT 'pending',
  decision_reason TEXT,
  created_at INTEGER NOT NULL,
  CHECK(confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  CHECK(decision IN ('pending', 'accepted', 'modified', 'rejected'))
);
CREATE INDEX IF NOT EXISTS idx_ai_suggestion_items_suggestion
  ON ai_suggestion_items(suggestion_id);
CREATE INDEX IF NOT EXISTS idx_ai_suggestion_items_tag
  ON ai_suggestion_items(tag_id);
```

### 4.2 `tags` 增列

SQLite 不支持通用 `ADD COLUMN IF NOT EXISTS`，按现有 `migrate_v2/migrate_v5` 的逐列检查模式实现：

```sql
ALTER TABLE tags ADD COLUMN canonical_name TEXT;
ALTER TABLE tags ADD COLUMN normalized_name TEXT;
ALTER TABLE tags ADD COLUMN facet_key TEXT NOT NULL DEFAULT 'custom';
ALTER TABLE tags ADD COLUMN status TEXT NOT NULL DEFAULT 'active';
ALTER TABLE tags ADD COLUMN is_system INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tags ADD COLUMN description TEXT NOT NULL DEFAULT '';
```

### 4.3 `asset_tags` 增列

```sql
ALTER TABLE asset_tags ADD COLUMN confidence REAL;
ALTER TABLE asset_tags ADD COLUMN confirmation TEXT NOT NULL DEFAULT 'confirmed';
ALTER TABLE asset_tags ADD COLUMN confirmed_at INTEGER;
ALTER TABLE asset_tags ADD COLUMN confirmed_by TEXT;
ALTER TABLE asset_tags ADD COLUMN source_batch_id INTEGER;
```

### 4.4 数据回填顺序

1. 插入固定 `tag_facets`，使用 `INSERT OR IGNORE`；
2. 根据旧根标签名称映射 `facet_key`；无法识别的根节点使用 `custom`；
3. 所有标签回填 `canonical_name=name`、`normalized_name=normalize(name)`；
4. 将旧根标签标记 `is_system=1`，但不删除；
5. 旧 `asset_tags` 回填 `confirmation=confirmed`、`confirmed_by=migration`；
6. 从历史 AI JSON 生成 `ai_suggestion_items`，无法解析的保留原 JSON；
7. 创建别名时只写入确定的规范映射，绝不自动将模糊近义词当成别名；
8. 重建 FTS 文档；
9. 完成一致性校验后再更新 `PRAGMA user_version=8`。

### 4.5 迁移保护

迁移前自动生成数据库备份，至少记录：

- 数据库路径；
- 迁移前 `user_version`；
- assets/tags/asset_tags 行数；
- 迁移后相同计数；
- FTS 文档数量；
- 失败时的错误信息。

计数不一致时迁移失败，不允许静默继续启动。

## 5. 后端模块修改清单

### 5.1 `src-tauri/src/db/migrations.rs`

新增：

- `SCHEMA_V8`；
- `migrate_v8()`；
- `ensure_column()` 通用辅助函数，替换未来重复的逐列检查；
- 迁移后校验函数；
- FTS 重建函数调用。

不要修改历史迁移 SQL，避免老版本数据库在不同路径上产生分叉行为。

### 5.2 新增 `src-tauri/src/db/tag_facets.rs`

负责：

- `list_facets()`；
- `get_facet(key)`；
- `seed_system_facets()`；
- `update_custom_facet()`；
- `facet_for_tag()`；
- 根标签与分面的兼容映射。

分面 key 使用稳定 ASCII 标识，中文只作为 `display_name`，避免设置页改名破坏历史数据。

### 5.3 重构 `src-tauri/src/db/tags.rs`

保留现有 CRUD API 的兼容包装，新增领域 API：

```rust
pub struct TagQuery {
    pub facet_key: Option<String>,
    pub search: Option<String>,
    pub include_inactive: bool,
}

pub struct TagWithPath {
    pub tag: Tag,
    pub path: String,
    pub facet_key: String,
    pub aliases: Vec<String>,
}

pub fn list_by_facet(conn: &Connection, facet_key: &str) -> AppResult<Vec<TagNode>>;
pub fn search_candidates(conn: &Connection, facet_key: Option<&str>, q: &str) -> AppResult<Vec<TagWithPath>>;
pub fn create_canonical(...);
pub fn add_alias(...);
pub fn merge_with_alias_preservation(...);
pub fn deactivate(...);
```

重要规则：

- `delete` 默认改为 `deactivate`；物理删除只允许无素材、无别名、无历史引用的标签；
- `merge` 必须把源名称写入 `tag_aliases`，防止旧搜索词失效；
- 重命名更新 `canonical_name`，旧名进入 `tag_aliases(alias_type='old_name')`；
- 标签移动不能跨分面，除非明确执行“迁移分面”操作并给出预览。

### 5.4 `src-tauri/src/db/asset_tags.rs`

新增统一写入函数：

```rust
pub struct TagAssignment {
    pub tag_id: i64,
    pub source: TagSource,
    pub confidence: Option<f64>,
    pub confirmation: ConfirmationState,
    pub batch_id: Option<i64>,
}

pub fn assign_effective(...);
pub fn remove_effective(...);
pub fn replace_source_assignments(...);
```

所有人工、AI、导入写入必须经过该模块，不允许各业务模块自行 `INSERT asset_tags`。这样才能保证：

- `tag_ops` 一定记录；
- FTS 一定刷新；
- 手动标签不会被 AI 覆盖；
- 同一批次可撤销。

### 5.5 `src-tauri/src/db/search.rs` 与 `assets.rs`

新增结构化查询类型：

```rust
pub struct FacetFilter {
    pub facet_key: String,
    pub tag_ids: Vec<i64>,
    pub mode: TagMatchMode, // any | all
}

pub enum TagMatchMode { Any, All }
```

`AssetFilter` 兼容保留：

- 旧 `tag_id` 转换为单个 `FacetFilter`；
- 旧 `tag_ids/tags_mode` 转换为无分面过滤；
- 新增 `facet_filters`、`exclude_tag_ids`、`include_descendants`。

查询语义：

- 同一个 `facet_key` 内：默认 OR；
- 不同 `facet_key` 之间：AND；
- `exclude_tag_ids`：全部排除；
- `include_descendants=true`：通过递归 CTE 包含后代；
- `include_descendants=false`：只匹配指定节点。

搜索文本处理：

- FTS 继续负责文件名、备注、规范标签和可搜索别名的召回；
- 分面和标签 ID 条件使用 SQL `EXISTS`，不拼接成 FTS 查询；
- 查询别名时返回规范标签结果；
- 低于 3 个 CJK 字符继续保留 LIKE 回退；
- 所有 FTS 查询必须使用参数绑定，禁止将用户操作符直接拼接进 SQL。

### 5.6 `src-tauri/src/db/ai.rs` 与 `services/ai_cloud.rs`

改为四步流程：

```text
模型原始 JSON
  -> 严格解析
  -> facet key 校验 + 标签规范化匹配
  -> ai_suggestion_items
  -> 人工确认后 assign_effective
```

修改点：

- prompt 使用稳定 facet key 和词表描述，不使用用户可任意改名的分类名称作为协议；
- 模型返回未知分类时记录错误，不创建根标签；
- 模型返回未知标签时先保存 `raw_name`，`tag_id=NULL`；
- 对已有规范标签/别名自动绑定 `tag_id`；
- 新候选必须经过人工确认才能 `create_canonical`；
- AI 确认修改时写入 `decision='modified'` 和最终 tag_id；
- `confirm_all_pending` 只确认已绑定规范标签的候选，未知候选保留待治理。

### 5.7 `src-tauri/src/commands/tags_cmd.rs`

保留旧命令，新增版本化命令：

```text
list_tag_facets
list_tags_by_facet
search_tag_candidates
create_canonical_tag
add_tag_alias
deactivate_tag
merge_tags_preserve_alias
assign_tag_batch
list_tag_governance
list_ai_suggestion_items
decide_ai_suggestion_item
```

旧 `create_tag` 可以继续用于兼容，但新 UI 不再直接调用它创建顶级自由标签。

## 6. 前端修改清单

### 6.1 类型层

修改 `src/types/tag.ts`：

```ts
export type TagStatus = "active" | "deprecated" | "blocked";
export type TagConfirmation = "confirmed" | "unconfirmed" | "overridden";

export interface TagFacet {
  key: string;
  displayName: string;
  description: string;
  selectionMode: "single" | "multi";
  maxItems: number | null;
  sortOrder: number;
  isSystem: boolean;
}

export interface Tag {
  id: number;
  name: string;
  canonicalName: string;
  normalizedName: string;
  facetKey: string;
  parentId: number | null;
  status: TagStatus;
  isSystem: boolean;
  isPreset: boolean;
  sortOrder: number;
  assetCount: number;
  totalCount: number;
  aliases: string[];
  path: string;
}
```

### 6.2 `tagStore.ts`

由单一 `tree` 改成：

```ts
interface TagState {
  facets: TagFacet[];
  treesByFacet: Record<string, TagNode[]>;
  recent: Tag[];
  loading: boolean;
  refreshFacets: () => Promise<void>;
  refreshFacet: (facetKey: string) => Promise<void>;
  searchCandidates: (facetKey: string | null, query: string) => Promise<Tag[]>;
}
```

保留 `flattenVisible`，但只接受一个分面的树，避免全库所有标签在同一个数组中扁平化。

### 6.3 `TagTree.tsx` / `SideBar.tsx`

左侧导航改为：

```text
未打标
全部分面
  主体/对象       1,240
  场景/地点         980
  风格/氛围         760
  色彩              520
  构图/视角         410
  光线/时间         310
  人物属性          180
  用途              160
  自定义             42
```

点击分面标题展开该分面标签；点击标签加入筛选，而不是直接替换全部筛选。当前激活筛选显示为可移除 chips。

### 6.4 `TagAssignDialog.tsx`

改为分面分组的搜索选择器：

- 顶部搜索已有规范标签和别名；
- 结果显示完整路径，例如 `主体 / 饮品 / 茶`；
- 创建新词时必须选择分面；
- 如果存在相似规范标签，优先提示合并/使用已有标签；
- 批量应用前显示素材数量、已存在数量和冲突数量；
- 新标签创建默认是 `custom` 或用户选择的分面，不再默认创建根标签。

### 6.5 `TagManageDialog.tsx`

增加四个治理标签页：

1. 分面与词表；
2. 别名和重复词；
3. 未确认 AI 候选；
4. 低频/停用标签。

删除按钮改成“停用”；合并时显示影响素材数，并自动保留源名为旧名称别名。

### 6.6 `SettingsPage.tsx`

现有 `tagCategories` 不再作为唯一事实来源：

- 系统分面的 `key` 和选择模式来自数据库；
- 设置页只允许调整 hint、最大候选数、AI 是否启用该分面；
- 系统分面显示名可本地化，但不能修改 key；
- 用户可新增 `custom` 分面，但必须使用稳定随机/slug key；
- 旧设置读取时按名称映射到 key，映射失败进入 `custom`，不丢失数据。

## 7. 搜索 API 目标协议

后端与前端最终统一为：

```ts
export interface FacetTagFilter {
  facetKey: string;
  tagIds: number[];
  mode: "any" | "all";
  includeDescendants: boolean;
}

export interface LibraryFilter {
  assetType: AssetType;
  untaggedOnly: boolean;
  search: string;
  facetFilters: FacetTagFilter[];
  excludeTagIds: number[];
  sortBy: "created_at" | "taken_at" | "size" | "resolution";
  sortDir: "desc" | "asc";
  trashOnly: boolean;
}
```

兼容策略：旧 `tagId`、`tagIds` 字段在 API 边界转为 `facetFilters`，内部查询只使用新协议，避免两套 SQL 语义长期并存。

## 8. 修改顺序

### Phase 1：后端地基，不改主要 UI

1. V8 migration、分面表、别名表、AI 候选表；
2. 规范化函数和标签 DTO；
3. 旧标签回填与 FTS 重建；
4. 新 `tag_facets`、`tag_aliases`、`ai_suggestion_items` 数据层测试；
5. 旧命令继续可用。

### Phase 2：统一写入与 AI

1. 所有标签写入集中到 `asset_tags` 服务；
2. AI prompt 改为稳定 facet key；
3. AI 候选规范化、置信度和人工决策；
4. 合并/重命名自动保留别名；
5. 批次撤销覆盖手动和 AI 批量操作。

### Phase 3：搜索协议

1. `FacetFilter` 后端查询；
2. 别名搜索；
3. 同分面 OR、跨分面 AND、排除和仅此标签；
4. 保留旧搜索回退；
5. 增加查询结果排序和无结果提示。

### Phase 4：前端分面 UI

1. `tagStore` 改为 facets + treesByFacet；
2. Sidebar 分面导航；
3. 标签分配分组和路径显示；
4. 标签治理页面；
5. 设置页从自由分类切换为稳定 key 配置。

### Phase 5：数据治理和可迁移性

1. 停用/重复/低频标签报表；
2. XMP/IPTC 映射；
3. 词表导入导出；
4. 搜索日志和常用标签排序；
5. 评估是否需要语义搜索，不提前绑定复杂向量方案。

## 9. 测试矩阵

### 9.1 迁移测试

- 空数据库从 V1 迁移到 V8；
- 已有 V7 数据迁移到 V8；
- V8 迁移中途失败后重复启动；
- 旧根标签名称无法映射时进入 `custom`；
- 行数、关联数、FTS 文档数迁移前后保持一致；
- 中文、繁体、英文和大小写规范化结果稳定。

### 9.2 标签领域测试

- 同一分面同级重复规范名被拒绝；
- 同义词唯一映射；
- 重命名保留旧名称别名；
- 合并保留源名称别名和全部关联；
- 跨分面移动被拒绝或要求明确迁移；
- 停用标签仍可查询历史关联，但默认不出现在新建候选中；
- 删除/合并后 FTS 没有旧 token 残留。

### 9.3 搜索测试

- 同分面 OR；
- 跨分面 AND；
- 全部匹配；
- 排除标签；
- 父标签含后代与仅此标签；
- 通过别名搜索命中规范标签；
- CJK 1/2/3/4+ 字符；
- 文件名命中与标签命中排序；
- 快速切换筛选时旧请求不能覆盖新结果。

### 9.4 AI 测试

- 未知分类不创建根标签；
- 未知词进入候选而不写正式标签；
- 高置信度规范标签可批量确认；
- 低置信度候选不能被“一键全部确认”绕过；
- 手动标签不会被 AI 重复结果覆盖；
- AI 批次切换不会写错素材；
- AI 撤销只撤销该批次真实新增的关联。

### 9.5 前端交互测试

- 只加载当前分面或缓存分面，不一次渲染全库所有标签；
- 标签选择显示路径和来源；
- 新建标签必须选择分面；
- 多分面筛选 chip 可单独移除；
- 分面刷新失败显示重试，不丢失已显示树；
- 治理合并后搜索旧名称仍可命中。

## 10. 风险与取舍

### 10.1 不采用“完全重建标签表”的原因

直接把根节点改成独立分面、重写所有 tag ID，会影响：

- `asset_tags`；
- AI 已确认记录；
- `tag_ops` 历史撤销；
- 前端缓存的 tag ID；
- 旧数据库和导出文件。

本方案用 `tag_facets` 管理语义、保留根标签兼容，能在不破坏历史的前提下逐步完成迁移。

### 10.2 不采用“每个 AI 词都建立候选标签”的原因

候选不等于规范标签。若候选直接写入 `tags`，用户很快会得到数百个低频、近似、无法解释的词。本方案允许候选记录存在，但只有人工确认或明确的自动规则才能创建规范标签。

### 10.3 不采用“全部信息都做结构化字段”的原因

纯字段模型不适合开放式视觉属性，也会使用户每次打标成本过高。分面标签保留多值和层级，结构化字段只承载可精确比较的属性。

## 11. 完成标准

重构完成后，应满足：

1. 旧数据库可自动迁移，标签和素材关联不丢失；
2. 新标签必须属于分面或明确标为自定义；
3. 重命名/合并不会让旧搜索词失效；
4. AI 未确认候选不会污染正式标签树；
5. 搜索支持分面组合、任意/全部/排除和别名；
6. 手动、AI、导入写入走同一事务和流水入口；
7. 标签删除默认可逆或至少保留历史引用；
8. 前端不再将所有标签作为一棵无语义的大树展示；
9. 所有迁移、查询、确认和治理关键路径有自动化测试；
10. 导出或未来 XMP/IPTC 映射可以按规范标签而不是显示字符串工作。

## 12. 推荐的第一批实现任务

按开发优先级，第一批应只做以下内容：

1. V8 migration：`tag_facets`、`tag_aliases`、`ai_suggestion_items`、标签/关联增列；
2. `normalize_tag_name()` 和稳定 facet seed；
3. `Tag` / `TagFacet` / `TagAlias` Rust 与 TypeScript DTO；
4. 统一标签写入服务，覆盖手动和 AI 确认；
5. 标签重命名/合并保留别名；
6. 新分面搜索 SQL，兼容旧筛选参数；
7. 数据层迁移与搜索测试。

暂缓：XMP/IPTC 双向写回、语义向量搜索、自动合并和跨设备词表同步。

**最终决策：** 先把分面、规范标签、别名、AI 候选和统一写入这五个边界做稳，再做视觉层的标签树改造。这样既能获得长期稳定的数据地基，也不会因为一次大规模 UI 改造而失去现有功能。

## 13. 本轮已落地的实现状态

本轮已将上述地基直接接入项目，主要行为如下：

- 数据库版本已升至 V8，新增 `tag_facets`、`tag_aliases`、`ai_suggestion_items`，并为 `tags`、`asset_tags` 增加规范化、状态、置信度、确认来源和批次字段；迁移可重复执行，旧 ID 和关联保持不变。
- 标签搜索同时覆盖规范名、路径和可搜索别名；标签树按分面分组；素材查询支持跨分面 AND、同分面 any/all、包含后代和排除标签。
- 新协议创建标签时直接绑定稳定 facet key，不再依赖用户可改名的设置分类；旧 AI 中文分类仍保留兼容根节点，以保证历史批次和旧测试数据可读。
- 重命名和新界面合并会保留旧名称别名；跨分面合并会被拒绝；管理界面的“删除”入口改为递归停用，保留历史 `asset_tags` 关联并从默认候选和搜索中隐藏。
- 增加标签治理统计命令和管理弹窗摘要，能够看到各分面的有效/停用标签数、关联素材数、别名数和待审 AI 候选数。
- AI 候选现在逐项落库，可查询并接受、修改或拒绝；确认整条建议时会把最终规范标签 ID 回写到候选项，移除的候选标记为 rejected，人工新增的最终标签记录为 modified。
- 素材详情、素材列表返回的标签已补齐路径和别名，避免前端不同入口显示不一致。
- 旧版“风景/美食/街拍/宠物……”等预置标签已停止继续播种；启动时只停用无素材关联的旧预置，已使用的标签和真正的系统分面根节点保留。

### 13.1 尚未做的扩展

- AI 候选审核目前已提供稳定 Tauri/API 接口，但工作台仍以现有整条建议编辑器为主，逐项候选审核面板可以在此接口之上继续补充。
- 旧 `delete_tag` 和 `tag_merge` 命令仍保留，用于兼容外部调用；新管理界面不再使用物理删除路径。
- `tagStore` 已缓存分面树，但当前仍会先加载完整树再切分面；标签规模超过数万时应改为按分面懒加载。

### 13.2 验收命令

```text
cargo check
cargo test
npm run typecheck
npm run test:unit
npm run build
```

本轮验收结果：Rust 全量测试、前端类型检查、前端单元测试和生产构建均通过；Rust 测试包含 26 个数据库集成用例和 54 个 QA 边界用例。
