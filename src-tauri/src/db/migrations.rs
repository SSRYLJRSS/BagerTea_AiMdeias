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
            conn.execute(
                &format!("ALTER TABLE assets ADD COLUMN {col} {ty}"),
                [],
            )?;
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
    Ok(())
}
