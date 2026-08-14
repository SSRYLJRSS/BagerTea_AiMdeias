//! T02 验收测试：迁移/触发器/搜索/标签树/分页/设置/AI 确认流
//! 运行：cargo test

use bagertea_ai_media_v2_lib::db::{self, ai, asset_tags, assets, settings, tags};
use bagertea_ai_media_v2_lib::db::assets::AssetFilter;
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
    let id = add_asset(&conn, "d:/p/海边日落.jpg", "海边日落.jpg", "jpg", "image/jpeg");
    let ids = db::search::search_asset_ids(&conn, "海边日落")?;
    assert_eq!(ids, vec![id]);
    Ok(())
}

// ② 词中子串可查：「日落」命中「海边日落.jpg」
#[test]
fn fts_substring_hit() -> AppResult<()> {
    let conn = setup();
    let id = add_asset(&conn, "d:/p/海边日落.jpg", "海边日落.jpg", "jpg", "image/jpeg");
    assert_eq!(db::search::search_asset_ids(&conn, "日落")?, vec![id]);
    Ok(())
}

// ③ 短语精确性：搜「海边」不得命中「上海公园湖边合影.jpg」
#[test]
fn fts_phrase_no_false_positive() -> AppResult<()> {
    let conn = setup();
    let hit = add_asset(&conn, "d:/p/海边日落.jpg", "海边日落.jpg", "jpg", "image/jpeg");
    add_asset(&conn, "d:/p/上海公园湖边合影.jpg", "上海公园湖边合影.jpg", "jpg", "image/jpeg");
    assert_eq!(db::search::search_asset_ids(&conn, "海边")?, vec![hit]);
    Ok(())
}

// ④ ≤2 字 LIKE 兜底 + 按标签名搜索
#[test]
fn like_fallback_and_tag_search() -> AppResult<()> {
    let conn = setup();
    let id = add_asset(&conn, "d:/p/photo001.jpg", "photo001.jpg", "jpg", "image/jpeg");
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
    let id = add_asset(&conn, "d:/p/photo001.jpg", "photo001.jpg", "jpg", "image/jpeg");
    let tag = tags::create(&conn, "山野", None)?;
    asset_tags::assign(&conn, &[id], &[tag.id], "manual")?;
    assert_eq!(db::search::search_asset_ids(&conn, "山野")?, vec![id]);
    asset_tags::remove(&conn, &[id], &[tag.id])?;
    assert!(db::search::search_asset_ids(&conn, "山野")?.is_empty(), "摘除标签后仍命中（幻影）");
    Ok(())
}

// ⑥ 文件改名索引同步
#[test]
fn rename_updates_index() -> AppResult<()> {
    let conn = setup();
    let id = add_asset(&conn, "d:/p/old.jpg", "old.jpg", "jpg", "image/jpeg");
    conn.execute("UPDATE assets SET file_name = '新名字.jpg' WHERE id = ?1", [id])?;
    assert_eq!(db::search::search_asset_ids(&conn, "新名字")?, vec![id]);
    assert!(db::search::search_asset_ids(&conn, "old")?.is_empty());
    Ok(())
}

// ⑦ 删除素材后索引清除（CASCADE + 触发器）
#[test]
fn delete_asset_clears_index() -> AppResult<()> {
    let conn = setup();
    let id = add_asset(&conn, "d:/p/海边日落.jpg", "海边日落.jpg", "jpg", "image/jpeg");
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
    let p = tree.iter().find(|n| n.tag.id == parent.id).expect("父标签缺失");
    assert_eq!(p.tag.asset_count, 1);          // 自身直接关联
    assert_eq!(p.tag.total_count, 2);          // a1+a2 去重合计
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

// ⑩ 分页 + 筛选（类型/未打标/标签连带）
#[test]
fn assets_pagination_and_filters() -> AppResult<()> {
    let conn = setup();
    for i in 0..5 {
        add_asset(&conn, &format!("d:/p/img{i}.jpg"), &format!("img{i}.jpg"), "jpg", "image/jpeg");
    }
    add_asset(&conn, "d:/p/v0.mp4", "v0.mp4", "mp4", "video/mp4");

    let page1 = assets::list(&conn, &AssetFilter { limit: 4, ..Default::default() })?;
    assert_eq!(page1.total, 6);
    assert_eq!(page1.items.len(), 4);
    assert!(page1.has_more);
    let page2 = assets::list(&conn, &AssetFilter { limit: 4, offset: 4, ..Default::default() })?;
    assert_eq!(page2.items.len(), 2);
    assert!(!page2.has_more);

    let videos = assets::list(&conn, &AssetFilter { asset_type: Some("video".into()), ..Default::default() })?;
    assert_eq!(videos.total, 1);

    let untagged = assets::list(&conn, &AssetFilter { untagged_only: true, ..Default::default() })?;
    assert_eq!(untagged.total, 6);

    // 标签连带筛选：父标签应捞出子标签素材
    let parent = tags::create(&conn, "风景", None)?;
    let child = tags::create(&conn, "海边", Some(parent.id))?;
    let pid = conn.query_row("SELECT id FROM assets WHERE file_ext='jpg' LIMIT 1", [], |r| r.get::<_, i64>(0))?;
    asset_tags::assign(&conn, &[pid], &[child.id], "manual")?;
    let filtered = assets::list(&conn, &AssetFilter { tag_id: Some(parent.id), ..Default::default() })?;
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
    let before = assets::list(&conn, &AssetFilter { untagged_only: true, ..Default::default() })?;
    assert_eq!(before.total, 1);

    let tags_map = ai::CategorizedTags::from([("场景".to_string(), vec!["夜景".to_string(), "城市".to_string()])]);
    ai::set_suggestion_tags(&conn, sugg.id, &tags_map)?;
    ai::confirm_suggestion(&conn, sugg.id, &tags_map)?;
    // 分类=父标签：「场景」应为根标签，「夜景」挂其下
    let tree = tags::list_tree(&conn)?;
    let scene = tree.iter().find(|n| n.tag.name == "场景").expect("应有分类父标签");
    assert!(scene.children.iter().any(|c| c.tag.name == "夜景"));

    let after = assets::list(&conn, &AssetFilter { untagged_only: true, ..Default::default() })?;
    assert_eq!(after.total, 0);
    // 确认后新标签可被检索
    assert_eq!(db::search::search_asset_ids(&conn, "夜景")?, vec![id]);
    // 来源标记
    let src: String = conn.query_row(
        "SELECT source FROM asset_tags WHERE asset_id = ?1", [id], |r| r.get(0))?;
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
