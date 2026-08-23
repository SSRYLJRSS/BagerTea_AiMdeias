//! T02 验收测试：迁移/触发器/搜索/标签树/分页/设置/AI 确认流
//! 运行：cargo test

use bagertea_ai_media_v2_lib::db::assets::AssetFilter;
use bagertea_ai_media_v2_lib::db::{self, ai, asset_tags, assets, dedup, settings, tag_ops, tags};
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

// ⑬ 预置标签播种（幂等）
#[test]
fn seed_presets_idempotent() -> AppResult<()> {
    let conn = setup();
    tags::seed_presets(&conn)?;
    tags::seed_presets(&conn)?;
    let tree = tags::list_tree(&conn)?;
    assert_eq!(tree.len(), 9);
    assert!(tree.iter().all(|n| n.tag.is_preset));
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
    ai::set_suggestion_error(&conn, sugg.id, "模型未返回可解析的标签（原始返回：我无法查看图片）")?;
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
