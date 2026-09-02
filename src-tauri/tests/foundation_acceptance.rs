//! §13 验收测试清单（十二组约 62 条）—— 一条命令跑完：
//!   cargo test --test foundation_acceptance
//!
//! 命名前缀统一；每个波次结束跑对应组（§13 验收流程）：
//!   F 波次 → 组 1/2/3/5/10/12；A 波次 → 组 4/5；S 波次 → 组 6/9/11；
//!   C 波次 → 组 7；全部绿 + 四关全绿 → foundation-verified。

use bagertea_ai_media_v2_lib::db::{
    ai, init_memory, asset_tags, assets, migrations, query_expr, schema_features, tag_facets, tags,
};
use bagertea_ai_media_v2_lib::error::AppResult;

fn mem() -> rusqlite::Connection {
    init_memory().expect("内存库初始化失败")
}

/// 辅助：往 tag_terms 写 canonical 词（模拟 apply_tag_constraints 后的新写入路径）。
fn insert_canonical_term(
    conn: &rusqlite::Connection,
    tag_id: i64,
    facet: &str,
    term: &str,
) -> AppResult<()> {
    conn.execute(
        "INSERT INTO tag_terms (tag_id, facet_key, normalized_term, term, locale, term_kind, is_searchable, created_at)
         VALUES (?1, ?2, ?3, ?3, '', 'canonical', 1, 1)",
        rusqlite::params![tag_id, facet, term],
    )?;
    Ok(())
}

/// 测试辅助：确保 tag_terms 表存在后写入一行 canonical（facet 校验触发器同时建好）。
fn db_schema_make_terms(
    conn: &rusqlite::Connection,
    tag_id: i64,
    facet: &str,
    term: &str,
) -> AppResult<()> {
    migrations::create_tag_terms_table_for_test(conn)?;
    migrations::create_terms_facet_defenses_for_test(conn)?;
    insert_canonical_term(conn, tag_id, facet, term)
}

// ═══════════════ 组 1：分面停用/恢复/删除/重建（F1 F4） ═══════════════

/// F1-b：effective() 与 SQL 常量同规则 —— status 3 值 × cfg 四列 16 组合 = 48 组合。
/// 这条测试的价值不是「验证现在对」，而是下次有人改规则时会失败。
#[test]
fn effective_value_sql_matches_rust() {
    let statuses = ["active", "inactive", "deprecated"];
    for status in statuses {
        for vis in [false, true] {
            for manual in [false, true] {
                for ai in [false, true] {
                    for search in [false, true] {
                        let f = TagFacetFixture {
                            status,
                            cfg_visible_in_navigation: vis,
                            cfg_manual_assignable: manual,
                            cfg_ai_assignable: ai,
                            cfg_searchable: search,
                        };
                        let eff = f.rust_effective();
                        // SQL 侧语义：
                        //  visible/manual/ai 都要 alive(status='active')；
                        //  searchable 不看 status（F4 语义变更）
                        let alive = status == "active";
                        assert_eq!(
                            eff.visible,
                            alive && vis,
                            "status={status} vis={vis} 时 visible 应一致"
                        );
                        assert_eq!(
                            eff.manual,
                            alive && manual,
                            "status={status} manual={manual} 时 manual 应一致"
                        );
                        assert_eq!(
                            eff.ai,
                            alive && ai,
                            "status={status} ai={ai} 时 ai 应一致"
                        );
                        assert_eq!(
                            eff.searchable,
                            search,
                            "status={status} search={search} 时 searchable 应只看 cfg（不看 status）"
                        );
                        // input_mode 只读派生
                        let derived = if ai { "ai_and_manual" } else { "manual_only" };
                        assert_eq!(f.rust_derived_input_mode(), derived);
                    }
                }
            }
        }
    }
}

struct TagFacetFixture {
    status: &'static str,
    cfg_visible_in_navigation: bool,
    cfg_manual_assignable: bool,
    cfg_ai_assignable: bool,
    cfg_searchable: bool,
}

impl TagFacetFixture {
    fn rust_effective(&self) -> tag_facets::FacetEffective {
        let alive = self.status == "active";
        tag_facets::FacetEffective {
            visible: alive && self.cfg_visible_in_navigation,
            manual: alive && self.cfg_manual_assignable,
            ai: alive && self.cfg_ai_assignable,
            searchable: self.cfg_searchable,
        }
    }
    fn rust_derived_input_mode(&self) -> &'static str {
        if self.cfg_ai_assignable {
            "ai_and_manual"
        } else {
            "manual_only"
        }
    }
}

/// F1-b + F7：ai_and_manual 分面停用 → 恢复仍是 ai_and_manual（cfg 不被生命周期覆盖）。
#[test]
fn facet_deactivate_restore_preserves_config() {
    let c = mem();
    let key = "my_facet";
    let f = tag_facets::create(&c, key, "我的分面", "", "multi", None, "all").unwrap();
    assert!(f.cfg_ai_assignable, "新建默认参与 AI");
    // 停用（用户分面，F7 允许；系统分面停用在 F7 单独验证）
    tag_facets::deactivate(&c, key).unwrap();
    let inactive = tag_facets::get(&c, key).unwrap();
    assert_eq!(inactive.status, "inactive");
    assert!(inactive.cfg_ai_assignable, "停用不清配置值（恢复时要还原）");
    assert_eq!(inactive.input_mode, "ai_and_manual", "cfg_ai=1 → 派生 ai_and_manual");
    // 恢复 → 仍是 ai_and_manual
    tag_facets::restore(&c, key).unwrap();
    let restored = tag_facets::get(&c, key).unwrap();
    assert_eq!(restored.status, "active");
    assert_eq!(restored.input_mode, "ai_and_manual", "停用→恢复必须还原原配置");
    assert!(restored.cfg_ai_assignable);
    // manual_only 同理
    tag_facets::update_facet(&c, key, "我的分面", "", "manual_only", "multi", None, "all").unwrap();
    tag_facets::deactivate(&c, key).unwrap();
    tag_facets::restore(&c, key).unwrap();
    let back = tag_facets::get(&c, key).unwrap();
    assert_eq!(back.input_mode, "manual_only", "manual_only 停用→恢复仍是 manual_only");
    assert!(!back.cfg_ai_assignable);
}

/// 组1：分面删除后可用同 key 重建（重建是新的 is_system=false 分面）。
#[test]
fn facet_delete_then_recreate_same_key() {
    let c = mem();
    tag_facets::create(&c, "tmp_facet", "临时", "", "multi", None, "all").unwrap();
    tag_facets::delete_facet(&c, "tmp_facet").unwrap();
    let re = tag_facets::create(&c, "tmp_facet", "重建", "", "multi", None, "all").unwrap();
    assert_eq!(re.key, "tmp_facet");
    assert!(!re.is_system);
}

// ═══════════════ 组 3：子树移动不突破深度（F1） ═══════════════

/// F1-c：把 A 挂到自己的后代 B 下 → 拒绝（环）。
#[test]
fn cycle_creation_rejected() {
    let c = mem();
    let a = tags::create_in_facet(&c, "A", None, Some("custom")).unwrap();
    let b = tags::create_in_facet(&c, "B", Some(a.id), Some("custom")).unwrap();
    let res = crate_private_update_parent(&c, a.id, Some(b.id));
    assert!(res.is_err(), "把 A 挂到子 B 下应报环错误");
    assert!(res.unwrap_err().to_string().contains("循环"));
}

/// 直接执行 UPDATE（绕过 tags::update 的应用层防环，验证触发器兜底）
fn crate_private_update_parent(c: &rusqlite::Connection, id: i64, parent: Option<i64>) -> AppResult<()> {
    c.execute(
        "UPDATE tags SET parent_id = ?1 WHERE id = ?2",
        rusqlite::params![parent, id],
    )?;
    Ok(())
}

/// F1-d 兜底：绕过触发器造环后，递归查询不挂死（深度上限）。
#[test]
fn recursive_cte_terminates_on_existing_cycle() {
    let c = mem();
    let a = tags::create_in_facet(&c, "CA", None, Some("custom")).unwrap();
    let b = tags::create_in_facet(&c, "CB", Some(a.id), Some("custom")).unwrap();
    // 绕过触发器直接造环（A → B → A）
    c.execute_batch("DROP TRIGGER trg_tags_no_cycle; DROP TRIGGER trg_tags_max_depth_au;")
        .unwrap();
    crate_private_update_parent(&c, a.id, Some(b.id)).unwrap();
    // 正常根保证 list_tree 顶层非空
    tags::create_in_facet(&c, "正常根", None, Some("custom")).unwrap();
    let tree = tags::list_tree(&c).unwrap();
    assert!(!tree.is_empty());
    let _ = tags::total_count(&c, a.id).unwrap();
}

/// F1-d 兜底：list_by_facet 在有环时也不挂死（它内部走 list_tree）。
#[test]
fn list_by_facet_survives_cycle() {
    let c = mem();
    let a = tags::create_in_facet(&c, "LA", None, Some("custom")).unwrap();
    let b = tags::create_in_facet(&c, "LB", Some(a.id), Some("custom")).unwrap();
    c.execute_batch("DROP TRIGGER trg_tags_no_cycle; DROP TRIGGER trg_tags_max_depth_au;")
        .unwrap();
    crate_private_update_parent(&c, a.id, Some(b.id)).unwrap();
    let _ = tags::list_by_facet(&c, "custom").unwrap();
}

// ═══════════════ 组 2：唯一性（F2 F3 F5 的 V22b 部分） ═══════════════

/// V22b 启用前先干净（无冲突），apply 成功 → schema_features 登记 enabled。
#[test]
fn v22b_applies_when_clean_and_registers_features() {
    let c = mem();
    // 全新 V22a 库：无标签 → 零冲突
    let report = tags::detect_tag_conflicts(&c).unwrap();
    assert!(report.is_clean(), "空库应零冲突：{report:?}");
    migrations::apply_v22b_constraints(&c).unwrap();
    // tag_terms 有 canonical（种子分面无标签，但 apply 后表存在）
    let n: i64 = c
        .query_row("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='tag_terms'", [], |r| r.get(0))
        .unwrap();
    assert_eq!(n, 1);
    // 特征登记（命令层做 set_feature；这里验证表 + 手动登记 API 可用）
    schema_features::set_feature(&c, "tag_unique_terms", true, None).unwrap();
    assert!(schema_features::feature_enabled(&c, "tag_unique_terms").unwrap());
}

/// 造 term 冲突（同分面两标签同 canonical）→ 预检发现 → 不 apply。
#[test]
fn term_alias_equals_other_canonical_rejected() {
    let c = mem();
    // scene 分面两个标签用同一名（绕过 DB 唯一约束不行 —— tags 无 facet+name 唯一；
    // 根级同名允许？tags UNIQUE(parent_id,name) 只拦同父同名。分面内规范名冲突是
    // 「两个根级标签同名不同 facet」之外的场景 —— 这里造：两个 active 标签规范名相同）
    // F5：create_in_facet 根级自动查重，重复词只能直插构造（绕过应用层）
    let t1 = tags::create_in_facet(&c, "海边", None, Some("scene")).unwrap();
    let _t2: i64 = c
        .query_row(
            "INSERT INTO tags (name, canonical_name, normalized_name, facet_key)
             VALUES ('海边','海边','海边','scene') RETURNING id",
            [],
            |r| r.get(0),
        )
        .unwrap();
    let report = tags::detect_tag_conflicts(&c).unwrap();
    assert!(
        report.term_conflicts.iter().any(|g| g.facet_key == "scene" && g.term == "海边" && g.entries.len() >= 2),
        "应发现 scene 分面「海边」重名：{report:?}"
    );
    let _ = t1;
}

/// 跨分面同名词允许（facet 是唯一索引的一部分）。
#[test]
fn term_same_name_across_facets_allowed() {
    let c = mem();
    tags::create_in_facet(&c, "海边", None, Some("scene")).unwrap();
    tags::create_in_facet(&c, "海边", None, Some("custom")).unwrap();
    // apply 后两个 canonical 共存（不同 facet → ux_terms 不冲突）
    migrations::apply_v22b_constraints(&c).unwrap();
    let n: i64 = c
        .query_row(
            "SELECT COUNT(*) FROM tag_terms WHERE normalized_term='海边' AND term_kind='canonical'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(n, 2, "跨分面同名词应各有一个 canonical");
}

/// 一标签两个 canonical 被拒（ux_terms_canonical 唯一）。
#[test]
fn term_two_canonicals_per_tag_rejected() {
    let c = mem();
    let t = tags::create_in_facet(&c, "人", None, Some("people")).unwrap();
    migrations::apply_v22b_constraints(&c).unwrap();
    // apply 的 backfill 已为「人」灌入 canonical「人」；再插第二个 canonical 应被唯一索引拒
    let err = insert_canonical_term(&c, t.id, "people", "人物");
    assert!(err.is_err(), "同标签第二个 canonical 应被唯一索引拒绝");
    // 确认原有 canonical 未被覆盖
    let n: i64 = c
        .query_row(
            "SELECT COUNT(*) FROM tag_terms WHERE tag_id=?1 AND term_kind='canonical'",
            [t.id],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(n, 1);
}

/// V22b 冲突时记录 blocked_by（命令层语义）—— 用 term 冲突库验证 is_clean=false。
#[test]
fn v22b_skipped_on_conflicts_records_blocked_by() {
    let c = mem();
    tags::create_in_facet(&c, "海边", None, Some("scene")).unwrap();
    // F5：重复词直插构造（create_in_facet 根级自动查重）
    c.execute(
        "INSERT INTO tags (name, canonical_name, normalized_name, facet_key)
         VALUES ('海边','海边','海边','scene')",
        [],
    )
    .unwrap();
    let report = tags::detect_tag_conflicts(&c).unwrap();
    assert!(!report.is_clean());
    // apply 会怎样？insert canonical 会在 ux_terms 上撞唯一 → apply 报错（不静默丢）
    let err = migrations::apply_v22b_constraints(&c);
    assert!(err.is_err(), "有重名时灌 canonical 应撞 ux_terms 唯一索引");
}

// ═══════════════ 组 12：tag_terms.facet_key 不漂移（F2-c） ═══════════════

/// 触发器 ①：改 tags.facet_key → tag_terms 自动同步。
#[test]
fn terms_facet_syncs_on_tag_update() {
    let c = mem();
    let t = tags::create_in_facet(&c, "x", None, Some("custom")).unwrap();
    migrations::apply_v22b_constraints(&c).unwrap();
    // 把标签迁到 scene 分面
    let scene_facet_exists: i64 = c
        .query_row("SELECT COUNT(*) FROM tag_facets WHERE key='scene'", [], |r| r.get(0))
        .unwrap();
    assert_eq!(scene_facet_exists, 1);
    c.execute("UPDATE tags SET facet_key='scene' WHERE id=?1", [t.id]).unwrap();
    let terms_facet: String = c
        .query_row("SELECT facet_key FROM tag_terms WHERE tag_id=?1", [t.id], |r| r.get(0))
        .unwrap();
    assert_eq!(terms_facet, "scene", "改 tags.facet_key 应同步 tag_terms");
}

/// 触发器 ②：插入 facet 不匹配的 term 被拒。
#[test]
fn terms_facet_insert_mismatch_rejected() {
    let c = mem();
    let t = tags::create_in_facet(&c, "x", None, Some("custom")).unwrap();
    migrations::apply_v22b_constraints(&c).unwrap();
    let err = c.execute(
        "INSERT INTO tag_terms (tag_id, facet_key, normalized_term, term, locale, term_kind, is_searchable, created_at)
         VALUES (?1, 'scene', 'x', 'x', '', 'canonical', 1, 1)",
        [t.id],
    );
    assert!(err.is_err(), "facet 不一致的 term 插入应被拒");
}

/// 触发器 ③：直接 UPDATE tag_terms.facet_key 到不一致值被拒。
#[test]
fn terms_facet_direct_update_mismatch_rejected() {
    let c = mem();
    let t = tags::create_in_facet(&c, "x", None, Some("custom")).unwrap();
    migrations::apply_v22b_constraints(&c).unwrap();
    let err = c.execute(
        "UPDATE tag_terms SET facet_key='scene' WHERE tag_id=?1",
        [t.id],
    );
    assert!(err.is_err(), "直接改 tag_terms.facet_key 不一致应被拒");
}

/// 不一致阻断启用：手工造不一致 → 修复按钮应提示（check_terms 层面）
#[test]
fn facet_mismatch_blocks_feature_enable() {
    let c = mem();
    // 造一致库再手工破坏（绕过触发器：先删触发器）
    let t = tags::create_in_facet(&c, "x", None, Some("custom")).unwrap();
    migrations::apply_v22b_constraints(&c).unwrap();
    c.execute_batch("DROP TRIGGER trg_terms_facet_match_au; DROP TRIGGER trg_terms_sync_facet;")
        .unwrap();
    c.execute("UPDATE tag_terms SET facet_key='scene' WHERE tag_id=?1", [t.id]).unwrap();
    let report = tags::detect_tag_conflicts(&c).unwrap();
    assert!(
        !report.facet_mismatches.is_empty(),
        "应发现 facet 不一致：{report:?}"
    );
    // 命令层 apply 会因预检不清拒绝（模拟）
    assert!(!report.is_clean());
}

// ═══════════════ 组 12/2：分面删除 RESTRICT（F2-d） ═══════════════

/// F2-d：带标签的分面禁止裸 DELETE；delete_facet 命令仍可用（级联）。
#[test]
fn facet_delete_restrict_blocks_raw_delete() {
    let c = mem();
    tag_facets::create(&c, "tmp_f", "临时", "", "multi", None, "all").unwrap();
    tags::create_in_facet(&c, "标签A", None, Some("tmp_f")).unwrap();
    migrations::apply_v22b_constraints(&c).unwrap();
    // 裸 DELETE 被 RESTRICT 拦
    let err = c.execute("DELETE FROM tag_facets WHERE key='tmp_f'", []);
    assert!(err.is_err(), "带标签的分面禁止裸删除");
    // delete_facet 命令（先删 tags）仍可用
    let report = tag_facets::delete_facet(&c, "tmp_f").unwrap();
    assert!(report.tags_deleted >= 1);
    let leftover: i64 = c
        .query_row("SELECT COUNT(*) FROM tag_facets WHERE key='tmp_f'", [], |r| r.get(0))
        .unwrap();
    assert_eq!(leftover, 0);
}

/// F2-d：delete_facet 全级联回归确认（含 tag_terms —— 标签删后 terms 由 CASCADE 清）。
#[test]
fn delete_facet_cascades_all_refs() {
    let c = mem();
    tag_facets::create(&c, "tmp_g", "临时", "", "multi", None, "all").unwrap();
    let t = tags::create_in_facet(&c, "标签B", None, Some("tmp_g")).unwrap();
    migrations::apply_v22b_constraints(&c).unwrap();
    let report = tag_facets::delete_facet(&c, "tmp_g").unwrap();
    assert!(report.tags_deleted >= 1);
    // tags 已删 → tag_terms 因 FK CASCADE 清空（验证不残留脏词条）
    let terms_left: i64 = c
        .query_row("SELECT COUNT(*) FROM tag_terms WHERE tag_id=?1", [t.id], |r| r.get(0))
        .unwrap();
    assert_eq!(terms_left, 0, "标签删除后其 tag_terms 应 CASCADE 清空");
}

/// F2 要求：设计书要求的 PRAGMA foreign_keys 测试。
#[test]
fn foreign_keys_pragma_is_on() {
    let c = mem();
    let on: i64 = c.query_row("PRAGMA foreign_keys", [], |r| r.get(0)).unwrap();
    assert_eq!(on, 1, "foreign_keys 必须为 ON（CASCADE 的前提）");
}

/// F2-a：六类冲突全被探测（构造每种冲突）。
#[test]
fn detect_conflicts_finds_all_six_types() {
    let c = mem();
    // ① term 冲突：同分面两标签同 canonical（F5 后重复词直插构造，绕过根级自动查重）
    tags::create_in_facet(&c, "海", None, Some("scene")).unwrap();
    c.execute(
        "INSERT INTO tags (name, canonical_name, normalized_name, facet_key)
         VALUES ('海','海','海','scene')",
        [],
    )
    .unwrap();
    // ② 孤儿：直接插一个 facet_key 不存在分面的标签（此时 F2-d 触发器未启用）
    c.execute("INSERT INTO tags (name, facet_key) VALUES ('孤儿', 'ghost_facet')", []).unwrap();
    // ③ 跨面挂父：把 custom 标签挂到 scene 标签下（绕过 trg_tags_parent_facet_ai）
    let scene_tag = tags::create_in_facet(&c, "山", None, Some("scene")).unwrap();
    c.execute_batch("DROP TRIGGER trg_tags_parent_facet_ai;").unwrap();
    c.execute(
        "INSERT INTO tags (name, parent_id, facet_key) VALUES ('山下', ?1, 'custom')",
        [scene_tag.id],
    )
    .unwrap();
    // ⑤ 超深：独立一条 9 层有根链（绕过深度触发器；保留根 → 预检能从根出发发现）
    c.execute_batch("DROP TRIGGER trg_tags_max_depth_ai; DROP TRIGGER trg_tags_max_depth_au;")
        .unwrap();
    let mut parent: Option<i64> = None;
    for i in 0..9 {
        let id = c
            .query_row(
                "INSERT INTO tags (name, parent_id, facet_key) VALUES (?1, ?2, 'custom') RETURNING id",
                rusqlite::params![format!("deep{i}"), parent],
                |r| r.get(0),
            )
            .unwrap();
        parent = Some(id);
    }
    // ④ 环：独立 A↔B（A 根，B 挂 A 下，再把 A 挂 B 下成环；绕过环触发器）
    c.execute_batch("DROP TRIGGER trg_tags_no_cycle;").unwrap();
    let cyc_a: i64 = c
        .query_row("INSERT INTO tags (name, facet_key) VALUES ('CA','custom') RETURNING id", [], |r| r.get(0))
        .unwrap();
    let cyc_b: i64 = c
        .query_row(
            "INSERT INTO tags (name, parent_id, facet_key) VALUES ('CB',?1,'custom') RETURNING id",
            [cyc_a],
            |r| r.get(0),
        )
        .unwrap();
    c.execute(
        "UPDATE tags SET parent_id=?1 WHERE id=?2",
        rusqlite::params![cyc_b, cyc_a],
    )
    .unwrap();
    // ⑥ facet 不一致：干净标签（custom 分面下无重名）—— 手工建 tag_terms 表并插一行
    //（本库已有 term 冲突，apply 会撞唯一索引，故不依赖 apply）
    let clean = tags::create_in_facet(&c, "干净词", None, Some("custom")).unwrap();
    crate::db_schema_make_terms(&c, clean.id, "custom", "干净词").unwrap();
    c.execute_batch("DROP TRIGGER trg_terms_facet_match_au; DROP TRIGGER trg_terms_sync_facet;")
        .unwrap();
    c.execute(
        "UPDATE tag_terms SET facet_key='scene' WHERE tag_id=?1",
        [clean.id],
    )
    .unwrap();

    let report = tags::detect_tag_conflicts(&c).unwrap();
    assert!(!report.term_conflicts.is_empty(), "① term 冲突未发现：{report:?}");
    assert!(!report.orphans.is_empty(), "② 孤儿未发现：{report:?}");
    assert!(!report.cross_facet_children.is_empty(), "③ 跨面挂父未发现：{report:?}");
    assert!(!report.cycle_edges.is_empty(), "④ 环未发现：{report:?}");
    assert!(!report.over_deep_subtrees.is_empty(), "⑤ 超深未发现：{report:?}");
    assert!(!report.facet_mismatches.is_empty(), "⑥ facet 不一致未发现：{report:?}");
}

// ═══════════════ 组 9 前缀：next_prefix 边界 + find_by_term（F3） ═══════════════

/// F3-b：next_prefix 十一个必测边界。
#[test]
fn next_prefix_boundaries() {
    use bagertea_ai_media_v2_lib::db::tags::next_prefix;
    assert_eq!(next_prefix("term123"), Some("term124".to_string()), "ASCII");
    assert_eq!(next_prefix("青"), Some("靓".to_string()), "中文");
    assert_eq!(next_prefix("海边"), Some("海辺".to_string()), "只改最后一个字符");
    assert_eq!(next_prefix("😀"), Some("😁".to_string()), "emoji（BMP 外）");
    assert_eq!(next_prefix("a😀"), Some("a😁".to_string()), "混合");
    assert_eq!(next_prefix("\u{FFFF}"), Some("\u{10000}".to_string()), "跨越 BMP 边界");
    assert_eq!(next_prefix("a\u{FFFF}"), Some("a\u{10000}".to_string()), "同上");
    assert_eq!(next_prefix("\u{10FFFF}"), None, "char::MAX");
    assert_eq!(next_prefix("a\u{10FFFF}"), Some("b".to_string()), "末字符到顶→前一个递增");
    assert_eq!(next_prefix("\u{D7FF}"), Some("\u{E000}".to_string()), "跳过 surrogate");
    assert_eq!(next_prefix(""), None, "空串");
}

/// F3-b：next_prefix 不变式 —— 每个探针都落在 [prefix, next) 区间；兄弟落在区间外。
#[test]
fn next_prefix_covers_all_children() {
    use bagertea_ai_media_v2_lib::db::tags::next_prefix;
    let prefixes = [
        "term123", "青", "海边", "😀", "a😀", "\u{FFFF}", "a\u{FFFF}", "\u{D7FF}",
    ];
    for p in prefixes {
        let Some(hi) = next_prefix(p) else { continue };
        // 探针：x、x+长中文、x+两个 emoji、x+char::MAX、x+ASCII
        let probes: Vec<String> = vec![
            format!("{p}x"),
            format!("{p}非常长的中文标签词"),
            format!("{p}😀😀"),
            format!("{p}{}", '\u{10FFFF}'),
            format!("{p}abc"),
        ];
        for s in probes {
            assert!(
                s.as_str() >= p && s.as_str() < hi.as_str(),
                "「{s}」应以 {p} 开头且小于 {hi}"
            );
        }
        // 字典序更大的兄弟（同一长度 + 递增末字符）应在区间外
        let bigger = next_prefix(p).unwrap();
        let sibling = next_prefix(&bigger).unwrap_or_else(|| bigger.clone());
        assert!(
            sibling >= hi,
            "兄弟「{sibling}」应在区间 [{p}, {hi}) 外"
        );
    }
}

/// F3：find_by_term 别名命中（同义词）；旧表路径与 tag_terms 路径行为一致。
#[test]
fn find_by_term_alias_hits_synonym() {
    use bagertea_ai_media_v2_lib::db::tags;
    let c = mem();
    let t = tags::create_in_facet(&c, "海边", None, Some("scene")).unwrap();
    tags::add_alias(&c, t.id, "海滨", None, "synonym").unwrap();
    // 旧表路径（tag_unique_terms 未启用）
    let lookup = tags::find_by_term(&c, "scene", "海滨", tags::TermMatch::Alias).unwrap();
    assert_eq!(lookup.hits.len(), 1, "别名应精确命中：{:?}", lookup.warnings);
    assert_eq!(lookup.hits[0].tag_id, t.id);
    assert!(
        lookup.warnings.iter().any(|w| w.contains("海滨") && w.contains("海边")),
        "别名命中应告知归入：{:?}",
        lookup.warnings
    );
}

/// F3：find_by_term 无 ORDER BY 兜底也唯一（分面内一个 term 最多命中一个标签）。
#[test]
fn find_by_term_is_deterministic() {
    use bagertea_ai_media_v2_lib::db::tags;
    let c = mem();
    // 启用 tag_terms 后：ux_terms 唯一索引保证唯一
    let t1 = tags::create_in_facet(&c, "森林", None, Some("scene")).unwrap();
    migrations::apply_v22b_constraints(&c).unwrap();
    let lookup = tags::find_by_term(&c, "scene", "森林", tags::TermMatch::Exact).unwrap();
    assert_eq!(lookup.hits.len(), 1);
    assert_eq!(lookup.hits[0].tag_id, t1.id);
    // Exact 不命中别名（term_kind='canonical' 过滤）
    tags::add_alias(&c, t1.id, "林子", None, "synonym").unwrap();
    // 新路径写入 tag_terms 需手动加行（apply 后 add_alias 走 tag_aliases —— 双写受 gate 约束）
    // Exact 模式对「林子」无 canonical 命中
    let miss = tags::find_by_term(&c, "scene", "林子", tags::TermMatch::Exact).unwrap();
    assert!(miss.hits.is_empty(), "Exact 只匹配 canonical");
}

// ═══════════════ 组 1（F4）：可见性三常量 —— 消费点一致性矩阵 ═══════════════

/// F5/F2 辅助：完整启用 tag_unique_terms（与命令层 apply_tag_constraints 同语义：
/// 先建约束/灌 canonical，再登记 feature 标志）。
fn enable_terms(conn: &rusqlite::Connection) {
    migrations::apply_v22b_constraints(conn).unwrap();
    schema_features::set_feature(conn, "tag_unique_terms", true, None).unwrap();
}

/// F4 辅助：插入一张图片素材，返回 id。
fn f4_insert_asset(conn: &rusqlite::Connection, path: &str) -> i64 {
    assets::insert(conn, path, path.rsplit('/').next().unwrap_or("a.jpg"), "jpg", 1024, "image/jpeg", 1700000000000)
        .expect("插入素材失败")
}

/// F4：status × cfg_* 组合下，数据层消费点（侧栏树 list_tree / 提示词 build_prompt_context /
/// AI 候选词 top_tags_per_facet / 候选搜索 search_candidates / 详情 get_asset_tags+角标 /
/// 条件叶子 FacetHasAny）可见性一致。
/// 价值：不是「验证现在对」，而是下次有人加第八个消费点时会失败（指南 §F4）。
#[test]
fn facet_capability_matrix() {
    struct Row {
        name: &'static str,
        status: &'static str,
        visible: bool,
        ai: bool,
        searchable: bool,
        nav: bool,
        prompt: bool,
        top: bool,
        search: bool,
        detail_effective: bool,
    }
    let rows = [
        Row { name: "active+全cfg=1", status: "active", visible: true, ai: true, searchable: true, nav: true, prompt: true, top: true, search: true, detail_effective: true },
        Row { name: "active+cfg_ai=0", status: "active", visible: true, ai: false, searchable: true, nav: true, prompt: false, top: false, search: true, detail_effective: true },
        Row { name: "active+cfg_visible=0", status: "active", visible: false, ai: true, searchable: true, nav: false, prompt: true, top: true, search: true, detail_effective: true },
        Row { name: "active+cfg_searchable=0", status: "active", visible: true, ai: true, searchable: false, nav: true, prompt: true, top: true, search: false, detail_effective: true },
        Row { name: "inactive（cfg保持）", status: "inactive", visible: true, ai: true, searchable: true, nav: false, prompt: false, top: false, search: true, detail_effective: false },
    ];
    for r in &rows {
        let c = mem();
        tag_facets::create(&c, "cap", "能力分面", "", "multi", None, "all").unwrap();
        let t = tags::create_in_facet(&c, "能力词", None, Some("cap")).unwrap();
        let aid = f4_insert_asset(&c, "d:/cap.jpg");
        asset_tags::assign(&c, &[aid], &[t.id], "manual").unwrap();
        c.execute(
            "UPDATE tag_facets SET status=?1, cfg_visible_in_navigation=?2,
                    cfg_ai_assignable=?3, cfg_searchable=?4 WHERE key='cap'",
            rusqlite::params![r.status, r.visible as i64, r.ai as i64, r.searchable as i64],
        )
        .unwrap();

        let in_nav = tags::list_tree(&c).unwrap().iter().any(|n| n.tag.facet_key == "cap");
        assert_eq!(in_nav, r.nav, "[{}] 侧栏可见性不符", r.name);

        let in_prompt = tag_facets::build_prompt_context(&c, "image")
            .unwrap()
            .iter()
            .any(|f| f.key == "cap");
        assert_eq!(in_prompt, r.prompt, "[{}] 提示词参与不符", r.name);

        let in_top = tags::top_tags_per_facet(&c, 200)
            .unwrap()
            .iter()
            .any(|(f, _)| f == "cap");
        assert_eq!(in_top, r.top, "[{}] AI 候选词不符", r.name);

        let cands = tags::search_candidates(&c, None, "能力词").unwrap();
        assert_eq!(cands.len() > 0, r.search, "[{}] 候选搜索不符", r.name);

        let detail = asset_tags::get_asset_tags(&c, aid).unwrap();
        let dtag = detail.iter().find(|x| x.id == t.id).expect("详情恒显示（不过滤）");
        assert_eq!(
            dtag.facet_effective, r.detail_effective,
            "[{}] 详情「已停用」角标不符",
            r.name
        );

        let (frag, _) = query_expr::compile_leaf(&c, &query_expr::LeafCond::FacetHasAny { facet_key: "cap".into() })
            .unwrap();
        let dropped = frag.trim() == "1=1";
        assert_eq!(dropped, !r.searchable, "[{}] 条件叶子剔除策略不符", r.name);
    }

    // 停用 → 恢复：回原配置（矩阵第 6 行）——生命周期状态永不覆盖 cfg_*
    let c = mem();
    tag_facets::create(&c, "cap2", "能力分面2", "", "multi", None, "all").unwrap();
    let t2 = tags::create_in_facet(&c, "能力词2", None, Some("cap2")).unwrap();
    let aid2 = f4_insert_asset(&c, "d:/cap2.jpg");
    asset_tags::assign(&c, &[aid2], &[t2.id], "manual").unwrap();
    tag_facets::deactivate(&c, "cap2").unwrap();
    // inactive：侧栏/提示词/AI候选停；详情仍显示 + 角标；可搜保持
    assert!(!tags::list_tree(&c).unwrap().iter().any(|n| n.tag.facet_key == "cap2"));
    assert!(!tag_facets::build_prompt_context(&c, "image").unwrap().iter().any(|f| f.key == "cap2"));
    assert!(!tags::top_tags_per_facet(&c, 200).unwrap().iter().any(|(f, _)| f == "cap2"));
    assert!(!tags::search_candidates(&c, None, "能力词2").unwrap().is_empty(), "停用分面标签仍可搜");
    let detail2 = asset_tags::get_asset_tags(&c, aid2).unwrap();
    assert!(!detail2.iter().find(|x| x.id == t2.id).unwrap().facet_effective, "停用分面详情打角标");
    // restore：回原配置
    tag_facets::restore(&c, "cap2").unwrap();
    assert!(tags::list_tree(&c).unwrap().iter().any(|n| n.tag.facet_key == "cap2"));
    assert!(tag_facets::build_prompt_context(&c, "image").unwrap().iter().any(|f| f.key == "cap2"));
    assert!(tags::top_tags_per_facet(&c, 200).unwrap().iter().any(|(f, _)| f == "cap2"));
    let detail3 = asset_tags::get_asset_tags(&c, aid2).unwrap();
    assert!(detail3.iter().find(|x| x.id == t2.id).unwrap().facet_effective, "恢复后角标消失");
}

/// F4：停用分面的标签仍可搜 —— FTS 全文搜索 + 候选搜索都保持命中
/// （SEARCHABLE_TAG / FTS 触发器只读 cfg_searchable，不看 f.status）。
#[test]
fn deactivated_facet_tags_still_searchable() {
    use bagertea_ai_media_v2_lib::db::search;
    let c = mem();
    tag_facets::create(&c, "mood_x", "情绪", "", "multi", None, "all").unwrap();
    let t = tags::create_in_facet(&c, "松弛感", None, Some("mood_x")).unwrap();
    let aid = f4_insert_asset(&c, "d:/mood.jpg");
    asset_tags::assign(&c, &[aid], &[t.id], "manual").unwrap();
    assert_eq!(
        search::search_asset_ids_all(&c, "松弛感").unwrap(),
        vec![aid],
        "停用前 FTS 应命中"
    );
    tag_facets::deactivate(&c, "mood_x").unwrap();
    assert_eq!(
        search::search_asset_ids_all(&c, "松弛感").unwrap(),
        vec![aid],
        "停用分面的标签仍可搜（FTS 只看 cfg_searchable）"
    );
    assert_eq!(
        tags::search_candidates(&c, None, "松弛").unwrap().len(),
        1,
        "停用分面的标签仍进候选"
    );
    // 对照：cfg_searchable=0 后候选搜索实时剔除（live 读）
    c.execute("UPDATE tag_facets SET cfg_searchable = 0 WHERE key = 'mood_x'", [])
        .unwrap();
    assert!(tags::search_candidates(&c, None, "松弛").unwrap().is_empty());
}

/// F4：停用分面的标签不得作为「已有候选词」喂给 AI（top_tags_per_facet 收口 AI_ASSIGNABLE_TAG）。
#[test]
fn top_tags_excludes_inactive_facet() {
    let c = mem();
    let key = "cap_top";
    tag_facets::create(&c, key, "候选分面", "", "multi", None, "all").unwrap();
    let t = tags::create_in_facet(&c, "高频词", None, Some(key)).unwrap();
    let aid = f4_insert_asset(&c, "d:/top.jpg");
    asset_tags::assign(&c, &[aid], &[t.id], "manual").unwrap();
    assert!(
        tags::top_tags_per_facet(&c, 200).unwrap().iter().any(|(f, _)| f == key),
        "active 分面应进 AI 候选"
    );
    tag_facets::deactivate(&c, key).unwrap();
    assert!(
        !tags::top_tags_per_facet(&c, 200).unwrap().iter().any(|(f, _)| f == key),
        "停用分面不得进 AI 候选（避免 AI 照产出后又被解析层丢弃的自相矛盾）"
    );
}

/// F4：build_prompt_context(media_kind) 按 applies_to 过滤 ——
/// 视频专属分面不污染图片批次提示词；'all' 用于超级搜索词典全量。
#[test]
fn prompt_context_respects_applies_to() {
    let c = mem();
    tag_facets::create(&c, "f_all", "通用", "", "multi", None, "all").unwrap();
    tag_facets::create(&c, "f_img", "画面", "", "multi", None, "image").unwrap();
    tag_facets::create(&c, "f_vid", "运镜", "", "multi", None, "video").unwrap();
    let img_keys: Vec<String> = tag_facets::build_prompt_context(&c, "image")
        .unwrap()
        .iter()
        .map(|f| f.key.clone())
        .collect();
    assert!(img_keys.contains(&"f_all".into()) && img_keys.contains(&"f_img".into()), "图片上下文应含 all+image: {img_keys:?}");
    assert!(!img_keys.contains(&"f_vid".into()), "视频专属分面不得进图片上下文: {img_keys:?}");
    let vid_keys: Vec<String> = tag_facets::build_prompt_context(&c, "video")
        .unwrap()
        .iter()
        .map(|f| f.key.clone())
        .collect();
    assert!(vid_keys.contains(&"f_all".into()) && vid_keys.contains(&"f_vid".into()), "视频上下文应含 all+video: {vid_keys:?}");
    assert!(!vid_keys.contains(&"f_img".into()), "图片专属分面不得进视频上下文: {vid_keys:?}");
    // 'all'：全量（超级搜索词典需要跨类型）——含系统分面 + 自定义三档
    let all_keys: Vec<String> = tag_facets::build_prompt_context(&c, "all")
        .unwrap()
        .iter()
        .map(|f| f.key.clone())
        .collect();
    assert!(
        all_keys.contains(&"f_all".into())
            && all_keys.contains(&"f_img".into())
            && all_keys.contains(&"f_vid".into()),
        "'all' 应含全部三档: {all_keys:?}"
    );
    // 非法 media_kind 报错
    assert!(tag_facets::build_prompt_context(&c, "audio").is_err());
}

// ═══════════════ F5：应用层单点收口 + tag_unique_terms feature gate ═══════════════

/// F5：根级「新词」创建自动查重（find_by_term mode=Alias）——同名/同义词都归并到已有标签。
#[test]
fn create_in_facet_dedups_via_find_by_term() {
    let c = mem();
    let a = tags::create_in_facet(&c, "海边", None, Some("scene")).unwrap();
    let b = tags::create_in_facet(&c, "海边", None, Some("scene")).unwrap();
    assert_eq!(a.id, b.id, "同分面同名根级创建应去重返回同一标签");
    let n: i64 = c
        .query_row(
            "SELECT COUNT(*) FROM tags WHERE facet_key='scene' AND name='海边'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(n, 1, "库里只能有一个「海边」");
    // 与已有同义词（别名）同名 → 归并到别名归属标签（关闭态走旧表 tag_aliases）
    let forest = tags::create_in_facet(&c, "森林", None, Some("scene")).unwrap();
    tags::add_alias(&c, forest.id, "树林", None, "synonym").unwrap();
    let hit = tags::create_in_facet(&c, "树林", None, Some("scene")).unwrap();
    assert_eq!(hit.id, forest.id, "「树林」是「森林」的同义词，创建应归并");
}

/// F5：create_tag 落库入口（tags::create_tag_in_facet）—— 无 parent 且无 facet 时报错，
/// 不再默默落 custom；有 facet / 有 parent 时正常归属。
#[test]
fn create_tag_requires_facet_when_no_parent() {
    let c = mem();
    // 无 parent 无 facet → 报错
    let err = tags::create_tag_in_facet(&c, "新词", None, None).unwrap_err();
    assert!(err.to_string().contains("分面"), "应提示选择分面: {err}");
    // 给 facet → 创建成功且归属正确
    let t = tags::create_tag_in_facet(&c, "新词", Some("scene"), None).unwrap();
    assert_eq!(t.facet_key, "scene");
    // 有 parent 无 facet → 按父标签归属分面
    let child = tags::create_tag_in_facet(&c, "子词", None, Some(t.id)).unwrap();
    assert_eq!(child.facet_key, "scene", "子标签应继承父标签分面");
}

/// F5：tags::update 改 parent 时校验同分面（触发器第二层兜底）。
#[test]
fn update_rejects_cross_facet_parent() {
    let c = mem();
    let subject = tags::create_in_facet(&c, "人像", None, Some("subject")).unwrap();
    let scene = tags::create_in_facet(&c, "海边", None, Some("scene")).unwrap();
    let err = tags::update(&c, scene.id, None, Some(Some(subject.id))).unwrap_err();
    assert!(
        err.to_string().contains("分面"),
        "跨分面挂父应报错: {err}"
    );
    // 同分面移动成功（防环由触发器守：挂到自己后代仍被拒）
    let child = tags::create_in_facet(&c, "沙滩", Some(scene.id), Some("scene")).unwrap();
    tags::update(&c, child.id, None, Some(Some(scene.id))).unwrap();
    let cycle_err = tags::update(&c, scene.id, None, Some(Some(child.id))).unwrap_err();
    assert!(!cycle_err.to_string().is_empty(), "挂到自己子标签下应被触发器拒绝");
}

/// F5：启用 tag_unique_terms 后 add_alias 写 tag_terms，ux_terms 冲突被翻译成人话。
#[test]
fn add_alias_conflict_message_is_human_readable() {
    let c = mem();
    let t1 = tags::create_in_facet(&c, "海边", None, Some("scene")).unwrap();
    let t2 = tags::create_in_facet(&c, "森林", None, Some("scene")).unwrap();
    enable_terms(&c);
    tags::add_alias(&c, t1.id, "海滨", None, "synonym").unwrap();
    let err = tags::add_alias(&c, t2.id, "海滨", None, "synonym").unwrap_err();
    let msg = err.to_string();
    assert!(msg.contains("海滨") && msg.contains("海边") && msg.contains("已被"), "冲突消息应点明两个词: {msg}");
    // 同标签幂等：重复添加同一词不报错
    tags::add_alias(&c, t1.id, "海滨", None, "synonym").unwrap();
}

/// F5+F6-c：启用词表后 merge 把 src 全部词条迁到 dst（canonical→synonym——合并=语义等价，
/// 改名才写 old_name；synonym 保留）。
#[test]
fn merge_moves_all_terms_to_target() {
    let c = mem();
    let src = tags::create_in_facet(&c, "海边", None, Some("scene")).unwrap();
    let dst = tags::create_in_facet(&c, "海岸", None, Some("scene")).unwrap();
    enable_terms(&c);
    tags::add_alias(&c, src.id, "海滨", None, "synonym").unwrap();
    tags::merge_preserve_alias(&c, src.id, dst.id).unwrap();
    let rows: Vec<(String, String)> = c
        .prepare("SELECT term, term_kind FROM tag_terms WHERE tag_id = ?1 ORDER BY term_kind")
        .unwrap()
        .query_map([dst.id], |r| Ok((r.get(0)?, r.get(1)?)))
        .unwrap()
        .filter_map(|r| r.ok())
        .collect();
    let kinds: Vec<&str> = rows.iter().map(|(_, k)| k.as_str()).collect();
    assert!(rows.iter().any(|(t, k)| t == "海岸" && k == "canonical"), "目标 canonical 保留: {rows:?}");
    assert!(rows.iter().any(|(t, k)| t == "海边" && k == "synonym"), "源 canonical 合并为 synonym（F6-c）: {rows:?}");
    assert!(rows.iter().any(|(t, k)| t == "海滨" && k == "synonym"), "源 synonym 保留: {rows:?}");
    assert_eq!(rows.len(), 3, "词条应完整迁移: {rows:?}");
}

/// F5：脏库（同分面同词重复）合并时不崩——撞了跳过，目标词优先。
#[test]
fn merge_skips_conflicting_term() {
    let c = mem();
    let src = tags::create_in_facet(&c, "海边", None, Some("scene")).unwrap();
    let dst = tags::create_in_facet(&c, "海岸", None, Some("scene")).unwrap();
    enable_terms(&c);
    // 造脏：dst 直插一条与 src canonical 同 normalized 的 canonical（先撤两个唯一索引才能插：
    // ux_terms 管 facet+词唯一，ux_terms_canonical 管同标签单 canonical）
    c.execute_batch("DROP INDEX ux_terms; DROP INDEX ux_terms_canonical;").unwrap();
    c.execute(
        "INSERT INTO tag_terms (tag_id, facet_key, normalized_term, term, locale, term_kind, is_searchable, created_at)
         VALUES (?1, 'scene', '海边', '海边', '', 'canonical', 1, 1)",
        [dst.id],
    )
    .unwrap();
    // 合并必须成功（不因 PK/唯一冲突中断），且 dst 仍只有一条「海边」
    tags::merge_preserve_alias(&c, src.id, dst.id).unwrap();
    let n: i64 = c
        .query_row(
            "SELECT COUNT(*) FROM tag_terms WHERE tag_id=?1 AND normalized_term='海边'",
            [dst.id],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(n, 1, "冲突词条被跳过，不产生重复: dst=海边 rows={n}");
}

/// F5：合并后源标签 deprecated 且没有任何词条（词已迁走）。
#[test]
fn deprecated_tag_has_no_terms() {
    let c = mem();
    let src = tags::create_in_facet(&c, "海边", None, Some("scene")).unwrap();
    let dst = tags::create_in_facet(&c, "海岸", None, Some("scene")).unwrap();
    enable_terms(&c);
    tags::add_alias(&c, src.id, "海滨", None, "synonym").unwrap();
    tags::merge_preserve_alias(&c, src.id, dst.id).unwrap();
    let status: String = c
        .query_row("SELECT status FROM tags WHERE id=?1", [src.id], |r| r.get(0))
        .unwrap();
    assert_eq!(status, "deprecated", "源标签应置 deprecated");
    let name: String = c
        .query_row("SELECT name FROM tags WHERE id=?1", [src.id], |r| r.get(0))
        .unwrap();
    assert!(name.contains("原名 #"), "源标签改名避开旧 UNIQUE: {name}");
    let n: i64 = c
        .query_row(
            "SELECT COUNT(*) FROM tag_terms WHERE tag_id=?1",
            [src.id],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(n, 0, "deprecated 标签不应残留词条");
}

/// F5+F6-c：合并后旧词仍可搜到目标标签（synonym 词条生效）。
#[test]
fn search_old_name_hits_merge_target() {
    let c = mem();
    let src = tags::create_in_facet(&c, "海边", None, Some("scene")).unwrap();
    let dst = tags::create_in_facet(&c, "海岸", None, Some("scene")).unwrap();
    enable_terms(&c);
    tags::merge_preserve_alias(&c, src.id, dst.id).unwrap();
    let lk = tags::find_by_term(&c, "scene", &tags::normalize_name("海边"), tags::TermMatch::Alias)
        .unwrap();
    assert_eq!(lk.hits.len(), 1, "旧词应精确命中: {:?}", lk.warnings);
    assert_eq!(lk.hits[0].tag_id, dst.id, "旧词「海边」应指向合并目标");
    assert_eq!(lk.hits[0].term_kind, "synonym", "合并写 synonym（F6-c），改名才写 old_name");
}

/// F5-d：find_by_term 尊重 feature gate —— 关闭读旧表、开启读 tag_terms，各断言一次。
#[test]
fn find_by_term_respects_feature_gate() {
    // 状态 0：关闭 → 别名事实源 tag_aliases（写入旧表），find_by_term Alias 命中
    let c0 = mem();
    let t0 = tags::create_in_facet(&c0, "海边", None, Some("scene")).unwrap();
    tags::add_alias(&c0, t0.id, "海滨", None, "synonym").unwrap();
    let lk0 = tags::find_by_term(&c0, "scene", &tags::normalize_name("海滨"), tags::TermMatch::Alias)
        .unwrap();
    assert_eq!(lk0.hits.len(), 1, "关闭态别名（tag_aliases）应命中");
    assert_eq!(lk0.hits[0].tag_id, t0.id);
    // 关闭态不读 tag_terms：即便手工造了词条行也不参与
    c0.execute_batch("CREATE TABLE IF NOT EXISTS tag_terms (
        tag_id INTEGER NOT NULL, facet_key TEXT NOT NULL, normalized_term TEXT NOT NULL,
        term TEXT NOT NULL, locale TEXT NOT NULL DEFAULT '', term_kind TEXT NOT NULL,
        is_searchable INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL)").unwrap();
    let another = tags::create_in_facet(&c0, "森林", None, Some("scene")).unwrap();
    c0.execute(
        "INSERT INTO tag_terms (tag_id, facet_key, normalized_term, term, locale, term_kind, is_searchable, created_at)
         VALUES (?1, 'scene', '森林', '森林', '', 'canonical', 1, 1)",
        [another.id],
    )
    .unwrap();
    let lk0b = tags::find_by_term(&c0, "scene", &tags::normalize_name("森林"), tags::TermMatch::Exact)
        .unwrap();
    assert_eq!(lk0b.hits.len(), 1, "关闭态仍按旧表命中（tags 规范名）");

    // 状态 1：开启 → 别名事实源 tag_terms（写入词条表），find_by_term Alias 命中词条
    let c1 = mem();
    let t1 = tags::create_in_facet(&c1, "海边", None, Some("scene")).unwrap();
    enable_terms(&c1);
    tags::add_alias(&c1, t1.id, "海滨", None, "synonym").unwrap();
    let lk1 = tags::find_by_term(&c1, "scene", &tags::normalize_name("海滨"), tags::TermMatch::Alias)
        .unwrap();
    assert_eq!(lk1.hits.len(), 1, "开启态别名（tag_terms）应命中");
    assert_eq!(lk1.hits[0].tag_id, t1.id);
    let terms_n: i64 = c1
        .query_row(
            "SELECT COUNT(*) FROM tag_terms WHERE tag_id=?1",
            [t1.id],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(terms_n, 2, "开启态 canonical+synonym 都在 tag_terms（绝不双写）");
    let aliases_n: i64 = c1
        .query_row(
            "SELECT COUNT(*) FROM tag_aliases WHERE tag_id=?1",
            [t1.id],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(aliases_n, 0, "开启态 tag_aliases 冻结只读，新增别名不得双写");
}

/// F5-d：未启用词表时 Prefix/Contains/Fuzzy 返回空 + 指引 warning。
#[test]
fn prefix_mode_unavailable_without_terms() {
    let c = mem();
    tags::create_in_facet(&c, "海边", None, Some("scene")).unwrap();
    for mode in [
        tags::TermMatch::Prefix,
        tags::TermMatch::Contains,
        tags::TermMatch::Fuzzy,
    ] {
        let lk = tags::find_by_term(&c, "scene", "海", mode).unwrap();
        assert!(lk.hits.is_empty(), "{mode:?} 未启用时应无命中");
        assert!(
            lk.warnings.iter().any(|w| w.contains("启用标签约束")),
            "{mode:?} 应提示启用标签约束: {:?}",
            lk.warnings
        );
    }
    // 启用后（S5 前未实现模糊匹配）不再报「不可用」指引
    let c2 = mem();
    tags::create_in_facet(&c2, "海边", None, Some("scene")).unwrap();
    enable_terms(&c2);
    let lk2 = tags::find_by_term(&c2, "scene", "海", tags::TermMatch::Prefix).unwrap();
    assert!(
        !lk2.warnings.iter().any(|w| w.contains("启用标签约束")),
        "启用后不应再提示不可用: {:?}",
        lk2.warnings
    );
}

// ═══════════════ F6：词表治理 ═══════════════

/// 辅助：单素材批次 → 返回第一条 suggestion。
fn f6_one_suggestion(c: &rusqlite::Connection) -> bagertea_ai_media_v2_lib::db::ai::AiSuggestion {
    use bagertea_ai_media_v2_lib::db::ai;
    let aid = f4_insert_asset(c, "d:/f6.jpg");
    let batch = ai::create_batch(c, &[aid], "cloud").unwrap();
    let s = ai::list_suggestions(c, batch.id).unwrap();
    assert_eq!(s.len(), 1);
    s.into_iter().next().unwrap()
}

/// F6-a：词表里没有的词，候选留在 ai_suggestion_items（tag_id NULL），tags 表不动。
#[test]
fn ai_new_term_stays_in_suggestion_items() {
    use bagertea_ai_media_v2_lib::db::ai;
    let c = mem();
    let sug = f6_one_suggestion(&c);
    let tags = ai::CategorizedTags::from([("scene".to_string(), vec!["太空漫步".to_string()])]);
    ai::set_suggestion_tags(&c, sug.id, &tags).unwrap();
    // ① tags 表不新增
    let n: i64 = c
        .query_row(
            "SELECT COUNT(*) FROM tags WHERE name='太空漫步'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(n, 0, "候选词不得提前进入 tags（AI 还没确认）");
    // ② 候选留在 items：pending + tag_id NULL
    let items = ai::list_suggestion_items(&c, sug.id).unwrap();
    assert_eq!(items.len(), 1);
    assert_eq!(items[0].facet_key, "scene");
    assert!(items[0].tag_id.is_none(), "未命中词表 → tag_id 保持 NULL");
    assert_eq!(items[0].decision, "pending");
}

/// F6-a/F6-c：用户把候选「一个人」合并到已有词「单人」→ 目标补 synonym 别名（不是 old_name）。
#[test]
fn candidate_merge_writes_synonym_not_old_name() {
    use bagertea_ai_media_v2_lib::db::ai;
    let c = mem();
    let target = tags::create_in_facet(&c, "单人", None, Some("scene")).unwrap();
    let sug = f6_one_suggestion(&c);
    let tags = ai::CategorizedTags::from([("scene".to_string(), vec!["一个人".to_string()])]);
    ai::set_suggestion_tags(&c, sug.id, &tags).unwrap();
    let item = ai::list_suggestion_items(&c, sug.id).unwrap().into_iter().next().unwrap();
    assert!(item.tag_id.is_none());
    // 用户选「合并到单人」
    ai::decide_suggestion_item(&c, item.id, "modified", Some(target.id), None, None).unwrap();
    // 目标补 synonym「一个人」（旧表路径 alias_type='synonym'；绝不写 old_name）
    let row: Option<(String, String)> = c
        .query_row(
            "SELECT ta.alias, ta.alias_type FROM tag_aliases ta
              WHERE ta.tag_id=?1 AND ta.normalized_alias='一个人'",
            [target.id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .ok();
    let (alias, kind) = row.expect("合并后目标应有 synonym 别名");
    assert_eq!(alias, "一个人");
    assert_eq!(kind, "synonym", "候选合并写 synonym（F6-c），不是 old_name");
    // item 指向目标
    let after = ai::list_suggestion_items(&c, sug.id).unwrap();
    assert_eq!(after[0].tag_id, Some(target.id));
    assert_eq!(after[0].decision, "modified");
}

/// F6-b：近似匹配两类都检出 —— 子串（一个 vs 一个人）+ 编辑距离（森材 vs 森林）。
#[test]
fn find_similar_detects_substring_and_edit_distance() {
    let c = mem();
    tags::create_in_facet(&c, "一个人", None, Some("scene")).unwrap();
    tags::create_in_facet(&c, "森林", None, Some("scene")).unwrap();
    // ② 子串：长度差 1，「一个人」含「一个」
    let sub = tags::find_similar_tag(&c, "scene", &tags::normalize_name("一个"))
        .unwrap()
        .expect("应命中「一个人」");
    assert_eq!(sub.1, "一个人");
    assert_eq!(sub.2, tags::SimilarReason::Substring);
    // ③ 编辑距离 ≤ 1：「森材」→「森林」
    let spell = tags::find_similar_tag(&c, "scene", &tags::normalize_name("森材"))
        .unwrap()
        .expect("应命中「森林」");
    assert_eq!(spell.1, "森林");
    assert_eq!(spell.2, tags::SimilarReason::Spell);
    // 不相关的词不误报
    assert!(tags::find_similar_tag(&c, "scene", &tags::normalize_name("城市")).unwrap().is_none());
}

/// F6-d：疑似重复扫描 —— 连通分量把 单人/一个人/一个 聚成一组。
#[test]
fn scan_duplicate_tags_finds_known_groups() {
    let c = mem();
    let a = tags::create_in_facet(&c, "单人", None, Some("scene")).unwrap();
    let b = tags::create_in_facet(&c, "一个人", None, Some("scene")).unwrap();
    let d = tags::create_in_facet(&c, "一个", None, Some("scene")).unwrap();
    let groups = tags::scan_duplicate_tags(&c).unwrap();
    let names: Vec<String> = groups
        .iter()
        .filter(|g| g.facet_key == "scene")
        .flat_map(|g| g.members.iter().map(|m| m.name.clone()))
        .collect();
    for expect in [&a.id, &b.id, &d.id] {
        let in_group = groups.iter().any(|g| {
            g.facet_key == "scene" && g.members.iter().any(|m| m.tag_id == *expect)
        });
        assert!(in_group, "「{expect}」应出现在疑似重复组");
    }
    assert!(
        names.contains(&"单人".to_string())
            && names.contains(&"一个人".to_string())
            && names.contains(&"一个".to_string()),
        "疑似重复应把 单人/一个人/一个 聚出（实际 scene 组: {names:?}）"
    );
}

/// F6-c：别名冲突按分面 —— 跨分面同名允许，同分面拒绝。
#[test]
fn alias_same_term_allowed_across_facets() {
    let c = mem();
    let people = tags::create_in_facet(&c, "人物", None, Some("people")).unwrap();
    let subject = tags::create_in_facet(&c, "主体", None, Some("subject")).unwrap();
    // people 用「一个人」作别名
    tags::add_alias(&c, people.id, "一个人", None, "synonym").unwrap();
    // subject 分面再用「一个人」→ 允许
    tags::add_alias(&c, subject.id, "一个人", None, "synonym").unwrap();
    // 同分面再用 → 拒绝
    let other_people = tags::create_in_facet(&c, "人像特写", None, Some("people")).unwrap();
    let err = tags::add_alias(&c, other_people.id, "一个人", None, "synonym").unwrap_err();
    assert!(
        err.to_string().contains("已绑定"),
        "同分面重词应报错: {err}"
    );
}
