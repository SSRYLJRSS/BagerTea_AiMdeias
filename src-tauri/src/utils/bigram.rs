//! 中文逐字切分（unigram）：CJK 字符相邻两字间插空格；CJK↔非CJK 边界两侧亦插空格。
//! 架构 v1.3 §1.5：写入侧与查询侧必须使用同一切分，保证索引与查询一致。
//! BUG-B 修复：旧实现只在 CJK↔CJK 间插空格，导致 `度100` 被 unicode61 合并为单 token，
//! 跨边界子串搜索失败；新实现在 CJK↔非CJK 边界两侧均插空格，使 CJK 与相邻 ASCII/符号分离。

use rusqlite::functions::FunctionFlags;
use rusqlite::Connection;

use crate::error::AppResult;

/// 是否 CJK 统一表意文字（基本区 + 扩展 A）
pub fn is_cjk(c: char) -> bool {
    ('\u{3400}'..='\u{9fff}').contains(&c)
}

/// 逐字切分：当前后任一为 CJK 时插空格（覆盖 CJK↔CJK 逐字与 CJK↔非CJK 边界两种情况），
/// 仅当前后均为非 CJK 时不插空格（保持 ASCII token 连续）。
/// - `海边日落`      → `海 边 日 落`（纯 CJK 切分不变）
/// - `进度100%.jpg`  → `进 度 100%.jpg`（CJK↔非CJK 边界两侧插空格，BUG-B 修复）
/// - `IMG_海边合照01.jpg` → `IMG_ 海 边 合 照 01.jpg`
/// - `photo001.jpg`  → `photo001.jpg`（纯非 CJK 不变）
pub fn cjk_bigram(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 2);
    let mut prev_cjk: Option<bool> = None;
    for ch in s.chars() {
        let cur_cjk = is_cjk(ch);
        if let Some(p) = prev_cjk {
            // 前后任一为 CJK 即插空格；等价于 (p && cur_cjk) || p != cur_cjk
            if p || cur_cjk {
                out.push(' ');
            }
        }
        prev_cjk = Some(cur_cjk);
        out.push(ch);
    }
    out
}

/// 注册为 SQLite 标量函数，供触发器调用（注意：调用方需保证参数非 NULL，
/// 触发器 SQL 中已用 COALESCE 兜底）
pub fn register(conn: &Connection) -> AppResult<()> {
    conn.create_scalar_function(
        "cjk_bigram",
        1,
        FunctionFlags::SQLITE_UTF8 | FunctionFlags::SQLITE_DETERMINISTIC,
        |ctx| {
            let s = ctx.get::<String>(0)?;
            Ok(cjk_bigram(&s))
        },
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bigram_splits_cjk() {
        assert_eq!(cjk_bigram("海边日落"), "海 边 日 落");
        assert_eq!(cjk_bigram("海边"), "海 边");
        assert_eq!(cjk_bigram("photo001.jpg"), "photo001.jpg");
        assert_eq!(cjk_bigram("IMG_海边合照01.jpg"), "IMG_ 海 边 合 照 01.jpg");
        assert_eq!(cjk_bigram(""), "");
    }

    #[test]
    fn bigram_boundary_spaces() {
        // CJK↔非CJK 边界两侧插空格（BUG-B 修复）
        assert_eq!(cjk_bigram("进度100%.jpg"), "进 度 100%.jpg");
        assert_eq!(cjk_bigram("IMG_海边合照01.jpg"), "IMG_ 海 边 合 照 01.jpg");
        // 纯 CJK 切分不变
        assert_eq!(cjk_bigram("海边日落"), "海 边 日 落");
        // 纯非 CJK 不变
        assert_eq!(cjk_bigram("photo001.jpg"), "photo001.jpg");
        // 单字 CJK
        assert_eq!(cjk_bigram("海"), "海");
    }
}
