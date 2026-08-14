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
| `thumbnail.rs` | 已入库双层缩略图（瘦壳） | 占位图/高清图；`get_or_create_hd` 用 `Arc<Mutex>` 短暂持锁（解码放锁外） |
| `importer.rs` | 入库管线 | 复制入分库 → 改名模板 → EXIF 提取 → 占位图 → 落库 |
| `exif_meta.rs` | EXIF 提取 | kamadak-exif：camera/lens/iso/aperture/shutter/focal/taken_at；`parse_exif_datetime` 本地时区 |
| `ai_cloud.rs` | 云端打标 | 双模式请求（OpenAI 兼容 / Anthropic Messages）+ `parse_tags_strict`（空解析即失败，v2.12）+ 逐条写回 + 进度回调 + 取消 |
| `export_local.rs` | 本地导出 | 复制 + 完整性校验 |
| `video.rs` | 视频封面帧提取 | 内嵌封面优先 |
| `dedup.rs` | 哈希去重（预留） | — |

### 2.2 db/（数据层）

| 模块 | 职责 |
|---|---|
| `migrations.rs` | 版本化迁移（v2 = assets 加 6 个 EXIF 列） |
| `assets.rs` | 素材 CRUD + `set_exif`；Asset 含 EXIF 字段 |
| `tags.rs` | 父子层级标签树；`find_or_create_root/child` |
| `asset_tags.rs` | 素材-标签关联 |
| `search.rs` | FTS5 查询：fts_content 表 + 9 触发器 + cjk_bigram 逐字切分 + 短语查询 + ≤2 字 LIKE 兜底 |
| `ai.rs` | 批次/建议表；`CategorizedTags = BTreeMap<String, Vec<String>>`；`parse_tags_json` 兼容旧扁平数组→「未分类」 |
| `settings.rs` | `ApiProfile{id,name,api_mode,base_url,api_key,model}` + `profiles[]/active_profile` + `TagCategory{name,hint,single,max}`；`normalize()` 旧扁平字段迁移（skip_serializing 只读，拒绝双数据源） |
| `cloud.rs` / `export.rs` | 网盘/导出记录（M2 预留） |

**settings 表只有一个 key：`app_settings`**（JSON 整体存取）。排查配置问题时别查 `key='settings'`。

### 2.3 commands/（Tauri 命令薄壳）

ai_cmd / assets_cmd / import_cmd / thumbnail_cmd / tags_cmd / settings_cmd / export_cmd。网络请求一律 `spawn_blocking` 不堵主线程；进度走 `app.emit("ai://progress", …)`。

## 三、前端结构（src/）

| 层 | 内容 |
|---|---|
| `pages/` | ImportPage（编排层瘦身）/ LibraryPage / AiTaggingPage / SettingsPage |
| `stores/` | libraryStore / selectionStore / tagStore / aiStore / settingsStore（Zustand） |
| `api/` | invoke 封装 + 模块级缓存（preview.ts）；`client.ts` 统一错误 |
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

### 4.4 中文搜索

FTS5 `fts_content` 独立表 + 9 个触发器同步 + 自注册 `cjk_bigram` 分词（逐字切分）+ 短语查询 + ≤2 字 LIKE 兜底。**注意**：外部工具（python sqlite3）连接此库只能 SELECT，DELETE/UPDATE 会因缺 `cjk_bigram` 函数报错——清数据必须用应用内功能。

### 4.5 UI 规范（全局约束）

- 黑白灰高级感；主 CTA（开始打标/确认写入/全部确认）黑色实心，其余幽灵文字按钮
- 苹果式简约动效；背景不透明（查看器等效新界面）
- CSS 变量主题（`--color-danger` 等），深色模式/定制主题走变量不换结构

## 五、数据流速查

| 链路 | 路径 |
|---|---|
| 入库 | ImportPage → importStore → import_cmd → importer（复制/改名/EXIF/占位图）→ assets 落库 |
| 缩略图 | Thumbnail.tsx → thumbnail_cmd → thumbnail.rs → imaging.rs → 缓存目录 |
| AI 打标 | LibraryPage 选图 → aiStore.createBatch → ai_cmd → ai.create_batch（pending 占位）→ AiTaggingPage → startBatch → run_cloud_batch（逐条 request_tags→set_suggestion_tags，失败置 rejected）→ emit 进度 → Workbench 确认 → ai_apply_tags 写标签树 |
| 搜索 | SearchInput（防抖）→ assets_cmd.list_assets → search.rs（FTS5 三策略） |
| 配置 | SettingsPage → settingsStore → settings_cmd → settings.rs（normalize 迁移） |

## 六、已知设计约束（不要违反）

1. 图像解码**只允许**走 imaging.rs（preview/thumbnail 是瘦壳，禁止另起解码逻辑）
2. DB 写操作必须短暂持锁；耗时操作（解码/网络）放锁外
3. 拒绝/删除不做物理删除，翻转状态（防误触）；物理删除仅 R-31 双策略弹窗确认后
4. 分类上限 500 张/批（batch_limit）；prompt 里分类 max 约束必须与实际 UI 一致
5. 旧字段迁移用 `normalize()` 只读模式，禁止新旧双数据源并行写
