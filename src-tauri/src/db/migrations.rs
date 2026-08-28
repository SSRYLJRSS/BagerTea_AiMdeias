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

/// v12：媒体元数据结构化字段 + 原始 JSON + 扫描状态（指导书 §7.4/§13.1）。
/// 只新增列，不改业务行；不在此迁移中扫描/回填视频（回填由可取消后台任务负责）。
/// 逐列 ALTER，幂等可重入（中途崩溃重启重跑不 panic）。
const V12_COLUMNS: &[(&str, &str)] = &[
    ("media_kind", "TEXT"),                 // image | video | unknown（后端探测事实源）
    ("container_format", "TEXT"),
    ("video_profile", "TEXT"),
    ("pixel_format", "TEXT"),
    ("bit_depth", "INTEGER"),
    ("frame_rate", "REAL"),                 // 简化：平均帧率小数；分子/分母原始值见 media_metadata_json
    ("video_bit_rate", "INTEGER"),
    ("color_range", "TEXT"),
    ("color_space", "TEXT"),
    ("color_transfer", "TEXT"),
    ("color_primaries", "TEXT"),
    ("audio_sample_rate", "INTEGER"),
    ("audio_channels", "INTEGER"),
    ("audio_layout", "TEXT"),
    ("rotation", "INTEGER"),
    ("media_metadata_json", "TEXT"),        // 原始 ffprobe JSON 留底
    ("metadata_version", "INTEGER"),        // 探测协议版本
    ("metadata_scanned_at", "INTEGER"),     // 最近一次探测时间（ms）
    ("metadata_error", "TEXT"),             // 探测失败原因；NULL 表示未探测/成功
];

fn migrate_v12(conn: &Connection) -> AppResult<()> {
    for (col, ty) in V12_COLUMNS {
        add_column_if_missing(conn, "assets", col, ty)?;
    }
    Ok(())
}

/// v13：标签分面生命周期能力（指导书 §12.2/§13.1 仅补真实缺失能力）。
/// ① 给 tag_facets 增加 `applies_to`（all|image|video，默认 all）；
/// ② 状态拓宽为 active|inactive|deprecated（原 CHECK 只有 active|deprecated）。
/// SQLite 无法 ALTER CHECK，需重建表；无任何表以 FK 引用 tag_facets（tags.facet_key 只是普通 TEXT 列），
/// 重建安全。幂等：仅当缺 applies_to 列时执行。
const V13_FACETS: &str = r#"
CREATE TABLE tag_facets_new (
  key            TEXT PRIMARY KEY,
  display_name   TEXT NOT NULL,
  description    TEXT NOT NULL DEFAULT '',
  selection_mode TEXT NOT NULL DEFAULT 'multi',
  max_items      INTEGER,
  sort_order     INTEGER NOT NULL DEFAULT 0,
  is_system      INTEGER NOT NULL DEFAULT 1,
  status         TEXT NOT NULL DEFAULT 'active',
  applies_to     TEXT NOT NULL DEFAULT 'all',
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  CHECK(selection_mode IN ('single', 'multi')),
  CHECK(status IN ('active', 'inactive', 'deprecated')),
  CHECK(applies_to IN ('all', 'image', 'video'))
);
INSERT INTO tag_facets_new
  (key, display_name, description, selection_mode, max_items, sort_order, is_system, status, applies_to, created_at, updated_at)
SELECT key, display_name, description, selection_mode, max_items, sort_order, is_system,
       CASE WHEN status = 'deprecated' THEN 'inactive' ELSE status END,
       'all', created_at, updated_at
  FROM tag_facets;
DROP TABLE tag_facets;
ALTER TABLE tag_facets_new RENAME TO tag_facets;
"#;

fn migrate_v13(conn: &Connection) -> AppResult<()> {
    if !has_column(conn, "tag_facets", "applies_to")? {
        conn.execute_batch(V13_FACETS)?;
    }
    Ok(())
}

/// v14：视频兼容代理缓存（指导书 §8.3）。记录按素材 + 变体生成/查询状态，不替换原文件。
/// 状态机：queued|running|ready|failed|canceled。代理失败原因可展示；清理缓存不影响原文件。
const V14: &str = r#"
CREATE TABLE IF NOT EXISTS video_proxies (
  asset_id   INTEGER NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  variant    TEXT    NOT NULL DEFAULT 'h264_mp4',
  status     TEXT    NOT NULL DEFAULT 'queued',
  path       TEXT,
  error      TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (asset_id, variant),
  CHECK(status IN ('queued', 'running', 'ready', 'failed', 'canceled'))
);
CREATE INDEX IF NOT EXISTS idx_video_proxies_asset ON video_proxies(asset_id);
"#;

fn migrate_v14(conn: &Connection) -> AppResult<()> {
    conn.execute_batch(V14)?;
    Ok(())
}

/// v15：AI 连接档案 + 用途绑定（指导书 §6.3/§7.3）。
///  - 创建 ai_connections / ai_usage_bindings；
///  - 迁移旧 settings.app_settings 的每个 profile 到连接表；
///  - 按 kind 映射 deployment（local→local，其他→cloud）；
///  - 按 apiMode 映射 protocol（openai→openai_chat，anthropic→anthropic_messages，缺失→openai_chat + warning）；
///  - API Key 写入系统凭据（keyring），成功后 api_key_ref = connection_id；
///    写入失败则保留旧 JSON 里的明文 key，并返回迁移 warning（不丢 key）；
///  - 旧 active_profile 同时绑定到 super_search 和 tagging，用户可在 UI 分别修改；
///  - 幂等：以 ai_connections 表非空 / user_version 提交为准，重复执行无副作用。
const V15_SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS ai_connections (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  deployment TEXT NOT NULL CHECK (deployment IN ('cloud','local')),
  protocol TEXT NOT NULL CHECK (protocol IN ('openai_chat','anthropic_messages')),
  base_url TEXT NOT NULL,
  model TEXT NOT NULL,
  api_key_ref TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS ai_usage_bindings (
  usage TEXT PRIMARY KEY CHECK (usage IN ('super_search','tagging')),
  connection_id TEXT NOT NULL REFERENCES ai_connections(id),
  updated_at INTEGER NOT NULL
);
"#;

/// §6.4 apiMode → protocol 固定映射（缺失/未知 → openai_chat + warning）。
fn map_protocol(api_mode: &str) -> &'static str {
    match api_mode {
        "anthropic" => "anthropic_messages",
        _ => "openai_chat",
    }
}

fn migrate_v15(conn: &Connection) -> AppResult<()> {
    conn.execute_batch(V15_SCHEMA)?;
    // 幂等：已有连接档案（
    let count: i64 = conn.query_row("SELECT COUNT(*) FROM ai_connections", [], |r| r.get(0))?;
    if count > 0 {
        return Ok(());
    }

    // 读取旧 settings（app_settings），迁入连接表
    let raw: Option<String> = conn
        .query_row("SELECT value FROM settings WHERE key = 'app_settings'", [], |r| r.get(0))
        .ok();
    let Some(raw) = raw else {
        return Ok(());
    };
    let s: serde_json::Value = match serde_json::from_str(&raw) {
        Ok(v) => v,
        Err(e) => {
            tracing::warn!("v15 迁移：settings JSON 解析失败，跳过连接迁移: {e}");
            return Ok(());
        }
    };
    let ai = s.get("ai").cloned().unwrap_or_default();
    let profiles = ai.get("profiles").and_then(|p| p.as_array()).cloned().unwrap_or_default();
    let active_id = ai.get("activeProfile").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let now = chrono::Utc::now().timestamp_millis();

    for p in &profiles {
        let id = p.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
        if id.is_empty() {
            tracing::warn!("v15 迁移：跳过无 id 的 profile");
            continue;
        }
        let name = p.get("name").and_then(|v| v.as_str()).unwrap_or("未命名").to_string();
        let kind = p.get("kind").and_then(|v| v.as_str()).unwrap_or("");
        let deployment = if kind == "local" { "local" } else { "cloud" };
        let api_mode = p.get("apiMode").and_then(|v| v.as_str()).unwrap_or("");
        let protocol = map_protocol(api_mode);
        if api_mode.is_empty() || (api_mode != "openai" && api_mode != "anthropic") {
            tracing::warn!(
                "v15 迁移：profile {name}({id}) 的 apiMode 缺失/未知({api_mode:?})，按 openai_chat 处理"
            );
        }
        let base_url = p.get("baseUrl").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let model = p.get("model").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let api_key = p.get("apiKey").and_then(|v| v.as_str()).unwrap_or("").to_string();

        // API Key → keyring；成功才置 api_key_ref，失败保留旧 JSON（不丢 key + warning）
        let mut api_key_ref: Option<String> = None;
        if !api_key.is_empty() {
            match crate::services::credentials::save_api_key(&id, &api_key) {
                Ok(()) => api_key_ref = Some(id.clone()),
                Err(e) => {
                    tracing::warn!(
                        "v15 迁移：profile {name}({id}) 的 API Key 写入系统凭据失败，保留旧 JSON: {e}"
                    );
                }
            }
        }
        conn.execute(
            "INSERT OR IGNORE INTO ai_connections
               (id, name, deployment, protocol, base_url, model, api_key_ref, enabled, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 1, ?8, ?8)",
            rusqlite::params![id, name, deployment, protocol, base_url, model, api_key_ref, now],
        )?;
    }

    // 旧 active_profile 同时绑定 super_search + tagging（UI 可分别修改）
    if !active_id.is_empty() {
        let exists: i64 = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM ai_connections WHERE id = ?1)",
                [&active_id],
                |r| r.get(0),
            )?;
        if exists != 0 {
            for usage in ["super_search", "tagging"] {
                conn.execute(
                    "INSERT OR IGNORE INTO ai_usage_bindings (usage, connection_id, updated_at)
                     VALUES (?1, ?2, ?3)",
                    rusqlite::params![usage, active_id, now],
                )?;
            }
        }
    }

    // 迁移成功后：原 settings JSON 移除明文 API Key（写备份副本；失败保留旧数据并 warning）
    if let Ok(mut s2) = serde_json::from_str::<serde_json::Value>(&raw) {
        // 备份副本
        let _ = conn.execute(
            "INSERT OR REPLACE INTO settings (key, value) VALUES ('app_settings_backup_v15', ?1)",
            [&raw],
        );
        let profiles = s2
            .get_mut("ai")
            .and_then(|a| a.get_mut("profiles"))
            .and_then(|p| p.as_array_mut());
        if let Some(profiles) = profiles {
            let mut all_migrated = true;
            for p in profiles.iter_mut() {
                let has_key = p.get("apiKey").and_then(|v| v.as_str()).map(|k| !k.is_empty()).unwrap_or(false);
                if has_key {
                    let id = p.get("id").and_then(|v| v.as_str()).unwrap_or("");
                    // 只有该连接成功写入凭据才清除明文；否则保留（不丢 key）
                    let cleared: bool = conn
                        .query_row(
                            "SELECT EXISTS(SELECT 1 FROM ai_connections WHERE id = ?1 AND api_key_ref = ?1)",
                            [&id],
                            |r| r.get(0),
                        )
                        .unwrap_or(false);
                    if cleared {
                        if let Some(obj) = p.as_object_mut() {
                            obj.insert("apiKey".into(), serde_json::Value::String(String::new()));
                        }
                    } else {
                        all_migrated = false;
                    }
                }
            }
            if all_migrated {
                if let Ok(cleaned) = serde_json::to_string(&s2) {
                    let _ = conn.execute(
                        "UPDATE settings SET value = ?1 WHERE key = 'app_settings'",
                        [&cleaned],
                    );
                }
            } else {
                tracing::warn!("v15 迁移：部分 profile 未成功写入凭据，settings JSON 保留明细（备份见 app_settings_backup_v15）");
            }
        }
    }
    Ok(())
}

/// FB2-08（§14.8）V16：颜色从 AI 分面改为算法主色属性。
///
///  - `assets` 加 6 列（palette_json / palette_version / palette_scanned_at / dominant_hue|sat|lum）+ 3 索引；
///  - color 分面停用：`tag_facets.status = 'inactive'`、`ai_facet_configs` 里 color 的 `enabledForAi = false`、
///    `visibleInWorkbench = false`（存量 color 标签保留可搜索，只是不再由 AI 生成、工作台默认收起）。
///  - 幂等：add_column_if_missing + IF NOT EXISTS + UPDATE 无条件（重复执行无副作用）。
const V16_COLUMNS: &[(&str, &str)] = &[
    ("palette_json", "TEXT"),
    ("palette_version", "INTEGER"),
    ("palette_scanned_at", "INTEGER"),
    ("dominant_hue", "INTEGER"),
    ("dominant_sat", "INTEGER"),
    ("dominant_lum", "INTEGER"),
];

const V16_INDEXES: &str = r#"
CREATE INDEX IF NOT EXISTS idx_assets_dominant_hue ON assets(dominant_hue);
CREATE INDEX IF NOT EXISTS idx_assets_dominant_sat ON assets(dominant_sat);
CREATE INDEX IF NOT EXISTS idx_assets_dominant_lum ON assets(dominant_lum);
"#;

/// V16 迁移：加色板列 + 索引 + color 分面停用（AI 侧摘除，见 §14.3）。
fn migrate_v16(conn: &Connection) -> AppResult<()> {
    // 1. 只增列模式（沿用 V12）
    for (col, ty) in V16_COLUMNS {
        add_column_if_missing(conn, "assets", col, ty)?;
    }
    conn.execute_batch(V16_INDEXES)?;

    let now = chrono::Utc::now().timestamp_millis();

    // 2. color 分面停用：`deprecated` 语义已收敛到 `inactive`（V13 统一），此处用 inactive。
    conn.execute(
        "UPDATE tag_facets SET status = 'inactive', updated_at = ?1 WHERE key = 'color'",
        rusqlite::params![now],
    )?;

    // 2b. §14.3：`style` 分面 hint 追加「不包含颜色描述」，作为删除 cross-facet 规则后的消歧补偿（数据里改，不硬编码）。
    conn.execute(
        "UPDATE tag_facets SET hint = hint || '。风格描述不包含颜色（颜色由算法主色呈现）', updated_at = ?1 WHERE key = 'style' AND instr(hint, '不包含颜色') = 0",
        rusqlite::params![now],
    )?;

    // 3. ai_facet_configs（settings JSON，camelCase）：color 的 enabledForAi=false + visibleInWorkbench=false。
    if let Ok(raw) = conn.query_row(
        "SELECT value FROM settings WHERE key = 'app_settings'",
        [],
        |r| r.get::<_, Option<String>>(0),
    ) {
        if let Some(raw) = raw {
            if let Ok(mut v) = serde_json::from_str::<serde_json::Value>(&raw) {
                let changed = {
                    let arr = v
                        .get_mut("aiFacetConfigs")
                        .and_then(|c| c.as_array_mut());
                    let mut changed = false;
                    if let Some(arr) = arr {
                        for cfg in arr.iter_mut() {
                            if cfg.get("facetKey").and_then(|k| k.as_str()) == Some("color") {
                                if let Some(o) = cfg.as_object_mut() {
                                    o.insert("enabledForAi".into(), serde_json::Value::Bool(false));
                                    o.insert("visibleInWorkbench".into(), serde_json::Value::Bool(false));
                                }
                                changed = true;
                            }
                        }
                    }
                    changed
                };
                if changed {
                    if let Ok(s) = serde_json::to_string(&v) {
                        let _ = conn.execute(
                            "UPDATE settings SET value = ?1 WHERE key = 'app_settings'",
                            [&s],
                        );
                    }
                }
            }
        }
    }
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
    if version < 12 {
        // V12：媒体元数据结构化字段（只增列，不扫描/回填视频）
        migrate_v12(conn)?;
        conn.pragma_update(None, "user_version", 12)?;
    }
    if version < 13 {
        // V13：标签分面生命周期字段（applies_to + 状态放宽）
        migrate_v13(conn)?;
        conn.pragma_update(None, "user_version", 13)?;
    }
    if version < 14 {
        // V14：视频兼容代理缓存表（queued|running|ready|failed|canceled）
        migrate_v14(conn)?;
        conn.pragma_update(None, "user_version", 14)?;
    }
    if version < 15 {
        // V15：AI 连接档案 + 用途绑定（keyring 凭据迁移；§6.3/§7.3）
        migrate_v15(conn)?;
        conn.pragma_update(None, "user_version", 15)?;
    }
    if version < 16 {
        // FB2-08（§14.8）：颜色改为算法主色属性 + color 分面停用（AI 侧摘除）
        migrate_v16(conn)?;
        conn.pragma_update(None, "user_version", 16)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mem() -> rusqlite::Connection {
        let c = rusqlite::Connection::open_in_memory().unwrap();
        c.pragma_update(None, "journal_mode", "WAL").unwrap();
        c
    }

    /// 生成一份「已到 v14」的旧库 fixture：直接建必要表 + settings JSON + user_version=14。
    /// 凭据后端：不强制 mock（避免与 credentials 测试竞态全局 builder）——
    /// 迁移行为按「keyring 可用/不可用」两种情形分别断言（下同）。
    fn legacy_v14_fixture() -> rusqlite::Connection {
        let c = mem();
        // 只需 settings 表 + 旧 app_settings JSON；迁移只依赖这两者
        c.execute_batch(
            "CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
             CREATE TABLE ai_connections (
               id TEXT PRIMARY KEY, name TEXT NOT NULL,
               deployment TEXT NOT NULL CHECK (deployment IN ('cloud','local')),
               protocol TEXT NOT NULL CHECK (protocol IN ('openai_chat','anthropic_messages')),
               base_url TEXT NOT NULL, model TEXT NOT NULL,
               api_key_ref TEXT, enabled INTEGER NOT NULL DEFAULT 1,
               created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
             CREATE TABLE ai_usage_bindings (
               usage TEXT PRIMARY KEY CHECK (usage IN ('super_search','tagging')),
               connection_id TEXT NOT NULL REFERENCES ai_connections(id),
               updated_at INTEGER NOT NULL);",
        )
        .unwrap();
        c.pragma_update(None, "user_version", 14).unwrap();
        c
    }

    /// v15 迁移：每个 profile 迁入连接表、apiMode→protocol 映射正确、active 绑定两用途。
    /// keyring 行为分两种合法结果并分别断言：
    ///  - 可用：api_key_ref 有值，旧 JSON 明文被清除，备份副本保留；
    ///  - 不可用：api_key_ref 空，旧 JSON 明文保留（不丢 key）。
    #[test]
    fn v15_migrates_old_profiles_into_connections_and_preserves_keys() {
        let c = legacy_v14_fixture();
        let old_json = r#"{
          "ai": {
            "profiles": [
              {"id":"p1","name":"通义","apiMode":"openai","kind":"cloud","baseUrl":"https://a/v1","apiKey":"sk-a","model":"qwen-max"},
              {"id":"p2","name":"本地Ollama","apiMode":"openai","kind":"local","baseUrl":"http://localhost:11434/v1","apiKey":"","model":"llama3.2-vision"},
              {"id":"p3","name":"Claude","apiMode":"anthropic","kind":"cloud","baseUrl":"https://api.anthropic.com","apiKey":"sk-b","model":"claude-3"}
            ],
            "activeProfile": "p1"
          }
        }"#;
        c.execute("INSERT INTO settings (key, value) VALUES ('app_settings', ?1)", [old_json]).unwrap();

        migrate_v15(&c).unwrap();

        // p1: cloud + openai→openai_chat
        let (deploy, proto) = c
            .query_row("SELECT deployment, protocol FROM ai_connections WHERE id='p1'", [], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
            })
            .unwrap();
        assert_eq!(deploy, "cloud");
        assert_eq!(proto, "openai_chat");
        // p2: local
        let deploy2: String = c
            .query_row("SELECT deployment FROM ai_connections WHERE id='p2'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(deploy2, "local");
        // p3: anthropic→anthropic_messages
        let proto3: String = c
            .query_row("SELECT protocol FROM ai_connections WHERE id='p3'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(proto3, "anthropic_messages");

        // active profile 绑定两个用途（与 keyring 可用性无关）
        let usages: Vec<String> = c
            .prepare("SELECT usage FROM ai_usage_bindings ORDER BY usage")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .map(|r| r.unwrap())
            .collect();
        assert_eq!(usages, vec!["super_search", "tagging"]);
        let count: i64 = c.query_row("SELECT COUNT(*) FROM ai_connections", [], |r| r.get(0)).unwrap();
        assert_eq!(count, 3);

        // 分情形断言密钥迁移结果（二选一，均合法）
        let ref1: Option<String> = c
            .query_row("SELECT api_key_ref FROM ai_connections WHERE id='p1'", [], |r| r.get(0))
            .unwrap();
        let kept: String = c
            .query_row("SELECT value FROM settings WHERE key='app_settings'", [], |r| r.get(0))
            .unwrap();
        let backup: Option<String> = c
            .query_row("SELECT value FROM settings WHERE key='app_settings_backup_v15'", [], |r| r.get(0))
            .ok();
        if ref1.is_some() {
            // keyring 可用：明文清除 + 备份副本保留
            assert!(!kept.contains("sk-a"), "迁移成功后 settings JSON 不得再含明文 API Key");
            assert!(!kept.contains("sk-b"));
            assert!(backup.is_some() && backup.unwrap().contains("sk-a"), "备份副本应保留原始明文");
        } else {
            // keyring 不可用：旧明文保留（不丢 key），迁移仍完成
            assert!(kept.contains("sk-a"), "keyring 写失败时旧明文 key 必须保留");
            assert!(kept.contains("sk-b"));
        }
    }

    /// 幂等：重复执行无副作用（连接表非空即跳过）。
    #[test]
    fn v15_is_idempotent() {
        let c = legacy_v14_fixture();
        let old_json = r#"{"ai":{"profiles":[{"id":"p1","name":"A","apiMode":"openai","kind":"cloud","baseUrl":"u","model":"m"}],"activeProfile":"p1"}}"#;
        c.execute("INSERT INTO settings (key, value) VALUES ('app_settings', ?1)", [old_json]).unwrap();
        migrate_v15(&c).unwrap();
        migrate_v15(&c).unwrap();
        let count: i64 = c.query_row("SELECT COUNT(*) FROM ai_connections", [], |r| r.get(0)).unwrap();
        assert_eq!(count, 1, "重复执行不得重复插入连接");
    }

    /// 空 settings（无 app_settings 行）不报错。
    #[test]
    fn v15_no_settings_is_noop() {
        let c = legacy_v14_fixture();
        migrate_v15(&c).unwrap();
        let count: i64 = c.query_row("SELECT COUNT(*) FROM ai_connections", [], |r| r.get(0)).unwrap();
        assert_eq!(count, 0);
    }

    /// 迁移后 foreign_key_check 无错误（表结构约束合法）。
    #[test]
    fn v15_passes_foreign_key_check() {
        let c = legacy_v14_fixture();
        let old_json = r#"{"ai":{"profiles":[{"id":"p1","name":"A","apiMode":"openai","kind":"cloud","baseUrl":"u","model":"m"}],"activeProfile":"p1"}}"#;
        c.execute("INSERT INTO settings (key, value) VALUES ('app_settings', ?1)", [old_json]).unwrap();
        migrate_v15(&c).unwrap();
        let mut stmt = c.prepare("PRAGMA foreign_key_check").unwrap();
        let rows = stmt.query_map([], |r| r.get::<_, String>(0)).unwrap();
        assert_eq!(rows.count(), 0, "foreign_key_check 应无错误");
    }
}
