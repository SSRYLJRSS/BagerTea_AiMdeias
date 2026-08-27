# 茶包素材 V2 — 架构现状手册

> 版本 v1.0 ｜ 2026-08-12 ｜ 对应代码：PRD v2.12 实现态
> 定位：**代码实际结构的权威描述**，随代码同步更新。

---

## 一、总览

```
┌──────────────────────────── 前端（React 19 + Zustand + Tailwind v4）────────────────────────────┐
│  pages（4 页） ──► stores（5 个） ──► api/（invoke 封装） ──► types（与 Rust serde 对齐）        │
│  components/（common · layout · library · import · ai · dialogs）                                │
└──────────────────────────────────────┬─────────────────────────────────────────────────────────┘
                                       │ Tauri invoke / 事件（ai://progress 等）
┌──────────────────────────────────────┴─────────────────────────────────────────────────────────┐
│  Rust 后端（src-tauri）                                                                          │
│  commands/（薄壳：参数校验 + 锁 + 事件）──► services/（业务逻辑）──► db/（SQL + 迁移）            │
│  state.rs（AppState：DB 连接 + 取消注册表）  error.rs（统一 AppError）  utils/（纯函数）          │
└────────────────────────────────────────────────────────────────────────────────────────────────┘
```

**分层铁律**：commands 是薄壳（不写业务），services 持业务逻辑（可单测），db 只管 SQL。任何"一个函数全写一个文件"的写法都是违规。

## 二、后端模块职责（src-tauri/src）

### 2.1 services/（业务核心）

| 模块 | 职责 | 关键机制 |
|---|---|---|
| `imaging.rs` | **全局唯一图像解码引擎**（老板点名"全局公用一个"） | 内嵌策略链 + 4 许可信号量 + 宽容裁剪，详见第四节 |
| `preview.rs` | 待入库预览（瘦壳） | 缓存键 + 委托 imaging |
| `thumbnail.rs` | 已入库双层缩略图（瘦壳） | 占位图/高清图 + LRU 清理（B05）；`get_or_create_hd` 短持锁（解码放锁外） |
| `importer.rs` | 入库管线 | 复制入分库 → 改名模板 → EXIF 提取 → 占位图 → 落库 |
| `exif_meta.rs` | EXIF 提取 | kamadak-exif：camera/lens/iso/aperture/shutter/focal/taken_at；`parse_exif_datetime` 本地时区 |
| `ai_cloud.rs` | 云端/本地统一打标管线 | OpenAI 兼容 + Anthropic 双协议 + `parse_tags_strict`（v2.12）+ Ollama 退化输出自愈（卸载重载）+ 进度回调 + 取消 |
| `export_local.rs` | 本地导出 | copy/move + 同名唯一化（B06b）+ R-26 子目录（by_tag/by_date）+ CSV 清单（公式注入转义）+ 任务持久化 + 完成软提示 |
| `video.rs` | 视频封面帧/关键帧提取 | 内嵌封面优先 + 抽帧打标（P3-02） |
| `dedup.rs` | 哈希去重（v4 索引 + 入库去重 + 去重扫描） | M3-02 去重对话框 |
| `heic_decode.rs` / `raw_decode.rs` | HEIC/RAW 解码兜底层 | libheif 静态链 + darktable rawler |
| `ollama_setup.rs` / `ollama_installer.rs` | 本地模型一键配置/安装（A2/A3） | ping/probe/pull + 多源降级 + 断点续传 + 自动安装 |

### 2.2 db/（数据层）

| 模块 | 职责 |
|---|---|
| `migrations.rs` | 版本化迁移（v2 EXIF 列 / v3 FTS 重建 / v4 去重索引 / v5 排序+回收站+tag_ops / v6 last_error / v7 导出任务 warning / **v9 查询索引 / v10 旧 tagCategories→facet configs / v11 独立 color 分面补齐**） |
| `assets.rs` | 素材 CRUD + `set_exif`；Asset 含 EXIF 字段；`AssetFilter{metadata_filters, sort_by/sort_dir, …}` + `validate()` 参数校验 |
| `search.rs` | FTS5 查询：库内谓词 `SearchPredicate{sql, params}`（不返回大 ID 列表）；`build_search_predicate` 编译 FTS/LIKE 分支 |
| `search_query.rs` | 元数据白名单编译：`MetadataFilter{key, op, value, values, min, max}` → 参数化 SQL；key×op 校验、NULL 排除、日期左闭右开、resolution/aspect_ratio 派生表达式 |
| `tags.rs` | 父子层级标签树；`find_or_create_root/child`；`search_candidates`（规范名/别名/候选） |
| `tag_facets.rs` | 稳定分面（key 是机器协议）；`FacetPromptContext` + `build_prompt_context`（合并 AI facet 配置与 DB tag_facets） |
| `asset_tags.rs` | 素材-标签关联 |
| `tag_ops.rs` | 打标流水（R-25）：add/remove + 批次撤销 |
| `ai.rs` | 批次/建议表；`CategorizedTags = BTreeMap<String, Vec<String>>`；`parse_tags_json` 兼容旧扁平数组→「未分类」 |
| `settings.rs` | `ApiProfile{id,name,api_mode,kind,base_url,api_key,model}` + `profiles[]/active_profile` + `AiFacetConfig{facet_key,hint,enabled_for_ai,display_name,visible_in_workbench}`（tag_categories 已弃用仅作迁移输入；`visible_in_workbench` 独立于 `enabled_for_ai` 控制工作台显隐，缺省前端按 `WORKBENCH_DEFAULT_KEYS` 白名单决定）；`normalize()` 旧扁平字段迁移（skip_serializing 只读，拒绝双数据源） |
| `export.rs` | 导出任务持久化（copy/move/CSV 统一任务模型，含 warning 软提示列） |
| `cloud.rs` | 网盘账号（M2 预留，前端置灰） |

**settings 表只有一个 key：`app_settings`**（JSON 整体存取）。排查配置问题时别查 `key='settings'`。

### 2.3 commands/（Tauri 命令薄壳）

ai_cmd / assets_cmd / import_cmd / thumbnail_cmd / tags_cmd / settings_cmd / export_cmd / ollama_cmd / super_search_cmd。
网络请求一律 `spawn_blocking` 不堵主线程；进度走 `app.emit("ai://progress" / "export://progress" /
"import://progress" / "ollama://pull-progress", …)`。超级搜索 `ai_parse_search_query` 同样短锁读配置→放锁→spawn_blocking 网络→短锁解析 tagId。

## 三、前端结构（src/）

| 层 | 内容 |
|---|---|
| `pages/` | ImportPage（编排层瘦身）/ LibraryPage / AiTaggingPage / SettingsPage / SuperSearchPage |
| `stores/` | libraryStore / selectionStore / tagStore / aiStore / settingsStore / taskStore（全局任务条，M3-04）/ superSearchStore（独立 query，防污染普通素材库） |
| `api/` | invoke 封装 + 模块级缓存（preview.ts）；`client.ts` 统一错误；superSearch.ts 把 ResolvedSearchQuery 转 AssetFilter |
| `types/` | 与 Rust 结构体 serde 对齐（改 Rust 字段必须同步改这里） |

**关键组件**：

- 素材库：`AssetGrid`（虚拟滚动 + 单击选中/再击取消 + 右键菜单）→ `GridToolbar`（搜索+操作条+计数）→ `SideBar`（类型区+标签区）→ `ViewerPage`（全屏查看器）
- 通用：`ContextMenu`（右键菜单，**捕获关闭必须排除菜单内部**）、`ModelSelect`（模型自动拉取+手输兜底）
- 入库：`RenameBuilder`（改名按钮构造器：点选变色排序、序号位数手输）+ `PendingList`（双视图，固定 36px 头部，列表模式纯文字）
- 打标：`Filmstrip`（胶片条）+ `Workbench`（工作台：悬浮导航条+两列分类+max 约束+恢复按钮）

## 四、关键机制（改代码前必读）

### 4.1 imaging 全局图像引擎（性能命脉）

```
decode_thumb(path, target_px)
  └─ 策略链：① 自写 TIFF 遍历取内嵌预览（locate_tiff_base：JPEG 容器 APP1 定位，
     IFD 偏移相对 TIFF 基准而非文件头；RW2 magic 0x55 / 标准 0x2A；0x0201/0x0202
     + Panasonic 0x2E UNDEF count 即长度）
     ② FFD8 标记扫描兜底（.jpg 禁用——防误抓 7.5MB 主图）
     ③ 全图解码兜底
  └─ cut_jpeg 宽容裁剪：前 64 字节找 SOI、末尾 rfind EOI（某些相机有 FF 填充字节）
  └─ 并发控制：4 许可信号量（Mutex<usize> + Condvar，RAII guard）
```

配套：`Cargo.toml` 对 image/zune-jpeg/png/kamadak-exif/rayon 强制 `[profile.dev.package.*] opt-level=3`（debug 全解码 12.7s→0.37s）。**新增图像依赖必须同步加 O3**。

### 4.2 打标状态机（v2.12 修订）

```
批次：pending ──► processing ──► done
                    │           ▲
                    └──► cancelled ─┘  ← done/cancelled 均可再次启动，续跑剩余 pending（仅 processing 拒绝）
建议：pending ──► confirmed（确认写入标签树）
        │  └──► rejected（可 ai_restore_suggestion 恢复，防误触）
        └── 单条失败（含空解析）自动置 rejected + tracing::warn，不阻塞批次
```

- 前端流程：素材库选好 → `createBatch`（只建批不调 AI；manual 建完即 done）→ 打标页展示全部图片 → 老板手动点「开始打标」→ `startBatch(limit?)`（打标全部 / 仅前 N 张）
- AI 配置多档案：`profiles[]` + `active_profile` 自由切换（多中转站场景）

### 4.3 标签体系

- **EXIF 自身标签**：入库自动提取，只读展示，打标界面不显示、不参与 AI 打标
- **AI 分类标签**：`CategorizedTags`（分类名→标签数组）；分类即父标签复用标签树（零新表）；`TagCategory.max` 写入提示词"可多选 1-N 个"；设置页可自定义分类与上限

### 4.4 中文搜索与超级搜索

**中文搜索**：FTS5 `fts_content` 独立表 + 触发器同步 + 自注册 `cjk_bigram` 分词（逐字切分）+ 短语查询 + ≤2 字 LIKE 兜底。**P1A 改造**：不再把全部命中 ID 拉回 Rust 拼长 IN 列表，`search.rs::build_search_predicate` 编译为 `SearchPredicate{sql, params}` 谓词（FTS 子查询 / LIKE EXISTS / 并集 OR），在数据库内与其他条件组合。

**超级搜索**（一期）：两层查询对象——AI 输出 `SearchIntent`（文字/字段/op，无 id/SQL/分页），后端解析为 `ResolvedSearchQuery`（已解析 tagId + 合法字段）。元数据筛选走 `search_query.rs` 白名单编译（key×op 双白名单、全部参数绑定、NULL 排除、日期左闭右开、resolution=width*height、aspect_ratio=width/height）。`tag_facets.key` 是唯一机器协议，`selection_mode/max_items` 以数据库为准，设置不再存第二份。查询语义：同分面默认 OR、分面间 AND、父标签默认含后代、排除默认含后代、默认不查回收站、排序尾缀 `a.id DESC` 稳定分页。AI 搜索零数据库写入。**注意**：外部工具（python sqlite3）连接此库只能 SELECT，DELETE/UPDATE 会因缺 `cjk_bigram` 函数报错——清数据必须用应用内功能。

### 4.5 UI 规范（全局约束）

- 黑白灰高级感；主 CTA（开始打标/确认写入/全部确认）黑色实心，其余幽灵文字按钮
- 苹果式简约动效；背景不透明（查看器等效新界面）
- CSS 变量主题（`--color-danger` 等），深色模式/定制主题走变量不换结构

## 五、数据流速查

| 链路 | 路径 |
|---|---|
| 入库 | ImportPage（本地 state）→ import_cmd → importer（复制/改名/EXIF/占位图）→ assets 落库 |
| 缩略图 | Thumbnail.tsx → thumbnail_cmd → thumbnail.rs → imaging.rs → 缓存目录 |
| AI 打标 | LibraryPage 选图 → aiStore.createBatch → ai_cmd → ai.create_batch（pending 占位）→ AiTaggingPage → startBatch → run_cloud_batch（逐条 request_tags→set_suggestion_tags，失败置 rejected）→ emit 进度 → Workbench 确认 → ai_apply_tags 写标签树 |
| 本地模型 | LocalModelGroup → ollama_cmd → ollama_setup/ollama_installer（检测/推荐/拉取/一键安装） |
| 搜索 | SearchInput（防抖）→ assets_cmd.list_assets → search.rs（FTS5 三策略） |
| 超级搜索 | BottomBar 双击素材库 → SuperSearchPage → superSearchStore → assets.list（库内谓词） |
| AI 超级搜索 | SuperSearchPage AiSearchBar → superSearchStore.applyAiSearch → ai_parse_search_query → super_search_ai（三级降级）→ resolve_query → superSearchStore 回填芯片并刷新 |
| 配置 | SettingsPage → settingsStore → settings_cmd → settings.rs（normalize 迁移） |

## 六、已知设计约束（不要违反）

1. 图像解码**只允许**走 imaging.rs（preview/thumbnail 是瘦壳，禁止另起解码逻辑）
2. DB 写操作必须短暂持锁；耗时操作（解码/网络）放锁外
3. 拒绝/删除不做物理删除，翻转状态（防误触）；物理删除仅 R-31 双策略弹窗确认后
4. 分类上限 500 张/批（batch_limit）；prompt 里分类 max 约束必须与实际 UI 一致
5. 旧字段迁移用 `normalize()` 只读模式，禁止新旧双数据源并行写
