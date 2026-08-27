//! 建表迁移：按 PRAGMA user_version 版本推进
//! v1 = 架构 v1.3 §1.4 全量 schema（含 fts_content 中间表 + 9 个触发器）

use rusqlite::Connection;

use crate::error::AppResult;

const SCHEMA_V1: &str = r#"
-- 素材表
CREATE TABLE assets (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  file_path     TEXT    NOT NULL UNIQUE,
  file_name     TEXT    NOT NULL,
  file_ext      TEXT    NOT NULL,
  file_size     INTEGER NOT NULL,
  mime_type     TEXT    NOT NULL,
  width         INTEGER,
  height        INTEGER,
  duration_ms   INTEGER,
  video_codec   TEXT,
  audio_codec   TEXT,
  taken_at      INTEGER,
  created_at    INTEGER NOT NULL,
  modified_at   INTEGER NOT NULL,
  hash          TEXT,
  placeholder_path TEXT,
  hd_thumbnail_path TEXT
);
CREATE INDEX idx_assets_mime    ON assets(mime_type);
CREATE INDEX idx_assets_created ON assets(created_at);

-- 标签表（父子层级，方案B）
CREATE TABLE tags (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT    NOT NULL,
  parent_id   INTEGER REFERENCES tags(id) ON DELETE CASCADE,
  is_preset   INTEGER NOT NULL DEFAULT 0,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  UNIQUE(parent_id, name)
);
CREATE INDEX idx_tags_parent ON tags(parent_id);

-- 素材-标签关联
CREATE TABLE asset_tags (
  asset_id   INTEGER NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  tag_id     INTEGER NOT NULL REFERENCES tags(id)  ON DELETE CASCADE,
  source     TEXT    NOT NULL DEFAULT 'manual',
  created_at INTEGER NOT NULL,
  PRIMARY KEY (asset_id, tag_id)
);
CREATE INDEX idx_asset_tags_tag   ON asset_tags(tag_id);
CREATE INDEX idx_asset_tags_asset ON asset_tags(asset_id);

-- FTS5 方案2：独立 fts_content 中间表（外部内容表）
CREATE TABLE fts_content (
  asset_id   INTEGER PRIMARY KEY,
  file_name  TEXT NOT NULL,
  tag_names  TEXT
);
CREATE VIRTUAL TABLE assets_fts USING fts5(
  file_name,
  tag_names,
  content='fts_content',
  content_rowid='asset_id',
  tokenize='unicode61'
);

-- 第一层触发器：FTS 索引维护（挂 fts_content，官方 old/new 三段式；
-- delete 必须提供原始插入值，否则旧 token 残留产生幻影命中——已实测）
CREATE TRIGGER trg_fc_ai AFTER INSERT ON fts_content BEGIN
  INSERT INTO assets_fts(rowid, file_name, tag_names)
    VALUES (new.asset_id, new.file_name, new.tag_names);
END;
CREATE TRIGGER trg_fc_ad AFTER DELETE ON fts_content BEGIN
  INSERT INTO assets_fts(assets_fts, rowid, file_name, tag_names)
    VALUES ('delete', old.asset_id, old.file_name, old.tag_names);
END;
CREATE TRIGGER trg_fc_au AFTER UPDATE ON fts_content BEGIN
  INSERT INTO assets_fts(assets_fts, rowid, file_name, tag_names)
    VALUES ('delete', old.asset_id, old.file_name, old.tag_names);
  INSERT INTO assets_fts(rowid, file_name, tag_names)
    VALUES (new.asset_id, new.file_name, new.tag_names);
END;

-- 第二层触发器：业务表只维护 fts_content
CREATE TRIGGER trg_assets_ai AFTER INSERT ON assets BEGIN
  INSERT INTO fts_content(asset_id, file_name, tag_names)
    VALUES (new.id, cjk_bigram(new.file_name), '');
END;
CREATE TRIGGER trg_assets_ad AFTER DELETE ON assets BEGIN
  DELETE FROM fts_content WHERE asset_id = old.id;
END;
CREATE TRIGGER trg_assets_au AFTER UPDATE OF file_name ON assets BEGIN
  UPDATE fts_content SET file_name = cjk_bigram(new.file_name) WHERE asset_id = new.id;
END;
-- COALESCE 必须包在 cjk_bigram 参数内（无标签时 group_concat 为 NULL，直传报错——已实测）
CREATE TRIGGER trg_at_ai AFTER INSERT ON asset_tags BEGIN
  UPDATE fts_content SET tag_names = (
    SELECT cjk_bigram(COALESCE(group_concat(t.name, ' '), ''))
      FROM asset_tags at JOIN tags t ON t.id = at.tag_id
     WHERE at.asset_id = new.asset_id
  ) WHERE asset_id = new.asset_id;
END;
CREATE TRIGGER trg_at_ad AFTER DELETE ON asset_tags BEGIN
  UPDATE fts_content SET tag_names = (
    SELECT cjk_bigram(COALESCE(group_concat(t.name, ' '), ''))
      FROM asset_tags at JOIN tags t ON t.id = at.tag_id
     WHERE at.asset_id = old.asset_id
  ) WHERE asset_id = old.asset_id;
END;
CREATE TRIGGER trg_tags_au AFTER UPDATE OF name ON tags BEGIN
  UPDATE fts_content SET tag_names = (
    SELECT cjk_bigram(COALESCE(group_concat(t2.name, ' '), ''))
      FROM asset_tags at JOIN tags t2 ON t2.id = at.tag_id
     WHERE at.asset_id = fts_content.asset_id
  ) WHERE asset_id IN (SELECT asset_id FROM asset_tags WHERE tag_id = new.id);
END;

-- AI 打标批次
CREATE TABLE ai_batches (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  status     TEXT NOT NULL DEFAULT 'pending',
  mode       TEXT NOT NULL,
  total      INTEGER NOT NULL DEFAULT 0,
  processed  INTEGER NOT NULL DEFAULT 0,
  confirmed  INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

-- AI 建议（确认才写 asset_tags）
CREATE TABLE ai_suggestions (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id       INTEGER NOT NULL REFERENCES ai_batches(id) ON DELETE CASCADE,
  asset_id       INTEGER NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  suggested_tags TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'pending',
  confirmed_tags TEXT,
  created_at     INTEGER NOT NULL
);
CREATE INDEX idx_ai_sugg_batch ON ai_suggestions(batch_id);

-- 设置（键值对）
CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- 网盘账号绑定
CREATE TABLE cloud_accounts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  provider      TEXT NOT NULL,
  name          TEXT,
  access_token  TEXT,
  refresh_token TEXT,
  cookie        TEXT,
  expires_at    INTEGER,
  created_at    INTEGER NOT NULL
);

-- 导出任务
CREATE TABLE export_tasks (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  target     TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'pending',
  total      INTEGER NOT NULL DEFAULT 0,
  done       INTEGER NOT NULL DEFAULT 0,
  dest_dir   TEXT,
  account_id INTEGER,
  share_url  TEXT,
  error      TEXT,
  created_at INTEGER NOT NULL
);
"#;

/// v2：EXIF 元信息列（PRD 5.5，打标工作台 2.0）
/// B37：逐列定义，配合 migrate_v2 容错（PRAGMA table_info 检查再 ALTER）
const SCHEMA_V2_COLUMNS: &[(&str, &str)] = &[
    ("camera", "TEXT"),
    ("lens", "TEXT"),
    ("iso", "INTEGER"),
    ("aperture", "REAL"),
    ("shutter", "TEXT"),
    ("focal", "REAL"),
];

/// B37：逐列检查再 ALTER，幂等可重入
/// SQLite ALTER TABLE ADD COLUMN 不支持 IF NOT EXISTS 语法，
/// 中途崩溃（部分列已加但 user_version 未提交）重启后重跑不会 panic。
fn migrate_v2(conn: &Connection) -> AppResult<()> {
    let existing: std::collections::HashSet<String> = {
        let mut stmt = conn.prepare("PRAGMA table_info(assets)")?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(1))?; // col 1 = name
        rows.filter_map(|r| r.ok()).collect()
    };
    for (col, ty) in SCHEMA_V2_COLUMNS {
        if !existing.contains(*col) {
            conn.execute(&format!("ALTER TABLE assets ADD COLUMN {col} {ty}"), [])?;
        }
    }
    Ok(())
}

/// v3：BUG-B 写入侧根治（cjk_bigram 在 CJK↔非CJK 边界插空格）+ BUG-D 写入侧加固
/// （tag 触发器 group_concat 加 ORDER BY t.sort_order, t.id）。
/// 旧 cjk_bigram 产物不可逆，必须 DELETE fts_content 后回源重算 + FTS rebuild。
/// 幂等可重入：先完成重建（DROP 触发器→回源重算→rebuild）再 set user_version=3；
/// 中途崩溃（user_version 未提交）重启后重跑无副作用——DELETE+回源重算+rebuild 天然幂等，
/// 且 'rebuild' 会先清空 assets_fts 索引再从 fts_content 重灌，确保与任意前序状态一致。
const SCHEMA_V3: &str = r#"
-- ① 重建 3 个 tag 触发器（group_concat 固定顺序，与 assets.rs fill_tags 展示排序一致）
DROP TRIGGER IF EXISTS trg_at_ai;
DROP TRIGGER IF EXISTS trg_at_ad;
DROP TRIGGER IF EXISTS trg_tags_au;

CREATE TRIGGER trg_at_ai AFTER INSERT ON asset_tags BEGIN
  UPDATE fts_content SET tag_names = (
    SELECT cjk_bigram(COALESCE(group_concat(x.name, ' '), ''))
      FROM (SELECT t.name FROM asset_tags at JOIN tags t ON t.id = at.tag_id
             WHERE at.asset_id = new.asset_id
             ORDER BY t.sort_order, t.id) x
  ) WHERE asset_id = new.asset_id;
END;
CREATE TRIGGER trg_at_ad AFTER DELETE ON asset_tags BEGIN
  UPDATE fts_content SET tag_names = (
    SELECT cjk_bigram(COALESCE(group_concat(x.name, ' '), ''))
      FROM (SELECT t.name FROM asset_tags at JOIN tags t ON t.id = at.tag_id
             WHERE at.asset_id = old.asset_id
             ORDER BY t.sort_order, t.id) x
  ) WHERE asset_id = old.asset_id;
END;
CREATE TRIGGER trg_tags_au AFTER UPDATE OF name ON tags BEGIN
  UPDATE fts_content SET tag_names = (
    SELECT cjk_bigram(COALESCE(group_concat(x.name, ' '), ''))
      FROM (SELECT t.name FROM asset_tags at JOIN tags t ON t.id = at.tag_id
             WHERE at.asset_id = fts_content.asset_id
             ORDER BY t.sort_order, t.id) x
  ) WHERE asset_id IN (SELECT asset_id FROM asset_tags WHERE tag_id = new.id);
END;

-- ② 从源表全量回源重算 fts_content（旧 cjk_bigram 产物不可逆，必须 DELETE 后回源重算）
DELETE FROM fts_content;
INSERT INTO fts_content(asset_id, file_name, tag_names)
  SELECT a.id,
         cjk_bigram(a.file_name),
         (SELECT cjk_bigram(COALESCE(group_concat(x.name, ' '), ''))
            FROM (SELECT t.name FROM asset_tags at JOIN tags t ON t.id = at.tag_id
                   WHERE at.asset_id = a.id
                   ORDER BY t.sort_order, t.id) x)
  FROM assets a;

-- ③ 重建外部内容表 FTS 索引（确保 assets_fts 与 fts_content 完全一致）
INSERT INTO assets_fts(assets_fts) VALUES('rebuild');
"#;

/// v4：M3-02 去重扫描索引（hash GROUP BY 走索引，3 万素材红线）
const SCHEMA_V4: &str = r#"
CREATE INDEX IF NOT EXISTS idx_assets_hash ON assets(hash);
"#;

/// v5：S3 包——排序索引（R-21）+ 回收站 deleted_at（R-22）+ 打标流水 tag_ops（R-25）
const SCHEMA_V5: &str = r#"
CREATE INDEX IF NOT EXISTS idx_assets_taken_at ON assets(taken_at);
CREATE INDEX IF NOT EXISTS idx_assets_size     ON assets(file_size);
CREATE INDEX IF NOT EXISTS idx_assets_deleted  ON assets(deleted_at);

-- 打标操作流水（R-25）：确认/摘标签写入，撤销按 batch_id 反向操作
CREATE TABLE IF NOT EXISTS tag_ops (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  asset_id   INTEGER NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  tag_id     INTEGER NOT NULL REFERENCES tags(id)  ON DELETE CASCADE,
  op         TEXT    NOT NULL,             -- add | remove
  actor      TEXT    NOT NULL,             -- manual | ai_cloud | ai_local
  batch_id   INTEGER,                      -- AI 批次 id（手工操作为 NULL）
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tag_ops_batch   ON tag_ops(batch_id);
CREATE INDEX IF NOT EXISTS idx_tag_ops_created ON tag_ops(created_at);
"#;

/// B37 同款容错：检查表是否已有某列（SQLite ALTER ADD COLUMN 不支持 IF NOT EXISTS，
/// 逐列检查再 ALTER，幂等可重入——中途崩溃重启重跑不会 panic）
fn has_column(conn: &Connection, table: &str, column: &str) -> AppResult<bool> {
    let mut stmt = conn.prepare(&format!("PRAGMA table_info({table})"))?;
    let rows = stmt.query_map([], |r| r.get::<_, String>(1))?;
    let mut names = rows.filter_map(|r| r.ok());
    Ok(names.any(|name| name == column))
}

/// B37 同款容错：先查列再 ALTER（deleted_at；SQLite ALTER 不支持 IF NOT EXISTS）
fn migrate_v5(conn: &Connection) -> AppResult<()> {
    if !has_column(conn, "assets", "deleted_at")? {
        conn.execute("ALTER TABLE assets ADD COLUMN deleted_at INTEGER", [])?;
    }
    conn.execute_batch(SCHEMA_V5)?;
    Ok(())
}

/// v6：本地打标错误详情——ai_suggestions 增加 last_error（单条失败原因落库供前端展示）
fn migrate_v6(conn: &Connection) -> AppResult<()> {
    if !has_column(conn, "ai_suggestions", "last_error")? {
        conn.execute("ALTER TABLE ai_suggestions ADD COLUMN last_error TEXT", [])?;
    }
    Ok(())
}

/// v7：P1-04 导出任务软提示——export_tasks 增加 warning 列（status=done 时的注意事项）
fn migrate_v7(conn: &Connection) -> AppResult<()> {
    if !has_column(conn, "export_tasks", "warning")? {
        conn.execute("ALTER TABLE export_tasks ADD COLUMN warning TEXT", [])?;
    }
    Ok(())
}

/// v8：标签系统地基——稳定分面、规范标签、别名、AI 候选明细与关联确认元数据。
/// 迁移仅增列/增表，保留现有 tag id 和 asset_tags 关联；所有步骤均可重入。
const SCHEMA_V8: &str = r#"
CREATE TABLE IF NOT EXISTS tag_facets (
  key            TEXT PRIMARY KEY,
  display_name   TEXT NOT NULL,
  description    TEXT NOT NULL DEFAULT '',
  selection_mode TEXT NOT NULL DEFAULT 'multi',
  max_items      INTEGER,
  sort_order     INTEGER NOT NULL DEFAULT 0,
  is_system      INTEGER NOT NULL DEFAULT 1,
  status         TEXT NOT NULL DEFAULT 'active',
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  CHECK(selection_mode IN ('single', 'multi')),
  CHECK(status IN ('active', 'deprecated'))
);

CREATE TABLE IF NOT EXISTS tag_aliases (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  tag_id           INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  alias            TEXT NOT NULL,
  normalized_alias TEXT NOT NULL,
  locale           TEXT NOT NULL DEFAULT '',
  alias_type       TEXT NOT NULL DEFAULT 'synonym',
  is_searchable    INTEGER NOT NULL DEFAULT 1,
  created_at       INTEGER NOT NULL,
  UNIQUE(tag_id, normalized_alias, locale),
  CHECK(alias_type IN ('synonym', 'old_name', 'translation', 'typo'))
);
CREATE INDEX IF NOT EXISTS idx_tag_aliases_lookup
  ON tag_aliases(normalized_alias, locale);

CREATE TABLE IF NOT EXISTS ai_suggestion_items (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  suggestion_id   INTEGER NOT NULL REFERENCES ai_suggestions(id) ON DELETE CASCADE,
  facet_key       TEXT NOT NULL,
  raw_name        TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  tag_id          INTEGER REFERENCES tags(id) ON DELETE SET NULL,
  confidence      REAL,
  decision        TEXT NOT NULL DEFAULT 'pending',
  decision_reason TEXT,
  created_at      INTEGER NOT NULL,
  CHECK(confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  CHECK(decision IN ('pending', 'accepted', 'modified', 'rejected'))
);
CREATE INDEX IF NOT EXISTS idx_ai_suggestion_items_suggestion
  ON ai_suggestion_items(suggestion_id);
CREATE INDEX IF NOT EXISTS idx_ai_suggestion_items_tag
  ON ai_suggestion_items(tag_id);

CREATE INDEX IF NOT EXISTS idx_tags_facet_status
  ON tags(facet_key, status, sort_order, id);
CREATE INDEX IF NOT EXISTS idx_tags_normalized
  ON tags(facet_key, normalized_name);
CREATE INDEX IF NOT EXISTS idx_asset_tags_confirmation
  ON asset_tags(confirmation, tag_id, asset_id);
"#;

fn add_column_if_missing(
    conn: &Connection,
    table: &str,
    column: &str,
    definition: &str,
) -> AppResult<()> {
    if !has_column(conn, table, column)? {
        conn.execute(
            &format!("ALTER TABLE {table} ADD COLUMN {column} {definition}"),
            [],
        )?;
    }
    Ok(())
}

fn migrate_v8(conn: &Connection) -> AppResult<()> {
    add_column_if_missing(conn, "tags", "canonical_name", "TEXT")?;
    add_column_if_missing(conn, "tags", "normalized_name", "TEXT")?;
    add_column_if_missing(conn, "tags", "facet_key", "TEXT NOT NULL DEFAULT 'custom'")?;
    add_column_if_missing(conn, "tags", "status", "TEXT NOT NULL DEFAULT 'active'")?;
    add_column_if_missing(conn, "tags", "is_system", "INTEGER NOT NULL DEFAULT 0")?;
    add_column_if_missing(conn, "tags", "description", "TEXT NOT NULL DEFAULT ''")?;

    add_column_if_missing(conn, "asset_tags", "confidence", "REAL")?;
    add_column_if_missing(
        conn,
        "asset_tags",
        "confirmation",
        "TEXT NOT NULL DEFAULT 'confirmed'",
    )?;
    add_column_if_missing(conn, "asset_tags", "confirmed_at", "INTEGER")?;
    add_column_if_missing(conn, "asset_tags", "confirmed_by", "TEXT")?;
    add_column_if_missing(conn, "asset_tags", "source_batch_id", "INTEGER")?;

    conn.execute_batch(SCHEMA_V8)?;
    let now = chrono::Utc::now().timestamp_millis();
    const FACETS: &[(&str, &str, &str, i64, i64)] = &[
        ("subject", "主体/对象", "画面中可观察到的主要对象", 5, 10),
        ("scene", "场景/地点", "素材发生的环境或地点", 3, 20),
        ("purpose", "用途", "稳定的发布或设计用途", 3, 30),
        ("style", "风格/氛围", "视觉风格与整体情绪", 4, 40),
        ("color", "色彩", "主色、色调与色彩关系", 3, 50),
        ("composition", "构图/视角", "景别、视角和构图关系", 4, 60),
        ("lighting", "光线/时间", "光线方向、质感和时间氛围", 3, 70),
        ("people", "人物属性", "人物数量、年龄段和可观察动作", 4, 80),
        (
            "technical",
            "可用性/技术特征",
            "透明背景、可裁切等非文件格式属性",
            4,
            90,
        ),
        (
            "custom",
            "自定义",
            "用户自定义且暂未归入固定分面的标签",
            0,
            100,
        ),
    ];
    for (key, name, description, max_items, sort_order) in FACETS {
        conn.execute(
            "INSERT OR IGNORE INTO tag_facets
             (key, display_name, description, selection_mode, max_items, sort_order, is_system, status, created_at, updated_at)
             VALUES (?1, ?2, ?3, 'multi', NULLIF(?4, 0), ?5, 1, 'active', ?6, ?6)",
            rusqlite::params![key, name, description, max_items, sort_order, now],
        )?;
    }

    conn.execute(
        "UPDATE tags SET canonical_name = name WHERE canonical_name IS NULL OR canonical_name = ''",
        [],
    )?;
    conn.execute(
        "UPDATE tags SET normalized_name = lower(trim(name)) WHERE normalized_name IS NULL OR normalized_name = ''",
        [],
    )?;
    conn.execute(
        "UPDATE asset_tags SET confirmed_by = 'migration', confirmed_at = created_at
          WHERE confirmed_by IS NULL",
        [],
    )?;

    // 旧分类根节点映射到稳定分面；未知根节点及其后代保留为 custom。
    const ROOT_MAPPINGS: &[(&str, &str)] = &[
        ("主体", "subject"),
        ("物体", "subject"),
        ("场景", "scene"),
        ("用途", "purpose"),
        ("风格", "style"),
        ("色彩风格", "style"),
        ("氛围情绪", "style"),
        ("色彩", "color"),
        ("构图视角", "composition"),
        ("构图/视角", "composition"),
        ("光线", "lighting"),
        ("光线/时间", "lighting"),
        ("人物", "people"),
        ("人物属性", "people"),
        ("技术", "technical"),
        ("可用性/技术特征", "technical"),
    ];
    for (root_name, facet_key) in ROOT_MAPPINGS {
        conn.execute(
            "WITH RECURSIVE sub(id) AS (
               SELECT id FROM tags WHERE parent_id IS NULL AND name = ?1
               UNION ALL SELECT t.id FROM tags t JOIN sub s ON t.parent_id = s.id
             )
             UPDATE tags SET facet_key = ?2,
                    is_system = CASE WHEN parent_id IS NULL THEN 1 ELSE is_system END
              WHERE id IN (SELECT id FROM sub)",
            rusqlite::params![root_name, facet_key],
        )?;
    }

    // FTS 文档包含规范标签名和可搜索别名；别名变化也会刷新相关素材。
    conn.execute_batch(
        r#"
DROP TRIGGER IF EXISTS trg_at_ai;
DROP TRIGGER IF EXISTS trg_at_ad;
DROP TRIGGER IF EXISTS trg_tags_au;
DROP TRIGGER IF EXISTS trg_tag_alias_ai;
DROP TRIGGER IF EXISTS trg_tag_alias_au;
DROP TRIGGER IF EXISTS trg_tag_alias_ad;

CREATE TRIGGER trg_at_ai AFTER INSERT ON asset_tags BEGIN
  UPDATE fts_content SET tag_names = (
    SELECT cjk_bigram(COALESCE(group_concat(x.term, ' '), '')) FROM (
      SELECT t.name AS term, t.sort_order AS ord, t.id AS tid, 0 AS kind
        FROM asset_tags at JOIN tags t ON t.id = at.tag_id
       WHERE at.asset_id = new.asset_id AND t.status = 'active'
      UNION ALL
      SELECT ta.alias AS term, t.sort_order AS ord, t.id AS tid, 1 AS kind
        FROM asset_tags at JOIN tags t ON t.id = at.tag_id
        JOIN tag_aliases ta ON ta.tag_id = t.id AND ta.is_searchable = 1
       WHERE at.asset_id = new.asset_id AND t.status = 'active'
      ORDER BY ord, tid, kind, term
    ) x
  ) WHERE asset_id = new.asset_id;
END;
CREATE TRIGGER trg_at_ad AFTER DELETE ON asset_tags BEGIN
  UPDATE fts_content SET tag_names = (
    SELECT cjk_bigram(COALESCE(group_concat(x.term, ' '), '')) FROM (
      SELECT t.name AS term, t.sort_order AS ord, t.id AS tid, 0 AS kind
        FROM asset_tags at JOIN tags t ON t.id = at.tag_id
       WHERE at.asset_id = old.asset_id AND t.status = 'active'
      UNION ALL
      SELECT ta.alias AS term, t.sort_order AS ord, t.id AS tid, 1 AS kind
        FROM asset_tags at JOIN tags t ON t.id = at.tag_id
        JOIN tag_aliases ta ON ta.tag_id = t.id AND ta.is_searchable = 1
       WHERE at.asset_id = old.asset_id AND t.status = 'active'
      ORDER BY ord, tid, kind, term
    ) x
  ) WHERE asset_id = old.asset_id;
END;
CREATE TRIGGER trg_tags_au AFTER UPDATE OF name, status ON tags BEGIN
  UPDATE fts_content SET tag_names = (
    SELECT cjk_bigram(COALESCE(group_concat(x.term, ' '), '')) FROM (
      SELECT t.name AS term, t.sort_order AS ord, t.id AS tid, 0 AS kind
        FROM asset_tags at JOIN tags t ON t.id = at.tag_id
       WHERE at.asset_id = fts_content.asset_id AND t.status = 'active'
      UNION ALL
      SELECT ta.alias AS term, t.sort_order AS ord, t.id AS tid, 1 AS kind
        FROM asset_tags at JOIN tags t ON t.id = at.tag_id
        JOIN tag_aliases ta ON ta.tag_id = t.id AND ta.is_searchable = 1
       WHERE at.asset_id = fts_content.asset_id AND t.status = 'active'
      ORDER BY ord, tid, kind, term
    ) x
  ) WHERE asset_id IN (SELECT asset_id FROM asset_tags WHERE tag_id = new.id);
END;
CREATE TRIGGER trg_tag_alias_ai AFTER INSERT ON tag_aliases BEGIN
  UPDATE fts_content SET tag_names = (
    SELECT cjk_bigram(COALESCE(group_concat(x.term, ' '), '')) FROM (
      SELECT t.name AS term, t.sort_order AS ord, t.id AS tid, 0 AS kind
        FROM asset_tags at JOIN tags t ON t.id = at.tag_id
       WHERE at.asset_id = fts_content.asset_id AND t.status = 'active'
      UNION ALL
      SELECT ta.alias AS term, t.sort_order AS ord, t.id AS tid, 1 AS kind
        FROM asset_tags at JOIN tags t ON t.id = at.tag_id
        JOIN tag_aliases ta ON ta.tag_id = t.id AND ta.is_searchable = 1
       WHERE at.asset_id = fts_content.asset_id AND t.status = 'active'
      ORDER BY ord, tid, kind, term
    ) x
  ) WHERE asset_id IN (SELECT asset_id FROM asset_tags WHERE tag_id = new.tag_id);
END;
CREATE TRIGGER trg_tag_alias_au AFTER UPDATE ON tag_aliases BEGIN
  UPDATE fts_content SET tag_names = (
    SELECT cjk_bigram(COALESCE(group_concat(x.term, ' '), '')) FROM (
      SELECT t.name AS term, t.sort_order AS ord, t.id AS tid, 0 AS kind
        FROM asset_tags at JOIN tags t ON t.id = at.tag_id
       WHERE at.asset_id = fts_content.asset_id AND t.status = 'active'
      UNION ALL
      SELECT ta.alias AS term, t.sort_order AS ord, t.id AS tid, 1 AS kind
        FROM asset_tags at JOIN tags t ON t.id = at.tag_id
        JOIN tag_aliases ta ON ta.tag_id = t.id AND ta.is_searchable = 1
       WHERE at.asset_id = fts_content.asset_id AND t.status = 'active'
      ORDER BY ord, tid, kind, term
    ) x
  ) WHERE asset_id IN (SELECT asset_id FROM asset_tags WHERE tag_id IN (old.tag_id, new.tag_id));
END;
CREATE TRIGGER trg_tag_alias_ad AFTER DELETE ON tag_aliases BEGIN
  UPDATE fts_content SET tag_names = (
    SELECT cjk_bigram(COALESCE(group_concat(x.term, ' '), '')) FROM (
      SELECT t.name AS term, t.sort_order AS ord, t.id AS tid, 0 AS kind
        FROM asset_tags at JOIN tags t ON t.id = at.tag_id
       WHERE at.asset_id = fts_content.asset_id AND t.status = 'active'
      UNION ALL
      SELECT ta.alias AS term, t.sort_order AS ord, t.id AS tid, 1 AS kind
        FROM asset_tags at JOIN tags t ON t.id = at.tag_id
        JOIN tag_aliases ta ON ta.tag_id = t.id AND ta.is_searchable = 1
       WHERE at.asset_id = fts_content.asset_id AND t.status = 'active'
      ORDER BY ord, tid, kind, term
    ) x
  ) WHERE asset_id IN (SELECT asset_id FROM asset_tags WHERE tag_id = old.tag_id);
END;

UPDATE fts_content SET tag_names = (
  SELECT cjk_bigram(COALESCE(group_concat(x.term, ' '), '')) FROM (
    SELECT t.name AS term, t.sort_order AS ord, t.id AS tid, 0 AS kind
      FROM asset_tags at JOIN tags t ON t.id = at.tag_id
     WHERE at.asset_id = fts_content.asset_id AND t.status = 'active'
    UNION ALL
    SELECT ta.alias AS term, t.sort_order AS ord, t.id AS tid, 1 AS kind
      FROM asset_tags at JOIN tags t ON t.id = at.tag_id
      JOIN tag_aliases ta ON ta.tag_id = t.id AND ta.is_searchable = 1
     WHERE at.asset_id = fts_content.asset_id AND t.status = 'active'
    ORDER BY ord, tid, kind, term
  ) x
);
INSERT INTO assets_fts(assets_fts) VALUES('rebuild');
"#,
    )?;
    Ok(())
}

/// v9：超级搜索查询索引（P1A）。只加索引，不改业务行数。
/// 评审 §三.3 取舍：只加 taken_at / camera / file_size / (width,height) 四个；
/// file_ext 基数极低不做；lens / duration_ms 等真出现慢查询再说；aspect_ratio 为派生表达式暂无索引承诺。
const SCHEMA_V9: &str = r#"
CREATE INDEX IF NOT EXISTS idx_assets_taken_at ON assets(taken_at);
CREATE INDEX IF NOT EXISTS idx_assets_camera   ON assets(camera);
CREATE INDEX IF NOT EXISTS idx_assets_file_size ON assets(file_size);
CREATE INDEX IF NOT EXISTS idx_assets_width_height ON assets(width, height);
"#;

/// v10：tagCategories（中文名机器协议）→ ai_facet_configs（稳定 facet_key）已在上方 migrate() 处理。

/// v11：独立 color 分面补齐（指导书 C-3/C-5）。
/// 老库 V8 已建 tag_facets，但默认 AI 配置曾把「色彩风格」归 style 而缺少独立 color；
/// 新库由 default_tag_categories 覆盖（含「色彩」→color）。本迁移幂等：
///  ① INSERT OR IGNORE 补齐 color tag_facets 行；
///  ② 若 ai_facet_configs 缺 color 配置则补默认（不覆盖用户已有 style hint/配置内容）。
fn migrate_v11(conn: &Connection) -> AppResult<()> {
    let now = chrono::Utc::now().timestamp_millis();
    conn.execute(
        "INSERT OR IGNORE INTO tag_facets
         (key, display_name, description, selection_mode, max_items, sort_order, is_system, status, created_at, updated_at)
         VALUES ('color', '色彩', '主色、色调与色彩关系', 'multi', 3, 50, 1, 'active', ?1, ?1)",
        rusqlite::params![now],
    )?;
    super::settings::ensure_color_facet_config(conn)?;
    Ok(())
}

pub fn migrate(conn: &Connection) -> AppResult<()> {
    let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    if version < 1 {
        conn.execute_batch(SCHEMA_V1)?;
        conn.pragma_update(None, "user_version", 1)?;
    }
    if version < 2 {
        // B37：逐列容错 ALTER，幂等可重入
        migrate_v2(conn)?;
        conn.pragma_update(None, "user_version", 2)?;
    }
    if version < 3 {
        // 先完成重建再提交 user_version=3：中途崩溃重启能重跑（V3 天然幂等）
        conn.execute_batch(SCHEMA_V3)?;
        conn.pragma_update(None, "user_version", 3)?;
    }
    if version < 4 {
        conn.execute_batch(SCHEMA_V4)?;
        conn.pragma_update(None, "user_version", 4)?;
    }
    if version < 5 {
        migrate_v5(conn)?;
        conn.pragma_update(None, "user_version", 5)?;
    }
    if version < 6 {
        migrate_v6(conn)?;
        conn.pragma_update(None, "user_version", 6)?;
    }
    if version < 7 {
        migrate_v7(conn)?;
        conn.pragma_update(None, "user_version", 7)?;
    }
    if version < 8 {
        migrate_v8(conn)?;
        conn.pragma_update(None, "user_version", 8)?;
    }
    if version < 9 {
        conn.execute_batch(SCHEMA_V9)?;
        conn.pragma_update(None, "user_version", 9)?;
    }
    if version < 10 {
        // V10：旧 tagCategories（中文名机器协议）→ ai_facet_configs（稳定 facet_key）。
        // 设置在键值表存 JSON，这里读出来转换后写回；幂等（已转则不变）。
        super::settings::normalize_settings_persist(conn)?;
        conn.pragma_update(None, "user_version", 10)?;
    }
    if version < 11 {
        // V11：独立 color 分面补齐（新库/存量库都成立），幂等
        migrate_v11(conn)?;
        conn.pragma_update(None, "user_version", 11)?;
    }
    Ok(())
}
