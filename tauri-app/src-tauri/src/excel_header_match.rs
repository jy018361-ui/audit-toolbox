//! Excel 合并·智能表头匹配引擎（纯逻辑，不做文件 IO）。
//!
//! 职责三块：
//! 1. **表头探测**——表头不在首行（标题/单位/说明行在前）与两层合并表头，
//!    逐行打分判定，探测结果供前端展示与人工兜底；
//! 2. **列匹配**——模板表头 vs 各文件表头：归一化一致 > 个人对照表 > 常用
//!    别名词库 > 分段一致（双语表头）为机器绿；相似度（编辑距离 + LCS +
//!    bigram Dice 固定权重 0.45/0.30/0.25）只给黄色建议；对立词（借/贷、应收/应付…）
//!    相似度再高也强制拦下，宁可疑而勿错并；
//! 3. **合并计划**——前端确认后的最终映射（`HeaderMatchingPlan`），
//!    `excel_merger::merge` 的纵向写出路径按它重排列并去重表头。
//!
//! 文件 IO（读 workbook、组装 preview JSON、写出结果）全部留在
//! `excel_merger.rs`，本模块接口只认 `String`，便于单测与复用。
//!
//! 打分复用 `ledger_mapping::header_row_score`（非空率/文本率/唯一率/账表
//! 关键词/下一行像数据 五信号加权），归一化复用 `ledger_mapping::normalize_header`。

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::HashSet;
use std::path::PathBuf;

use crate::AppError;
use crate::ledger_mapping::{header_row_score, normalize_header};

// ────────────────────────────── 表头探测 ──────────────────────────────

/// 扫描前多少行找表头。真实导出里标题区一般不超过十来行，30 与公共账表入口一致。
const HEADER_SCAN_ROWS: usize = 30;
/// 探测置信度低于该值（或与次高分行难分伯仲）时要求人工确认表头行。
const HEADER_REVIEW_SCORE: f64 = 0.55;
const HEADER_REVIEW_MARGIN: f64 = 0.05;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HeaderDetection {
    /// 表头行下标（0 基）。
    pub header_row: usize,
    /// 表头占几行（1=单层，2=合并单元格两层）。
    pub header_rows_count: usize,
    /// 探测置信度 = 表头行得分（0~1）。
    pub confidence: f64,
    /// 拿不准时前端在文件名旁挂黄点，点开人工指定表头行。
    pub needs_review: bool,
}

/// 合并与 TBJE 共用账表候选行和层数判据；合并区域不再另开宽松路径。
pub(crate) fn detect_header(rows: &[Vec<String>]) -> Option<HeaderDetection> {
    detect_header_with_merges(rows, &[])
}

pub(crate) fn detect_header_with_merges(
    rows: &[Vec<String>],
    _merges: &[(u32, u32, u32, u32)],
) -> Option<HeaderDetection> {
    if !rows.iter().any(|row| row.iter().any(|value| !value.trim().is_empty())) {
        return None;
    }
    let (row, depth) = crate::fx::infer_public_header_layout(rows);
    let header_row = row.saturating_sub(1);
    let score = header_row_score(rows, header_row);
    let second = (0..rows.len().min(HEADER_SCAN_ROWS))
        .filter(|&i| i != header_row && i >= header_row + depth)
        .map(|i| header_row_score(rows, i))
        .fold(0.0_f64, f64::max);
    Some(HeaderDetection {
        header_row,
        header_rows_count: depth,
        confidence: (score * 100.0).round() / 100.0,
        needs_review: score < HEADER_REVIEW_SCORE || score - second < HEADER_REVIEW_MARGIN,
    })
}

/// 空表头保留原列位置；不把左侧字段名扩散到空标题列。
pub(crate) fn single_layer_headers(row: &[String]) -> Vec<String> {
    row.iter().enumerate().map(|(index, value)| {
        let name = crate::fx::merge_consistent_header(value);
        if name.is_empty() { format!("列{}", index + 1) } else { name }
    }).collect()
}

/// 两层表头拍平成单层列名：父级向右填充（合并单元格只有首格有值），
/// 父-子用「-」连接，父级为空用子级名，父子同名去重，全空给占位名。
pub(crate) fn flatten_two_layer(first: &[String], second: &[String]) -> Vec<String> {
    let width = first.len().max(second.len());
    let mut out = Vec::with_capacity(width);
    let mut parent = String::new();
    for index in 0..width {
        let top = first.get(index).map(String::as_str).unwrap_or("").trim();
        if !top.is_empty() {
            parent = crate::fx::merge_consistent_header(top);
        }
        let child = crate::fx::merge_consistent_header(second.get(index).map(String::as_str).unwrap_or(""));
        let child = child.as_str();
        let name = if parent.is_empty() {
            child.to_string()
        } else if child.is_empty() || child == parent {
            parent.clone()
        } else {
            format!("{parent}-{child}")
        };
        out.push(if name.is_empty() {
            format!("列{}", index + 1)
        } else {
            name
        });
    }
    out
}

// ────────────────────────────── 列匹配引擎 ──────────────────────────────

/// 审计底稿常用字段的同义写法分组。同一组内的写法视为同一字段；
/// 组间互不相认（「借方金额」组绝不吸收裸「金额」，那交给相似度层给黄）。
const ALIAS_GROUPS: &[&[&str]] = &[
    &[
        "日期",
        "记账日期",
        "制单日期",
        "凭证日期",
        "发生日期",
        "业务日期",
        "交易日期",
        "记账时间",
        "date",
        "postingdate",
        "voucherdate",
    ],
    &[
        "凭证号",
        "凭证编号",
        "凭证号码",
        "凭证字号",
        "记账号",
        "记账凭证号",
        "单据编号",
        "单据号",
        "单号",
        "voucherno",
        "vouchernumber",
        "voucherid",
    ],
    &[
        "摘要",
        "凭证摘要",
        "摘要说明",
        "摘要描述",
        "事由",
        "说明",
        "description",
    ],
    &[
        "科目编码",
        "科目代码",
        "科目编号",
        "科目号",
        "accountcode",
        "accountno",
    ],
    &[
        "科目名称",
        "科目描述",
        "科目",
        "accountname",
        "accountdescription",
    ],
    &[
        "借方金额",
        "借方发生额",
        "借方本位币金额",
        "借方",
        "debit",
        "debitamount",
    ],
    &[
        "贷方金额",
        "贷方发生额",
        "贷方本位币金额",
        "贷方",
        "credit",
        "creditamount",
    ],
    &["余额", "科目余额", "账面余额", "balance", "balanceamount"],
    &[
        "金额",
        "发生额",
        "本币金额",
        "本位币金额",
        "amount",
        "金额本位币",
    ],
    &["数量", "qty", "quantity", "数目"],
    &["单价", "unitprice", "price"],
    &["币种", "货币", "货币种类", "currency"],
    &["汇率", "exchangeRate", "折算汇率", "折算率"],
    &[
        "期初余额",
        "期初金额",
        "期初数",
        "年初余额",
        "openingbalance",
    ],
    &[
        "期末余额",
        "期末金额",
        "期末数",
        "年末余额",
        "closingbalance",
    ],
    &["部门", "部门名称", "成本中心", "department", "costcenter"],
    &[
        "往来单位",
        "单位名称",
        "对方单位",
        "交易对手",
        "客商",
        "客商名称",
        "counterparty",
        "supplier",
        "customer",
        "vendor",
    ],
    &["制单人", "制单", "录入人", "创建人", "preparedby", "maker"],
    &["审核人", "复核人", "审核", "approvedby", "checker"],
];

/// 对立词对：两边分别命中即语义相反，相似度层一票否决——「借方金额」和
/// 「贷方金额」只差一个字，错配了借贷方向整个反掉；「原币/本位币」与
/// 「含税/不含税」同样是差一个字、口径全反，审计底稿里最要命。
/// 「不含税」包含子串「含税」，见 [`term_hit`] 的超集词处理。
const CONFLICT_PAIRS: &[(&str, &str)] = &[
    ("借方", "贷方"),
    ("应收", "应付"),
    ("期初", "期末"),
    ("年初", "年末"),
    ("预付", "预收"),
    ("收入", "支出"),
    ("资产", "负债"),
    ("增加", "减少"),
    ("原币", "本位币"),
    ("含税", "不含税"),
];

/// 词对里一方是另一方的超集词（「不含税」⊃「含税」）时，命中长词不算
/// 命中短词——否则「不含税金额」会被误判为同时含「含税」，对立判定失效。
fn term_hit(text: &str, term: &str, opposite: &str) -> bool {
    if opposite.len() > term.len() && opposite.contains(term) && text.contains(opposite) {
        return false;
    }
    text.contains(term)
}

fn conflicts(template: &str, header: &str) -> bool {
    CONFLICT_PAIRS.iter().any(|&(a, b)| {
        let (t_a, t_b) = (term_hit(template, a, b), term_hit(template, b, a));
        let (h_a, h_b) = (term_hit(header, a, b), term_hit(header, b, a));
        (t_a && h_b && !h_a) || (t_b && h_a && !h_b)
    })
}

fn alias_group_of(normalized: &str) -> Option<usize> {
    ALIAS_GROUPS.iter().position(|group| {
        group
            .iter()
            .any(|alias| normalize_header(alias) == normalized)
    })
}

/// 单对匹配强度与依据。`None` = 不建议。
fn pair_score(template: &str, header: &str, aliases: &[(String, String)]) -> Option<(f64, String)> {
    let nt = normalize_header(template);
    let nh = normalize_header(header);
    if nt.is_empty() || nh.is_empty() {
        return None;
    }
    if nt == nh {
        return Some((1.0, "名称一致".into()));
    }
    if aliases
        .iter()
        .any(|(source, target)| normalize_header(source) == nh && normalize_header(target) == nt)
    {
        return Some((0.97, "我的对照表".into()));
    }
    let (group_t, group_h) = (alias_group_of(&nt), alias_group_of(&nh));
    if let (Some(gt), Some(gh)) = (group_t, group_h) {
        if gt == gh {
            return Some((0.92, "常见同义写法".into()));
        }
    }
    // 双语表头（`过账日期\nPosting Date`）整体不等，但某一段正好相等。
    for segment in crate::ledger_mapping::header_segments(header) {
        if segment == nt {
            return Some((0.95, "表头分段一致".into()));
        }
    }
    for segment in crate::ledger_mapping::header_segments(template) {
        if segment == nh {
            return Some((0.95, "表头分段一致".into()));
        }
    }
    // 相似度层（黄色建议）：对立词先拦，再做包含/编辑距离/bigram。
    if conflicts(&nt, &nh) {
        return None;
    }
    let tc: Vec<char> = nt.chars().collect();
    let hc: Vec<char> = nh.chars().collect();
    let embedded = (tc.len() >= 2 && tc.len() <= hc.len() && nh.contains(nt.as_str()))
        || (hc.len() >= 2 && hc.len() < tc.len() && nt.contains(nh.as_str()));
    if embedded {
        return Some((0.80, "名称包含".into()));
    }
    let similarity = 0.45 * levenshtein_ratio(&tc, &hc)
        + 0.30 * lcs_ratio(&tc, &hc)
        + 0.25 * bigram_dice(&tc, &hc);
    if similarity >= 0.62 {
        let percent = (similarity * 100.0).round() as u64;
        return Some((similarity, format!("相似度 {percent}%")));
    }
    None
}

/// 单列匹配结论。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ColumnMatch {
    /// 模板列下标；`None` = 未匹配（进未匹配区）。
    pub target: Option<usize>,
    pub confidence: f64,
    pub reason: String,
}

/// 一组文件表头对模板的一对一匹配：高分优先占位、低分让路。
///
/// 机器绿（直接采信）只来自名称一致/我的对照表/常见同义/分段一致；
/// 相似度层无论多像都只给黄色建议，由人拍板。
pub(crate) fn match_columns(
    template: &[String],
    headers: &[String],
    aliases: &[(String, String)],
) -> Vec<ColumnMatch> {
    let mut candidates: Vec<(f64, usize, usize, String)> = Vec::new();
    for (h, header) in headers.iter().enumerate() {
        for (t, column) in template.iter().enumerate() {
            if let Some((score, reason)) = pair_score(column, header, aliases) {
                candidates.push((score, h, t, reason));
            }
        }
    }
    candidates.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
    let mut taken_h = vec![false; headers.len()];
    let mut taken_t = vec![false; template.len()];
    let mut result = vec![
        ColumnMatch {
            target: None,
            confidence: 0.0,
            reason: String::new(),
        };
        headers.len()
    ];
    for (score, h, t, reason) in candidates {
        if taken_h[h] || taken_t[t] {
            continue;
        }
        taken_h[h] = true;
        taken_t[t] = true;
        result[h] = ColumnMatch {
            target: Some(t),
            confidence: (score * 100.0).round() / 100.0,
            reason,
        };
    }
    result
}

// ────────────────── 相似度原语（短文本，自 fuzzy_match 平移） ──────────────────

fn levenshtein_distance(a: &[char], b: &[char]) -> usize {
    if a.is_empty() {
        return b.len();
    }
    if b.is_empty() {
        return a.len();
    }
    let mut prev: Vec<usize> = (0..=b.len()).collect();
    let mut cur: Vec<usize> = vec![0; b.len() + 1];
    for (i, ca) in a.iter().enumerate() {
        cur[0] = i + 1;
        for (j, cb) in b.iter().enumerate() {
            let cost = usize::from(ca != cb);
            cur[j + 1] = (prev[j + 1] + 1).min(cur[j] + 1).min(prev[j] + cost);
        }
        std::mem::swap(&mut prev, &mut cur);
    }
    prev[b.len()]
}

fn levenshtein_ratio(a: &[char], b: &[char]) -> f64 {
    let max = a.len().max(b.len());
    if max == 0 {
        return 1.0;
    }
    1.0 - levenshtein_distance(a, b) as f64 / max as f64
}

fn lcs_length(a: &[char], b: &[char]) -> usize {
    if a.is_empty() || b.is_empty() {
        return 0;
    }
    let mut prev: Vec<usize> = vec![0; b.len() + 1];
    let mut cur: Vec<usize> = vec![0; b.len() + 1];
    for ca in a {
        for (j, cb) in b.iter().enumerate() {
            cur[j + 1] = if ca == cb {
                prev[j] + 1
            } else {
                prev[j + 1].max(cur[j])
            };
        }
        std::mem::swap(&mut prev, &mut cur);
    }
    prev[b.len()]
}

fn lcs_ratio(a: &[char], b: &[char]) -> f64 {
    let max = a.len().max(b.len());
    if max == 0 {
        return 1.0;
    }
    lcs_length(a, b) as f64 / max as f64
}

fn bigram_set(chars: &[char]) -> Vec<[char; 2]> {
    if chars.len() < 2 {
        return vec![];
    }
    let mut grams: Vec<[char; 2]> = chars.windows(2).map(|w| [w[0], w[1]]).collect();
    grams.sort_unstable();
    grams.dedup();
    grams
}

fn bigram_dice(a: &[char], b: &[char]) -> f64 {
    let ga = bigram_set(a);
    let gb = bigram_set(b);
    if ga.is_empty() && gb.is_empty() {
        return 1.0;
    }
    if ga.is_empty() || gb.is_empty() {
        return 0.0;
    }
    let (mut i, mut j, mut common) = (0usize, 0usize, 0usize);
    while i < ga.len() && j < gb.len() {
        match ga[i].cmp(&gb[j]) {
            std::cmp::Ordering::Less => i += 1,
            std::cmp::Ordering::Greater => j += 1,
            std::cmp::Ordering::Equal => {
                common += 1;
                i += 1;
                j += 1;
            }
        }
    }
    2.0 * common as f64 / (ga.len() + gb.len()) as f64
}

// ────────────────────────────── 个人对照表 ──────────────────────────────

/// 对照表落盘于本机数据目录（`header_aliases.json`），记录「源列名→标准列名」
/// 的人工配对，下次匹配直接按机器绿采信。任何读写失败都静默降级——对照表
/// 是锦上添花，不能拖垮主流程。
pub(crate) fn alias_file_path() -> Option<PathBuf> {
    directories::ProjectDirs::from("com", "AuditToolbox", "AuditToolbox")
        .map(|dirs| dirs.data_local_dir().join("header_aliases.json"))
}

pub(crate) fn load_aliases() -> Vec<(String, String)> {
    alias_file_path()
        .map(|path| load_aliases_from(&path))
        .unwrap_or_default()
}

pub(crate) fn save_aliases(pairs: &[(String, String)]) {
    let Some(path) = alias_file_path() else {
        return;
    };
    save_aliases_to(&path, pairs);
}

/// 删除一条人工对照（拖错又勾了记住的场景）；返回删除后的清单。
pub(crate) fn delete_alias(source: &str, target: &str) -> Vec<(String, String)> {
    alias_file_path()
        .map(|path| delete_alias_at(&path, source, target))
        .unwrap_or_default()
}

/// 读写落在指定路径上，真实数据目录与测试临时目录共用同一套逻辑。
fn load_aliases_from(path: &std::path::Path) -> Vec<(String, String)> {
    let Ok(raw) = std::fs::read_to_string(path) else {
        return Vec::new();
    };
    let Ok(value) = serde_json::from_str::<Value>(&raw) else {
        return Vec::new();
    };
    value
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    let source = item.get("source")?.as_str()?.trim().to_string();
                    let target = item.get("target")?.as_str()?.trim().to_string();
                    if source.is_empty() || target.is_empty() {
                        return None;
                    }
                    Some((source, target))
                })
                .collect()
        })
        .unwrap_or_default()
}

fn save_aliases_to(path: &std::path::Path, pairs: &[(String, String)]) {
    let mut existing = load_aliases_from(path);
    for pair in pairs {
        if !existing
            .iter()
            .any(|(source, target)| source == &pair.0 && target == &pair.1)
        {
            existing.push(pair.clone());
        }
    }
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let value = json!(
        existing
            .iter()
            .map(|(source, target)| json!({"source": source, "target": target}))
            .collect::<Vec<_>>()
    );
    let _ = std::fs::write(path, value.to_string());
}

fn delete_alias_at(path: &std::path::Path, source: &str, target: &str) -> Vec<(String, String)> {
    let mut existing = load_aliases_from(path);
    let before = existing.len();
    existing.retain(|(s, t)| !(s == source && t == target));
    if existing.len() != before {
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let value = json!(
            existing
                .iter()
                .map(|(s, t)| json!({"source": s, "target": t}))
                .collect::<Vec<_>>()
        );
        let _ = std::fs::write(path, value.to_string());
    }
    existing
}

// ────────────────────────────── 合并计划 ──────────────────────────────

/// 前端匹配网格确认后回传的最终映射，`merge` 纵向路径按它重排列。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HeaderMatchingPlan {
    pub template_path: String,
    pub template_headers: Vec<String>,
    /// 勾选「记住本次手动对应关系」时携带的人工配对，合并成功后写入对照表。
    #[serde(default)]
    pub remember_aliases: Vec<(String, String)>,
    pub assignments: Vec<FileAssignment>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FileAssignment {
    pub path: String,
    pub sheet: String,
    pub header_row: usize,
    pub header_rows_count: usize,
    /// 该文件拍平后的表头（含独立列名，供重排与日志使用）。
    pub headers: Vec<String>,
    /// 未匹配（独立）列在匹配网格未匹配区里的用户排序（源列下标）。
    /// 决定独立列在合并输出中的先后；未列出的列按源顺序垫后。
    #[serde(default)]
    pub independent_order: Vec<usize>,
    pub columns: Vec<ColumnDecision>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ColumnDecision {
    pub source: usize,
    /// 模板列下标；`None` = 未匹配（默认保留为独立列）。
    pub target: Option<usize>,
    #[serde(default)]
    pub discard: bool,
    #[serde(default)]
    pub manual: bool,
    #[serde(default)]
    pub reason: String,
}

fn plan_error(message: &str) -> AppError {
    AppError::new("INVALID_HEADER_PLAN", message.to_string(), false, None)
}

/// 校验合并计划：模板列下标不越界、源列下标不越界、同一文件内一列只投一处。
/// 前端状态坏了（或参数被手改坏）必须在这里拦住，不能让错位数据悄悄落盘。
pub(crate) fn validate_plan(plan: &HeaderMatchingPlan) -> Result<(), AppError> {
    if plan.template_headers.is_empty() {
        return Err(plan_error("智能表头匹配缺少模板列。"));
    }
    if plan.assignments.is_empty() {
        return Err(plan_error("智能表头匹配没有可执行的映射。"));
    }
    let template_len = plan.template_headers.len();
    for assignment in &plan.assignments {
        let mut taken = HashSet::new();
        for column in &assignment.columns {
            if column.source >= assignment.headers.len() {
                return Err(plan_error(&format!(
                    "映射的源列超出 {} 的表头范围。",
                    assignment.path
                )));
            }
            if let Some(target) = column.target {
                if target >= template_len || !taken.insert(target) {
                    return Err(plan_error(&format!(
                        "{} 的「{}」映射到了无效或重复的标准列。",
                        assignment.path, assignment.headers[column.source]
                    )));
                }
            }
        }
    }
    Ok(())
}

// ────────────────────────────── 单元测试 ──────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 通用表头合并工具排除重复标题() {
        let sheet = vec![
            vec!["记账凭证明细查询".into(); 6],
            vec![
                "日期".into(),
                "凭证号".into(),
                "科目编码".into(),
                "摘要".into(),
                "借方金额".into(),
                "贷方金额".into(),
            ],
            vec![
                "2026-01-04".into(),
                "001".into(),
                "1001".into(),
                "收款".into(),
                "100".into(),
                "0".into(),
            ],
        ];
        let detected = detect_header_with_merges(&sheet, &[(0, 0, 0, 5)]).unwrap();
        assert_eq!((detected.header_row, detected.header_rows_count), (1, 1));
    }

    fn rows(input: &[&[&str]]) -> Vec<Vec<String>> {
        input
            .iter()
            .map(|row| row.iter().map(|v| v.to_string()).collect())
            .collect()
    }

    #[test]
    fn detects_header_on_first_row() {
        let sheet = rows(&[
            &["日期", "凭证号", "摘要", "金额"],
            &["2026-01-01", "记-001", "提现", "1000.00"],
            &["2026-01-02", "记-002", "报销", "250.50"],
        ]);
        let detection = detect_header(&sheet).unwrap();
        assert_eq!(detection.header_row, 0);
        assert_eq!(detection.header_rows_count, 1);
        assert!(!detection.needs_review);
    }

    #[test]
    fn detects_header_after_title_rows() {
        let sheet = rows(&[
            &["XX公司2026年度明细账"],
            &["单位：元"],
            &["日期", "凭证号", "摘要", "借方金额", "贷方金额"],
            &["2026-01-01", "记-001", "提现", "1000.00", ""],
            &["2026-01-02", "记-002", "报销", "", "250.50"],
        ]);
        let detection = detect_header(&sheet).unwrap();
        assert_eq!(detection.header_row, 2);
        assert_eq!(detection.header_rows_count, 1);
    }

    #[test]
    fn detects_two_layer_header() {
        let sheet = rows(&[
            &["2026年明细账"],
            &["日期", "凭证号", "金额", "", "", "余额"],
            &["", "", "借方", "贷方", "合计", ""],
            &["2026-01-01", "记-001", "100.00", "", "100.00", "500.00"],
            &["2026-01-02", "记-002", "", "80.00", "80.00", "580.00"],
        ]);
        let detection = detect_header(&sheet).unwrap();
        assert_eq!(detection.header_row, 1);
        assert_eq!(detection.header_rows_count, 2);
        let flat = flatten_two_layer(&sheet[1], &sheet[2]);
        assert_eq!(
            flat,
            vec![
                "日期",
                "凭证号",
                "金额-借方",
                "金额-贷方",
                "金额-合计",
                "余额"
            ]
        );
    }

    #[test]
    fn flatten_fills_parent_rightward_until_next_parent() {
        // 合并单元格只有左上角有值：父级向右填充到下一个非空父级为止。
        let first = ["基本信息", "", "", "金额"]
            .iter()
            .map(|v| v.to_string())
            .collect::<Vec<_>>();
        let second = ["日期", "编号", "名称", "本币"]
            .iter()
            .map(|v| v.to_string())
            .collect::<Vec<_>>();
        let flat = flatten_two_layer(&first, &second);
        assert_eq!(
            flat,
            vec![
                "基本信息-日期",
                "基本信息-编号",
                "基本信息-名称",
                "金额-本币"
            ]
        );
    }

    #[test]
    fn matches_exact_alias_and_dictionary() {
        let template = vec!["日期".into(), "凭证号".into(), "借方金额".into()];
        let headers = vec!["记账日期".into(), "单据编号".into(), "借方发生额".into()];
        let matches = match_columns(&template, &headers, &[]);
        assert_eq!(matches[0].target, Some(0));
        assert_eq!(matches[1].target, Some(1));
        assert_eq!(matches[2].target, Some(2));
        assert!(matches.iter().all(|m| m.confidence >= 0.92));
    }

    #[test]
    fn personal_dictionary_wins_as_green() {
        let template = vec!["凭证号".into()];
        let headers = vec!["单据编号".into()];
        let matches = match_columns(&template, &headers, &[("单据编号".into(), "凭证号".into())]);
        assert_eq!(matches[0].target, Some(0));
        assert_eq!(matches[0].reason, "我的对照表");
    }

    #[test]
    fn similarity_is_only_a_suggestion() {
        let template = vec!["借贷方向".into()];
        let headers = vec!["借货方向".into()];
        let matches = match_columns(&template, &headers, &[]);
        assert_eq!(matches[0].target, Some(0));
        assert!(matches[0].confidence < 0.92, "相似度再高也不能当机器绿");
    }

    #[test]
    fn opposite_terms_never_match_by_similarity() {
        let template = vec!["借方金额".into(), "贷方金额".into()];
        let headers = vec!["贷方金额".into(), "借方金额".into()];
        let matches = match_columns(&template, &headers, &[]);
        // 名称一致最强，正常一对一占位，而不是被相似度交叉错配。
        assert_eq!(matches[0].target, Some(1));
        assert_eq!(matches[1].target, Some(0));

        let cases: &[(&str, &str)] = &[
            ("应收账款", "应付账款"),
            ("原币金额", "本位币金额"),
            ("本位币金额", "原币金额"),
            ("含税金额", "不含税金额"),
            ("不含税金额", "含税金额"),
        ];
        for (t, h) in cases {
            let matches = match_columns(
                std::slice::from_ref(&t.to_string()),
                std::slice::from_ref(&h.to_string()),
                &[],
            );
            assert!(
                matches[0].target.is_none(),
                "「{t}」与「{h}」一个字之差口径全反，必须拦下"
            );
        }
        // 超集词不能误伤：两个「不含税」之间仍是名称一致。
        let same = match_columns(
            &["不含税金额".to_string()],
            &["不含税金额".to_string()],
            &[],
        );
        assert_eq!(same[0].target, Some(0));
    }

    #[test]
    fn bilingual_header_segment_match() {
        let template = vec!["过账日期".into()];
        let headers = vec!["过账日期\nPosting Date".into()];
        let matches = match_columns(&template, &headers, &[]);
        assert_eq!(matches[0].target, Some(0));
        assert_eq!(matches[0].reason, "表头分段一致");
    }

    #[test]
    fn greedy_assignment_prefers_high_scores() {
        let template = vec!["金额".into(), "借方金额".into()];
        let headers = vec!["借方金额".into(), "金额".into()];
        let matches = match_columns(&template, &headers, &[]);
        assert_eq!(matches[0].target, Some(1));
        assert_eq!(matches[1].target, Some(0));
    }

    #[test]
    fn validate_plan_rejects_out_of_range_target() {
        let plan = HeaderMatchingPlan {
            template_path: "a.xlsx".into(),
            template_headers: vec!["日期".into()],
            remember_aliases: vec![],
            assignments: vec![FileAssignment {
                path: "b.xlsx".into(),
                sheet: "Sheet1".into(),
                header_row: 0,
                header_rows_count: 1,
                headers: vec!["日期".into()],
                independent_order: vec![],
                columns: vec![ColumnDecision {
                    source: 0,
                    target: Some(5),
                    discard: false,
                    manual: false,
                    reason: String::new(),
                }],
            }],
        };
        assert!(validate_plan(&plan).is_err());
    }

    #[test]
    fn alias_roundtrip_and_dedupe() {
        // save/load 直接落真实数据目录不合适，这里用注入的临时路径走同一套
        // 落盘/去重/删除逻辑——此前本测试只断言了 JSON 字符串格式，零覆盖。
        let dir = std::env::temp_dir().join(format!("alias-store-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("aliases.json");
        let _ = std::fs::remove_file(&path);

        save_aliases_to(&path, &[("单据编号".into(), "凭证号".into())]);
        // 同源同目标重复入库应去重；同源不同目标应并存。
        save_aliases_to(&path, &[("单据编号".into(), "凭证号".into())]);
        save_aliases_to(&path, &[("单据编号".into(), "凭证日期".into())]);
        assert_eq!(
            load_aliases_from(&path),
            vec![
                ("单据编号".to_string(), "凭证号".to_string()),
                ("单据编号".to_string(), "凭证日期".to_string()),
            ]
        );

        let after_delete = delete_alias_at(&path, "单据编号", "凭证号");
        assert_eq!(after_delete.len(), 1);
        assert_eq!(
            load_aliases_from(&path),
            after_delete,
            "删除应即时落盘，回读与返回清单一致"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
