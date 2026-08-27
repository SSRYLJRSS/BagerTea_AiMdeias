//! T02 验收测试：迁移/触发器/搜索/标签树/分页/设置/AI 确认流
//! 运行：cargo test

use bagertea_ai_media_v2_lib::db::assets::AssetFilter;
use bagertea_ai_media_v2_lib::db::{
    self, ai, asset_tags, assets, dedup, migrations, settings, tag_ops, tags,
};
use bagertea_ai_media_v2_lib::error::AppResult;

fn setup() -> rusqlite::Connection {
    db::init_memory().expect("内存库初始化失败")
}

fn add_asset(conn: &rusqlite::Connection, path: &str, name: &str, ext: &str, mime: &str) -> i64 {
    assets::insert(conn, path, name, ext, 1024, mime, 1700000000000).expect("插入素材失败")
}

// ① 迁移 + 触发器：插入素材即可被 FTS 检索（文件名逐字切分）
#[test]
fn fts_index_on_insert() -> AppResult<()> {
    let conn = setup();
    let id = add_asset(
        &conn,
        "d:/p/海边日落.jpg",
        "海边日落.jpg",
        "jpg",
        "image/jpeg",
    );
    let ids = db::search::search_asset_ids(&conn, "海边日落")?;
    assert_eq!(ids, vec![id]);
    Ok(())
}

// ② 词中子串可查：「日落」命中「海边日落.jpg」
#[test]
fn fts_substring_hit() -> AppResult<()> {
    let conn = setup();
    let id = add_asset(
        &conn,
        "d:/p/海边日落.jpg",
        "海边日落.jpg",
        "jpg",
        "image/jpeg",
    );
    assert_eq!(db::search::search_asset_ids(&conn, "日落")?, vec![id]);
    Ok(())
}

// ③ 短语精确性：搜「海边」不得命中「上海公园湖边合影.jpg」
#[test]
fn fts_phrase_no_false_positive() -> AppResult<()> {
    let conn = setup();
    let hit = add_asset(
        &conn,
        "d:/p/海边日落.jpg",
        "海边日落.jpg",
        "jpg",
        "image/jpeg",
    );
    add_asset(
        &conn,
        "d:/p/上海公园湖边合影.jpg",
        "上海公园湖边合影.jpg",
        "jpg",
        "image/jpeg",
    );
    assert_eq!(db::search::search_asset_ids(&conn, "海边")?, vec![hit]);
    Ok(())
}

// ④ ≤2 字 LIKE 兜底 + 按标签名搜索
#[test]
fn like_fallback_and_tag_search() -> AppResult<()> {
    let conn = setup();
    let id = add_asset(
        &conn,
        "d:/p/photo001.jpg",
        "photo001.jpg",
        "jpg",
        "image/jpeg",
    );
    let tag = tags::create(&conn, "海边", None)?;
    asset_tags::assign(&conn, &[id], &[tag.id], "manual")?;
    // 按标签名（2 字 → LIKE 走 EXISTS 子查询）
    assert_eq!(db::search::search_asset_ids(&conn, "海边")?, vec![id]);
    // 按文件名（2 字 ASCII）
    assert_eq!(db::search::search_asset_ids(&conn, "01")?, vec![id]);
    Ok(())
}

// ⑤ 摘除标签后无幻影命中（触发器 delete 顺序正确性）
#[test]
fn no_phantom_after_tag_removal() -> AppResult<()> {
    let conn = setup();
    let id = add_asset(
        &conn,
        "d:/p/photo001.jpg",
        "photo001.jpg",
        "jpg",
        "image/jpeg",
    );
    let tag = tags::create(&conn, "山野", None)?;
    asset_tags::assign(&conn, &[id], &[tag.id], "manual")?;
    assert_eq!(db::search::search_asset_ids(&conn, "山野")?, vec![id]);
    asset_tags::remove(&conn, &[id], &[tag.id])?;
    assert!(
        db::search::search_asset_ids(&conn, "山野")?.is_empty(),
        "摘除标签后仍命中（幻影）"
    );
    Ok(())
}

// ⑥ 文件改名索引同步
#[test]
fn rename_updates_index() -> AppResult<()> {
    let conn = setup();
    let id = add_asset(&conn, "d:/p/old.jpg", "old.jpg", "jpg", "image/jpeg");
    conn.execute(
        "UPDATE assets SET file_name = '新名字.jpg' WHERE id = ?1",
        [id],
    )?;
    assert_eq!(db::search::search_asset_ids(&conn, "新名字")?, vec![id]);
    assert!(db::search::search_asset_ids(&conn, "old")?.is_empty());
    Ok(())
}

// ⑦ 删除素材后索引清除（CASCADE + 触发器）
#[test]
fn delete_asset_clears_index() -> AppResult<()> {
    let conn = setup();
    let id = add_asset(
        &conn,
        "d:/p/海边日落.jpg",
        "海边日落.jpg",
        "jpg",
        "image/jpeg",
    );
    assets::delete(&conn, &[id])?;
    assert!(db::search::search_asset_ids(&conn, "海边日落")?.is_empty());
    Ok(())
}

// ⑧ 标签树：父子层级 + 连带计数（去重）
#[test]
fn tag_tree_counts() -> AppResult<()> {
    let conn = setup();
    let parent = tags::create(&conn, "人像", None)?;
    let child = tags::create(&conn, "宠物", Some(parent.id))?;
    let a1 = add_asset(&conn, "d:/p/a1.jpg", "a1.jpg", "jpg", "image/jpeg");
    let a2 = add_asset(&conn, "d:/p/a2.jpg", "a2.jpg", "jpg", "image/jpeg");
    asset_tags::assign(&conn, &[a1], &[parent.id], "manual")?;
    asset_tags::assign(&conn, &[a1, a2], &[child.id], "manual")?; // a1 同时挂父子

    let tree = tags::list_tree(&conn)?;
    let p = tree
        .iter()
        .find(|n| n.tag.id == parent.id)
        .expect("父标签缺失");
    assert_eq!(p.tag.asset_count, 1); // 自身直接关联
    assert_eq!(p.tag.total_count, 2); // a1+a2 去重合计
    assert_eq!(p.children.len(), 1);
    assert_eq!(p.children[0].tag.total_count, 2);
    Ok(())
}

// ⑨ 挂载防环
#[test]
fn tag_reparent_cycle_rejected() -> AppResult<()> {
    let conn = setup();
    let parent = tags::create(&conn, "人像", None)?;
    let child = tags::create(&conn, "宠物", Some(parent.id))?;
    let r = tags::update(&conn, parent.id, None, Some(Some(child.id)));
    assert!(r.is_err(), "把父标签挂到自己子标签下应被拒绝");
    Ok(())
}

// ⑩ 标签合并（M3-01）：关联改挂去重 + 子标签回挂 + FTS 联动
#[test]
fn tag_merge_moves_assets_and_children() -> AppResult<()> {
    let conn = setup();
    let src = tags::create(&conn, "海边", None)?;
    let dst = tags::create(&conn, "风景", None)?;
    let src_child = tags::create(&conn, "沙滩", Some(src.id))?;
    let a1 = add_asset(&conn, "d:/p/a1.jpg", "a1.jpg", "jpg", "image/jpeg");
    let a2 = add_asset(&conn, "d:/p/a2.jpg", "a2.jpg", "jpg", "image/jpeg");
    asset_tags::assign(&conn, &[a1, a2], &[src.id], "manual")?;
    asset_tags::assign(&conn, &[a1], &[dst.id], "manual")?; // a1 同时挂两边 → 合并后去重

    tags::merge(&conn, src.id, dst.id)?;

    // src 已删除；子标签回挂 dst
    let tree = tags::list_tree(&conn)?;
    assert!(tree.iter().all(|n| n.tag.id != src.id), "源标签应被删除");
    let d = tree
        .iter()
        .find(|n| n.tag.id == dst.id)
        .expect("目标标签缺失");
    assert_eq!(d.tag.asset_count, 2);
    assert_eq!(d.children.len(), 1);
    assert_eq!(d.children[0].tag.id, src_child.id);
    // FTS 按目标标签名仍可搜
    assert_eq!(db::search::search_asset_ids(&conn, "风景")?.len(), 2);
    assert!(
        db::search::search_asset_ids(&conn, "海边")?.is_empty(),
        "源标签名不应再命中"
    );
    Ok(())
}

// ⑪ 合并防环：不能合并到自己的子标签下
#[test]
fn tag_merge_into_descendant_rejected() -> AppResult<()> {
    let conn = setup();
    let parent = tags::create(&conn, "人像", None)?;
    let child = tags::create(&conn, "自拍", Some(parent.id))?;
    assert!(
        tags::merge(&conn, parent.id, parent.id).is_err(),
        "自合并应被拒绝"
    );
    assert!(
        tags::merge(&conn, parent.id, child.id).is_err(),
        "合并到自己的子标签下应被拒绝"
    );
    Ok(())
}

// ⑫ 重复素材扫描（M3-02）：hash 分组 + 最早优先排序
#[test]
fn dedup_scan_groups_by_hash() -> AppResult<()> {
    let conn = setup();
    let a1 = add_asset(&conn, "d:/p/a1.jpg", "a1.jpg", "jpg", "image/jpeg");
    let a2 = add_asset(&conn, "d:/p/a2.jpg", "a2.jpg", "jpg", "image/jpeg");
    let a3 = add_asset(&conn, "d:/p/a3.jpg", "a3.jpg", "jpg", "image/jpeg");
    // a1/a2 同 hash 重复；a3 独立；a2 入库更晚（insert 固定 created_at，用 id 升序兼验排序稳定性）
    assets::set_hash(&conn, a1, "h_same")?;
    assets::set_hash(&conn, a2, "h_same")?;
    assets::set_hash(&conn, a3, "h_other")?;

    let groups = dedup::scan_groups(&conn)?;
    assert_eq!(groups.len(), 1, "只应有一组重复");
    assert_eq!(groups[0].hash, "h_same");
    assert_eq!(
        groups[0].assets.iter().map(|a| a.id).collect::<Vec<_>>(),
        vec![a1, a2]
    );
    Ok(())
}

// ⑩ 分页 + 筛选（类型/未打标/标签连带）
#[test]
fn assets_pagination_and_filters() -> AppResult<()> {
    let conn = setup();
    for i in 0..5 {
        add_asset(
            &conn,
            &format!("d:/p/img{i}.jpg"),
            &format!("img{i}.jpg"),
            "jpg",
            "image/jpeg",
        );
    }
    add_asset(&conn, "d:/p/v0.mp4", "v0.mp4", "mp4", "video/mp4");

    let page1 = assets::list(
        &conn,
        &AssetFilter {
            limit: 4,
            ..Default::default()
        },
    )?;
    assert_eq!(page1.total, 6);
    assert_eq!(page1.items.len(), 4);
    assert!(page1.has_more);
    let page2 = assets::list(
        &conn,
        &AssetFilter {
            limit: 4,
            offset: 4,
            ..Default::default()
        },
    )?;
    assert_eq!(page2.items.len(), 2);
    assert!(!page2.has_more);

    let videos = assets::list(
        &conn,
        &AssetFilter {
            asset_type: Some("video".into()),
            ..Default::default()
        },
    )?;
    assert_eq!(videos.total, 1);

    let untagged = assets::list(
        &conn,
        &AssetFilter {
            untagged_only: true,
            ..Default::default()
        },
    )?;
    assert_eq!(untagged.total, 6);

    // 标签连带筛选：父标签应捞出子标签素材
    let parent = tags::create(&conn, "风景", None)?;
    let child = tags::create(&conn, "海边", Some(parent.id))?;
    let pid = conn.query_row(
        "SELECT id FROM assets WHERE file_ext='jpg' LIMIT 1",
        [],
        |r| r.get::<_, i64>(0),
    )?;
    asset_tags::assign(&conn, &[pid], &[child.id], "manual")?;
    let filtered = assets::list(
        &conn,
        &AssetFilter {
            tag_id: Some(parent.id),
            ..Default::default()
        },
    )?;
    assert_eq!(filtered.total, 1);
    assert_eq!(filtered.items[0].tags.len(), 1);
    Ok(())
}

// ⑪ 设置读写回环 + 默认值
#[test]
fn settings_roundtrip() -> AppResult<()> {
    let conn = setup();
    let s = settings::get_settings(&conn)?;
    assert_eq!(s.theme, "system");
    assert_eq!(s.thumbnail_cache_mb, 2048);
    assert!(!s.ai.auto_tagging);
    let mut s2 = settings::Settings::default();
    s2.ai.profiles.push(settings::ApiProfile {
        id: "p1".into(),
        name: "中转 A".into(),
        api_mode: "openai".into(),
        kind: "cloud".into(),
        base_url: "https://api.example.com/v1".into(),
        api_key: "sk-test".into(),
        model: "qwen-vl-plus".into(),
    });
    s2.ai.active_profile = "p1".into();
    s2.theme = "dark".into();
    settings::save_settings(&conn, &s2)?;
    let got = settings::get_settings(&conn)?;
    let active = got.ai.active().expect("应有激活档案");
    assert_eq!(active.base_url, "https://api.example.com/v1");
    assert_eq!(active.name, "中转 A");
    assert_eq!(active.kind, "cloud");
    assert_eq!(got.theme, "dark");
    Ok(())
}

// ⑫ AI 确认流：确认才写 asset_tags + 来源标记 + 可被搜索
#[test]
fn ai_confirm_flow() -> AppResult<()> {
    let conn = setup();
    let id = add_asset(&conn, "d:/p/p1.jpg", "p1.jpg", "jpg", "image/jpeg");
    let batch = ai::create_batch(&conn, &[id], "cloud")?;
    assert_eq!(batch.total, 1);
    let sugg = ai::list_suggestions(&conn, batch.id)?.remove(0);
    assert_eq!(sugg.status, "pending");
    assert_eq!(sugg.asset_path, "d:/p/p1.jpg");

    // 未确认 → 未打标
    let before = assets::list(
        &conn,
        &AssetFilter {
            untagged_only: true,
            ..Default::default()
        },
    )?;
    assert_eq!(before.total, 1);

    let tags_map = ai::CategorizedTags::from([(
        "场景".to_string(),
        vec!["夜景".to_string(), "城市".to_string()],
    )]);
    ai::set_suggestion_tags(&conn, sugg.id, &tags_map)?;
    let item_count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM ai_suggestion_items WHERE suggestion_id = ?1",
        [sugg.id],
        |r| r.get(0),
    )?;
    assert_eq!(item_count, 2);
    ai::confirm_suggestion(&conn, sugg.id, &tags_map)?;
    // 分类=父标签：「场景」应为根标签，「夜景」挂其下
    let tree = tags::list_tree(&conn)?;
    let scene = tree
        .iter()
        .find(|n| n.tag.name == "场景")
        .expect("应有分类父标签");
    assert!(scene.children.iter().any(|c| c.tag.name == "夜景"));

    let after = assets::list(
        &conn,
        &AssetFilter {
            untagged_only: true,
            ..Default::default()
        },
    )?;
    assert_eq!(after.total, 0);
    // 确认后新标签可被检索
    assert_eq!(db::search::search_asset_ids(&conn, "夜景")?, vec![id]);
    // 来源标记
    let src: String = conn.query_row(
        "SELECT source FROM asset_tags WHERE asset_id = ?1",
        [id],
        |r| r.get(0),
    )?;
    assert_eq!(src, "ai_cloud");
    let b = ai::get_batch(&conn, batch.id)?;
    assert_eq!(b.confirmed, 1);
    Ok(())
}

// 阶段5 §8.2：应用重启/中断时，把遗留 processing 批次标记为 interrupted（可一键续跑）
#[test]
fn mark_interrupted_batches_flags_processing() -> AppResult<()> {
    let conn = setup();
    let asset = add_asset(&conn, "d:/p/x.jpg", "x.jpg", "jpg", "image/jpeg");
    let batch = ai::create_batch(&conn, &[asset], "cloud")?;
    // 模拟正在执行中
    ai::set_batch_status(&conn, batch.id, "processing")?;
    ai::mark_interrupted_batches(&conn)?;
    let b = ai::get_batch(&conn, batch.id)?;
    assert_eq!(b.status, "interrupted");
    // 再次调用幂等
    ai::mark_interrupted_batches(&conn)?;
    let b = ai::get_batch(&conn, batch.id)?;
    assert_eq!(b.status, "interrupted");
    // done 批次不受影响
    let done_batch = ai::create_batch(&conn, &[asset], "cloud")?;
    ai::set_batch_status(&conn, done_batch.id, "done")?;
    ai::mark_interrupted_batches(&conn)?;
    assert_eq!(ai::get_batch(&conn, done_batch.id)?.status, "done");
    Ok(())
}

// ⑬ 预置标签播种（幂等）
#[test]
fn seed_presets_idempotent() -> AppResult<()> {
    let conn = setup();
    tags::seed_presets(&conn)?;
    tags::seed_presets(&conn)?;
    let tree = tags::list_tree(&conn)?;
    assert!(tree.is_empty(), "新库不应自动创建旧版预置标签");
    Ok(())
}

#[test]
fn unused_legacy_presets_are_retired_but_used_ones_remain() -> AppResult<()> {
    let conn = setup();
    let unused = tags::create_in_facet(&conn, "风景", None, Some("scene"))?;
    conn.execute("UPDATE tags SET is_preset = 1 WHERE id = ?1", [unused.id])?;
    let asset = add_asset(
        &conn,
        "d:/p/used-preset.jpg",
        "used-preset.jpg",
        "jpg",
        "image/jpeg",
    );
    let used = tags::create_in_facet(&conn, "美食", None, Some("subject"))?;
    conn.execute("UPDATE tags SET is_preset = 1 WHERE id = ?1", [used.id])?;
    asset_tags::assign(&conn, &[asset], &[used.id], "manual")?;

    let changed = tags::retire_unused_presets(&conn)?;
    assert_eq!(changed, 1);
    let unused_status: String =
        conn.query_row("SELECT status FROM tags WHERE id = ?1", [unused.id], |r| {
            r.get(0)
        })?;
    let used_status: String =
        conn.query_row("SELECT status FROM tags WHERE id = ?1", [used.id], |r| {
            r.get(0)
        })?;
    assert_eq!(unused_status, "deprecated");
    assert_eq!(used_status, "active");
    Ok(())
}

// ⑭ 排序 + 多标签筛选（R-21）：taken_at 缺值排最后；all 模式逐标签 EXISTS
#[test]
fn sort_and_multi_tag_filter() -> AppResult<()> {
    let conn = setup();
    let a1 = add_asset(&conn, "d:/p/a1.jpg", "a1.jpg", "jpg", "image/jpeg");
    let a2 = add_asset(&conn, "d:/p/a2.jpg", "a2.jpg", "jpg", "image/jpeg");
    let a3 = add_asset(&conn, "d:/p/a3.jpg", "a3.jpg", "jpg", "image/jpeg");
    // a1 拍摄时间最早；a2 最晚；a3 无 taken_at（应排最后）
    assets::set_exif(
        &conn,
        a1,
        &assets::ExifPatch {
            taken_at: Some(1600000000000),
            ..Default::default()
        },
    )?;
    assets::set_exif(
        &conn,
        a2,
        &assets::ExifPatch {
            taken_at: Some(1650000000000),
            ..Default::default()
        },
    )?;
    let sorted = assets::list(
        &conn,
        &AssetFilter {
            sort_by: Some("taken_at".into()),
            sort_dir: Some("asc".into()),
            ..Default::default()
        },
    )?;
    let ids: Vec<i64> = sorted.items.iter().map(|a| a.id).collect();
    assert_eq!(ids, vec![a1, a2, a3], "taken_at 升序且缺值排最后");

    // 多标签：a1 挂双标签，a2 只挂其一
    let ta = tags::create(&conn, "风景", None)?;
    let tb = tags::create(&conn, "海边", None)?;
    asset_tags::assign(&conn, &[a1], &[ta.id, tb.id], "manual")?;
    asset_tags::assign(&conn, &[a2], &[ta.id], "manual")?;
    let all_mode = assets::list(
        &conn,
        &AssetFilter {
            tag_ids: vec![ta.id, tb.id],
            tags_mode: Some("all".into()),
            ..Default::default()
        },
    )?;
    assert_eq!(all_mode.total, 1);
    assert_eq!(all_mode.items[0].id, a1);
    let any_mode = assets::list(
        &conn,
        &AssetFilter {
            tag_ids: vec![ta.id, tb.id],
            ..Default::default()
        },
    )?;
    assert_eq!(any_mode.total, 2);
    Ok(())
}

// ⑮ 回收站（R-22）：软删隔离 + trash_only 查看 + 恢复 + 超期清单
#[test]
fn trash_soft_delete_restore() -> AppResult<()> {
    let conn = setup();
    let a1 = add_asset(&conn, "d:/p/a1.jpg", "a1.jpg", "jpg", "image/jpeg");
    let a2 = add_asset(&conn, "d:/p/a2.jpg", "a2.jpg", "jpg", "image/jpeg");
    assets::soft_delete(&conn, &[a1])?;

    // 默认列表不含已软删
    let normal = assets::list(&conn, &AssetFilter::default())?;
    assert_eq!(normal.total, 1);
    assert_eq!(normal.items[0].id, a2);
    // 回收站视图
    let trash = assets::list(
        &conn,
        &AssetFilter {
            trash_only: true,
            ..Default::default()
        },
    )?;
    assert_eq!(trash.total, 1);
    assert_eq!(trash.items[0].id, a1);
    // 恢复
    assert_eq!(assets::restore(&conn, &[a1])?, 1);
    assert_eq!(assets::list(&conn, &AssetFilter::default())?.total, 2);
    // 超期清单：刚软删的不超期；手工回拨 deleted_at 后应命中
    assert!(assets::list_expired_trash(&conn, 0)?.is_empty());
    assets::soft_delete(&conn, &[a1])?;
    conn.execute("UPDATE assets SET deleted_at = 1 WHERE id = ?1", [a1])?;
    let expired = assets::list_expired_trash(&conn, chrono::Utc::now().timestamp_millis())?;
    assert_eq!(expired.len(), 1);
    assert_eq!(expired[0].0, a1);
    Ok(())
}

// ⑯ 打标历史（R-25）：挂/摘写流水 + AI 确认带 batch_id + 批次撤销幂等
#[test]
fn tag_ops_record_and_undo() -> AppResult<()> {
    let conn = setup();
    let id = add_asset(&conn, "d:/p/p1.jpg", "p1.jpg", "jpg", "image/jpeg");
    // 手工挂摘写流水
    let t = tags::create(&conn, "海边", None)?;
    asset_tags::assign(&conn, &[id], &[t.id], "manual")?;
    asset_tags::remove(&conn, &[id], &[t.id])?;
    let ops = tag_ops::recent(&conn, 100)?;
    assert_eq!(ops.len(), 2);
    assert!(ops.iter().all(|o| o.batch_id.is_none()));

    // AI 确认流写 add 流水带 batch_id
    let batch = ai::create_batch(&conn, &[id], "cloud")?;
    let sugg = ai::list_suggestions(&conn, batch.id)?.remove(0);
    let tags_map = ai::CategorizedTags::from([("场景".to_string(), vec!["夜景".to_string()])]);
    ai::confirm_suggestion(&conn, sugg.id, &tags_map)?;
    let ai_ops = tag_ops::recent(&conn, 100)?;
    let add_op = ai_ops
        .iter()
        .find(|o| o.batch_id == Some(batch.id))
        .expect("确认应写带批次的流水");
    assert_eq!(add_op.op, "add");
    assert_eq!(add_op.actor, "ai_cloud");

    // 撤销：AI 标签被摘除；重复撤销幂等
    assert!(assets::get(&conn, id)?
        .tags
        .iter()
        .any(|tg| tg.name == "夜景"));
    let n = tag_ops::undo_batch(&conn, batch.id)?;
    assert!(n >= 1);
    assert!(!assets::get(&conn, id)?
        .tags
        .iter()
        .any(|tg| tg.name == "夜景"));
    assert_eq!(tag_ops::undo_batch(&conn, batch.id)?, 0);
    Ok(())
}

// D-6：AI 添加后手工确认，撤销 AI 批次不删除手工确认的标签
#[test]
fn undo_ai_batch_keeps_manual_confirmed_tag() -> AppResult<()> {
    let conn = setup();
    let id = add_asset(&conn, "d:/p/d6_1.jpg", "d6_1.jpg", "jpg", "image/jpeg");
    let batch = ai::create_batch(&conn, &[id], "cloud")?;
    let sug = ai::list_suggestions(&conn, batch.id)?.remove(0);
    let tags = ai::CategorizedTags::from([("subject".to_string(), vec!["杯子".to_string()])]);
    ai::confirm_suggestion(&conn, sug.id, &tags)?;
    // 手工确认同一标签 → 覆盖来源为 manual、清空 source_batch_id
    let t = tags::find_or_create_canonical(&conn, "subject", "杯子")?;
    asset_tags::assign(&conn, &[id], &[t], "manual")?;
    assert_eq!(
        tag_ops::undo_batch(&conn, batch.id)?,
        0,
        "AI 批次撤销不应删除手工确认的标签"
    );
    assert!(
        assets::get(&conn, id)?.tags.iter().any(|tg| tg.name == "杯子"),
        "手工确认的标签在撤销 AI 批次后应保留"
    );
    Ok(())
}

// D-6：AI 添加后手工删除再重新添加，撤销 AI 批次不删除重新添加的标签
#[test]
fn undo_ai_batch_keeps_manually_readded_tag() -> AppResult<()> {
    let conn = setup();
    let id = add_asset(&conn, "d:/p/d6_2.jpg", "d6_2.jpg", "jpg", "image/jpeg");
    let batch = ai::create_batch(&conn, &[id], "cloud")?;
    let sug = ai::list_suggestions(&conn, batch.id)?.remove(0);
    let tags = ai::CategorizedTags::from([("subject".to_string(), vec!["杯子".to_string()])]);
    ai::confirm_suggestion(&conn, sug.id, &tags)?;
    let t = tags::find_or_create_canonical(&conn, "subject", "杯子")?;
    // 手工删除后重新添加（走 manual，source_batch_id 应为 NULL）
    asset_tags::remove(&conn, &[id], &[t])?;
    asset_tags::assign(&conn, &[id], &[t], "manual")?;
    assert_eq!(
        tag_ops::undo_batch(&conn, batch.id)?,
        0,
        "撤销 AI 批次不应删除手工重新添加的标签"
    );
    assert!(
        assets::get(&conn, id)?.tags.iter().any(|tg| tg.name == "杯子"),
        "手工重新添加的标签在撤销 AI 批次后应保留"
    );
    Ok(())
}

// D-6：批次 A 添加、批次 B 对同一素材同一标签确认——当前单归属边界：A 撤销会删除该关联，
// B 没有自己的关联可恢复（INSERT OR IGNORE 不产生新行）。测试名写明预期语义。
#[test]
fn cross_batch_single_ownership_undo_a_removes_tag_shared_with_b() -> AppResult<()> {
    let conn = setup();
    let id = add_asset(&conn, "d:/p/d6_3.jpg", "d6_3.jpg", "jpg", "image/jpeg");
    let batch_a = ai::create_batch(&conn, &[id], "cloud")?;
    let sug_a = ai::list_suggestions(&conn, batch_a.id)?.remove(0);
    let tags = ai::CategorizedTags::from([("subject".to_string(), vec!["杯子".to_string()])]);
    ai::confirm_suggestion(&conn, sug_a.id, &tags)?;

    // 批次 B 确认同一素材同一标签（INSERT OR IGNORE 不产生新的关联行）
    let batch_b = ai::create_batch(&conn, &[id], "cloud")?;
    let sug_b = ai::list_suggestions(&conn, batch_b.id)?.remove(0);
    ai::confirm_suggestion(&conn, sug_b.id, &tags)?;
    let at_rows: i64 = conn.query_row("SELECT COUNT(*) FROM asset_tags", [], |r| r.get(0))?;
    assert_eq!(at_rows, 1, "单归属：同一关联只有一行");

    // 撤销批次 A → 删除该唯一关联（B 无自己的关联可恢复）
    assert!(tag_ops::undo_batch(&conn, batch_a.id)? >= 1);
    assert!(
        !assets::get(&conn, id)?.tags.iter().any(|tg| tg.name == "杯子"),
        "单归属边界：撤销 A 删除共享的同一关联（B 已确认但无独立关联）"
    );
    // B 的确认计数不受影响（历史事实保留，不把 confused 计数伪装成 0）
    let b_after = ai::get_batch(&conn, batch_b.id)?;
    assert_eq!(b_after.confirmed, 1, "撤销 A 不应改动 B 的 confirmed 历史计数");
    Ok(())
}

// D-6：remove 流水撤销后重新插入的关联 source_batch_id 为 NULL（恢复的关联不再属于被撤销批次）
#[test]
fn undo_remove_op_reinserts_with_null_source_batch() -> AppResult<()> {
    let conn = setup();
    let id = add_asset(&conn, "d:/p/d6_4.jpg", "d6_4.jpg", "jpg", "image/jpeg");
    let t = tags::create(&conn, "海边", None)?;
    // 直接构造：往某批次插入一条 remove 流水（手工移除过该关联），随后撤销该批次
    asset_tags::assign(&conn, &[id], &[t.id], "manual")?;
    asset_tags::remove(&conn, &[id], &[t.id])?; // 写 remove 流水（batch None）
    let last_remove_id: i64 = conn.query_row("SELECT MAX(id) FROM tag_ops", [], |r| r.get(0))?;
    // 把这条 remove 流水关联到一个批次，使其可被该批次撤销
    let batch = ai::create_batch(&conn, &[id], "cloud")?;
    conn.execute(
        "UPDATE tag_ops SET batch_id = ?1 WHERE id = ?2",
        rusqlite::params![batch.id, last_remove_id],
    )?;
    assert!(tag_ops::undo_batch(&conn, batch.id)? >= 1);
    let batch_null: Option<i64> = conn.query_row(
        "SELECT source_batch_id FROM asset_tags WHERE asset_id = ?1 AND tag_id = ?2",
        rusqlite::params![id, t.id],
        |r| r.get(0),
    )?;
    assert!(
        batch_null.is_none(),
        "remove 恢复的关联 source_batch_id 应为 NULL（不再属于被撤销批次）"
    );
    Ok(())
}

// ⑯ v6：单条打标失败原因落库（last_error）可回读——本地打标错误详情的存储侧验证
#[test]
fn suggestion_last_error_roundtrip() -> AppResult<()> {
    let conn = setup();
    let id = add_asset(&conn, "d:/p/p2.jpg", "p2.jpg", "jpg", "image/jpeg");
    let batch = ai::create_batch(&conn, &[id], "local")?;
    let sugg = ai::list_suggestions(&conn, batch.id)?.remove(0);
    // 初始无错误
    assert!(sugg.last_error.is_none());
    // 失败 → set_suggestion_error + reject
    ai::set_suggestion_error(
        &conn,
        sugg.id,
        "模型未返回可解析的标签（原始返回：我无法查看图片）",
    )?;
    ai::reject_suggestion(&conn, sugg.id)?;
    let rej = ai::list_suggestions(&conn, batch.id)?.remove(0);
    assert_eq!(rej.status, "rejected");
    assert!(rej
        .last_error
        .as_deref()
        .unwrap_or("")
        .contains("未返回可解析"));
    Ok(())
}

#[test]
fn canonical_tag_governance_and_deactivation() -> AppResult<()> {
    let conn = setup();
    let asset = add_asset(&conn, "d:/p/gov.jpg", "gov.jpg", "jpg", "image/jpeg");
    let t = tags::find_or_create_canonical(&conn, "subject", "咖啡")?;
    asset_tags::assign(&conn, &[asset], &[t], "manual")?;
    let same = tags::find_or_create_canonical(&conn, "subject", " 咖啡 ")?;
    assert_eq!(same, t);
    assert!(tags::governance(&conn)?.iter().any(|g| {
        g.facet_key == "subject" && g.active_tag_count >= 1 && g.linked_asset_count >= 1
    }));
    tags::deactivate(&conn, t)?;
    assert!(tags::search_candidates(&conn, Some("subject"), "咖啡")?.is_empty());
    let links: i64 = conn.query_row("SELECT COUNT(*) FROM asset_tags", [], |r| r.get(0))?;
    assert_eq!(links, 1);
    Ok(())
}

#[test]
fn ai_suggestion_item_decision_and_final_mapping() -> AppResult<()> {
    let conn = setup();
    let asset = add_asset(
        &conn,
        "d:/p/decision.jpg",
        "decision.jpg",
        "jpg",
        "image/jpeg",
    );
    let batch = ai::create_batch(&conn, &[asset], "cloud")?;
    let suggestion = ai::list_suggestions(&conn, batch.id)?.remove(0);
    let tags = ai::CategorizedTags::from([("subject".to_string(), vec!["杯子".to_string()])]);
    ai::set_suggestion_tags(&conn, suggestion.id, &tags)?;
    let item = ai::list_suggestion_items(&conn, suggestion.id)?.remove(0);
    assert!(item.tag_id.is_none());
    let canonical = tags::find_or_create_canonical(&conn, "subject", "杯子")?;
    ai::decide_suggestion_item(
        &conn,
        item.id,
        "accepted",
        Some(canonical),
        None,
        Some("规范化"),
    )?;
    ai::confirm_suggestion(&conn, suggestion.id, &tags)?;
    let final_item = ai::list_suggestion_items(&conn, suggestion.id)?.remove(0);
    assert_eq!(final_item.tag_id, Some(canonical));
    assert_eq!(final_item.decision, "accepted");
    assert!(assets::get(&conn, asset)?
        .tags
        .iter()
        .any(|t| t.id == canonical));
    Ok(())
}

#[test]
fn cross_facet_merge_is_rejected() -> AppResult<()> {
    let conn = setup();
    let subject = tags::find_or_create_canonical(&conn, "subject", "主体")?;
    let scene = tags::find_or_create_canonical(&conn, "scene", "主体")?;
    assert!(tags::merge_preserve_alias(&conn, subject, scene).is_err());
    Ok(())
}

#[test]
fn alias_conflict_is_rejected() -> AppResult<()> {
    let conn = setup();
    let a = tags::find_or_create_canonical(&conn, "subject", "猫")?;
    let b = tags::find_or_create_canonical(&conn, "subject", "小猫")?;
    tags::add_alias(&conn, a, "cat", Some("en"), "translation")?;
    assert!(tags::add_alias(&conn, b, "CAT", Some("en"), "translation").is_err());
    Ok(())
}

#[test]
fn tag_facets_aliases_and_canonical_search() -> AppResult<()> {
    let conn = setup();
    let facets = db::tag_facets::list(&conn)?;
    assert!(facets.iter().any(|f| f.key == "subject"));
    assert!(facets.iter().any(|f| f.key == "scene"));

    let root = tags::find_or_create_facet_root(&conn, "subject", "主体/对象")?;
    let tea = tags::create_in_facet(&conn, "茶", Some(root), Some("subject"))?;
    tags::add_alias(&conn, tea.id, "茶叶", Some("zh-CN"), "synonym")?;
    let id = add_asset(&conn, "d:/p/tea.jpg", "tea.jpg", "jpg", "image/jpeg");
    asset_tags::assign(&conn, &[id], &[tea.id], "manual")?;

    assert_eq!(db::search::search_asset_ids(&conn, "茶叶")?, vec![id]);
    let candidates = tags::search_candidates(&conn, Some("subject"), "茶叶")?;
    assert_eq!(candidates.len(), 1);
    assert_eq!(candidates[0].id, tea.id);

    tags::update_preserve_alias(&conn, tea.id, Some("茶饮"), None)?;
    assert_eq!(db::search::search_asset_ids(&conn, "茶")?, vec![id]);
    assert!(tags::aliases(&conn, tea.id)?.iter().any(|a| a == "茶"));
    Ok(())
}

#[test]
fn facet_filter_any_all_and_exclude() -> AppResult<()> {
    let conn = setup();
    let subject = tags::find_or_create_facet_root(&conn, "subject", "主体/对象")?;
    let scene = tags::find_or_create_facet_root(&conn, "scene", "场景/地点")?;
    let tea = tags::create_in_facet(&conn, "茶", Some(subject), Some("subject"))?;
    let coffee = tags::create_in_facet(&conn, "咖啡", Some(subject), Some("subject"))?;
    let room = tags::create_in_facet(&conn, "室内", Some(scene), Some("scene"))?;
    let a1 = add_asset(&conn, "d:/p/a1.jpg", "a1.jpg", "jpg", "image/jpeg");
    let a2 = add_asset(&conn, "d:/p/a2.jpg", "a2.jpg", "jpg", "image/jpeg");
    asset_tags::assign(&conn, &[a1], &[tea.id, room.id], "manual")?;
    asset_tags::assign(&conn, &[a2], &[coffee.id, room.id], "manual")?;

    let filtered = assets::list(
        &conn,
        &AssetFilter {
            facet_filters: vec![
                assets::FacetTagFilter {
                    facet_key: "subject".into(),
                    tag_ids: vec![tea.id],
                    mode: Some("any".into()),
                    include_descendants: true,
                },
                assets::FacetTagFilter {
                    facet_key: "scene".into(),
                    tag_ids: vec![room.id],
                    mode: Some("all".into()),
                    include_descendants: true,
                },
            ],
            ..Default::default()
        },
    )?;
    assert_eq!(
        filtered.items.iter().map(|a| a.id).collect::<Vec<_>>(),
        vec![a1]
    );

    let excluded = assets::list(
        &conn,
        &AssetFilter {
            exclude_tag_ids: vec![tea.id],
            ..Default::default()
        },
    )?;
    assert!(!excluded.items.iter().any(|a| a.id == a1));
    assert!(excluded.items.iter().any(|a| a.id == a2));
    Ok(())
}

#[test]
fn metadata_facets_cover_folders_images_and_videos() -> AppResult<()> {
    let conn = setup();
    let image = add_asset(
        &conn,
        "d:/library/旅行/上海/photo.jpg",
        "photo.jpg",
        "jpg",
        "image/jpeg",
    );
    let video = add_asset(
        &conn,
        "d:/library/视频/clip.mp4",
        "clip.mp4",
        "mp4",
        "video/mp4",
    );
    conn.execute(
        "UPDATE assets SET width=4000, height=3000, camera='Test Camera', file_size=5242880 WHERE id=?1",
        [image],
    )?;
    conn.execute(
        "UPDATE assets SET width=1920, height=1080, duration_ms=75000, video_codec='h264', audio_codec='aac', file_size=52428800 WHERE id=?1",
        [video],
    )?;

    let facets = assets::list_metadata_facets(&conn, Some("d:/library"))?;
    let folders = facets
        .iter()
        .find(|facet| facet.key == "folder")
        .expect("应有文件夹分面");
    assert!(folders.items.iter().any(|item| item.label == "旅行/上海"));
    assert!(folders.items.iter().any(|item| item.label == "视频"));
    assert!(facets.iter().any(|facet| facet.key == "camera"));
    assert!(facets.iter().any(|facet| facet.key == "duration"));
    assert!(facets.iter().any(|facet| facet.key == "video_codec"));

    let folder_filtered = assets::list(
        &conn,
        &AssetFilter {
            metadata_filters: vec![assets::MetadataFilter {
                key: "folder".into(),
                op: "eq".into(),
                value: Some("d:/library/旅行".into()),
                values: None,
                min: None,
                max: None,
            }],
            ..Default::default()
        },
    )?;
    assert_eq!(
        folder_filtered
            .items
            .iter()
            .map(|asset| asset.id)
            .collect::<Vec<_>>(),
        vec![image]
    );

    let video_filtered = assets::list(
        &conn,
        &AssetFilter {
            metadata_filters: vec![
                assets::MetadataFilter {
                    key: "duration_ms".into(),
                    op: "between".into(),
                    value: None,
                    values: None,
                    min: Some(60000.into()),
                    max: Some(300000.into()),
                },
                assets::MetadataFilter {
                    key: "video_codec".into(),
                    op: "eq".into(),
                    value: Some("h264".into()),
                    values: None,
                    min: None,
                    max: None,
                },
            ],
            ..Default::default()
        },
    )?;
    assert_eq!(
        video_filtered
            .items
            .iter()
            .map(|asset| asset.id)
            .collect::<Vec<_>>(),
        vec![video]
    );
    Ok(())
}

// ⑰ P1A：元数据比较操作（数值/字符串/日期/分辨率/宽高比/NULL 排除/非法回退）
#[test]
fn metadata_comparison_operators() -> AppResult<()> {
    let conn = setup();
    // 大图：4000x3000 = 1200 万像素，camera=Sony，taken_at=2025-05-01
    let big = add_asset(&conn, "d:/p/big.jpg", "big.jpg", "jpg", "image/jpeg");
    conn.execute(
        "UPDATE assets SET width=4000, height=3000, camera='Sony', file_size=5242880,
                taken_at=1746057600000 WHERE id=?1",
        [big],
    )?;
    // 小图：1000x800，camera=Canon，无 taken_at
    let small = add_asset(&conn, "d:/p/small.jpg", "small.jpg", "jpg", "image/jpeg");
    conn.execute(
        "UPDATE assets SET width=1000, height=800, camera='Canon', file_size=1048576 WHERE id=?1",
        [small],
    )?;
    // 视频：1920x1080，duration 90s
    let video = add_asset(&conn, "d:/p/video.mp4", "video.mp4", "mp4", "video/mp4");
    conn.execute(
        "UPDATE assets SET width=1920, height=1080, duration_ms=90000, file_size=52428800 WHERE id=?1",
        [video],
    )?;

    let mf = |key: &str, op: &str, value: serde_json::Value| assets::MetadataFilter {
        key: key.into(),
        op: op.into(),
        value: Some(value),
        values: None,
        min: None,
        max: None,
    };
    let between =
        |key: &str, min: serde_json::Value, max: serde_json::Value| assets::MetadataFilter {
            key: key.into(),
            op: "between".into(),
            value: None,
            values: None,
            min: Some(min),
            max: Some(max),
        };
    let ids = |page: assets::AssetPage| {
        let mut v = page.items.iter().map(|a| a.id).collect::<Vec<_>>();
        v.sort();
        v
    };

    // file_size >= 5MB -> big(5MB) + video(50MB)
    let r = assets::list(
        &conn,
        &AssetFilter {
            metadata_filters: vec![mf("file_size", "gte", 5242880.into())],
            ..Default::default()
        },
    )?;
    assert_eq!(ids(r), vec![big, video]);

    // camera contains "son" -> Sony (大小写不敏感？contains 用原列，不 lower，仅 substring)
    let r = assets::list(
        &conn,
        &AssetFilter {
            metadata_filters: vec![mf("camera", "contains", "Sony".into())],
            ..Default::default()
        },
    )?;
    assert_eq!(ids(r), vec![big]);

    // camera in [Canon] -> small
    let r = assets::list(
        &conn,
        &AssetFilter {
            metadata_filters: vec![assets::MetadataFilter {
                key: "camera".into(),
                op: "in".into(),
                value: None,
                values: Some(vec!["Canon".into()]),
                min: None,
                max: None,
            }],
            ..Default::default()
        },
    )?;
    assert_eq!(ids(r), vec![small]);

    // resolution gte 10000000 (10MP) -> big only
    let r = assets::list(
        &conn,
        &AssetFilter {
            metadata_filters: vec![mf("resolution", "gte", 10000000.into())],
            ..Default::default()
        },
    )?;
    assert_eq!(ids(r), vec![big]);

    // duration_ms between 60000..120000 -> video
    let r = assets::list(
        &conn,
        &AssetFilter {
            metadata_filters: vec![between("duration_ms", 60000.into(), 120000.into())],
            ..Default::default()
        },
    )?;
    assert_eq!(ids(r), vec![video]);

    // taken_at between 2025-01-01 .. 2025-12-31（左闭右开）-> big 仅
    let r = assets::list(
        &conn,
        &AssetFilter {
            metadata_filters: vec![assets::MetadataFilter {
                key: "taken_at".into(),
                op: "between".into(),
                value: None,
                values: None,
                min: Some("2025-01-01".into()),
                max: Some("2025-12-31".into()),
            }],
            ..Default::default()
        },
    )?;
    assert_eq!(ids(r), vec![big]);

    // NULL 排除：taken_at gte 2020-01-01 不应命中无 taken_at 的 small
    let r = assets::list(
        &conn,
        &AssetFilter {
            metadata_filters: vec![mf("taken_at", "gte", "2020-01-01".into())],
            ..Default::default()
        },
    )?;
    assert_eq!(ids(r), vec![big]);

    // 非法 key → validate 拒绝
    let bad = AssetFilter {
        metadata_filters: vec![mf("nonexistent_key", "eq", "x".into())],
        ..Default::default()
    };
    assert!(assets::list(&conn, &bad).is_err());

    // 非法 op → validate 拒绝
    let bad = AssetFilter {
        metadata_filters: vec![mf("file_size", "prefix", 1.into())],
        ..Default::default()
    };
    assert!(assets::list(&conn, &bad).is_err());

    // between 缺 max → 拒绝
    let bad = AssetFilter {
        metadata_filters: vec![assets::MetadataFilter {
            key: "file_size".into(),
            op: "between".into(),
            value: None,
            values: None,
            min: Some(1.into()),
            max: None,
        }],
        ..Default::default()
    };
    assert!(assets::list(&conn, &bad).is_err());

    // in 空 values → 拒绝
    let bad = AssetFilter {
        metadata_filters: vec![assets::MetadataFilter {
            key: "camera".into(),
            op: "in".into(),
            value: None,
            values: Some(vec![]),
            min: None,
            max: None,
        }],
        ..Default::default()
    };
    assert!(assets::list(&conn, &bad).is_err());
    Ok(())
}

// ⑰b P0-2：数值分面支持 `in`（同时接受数字字符串），保证普通素材库点击 ISO/光圈/焦距分面不回归。
#[test]
fn metadata_numeric_in_facet() -> AppResult<()> {
    let conn = setup();
    // 大图：ISO 800 / f/2.8；小图：ISO 100 / f/5.6；none：无 ISO / aperture
    let big = add_asset(&conn, "d:/p/big.jpg", "big.jpg", "jpg", "image/jpeg");
    conn.execute(
        "UPDATE assets SET width=4000, height=3000, iso=800, aperture=2.8, file_size=5242880 WHERE id=?1",
        [big],
    )?;
    let small = add_asset(&conn, "d:/p/small.jpg", "small.jpg", "jpg", "image/jpeg");
    conn.execute(
        "UPDATE assets SET width=1000, height=800, iso=100, aperture=5.6, file_size=1048576 WHERE id=?1",
        [small],
    )?;
    let none = add_asset(&conn, "d:/p/none.jpg", "none.jpg", "jpg", "image/jpeg");

    let in_filter = |key: &str, values: Vec<serde_json::Value>| assets::MetadataFilter {
        key: key.into(),
        op: "in".into(),
        value: None,
        values: Some(values),
        min: None,
        max: None,
    };
    let mf = |key: &str, op: &str, value: serde_json::Value| assets::MetadataFilter {
        key: key.into(),
        op: op.into(),
        value: Some(value),
        values: None,
        min: None,
        max: None,
    };
    let ids = |page: assets::AssetPage| {
        let mut v = page.items.iter().map(|a| a.id).collect::<Vec<_>>();
        v.sort();
        v
    };

    // iso in ["800", "1600"]（数字字符串）→ 仅 big
    let r = assets::list(
        &conn,
        &AssetFilter {
            metadata_filters: vec![in_filter("iso", vec!["800".into(), "1600".into()])],
            ..Default::default()
        },
    )?;
    assert_eq!(ids(r), vec![big]);

    // iso in [100, 800]（JSON number）→ big + small
    let r = assets::list(
        &conn,
        &AssetFilter {
            metadata_filters: vec![in_filter("iso", vec![100.into(), 800.into()])],
            ..Default::default()
        },
    )?;
    assert_eq!(ids(r), vec![big, small]);

    // iso eq 800 → 仅 big
    let r = assets::list(
        &conn,
        &AssetFilter {
            metadata_filters: vec![mf("iso", "eq", 800.into())],
            ..Default::default()
        },
    )?;
    assert_eq!(ids(r), vec![big]);

    // aperture gte 2.8（数字字符串）→ big(2.8) + small(5.6)
    let r = assets::list(
        &conn,
        &AssetFilter {
            metadata_filters: vec![mf("aperture", "gte", "2.8".into())],
            ..Default::default()
        },
    )?;
    assert_eq!(ids(r), vec![big, small]);

    // aperture gte 4.0 → 仅 small
    let r = assets::list(
        &conn,
        &AssetFilter {
            metadata_filters: vec![mf("aperture", "gte", 4.0.into())],
            ..Default::default()
        },
    )?;
    assert_eq!(ids(r), vec![small]);

    // 非数字字符串 → 明确错误
    let bad = AssetFilter {
        metadata_filters: vec![in_filter("iso", vec!["abc".into()])],
        ..Default::default()
    };
    assert!(assets::list(&conn, &bad).is_err());

    // NULL 数值不命中（none 无 ISO，靠 IS NOT NULL 守卫排除）
    let r = assets::list(
        &conn,
        &AssetFilter {
            metadata_filters: vec![in_filter("iso", vec![100.into(), 800.into()])],
            ..Default::default()
        },
    )?;
    assert_eq!(ids(r), vec![big, small]);
    let _ = none;

    // 普通素材库 metadata facet 点击后查询成功：list_metadata_facets 返回 iso 分面，
    // 把 facet item 的 value（字符串）转成 in 查询，不报错且命中。
    let facets = assets::list_metadata_facets(&conn, None)?;
    let iso_facet = facets
        .iter()
        .find(|f| f.key == "iso")
        .expect("存在 iso 分面");
    assert!(!iso_facet.items.is_empty());
    let iso_vals = iso_facet
        .items
        .iter()
        .map(|it| it.value.clone())
        .collect::<Vec<_>>();
    let r = assets::list(
        &conn,
        &AssetFilter {
            metadata_filters: vec![in_filter("iso", iso_vals.into_iter().map(|v| v.into()).collect())],
            ..Default::default()
        },
    )?;
    assert!(r.items.iter().any(|a| a.id == big || a.id == small));
    Ok(())
}

// ⑱ P1B：V10 迁移——旧 tag_categories 转 ai_facet_configs 并落库（幂等）
#[test]
fn v10_migrates_legacy_tag_categories_to_facet_configs() -> AppResult<()> {
    let conn = setup();
    // 设置写入旧格式 tag_categories（含中文分类名）
    let legacy = serde_json::json!({
        "theme": "dark",
        "thumbnailCacheMb": 1024,
        "tagCategories": [
            {"name":"场景","hint":"如公园/街道","single":true,"max":1},
            {"name":"未知分类","hint":"保留","single":false,"max":3}
        ],
        "libraryRoot": "",
        "trashRetentionDays": 30
    });
    conn.execute(
        "INSERT INTO settings (key, value) VALUES ('app_settings', ?1)",
        [legacy.to_string()],
    )?;

    // 回退 user_version 触发 V10
    conn.pragma_update(None, "user_version", 9)?;
    migrations::migrate(&conn)?;

    let s = settings::get_settings(&conn)?;
    assert!(s.tag_categories.is_empty(), "旧分类应被清空");
    let scene = s
        .ai_facet_configs
        .iter()
        .find(|c| c.facet_key == "scene")
        .expect("场景应映射为 scene");
    assert_eq!(scene.hint, "如公园/街道");
    assert!(scene.enabled_for_ai);
    assert!(
        s.ai_facet_configs.iter().any(|c| c.facet_key == "custom"),
        "未知分类应归 custom"
    );
    // 其他设置字段不丢失
    assert_eq!(s.theme, "dark");
    assert_eq!(s.thumbnail_cache_mb, 1024);
    assert_eq!(s.trash_retention_days, 30);

    // 幂等：再次迁移不重复配置
    conn.pragma_update(None, "user_version", 9)?;
    migrations::migrate(&conn)?;
    let s2 = settings::get_settings(&conn)?;
    assert_eq!(s2.ai_facet_configs.len(), s.ai_facet_configs.len());
    Ok(())
}

// C-5/V11：存量库补齐独立 color 分面（tag_facets 行 + ai_facet_configs 配置），幂等
#[test]
fn v11_adds_color_facet_to_existing_settings() -> AppResult<()> {
    let conn = setup();
    // 模拟存量库：settings 只有 scene 配置、缺 color；tag_facets 缺 color 行
    let legacy = serde_json::json!({
        "ai": { "profiles": [], "activeProfile": "" },
        "theme": "system",
        "aiFacetConfigs": [{"facetKey":"scene","hint":"如房间","enabledForAi":true}]
    });
    conn.execute(
        "INSERT INTO settings (key, value) VALUES ('app_settings', ?1)",
        [legacy.to_string()],
    )?;
    // 删除 color tag_facets 行（模拟老库可能确实缺），回退 user_version 触发 V11
    conn.execute("DELETE FROM tag_facets WHERE key = 'color'", [])?;
    conn.pragma_update(None, "user_version", 10)?;
    migrations::migrate(&conn)?;

    // tag_facets 补齐 color
    let facets = db::tag_facets::list(&conn)?;
    assert!(
        facets.iter().any(|f| f.key == "color"),
        "tag_facets 应补齐 color 分面"
    );
    // settings 的 ai_facet_configs 补齐 color（不覆盖已有 scene）
    let s = settings::get_settings(&conn)?;
    let scene = s.ai_facet_configs.iter().find(|c| c.facet_key == "scene").expect("scene 保留");
    assert_eq!(scene.hint, "如房间");
    assert!(
        s.ai_facet_configs.iter().any(|c| c.facet_key == "color"),
        "ai_facet_configs 应补齐 color 配置"
    );

    // 幂等：再跑一次不重复插入
    conn.pragma_update(None, "user_version", 10)?;
    migrations::migrate(&conn)?;
    let s2 = settings::get_settings(&conn)?;
    assert_eq!(s2.ai_facet_configs.len(), s.ai_facet_configs.len());
    Ok(())
}

// 阶段6 §9.7：AI 打标与 AI 超级搜索共用同一 FacetPromptContext——
// build_prompt_context 反映 aiFacetConfig 的 hint/displayName 覆盖（改 hint 两边同步读新值），显示名改变不影响 facet_key
#[test]
fn prompt_context_reflects_facet_config_overrides() -> AppResult<()> {
    let conn = setup();
    let cfg = vec![bagertea_ai_media_v2_lib::db::settings::AiFacetConfig {
        facet_key: "scene".into(),
        hint: "识别拍摄场景".into(),
        enabled_for_ai: true,
        display_name: Some("场景".into()),
        visible_in_workbench: None,
    }];
    let ctx = db::tag_facets::build_prompt_context(&conn, &cfg)?;
    let scene = ctx.iter().find(|c| c.key == "scene").expect("存在 scene 分面");
    assert_eq!(scene.hint, "识别拍摄场景");
    assert_eq!(scene.display_name, "场景", "显示名覆盖生效");
    assert_eq!(scene.key, "scene", "显示名改变不影响 facetKey");
    Ok(())
}

// ⑲ P4：布尔表达式树——(含 A 或 含 B) 且 非C 的嵌套查询
use bagertea_ai_media_v2_lib::db::query_expr::{LeafCond, QueryExpr};

#[test]
fn expr_nested_and_or_not_query() -> AppResult<()> {
    let conn = setup();
    // 素材：a1 挂「海边」，a2 挂「沙滩」，a3 挂「海边 + 夜景」
    let a1 = add_asset(&conn, "d:/p/a1.jpg", "a1.jpg", "jpg", "image/jpeg");
    let a2 = add_asset(&conn, "d:/p/a2.jpg", "a2.jpg", "jpg", "image/jpeg");
    let a3 = add_asset(&conn, "d:/p/a3.jpg", "a3.jpg", "jpg", "image/jpeg");
    let sea = tags::find_or_create_canonical(&conn, "scene", "海边")?;
    let beach = tags::find_or_create_canonical(&conn, "scene", "沙滩")?;
    let night = tags::find_or_create_canonical(&conn, "lighting", "夜景")?;
    asset_tags::assign(&conn, &[a1, a3], &[sea], "manual")?;
    asset_tags::assign(&conn, &[a2], &[beach], "manual")?;
    asset_tags::assign(&conn, &[a3], &[night], "manual")?;

    // (含「海边」或含「沙滩」) 且 NOT 含「夜景」
    let expr = QueryExpr::And {
        children: vec![
            QueryExpr::Or {
                children: vec![
                    QueryExpr::Leaf {
                        cond: LeafCond::Tag {
                            facet_key: "scene".into(),
                            tag_ids: vec![sea],
                            mode: Some("any".into()),
                            include_descendants: true,
                        },
                    },
                    QueryExpr::Leaf {
                        cond: LeafCond::Tag {
                            facet_key: "scene".into(),
                            tag_ids: vec![beach],
                            mode: Some("any".into()),
                            include_descendants: true,
                        },
                    },
                ],
            },
            QueryExpr::Not {
                child: Box::new(QueryExpr::Leaf {
                    cond: LeafCond::Tag {
                        facet_key: "lighting".into(),
                        tag_ids: vec![night],
                        mode: Some("any".into()),
                        include_descendants: true,
                    },
                }),
            },
        ],
    };
    let page = assets::list(
        &conn,
        &AssetFilter {
            expr: Some(expr),
            ..Default::default()
        },
    )?;
    let mut ids = page.items.iter().map(|a| a.id).collect::<Vec<_>>();
    ids.sort();
    // 期望命中 a1（海边且非夜景）与 a2（沙滩且非夜景）；排除 a3（含夜景）
    assert_eq!(ids, vec![a1, a2]);
    Ok(())
}

#[test]
fn expr_metadata_combined_with_tag() -> AppResult<()> {
    let conn = setup();
    let a1 = add_asset(&conn, "d:/p/a1.jpg", "a1.jpg", "jpg", "image/jpeg");
    let a2 = add_asset(&conn, "d:/p/a2.jpg", "a2.jpg", "jpg", "image/jpeg");
    conn.execute("UPDATE assets SET file_size=5242880 WHERE id=?1", [a1])?;
    conn.execute("UPDATE assets SET file_size=1048576 WHERE id=?1", [a2])?;
    let sea = tags::find_or_create_canonical(&conn, "scene", "海边")?;
    asset_tags::assign(&conn, &[a1, a2], &[sea], "manual")?;

    // 含「海边」且 file_size>=5MB（只 a1）
    let expr = QueryExpr::And {
        children: vec![
            QueryExpr::Leaf {
                cond: LeafCond::Tag {
                    facet_key: "scene".into(),
                    tag_ids: vec![sea],
                    mode: Some("any".into()),
                    include_descendants: true,
                },
            },
            QueryExpr::Leaf {
                cond: LeafCond::Metadata {
                    filter: bagertea_ai_media_v2_lib::db::search_query::MetadataFilter {
                        key: "file_size".into(),
                        op: "gte".into(),
                        value: Some(5242880.into()),
                        values: None,
                        min: None,
                        max: None,
                    },
                },
            },
        ],
    };
    let page = assets::list(
        &conn,
        &AssetFilter {
            expr: Some(expr),
            ..Default::default()
        },
    )?;
    assert_eq!(
        page.items.iter().map(|a| a.id).collect::<Vec<_>>(),
        vec![a1]
    );
    Ok(())
}

#[test]
fn expr_invalid_rejected_by_validate() -> AppResult<()> {
    let conn = setup();
    add_asset(&conn, "d:/p/a.jpg", "a.jpg", "jpg", "image/jpeg");
    // 空 Or 组 → validate 拒绝
    let bad = AssetFilter {
        expr: Some(QueryExpr::Or { children: vec![] }),
        ..Default::default()
    };
    assert!(assets::list(&conn, &bad).is_err());
    // 未知分面标签 → tag_ids 空拒绝
    let bad2 = AssetFilter {
        expr: Some(QueryExpr::Leaf {
            cond: LeafCond::Tag {
                facet_key: "scene".into(),
                tag_ids: vec![],
                mode: Some("any".into()),
                include_descendants: true,
            },
        }),
        ..Default::default()
    };
    assert!(assets::list(&conn, &bad2).is_err());
    Ok(())
}
