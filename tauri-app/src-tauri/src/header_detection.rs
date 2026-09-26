//! 通用表头结构判据；业务模块提供自己的字段评分，避免套用账表关键词。
use std::collections::HashSet;

pub(crate) fn distinct_labels(row: &[String]) -> usize {
    row.iter()
        .filter(|v| !v.trim().is_empty())
        .map(|v| crate::ledger_mapping::normalize_header(v))
        .collect::<HashSet<_>>()
        .len()
}

/// 多格重复同一个名称或仅一格有字均是报表标题候选，不作为分组表头。
pub(crate) fn is_title(row: &[String]) -> bool {
    distinct_labels(row) <= 1
}

/// 返回 0 基行号；评分由工具传入。相同分数时优先更早的行。
pub(crate) fn select_row(
    rows: &[Vec<String>],
    limit: usize,
    score: impl Fn(&[String]) -> f64,
) -> usize {
    let has_fields = rows.iter().take(limit).any(|r| !is_title(r));
    rows.iter()
        .take(limit)
        .enumerate()
        .filter(|(_, r)| !has_fields || !is_title(r))
        .max_by(|(ia, a), (ib, b)| score(a).total_cmp(&score(b)).then_with(|| ib.cmp(ia)))
        .map(|(i, _)| i)
        .unwrap_or(0)
}

pub(crate) fn layout(
    rows: &[Vec<String>],
    limit: usize,
    score: impl Fn(&[String]) -> f64,
    hit: impl Fn(&str) -> bool,
    requested: Option<usize>,
) -> (usize, usize) {
    let selected = requested.unwrap_or_else(|| select_row(rows, limit, score));
    if requested.is_none() && selected > 0 && depth(rows, selected - 1, &hit) == 2 {
        (selected - 1, 2)
    } else {
        (selected, depth(rows, selected, hit))
    }
}

/// 只有分组上层、带业务字段的文字下层、随后确有数据三项齐备才采用双层。
pub(crate) fn depth(rows: &[Vec<String>], start: usize, hit: impl Fn(&str) -> bool) -> usize {
    let Some(top) = rows.get(start) else {
        return 1;
    };
    let Some(lower) = rows.get(start + 1) else {
        return 1;
    };
    let Some(data) = rows.get(start + 2) else {
        return 1;
    };
    let text =
        |v: &&String| !v.trim().is_empty() && crate::ledger_mapping::parse_amount(v).is_err();
    let non = lower.iter().filter(|v| !v.trim().is_empty()).count();
    let grouped = top.iter().any(|v| v.trim().is_empty())
        || distinct_labels(top) < top.iter().filter(|v| !v.trim().is_empty()).count();
    let hits = lower.iter().filter(|v| hit(v)).count();
    let numeric = data
        .iter()
        .filter(|v| {
            crate::ledger_mapping::parse_amount(v)
                .ok()
                .flatten()
                .is_some()
                || crate::ledger_mapping::parse_date(v).is_some()
        })
        .count();
    if !is_title(top)
        && !is_title(lower)
        && grouped
        && non >= 2
        && lower.iter().filter(text).count() * 5 >= non * 4
        && hits >= 2
        && numeric > 0
    {
        2
    } else {
        1
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn 通用表头排除重复标题并保留工具评分() {
        let rows = vec![
            vec!["借款登记簿".into(); 6],
            vec!["银行".into(), "本金".into(), "利率".into()],
            vec!["某银行".into(), "100".into(), "3.5".into()],
        ];
        assert_eq!(
            select_row(&rows, 30, |r| r
                .iter()
                .filter(|v| v.contains("借款") || v.contains("本金"))
                .count() as f64),
            1
        );
        assert_eq!(depth(&rows, 0, |_| true), 1);
    }
    #[test]
    fn 通用表头双层须有分组和数据证据() {
        let rows = vec![
            vec!["资产信息".into(), "".into(), "金额".into(), "".into()],
            vec!["编号".into(), "名称".into(), "原值".into(), "折旧".into()],
            vec!["001".into(), "设备".into(), "100".into(), "10".into()],
        ];
        assert_eq!(depth(&rows, 0, |_| true), 2);
        assert_eq!(depth(&rows[..2], 0, |_| true), 1);
    }
}
