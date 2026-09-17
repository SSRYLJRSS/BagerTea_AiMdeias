# 分面协议 V2

> 状态：Frozen
>
> 更新日期：2026-09-14
>
> 本文件是标签分面的唯一机器协议。
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

### 3.1 AI 工作台展示与人物输出规则

- `custom` 是未知 AI key 的后端路由兜底桶，不是用户可管理的分类；设置页和 AI 打标工作台都不展示它，AI 提示词也不把它列为可输出分面。
- AI 输出的素材分析协议固定为 `description`、`peoplePresence`、`tags`、`numbers`；标签必须是 `{name, confidence}`，不接受裸字符串或旧顶层分面协议。
- `description` 目标为 12–30 个 Unicode 字符。过短时只补调一次；超过上限按字符截断。
- `peoplePresence.status` 只允许 `present`、`absent`、`unknown`。`absent` 且置信度达标时才生成「无人」；低置信度的 `absent` 转为「未知」；`present` 时禁止出现「无人」「未知」「人物」，人物存在由 `subject=人` 表达。
- `people` 必须与 `subject` / `description` 保持一致，解析层不根据空数组猜测人物是否存在。
- `subject` 是主体对象分面，最多 3 个。人物统一写「人」，不得写男子、女子、行人、男孩、女孩、老人、人数、性别、年龄或穿着；有清晰主体时通常输出 2–3 个，确实只有一个时不凑数。
- `scene` 是空间、环境和地点分面，最多 3 个。场景清楚时可输出 2–3 个维度；树木、水面、楼梯等主体物不得混入场景。
- `people` 按图片整体记录人物状态、人数档位、性别、年龄段、穿着和动作，最多 8 个。混合人群分别输出原子属性，不写「年轻女子」这类复合词。
- 人数档位固定为：无人 0、单人 1、双人 2、多人 3–10、人群超过 10 或无法准确计数。人数不确定时不猜档位。
- 仅保留一个 `confidenceMinSuggest`（默认 `0.30`）。低于阈值的标签直接拦截，其余标签全部保持 `pending`，必须经用户在打标页「确认写入」后才写素材。
- 精确词命中、新词和普通建议都进入人工确认；不存在 AI 自动采用或自动创建正式标签的开关。核心分面新词确认后落到「其他」父类，普通和自建分面仍按原规则创建。

### 3.2 核心默认层级

新库、重置标签后和恢复备份后的空标签库播种以下默认层级。父节点用于浏览和宽泛筛选，AI 只输出叶子；其中带别名的常用同义说法统一归到规范叶子。

```text
主体对象（subject，最多 3）
  人物 > 人
  动物 > 猫、狗、鸟、鱼、宠物、野生动物
  植物 > 树木、花卉、绿植、农作物
  食物饮品 > 食物、饮品、茶、咖啡
  器物 > 产品、家具、器皿、电子设备、日用品、工具
  建筑设施 > 建筑、楼梯、桥梁、道路、设施
  交通工具 > 汽车、自行车、船、飞机、列车
  自然景观 > 山、水体、天空、云、岩石、雪
  其他

场景/地点（scene，最多 3）
  空间类型 > 室内、户外、半室内
  环境类型 > 城市、自然、乡村、工业、商业、交通
  场所类型 > 公园、街道、海边、湖边、树林、山地、草地、桥梁、餐饮空间、办公空间、商业空间、工业空间
  其他

人物属性（people，最多 8）
  人物状态 > 无人、未知
  人数 > 单人、双人、多人、人群
  性别 > 男性、女性、性别不明
  年龄段 > 婴幼儿、儿童、青少年、青年、中年、老年、年龄不明
  穿着 > 现代装、古装、民族服饰、职业装、制服、礼服、运动装、休闲装、泳装
  动作状态 > 站立、坐姿、行走、奔跑、交谈、工作、表演、休息
  其他
```

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

- 系统分面（subject/scene/purpose/color/composition/lighting/people/technical/custom）不可删除；status 生命周期按当前管理规则执行。
- `style` 不再是系统分面，也不再参与 AI 提示词、建议生成或工作台展示。
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
