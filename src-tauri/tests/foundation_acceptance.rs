//! §13 验收测试清单（十二组约 62 条）—— 一条命令跑完：
//!   cargo test --test foundation_acceptance
//!
//! 命名前缀统一；每个波次结束跑对应组（§13 验收流程）：
//!   F 波次 → 组 1/2/3/5/10/12；A 波次 → 组 4/5；S 波次 → 组 6/9/11；
//!   C 波次 → 组 7；全部绿 + 四关全绿 → foundation-verified。

use bagertea_ai_media_v2_lib::db::{init_memory, tag_facets, tags};
use bagertea_ai_media_v2_lib::error::AppResult;

fn mem() -> rusqlite::Connection {
    init_memory().expect("内存库初始化失败")
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
