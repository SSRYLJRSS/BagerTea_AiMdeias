//! 重复素材扫描（M3-02 R-20）：按入库 hash 精确分组（感知哈希留机动项）。
//! hash 相同 = 字节级完全一致（入库时 sha256 计算写入 assets.hash）。

use rusqlite::Connection;
use serde::Serialize;

use super::assets::{from_row, Asset, COLUMNS};
use crate::error::AppResult;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DupGroup {
    pub hash: String,
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
            Some(g) if g.hash == hash => g.assets.push(asset),
            _ => groups.push(DupGroup {
                hash,
                assets: vec![asset],
            }),
        }
    }
    Ok(groups)
}
