//! 一次性维护工具：清空素材库记录（仅出库，原文件不动）
//! 用途：老板走查期间产生的半成品数据需要清库重导
//! 运行：cargo test --test dev_maintenance -- --ignored
//! 注意：会操作真实用户数据库，执行前请关闭应用（避免写锁竞争）

use std::path::Path;

use bagertea_ai_media_v2_lib::db;

#[test]
#[ignore = "手动触发的维护操作"]
fn purge_all_assets() {
    let db_path = Path::new(r"C:\Users\33887\AppData\Roaming\bagertea_ai_media_v2\library.db");
    let conn = db::init(db_path).expect("打开数据库失败");

    let before: i64 = conn
        .query_row("SELECT COUNT(*) FROM assets", [], |r| r.get(0))
        .unwrap();
    let tx = conn.unchecked_transaction().unwrap();
    tx.execute("DELETE FROM asset_tags", []).unwrap();
    tx.execute("DELETE FROM ai_suggestions", []).unwrap();
    tx.execute("DELETE FROM ai_batches", []).unwrap();
    // 触发器自动清 fts_content（cjk_bigram 已由 db::init 注册）
    tx.execute("DELETE FROM assets", []).unwrap();
    tx.commit().unwrap();

    let after: i64 = conn
        .query_row("SELECT COUNT(*) FROM assets", [], |r| r.get(0))
        .unwrap();
    let fts: i64 = conn
        .query_row("SELECT COUNT(*) FROM fts_content", [], |r| r.get(0))
        .unwrap();
    println!("清理完成：{before} → {after} 条素材；fts_content 剩余 {fts}");
    assert_eq!(after, 0);
    assert_eq!(fts, 0);
}
