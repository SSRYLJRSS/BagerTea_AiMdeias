/// Shift numbered SQLite placeholders while preserving arbitrary UTF-8 text.
///
/// Only `?N` placeholders are rewritten. Bare `?` characters and non-ASCII SQL
/// comments/literals are copied byte-for-byte.
pub(crate) fn offset_placeholders(fragment: &str, offset: usize) -> String {
    if offset == 0 {
        return fragment.to_string();
    }

    let bytes = fragment.as_bytes();
    let mut output = String::with_capacity(fragment.len());
    let mut cursor = 0;
    let mut copied_until = 0;

    while cursor < bytes.len() {
        if bytes[cursor] == b'?'
            && bytes
                .get(cursor + 1)
                .is_some_and(|byte| byte.is_ascii_digit())
        {
            output.push_str(&fragment[copied_until..cursor]);
            let mut end = cursor + 1;
            while end < bytes.len() && bytes[end].is_ascii_digit() {
                end += 1;
            }
            let index = fragment[cursor + 1..end]
                .parse::<usize>()
                .expect("placeholder index contains only ASCII digits");
            output.push('?');
            output.push_str(&(index + offset).to_string());
            cursor = end;
            copied_until = end;
        } else {
            cursor += 1;
        }
    }
    output.push_str(&fragment[copied_until..]);
    output
}

#[cfg(test)]
mod tests {
    use super::offset_placeholders;

    #[test]
    fn shifts_numbered_placeholders_and_preserves_utf8() {
        assert_eq!(
            offset_placeholders("名称 = ?1 AND 备注 = '中文?' AND id = ?12", 3),
            "名称 = ?4 AND 备注 = '中文?' AND id = ?15"
        );
    }

    #[test]
    fn leaves_bare_question_marks_unchanged() {
        assert_eq!(
            offset_placeholders("a = ? AND b = ?2", 4),
            "a = ? AND b = ?6"
        );
    }
}
