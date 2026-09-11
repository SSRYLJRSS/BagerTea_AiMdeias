//! 重复素材扫描（M3-02 R-20）：按入库 hash 精确分组 + W5d 感知相似分组。
//! hash 相同 = 字节级完全一致（入库时 sha256 计算写入 assets.hash）。
//! W5d（§W5d）：相似分组 —— 短锁取 (id, file_path, phash) 全表入内存 → 高 16 位前缀分桶 →
//! 桶内两两汉明 ≤ threshold → 并查集合并（410 行全表分桶是微秒级；SQL 两两比较已被拒绝）。

use rusqlite::Connection;
use serde::Serialize;

use super::assets::{from_row, Asset, COLUMNS};
use crate::error::AppResult;
use crate::services::kinship::kinship_key;
use crate::services::perceptual::{bucket_by_prefix, hamming};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum GroupKind {
    /// 字节级完全一致（sha256 相同）
    Exact,
    /// 感知相似（dHash 汉明距离 ≤ 阈值）
    Similar,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DupGroup {
    pub hash: String,
    /// exact = 相同 sha256；similar = 组内代表 phash（前端据此区分文案/排序）
    pub kind: GroupKind,
    /// 按 created_at 升序，首项最早（前端高亮为保留候选）
    pub assets: Vec<Asset>,
}

/// 扫描全库 hash 重复分组。
/// 走 idx_assets_hash 索引：子查询 GROUP BY 定位重复 hash，外层按 hash + created_at 排序取明细。
pub fn scan_groups(conn: &Connection) -> AppResult<Vec<DupGroup>> {
    let sql = format!(
        "SELECT {COLUMNS} FROM assets a
          WHERE a.hash IS NOT NULL
            AND a.hash IN (SELECT hash FROM assets WHERE hash IS NOT NULL GROUP BY hash HAVING COUNT(*) > 1)
          ORDER BY a.hash, a.created_at, a.id"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt
        .query_map([], from_row)?
        .collect::<Result<Vec<Asset>, _>>()?;

    // 已按 hash 排序，顺序切块即分组
    let mut groups: Vec<DupGroup> = Vec::new();
    for asset in rows {
        let hash = asset.hash.clone().unwrap_or_default();
        match groups.last_mut() {
            Some(g) if g.kind == GroupKind::Exact && g.hash == hash => g.assets.push(asset),
            _ => groups.push(DupGroup {
                hash,
                kind: GroupKind::Exact,
                assets: vec![asset],
            }),
        }
    }
    Ok(groups)
}

/// 扫描感知相似分组。
///
/// `threshold`：汉明距离阈值（0 = 禁用相似检测，直接返回空）。
/// `exclude_kinship`：同源文件（同目录 + 同主干名 + 一 RAW 一非 RAW，W5h）不算相似 ——
///   你的库 205 组 RAW+JPG 同画面会被 dHash 识别为「相似」，不开排除会被真实连拍重复淹没。
/// `need_ids`：只对给定 id 子集做相似检测（空 = 全库）。
///
/// 算法：一次短锁取 (id, file_path, phash) 全表（只三列）→ 过滤 phash 非空 / 哨兵 0 →
/// 按高 16 位前缀分桶 → 桶内两两汉明比较（同源且 exclude_kinship 时跳过）→ 并查集合并 →
/// 按 id 回读完整 Asset 明细（与 scan_groups 的 COLUMNS 一致，组内按 created_at 升序）。
pub fn scan_similar_groups(
    conn: &Connection,
    threshold: u32,
    exclude_kinship: bool,
    need_ids: &[i64],
) -> AppResult<Vec<DupGroup>> {
    if threshold == 0 {
        return Ok(Vec::new());
    }
    // 1. 一次短锁取 (id, file_path, phash)
    let mut stmt = conn.prepare(
        "SELECT id, file_path, phash FROM assets WHERE deleted_at IS NULL AND phash IS NOT NULL",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok((
            r.get::<_, i64>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, i64>(2)?,
        ))
    })?;
    let mut rows_all: Vec<(i64, String, u64)> = Vec::new();
    for row in rows {
        let (id, path, phash) = row?;
        let ph = phash as u64;
        if ph == 0 {
            continue; // 0 是 set_phash 的哨兵（纯色/无差分图）
        }
        if !need_ids.is_empty() && !need_ids.contains(&id) {
            continue;
        }
        rows_all.push((id, path, ph));
    }
    if rows_all.len() < 2 {
        return Ok(Vec::new());
    }

    // 2. 并查集（按 rows_all 下标）
    let n = rows_all.len();
    let mut parent: Vec<usize> = (0..n).collect();
    fn find(parent: &mut [usize], x: usize) -> usize {
        if parent[x] != x {
            parent[x] = find(parent, parent[x]);
        }
        parent[x]
    }

    // 3. 前缀分桶 → 桶内两两比较 → 并查集合并
    let id_to_idx: std::collections::HashMap<i64, usize> = rows_all
        .iter()
        .enumerate()
        .map(|(i, (id, _, _))| (*id, i))
        .collect();
    let phash_rows: Vec<(i64, u64)> = rows_all.iter().map(|(id, _, ph)| (*id, *ph)).collect();
    for (_prefix, bucket) in bucket_by_prefix(phash_rows) {
        for i in 0..bucket.len() {
            let (ida, pha) = bucket[i];
            let idxa = id_to_idx[&ida];
            for &(idb, phb) in bucket.iter().skip(i + 1) {
                if exclude_kinship
                    && kinship_key(&rows_all[id_to_idx[&ida]].1).0
                        == kinship_key(&rows_all[id_to_idx[&idb]].1).0
                {
                    continue;
                }
                if hamming(pha, phb) <= threshold {
                    let idxb = id_to_idx[&idb];
                    let ra = find(&mut parent, idxa);
                    let rb = find(&mut parent, idxb);
                    if ra != rb {
                        parent[rb] = ra;
                    }
                }
            }
        }
    }

    // 4. 连通块 → ≥2 成员的组
    let mut groups: std::collections::HashMap<usize, Vec<i64>> = std::collections::HashMap::new();
    for (i, row) in rows_all.iter().enumerate().take(n) {
        let root = find(&mut parent, i);
        groups.entry(root).or_default().push(row.0);
    }
    let member_lists: Vec<Vec<i64>> = groups.into_values().filter(|v| v.len() >= 2).collect();
    if member_lists.is_empty() {
        return Ok(Vec::new());
    }

    // 5. 回读完整 Asset（一次短锁；组内按 created_at 升序，与 scan_groups 语义一致）
    let mut stmt = conn.prepare(&format!("SELECT {COLUMNS} FROM assets WHERE id = ?1"))?;
    let mut out: Vec<DupGroup> = Vec::new();
    for mut member_ids in member_lists {
        member_ids.sort_unstable();
        let mut assets: Vec<Asset> = member_ids
            .iter()
            .filter_map(|&id| stmt.query_row([id], from_row).ok())
            .collect();
        assets.sort_by(|a, b| a.created_at.cmp(&b.created_at).then(a.id.cmp(&b.id)));
        let rep = assets.first().and_then(|a| a.phash).unwrap_or(0);
        out.push(DupGroup {
            hash: format!("{rep:016x}"),
            kind: GroupKind::Similar,
            assets,
        });
    }
    // 组间按代表 phash 排序（稳定输出，方便测试与 UI 复现）
    out.sort_by(|a, b| a.hash.cmp(&b.hash));
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::init_memory;

    fn insert_asset(
        conn: &rusqlite::Connection,
        file_path: &str,
        hash: &str,
        phash: Option<i64>,
    ) -> i64 {
        conn.execute(
            "INSERT INTO assets (file_path, file_name, file_ext, file_size, mime_type, created_at, modified_at, hash, phash)
             VALUES (?1, ?1, '.jpg', 1, 'image/jpeg', 0, 0, ?2, ?3)",
            rusqlite::params![file_path, hash, phash],
        )
        .unwrap();
        conn.last_insert_rowid()
    }

    #[test]
    fn similar_group_merges_near_hashes() {
        let conn = init_memory().unwrap();
        let a = insert_asset(
            &conn,
            "C:/photos/a.jpg",
            "h1",
            Some(0xABCD_0000_0000_0001u64 as i64),
        );
        let b = insert_asset(
            &conn,
            "C:/photos/b.jpg",
            "h2",
            Some(0xABCD_0000_0000_0003u64 as i64),
        ); // 汉明 1
        insert_asset(
            &conn,
            "C:/photos/c.jpg",
            "h3",
            Some(0xFFFF_FFFF_FFFF_FFFFu64 as i64),
        ); // 远
        let groups = scan_similar_groups(&conn, 8, false, &[]).unwrap();
        assert_eq!(groups.len(), 1, "只有 a/b 接近成组");
        assert_eq!(groups[0].kind, GroupKind::Similar);
        let ids: Vec<i64> = groups[0].assets.iter().map(|x| x.id).collect();
        assert_eq!(ids, vec![a, b]);
    }

    #[test]
    fn far_hashes_never_group() {
        let conn = init_memory().unwrap();
        insert_asset(
            &conn,
            "C:/photos/a.jpg",
            "h1",
            Some(0x0000_0000_0000_FFFFu64 as i64),
        );
        insert_asset(
            &conn,
            "C:/photos/b.jpg",
            "h2",
            Some(0xFFFF_FFFF_FFFF_0000u64 as i64),
        );
        let groups = scan_similar_groups(&conn, 8, false, &[]).unwrap();
        assert!(groups.is_empty());
    }

    #[test]
    fn kinship_exclusion_skips_raw_jpeg_pair() {
        let conn = init_memory().unwrap();
        // 同目录 + 同主干名（DSC0001）+ 一 RAW 一 JPG = 同源文件
        insert_asset(
            &conn,
            "C:/photos/DSC0001.RW2",
            "r",
            Some(0xABCD_0000_0000_0001u64 as i64),
        );
        insert_asset(
            &conn,
            "C:/photos/DSC0001.JPG",
            "j",
            Some(0xABCD_0000_0000_0003u64 as i64),
        );
        // 排除同源 → 不成组
        let excluded = scan_similar_groups(&conn, 8, true, &[]).unwrap();
        assert!(excluded.is_empty(), "同源 RAW+JPG 应被排除");
        // 不排除 → 成组
        let included = scan_similar_groups(&conn, 8, false, &[]).unwrap();
        assert_eq!(included.len(), 1);
    }

    #[test]
    fn threshold_zero_disables_similar() {
        let conn = init_memory().unwrap();
        insert_asset(
            &conn,
            "C:/photos/a.jpg",
            "h1",
            Some(0xABCD_0000_0000_0001u64 as i64),
        );
        insert_asset(
            &conn,
            "C:/photos/b.jpg",
            "h2",
            Some(0xABCD_0000_0000_0003u64 as i64),
        );
        assert!(scan_similar_groups(&conn, 0, false, &[])
            .unwrap()
            .is_empty());
    }

    #[test]
    fn need_ids_restricts_scope() {
        let conn = init_memory().unwrap();
        let a = insert_asset(
            &conn,
            "C:/photos/a.jpg",
            "h1",
            Some(0xABCD_0000_0000_0001u64 as i64),
        );
        insert_asset(
            &conn,
            "C:/photos/b.jpg",
            "h2",
            Some(0xABCD_0000_0000_0003u64 as i64),
        );
        insert_asset(
            &conn,
            "C:/photos/c.jpg",
            "h3",
            Some(0xFFFF_FFFF_FFFF_FFFFu64 as i64),
        );
        // 只检测 [a]：与任何其他 id 距离再近都不参与（b/c 不在范围内）→ 空
        let groups = scan_similar_groups(&conn, 8, false, &[a]).unwrap();
        assert!(groups.is_empty());
    }
}
