//! 通用表头结构判据；业务模块提供自己的字段评分，避免套用账表关键词。
use std::collections::HashSet;

/// 读取、前缀与结果缓存共同引用，防止表头规则修复后继续使用旧列名或正文。
pub(crate) const RULE_VERSION: &str = "headers-v4-structural-candidates";

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum SheetKind { Table, KeyValue, Empty, Uncertain }

fn populated(row: &[String]) -> Vec<(usize, &str)> {
    row.iter().enumerate().filter_map(|(i, v)| {
        let v = v.trim();
        (!v.is_empty()).then_some((i, v))
    }).collect()
}

/// 短字段是结构锚点，段落不能靠包含许多业务词冒充字段。
fn short_label(value: &str) -> bool {
    let n = value.trim().chars().count();
    n > 0 && n <= 40 && !is_body_scalar(value)
}

/// 仅在键／值位置稳定、键为短文字且首条值已有参数取值证据时判为参数页。
/// 普通的两列姓名／部门等纯文本清单不能仅因列数少被排除。
pub(crate) fn sheet_kind(rows: &[Vec<String>]) -> SheetKind {
    let records = rows.iter().filter(|r| !populated(r).is_empty()).take(32).collect::<Vec<_>>();
    if records.is_empty() { return if rows.is_empty() { SheetKind::Empty } else { SheetKind::Uncertain }; }
    let first = populated(records[0]);
    if first.len() == 2 && records.len() >= 3 {
        let positions = (first[0].0, first[1].0);
        let pair = |row: &[String]| {
            let p = populated(row);
            p.len() == 2 && (p[0].0, p[1].0) == positions
                && short_label(p[0].1) && p[0].1.chars().count() <= 20
        };
        let parameter_value = |v: &str| is_body_scalar(v) || v.chars().count() > 40
            || (v.chars().filter(char::is_ascii_digit).count() >= 8 && v.contains('-'));
        let paired = records.iter().filter(|r| pair(r)).count();
        let values = records.iter().filter(|r| pair(r) && parameter_value(&r[positions.1])).count();
        if paired * 5 >= records.len() * 4 && values >= 2 && parameter_value(first[1].1) {
            return SheetKind::KeyValue;
        }
    }
    if (0..rows.len().min(30)).any(|i| candidate_row(rows, i)) { SheetKind::Table } else { SheetKind::Uncertain }
}

/// 只筛结构，不按某个工具的字段词表决定能否成为候选。
pub(crate) fn candidate_row(rows: &[Vec<String>], start: usize) -> bool {
    let Some(row) = rows.get(start) else { return false };
    let fields = populated(row);
    if fields.is_empty() { return false; }
    let multi_column = rows.iter().any(|r| populated(r).len() >= 2);
    if multi_column && is_title(row) { return false; }
    let short = fields.iter().filter(|(_, v)| short_label(v)).count();
    let paragraphs = fields.iter().filter(|(_, v)| v.chars().count() > 80).count();
    short >= if multi_column { 2 } else { 1 }
        && paragraphs * 2 < fields.len()
        && fields.iter().filter(|(_, v)| is_body_scalar(v)).count() < 2
}

/// 允许纯文本正文；检查后续记录是否沿用候选列位，不强制数值或日期。
pub(crate) fn body_support(rows: &[Vec<String>], start: usize, depth: usize) -> usize {
    let Some(header) = rows.get(start) else { return 0 };
    let width = rows.iter().skip(start).take(depth).map(Vec::len).max().unwrap_or(0);
    let minimum = if populated(header).len() > 1 { 2 } else { 1 };
    rows.iter().skip(start + depth).take(4).filter(|row| {
        let values = populated(row);
        values.iter().filter(|(i, _)| *i < width).count() >= minimum
            && values.iter().filter(|(_, v)| v.chars().count() > 80).count() * 2 < values.len()
            && *row != header
    }).count()
}

/// 选 Sheet 与选表头使用相同结构约束，说明页不能凭关键词获得高排名。
pub(crate) fn table_score(rows: &[Vec<String>]) -> f64 {
    if sheet_kind(rows) == SheetKind::KeyValue { return -1.0; }
    if sheet_kind(rows) == SheetKind::Empty { return 0.0; }
    (0..rows.len().min(30)).filter(|&i| candidate_row(rows, i))
        .map(|i| crate::ledger_mapping::header_row_score(rows, i)).fold(0.0, f64::max)
}

/// 自动入口遇到参数页应要求显式指定，不能给业务计算伪造一套表头。
pub(crate) fn require_tabular(rows: &[Vec<String>], automatic: bool) -> Result<(), crate::AppError> {
    if automatic && sheet_kind(rows) == SheetKind::KeyValue {
        return Err(crate::AppError::new("SOURCE_NOT_TABULAR", "该工作表是参数／说明页，没有常规表头。请选择数据表，或手动指定表头行。", false, None));
    }
    Ok(())
}

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
    let has_fields = (0..rows.len().min(limit)).any(|i| candidate_row(rows, i));
    let has_body = (0..rows.len().min(limit)).any(|i| candidate_row(rows, i) && body_support(rows, i, 1) > 0);
    rows.iter()
        .take(limit)
        .enumerate()
        .filter(|(i, _)| (!has_fields || candidate_row(rows, *i)) && (!has_body || body_support(rows, *i, 1) > 0))
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

fn is_body_scalar(value: &str) -> bool {
    if let Some(number) = crate::ledger_mapping::parse_amount(value).ok().flatten() {
        // 年份可以是合法分组名称，金额、序号等实际取值不能成为下层字段。
        return !(number.fract() == 0.0 && (1900.0..=2100.0).contains(&number));
    }
    crate::ledger_mapping::parse_date(value).is_some()
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
        && !lower.iter().any(|value| is_body_scalar(value))
        && top.iter().filter(|value| is_body_scalar(value)).take(2).count() < 2
        && grouped
        && non >= 2
        && lower.iter().filter(text).count() * 5 >= non * 4
        && candidate_row(rows, start)
        && candidate_row(rows, start + 1)
        && (hits >= 2 || (distinct_labels(lower) < non
            && top.iter().zip(lower).any(|(a,b)| !a.trim().is_empty() && a.trim() == b.trim())))
        && (numeric > 0 || body_support(rows, start, 2) >= 2)
    {
        2
    } else {
        1
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn strings(rows: &[&[&str]]) -> Vec<Vec<String>> {
        rows.iter().map(|r| r.iter().map(|v| v.to_string()).collect()).collect()
    }
    #[test]
    fn header_structure_excludes_keyword_rich_paragraph_and_keeps_two_header_rows() {
        let mut rows = strings(&[
            &["", "变动项目", "合计", "固定资产"],
            &["变动项目", "变动项目", "计算", "资产类别"],
            &["原值", "期初原值", "100", "100"],
            &["", "原值增加", "20", "20"],
        ]);
        rows.resize(21, vec![String::new(); 4]);
        rows.push(vec!["计算依据".into(), "期初余额与期末余额取科目余额表，增加减少按凭证日期逐笔归集；金额与本位币余额核对，同时保留公司主体、摘要和科目辅助信息。".repeat(3), String::new(), String::new()]);
        assert!(!candidate_row(&rows, 21));
        assert_eq!(crate::fx::infer_public_header_layout(&rows), (1, 2));
        assert_eq!(layout(&rows, 30, |r| r.iter().filter(|v| v.contains("原值") || v.contains("资产")).count() as f64, |_| true, None), (0, 2));
    }
    #[test]
    fn header_structure_key_value_empty_and_text_records_are_distinct() {
        let params = strings(&[
            &["测算期间", "2025-01-01 至 2025-12-31"],
            &["月度余额来源", "序时账逐月还原"],
            &["衔接方法", "按现有映射与已验证辅助衔接，并保留各主体原始科目和明细数据，不将说明文字作为业务表头进行处理。"],
            &["计算范围", "所有存款账户按已经确认的核算方法逐月计算，遇到缺失信息时需要核对原始资料后重新确认。"],
        ]);
        assert_eq!(sheet_kind(&params), SheetKind::KeyValue);
        assert_eq!(require_tabular(&params, true).unwrap_err().code, "SOURCE_NOT_TABULAR");
        assert!(require_tabular(&params, false).is_ok());
        assert_eq!(sheet_kind(&[]), SheetKind::Empty);
        let text = strings(&[&["姓名", "部门"], &["张三", "销售部"], &["李四", "研发部"]]);
        assert_eq!(sheet_kind(&text), SheetKind::Table);
        assert_eq!(crate::fx::infer_public_header_layout(&text), (1, 1));
        assert_eq!(body_support(&text, 0, 1), 2);
    }
    #[test]
    fn header_structure_parameter_guard_reaches_business_readers() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("参数.csv");
        std::fs::write(&path, "测算期间,2025-01-01 至 2025-12-31\n余额来源,序时账逐月还原\n计算方法,按各账户已确认的取数方法计算金额并保留原始明细记录，遇到未明确的信息应先核对原始资料后再确认参数和取数方法\n核算范围,对所有已选择的主体和科目保留原始明细与发生额，数据核对完成以后才能进入后续测算流程并输出完整底稿\n").unwrap();
        for kind in ["ledger", "rateLedger", "tb", "je"] {
            let err = crate::loan_interest::call("loan.inspect", serde_json::json!({"kind":kind,"source":{"inputPath":path,"headerRow":0,"headerDepth":0}})).unwrap_err();
            assert_eq!(err.code, "SOURCE_NOT_TABULAR", "{kind}");
        }
        let err = crate::fuzzy_match::call("fuzzy.inspect", serde_json::json!({"source":{"inputPath":path,"headerRow":0,"headerDepth":0}})).unwrap_err();
        assert_eq!(err.code,"SOURCE_NOT_TABULAR");
        assert_eq!(crate::fa::load_table(&path,None,None,false).unwrap_err().code,"SOURCE_NOT_TABULAR");
        let source = crate::fx::SourceSpec { input_path:path.to_string_lossy().into_owned(),sheet:String::new(),header_row:0,header_depth:0 };
        assert_eq!(crate::fx::load_fx_bounded_inspection(&source,&path).unwrap_err().code,"SOURCE_NOT_TABULAR");
    }
    #[test]
    fn header_structure_pure_text_grouped_headers_and_header_only_sheet() {
        let rows = strings(&[
            &["人员信息", "", "单位信息", ""],
            &["姓名", "性别", "公司", "部门"],
            &["张三", "男", "甲公司", "销售部"],
            &["李四", "女", "乙公司", "研发部"],
        ]);
        assert_eq!(depth(&rows, 0, |_| true), 2);
        assert_eq!(sheet_kind(&strings(&[&["编号", "名称"]])), SheetKind::Table);
    }
    #[test]
    fn 通用表头含金额或日期的首条正文不能变成下层() {
        for scalar in ["100", "2026-01-02"] {
            let rows: Vec<Vec<String>> = [
                vec!["客户名称", "编号", "金额", "备注", ""],
                vec!["客户甲", "客户编号", scalar, "备注说明", "辅助名称"],
                vec!["客户乙", "002", "200", "正常", "其他"],
            ].into_iter().map(|r| r.into_iter().map(str::to_owned).collect()).collect();
            assert_eq!(depth(&rows, 0, |_| true), 1, "{scalar}");
        }
    }
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
