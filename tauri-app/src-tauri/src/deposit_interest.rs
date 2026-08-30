//! Native deposit interest audit engine.
//!
//! 口径与判断都放在 Rust 侧：UI 只负责收集映射和用户覆盖的利率，
//! 月度余额还原、月均余额、利息测算和与 TB 利息收入的勾稽都在这里完成。
//!
//! 上传、Sheet/标题行识别和 JE-vs-TB 自动判定直接复用汇兑损益工具的
//! `fx::load_fx_table` / `fx::classify_source`，因此两个工具的上传与映射
//! 交互完全一致；本模块只提供存款利息自己的字段词典与业务口径。
use crate::ledger_mapping;
use crate::{
    AppError,
    excel_merger::PauseCheckpoint,
    fx::{FxTable, SourceSpec, classify_source, load_fx_table, normalize_header, parse_date},
};
use chrono::{Datelike, Local, NaiveDate};
use rust_xlsxwriter::{Format, FormatAlign, FormatBorder, Formula, Workbook, Worksheet, XlsxError};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use std::{
    collections::{BTreeMap, BTreeSet, HashSet},
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};

fn error(code: &str, message: impl Into<String>, detail: Option<String>) -> AppError {
    AppError::new(code, message, false, detail)
}

// ---------------------------------------------------------------------------
// 内置存款利率档位库
// ---------------------------------------------------------------------------

/// 央行基准存款利率自 2015-10-24 起未再调整；挂牌参考值取国有大行 2025-05-20
/// 调整后的水平。两者都只是"合理性参照"，实际计息利率以存款协议/对账单为准，
/// 所以每一档都可以在界面和导出的 Excel 里被覆盖。
pub(crate) const PBC_BENCHMARK_DATE: &str = "2015-10-24";
pub(crate) const LISTED_REFERENCE_DATE: &str = "2025-05-20";

pub(crate) struct Tier {
    pub(crate) key: &'static str,
    pub(crate) category: &'static str,
    pub(crate) category_label: &'static str,
    /// 空串表示该大类没有期限之分（活期、协定、自定义）。
    pub(crate) term_label: &'static str,
    /// 央行基准。**只作合理性上限参照，不参与测算**——3 年期基准 2.75% 对比
    /// 实际 1.25%，拿它算会把利息放大一倍以上。`None` 表示央行从未公布该档。
    pub(crate) benchmark: Option<f64>,
    /// 国有大行挂牌参考值。
    pub(crate) listed: Option<f64>,
    /// 是否自动套用默认利率。**只有活期为 true**：对公活期没有议价空间，
    /// 挂牌值覆盖绝大多数情况；定期/协定/大额存单的利率是逐笔合同约定的，
    /// 自动填一个"看着合理"的数只会让人直接采信，必须由用户填实际利率。
    pub(crate) auto_apply: bool,
    /// 实务中常见区间（下限, 上限）——不是权威数据，只用于提示利率是否离谱。
    pub(crate) practice: Option<(f64, f64)>,
    pub(crate) practice_note: &'static str,
}

#[allow(clippy::too_many_arguments)]
const fn tier(
    key: &'static str,
    category: &'static str,
    category_label: &'static str,
    term_label: &'static str,
    benchmark: Option<f64>,
    listed: Option<f64>,
    auto_apply: bool,
    practice: Option<(f64, f64)>,
    practice_note: &'static str,
) -> Tier {
    Tier {
        key,
        category,
        category_label,
        term_label,
        benchmark,
        listed,
        auto_apply,
        practice,
        practice_note,
    }
}

// 参数顺序：档位键, 大类键, 大类名, 期限名, 央行基准, 大行挂牌, 是否自动套用, 实务区间, 实务说明
const RATE_TIERS: &[Tier] = &[
    tier(
        "demand",
        "demand",
        "活期存款",
        "",
        Some(0.0035),
        Some(0.0005),
        true,
        Some((0.0005, 0.0035)),
        "对公活期几乎没有议价空间，国有大行普遍就是挂牌 0.05%；老协议里仍挂 0.35% 的情况也见得到。这是唯一自动套用默认利率的档位。",
    ),
    tier(
        "agreement",
        "agreement",
        "协定存款",
        "",
        Some(0.0115),
        Some(0.0020),
        false,
        Some((0.0020, 0.0150)),
        "挂牌与实际差最大的一档。超出约定留存额的部分按协定利率计息，大客户议价后普遍高于挂牌，务必看协议。",
    ),
    tier(
        "notice_1d",
        "notice",
        "通知存款",
        "1天",
        Some(0.0080),
        Some(0.0010),
        false,
        Some((0.0010, 0.0045)),
        "2024 年 5 月起银行下调通知存款利率并取消自律上限加点，实际水平明显低于央行基准。",
    ),
    tier(
        "notice_7d",
        "notice",
        "通知存款",
        "7天",
        Some(0.0135),
        Some(0.0055),
        false,
        Some((0.0055, 0.0100)),
        "企业闲置资金最常用的一档；股份制银行和城商行通常高于国有大行。",
    ),
    tier(
        "term_3m",
        "term",
        "定期存款",
        "3个月",
        Some(0.0110),
        Some(0.0065),
        false,
        Some((0.0065, 0.0110)),
        "股份制银行、城商行普遍在大行挂牌上加 20~40BP。",
    ),
    tier(
        "term_6m",
        "term",
        "定期存款",
        "6个月",
        Some(0.0130),
        Some(0.0085),
        false,
        Some((0.0085, 0.0130)),
        "股份制银行、城商行普遍在大行挂牌上加 20~40BP。",
    ),
    tier(
        "term_1y",
        "term",
        "定期存款",
        "1年",
        Some(0.0150),
        Some(0.0095),
        false,
        Some((0.0095, 0.0150)),
        "最常见的企业定存期限；中小银行 1 年期做到 1.3%~1.5% 并不少见。",
    ),
    tier(
        "term_2y",
        "term",
        "定期存款",
        "2年",
        Some(0.0210),
        Some(0.0105),
        false,
        Some((0.0105, 0.0160)),
        "期限越长，挂牌与中小银行报价的差距越大。",
    ),
    tier(
        "term_3y",
        "term",
        "定期存款",
        "3年",
        Some(0.0275),
        Some(0.0125),
        false,
        Some((0.0125, 0.0190)),
        "央行基准 2.75% 已严重脱离实际，只能当上限参照；拿它测算会把利息放大一倍以上。",
    ),
    tier(
        "term_5y",
        "term",
        "定期存款",
        "5年",
        None,
        Some(0.0130),
        false,
        Some((0.0130, 0.0200)),
        "央行从未公布 5 年期存款基准；部分银行 5 年期报价甚至低于 3 年期。",
    ),
    tier(
        "cd_1y",
        "large_cd",
        "大额存单",
        "1年",
        None,
        Some(0.0110),
        false,
        Some((0.0100, 0.0140)),
        "大额存单通常比同期定存高 10~25BP，按 20 万/100 万/1000 万起存分档，起存越高利率越高。",
    ),
    tier(
        "cd_2y",
        "large_cd",
        "大额存单",
        "2年",
        None,
        Some(0.0120),
        false,
        Some((0.0110, 0.0155)),
        "大额存单通常比同期定存高 10~25BP。",
    ),
    tier(
        "cd_3y",
        "large_cd",
        "大额存单",
        "3年",
        None,
        Some(0.0140),
        false,
        Some((0.0130, 0.0185)),
        "部分国有大行已阶段性停发 3 年期大额存单，若账上有则多为往年存续单。",
    ),
    tier(
        "custom",
        "custom",
        "自定义（按存款协议）",
        "",
        None,
        None,
        false,
        None,
        "外币存款、结构性存款、保证金存款等不适用人民币挂牌档位，请直接填对账单上的实际利率。",
    ),
];

/// 挂牌利率超过这个月龄就提醒用户核对——挂牌利率每年动一到两次，
/// 一个过期的默认值比没有默认值更危险。
const RATE_STALE_AFTER_MONTHS: i64 = 12;

fn listed_rate_age_months() -> i64 {
    let Some(base) = NaiveDate::parse_from_str(LISTED_REFERENCE_DATE, "%Y-%m-%d").ok() else {
        return 0;
    };
    let today = Local::now().date_naive();
    (i64::from(today.year()) - i64::from(base.year())) * 12
        + (i64::from(today.month()) - i64::from(base.month()))
}

/// 利率查询的官方入口。这是一份**白名单**：`open_reference_url` 只放行这里
/// 列出的地址，前端不能借这条命令打开任意 URL。只给栏目级入口，不写死可能
/// 失效的深层链接。
pub(crate) const REFERENCE_LINKS: &[(&str, &str, &str, &str)] = &[
    (
        "中国人民银行",
        "http://www.pbc.gov.cn/",
        "「货币政策」—「货币政策工具」—利率政策，可查《金融机构人民币存款基准利率调整表》",
        "official",
    ),
    (
        "中国货币网（全国银行间同业拆借中心）",
        "https://www.chinamoney.com.cn/",
        "市场利率定价自律机制的存款利率相关公告发布渠道",
        "official",
    ),
    (
        "国家外汇管理局",
        "https://www.safe.gov.cn/",
        "外币存款相关政策与人民币汇率中间价查询",
        "official",
    ),
    (
        "中国工商银行",
        "https://www.icbc.com.cn/",
        "首页搜索「人民币存款利率」查当前挂牌利率表",
        "bank",
    ),
    (
        "中国建设银行",
        "http://www.ccb.com/",
        "首页搜索「人民币存款利率」查当前挂牌利率表",
        "bank",
    ),
    (
        "中国农业银行",
        "https://www.abchina.com/",
        "首页搜索「人民币存款利率」查当前挂牌利率表",
        "bank",
    ),
    (
        "中国银行",
        "https://www.boc.cn/",
        "首页搜索「人民币存款利率」查当前挂牌利率表",
        "bank",
    ),
    (
        "交通银行",
        "https://www.bankcomm.com/",
        "首页搜索「人民币存款利率」查当前挂牌利率表",
        "bank",
    ),
    (
        "招商银行",
        "https://www.cmbchina.com/",
        "股份制银行报价通常高于国有大行，可作为区间上沿参照",
        "bank",
    ),
];

pub(crate) fn is_reference_url(url: &str) -> bool {
    REFERENCE_LINKS.iter().any(|link| link.1 == url)
}

fn find_tier(key: &str) -> Option<&'static Tier> {
    RATE_TIERS.iter().find(|tier| tier.key == key)
}

/// 认不出的档位键一律按活期兜底——活期是货币资金里占比最高、也最保守的一档；
/// 兜到"自定义"只会让界面上冒出一个用户没选过的大类。
fn tier_or_demand(key: &str) -> &'static Tier {
    find_tier(key).unwrap_or(&RATE_TIERS[0])
}

pub(crate) fn tier_label(key: &str) -> String {
    let tier = tier_or_demand(key);
    if tier.term_label.is_empty() {
        tier.category_label.to_string()
    } else {
        format!("{}（{}）", tier.category_label, tier.term_label)
    }
}

/// 某一档的挂牌参考利率，用于界面展示。**注意这不等于"会被自动套用"**——
/// 只有 `auto_rate` 返回 Some 的档位才会自动填进测算。
pub(crate) fn tier_rate(key: &str) -> Option<f64> {
    find_tier(key)?.listed
}

/// 自动套用的默认利率。只有活期有；其余档位一律返回 None，逼着用户
/// 去存款协议/对账单上取实际利率，避免一个"看着合理"的数被直接采信。
pub(crate) fn auto_rate(key: &str) -> Option<f64> {
    let tier = find_tier(key)?;
    tier.auto_apply.then_some(tier.listed).flatten()
}

/// 央行基准，**仅作合理性上限参照**，不参与任何测算。
pub(crate) fn benchmark_rate(key: &str) -> Option<f64> {
    find_tier(key)?.benchmark
}

/// 从科目名称/辅助核算文字推断存款档位，并把命中的关键字回传，
/// 好让界面和底稿都能说清楚"为什么判成这一档"。
/// 判断不出来时按活期处理——活期是货币资金里占比最高也最保守的一档。
/// 从科目名称/币种字段里认外币。SAP 的科目名普遍带币种前缀
/// （USD BOA CPCSC Cash / RMB CMB CPCSC SH），这是最可靠的线索。
pub(crate) fn detect_foreign_currency(text: &str) -> Option<&'static str> {
    let value = normalize_header(text);
    [
        "usd", "eur", "jpy", "hkd", "gbp", "aud", "sgd", "chf", "cad", "krw", "twd", "myr", "thb",
    ]
    .into_iter()
    .find(|code| value.contains(code))
}

pub(crate) fn suggest_tier(text: &str) -> (&'static str, String) {
    // 外币存款不适用人民币挂牌档位——美元户按 0.05% 人民币活期算会严重低估。
    // 大类仍按活期兜底（认不出类型时统一落活期），但 [`resolve_rate`] 不会
    // 给外币户自动套用人民币挂牌利率，必须由用户填对账单上的实际利率。
    if let Some(code) = detect_foreign_currency(text) {
        return (
            "demand",
            format!(
                "科目为 {} 外币户，人民币挂牌利率不适用，大类按活期兜底，请按对账单填实际利率",
                code.to_uppercase()
            ),
        );
    }
    let value = normalize_header(text);
    let hit = |words: &[&'static str]| words.iter().find(|word| value.contains(**word)).copied();
    let term = |words: &[&'static str]| hit(words).is_some();
    if let Some(word) = hit(&["大额存单", "存单"]) {
        let key = if term(&["三年", "3年"]) {
            "cd_3y"
        } else if term(&["两年", "2年"]) {
            "cd_2y"
        } else {
            "cd_1y"
        };
        return (key, format!("命中关键字“{word}”"));
    }
    if let Some(word) = hit(&["协定存款", "协定"]) {
        return ("agreement", format!("命中关键字“{word}”"));
    }
    if let Some(word) = hit(&["通知存款", "通知"]) {
        let key = if term(&["1天", "一天", "1日", "隔夜"]) {
            "notice_1d"
        } else {
            "notice_7d"
        };
        return (key, format!("命中关键字“{word}”"));
    }
    if let Some(word) = hit(&["定期存款", "定期", "整存整取", "时点存款"]) {
        let key = if term(&["三个月", "3个月", "3m", "季度"]) {
            "term_3m"
        } else if term(&["六个月", "6个月", "半年", "6m"]) {
            "term_6m"
        } else if term(&["两年", "2年", "2y"]) {
            "term_2y"
        } else if term(&["三年", "3年", "3y"]) {
            "term_3y"
        } else if term(&["五年", "5年", "5y"]) {
            "term_5y"
        } else {
            "term_1y"
        };
        return (key, format!("命中关键字“{word}”"));
    }
    ("demand", "未命中期限关键字，默认按活期".to_string())
}

// ---------------------------------------------------------------------------
// 科目分类
// ---------------------------------------------------------------------------

/// 存款利息测算只关心两类科目：计息的货币资金，和用来勾稽的利息收入。
/// 库存现金单列，因为它属于货币资金但不计息，默认不参与测算。
///
/// 判断顺序很重要，先排除干扰项再认存款：SAP 里 "Bank Service Charges"
/// （银行手续费，费用类）和 "Shdw All Bnk Cl Acct"（影子/清算科目）都含
/// bank/bnk，直接按关键字认会把它们错当成银行存款。
pub(crate) fn suggest_account_role(account: &str) -> &'static str {
    let value = normalize_header(account);
    let code = account_code(account);
    let has = |words: &[&str]| words.iter().any(|word| value.contains(word));

    // 只因名字含"利息收入"就当勾稽基准会认错两类科目，都要先挡掉：
    //
    // 1. **投资收益**（6111）核算的是金融资产投资的回报，不是存款利息。存款利息
    //    对企业而言记在财务费用里，挂投资收益的（理财、结构性存款）其本金也不在
    //    货币资金，两边都不该进这个测算。
    // 2. **内部／关联方利息**是资金拆借的往来利息；往来科目在存款侧已被排除，
    //    收入侧再计入，估算与基准覆盖的就不是同一批科目，必然对不上。
    //
    // 真实 4800 账套里「投资收益-内部利息收入」两条都占，把基准撑大了 62,337.51。
    // 资金池等确需纳入的情形，用户在科目分类里逐个改回即可。
    let not_deposit_interest = code.starts_with("6111")
        || has(&[
            "投资收益",
            "投資收益",
            "内部",
            "關聯",
            "关联",
            "拆借",
            "委托贷款",
            "委託貸款",
            "intercompany",
            "intragroup",
            "relatedparty",
        ]);

    // 利息收入：中国科目表 6051，SAP 常见 "Int Income" / "Interest Income"。
    if !not_deposit_interest
        && (code.starts_with("6051")
            || has(&[
                "利息收入",
                "利息收益",
                "存款利息",
                "interestincome",
                "intincome",
                "interestinc",
                "interestrevenue",
                "intinc-",
                "interestearned",
            ]))
    {
        return "interest_income";
    }

    // 明确不是存款的干扰项，必须先挡掉。
    if has(&[
        "servicecharge",
        "bankcharge",
        "bankfee",
        "手续费",
        "银行费用",
        "shdw",
        "shadow",
        "影子",
        "clearingaccount",
        "现流项目",
        "现金流项目",
        "clacct",
        "clearing",
        "过渡",
        "清算",
        "fxval",
        "valuation",
        "重估",
        "interestpayable",
        "interestexpense",
        "利息支出",
        "应付利息",
        "应收利息",
    ]) {
        return "excluded";
    }

    // 科目性质护栏：会计科目首位 1=资产，2=负债，4=权益，5=成本，6=损益。
    // 没有这道闸，"其他应付款-销售保证金"这类负债科目会被关键字带成存款。
    if code
        .chars()
        .next()
        .is_some_and(|first| first.is_ascii_digit() && first != '1')
    {
        return "excluded";
    }

    // 先看科目名称，再退回编码前缀。名称是跨科目表通用的证据，而编码前缀
    // 只对中国科目表成立——SAP 的 6 位编码 100332 恰好以 "1003" 开头，
    // 但它是银行存款而不是其他货币资金。
    if has(&[
        "其他货币资金",
        "存出投资款",
        "定期存款",
        "通知存款",
        "协定存款",
        "大额存单",
        "保证金存款",
        "受限资金",
        "timedeposit",
        "termdeposit",
        "restrictedcash",
        "otherbankbalance",
        "depositcertificate",
        "notice deposit",
    ]) {
        return "other_monetary";
    }
    if has(&[
        "库存现金",
        "现金账户",
        "cashonhand",
        "cashinhand",
        "pettycash",
    ]) {
        return "cash_on_hand";
    }
    if has(&[
        "银行存款",
        "银行账户",
        "bankdeposit",
        "cashatbank",
        "bankbalance",
        "bankaccount",
        "bank",
        "bnk",
        "cash",
        "boc",
        "boa",
        "hsbc",
        "cmb",
        "icbc",
        "ccb",
        "abc",
        "citi",
        "citibank",
        "jpm",
        "scb",
        "dbs",
        "mufg",
        "spdb",
        "cib",
        "ceb",
    ]) {
        return "deposit";
    }

    // 名称给不出线索时才用中国科目表的一级编码。
    if code.starts_with("1001") {
        return "cash_on_hand";
    }
    if code.starts_with("1002") {
        return "deposit";
    }
    if code.starts_with("1003") || code.starts_with("1012") {
        return "other_monetary";
    }
    "excluded"
}

fn account_code(account: &str) -> &str {
    account
        .split_whitespace()
        .find(|token| {
            let digits = token.chars().filter(char::is_ascii_digit).count();
            // 科目编码是以数字为主的串，允许 "1002.01" 这类分隔符。
            digits >= 3
                && digits * 2 >= token.chars().count()
                && token.chars().next().is_some_and(|c| c.is_ascii_digit())
        })
        .or_else(|| account.split_whitespace().next())
        .filter(|token| !token.is_empty())
        .unwrap_or(account.trim())
}

fn role_for(account: &str, params: &Value) -> String {
    // 新版 UI 把自动预设与人工决定分开传入；只有人工决定才可挡住父项继承。
    // 旧任务没有 overrides 时仍将 accountRoles 视为人工决定，保留历史排除。
    let roles = params
        .get("accountRoleOverrides")
        .and_then(Value::as_object)
        .or_else(|| params.get("accountRoles").and_then(Value::as_object));
    if let Some(role) = roles
        .and_then(|values| values.get(account))
        .and_then(Value::as_str)
    {
        if role != "unassigned" {
            return role.to_owned();
        }
    }
    // 科目清单是识别时的快照，与测算行有两类天然错位：界面把 TB 与序时账
    // 两套拼法并进同一张分类表（4800 实况是两边全名相同的科目为 0），以及
    // 用户事后改过科目编码/名称的映射列。精确名对不上时按科目编码回退，
    // 与 `fx::role_for` 同一口径——否则用户在科目分类里手工指定的利息收入
    // 科目在测算时被悄悄丢掉，基准数又变回「未识别」。
    let code = account_code(account);
    if let Some(role) = roles.and_then(|values| {
        values.iter().find_map(|(candidate, role)| {
            (account_code(candidate) == code)
                .then(|| role.as_str())
                .flatten()
                .filter(|value| *value != "unassigned")
        })
    }) {
        return role.to_owned();
    }
    // 自动识别有结论（名称关键词或编码前缀命中）时相信它；判成 excluded 时
    // 再给一次「上级科目继承」：界面科目清单包含非末级汇总行，而测算只读
    // 末级——用户在「6603 财务费用」上选了利息收入，末级「66030101 …」
    // 应当继承，否则人工分类永远落空。
    let suggested = suggest_account_role(account);
    if suggested != "excluded" {
        return suggested.to_owned();
    }
    if let Some(role) = ledger_mapping::inherited_role_by_code_prefix(
        code,
        roles
            .into_iter()
            .flat_map(|values| values.iter())
            .filter_map(|(candidate, role)| role.as_str().map(|value| (candidate.as_str(), value))),
        account_code,
    ) {
        return role;
    }
    suggested.to_owned()
}

/// 科目确认页上的存款类型覆盖。全文因 TB/JE 拼法不同而对不上时按科目编码
/// 回退；没有人工覆盖时仍按科目名称/辅助核算预判，无法判断则默认活期。
fn tier_for<'a>(account: &str, auxiliary: &str, params: &'a Value) -> (&'a str, String) {
    let overrides = params
        .get("accountTierOverrides")
        .and_then(Value::as_object);
    let selected = overrides
        .and_then(|values| values.get(account))
        .and_then(Value::as_str)
        .or_else(|| {
            let code = account_code(account);
            overrides.and_then(|values| {
                values.iter().find_map(|(candidate, tier)| {
                    (account_code(candidate) == code)
                        .then(|| tier.as_str())
                        .flatten()
                })
            })
        });
    if let Some(tier) = selected.filter(|tier| find_tier(tier).is_some()) {
        return (tier, "用户在科目分类中指定存款类型".into());
    }
    let (tier, reason) = suggest_tier(&format!("{account} {auxiliary}"));
    (tier, reason)
}

fn is_deposit_role(role: &str) -> bool {
    matches!(role, "deposit" | "other_monetary" | "cash_on_hand")
}

// ---------------------------------------------------------------------------
// 字段词典
// ---------------------------------------------------------------------------

type Candidate = (String, f64, Vec<String>, Vec<String>);

/// (角色, 命中词, 冲突词)。冲突词命中会扣分，用来把"年初余额-借方"和
/// "年初余额"这类互相包含的表头分开。
/// 角色表来自统一内核，另加存款利息的两个专属角色。
///
/// 与旧版的实质差别：**科目编码与科目名称拆成两个角色**——旧版把它们混进一个
/// 多选的 `account`，用户看不出该填哪个。分类仍然需要「编码＋名称」的完整文本，
/// 由 [`account_columns`] 把两个角色的列合起来给它。
fn roles(kind: &str) -> Vec<(&'static str, Vec<&'static str>, Vec<&'static str>)> {
    let mut out: Vec<(&'static str, Vec<&'static str>, Vec<&'static str>)> =
        ledger_mapping::roles(kind)
            .iter()
            // 存款利息不启用原币口径，识别出来也不参与计算；
            // 币种线索文本是汇兑损益专用的，这里那一列要留给辅助核算。
            .filter(|role| !role.name.contains("Foreign") && role.name != "currencyText")
            .map(|role| (role.name, role.aliases.to_vec(), role.conflicts.to_vec()))
            .collect();
    // 辅助核算是存款利息的关键字段：靠它认存款档次（活期／定期／通知），
    // 再把序时账每一笔落到具体银行账户上。不进标准表，只在本工具启用。
    out.push((
        "auxiliary",
        vec![
            "辅助核算",
            "银行账号",
            "银行帐号",
            "账户",
            "明细项",
            "往来单位",
            "文本",
            "科目文本",
            "账户文本",
            "assignment",
            "profit center",
            "profitcenter",
            "成本中心",
            "财务项目",
        ],
        vec!["科目编码", "科目代码", "科目名称"],
    ));
    if kind == "je" {
        // 数量列用于识别计息天数之类的辅助信息，同样是本工具专属。
        out.push((
            "quantity",
            vec!["数量", "quantity", "menge"],
            vec!["金额", "amount"],
        ));
    } else {
        // 会计期间只在科目余额表上有用：没有日期列时靠它取年份。
        // 序时账侧一律走 date 列，所以标准表里没有这个角色。
        out.push((
            "period",
            vec![
                "会计期间",
                "期间",
                "所属期间",
                "年月",
                "period",
                "fiscalperiod",
            ],
            vec!["金额", "余额", "amount", "balance"],
        ));
    }
    out
}

/// 科目编码与科目名称的列合在一起——分类逻辑要看完整文本，
/// 只有编码时 SAP 的「100000」认不出是银行存款。
fn account_columns(table: &FxTable, mapping: &Map<String, Value>) -> Vec<usize> {
    let mut out = column_indexes(table, mapping, "accountCode");
    for index in column_indexes(table, mapping, "accountName") {
        if !out.contains(&index) {
            out.push(index);
        }
    }
    // 兼容历史映射：旧版把两者混在一个 account 里。
    if out.is_empty() {
        out = column_indexes(table, mapping, "account");
    }
    out.sort_unstable();
    out
}

/// 列名分不出「本年累计」与「本期发生」时，按金额量级重判：合计大的是本年累计。
/// 本工具的候选打分带列画像加权，映射不是内核直接产出的，所以在成型之后再过一道。
fn refine_layout(table: &FxTable, kind: &str, mapping: &mut Map<String, Value>) {
    let current: Vec<(String, String)> = mapping
        .iter()
        .filter_map(|(role, value)| {
            value
                .as_str()
                .map(|column| (role.clone(), column.to_string()))
        })
        .collect();
    for (role, column) in
        ledger_mapping::recheck_cumulative(kind, &table.headers, &table.rows, &current)
    {
        match column {
            Some(name) => {
                mapping.insert(role.to_string(), Value::String(name));
            }
            None => {
                mapping.remove(role);
            }
        }
    }
}

/// 一列只承载一个语义：同一列被多个角色选中时，分数高的留下。
///
/// 可多列的角色（科目名称、凭证识别字段）逐列参与——被挤掉时只丢那一列，
/// 丢光了才整个角色移除。
fn drop_column_conflicts(
    kind: &str,
    candidates: &BTreeMap<String, Vec<Candidate>>,
    mapping: &mut Map<String, Value>,
) {
    let score_of = |role: &str, column: &str| {
        candidates
            .get(role)
            .and_then(|all| all.iter().find(|c| c.0 == column))
            .map(|c| c.1)
            .unwrap_or(0.0)
    };
    let mut picks: Vec<(String, String, f64)> = Vec::new();
    for (role, value) in mapping.iter() {
        match value {
            Value::String(column) => {
                picks.push((role.clone(), column.clone(), score_of(role, column)))
            }
            Value::Array(columns) => {
                for column in columns.iter().filter_map(Value::as_str) {
                    picks.push((role.clone(), column.to_string(), score_of(role, column)));
                }
            }
            _ => {}
        }
    }
    for (role, column) in ledger_mapping::conflicting_roles(kind, &picks) {
        let drop_whole = match mapping.get_mut(&role) {
            Some(Value::Array(columns)) => {
                columns.retain(|x| x.as_str() != Some(column.as_str()));
                columns.is_empty()
            }
            _ => true,
        };
        if drop_whole {
            mapping.remove(&role);
        }
    }
}

/// 一个角色映射到的列名集合（单列是字符串、多列是数组，两种形状都收）。
fn suggest_mappings(table: &FxTable, kind: &str) -> BTreeMap<String, Vec<Candidate>> {
    let numeric = table
        .headers
        .iter()
        .enumerate()
        .map(|(index, _)| number_ratio(table, index))
        .collect::<Vec<_>>();
    let dated = table
        .headers
        .iter()
        .enumerate()
        .map(|(index, _)| date_ratio(table, index))
        .collect::<Vec<_>>();
    let mut out = BTreeMap::new();
    for (role, aliases, conflicts) in roles(kind) {
        let mut choices = table
            .headers
            .iter()
            .enumerate()
            .map(|(index, header)| {
                let value = normalize_header(header);
                // 双语表头「科目描述 Description」整体不等于别名，但其中一段正好是。
                let exact = aliases
                    .iter()
                    .filter(|alias| value == normalize_header(alias))
                    .map(|alias| (*alias).to_string())
                    .collect::<Vec<_>>();
                // 双语表头的某一段正好是别名：比「包含」可信，但不压过整体相等。
                let segment = aliases
                    .iter()
                    .filter(|alias| ledger_mapping::segment_exact(header, alias))
                    .map(|alias| (*alias).to_string())
                    .collect::<Vec<_>>();
                // 只允许"真实表头包含完整别名"，避免短别名反向扩散。
                let partial = aliases
                    .iter()
                    .filter(|alias| value.contains(&normalize_header(alias)))
                    .map(|alias| (*alias).to_string())
                    .collect::<Vec<_>>();
                let bad = conflicts
                    .iter()
                    .filter(|term| value.contains(&normalize_header(term)))
                    .map(|term| (*term).to_string())
                    .collect::<Vec<_>>();
                let mut score: f64 = if !exact.is_empty() {
                    0.94
                } else if !segment.is_empty() {
                    0.88
                } else if !partial.is_empty() {
                    0.72
                } else {
                    0.0
                };
                if role == "date" {
                    score += dated[index] * 0.12;
                }
                if role.contains("Amount") || role.contains("Debit") || role.contains("Credit") {
                    score += numeric[index] * 0.12;
                }
                // 冲突词是排除条件，不是扣分项——与内核和汇兑损益同口径：
                // 「冲销凭证号」含别名"凭证号"，按 0.35 一条扣分仍过得了 0.15
                // 的门槛，必须整条归零；预算／对方科目不得混进科目名称同理。
                if !bad.is_empty() {
                    score = 0.0;
                }
                (
                    header.clone(),
                    score.clamp(0.0, 1.0),
                    if exact.is_empty() { partial } else { exact },
                    bad,
                )
            })
            .filter(|choice| choice.1 > 0.15)
            .collect::<Vec<_>>();
        choices.sort_by(|a, b| b.1.total_cmp(&a.1));
        choices.truncate(3);
        out.insert(role.to_string(), choices);
    }
    out
}

fn number_ratio(table: &FxTable, index: usize) -> f64 {
    let values = sample(table, index);
    if values.is_empty() {
        return 0.0;
    }
    values
        .iter()
        .filter(|value| parse_number(value).is_some())
        .count() as f64
        / values.len() as f64
}

fn date_ratio(table: &FxTable, index: usize) -> f64 {
    let values = sample(table, index);
    if values.is_empty() {
        return 0.0;
    }
    values
        .iter()
        .filter(|value| parse_date(value).is_some())
        .count() as f64
        / values.len() as f64
}

fn sample(table: &FxTable, index: usize) -> Vec<&String> {
    table
        .rows
        .iter()
        .take(200)
        .filter_map(|row| row.get(index))
        .filter(|value| !value.trim().is_empty())
        .collect()
}

fn candidate_json(all: &BTreeMap<String, Vec<Candidate>>) -> Value {
    Value::Array(
        all.iter()
            .map(|(role, choices)| {
                json!({
                    "role": role,
                    "candidates": choices.iter().map(|choice| json!({
                        "column": choice.0, "confidence": choice.1,
                        "matchedTerms": choice.2, "conflictTerms": choice.3
                    })).collect::<Vec<_>>()
                })
            })
            .collect(),
    )
}

/// inspect 响应里的角色标签表：引擎当前认识的全部角色（标准名＋中文标签）。
///
/// 前端要把 `mappingCandidates`／`suggestedMapping` 里的英文标准名渲染成中文，
/// 此前只能自持一份「标准名→中文」对照表——引擎每加一个角色它就静默过期。
/// 这里把 [`ledger_mapping::roles`] 的全量快照直接下发，标签与
/// `missing_required` 返回的 `MissingRole.label` 同源（同一张 Role 表的
/// label 字段），本模块不自抄一份。注意两点口径：
///
/// 1. **全量不筛选**：本工具识别时会滤掉原币/币种线索角色，但标签表只做
///    查询用，多发几个用不到的角色无害，少了才是坑；
/// 2. 本工具自扩的 auxiliary／quantity／period 不在引擎表里、没有引擎标签，
///    不混进来——需要展示的由前端按自己的扩展角色处理。
fn engine_role_labels(kind: &str) -> Vec<Value> {
    ledger_mapping::roles(kind)
        .iter()
        .map(|role| json!({ "name": role.name, "label": role.label }))
        .collect()
}

// ---------------------------------------------------------------------------
// 命令入口
// ---------------------------------------------------------------------------

pub(crate) fn call(method: &str, params: Value) -> Result<Value, AppError> {
    match method {
        "deposit.classify_source" => classify_source(&params),
        "deposit.inspect_je" => inspect(&params, "je"),
        "deposit.inspect_tb" => inspect(&params, "tb"),
        "deposit.rate_tiers" => Ok(rate_tiers()),
        _ => Err(error(
            "METHOD_NOT_FOUND",
            "未找到存款利息业务方法。",
            Some(method.into()),
        )),
    }
}

pub(crate) fn run_job(
    method: &str,
    params: Value,
    progress: &dyn Fn(&str, usize, usize, &str),
    cancel: Arc<AtomicBool>,
    pause: &PauseCheckpoint,
) -> Result<Value, AppError> {
    if !matches!(method, "deposit.preview" | "deposit.export") {
        return Err(error(
            "METHOD_NOT_FOUND",
            "未找到存款利息任务方法。",
            Some(method.into()),
        ));
    }
    let total = if method == "deposit.export" { 4 } else { 3 };
    checkpoint(&cancel, pause)?;
    progress(
        "read",
        1,
        total,
        "正在读取 TB 并识别货币资金及利息收入科目…",
    );
    let mut result = calculate(&params, &cancel, pause, progress, total)?;
    checkpoint(&cancel, pause)?;
    if method == "deposit.export" {
        progress("export", 4, total, "正在生成存款利息审计底稿…");
        let path = export(&params, &result)?;
        result["outputPaths"] = json!([path.to_string_lossy()]);
    }
    Ok(result)
}

fn checkpoint(cancel: &AtomicBool, pause: &PauseCheckpoint) -> Result<(), AppError> {
    if cancel.load(Ordering::Relaxed) {
        return Err(error("JOB_CANCELLED", "任务已取消。", None));
    }
    pause.wait()
}

fn rate_tiers() -> Value {
    let age = listed_rate_age_months();
    let stale = age > RATE_STALE_AFTER_MONTHS;
    let mut categories: Vec<Value> = vec![];
    for tier in RATE_TIERS {
        if !categories
            .iter()
            .any(|item| item["key"] == json!(tier.category))
        {
            categories.push(json!({
                "key": tier.category, "label": tier.category_label,
                "terms": RATE_TIERS.iter().filter(|x| x.category == tier.category)
                    .map(|x| json!({"key": x.key, "label": x.term_label}))
                    .collect::<Vec<_>>()
            }));
        }
    }
    json!({
        "benchmarkDate": PBC_BENCHMARK_DATE,
        "listedDate": LISTED_REFERENCE_DATE,
        "benchmarkSource": format!(
            "中国人民银行《金融机构人民币存款基准利率调整表》，{PBC_BENCHMARK_DATE} 起执行，至今未再调整。**仅作合理性上限参照，不参与测算**——3 年期基准 2.75% 对比实际约 1.25%，拿它算会把利息放大一倍以上。"
        ),
        "listedSource": format!(
            "国有大型商业银行人民币存款挂牌利率，{LISTED_REFERENCE_DATE} 调整后水平；\
             2022 年建立存款利率市场化调整机制后，挂牌利率由各行自主报价并已多轮下调。"
        ),
        "practiceSource": "实务区间是常见报价范围的经验值，不是官方公布数据，仅用来提示填入的利率是否明显离谱。",
        "authority": "以上三组都只是默认值和合理性参照。审计依据应当是客户的存款协议、银行对账单或银行出具的利息清单。",
        "autoApplyPolicy": "只有活期自动套用默认利率——对公活期没有议价空间。协定、通知、定期、大额存单的利率逐笔合同约定，默认留空，须填入实际利率后才计入测算。",
        "listedRateDate": LISTED_REFERENCE_DATE,
        "rateAgeMonths": age,
        "ratesStale": stale,
        "staleMessage": if stale {
            format!(
                "内置挂牌利率最后更新于 {LISTED_REFERENCE_DATE}，距今约 {age} 个月，期间挂牌利率很可能已调整，请核对最新挂牌利率后再使用默认值。"
            )
        } else {
            String::new()
        },
        "links": REFERENCE_LINKS.iter()
            .map(|link| json!({"label": link.0, "url": link.1, "hint": link.2, "group": link.3}))
            .collect::<Vec<_>>(),
        "linkGroups": [
            {"key": "official", "label": "官方发布渠道", "hint": "基准利率与政策公告的权威出处，可直接作为底稿引用来源。"},
            {"key": "bank", "label": "各行挂牌利率表", "hint": "实际计息利率的参照；最终仍应以客户的存款协议或银行对账单为准。"}
        ],
        "categories": categories,
        "tiers": RATE_TIERS.iter().map(|tier| json!({
            "key": tier.key, "category": tier.category, "categoryLabel": tier.category_label,
            "termLabel": tier.term_label, "label": tier_label(tier.key),
            "benchmarkRate": tier.benchmark, "listedRate": tier.listed,
            "autoApply": tier.auto_apply,
            "practiceLow": tier.practice.map(|x| x.0), "practiceHigh": tier.practice.map(|x| x.1),
            "practiceNote": tier.practice_note
        })).collect::<Vec<_>>()
    })
}

fn inspect(params: &Value, kind: &str) -> Result<Value, AppError> {
    let source: SourceSpec = serde_json::from_value(
        params
            .get("source")
            .cloned()
            .unwrap_or_else(|| params.clone()),
    )
    .map_err(|e| error("INVALID_PARAMS", "文件参数不完整。", Some(e.to_string())))?;
    let table = load_fx_table(&source)?;
    let candidates = suggest_mappings(&table, kind);
    let mapping = candidates
        .iter()
        .filter_map(|(role, choices)| {
            if ledger_mapping::role_of(kind, role).is_some_and(|item| item.multi) {
                // 首选列按常规阈值收下，附加列才要求高置信度。
                let columns = choices
                    .iter()
                    .enumerate()
                    .filter(|(rank, choice)| choice.1 >= if *rank == 0 { 0.55 } else { 0.85 })
                    .map(|(_, choice)| Value::String(choice.0.clone()))
                    .collect::<Vec<_>>();
                (!columns.is_empty()).then(|| (role.clone(), Value::Array(columns)))
            } else {
                choices
                    .first()
                    .filter(|choice| choice.1 >= 0.55)
                    .map(|choice| (role.clone(), Value::String(choice.0.clone())))
            }
        })
        .collect::<Map<_, _>>();
    let mut mapping = mapping;
    refine_layout(&table, kind, &mut mapping);
    drop_column_conflicts(kind, &candidates, &mut mapping);
    // 合并科目列的兜底与汇兑损益共用同一份（判定在公共引擎、套用在 fx 侧），
    // 存款利息不再自持一份近似实现。
    crate::fx::fill_combined_account_column(kind, &table, &mut mapping);
    if kind == "tb" {
        crate::fx::promote_period_movement(&table, &mut mapping);
    }
    let mapping = mapping;
    let accounts = distinct_accounts(&table, &mapping);
    let entities = distinct_values(&table, &mapping, "entity");
    let years = data_years(&table, kind, &mapping);
    let close = table
        .header_candidates
        .get(1)
        .map(|next| table.header_candidates[0].1 - next.1 < 0.08)
        .unwrap_or(false);
    Ok(json!({
        "kind": kind, "path": table.path, "sheet": table.sheet, "sheets": table.sheets,
        "headerRow": table.header_row, "headerDepth": table.header_depth,
        "headerDetection": {
            "candidates": table.header_candidates.iter()
                .map(|x| json!({"row": x.0, "score": x.1})).collect::<Vec<_>>(),
            "needsConfirmation": close
        },
        "rawHeaders": table.raw_headers, "headers": table.headers,
        "preview": table.rows.iter().take(8).collect::<Vec<_>>(),
        "rowCount": table.rows.len(),
        "mappingCandidates": candidate_json(&candidates), "suggestedMapping": mapping,
        // 角色标签表与映射建议并列下发：前端用它把英文标准名渲染成中文，
        // 不再自持会过期的对照表（标签与引擎 MissingRole.label 同源）。
        "roles": engine_role_labels(kind),
        "entities": entities, "accounts": accounts,
        "suggestedAccountRoles": accounts.iter().map(|account|
            (account.clone(), Value::String(suggest_account_role(account).into()))
        ).collect::<Map<_, _>>(),
        "suggestedAccountTiers": accounts.iter().map(|account| {
            let (tier, _) = suggest_tier(account);
            (account.clone(), Value::String(tier.into()))
        }).collect::<Map<_, _>>(),
        "dataYears": years,
        "suggestedBalanceSheetDate": years.last().map(|year| format!("{year}-12-31"))
    }))
}

fn data_years(table: &FxTable, kind: &str, mapping: &Map<String, Value>) -> Vec<i32> {
    let mut years = BTreeSet::new();
    if kind == "je" {
        if let Some(index) = column_index(table, mapping, "date") {
            for row in &table.rows {
                if let Some(date) = row.get(index).and_then(|value| parse_date(value)) {
                    years.insert(date.year());
                }
            }
        }
    } else if let Some(index) = column_index(table, mapping, "period") {
        for row in &table.rows {
            let Some(value) = row.get(index) else {
                continue;
            };
            for token in value.split(|c: char| !c.is_ascii_digit()) {
                if token.len() == 4 {
                    if let Ok(year) = token.parse::<i32>() {
                        if (1900..=2200).contains(&year) {
                            years.insert(year);
                        }
                    }
                }
            }
        }
    }
    years.into_iter().collect()
}

fn distinct_values(table: &FxTable, mapping: &Map<String, Value>, role: &str) -> Vec<String> {
    let Some(index) = column_index(table, mapping, role) else {
        return vec![];
    };
    table
        .rows
        .iter()
        .filter_map(|row| row.get(index))
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .take(500)
        .collect()
}

fn distinct_accounts(table: &FxTable, mapping: &Map<String, Value>) -> Vec<String> {
    let indexes = account_columns(table, mapping);
    if indexes.is_empty() {
        return vec![];
    }
    table
        .rows
        .iter()
        .map(|row| join_columns(row, &indexes))
        .filter(|value| !value.is_empty())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .take(1000)
        .collect()
}

// ---------------------------------------------------------------------------
// 业务计算
// ---------------------------------------------------------------------------

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MonthCell {
    pub(crate) month: u32,
    pub(crate) opening: f64,
    pub(crate) debit: f64,
    pub(crate) credit: f64,
    pub(crate) closing: f64,
    pub(crate) average: f64,
    pub(crate) days: f64,
    pub(crate) denominator: f64,
    pub(crate) interest: f64,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AccountRow {
    pub(crate) key: String,
    pub(crate) entity: String,
    pub(crate) account: String,
    pub(crate) auxiliary: String,
    pub(crate) currency: String,
    pub(crate) role: String,
    pub(crate) tier: String,
    pub(crate) tier_label: String,
    pub(crate) category: String,
    pub(crate) term_label: String,
    pub(crate) tier_matched_by: String,
    pub(crate) rate_source: String,
    pub(crate) annual_rate: f64,
    /// false = 这一户还没有可用利率，测算利息不计入合计。
    pub(crate) rate_resolved: bool,
    /// 填入的利率高于该档央行基准时的提示（基准只作上限参照）。
    pub(crate) rate_warning: String,
    pub(crate) opening_balance: f64,
    /// 年初余额是否直接取自 TB。SAP 的 Trial Balance LC/GC 只有 MTD/YTD，
    /// 没有年初余额列，这时用"期末余额 − 全年发生额"倒推。
    pub(crate) opening_from_tb: bool,
    pub(crate) tb_closing_balance: f64,
    pub(crate) derived_closing_balance: f64,
    pub(crate) reconciliation_diff: f64,
    pub(crate) average_balance: f64,
    pub(crate) calculated_interest: f64,
    pub(crate) months: Vec<MonthCell>,
    pub(crate) status: String,
    pub(crate) note: String,
}

/// 月度利息 = 月均余额 × 年利率 × 计息天数 ÷ 年基数。
/// `month12` 把（天数=1，基数=12）代进同一个公式，导出的 Excel 因此
/// 只需要一条公式就能覆盖三种口径。
fn day_basis(params: &Value) -> (&'static str, &'static str) {
    match params.get("dayBasis").and_then(Value::as_str) {
        Some("actual360") => ("actual360", "实际天数/360（银行计息惯例）"),
        Some("actual365") => ("actual365", "实际天数/365"),
        _ => ("month12", "年利率÷12（按月平均）"),
    }
}

/// 测算期间覆盖的月份序列（按结束日所在年度）。跨年时只取结束年度的月份，
/// 与"资产负债表日所在会计年度"的口径一致。
fn month_range(start: NaiveDate, end: NaiveDate) -> Vec<u32> {
    let first = if start.year() == end.year() {
        start.month()
    } else {
        1
    };
    (first..=end.month()).collect()
}

fn month_days(basis: &str, year: i32, month: u32, start: NaiveDate, end: NaiveDate) -> (f64, f64) {
    if basis == "month12" {
        return (1.0, 12.0);
    }
    let first = NaiveDate::from_ymd_opt(year, month, 1).unwrap_or(start);
    let next = if month == 12 {
        NaiveDate::from_ymd_opt(year + 1, 1, 1)
    } else {
        NaiveDate::from_ymd_opt(year, month + 1, 1)
    }
    .unwrap_or(end);
    let from = first.max(start);
    let to = (next - chrono::Duration::days(1)).min(end);
    let days = ((to - from).num_days() + 1).max(0) as f64;
    (days, if basis == "actual360" { 360.0 } else { 365.0 })
}

fn calculate(
    params: &Value,
    cancel: &AtomicBool,
    pause: &PauseCheckpoint,
    progress: &dyn Fn(&str, usize, usize, &str),
    total: usize,
) -> Result<Value, AppError> {
    let start = date_param(params, "reportStart")?;
    let end = date_param(params, "reportEnd")?;
    if end < start {
        return Err(error(
            "INVALID_PERIOD",
            "测算期间结束日不能早于开始日。",
            None,
        ));
    }
    let year = end.year();
    let (basis_key, basis_label) = day_basis(params);

    let (tb, tb_map) = table_for(params, "tbSource", "tbMapping")?;
    // 必填校验放在一切计算之前：缺金标身份就报错，不沉默算错账。
    // 有序时账时年初余额可缺（倒推），与前端判定同口径。
    let has_je = params.get("jeSource").is_some_and(|value| !value.is_null());
    require_mappings("tb", &tb_map, has_je)?;
    let mut accounts: Vec<AccountRow> = vec![];
    let mut booked_interest_rows: Vec<Value> = vec![];
    let mut booked_interest = 0.0;

    let account_cols = account_columns(&tb, &tb_map);
    if account_cols.is_empty() {
        return Err(error(
            "MAPPING_INCOMPLETE",
            "TB 尚未映射科目编码/名称，无法识别货币资金科目。",
            None,
        ));
    }
    let tb_leaf = ledger_mapping::tb_leaf_mask(&tb.headers, &tb.rows, &|role| {
        column_indexes(&tb, &tb_map, role)
            .into_iter()
            .filter_map(|index| tb.headers.get(index).cloned())
            .collect()
    });
    // TB 余额的符号口径与「整列是否自带符号」全表各判一次，判据与汇兑损益、
    // 借款利息、FA TBJE 共用——此前这里直接取净额原值、完全不看方向列，
    // 贷方余额的货币资金科目（如银行透支）会少一个负号。
    let tb_columns = |role: &str| -> Vec<String> {
        column_indexes(&tb, &tb_map, role)
            .into_iter()
            .filter_map(|index| tb.headers.get(index).cloned())
            .collect()
    };
    let tb_convention =
        ledger_mapping::detect_tb_sign_convention(&tb.headers, &tb.rows, &tb_columns)
            .convention
            .unwrap_or(ledger_mapping::SignConvention::Unsigned);
    let opening_self_signed = ledger_mapping::balance_self_signed(
        &tb.headers,
        &tb.rows,
        &tb_columns,
        "openingFunctional",
    );
    let closing_self_signed = ledger_mapping::balance_self_signed(
        &tb.headers,
        &tb.rows,
        &tb_columns,
        "closingFunctional",
    );
    for (row_index, row) in tb.rows.iter().enumerate() {
        if !tb_leaf[row_index] {
            continue;
        }
        let account = join_columns(row, &account_cols);
        if account.is_empty() {
            continue;
        }
        let role = role_for(&account, params);
        if role == "interest_income" {
            // 利息收入是损益类贷方科目：优先用本期发生额净额，
            // 只有余额可用时退回期末余额净额。
            // 发生额口径：本年累计优先，表里只给本期时退而求其次。
            let net = signed(
                &tb,
                row,
                &tb_map,
                "ytdFunctionalCredit",
                "ytdFunctionalDebit",
            )
            .or_else(|| {
                signed(
                    &tb,
                    row,
                    &tb_map,
                    "periodFunctionalCredit",
                    "periodFunctionalDebit",
                )
            })
            .filter(|value| value.abs() > 0.0)
            .or_else(|| {
                signed(
                    &tb,
                    row,
                    &tb_map,
                    "closingFunctionalCredit",
                    "closingFunctionalDebit",
                )
            })
            .or_else(|| cell_number(&tb, row, &tb_map, "closingFunctionalAmount").map(|x| -x))
            .unwrap_or(0.0);
            booked_interest += net;
            booked_interest_rows.push(json!({
                "entity": cell_text(&tb, row, &tb_map, "entity"),
                "account": account, "bookedAmount": net
            }));
            continue;
        }
        if !is_deposit_role(&role) {
            continue;
        }
        if role == "cash_on_hand" && !params["includeCashOnHand"].as_bool().unwrap_or(false) {
            continue;
        }
        let entity = cell_text(&tb, row, &tb_map, "entity");
        let auxiliary = cell_text(&tb, row, &tb_map, "auxiliary");
        let currency = cell_text(&tb, row, &tb_map, "currency");
        // 货币资金是借方余额资产，净额一律按"借方－贷方"。
        let opening = tb_balance(
            &tb,
            row,
            &tb_map,
            "openingFunctional",
            tb_convention,
            opening_self_signed,
        );
        let closing = tb_balance(
            &tb,
            row,
            &tb_map,
            "closingFunctional",
            tb_convention,
            closing_self_signed,
        )
        .unwrap_or(0.0);
        let (tier, matched_by) = tier_for(&account, &auxiliary, params);
        let meta = find_tier(tier);
        accounts.push(AccountRow {
            key: account_key(&entity, &account, &auxiliary),
            entity,
            account,
            auxiliary,
            currency,
            role,
            tier: tier.into(),
            tier_label: tier_label(tier),
            category: meta.map(|x| x.category).unwrap_or("demand").into(),
            term_label: meta.map(|x| x.term_label).unwrap_or("").into(),
            tier_matched_by: matched_by,
            rate_source: String::new(),
            annual_rate: 0.0,
            rate_resolved: false,
            rate_warning: String::new(),
            opening_balance: opening.unwrap_or(0.0),
            opening_from_tb: opening.is_some(),
            tb_closing_balance: closing,
            derived_closing_balance: closing,
            reconciliation_diff: 0.0,
            average_balance: 0.0,
            calculated_interest: 0.0,
            months: vec![],
            status: String::new(),
            note: String::new(),
        });
    }
    if accounts.is_empty() {
        return Err(error(
            "NO_DEPOSIT_ACCOUNTS",
            "未从 TB 识别到货币资金科目；请在科目分类中确认银行存款/其他货币资金科目。",
            None,
        ));
    }
    checkpoint(cancel, pause)?;

    // 只测算期间覆盖到的月份。SAP 的 TB 常常只出到某个期间（例如 10 月），
    // 硬跑 1~12 月会凭空多出两个月的利息。
    let period = month_range(start, end);
    if period.is_empty() {
        return Err(error(
            "INVALID_PERIOD",
            "测算期间没有覆盖任何完整月份。",
            None,
        ));
    }

    // 逐月发生额：有序时账就按日期还原，没有序时账就退回期初/期末两点法。
    progress("movement", 2, total, "正在按序时账还原逐月余额变动…");
    let detected = monthly_movements(params, &accounts, start, end)?;
    let has_je = detected.is_some();
    let amount_scheme = detected
        .as_ref()
        .map(|(_, label, _)| label.clone())
        .unwrap_or_default();
    let amount_evidence = detected
        .as_ref()
        .map(|(_, _, note)| note.clone())
        .unwrap_or_default();
    let movements = detected.map(|(series, _, _)| series);
    checkpoint(cancel, pause)?;

    progress("interest", 3, total, "正在按月均余额和存款利率测算利息…");
    let overrides = params.get("rateOverrides").and_then(Value::as_object);
    let custom_rates = params.get("tierRates").and_then(Value::as_object);
    for account in &mut accounts {
        let resolved = resolve_rate(account, overrides, custom_rates);
        let (tier, rate) = (resolved.tier, resolved.rate);
        if tier != account.tier {
            account.tier_matched_by = "用户手工选择档位".into();
        }
        account.tier_label = tier_label(&tier);
        account.category = find_tier(&tier)
            .map(|x| x.category)
            .unwrap_or("demand")
            .into();
        account.term_label = find_tier(&tier).map(|x| x.term_label).unwrap_or("").into();
        account.annual_rate = rate;
        account.rate_source = resolved.source;
        account.rate_resolved = resolved.resolved;
        // 央行基准只在这里起作用：超过基准就提示复核，绝不参与测算。
        account.rate_warning = match benchmark_rate(&tier) {
            Some(benchmark) if resolved.resolved && rate > benchmark + 1e-9 => format!(
                "填入利率 {:.4}% 高于该档央行基准 {:.4}%，请确认是否与存款协议一致。",
                rate * 100.0,
                benchmark * 100.0
            ),
            _ => String::new(),
        };
        account.tier = tier;

        // TB 没给年初余额时（SAP Trial Balance LC/GC 就没有这一列），
        // 用"期末余额 − 期间内全部发生额"倒推年初。
        let series = movements.as_ref().and_then(|all| all.get(&account.key));
        if !account.opening_from_tb {
            let net: f64 = series
                .map(|all| all.iter().map(|(debit, credit)| debit - credit).sum())
                .unwrap_or(0.0);
            account.opening_balance = account.tb_closing_balance - net;
        }

        let mut opening = account.opening_balance;
        let mut months = Vec::with_capacity(period.len());
        let span = period.len() as f64;
        for (index, month) in period.iter().copied().enumerate() {
            let (debit, credit) = series
                .map(|all| all[(month - 1) as usize])
                .unwrap_or((0.0, 0.0));
            let closing = if has_je {
                opening + debit - credit
            } else {
                // 两点法：只有期初和期末，月末余额按直线推进，
                // 各月月均余额的平均值仍然等于(期初+期末)/2。
                account.opening_balance
                    + (account.tb_closing_balance - account.opening_balance) * (index as f64 + 1.0)
                        / span
            };
            let (days, denominator) = month_days(basis_key, year, month, start, end);
            let average = (opening + closing) / 2.0;
            months.push(MonthCell {
                month,
                opening,
                debit,
                credit,
                closing,
                average,
                days,
                denominator,
                interest: average * rate * days / denominator,
            });
            opening = closing;
        }
        account.derived_closing_balance = months.last().map(|m| m.closing).unwrap_or(0.0);
        account.reconciliation_diff = account.derived_closing_balance - account.tb_closing_balance;
        account.average_balance = months.iter().map(|m| m.average).sum::<f64>() / span;
        account.calculated_interest = months.iter().map(|m| m.interest).sum();
        // 没有利率是最优先的状态：这一户根本还没测出来，不能被余额勾稽上了
        // 就显示成"已勾稽"。
        account.status = if !account.rate_resolved {
            "待填利率".into()
        } else if !has_je {
            "两点法推算".into()
        } else if !account.opening_from_tb {
            "年初倒推".into()
        } else if account.reconciliation_diff.abs() < 0.01 {
            "已勾稽".into()
        } else {
            "待复核".into()
        };
        let mut notes: Vec<String> = vec![];
        if !account.opening_from_tb {
            notes.push(
                "TB 未提供年初余额，已按“期末余额 − 期间内发生额”倒推；此时期末余额必然勾稽，不构成独立复核证据。"
                    .into(),
            );
        }
        if !account.rate_resolved {
            notes.push(format!(
                "{}不自动套用默认利率，请按存款协议/对账单填入实际利率；未填前该户利息不计入合计。",
                account.tier_label
            ));
        }
        if !account.rate_warning.is_empty() {
            notes.push(account.rate_warning.clone());
        }
        if !has_je {
            notes.push("未提供序时账，月末余额按年初到年末直线推算，月均余额仅供参考。".into());
        } else if account.reconciliation_diff.abs() >= 0.01 {
            notes.push(format!(
                "JE 推导的年末余额与 TB 相差 {:.2}，请确认科目/辅助核算是否完整匹配。",
                account.reconciliation_diff
            ));
        }
        account.note = notes.join(" ");
        account.months = months;
    }

    // 未确定利率的账户利息恒为 0，从合计里排除掉只是把这件事说明白，
    // 避免"0 元利息"被当成一个有效结论。
    let calculated: f64 = accounts
        .iter()
        .filter(|a| a.rate_resolved)
        .map(|a| a.calculated_interest)
        .sum();
    let missing_rate: Vec<&AccountRow> = accounts.iter().filter(|a| !a.rate_resolved).collect();
    let missing_rate_count = missing_rate.len();
    let missing_rate_balance: f64 = missing_rate.iter().map(|a| a.average_balance).sum();
    let missing_rate_tiers: Vec<String> = {
        let mut all: Vec<String> = missing_rate
            .iter()
            .map(|a| a.tier_label.clone())
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect();
        all.sort();
        all
    };
    let booked = booked_interest.abs();
    let difference = calculated - booked;
    let ratio = (booked.abs() > 0.005).then(|| difference / booked);
    let review = accounts.iter().filter(|a| a.status != "已勾稽").count();
    let stale_months = listed_rate_age_months();
    let rates_stale = stale_months > RATE_STALE_AFTER_MONTHS;
    Ok(json!({
        "rows": accounts,
        "bookedInterestRows": booked_interest_rows,
        "summary": {
            "accountCount": accounts.len(),
            "calculatedInterest": calculated,
            "bookedInterestIncome": booked,
            "bookedInterestRaw": booked_interest,
            "difference": difference,
            "differenceRatio": ratio,
            // 还有账户没填利率时，测算合计本身就不完整，谈不上勾稽通过。
            "reconciliationPassed": missing_rate_count == 0
                && ratio.map(|r| r.abs() <= 0.05).unwrap_or(false),
            "reviewCount": review,
            "missingRateCount": missing_rate_count,
            "missingRateBalance": missing_rate_balance,
            "missingRateTiers": missing_rate_tiers,
            "monthlySource": if has_je { "序时账逐月还原" } else { "期初/期末两点法" },
            "amountScheme": amount_scheme,
            "amountEvidence": amount_evidence,
            "openingSource": if accounts.iter().all(|a| a.opening_from_tb) {
                "TB 年初余额"
            } else if accounts.iter().any(|a| a.opening_from_tb) {
                "部分账户由期末余额倒推"
            } else {
                "全部由期末余额倒推（TB 无年初余额列）"
            },
            "months": period.clone(),
            "monthCount": period.len(),
            "dayBasis": basis_key,
            "dayBasisLabel": basis_label,
            "rateBasisLabel": format!(
                "仅活期自动套用国有大行挂牌默认值（{LISTED_REFERENCE_DATE}）；\
                 其余档位须填实际利率。央行基准（{PBC_BENCHMARK_DATE}）只作上限参照，不参与测算。"
            ),
            "listedRateDate": LISTED_REFERENCE_DATE,
            "ratesStale": rates_stale,
            "rateAgeMonths": stale_months,
            "staleMessage": if rates_stale {
                format!(
                    "内置挂牌利率最后更新于 {LISTED_REFERENCE_DATE}，距今约 {stale_months} 个月，\
                     期间挂牌利率很可能已调整，请核对最新挂牌利率后再使用默认值。"
                )
            } else {
                String::new()
            },
            "reportStart": start.format("%Y-%m-%d").to_string(),
            "reportEnd": end.format("%Y-%m-%d").to_string(),
            "hasInterestIncomeAccount": !booked_interest_rows.is_empty()
        },
        "outputPaths": []
    }))
}

/// 利率优先级：账户级手填 > 用户改写的档位利率 > 仅活期的内置默认值。
/// 第三个返回值是利率来源；`resolved` 为 false 表示这一户还没有可用利率，
/// 不能算作"已勾稽"，也不该把 0 当成一个正常的测算结果。
struct ResolvedRate {
    tier: String,
    rate: f64,
    source: String,
    resolved: bool,
}

fn resolve_rate(
    account: &AccountRow,
    overrides: Option<&Map<String, Value>>,
    custom_rates: Option<&Map<String, Value>>,
) -> ResolvedRate {
    let over = overrides.and_then(|all| all.get(&account.key));
    let tier = over
        .and_then(|value| value.get("tier"))
        .and_then(Value::as_str)
        .unwrap_or(&account.tier)
        .to_owned();
    let done = |rate: f64, source: &str| ResolvedRate {
        tier: tier.clone(),
        rate: normalize_rate(rate),
        source: source.into(),
        resolved: true,
    };
    if let Some(rate) = over
        .and_then(|value| value.get("annualRate"))
        .and_then(Value::as_f64)
    {
        return done(rate, "本账户手工指定");
    }
    if let Some(rate) = custom_rates
        .and_then(|all| all.get(&tier))
        .and_then(Value::as_f64)
    {
        return done(rate, "自定义档位利率");
    }
    // 外币户即便落在活期档，也不能自动套人民币挂牌利率（0.05% 会严重低估
    // 美元存款利息）——留空逼着用户按对账单填。用户手工填的利率在上面已经返回。
    let foreign = detect_foreign_currency(&format!(
        "{} {} {}",
        account.account, account.auxiliary, account.currency
    ))
    .is_some();
    match auto_rate(&tier).filter(|_| !foreign) {
        Some(rate) => done(rate, "活期挂牌默认值"),
        None => ResolvedRate {
            tier,
            rate: 0.0,
            source: "需填写实际利率".into(),
            resolved: false,
        },
    }
}

/// 大于 1 的输入按百分数理解（4.2 → 0.042）；利率不可能大于 100%。
fn normalize_rate(value: f64) -> f64 {
    if value.abs() > 1.0 {
        value / 100.0
    } else {
        value
    }
}

type MonthlySeries = BTreeMap<String, [(f64, f64); 12]>;

/// 返回逐月发生额，以及金额口径是怎么判出来的——底稿要能交代清楚
/// "这本序时账是按哪种方案、哪种符号口径读的"。
fn monthly_movements(
    params: &Value,
    accounts: &[AccountRow],
    start: NaiveDate,
    end: NaiveDate,
) -> Result<Option<(MonthlySeries, String, String)>, AppError> {
    if params.get("jeSource").is_none_or(Value::is_null) {
        return Ok(None);
    }
    let (je, je_map) = table_for(params, "jeSource", "jeMapping")?;
    // 抽样表只解析了开头若干行，拿它还原逐月余额会得到一份看似完整、
    // 实则缺了大半发生额的结果——宁可报错也不能悄悄算错。
    if je.sampled {
        return Err(error(
            "JE_SAMPLED",
            "序时账过大，当前只读取了部分行，无法据此还原逐月余额。请改用不含序时账的两点法，或提供按期间拆分后的序时账。",
            None,
        ));
    }
    // 序时账只在提供时校验（与前端一致）；年初余额的放松只对 TB 一侧有意义。
    require_mappings("je", &je_map, false)?;
    let date_index = column_index(&je, &je_map, "date").ok_or_else(|| {
        error(
            "MAPPING_INCOMPLETE",
            "序时账尚未映射记账日期，无法还原逐月余额。",
            None,
        )
    })?;
    let account_cols = account_columns(&je, &je_map);
    if account_cols.is_empty() {
        return Err(error(
            "MAPPING_INCOMPLETE",
            "序时账尚未映射科目编码/名称。",
            None,
        ));
    }
    // 先按 科目全称 / 科目编码 建索引，序时账与 TB 的科目层级不一定完全一致，
    // 允许退化到编码前缀匹配。
    let mut by_account: BTreeMap<String, Vec<usize>> = BTreeMap::new();
    let mut by_code: BTreeMap<String, Vec<usize>> = BTreeMap::new();
    for (index, account) in accounts.iter().enumerate() {
        by_account
            .entry(normalize_header(&account.account))
            .or_default()
            .push(index);
        by_code
            .entry(account_code(&account.account).to_owned())
            .or_default()
            .push(index);
    }
    let scheme = detect_amount_scheme(&je, &je_map)?;
    // 垃圾行剔除走引擎一份规则（`ledger_junk_mask`）：合计行、表尾手工草稿、
    // 游离数字行在此显式挡掉。此前这些行进不来靠的是「日期读不出／科目对不上」
    // 的间接效果——哪天循环放宽了其中一个条件它们就会漏进来，把合计翻倍。
    // 掩码语义是 `true` 表示该行要算。
    let keep = ledger_mapping::ledger_junk_mask(&je.headers, &je.rows, &|role| {
        column_indexes(&je, &je_map, role)
            .into_iter()
            .filter_map(|index| je.headers.get(index).cloned())
            .collect()
    });
    let mut series: MonthlySeries = accounts
        .iter()
        .map(|account| (account.key.clone(), [(0.0, 0.0); 12]))
        .collect();
    let mut matched = 0usize;
    for (row_index, row) in je.rows.iter().enumerate() {
        if !keep.get(row_index).copied().unwrap_or(true) {
            continue;
        }
        let Some(date) = row.get(date_index).and_then(|value| parse_date(value)) else {
            continue;
        };
        if date < start || date > end {
            continue;
        }
        let account = join_columns(row, &account_cols);
        if account.is_empty() {
            continue;
        }
        let code = account_code(&account);
        let hits = by_account
            .get(&normalize_header(&account))
            .or_else(|| by_code.get(code))
            .cloned()
            .unwrap_or_default();
        if hits.is_empty() {
            continue;
        }
        let entity = cell_text(&je, row, &je_map, "entity");
        let auxiliary = cell_text(&je, row, &je_map, "auxiliary");
        // 同一科目下有多个辅助核算/主体时，优先精确落到对应账户；
        // 落不到就摊到该科目下唯一的账户，多于一个则跳过并留待复核。
        let target = hits
            .iter()
            .find(|index| {
                let candidate = &accounts[**index];
                (entity.is_empty() || candidate.entity.is_empty() || candidate.entity == entity)
                    && (auxiliary.is_empty()
                        || candidate.auxiliary.is_empty()
                        || candidate.auxiliary == auxiliary)
            })
            .copied()
            .or_else(|| (hits.len() == 1).then(|| hits[0]));
        let Some(target) = target else { continue };
        let net = scheme.net(row);
        if net == 0.0 {
            continue;
        }
        let (debit, credit) = if net < 0.0 { (0.0, -net) } else { (net, 0.0) };
        matched += 1;
        let slot = &mut series.get_mut(&accounts[target].key).unwrap()[(date.month() - 1) as usize];
        slot.0 += debit;
        slot.1 += credit;
    }
    if matched == 0 {
        return Err(error(
            "NO_JE_MATCH",
            "序时账中没有任何行匹配到 TB 的货币资金科目；请检查科目映射或改用不含序时账的两点法。",
            None,
        ));
    }
    Ok(Some((series, scheme.label(), scheme.evidence.clone())))
}

/// 序时账金额口径。直接复用看账小工具的 `sign_evidence`：它把 JE 的金额
/// 布局分成三种方案（A=金额+方向列、B=借贷分列、single=单一金额列），
/// 再用**凭证配平投票**判断数值是否已带符号——一张借贷齐全的凭证，
/// 在"已带符号"口径下 Σ金额≈0，在"借贷符号一样"口径下 Σ借≈Σ贷，
/// 两者互斥，是最硬的证据。合起来共 5 种情形，本工具全部覆盖。
///
/// 自己另写一套启发式（例如"整列出现过负数就算带符号"）会漏掉
/// "借贷分列且贷方为负"这一种，把本该相减的两列加了起来。
#[derive(Debug)]
struct AmountScheme {
    scheme: &'static str,
    signed: bool,
    debit: Option<usize>,
    credit: Option<usize>,
    amount: Option<usize>,
    direction: Option<usize>,
    evidence: String,
}

fn detect_amount_scheme(
    table: &FxTable,
    mapping: &Map<String, Value>,
) -> Result<AmountScheme, AppError> {
    let column = |role: &str| mapping.get(role).and_then(Value::as_str).map(str::to_owned);
    let ledger = crate::tabular::LedgerMapping {
        id: column("id").into_iter().collect(),
        account_code: column("accountCode"),
        entity: column("entity"),
        date: column("date"),
        summary: column("summary"),
        amount: column("functionalAmount"),
        direction: column("direction"),
        debit: column("functionalDebit"),
        credit: column("functionalCredit"),
        ..Default::default()
    };
    let id_indexes = column_indexes(table, mapping, "id");
    let evidence = crate::tabular::sign_evidence(&table.rows, &table.headers, &ledger, &id_indexes);

    // 记法一律自动判定，界面不再提供人工选择：检测走两步，先拿借贷齐全的
    // 凭证配平投票，配不出来就退到看列的形状（贷方列出现负数即已带符号）——
    // 单边账走的就是第二步，同样是确定的答案。
    let (signed, basis) = match evidence.convention {
        Some(convention) => {
            let signed = convention.as_str() == "signed";
            let basis = if evidence.signed_votes + evidence.unsigned_votes > 0 {
                format!(
                    "{} 张借贷齐全的凭证按此口径配平",
                    evidence.signed_votes.max(evidence.unsigned_votes)
                )
            } else {
                evidence
                    .note
                    .clone()
                    .unwrap_or_else(|| "按金额列的正负形状判定".into())
            };
            (signed, basis)
        }
        None => {
            return Err(error(
                "AMOUNT_SCHEME_UNDETERMINED",
                format!(
                    "无法自动判断序时账的金额记法：{}这份序时账的借贷记法两种解释都说得通，为避免算错已停止测算；请让客户重新导出借贷方向明确的序时账，或移除序时账、改用期初/期末两点法。",
                    evidence
                        .note
                        .clone()
                        .map(|x| format!("{x}。"))
                        .unwrap_or_default()
                ),
                None,
            ));
        }
    };
    Ok(AmountScheme {
        scheme: evidence.scheme,
        signed,
        debit: column_index(table, mapping, "functionalDebit"),
        credit: column_index(table, mapping, "functionalCredit"),
        amount: column_index(table, mapping, "functionalAmount"),
        direction: column_index(table, mapping, "direction"),
        evidence: basis,
    })
}

impl AmountScheme {
    fn label(&self) -> String {
        let layout = match self.scheme {
            "A" => "金额＋方向列",
            "B" => "借贷分列",
            "single" => "单一金额列",
            _ => "金额字段未映射",
        };
        if self.scheme == "none" {
            return layout.into();
        }
        format!(
            "{layout}，{}",
            if self.signed {
                "数值已带符号（借正贷负）"
            } else {
                "借贷符号一样（靠分列/方向区分）"
            }
        )
    }

    /// 本行的有符号净发生额：正数是借方增加，负数是贷方减少。
    fn net(&self, row: &[String]) -> f64 {
        let value = |index: Option<usize>| {
            index
                .and_then(|i| row.get(i))
                .and_then(|text| parse_number(text))
                .unwrap_or(0.0)
        };
        let inputs = match self.scheme {
            "B" => ledger_mapping::AmountInputs {
                debit: Some(value(self.debit)),
                credit: Some(value(self.credit)),
                ..Default::default()
            },
            "A" => ledger_mapping::AmountInputs {
                amount: Some(value(self.amount)),
                direction: self.direction.and_then(|i| row.get(i)).cloned(),
                ..Default::default()
            },
            "single" => ledger_mapping::AmountInputs {
                amount: Some(value(self.amount)),
                ..Default::default()
            },
            _ => return 0.0,
        };
        ledger_mapping::signed_amount(
            &inputs,
            if self.signed {
                ledger_mapping::SignConvention::Signed
            } else {
                ledger_mapping::SignConvention::Unsigned
            },
        )
    }
}

fn account_key(entity: &str, account: &str, auxiliary: &str) -> String {
    [entity, account, auxiliary]
        .iter()
        .map(|part| part.trim())
        .collect::<Vec<_>>()
        .join(" | ")
}

// ---------------------------------------------------------------------------
// 取数辅助
// ---------------------------------------------------------------------------

/// 把映射里已填的角色收成集合，供引擎的必填判定用。
/// 历史保存的映射把科目编码与名称合在一个 `account` 里，判定时一并认——
/// 与前端 `depositMissingRequired` 的兼容口径是同一条。
fn mapped_roles(mapping: &Map<String, Value>) -> HashSet<&str> {
    let mut out = HashSet::new();
    for (role, value) in mapping {
        let filled = match value {
            Value::String(one) => !one.trim().is_empty(),
            Value::Array(all) => all
                .iter()
                .any(|item| item.as_str().is_some_and(|s| !s.trim().is_empty())),
            _ => false,
        };
        if filled {
            out.insert(role.as_str());
        }
    }
    if out.contains("account") {
        out.insert("accountCode");
        out.insert("accountName");
    }
    out
}

/// 必填映射的 Rust 侧硬校验：金标身份槽 ∪ 金额形态槽 ∪ 工具自己声明的角色，
/// 判定只有引擎（[`ledger_mapping::missing_required`]）一份。
///
/// 此前必填只在前端 `depositMissingRequired` 手写，worker 路径不拦，缺映射的
/// 参数会一路算到底、给出沉默的错误合计。本工具不重写判定，只声明**豁免**——
/// 把豁免的角色预填进 `mapped`，让引擎把它们当作已映射；角色名、中文标签、
/// 形态匹配逻辑全部留在引擎里。豁免清单与前端 `depositMissingRequired` 同口径，
/// 都是存款利息自己的业务决定：
///
/// 1. **有序时账时年初余额槽整槽豁免**——按「期末余额 − 期间内发生额」倒推
///    （SAP 的 Trial Balance LC/GC 就没有年初余额列）；
/// 2. **本年累计／本期发生额槽豁免**——金标把它列为 TB 必填槽是给六型余额表的
///    通用要求，但净额式余额表（SAP）没有借贷发生额列，账面利息收入取不到
///    发生额时本工具退回期末净额，照样算得出；
/// 3. **余额槽按「任一即可」放行**——期初／期末家族里映射了任意一列就算整槽
///    到齐。只映射借方一列的余额表（贷方全表为空）真实存在，前端判的也是
///    「净额｜借方｜贷方三选一」；
/// 4. **序时账的科目名称／摘要豁免**——逐月余额还原只依赖日期、科目编码与
///    金额方案；真实 SAP 导出（`G/L Account`＋`Text`）就没有这两列，前端在
///    界面上仍按金标拦，worker 路径维持旧版放行。
///
/// 其余一律硬拦：TB 科目编码／科目名称、期末余额槽、无序时账时的期初余额槽、
/// 序时账的记账日期与科目编码、金额方案，报错指名道姓缺哪个角色。
fn require_mappings(
    kind: &str,
    mapping: &Map<String, Value>,
    has_je: bool,
) -> Result<(), AppError> {
    let mut mapped = mapped_roles(mapping);
    // 豁免 2：本年累计／本期发生额不硬性要求。
    for role in [
        "ytdFunctionalDebit",
        "ytdFunctionalCredit",
        "periodFunctionalDebit",
        "periodFunctionalCredit",
    ] {
        mapped.insert(role);
    }
    // 豁免 3：余额槽家族任一即可——家族里有一列就把整槽补齐。
    const OPENING: &[&str] = &[
        "openingFunctionalAmount",
        "openingFunctionalDebit",
        "openingFunctionalCredit",
    ];
    const CLOSING: &[&str] = &[
        "closingFunctionalAmount",
        "closingFunctionalDebit",
        "closingFunctionalCredit",
    ];
    for family in [OPENING, CLOSING] {
        if family.iter().any(|role| mapped.contains(*role)) {
            for role in family {
                mapped.insert(role);
            }
        }
    }
    // 豁免 1：有序时账时年初余额整槽豁免（期末倒推）。
    if has_je {
        for role in OPENING {
            mapped.insert(role);
        }
    }
    if kind == "je" {
        // 豁免 4：序时账的科目名称／摘要不作硬性要求。
        mapped.insert("accountName");
        mapped.insert("summary");
        // JE 金额方案同样是「净额｜借方｜贷方任一即可」，借方一列也能算
        // （净额 = 借 − 贷，贷方缺列按 0 处理）。
        const AMOUNTS: &[&str] = &["functionalAmount", "functionalDebit", "functionalCredit"];
        if AMOUNTS.iter().any(|role| mapped.contains(*role)) {
            for role in AMOUNTS {
                mapped.insert(role);
            }
        }
    }
    let missing: Vec<&str> =
        ledger_mapping::missing_required(ledger_mapping::Tool::DepositInterest, kind, &mapped)
            .into_iter()
            .map(|item| item.label)
            .collect();
    if missing.is_empty() {
        return Ok(());
    }
    Err(error(
        "MAPPING_INCOMPLETE",
        format!(
            "{}尚未映射：{}。请回到第一步，在预览表头完成字段映射。",
            if kind == "je" { "序时账" } else { "TB" },
            missing.join("、")
        ),
        None,
    ))
}

fn table_for(
    params: &Value,
    source_key: &str,
    mapping_key: &str,
) -> Result<(Arc<FxTable>, Map<String, Value>), AppError> {
    let spec: SourceSpec = serde_json::from_value(
        params.get(source_key).cloned().unwrap_or(Value::Null),
    )
    .map_err(|e| {
        error(
            "MISSING_SOURCE",
            format!("缺少 {source_key} 数据源或参数不完整。"),
            Some(e.to_string()),
        )
    })?;
    let mapping = params
        .get(mapping_key)
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let table = load_fx_table(&spec)?;
    let table = if source_key.eq_ignore_ascii_case("jeSource") {
        crate::fx::forward_filled_je_table(&table, &mapping)
    } else {
        table
    };
    Ok((table, mapping))
}

fn column_indexes(table: &FxTable, mapping: &Map<String, Value>, role: &str) -> Vec<usize> {
    let columns = match mapping.get(role) {
        Some(Value::String(value)) => vec![value.clone()],
        Some(Value::Array(values)) => values
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_owned)
            .collect(),
        _ => vec![],
    };
    columns
        .iter()
        .filter_map(|column| table.headers.iter().position(|header| header == column))
        .collect()
}

fn column_index(table: &FxTable, mapping: &Map<String, Value>, role: &str) -> Option<usize> {
    column_indexes(table, mapping, role).first().copied()
}

fn join_columns(row: &[String], indexes: &[usize]) -> String {
    indexes
        .iter()
        .filter_map(|index| row.get(*index))
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

fn cell_text(table: &FxTable, row: &[String], mapping: &Map<String, Value>, role: &str) -> String {
    column_index(table, mapping, role)
        .and_then(|index| row.get(index))
        .map(|value| value.trim().to_owned())
        .unwrap_or_default()
}

fn cell_number(
    table: &FxTable,
    row: &[String],
    mapping: &Map<String, Value>,
    role: &str,
) -> Option<f64> {
    let index = column_index(table, mapping, role)?;
    parse_number(row.get(index)?)
}

/// TB 的一格余额。借贷分列、净额＋方向、单列净额三种形态由公共内核吸收；
/// 「整列自带符号」由 [`ledger_mapping::balance_self_signed`] 判定后传进来。
fn tb_balance(
    table: &FxTable,
    row: &[String],
    mapping: &Map<String, Value>,
    prefix: &str,
    convention: ledger_mapping::SignConvention,
    self_signed: bool,
) -> Option<f64> {
    let debit = cell_number(table, row, mapping, &format!("{prefix}Debit"));
    let credit = cell_number(table, row, mapping, &format!("{prefix}Credit"));
    let amount = cell_number(table, row, mapping, &format!("{prefix}Amount"));
    if debit.is_none() && credit.is_none() && amount.is_none() {
        return None;
    }
    let direction = cell_text(
        table,
        row,
        mapping,
        if prefix.starts_with("opening") {
            "openingDirection"
        } else {
            "closingDirection"
        },
    );
    Some(ledger_mapping::signed_balance(
        &ledger_mapping::AmountInputs {
            amount,
            debit,
            credit,
            direction: (!direction.is_empty()).then_some(direction),
        },
        convention,
        self_signed,
    ))
}

fn signed(
    table: &FxTable,
    row: &[String],
    mapping: &Map<String, Value>,
    positive: &str,
    negative: &str,
) -> Option<f64> {
    let plus = cell_number(table, row, mapping, positive);
    let minus = cell_number(table, row, mapping, negative);
    (plus.is_some() || minus.is_some()).then(|| plus.unwrap_or(0.0) - minus.unwrap_or(0.0))
}

/// 金额文本读取：引擎 [`ledger_mapping::parse_amount_lenient`] 的薄包装。
///
/// 千分位、货币符号、括号负数、占位符（`-`／`—`／`N/A`）与尾部负号、
/// `CR/DR`、借贷后缀都由引擎一份口径认，本模块不再自持规则。包装只补两件
/// 引擎刻意留给调用方的事：
///
/// 1. **百分号换算**：引擎只剥符号（`3.5%` 读作 3.5，换算与否是调用方的业务），
///    存款利息的利率列要的是小数，这里统一除以一百；
/// 2. **全角句点**「。」转半角——旧版本地实现就认，保持不变。
///
/// 读不出一律 `None`（含占位符），与旧版一致，调用方把读不出当缺省处理。
/// fa_tbje 也借用这份口径，可见性保持 `pub(crate)` 不动。
pub(crate) fn parse_number(raw: &str) -> Option<f64> {
    let percent = raw.contains('%');
    let normalized = raw.replace('。', ".");
    ledger_mapping::parse_amount_lenient(&normalized)
        .map(|value| if percent { value / 100.0 } else { value })
}

fn date_param(params: &Value, key: &str) -> Result<NaiveDate, AppError> {
    NaiveDate::parse_from_str(
        params.get(key).and_then(Value::as_str).unwrap_or(""),
        "%Y-%m-%d",
    )
    .map_err(|_| {
        error(
            "INVALID_DATE",
            "测算期间日期无效，请选择资产负债表日。",
            None,
        )
    })
}

// ---------------------------------------------------------------------------
// Excel 底稿
// ---------------------------------------------------------------------------

const SUMMARY_SHEET: &str = "测算汇总";
const MONTHLY_SHEET: &str = "月度余额与利息";

fn export(params: &Value, result: &Value) -> Result<PathBuf, AppError> {
    let path = output_path(params);
    let rows: Vec<AccountRow> = serde_json::from_value(result["rows"].clone())
        .map_err(|e| error("EXPORT_FAILED", "测算结果结构异常。", Some(e.to_string())))?;
    let summary = &result["summary"];

    let mut workbook = Workbook::new();
    // 汇总表要引用月度表的行号，所以先算好每个账户在月度表里占用的区间。
    let mut ranges: Vec<(u32, u32)> = Vec::with_capacity(rows.len());
    let mut cursor = 2u32;
    for row in &rows {
        let span = row.months.len().max(1) as u32;
        ranges.push((cursor, cursor + span - 1));
        cursor += span;
    }
    write_summary(workbook.add_worksheet(), &rows, &ranges)?;
    write_monthly(workbook.add_worksheet(), &rows)?;
    write_reconciliation(workbook.add_worksheet(), &rows, summary, result)?;
    write_rate_tiers(workbook.add_worksheet(), params)?;
    write_parameters(workbook.add_worksheet(), summary, &rows)?;
    workbook.save(&path).map_err(xlsx)?;
    Ok(path)
}

fn output_path(params: &Value) -> PathBuf {
    if let Some(path) = params
        .get("outputPath")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
    {
        return PathBuf::from(path);
    }
    let base = params
        .get("tbSource")
        .and_then(|source| source.get("inputPath"))
        .and_then(Value::as_str)
        .map(PathBuf::from)
        .and_then(|path| path.parent().map(Path::to_path_buf))
        .unwrap_or_else(std::env::temp_dir);
    base.join(format!(
        "存款利息收入测算_{}.xlsx",
        Local::now().format("%Y%m%d_%H%M%S")
    ))
}

fn header_format() -> Format {
    Format::new()
        .set_bold()
        .set_align(FormatAlign::Center)
        .set_border(FormatBorder::Thin)
        .set_background_color("#245A57")
        .set_font_color("#FFFFFF")
}

fn write_summary(
    sheet: &mut Worksheet,
    rows: &[AccountRow],
    ranges: &[(u32, u32)],
) -> Result<(), AppError> {
    sheet.set_name(SUMMARY_SHEET).map_err(xlsx)?;
    let amount = Format::new().set_num_format("#,##0.00;[Red](#,##0.00);-");
    // 黄底＝可直接改写的输入格，这是整张底稿唯一需要用户动手的地方。
    let input = Format::new()
        .set_num_format("0.0000%")
        .set_background_color("#FFF2CC")
        .set_border(FormatBorder::Thin);
    // 列顺序对应下面公式里的字母：H=年利率(输入) M=月均余额 N=测算利息
    let headers = [
        "核算主体",
        "科目",
        "辅助核算/账户",
        "币种",
        "存款档位",
        "档位匹配依据",
        "利率来源",
        "年利率（可修改）",
        "年初余额",
        "年末余额(TB)",
        "年末余额(JE推导)",
        "勾稽差异",
        "月均余额(年平均)",
        "测算利息",
        "状态",
        "提示",
    ];
    for (column, title) in headers.iter().enumerate() {
        sheet
            .write_string_with_format(0, column as u16, *title, &header_format())
            .map_err(xlsx)?;
    }
    for (index, row) in rows.iter().enumerate() {
        let y = index as u32 + 1;
        let (first, last) = ranges[index];
        sheet.write_string(y, 0, &row.entity).map_err(xlsx)?;
        sheet.write_string(y, 1, &row.account).map_err(xlsx)?;
        sheet.write_string(y, 2, &row.auxiliary).map_err(xlsx)?;
        sheet.write_string(y, 3, &row.currency).map_err(xlsx)?;
        sheet.write_string(y, 4, &row.tier_label).map_err(xlsx)?;
        sheet
            .write_string(y, 5, &row.tier_matched_by)
            .map_err(xlsx)?;
        sheet.write_string(y, 6, &row.rate_source).map_err(xlsx)?;
        // 没确定利率的留空白输入格：写 0 会算出"0 元利息"这种看似有效的结论。
        if row.rate_resolved {
            sheet
                .write_number_with_format(y, 7, row.annual_rate, &input)
                .map_err(xlsx)?;
        } else {
            sheet.write_blank(y, 7, &input).map_err(xlsx)?;
        }
        for (offset, value) in [
            row.opening_balance,
            row.tb_closing_balance,
            row.derived_closing_balance,
            row.reconciliation_diff,
        ]
        .iter()
        .enumerate()
        {
            sheet
                .write_number_with_format(y, 8 + offset as u16, *value, &amount)
                .map_err(xlsx)?;
        }
        // 月均余额和测算利息全部引用月度表，改利率后 Excel 自己重算。
        sheet
            .write_formula_with_format(
                y,
                12,
                Formula::new(format!("AVERAGE('{MONTHLY_SHEET}'!K{first}:K{last})"))
                    .set_result(row.average_balance.to_string()),
                &amount,
            )
            .map_err(xlsx)?;
        sheet
            .write_formula_with_format(
                y,
                13,
                Formula::new(format!("SUM('{MONTHLY_SHEET}'!O{first}:O{last})"))
                    .set_result(row.calculated_interest.to_string()),
                &amount,
            )
            .map_err(xlsx)?;
        sheet.write_string(y, 14, &row.status).map_err(xlsx)?;
        sheet.write_string(y, 15, &row.note).map_err(xlsx)?;
    }
    let total = rows.len() as u32 + 1;
    sheet
        .write_string_with_format(total, 0, "合计", &header_format())
        .map_err(xlsx)?;
    sheet
        .write_formula_with_format(
            total,
            13,
            Formula::new(format!("SUM(N2:N{total})")),
            &amount,
        )
        .map_err(xlsx)?;
    sheet.set_column_width(1, 34).map_err(xlsx)?;
    sheet.set_column_width(2, 22).map_err(xlsx)?;
    sheet.set_column_width(5, 26).map_err(xlsx)?;
    sheet.set_column_width(15, 46).map_err(xlsx)?;
    sheet.autofit();
    Ok(())
}

fn write_monthly(sheet: &mut Worksheet, rows: &[AccountRow]) -> Result<(), AppError> {
    sheet.set_name(MONTHLY_SHEET).map_err(xlsx)?;
    let amount = Format::new().set_num_format("#,##0.00;[Red](#,##0.00);-");
    let percent = Format::new().set_num_format("0.0000%");
    // 列顺序必须与下面公式里的字母严格一致：
    // G=月初 H=借方 I=贷方 J=月末 K=月均 L=年利率 M=计息天数 N=年基数 O=当月利息
    let titles = [
        "核算主体",
        "科目",
        "辅助核算/账户",
        "月份",
        "存款类型",
        "币种",
        "月初余额",
        "本月借方",
        "本月贷方",
        "月末余额",
        "月均余额",
        "年利率",
        "计息天数",
        "年基数",
        "当月利息",
    ];
    for (column, title) in titles.iter().enumerate() {
        sheet
            .write_string_with_format(0, column as u16, *title, &header_format())
            .map_err(xlsx)?;
    }
    let mut y = 1u32;
    for (index, row) in rows.iter().enumerate() {
        let summary_row = index as u32 + 2;
        for month in &row.months {
            let line = y + 1; // Excel 行号（1 基）
            sheet.write_string(y, 0, &row.entity).map_err(xlsx)?;
            sheet.write_string(y, 1, &row.account).map_err(xlsx)?;
            sheet.write_string(y, 2, &row.auxiliary).map_err(xlsx)?;
            sheet
                .write_string(y, 3, format!("{}月", month.month))
                .map_err(xlsx)?;
            sheet.write_string(y, 4, &row.tier_label).map_err(xlsx)?;
            sheet.write_string(y, 5, &row.currency).map_err(xlsx)?;
            for (offset, value) in [month.opening, month.debit, month.credit, month.closing]
                .iter()
                .enumerate()
            {
                sheet
                    .write_number_with_format(y, 6 + offset as u16, *value, &amount)
                    .map_err(xlsx)?;
            }
            // 月均余额 =(月初+月末)/2，用户的口径原样落在公式里。
            sheet
                .write_formula_with_format(
                    y,
                    10,
                    Formula::new(format!("(G{line}+J{line})/2"))
                        .set_result(month.average.to_string()),
                    &amount,
                )
                .map_err(xlsx)?;
            // 年利率回引汇总表的输入格：在汇总表改一次，整列月度利息跟着变。
            sheet
                .write_formula_with_format(
                    y,
                    11,
                    Formula::new(format!("'{SUMMARY_SHEET}'!$H${summary_row}"))
                        .set_result(row.annual_rate.to_string()),
                    &percent,
                )
                .map_err(xlsx)?;
            sheet.write_number(y, 12, month.days).map_err(xlsx)?;
            sheet.write_number(y, 13, month.denominator).map_err(xlsx)?;
            sheet
                .write_formula_with_format(
                    y,
                    14,
                    Formula::new(format!("K{line}*L{line}*M{line}/N{line}"))
                        .set_result(month.interest.to_string()),
                    &amount,
                )
                .map_err(xlsx)?;
            y += 1;
        }
    }
    sheet.set_column_width(1, 34).map_err(xlsx)?;
    sheet.set_column_width(2, 22).map_err(xlsx)?;
    sheet.autofit();
    Ok(())
}

fn write_reconciliation(
    sheet: &mut Worksheet,
    rows: &[AccountRow],
    summary: &Value,
    result: &Value,
) -> Result<(), AppError> {
    sheet.set_name("与TB利息收入勾稽").map_err(xlsx)?;
    let amount = Format::new().set_num_format("#,##0.00;[Red](#,##0.00);-");
    let percent = Format::new().set_num_format("0.00%");
    let bold = Format::new().set_bold();
    let last = rows.len() as u32 + 1;
    let booked = summary["bookedInterestIncome"].as_f64().unwrap_or(0.0);
    sheet
        .write_string_with_format(0, 0, "存款利息测算与账面利息收入比较", &bold)
        .map_err(xlsx)?;
    sheet.write_string(2, 0, "审计测算存款利息").map_err(xlsx)?;
    sheet
        .write_formula_with_format(
            2,
            1,
            Formula::new(format!("SUM('{SUMMARY_SHEET}'!N2:N{last})")).set_result(
                summary["calculatedInterest"]
                    .as_f64()
                    .unwrap_or(0.0)
                    .to_string(),
            ),
            &amount,
        )
        .map_err(xlsx)?;
    sheet
        .write_string(3, 0, "TB 账面利息收入（取自利息收入类科目）")
        .map_err(xlsx)?;
    sheet
        .write_number_with_format(3, 1, booked, &amount)
        .map_err(xlsx)?;
    sheet
        .write_string(4, 0, "差异（测算－账面）")
        .map_err(xlsx)?;
    sheet
        .write_formula_with_format(4, 1, Formula::new("B3-B4"), &amount)
        .map_err(xlsx)?;
    sheet.write_string(5, 0, "差异率").map_err(xlsx)?;
    sheet
        .write_formula_with_format(5, 1, Formula::new("IFERROR(ABS(B5/B4),0)"), &percent)
        .map_err(xlsx)?;
    let mut y = 6u32;
    if !summary["hasInterestIncomeAccount"]
        .as_bool()
        .unwrap_or(false)
    {
        sheet
            .write_string(
                y,
                0,
                "提示：TB 中未识别到利息收入科目，账面金额为 0，差异不具备勾稽意义。",
            )
            .map_err(xlsx)?;
        y += 1;
    }
    let missing = summary["missingRateCount"].as_u64().unwrap_or(0);
    if missing > 0 {
        let tiers = summary["missingRateTiers"]
            .as_array()
            .map(|all| {
                all.iter()
                    .filter_map(Value::as_str)
                    .collect::<Vec<_>>()
                    .join("、")
            })
            .unwrap_or_default();
        sheet.write_string(y, 0, format!(
            "提示：{missing} 个账户尚未确定利率（{tiers}），月均余额合计 {:.2}，其利息未计入上方测算合计，本次差异尚不完整。",
            summary["missingRateBalance"].as_f64().unwrap_or(0.0)
        )).map_err(xlsx)?;
        y += 1;
    }
    if summary["ratesStale"].as_bool().unwrap_or(false) {
        sheet
            .write_string(y, 0, summary["staleMessage"].as_str().unwrap_or(""))
            .map_err(xlsx)?;
        y += 1;
    }
    y += 2;
    sheet
        .write_string_with_format(y, 0, "账面利息收入科目明细", &bold)
        .map_err(xlsx)?;
    y += 1;
    for (column, title) in ["核算主体", "科目", "账面金额"].iter().enumerate() {
        sheet
            .write_string_with_format(y, column as u16, *title, &header_format())
            .map_err(xlsx)?;
    }
    let empty: Vec<Value> = vec![];
    for item in result["bookedInterestRows"].as_array().unwrap_or(&empty) {
        y += 1;
        sheet
            .write_string(y, 0, item["entity"].as_str().unwrap_or(""))
            .map_err(xlsx)?;
        sheet
            .write_string(y, 1, item["account"].as_str().unwrap_or(""))
            .map_err(xlsx)?;
        sheet
            .write_number_with_format(y, 2, item["bookedAmount"].as_f64().unwrap_or(0.0), &amount)
            .map_err(xlsx)?;
    }
    sheet.set_column_width(0, 42).map_err(xlsx)?;
    sheet.set_column_width(1, 34).map_err(xlsx)?;
    sheet.autofit();
    Ok(())
}

fn write_rate_tiers(sheet: &mut Worksheet, params: &Value) -> Result<(), AppError> {
    sheet.set_name("存款利率档位").map_err(xlsx)?;
    let percent = Format::new().set_num_format("0.0000%");
    let bold = Format::new().set_bold();
    let custom = params.get("tierRates").and_then(Value::as_object);
    let titles = [
        "大类".to_string(),
        "期限".to_string(),
        format!("央行基准（{PBC_BENCHMARK_DATE} 起未调整，仅上限参照）"),
        format!("大行挂牌参考（{LISTED_REFERENCE_DATE}）"),
        "实务常见区间".to_string(),
        "本次测算采用".to_string(),
        "实务说明".to_string(),
    ];
    for (column, title) in titles.iter().enumerate() {
        sheet
            .write_string_with_format(0, column as u16, title, &header_format())
            .map_err(xlsx)?;
    }
    for (index, tier) in RATE_TIERS.iter().enumerate() {
        let y = index as u32 + 1;
        sheet
            .write_string(y, 0, tier.category_label)
            .map_err(xlsx)?;
        sheet.write_string(y, 1, tier.term_label).map_err(xlsx)?;
        match tier.benchmark {
            Some(rate) => sheet
                .write_number_with_format(y, 2, rate, &percent)
                .map_err(xlsx)?,
            None => sheet.write_string(y, 2, "央行未公布").map_err(xlsx)?,
        };
        match tier.listed {
            Some(rate) => sheet
                .write_number_with_format(y, 3, rate, &percent)
                .map_err(xlsx)?,
            None => sheet.write_string(y, 3, "按存款协议").map_err(xlsx)?,
        };
        match tier.practice {
            Some((low, high)) => sheet
                .write_string(y, 4, format!("{:.2}% ~ {:.2}%", low * 100.0, high * 100.0))
                .map_err(xlsx)?,
            None => sheet.write_string(y, 4, "—").map_err(xlsx)?,
        };
        // “本次测算采用”把用户改过的档位利率也落在底稿里，便于复核。
        let applied = custom
            .and_then(|all| all.get(tier.key))
            .and_then(Value::as_f64)
            .map(normalize_rate)
            .or_else(|| auto_rate(tier.key));
        match applied {
            Some(rate) => sheet
                .write_number_with_format(y, 5, rate, &percent)
                .map_err(xlsx)?,
            None => sheet.write_string(y, 5, "需填实际利率").map_err(xlsx)?,
        };
        sheet.write_string(y, 6, tier.practice_note).map_err(xlsx)?;
    }
    let mut y = RATE_TIERS.len() as u32 + 2;
    let age = listed_rate_age_months();
    let mut lines = vec![
        "自动套用范围：只有活期自动套用默认利率——对公活期没有议价空间。协定、通知、定期、大额存单的利率是逐笔合同约定的，默认留空，须填入实际利率后才计入测算合计。".to_string(),
        format!("央行基准来源：中国人民银行《金融机构人民币存款基准利率调整表》，{PBC_BENCHMARK_DATE} 起执行，至今未再调整。仅作合理性上限参照，不参与测算——3 年期基准 2.75% 对比实际约 1.25%，拿它算会把利息放大一倍以上。"),
        format!("大行挂牌来源：国有大型商业银行人民币存款挂牌利率，{LISTED_REFERENCE_DATE} 调整后水平；2022 年建立存款利率市场化调整机制后由各行自主报价，已多轮下调。"),
        "实务常见区间：常见报价范围的经验值，不是官方公布数据，只用于提示填入的利率是否明显偏离。".to_string(),
        "审计依据：以上都只是默认值和合理性参照。实际计息利率应以客户的存款协议、银行对账单或银行出具的利息清单为准。".to_string(),
        "官方查询入口：中国人民银行 http://www.pbc.gov.cn/ （货币政策—利率政策）；中国货币网 https://www.chinamoney.com.cn/ （利率自律机制公告）；各行挂牌利率见其官网“人民币存款利率表”栏目。".to_string(),
        "修改方式：档位利率可在工具界面的「存款利率档位」中改写；单个账户的利率可在「测算汇总」H 列直接改写，单户改写优先于档位默认值。".to_string(),
    ];
    if age > RATE_STALE_AFTER_MONTHS {
        lines.insert(0, format!(
            "【过期提醒】内置挂牌利率最后更新于 {LISTED_REFERENCE_DATE}，距本次测算约 {age} 个月，期间挂牌利率很可能已调整，请核对最新挂牌利率后再使用默认值。"
        ));
    }
    for line in lines {
        sheet
            .write_string_with_format(y, 0, &line, &bold)
            .map_err(xlsx)?;
        y += 1;
    }
    sheet.set_column_width(0, 20).map_err(xlsx)?;
    sheet.set_column_width(1, 12).map_err(xlsx)?;
    for column in 2..6 {
        sheet.set_column_width(column, 24).map_err(xlsx)?;
    }
    sheet.set_column_width(6, 80).map_err(xlsx)?;
    Ok(())
}

fn write_parameters(
    sheet: &mut Worksheet,
    summary: &Value,
    rows: &[AccountRow],
) -> Result<(), AppError> {
    sheet.set_name("参数与口径").map_err(xlsx)?;
    let bold = Format::new().set_bold();
    let items: Vec<(String, String)> = vec![
        ("测算期间".into(), format!(
            "{} 至 {}",
            summary["reportStart"].as_str().unwrap_or(""),
            summary["reportEnd"].as_str().unwrap_or("")
        )),
        ("月度余额来源".into(), summary["monthlySource"].as_str().unwrap_or("").into()),
        ("序时账金额口径".into(), summary["amountScheme"].as_str().unwrap_or("—").into()),
        ("口径判定依据".into(), summary["amountEvidence"].as_str().unwrap_or("—").into()),
        ("计息口径".into(), summary["dayBasisLabel"].as_str().unwrap_or("").into()),
        ("利率口径".into(), summary["rateBasisLabel"].as_str().unwrap_or("").into()),
        ("纳入测算账户数".into(), rows.len().to_string()),
        ("待复核账户数".into(), summary["reviewCount"].to_string()),
        ("待填利率账户数".into(), summary["missingRateCount"].to_string()),
        ("计算口径".into(), "月均余额 =（月初余额＋月末余额）÷2；当月利息 = 月均余额 × 年利率 × 计息天数 ÷ 年基数。".into()),
        ("勾稽口径".into(), "测算利息合计与 TB 利息收入类科目本期发生额净额比较，差异率超过 5% 提示复核。".into()),
        ("修改方式".into(), format!("在「{SUMMARY_SHEET}」H 列黄色「年利率」单元格直接改写利率，「{MONTHLY_SHEET}」的月度利息、汇总的测算利息和勾稽表会自动重算。")),
        ("空白利率格".into(), "活期以外的档位不自动套用默认利率，H 列留空即表示该户利率尚未确定；填入实际利率后金额自动出现。".into()),
    ];
    let items = if summary["ratesStale"].as_bool().unwrap_or(false) {
        let mut all = items;
        all.push((
            "利率过期提醒".into(),
            summary["staleMessage"].as_str().unwrap_or("").into(),
        ));
        all
    } else {
        items
    };
    for (index, (key, value)) in items.iter().enumerate() {
        let y = index as u32;
        sheet
            .write_string_with_format(y, 0, key, &bold)
            .map_err(xlsx)?;
        sheet.write_string(y, 1, value).map_err(xlsx)?;
    }
    sheet.set_column_width(0, 20).map_err(xlsx)?;
    sheet.set_column_width(1, 92).map_err(xlsx)?;
    Ok(())
}

fn xlsx(value: XlsxError) -> AppError {
    error(
        "EXPORT_FAILED",
        "无法生成 Excel 底稿。",
        Some(value.to_string()),
    )
}

// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    /// 真实 SAP 样例（汇兑损益测试资料/Oct+BS+PL+TB.xlsx 与 JE+YTD+OCT.xlsx）。
    /// 只在样例文件存在时运行，缺文件就跳过，不阻塞常规测试。
    /// 科目编码与科目名称现在是两个角色，断言时合起来看。
    fn account_columns_of(map: &Value) -> Vec<String> {
        let mut out = Vec::new();
        for role in ["accountCode", "accountName"] {
            match &map[role] {
                Value::String(one) => out.push(one.clone()),
                Value::Array(all) => {
                    out.extend(all.iter().filter_map(Value::as_str).map(str::to_string))
                }
                _ => {}
            }
        }
        out
    }

    #[test]
    fn maps_and_classifies_the_real_sap_sample() {
        let Some(base) = sample_dir() else { return };
        let tb_path = base.join("Oct+BS+PL+TB.xlsx");
        let je_path = base.join("JE+YTD+OCT.xlsx");
        if !tb_path.is_file() || !je_path.is_file() {
            eprintln!("跳过：未找到 SAP 样例文件 {}", base.display());
            return;
        }

        let tb = inspect(
            &json!({"source": {"inputPath": tb_path.to_string_lossy()}}),
            "tb",
        )
        .unwrap();
        let tb_map = &tb["suggestedMapping"];
        // 科目编码与科目名称拆成两个角色，但分类仍要拿到两者的完整文本。
        let account_cols = account_columns_of(tb_map);
        assert!(
            account_cols.iter().any(|x| x == "GL Account"),
            "科目编码未映射: {account_cols:?}"
        );
        assert!(
            account_cols.iter().any(|x| x == "GL Description"),
            "科目名称未映射: {account_cols:?}"
        );
        assert_eq!(tb_map["entity"], json!("Company Code"));
        assert_eq!(
            tb_map["closingFunctionalAmount"],
            json!("YTD Act (Local Curr)"),
            "期末余额应取本位币 YTD，而不是集团币"
        );

        let roles = tb["suggestedAccountRoles"].as_object().unwrap();
        let role_of = |needle: &str| -> String {
            roles
                .iter()
                .find(|(key, _)| key.contains(needle))
                .map(|(_, value)| value.as_str().unwrap_or("").to_string())
                .unwrap_or_else(|| panic!("样例里找不到科目 {needle}"))
        };
        assert_eq!(role_of("USD BOC-CPCSC-SH"), "deposit");
        assert_eq!(role_of("RMB BOA CPCSC Cash"), "deposit");
        assert_eq!(role_of("HSBC USD CPCSC"), "deposit");
        assert_eq!(role_of("RMB CMB CPCSC"), "deposit");
        assert_eq!(role_of("Cash-Other"), "deposit");
        assert_eq!(role_of("Int Income-Dom O/S"), "interest_income");
        // 干扰项：银行手续费是费用、影子清算户是技术科目，都不能当成存款。
        assert_eq!(role_of("Bank Service Charges"), "excluded");
        assert_eq!(role_of("Shdw All Bnk Cl Acct"), "excluded");
        assert_eq!(role_of("Accts Rec-Trade"), "excluded");

        let je = inspect(
            &json!({"source": {"inputPath": je_path.to_string_lossy()}}),
            "je",
        )
        .unwrap();
        let je_map = &je["suggestedMapping"];
        assert_eq!(je_map["date"], json!("Posting Date"));
        assert_eq!(je_map["accountCode"], json!("G/L Account"));
        assert_eq!(
            je_map["functionalAmount"],
            json!("Company Code Currency Value"),
            "本位币金额应避开 Group/Document Currency Value"
        );
        // 凭证号是 multi 角色（可能拆「凭证字＋凭证号」两列），映射值统一为数组形状。
        assert_eq!(je_map["id"], json!(["Document Number"]));

        // 完整跑一遍：TB 只出到 010 期间且没有年初余额列，两条路径都要走通。
        let params = json!({
            "reportStart": "2025-01-01", "reportEnd": "2025-10-31",
            "dayBasis": "month12",
            "tbSource": {"inputPath": tb_path.to_string_lossy()},
            "tbMapping": tb_map,
            "jeSource": {"inputPath": je_path.to_string_lossy()},
            "jeMapping": je_map
        });
        let cancel = Arc::new(AtomicBool::new(false));
        let pause = PauseCheckpoint::unpaused(cancel.clone());
        let result = run_job("deposit.preview", params, &|_, _, _, _| {}, cancel, &pause).unwrap();
        let summary = &result["summary"];
        eprintln!(
            "SAP 样例测算结果: {}",
            serde_json::to_string_pretty(summary).unwrap()
        );

        // 只到 10 月，不能凭空多算 11、12 月。
        assert_eq!(summary["monthCount"], json!(10));
        assert_eq!(summary["months"], json!([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]));
        assert_eq!(
            summary["openingSource"],
            "全部由期末余额倒推（TB 无年初余额列）"
        );
        assert_eq!(summary["monthlySource"], "序时账逐月还原");
        assert!(
            summary["accountCount"].as_u64().unwrap() >= 7,
            "应识别出多个银行账户"
        );
        assert!(summary["hasInterestIncomeAccount"].as_bool().unwrap());
        // 520000 Int Income-Dom O/S 的 YTD 是 -1,582,447.80（贷方 = 收入）。
        assert!(
            (summary["bookedInterestIncome"].as_f64().unwrap() - 1_582_447.80).abs() < 1.0,
            "账面利息收入应取自 520000"
        );
        // 全部落活期档，自动套用 0.05%，所以一定测得出数且没有待填利率。
        // 三个美元户（USD BOC / USD BOA / HSBC USD）大类同样兜底为活期，
        // 但不自动套人民币挂牌利率，必须落到待填，否则会把美元存款利息严重低估。
        assert_eq!(summary["missingRateCount"], json!(3));
        assert_eq!(summary["missingRateTiers"], json!(["活期存款"]));
        assert!(summary["calculatedInterest"].as_f64().unwrap() > 0.0);
        let usd = rows_of(&result, "USD BOA");
        assert_eq!(usd["tier"], "demand");
        assert!(!usd["rateResolved"].as_bool().unwrap());
        assert!(usd["tierMatchedBy"].as_str().unwrap().contains("USD"));
        let rmb = rows_of(&result, "RMB CMB");
        assert_eq!(rmb["tier"], "demand");
        assert!(rmb["rateResolved"].as_bool().unwrap());
        let rows = result["rows"].as_array().unwrap();
        assert!(
            rows.iter()
                .all(|row| row["months"].as_array().unwrap().len() == 10)
        );
        assert!(
            rows.iter()
                .all(|row| !row["openingFromTb"].as_bool().unwrap())
        );
    }

    fn sample_dir() -> Option<PathBuf> {
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .and_then(Path::parent)
            .map(|root| root.join("汇兑损益测试资料"))
    }

    #[test]
    fn 用友真实样例只取末级科目且红字冲销后全部勾稽() {
        let Some(base) = sample_dir() else { return };
        let tb_path = base.join("科目余额表.xls");
        let je_path = base.join("序时账-1.xlsx");
        if !tb_path.is_file() || !je_path.is_file() {
            eprintln!("跳过：未找到用友真实样例");
            return;
        }
        let tb = inspect(
            &json!({"source": {"inputPath": tb_path.to_string_lossy()}}),
            "tb",
        )
        .unwrap();
        let je = inspect(
            &json!({"source": {"inputPath": je_path.to_string_lossy()}}),
            "je",
        )
        .unwrap();
        assert_eq!(je["suggestedMapping"]["functionalAmount"], "金额");
        let params = json!({
            "reportStart": "2024-01-01", "reportEnd": "2024-12-31", "dayBasis": "month12",
            "tbSource": {"inputPath": tb_path.to_string_lossy()}, "tbMapping": tb["suggestedMapping"],
            "jeSource": {"inputPath": je_path.to_string_lossy()}, "jeMapping": je["suggestedMapping"]
        });
        let cancel = Arc::new(AtomicBool::new(false));
        let pause = PauseCheckpoint::unpaused(cancel.clone());
        let result = run_job("deposit.preview", params, &|_, _, _, _| {}, cancel, &pause).unwrap();
        let rows = result["rows"].as_array().unwrap();
        assert_eq!(
            rows.len(),
            11,
            "1002 汇总行不得与 11 个末级账户重复进入测算"
        );
        assert!(
            rows.iter()
                .all(|row| row["account"].as_str().unwrap_or("") != "1002 银行存款")
        );
        for row in rows {
            assert!(
                row["reconciliationDiff"].as_f64().unwrap().abs() < 0.01,
                "{} 未勾稽：{}",
                row["account"],
                row["reconciliationDiff"]
            );
        }
    }

    fn rows_of<'a>(result: &'a Value, needle: &str) -> &'a Value {
        result["rows"]
            .as_array()
            .unwrap()
            .iter()
            .find(|row| row["account"].as_str().unwrap_or("").contains(needle))
            .unwrap_or_else(|| panic!("结果里找不到账户 {needle}"))
    }

    /// 国内科目表样例（TB-4800 + 4800_JE_2025.01-12）。列名是"期初/期末金额-本位币"
    /// 而不是"余额"，序时账的本位币金额自带正负号、借贷标识用 SAP 的 S/H。
    #[test]
    fn maps_and_calculates_the_domestic_4800_sample() {
        let Some(base) = sample_dir() else { return };
        let tb_path = base.join("TB-4800.xlsx");
        let je_path = base.join("4800_JE_2025.01-12.xlsx");
        if !tb_path.is_file() || !je_path.is_file() {
            eprintln!("跳过：未找到 4800 样例文件");
            return;
        }
        let tb = inspect(
            &json!({"source": {"inputPath": tb_path.to_string_lossy()}}),
            "tb",
        )
        .unwrap();
        let tb_map = &tb["suggestedMapping"];
        let account_cols = account_columns_of(tb_map);
        // 科目名称必须一起进来，否则分类只看到 "6701030001" 这串数字。
        assert!(
            account_cols.iter().any(|x| x == "科目代码"),
            "{account_cols:?}"
        );
        assert!(
            account_cols.iter().any(|x| x == "科目名称二级"),
            "{account_cols:?}"
        );
        // 本位币优先于集团货币；"绝对差异"不能被当成余额或发生额。
        // 发生额列没写"本期"还是"本年"，一律按本年累计（审计导出的是全年数）。
        assert_eq!(tb_map["closingFunctionalAmount"], json!("期末金额-本位币"));
        assert_eq!(tb_map["openingFunctionalAmount"], json!("期初金额-本位币"));
        assert_eq!(tb_map["ytdFunctionalDebit"], json!("借方金额-本位币"));
        assert_eq!(tb_map["ytdFunctionalCredit"], json!("贷方金额-本位币"));
        // 辅助核算同样是 multi 角色，命中一列时也用单元素数组。
        assert_eq!(tb_map["auxiliary"], json!(["文本"]));

        let roles = tb["suggestedAccountRoles"].as_object().unwrap();
        let role_of = |needle: &str| -> String {
            roles
                .iter()
                .find(|(key, _)| key.contains(needle))
                .map(|(_, value)| value.as_str().unwrap_or("").to_string())
                .unwrap_or_else(|| panic!("样例里找不到科目 {needle}"))
        };
        assert_eq!(role_of("1002010017"), "deposit");
        assert_eq!(role_of("1003010003"), "other_monetary");
        assert_eq!(
            role_of("6701030001"),
            "interest_income",
            "财务费用-利息收入应作勾稽基准"
        );
        // 内部利息收入来自关联方往来，而往来科目在存款侧已被排除在计息范围外；
        // 收入侧再把它算进基准，估算与基准覆盖的科目就不是同一批，必然对不上。
        // 资金池等确需纳入的情形，用户在科目分类里逐个改回即可。
        assert_eq!(
            role_of("6111020001"),
            "excluded",
            "投资收益-内部利息收入不是存款利息"
        );
        // 过渡户、现流调整户、应收利息都不是可计息存款。
        assert_eq!(role_of("1002990001"), "excluded");
        assert_eq!(role_of("1002980001"), "excluded");
        assert_eq!(role_of("1004010001"), "excluded");

        let je = inspect(
            &json!({"source": {"inputPath": je_path.to_string_lossy()}}),
            "je",
        )
        .unwrap();
        let je_map = &je["suggestedMapping"];
        assert_eq!(
            je_map["date"],
            json!("记帐日期"),
            "不能错选录入用的“输入日期”"
        );
        assert_eq!(
            je_map["functionalAmount"],
            json!("本位币金额"),
            "不能错选凭证货币或集团货币"
        );
        assert_eq!(je_map["direction"], json!("借贷"));

        let params = json!({
            "reportStart": "2025-01-01", "reportEnd": "2025-12-31",
            "dayBasis": "month12",
            "tbSource": {"inputPath": tb_path.to_string_lossy()},
            "tbMapping": tb_map,
            "jeSource": {"inputPath": je_path.to_string_lossy()},
            "jeMapping": je_map
        });
        let cancel = Arc::new(AtomicBool::new(false));
        let pause = PauseCheckpoint::unpaused(cancel.clone());
        let result = run_job("deposit.preview", params, &|_, _, _, _| {}, cancel, &pause).unwrap();
        let summary = &result["summary"];
        eprintln!(
            "4800 测算结果: {}",
            serde_json::to_string_pretty(summary).unwrap()
        );

        // 期初余额直接来自 TB，不再倒推。
        assert_eq!(summary["openingSource"], "TB 年初余额");
        assert!(summary["hasInterestIncomeAccount"].as_bool().unwrap());
        // 只取 财务费用-利息收入 78,564.20；投资收益-内部利息收入 62,337.51 属关联方
        // 往来利息，往来科目在存款侧已被排除，收入侧再计入就会凭空撑出 6 万多的假差异。
        assert!(
            (summary["bookedInterestIncome"].as_f64().unwrap() - 78_564.20).abs() < 1.0,
            "账面利息收入取数不对: {}",
            summary["bookedInterestIncome"]
        );
        // 最有力的证据：13 个账户全部由序时账逐月还原后，期末余额与 TB 分毫不差。
        // 之前把带符号金额取绝对值时，这里会差出几千万。
        assert_eq!(result["rows"].as_array().unwrap().len(), 13);
        for row in result["rows"].as_array().unwrap() {
            let account = row["account"].as_str().unwrap_or("");
            assert!(
                row["openingFromTb"].as_bool().unwrap(),
                "{account} 期初应直接取自 TB"
            );
            assert!(
                row["reconciliationDiff"].as_f64().unwrap().abs() < 1.0,
                "{account} 序时账还原的期末余额与 TB 对不上: {}",
                row["reconciliationDiff"]
            );
            // 只有货币资金科目能进来，负债/损益类必须被挡在外面。
            assert!(
                account.contains("货币资金"),
                "{account} 不该被当成可计息存款"
            );
        }
        // 10 个外币户（USD/HKD）大类兜底为活期，但不套人民币活期挂牌，落到待填利率。
        assert_eq!(summary["missingRateCount"], json!(10));
        assert_eq!(summary["missingRateTiers"], json!(["活期存款"]));
        // 建行 RMB3250 户：期初 255.21 ＋ 借 143,172.03 － 贷 130,827.78 ＝ 期末 12,599.46。
        let rmb = rows_of(&result, "1002010017");
        assert!((rmb["openingBalance"].as_f64().unwrap() - 255.21).abs() < 0.01);
        assert!((rmb["tbClosingBalance"].as_f64().unwrap() - 12_599.46).abs() < 0.01);
        assert!(
            rmb["reconciliationDiff"].as_f64().unwrap().abs() < 1.0,
            "序时账还原的期末余额应与 TB 勾稽: {}",
            rmb["reconciliationDiff"]
        );
        // 测算利息必须为正——负利息说明余额还原反了。
        assert!(
            summary["calculatedInterest"].as_f64().unwrap() > 0.0,
            "测算利息为负: {}",
            summary["calculatedInterest"]
        );
    }

    fn scheme_table(headers: &[&str], rows: &[&[&str]]) -> FxTable {
        FxTable {
            path: PathBuf::new(),
            sheet: "S".into(),
            sheets: vec![],
            header_row: 1,
            header_depth: 1,
            raw_headers: vec![headers.iter().map(|x| (*x).to_string()).collect()],
            headers: headers.iter().map(|x| (*x).to_string()).collect(),
            rows: rows
                .iter()
                .map(|row| row.iter().map(|x| (*x).to_string()).collect())
                .collect(),
            row_count: rows.len(),
            header_candidates: vec![(1, 1.0)],
            sampled: false,
        }
    }

    /// 看账小工具把 JE 金额分成 3 种方案 × 2 种符号口径，共 5 种情形。
    /// 每种都用同样两张配平凭证（凭证配平才有投票依据），只统计银行存款
    /// 那几行的净额：借 100、贷 30，净额必须都是 +70。
    #[test]
    fn covers_all_five_journal_amount_layouts() {
        let bank_net = |table: &FxTable, mapping: Value| {
            let mapping = mapping.as_object().unwrap().clone();
            let scheme = detect_amount_scheme(table, &mapping).unwrap();
            let account = table.headers.iter().position(|h| h == "科目").unwrap();
            let net: f64 = table
                .rows
                .iter()
                .filter(|row| row[account] == "银行存款")
                .map(|row| scheme.net(row))
                .sum();
            (scheme.scheme, scheme.signed, (net * 100.0).round() / 100.0)
        };

        // 方案B ＋ 借贷符号一样：借贷分列都是正数。
        let table = scheme_table(
            &["凭证号", "科目", "借方金额", "贷方金额"],
            &[
                &["V1", "银行存款", "100", "0"],
                &["V1", "应收账款", "0", "100"],
                &["V2", "银行存款", "0", "30"],
                &["V2", "管理费用", "30", "0"],
            ],
        );
        let split =
            json!({"id": "凭证号", "functionalDebit": "借方金额", "functionalCredit": "贷方金额"});
        assert_eq!(bank_net(&table, split.clone()), ("B", false, 70.0));

        // 方案B ＋ 已带符号：贷方列是负数。若照搬"借减贷"会算成 130。
        let table = scheme_table(
            &["凭证号", "科目", "借方金额", "贷方金额"],
            &[
                &["V1", "银行存款", "100", "0"],
                &["V1", "应收账款", "0", "-100"],
                &["V2", "银行存款", "0", "-30"],
                &["V2", "管理费用", "30", "0"],
            ],
        );
        assert_eq!(bank_net(&table, split), ("B", true, 70.0));

        // 方案A ＋ 借贷符号一样：金额全正，靠方向列区分。
        let table = scheme_table(
            &["凭证号", "科目", "金额", "借贷"],
            &[
                &["V1", "银行存款", "100", "借"],
                &["V1", "应收账款", "100", "贷"],
                &["V2", "银行存款", "30", "贷"],
                &["V2", "管理费用", "30", "借"],
            ],
        );
        let directed = json!({"id": "凭证号", "functionalAmount": "金额", "direction": "借贷"});
        assert_eq!(bank_net(&table, directed.clone()), ("A", false, 70.0));

        // 方案A ＋ 已带符号：SAP 的 S/H 标识配上带符号的本位币金额。
        let table = scheme_table(
            &["凭证号", "科目", "金额", "借贷"],
            &[
                &["V1", "银行存款", "100", "S"],
                &["V1", "应收账款", "-100", "H"],
                &["V2", "银行存款", "-30", "H"],
                &["V2", "管理费用", "30", "S"],
            ],
        );
        assert_eq!(bank_net(&table, directed), ("A", true, 70.0));

        // 单一金额列：必然已带符号，否则凭证配不平。
        let table = scheme_table(
            &["凭证号", "科目", "本位币金额"],
            &[
                &["V1", "银行存款", "100"],
                &["V1", "应收账款", "-100"],
                &["V2", "银行存款", "-30"],
                &["V2", "管理费用", "30"],
            ],
        );
        let single = json!({"id": "凭证号", "functionalAmount": "本位币金额"});
        assert_eq!(bank_net(&table, single), ("single", true, 70.0));
    }

    /// 判不出来就明确报错停下来，而不是拿一个含糊的结论继续算。
    /// 人工选择记法已从界面移除，报错只指向换数据或改用两点法。
    #[test]
    fn stops_when_the_layout_cannot_be_decided_automatically() {
        // 借贷分列，但贷方列正负各半，两种记法都说得通。
        let table = scheme_table(
            &["凭证号", "科目", "借方金额", "贷方金额"],
            &[
                &["V1", "银行存款", "100", "0"],
                &["V1", "应收账款", "0", "100"],
                &["V2", "银行存款", "0", "-30"],
                &["V2", "管理费用", "30", "0"],
            ],
        );
        let mapping =
            json!({"id": "凭证号", "functionalDebit": "借方金额", "functionalCredit": "贷方金额"})
                .as_object()
                .unwrap()
                .clone();
        let err = detect_amount_scheme(&table, &mapping).unwrap_err();
        assert_eq!(err.code, "AMOUNT_SCHEME_UNDETERMINED");
        assert!(err.user_message.contains("无法自动判断"));
        assert!(!err.user_message.contains("手工选择"));
        assert!(err.user_message.contains("两点法"));
    }

    #[test]
    fn extracts_the_account_code_from_a_multi_column_label() {
        // 多列映射的拼接顺序不固定，编码可能在最前也可能在最后。
        assert_eq!(
            account_code("1002010017 货币资金 银行存款-建设银行"),
            "1002010017"
        );
        assert_eq!(
            account_code("货币资金 货币资金-银行存款-建设银行 1002010017"),
            "1002010017"
        );
        assert_eq!(account_code("100332 USD BOC-CPCSC-SH"), "100332");
        assert_eq!(account_code("1002.01 银行存款"), "1002.01");
        // 认不出编码时退回第一个词，行为与从前一致。
        assert_eq!(account_code("银行存款"), "银行存款");
        assert_eq!(account_code(""), "");
    }

    #[test]
    fn classifies_monetary_and_interest_accounts() {
        assert_eq!(suggest_account_role("1002 银行存款"), "deposit");
        assert_eq!(
            suggest_account_role("100201 银行存款-工行基本户"),
            "deposit"
        );
        assert_eq!(suggest_account_role("1012 其他货币资金"), "other_monetary");
        assert_eq!(suggest_account_role("1012.02 定期存款"), "other_monetary");
        assert_eq!(suggest_account_role("1001 库存现金"), "cash_on_hand");
        assert_eq!(suggest_account_role("6051 利息收入"), "interest_income");
        assert_eq!(
            suggest_account_role("660301 财务费用-利息收入"),
            "interest_income"
        );
        assert_eq!(suggest_account_role("1122 应收账款"), "excluded");
        // 投资收益核算金融资产投资回报，不是损益口径的存款利息收入，一律不作基准
        // ——哪怕名字里写着"利息收入"（真实 4800 账套的「投资收益-内部利息收入」
        // 就是这样被带进基准的），也哪怕是理财、结构性存款这类看着像存款的。
        assert_eq!(
            suggest_account_role("6111020001 投资收益-内部利息收入"),
            "excluded"
        );
        assert_eq!(
            suggest_account_role("6111010001 投资收益-结构性存款利息收入"),
            "excluded"
        );
        // 内部／关联方拆借利息是往来利息，往来科目在存款侧已被排除。
        assert_eq!(
            suggest_account_role("6051020001 利息收入-关联方拆借"),
            "excluded"
        );
        assert_eq!(
            suggest_account_role("6111030001 投资收益-委托贷款利息收入"),
            "excluded"
        );
        // 科目名称的证据优先于编码前缀：SAP 的六位编码 100332 恰好以 1003
        // 开头，但名称里的 BOC 说明它是银行存款，不是其他货币资金。
        assert_eq!(suggest_account_role("100332 USD BOC-CPCSC-SH"), "deposit");
        assert_eq!(
            suggest_account_role("1003010003 货币资金-其他货币资金-保证金"),
            "other_monetary"
        );
        // 名称给不出线索时才退回中国科目表的一级编码。
        assert_eq!(suggest_account_role("1003990001"), "other_monetary");
        assert_eq!(suggest_account_role("1002990002"), "deposit");
        // 负债、损益类科目不可能是存款，哪怕名字里带"保证金""银行"。
        assert_eq!(
            suggest_account_role("2241120001 其他应付款-销售保证金"),
            "excluded"
        );
        assert_eq!(
            suggest_account_role("709002 Bank Service Charges"),
            "excluded"
        );
    }

    #[test]
    fn infers_deposit_tier_from_account_text() {
        let key = |text: &str| suggest_tier(text).0;
        // 认不出期限关键字就落活期，这是最保守的一档。
        assert_eq!(key("银行存款-工行基本户"), "demand");
        assert_eq!(key("其他货币资金-三个月定期存款"), "term_3m");
        assert_eq!(key("定期存款-3年期"), "term_3y");
        assert_eq!(key("其他货币资金-定期存款"), "term_1y");
        assert_eq!(key("通知存款(7天)"), "notice_7d");
        assert_eq!(key("通知存款-1天"), "notice_1d");
        assert_eq!(key("协定存款账户"), "agreement");
        assert_eq!(key("大额存单"), "cd_1y");
        assert_eq!(key("3年期大额存单"), "cd_3y");
    }

    /// 外币户：大类同样兜底为活期（认不出类型一律落活期），
    /// 但人民币挂牌利率不会被自动套用，必须由用户按对账单填。
    #[test]
    fn foreign_currency_falls_back_to_demand_but_never_auto_fills_rmb_rate() {
        let (tier, reason) = suggest_tier("100332 USD BOC-CPCSC-SH");
        assert_eq!(tier, "demand");
        assert!(reason.contains("USD") && reason.contains("活期"));
        let row = AccountRow {
            account: "100332 USD BOC-CPCSC-SH".into(),
            tier: "demand".into(),
            ..blank_row()
        };
        let resolved = resolve_rate(&row, None, None);
        assert!(!resolved.resolved && resolved.rate == 0.0);
        assert_eq!(resolved.source, "需填写实际利率");
        // 人民币户不受影响，仍自动套活期挂牌。
        let rmb = AccountRow {
            account: "100201 RMB CMB-CPCSC-SH".into(),
            tier: "demand".into(),
            ..blank_row()
        };
        assert!(resolve_rate(&rmb, None, None).resolved);
        // 认不出的档位键也回落活期，不再冒出"自定义"。
        assert_eq!(RATE_TIERS[0].key, "demand", "第一档必须是活期，兜底靠它");
        assert_eq!(tier_label("不存在的档位"), "活期存款");
    }

    #[test]
    fn reports_why_a_tier_was_chosen() {
        assert!(suggest_tier("其他货币资金-定期存款").1.contains("定期"));
        assert_eq!(
            suggest_tier("银行存款-基本户").1,
            "未命中期限关键字，默认按活期"
        );
    }

    #[test]
    fn account_type_override_reaches_calculation_and_defaults_to_demand() {
        let params = json!({
            "accountTierOverrides": {
                "100201 银行存款-定期户（分类快照）": "term_1y"
            }
        });
        let selected = tier_for("100201 银行存款（TB末级）", "", &params);
        assert_eq!(selected.0, "term_1y");
        assert!(selected.1.contains("用户"));
        assert_eq!(
            tier_for("100202 银行存款-基本户", "", &json!({})).0,
            "demand"
        );
        assert_eq!(
            tier_for("100203 银行存款-通知存款", "", &json!({})).0,
            "notice_7d"
        );
    }

    #[test]
    fn every_tier_belongs_to_a_category_and_labels_cleanly() {
        for tier in RATE_TIERS {
            assert!(!tier.category.is_empty() && !tier.category_label.is_empty());
            let label = tier_label(tier.key);
            if tier.term_label.is_empty() {
                assert_eq!(label, tier.category_label);
            } else {
                assert!(label.contains(tier.category_label) && label.contains(tier.term_label));
            }
            // 实务区间必须是有效区间，且把内置默认值包在里面。
            if let Some((low, high)) = tier.practice {
                assert!(low <= high, "{} 实务区间上下限颠倒", tier.key);
                if let Some(listed) = tier.listed {
                    assert!(
                        (low..=high).contains(&listed),
                        "{} 挂牌值落在实务区间外",
                        tier.key
                    );
                }
            }
        }
    }

    #[test]
    fn rate_tiers_payload_groups_terms_under_categories() {
        let payload = rate_tiers();
        let categories = payload["categories"].as_array().unwrap();
        let find = |key: &str| {
            categories
                .iter()
                .find(|item| item["key"] == json!(key))
                .unwrap()["terms"]
                .as_array()
                .unwrap()
                .iter()
                .map(|term| term["label"].as_str().unwrap().to_string())
                .collect::<Vec<_>>()
        };
        assert_eq!(find("demand"), vec![""]);
        assert_eq!(find("agreement"), vec![""]);
        assert_eq!(find("notice"), vec!["1天", "7天"]);
        assert_eq!(
            find("term"),
            vec!["3个月", "6个月", "1年", "2年", "3年", "5年"]
        );
        assert_eq!(find("large_cd"), vec!["1年", "2年", "3年"]);
        assert!(!payload["links"].as_array().unwrap().is_empty());
    }

    #[test]
    fn only_built_in_reference_urls_are_allowed() {
        assert!(is_reference_url("http://www.pbc.gov.cn/"));
        // 前缀相同也不放行，避免"以官网开头"就被当成可信地址。
        assert!(!is_reference_url("http://www.pbc.gov.cn/evil"));
        assert!(!is_reference_url("https://example.com/"));
        assert!(!is_reference_url(""));
        // 界面上能点的每一条都必须在白名单里，否则点了会报 URL_NOT_ALLOWED。
        for link in REFERENCE_LINKS {
            assert!(is_reference_url(link.1), "{} 不在白名单里", link.1);
        }
    }

    #[test]
    fn every_reference_link_lands_in_a_declared_group() {
        let payload = rate_tiers();
        let groups: Vec<&str> = payload["linkGroups"]
            .as_array()
            .unwrap()
            .iter()
            .map(|group| group["key"].as_str().unwrap())
            .collect();
        assert_eq!(groups, vec!["official", "bank"]);
        let links = payload["links"].as_array().unwrap();
        assert!(!links.is_empty());
        for link in links {
            let group = link["group"].as_str().unwrap();
            assert!(
                groups.contains(&group),
                "{group} 没有对应的分组标题，界面会漏掉这条链接"
            );
            let url = link["url"].as_str().unwrap();
            assert!(url.starts_with("http"), "{url} 不是有效网址");
            assert!(
                !link["hint"].as_str().unwrap().is_empty(),
                "{url} 缺少查询指引"
            );
        }
        // 央行必须在"官方发布渠道"里——它是基准利率唯一的权威出处。
        assert!(links.iter().any(|link| {
            link["url"] == json!("http://www.pbc.gov.cn/") && link["group"] == json!("official")
        }));
    }

    #[test]
    fn account_rate_beats_tier_rate_beats_built_in() {
        let row = AccountRow {
            key: "K".into(),
            tier: "demand".into(),
            ..blank_row()
        };
        let custom = json!({"demand": 0.002});
        let custom = custom.as_object();
        // 活期的内置默认
        let resolved = resolve_rate(&row, None, None);
        assert_eq!(
            (resolved.rate, resolved.source.as_str()),
            (0.0005, "活期挂牌默认值")
        );
        // 档位级改写盖过内置默认
        let resolved = resolve_rate(&row, None, custom);
        assert_eq!(
            (resolved.rate, resolved.source.as_str()),
            (0.002, "自定义档位利率")
        );
        // 账户级改写优先于档位级；百分数写法自动归一
        let overrides = json!({"K": {"annualRate": 1.25}});
        let resolved = resolve_rate(&row, overrides.as_object(), custom);
        assert_eq!(
            (resolved.rate, resolved.source.as_str()),
            (0.0125, "本账户手工指定")
        );
        // 切到不自动套用的档位后，必须由用户填利率
        let overrides = json!({"K": {"tier": "term_3y"}});
        let resolved = resolve_rate(&row, overrides.as_object(), None);
        assert_eq!(resolved.tier, "term_3y");
        assert!(!resolved.resolved && resolved.rate == 0.0);
        // 档位级填了就能用
        let tier_rates = json!({"term_3y": 1.35});
        let resolved = resolve_rate(&row, overrides.as_object(), tier_rates.as_object());
        assert!(resolved.resolved);
        assert!((resolved.rate - 0.0135).abs() < 1e-12);
    }

    fn blank_row() -> AccountRow {
        AccountRow {
            key: String::new(),
            entity: String::new(),
            account: String::new(),
            auxiliary: String::new(),
            currency: String::new(),
            role: "deposit".into(),
            tier: "demand".into(),
            tier_label: String::new(),
            category: "demand".into(),
            term_label: String::new(),
            tier_matched_by: String::new(),
            rate_source: String::new(),
            annual_rate: 0.0,
            rate_resolved: false,
            rate_warning: String::new(),
            opening_balance: 0.0,
            opening_from_tb: true,
            tb_closing_balance: 0.0,
            derived_closing_balance: 0.0,
            reconciliation_diff: 0.0,
            average_balance: 0.0,
            calculated_interest: 0.0,
            months: vec![],
            status: String::new(),
            note: String::new(),
        }
    }

    #[test]
    fn only_demand_deposits_get_an_automatic_rate() {
        // 活期是唯一自动套用默认值的档位。
        assert_eq!(auto_rate("demand"), Some(0.0005));
        for key in [
            "agreement",
            "notice_7d",
            "term_1y",
            "term_3y",
            "cd_1y",
            "custom",
        ] {
            assert_eq!(auto_rate(key), None, "{key} 不应自动套用默认利率");
        }
        // 挂牌值仍然要能查到，只是不会被自动填进测算。
        assert_eq!(tier_rate("term_3y"), Some(0.0125));
        assert_eq!(tier_rate("custom"), None);
    }

    #[test]
    fn benchmark_is_reference_only_and_never_computes() {
        // 央行基准仍可查询，但没有任何路径会把它当成测算利率。
        assert_eq!(benchmark_rate("term_3y"), Some(0.0275));
        assert_eq!(benchmark_rate("term_5y"), None);
        let row = AccountRow {
            key: "K".into(),
            tier: "term_3y".into(),
            ..blank_row()
        };
        let resolved = resolve_rate(&row, None, None);
        assert!(!resolved.resolved);
        assert_eq!(resolved.rate, 0.0);
        assert_eq!(resolved.source, "需填写实际利率");
    }

    #[test]
    fn flags_listed_rates_once_they_age_out() {
        // 内置挂牌利率取自 2025-05-20；阈值是 12 个月。
        assert!(RATE_STALE_AFTER_MONTHS == 12);
        let payload = rate_tiers();
        let age = payload["rateAgeMonths"].as_i64().unwrap();
        assert_eq!(payload["ratesStale"], json!(age > RATE_STALE_AFTER_MONTHS));
        if age > RATE_STALE_AFTER_MONTHS {
            let message = payload["staleMessage"].as_str().unwrap();
            assert!(message.contains(LISTED_REFERENCE_DATE) && message.contains("核对最新挂牌"));
        } else {
            assert_eq!(payload["staleMessage"], json!(""));
        }
    }

    #[test]
    fn normalizes_user_entered_rates() {
        assert_eq!(normalize_rate(1.5), 0.015);
        assert_eq!(normalize_rate(0.015), 0.015);
        assert_eq!(parse_number("1,234.56"), Some(1234.56));
        assert_eq!(parse_number("(1,000.00)"), Some(-1000.0));
        assert_eq!(parse_number("1.50%"), Some(0.015));
        assert_eq!(parse_number("  -  "), None);
    }

    /// 金额解析收编到引擎宽松口径后的新旧对齐：旧版能读的原样保留，
    /// 引擎补的能力（尾部负号）按引擎算，垃圾文本一律 None。
    #[test]
    fn 金额解析与引擎宽松口径对齐() {
        // 旧版本地实现就支持的写法——换引擎后必须原样保留。
        assert_eq!(parse_number("3.5%"), Some(0.035));
        assert_eq!(parse_number("-3.5%"), Some(-0.035));
        assert_eq!(parse_number("(1,234.56)"), Some(-1234.56));
        assert_eq!(parse_number("¥1,200"), Some(1200.0));
        assert_eq!(parse_number("1,234。56"), Some(1234.56));
        // 引擎补的能力：尾部负号按会计负数读（旧版读不出，返回 None）。
        assert_eq!(parse_number("¥800-"), Some(-800.0));
        // 垃圾文本、占位符与空值一律 None，绝不猜数。
        assert_eq!(parse_number("见备注"), None);
        assert_eq!(parse_number(""), None);
        assert_eq!(parse_number("  -  "), None);
        assert_eq!(parse_number("—"), None);
        assert_eq!(parse_number("N/A"), None);
        assert_eq!(parse_number("%"), None);
        assert_eq!(parse_number("1,2)3"), None);
    }

    #[test]
    fn month12_basis_keeps_one_twelfth_per_month() {
        let start = NaiveDate::from_ymd_opt(2025, 1, 1).unwrap();
        let end = NaiveDate::from_ymd_opt(2025, 12, 31).unwrap();
        assert_eq!(month_days("month12", 2025, 2, start, end), (1.0, 12.0));
        assert_eq!(month_days("actual360", 2025, 1, start, end), (31.0, 360.0));
        assert_eq!(month_days("actual365", 2025, 2, start, end), (28.0, 365.0));
    }

    #[test]
    fn two_point_fallback_matches_simple_average() {
        // 无序时账时全年月均余额的平均值必须等于（年初＋年末）÷2。
        let opening = 1_200_000.0;
        let closing = 2_400_000.0;
        let mut previous = opening;
        let mut total = 0.0;
        for month in 1..=12u32 {
            let current = opening + (closing - opening) * month as f64 / 12.0;
            total += (previous + current) / 2.0;
            previous = current;
        }
        assert!(((total / 12.0) - (opening + closing) / 2.0).abs() < 1e-6);
    }

    #[test]
    fn rejects_unknown_methods() {
        let err = call("deposit.unknown", json!({})).unwrap_err();
        assert_eq!(err.code, "METHOD_NOT_FOUND");
    }

    /// 人工科目分类必须在复测时生效。用户实测的坑：词典没认出利息收入
    /// 科目，人工在界面科目分类里补选「利息收入（勾稽基准）」后点复测，
    /// 基准数仍显示「未识别」——科目清单是识别时的快照，与测算行有两类
    /// 错位：界面把 TB 与序时账两套拼法并进同一张分类表（同编码不同全名），
    /// 以及清单里包含非末级汇总行而测算只读末级。前者按编码回退，后者由
    /// 末级继承汇总行上的指定。
    #[test]
    fn manual_account_roles_survive_snapshot_and_leaf_mismatches() {
        let dir = std::env::temp_dir().join(format!("deposit-roles-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let tb_path = dir.join("tb.xlsx");
        write_fixture(
            &tb_path,
            &[
                vec![
                    "科目编码",
                    "科目名称",
                    "年初余额借方",
                    "期末余额借方",
                    "本期借方发生额",
                    "本期贷方发生额",
                ],
                vec!["1002", "银行存款", "1200000", "2400000", "1200000", "0"],
                // 名称没有利息关键词、损益类编码：自动识别判 excluded，
                // 正是需要人工补选的形态。
                vec!["660299", "财务费用-融资成本", "0", "0", "0", "888"],
                // 汇总行与末级行并存：测算只读末级，但界面清单两者都有。
                vec!["6603", "财务费用", "0", "0", "0", "0"],
                vec!["66030101", "财务费用-手续及利息户", "0", "0", "0", "777"],
            ],
        );
        let tb = inspect(
            &json!({"source": {"inputPath": tb_path.to_string_lossy()}}),
            "tb",
        )
        .unwrap();
        let params = json!({
            "reportStart": "2025-01-01", "reportEnd": "2025-12-31",
            "tbSource": {"inputPath": tb_path.to_string_lossy()},
            "tbMapping": tb["suggestedMapping"],
            // 真实页面会把全部自动预设一起传入；excluded 不能冒充手工排除。
            "accountRoles": tb["suggestedAccountRoles"],
            "accountRoleOverrides": {
                "1002 银行存款": "deposit",
                // 序时账侧的拼法：同编码、不同全名，精确匹配必然落空。
                "660299 财务费用-融资成本 CPCSC": "interest_income",
                // 汇总行上的指定要落到末级 66030101 上。
                "6603 财务费用": "interest_income"
            }
        });
        let cancel = Arc::new(AtomicBool::new(false));
        let pause = PauseCheckpoint::unpaused(cancel.clone());
        let result = run_job("deposit.preview", params, &|_, _, _, _| {}, cancel, &pause).unwrap();
        let summary = &result["summary"];
        assert!(
            summary["hasInterestIncomeAccount"].as_bool().unwrap(),
            "人工指定的利息收入科目应进入基准数: {summary}"
        );
        assert!(
            (summary["bookedInterestIncome"].as_f64().unwrap() - (888.0 + 777.0)).abs() < 0.01,
            "两条人工指定的利息收入都应抓到: {summary}"
        );
        assert_eq!(
            result["bookedInterestRows"].as_array().unwrap().len(),
            2,
            "汇总行本身不进入测算，末级行继承其分类"
        );
        // 自动识别有结论的科目不被上级指定覆盖：1002 仍按存款测算，
        // 而 6603 汇总行不在结果里。
        let rows = result["rows"].as_array().unwrap();
        assert_eq!(rows.len(), 1);
        assert!(rows[0]["account"].as_str().unwrap().contains("银行存款"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 整表只有一列科目、编码＋名称挤在一格（03 号样例形态）时，
    /// 列名判不出科目编码，靠引擎的合并列探测把它建议为 accountCode。
    #[test]
    fn 合并科目列在编码空缺时顶上() {
        let dir = std::env::temp_dir().join(format!("deposit-combined-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        // 表头带「文本」：会被存款扩展的 auxiliary 别名抢走，而「项目编码」
        // 又不是科目编码的别名——按列名科目身份两头落空，只能看数据。
        let path = dir.join("tb.xlsx");
        write_fixture(
            &path,
            &[
                vec![
                    "项目编码、文本",
                    "年初余额借方",
                    "期末余额借方",
                    "本期借方发生额",
                    "本期贷方发生额",
                ],
                vec!["1002010000:银行存款-工商银行", "1000", "2000", "1000", "0"],
                vec!["1002020000:银行存款-建设银行", "1100", "2100", "1000", "0"],
                vec!["1002030000:银行存款-农业银行", "1200", "2200", "1000", "0"],
                vec!["1002040000:银行存款-中国银行", "1300", "2300", "1000", "0"],
            ],
        );
        let inspected = inspect(
            &json!({"source": {"inputPath": path.to_string_lossy()}}),
            "tb",
        )
        .unwrap();
        let mapping = &inspected["suggestedMapping"];
        assert_eq!(
            mapping["accountCode"],
            json!("项目编码、文本"),
            "合并列应由数据形态兜底为科目编码"
        );
        // 编码与名称在同一格里，科目名称同列兼挂，界面不必再提示缺映射。
        assert_eq!(mapping["accountName"], json!(["项目编码、文本"]));
        // 身份列不能兼任辅助核算：整列科目全称当成银行账号会污染分摊。
        assert!(
            mapping.get("auxiliary").is_none(),
            "合并列应从 auxiliary 让位: {mapping}"
        );
        let accounts = inspected["accounts"].as_array().unwrap();
        assert!(
            accounts
                .iter()
                .any(|x| x == &json!("1002010000:银行存款-工商银行")),
            "科目清单应按合并列原文识别: {accounts:?}"
        );
        assert_eq!(
            inspected["suggestedAccountRoles"]["1002010000:银行存款-工商银行"],
            json!("deposit")
        );

        // 裸表头「科目」本身就是科目编码的别名，编码能按列名映射；
        // 此时编码列是合并列而名称空缺，应同列补挂科目名称。
        let single = dir.join("single.xlsx");
        write_fixture(
            &single,
            &[
                vec!["科目", "期末余额借方", "本期借方发生额", "本期贷方发生额"],
                vec!["1002010000:银行存款-工商银行", "2000", "1000", "0"],
                vec!["1002020000:银行存款-建设银行", "2100", "1000", "0"],
                vec!["1002030000:银行存款-农业银行", "2200", "1000", "0"],
                vec!["1002040000:银行存款-中国银行", "2300", "1000", "0"],
            ],
        );
        let inspected = inspect(
            &json!({"source": {"inputPath": single.to_string_lossy()}}),
            "tb",
        )
        .unwrap();
        let mapping = &inspected["suggestedMapping"];
        assert_eq!(mapping["accountCode"], json!("科目"));
        assert_eq!(mapping["accountName"], json!(["科目"]));

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// inspect 下发的 `roles` 角色标签表与引擎 Role 表逐条同源：全量、
    /// name/label 齐全、标签就是引擎那份（与 MissingRole.label 同一张表），
    /// 前端据此渲染中文角色名，不再自持会过期的对照表。
    #[test]
    fn inspect下发引擎角色标签表() {
        let dir = std::env::temp_dir().join(format!("deposit-role-labels-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("tb.xlsx");
        write_fixture(
            &path,
            &[
                vec![
                    "科目编码",
                    "科目名称",
                    "期末余额借方",
                    "本期借方发生额",
                    "本期贷方发生额",
                ],
                vec!["1002", "银行存款", "2000", "1000", "0"],
            ],
        );
        let empty: Vec<Value> = vec![];
        for kind in ["tb", "je"] {
            let inspected = inspect(
                &json!({"source": {"inputPath": path.to_string_lossy()}}),
                kind,
            )
            .unwrap();
            let roles = inspected["roles"].as_array().unwrap_or(&empty);
            let engine = ledger_mapping::roles(kind);
            assert!(!roles.is_empty(), "{kind} 的角色标签表不应为空");
            assert_eq!(
                roles.len(),
                engine.len(),
                "{kind} 应全量下发引擎当前认识的角色"
            );
            for item in roles {
                let name = item["name"].as_str().unwrap_or_default();
                let label = item["label"].as_str().unwrap_or_default();
                assert!(
                    !name.is_empty() && !label.is_empty(),
                    "每个角色都应同时携带标准名与中文标签: {item}"
                );
                assert_eq!(
                    label,
                    ledger_mapping::role_of(kind, name)
                        .map(|x| x.label)
                        .unwrap_or(""),
                    "标签必须取自引擎 Role 表: {name}"
                );
            }
            // 锁一个前端直接要用的形状：标准名渲染成中文。
            let code = roles
                .iter()
                .find(|x| x["name"] == json!("accountCode"))
                .unwrap();
            assert_eq!(code["label"], json!("科目编码"));
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 序时账里的「合计」行由引擎垃圾行规则显式剔除，不进入逐月余额还原。
    #[test]
    fn 序时账合计行不进入利息测算() {
        let dir = std::env::temp_dir().join(format!("deposit-junk-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let tb_path = dir.join("tb.xlsx");
        let je_path = dir.join("je.xlsx");
        write_fixture(
            &tb_path,
            &[
                vec![
                    "科目编码",
                    "科目名称",
                    "年初余额借方",
                    "期末余额借方",
                    "本期借方发生额",
                    "本期贷方发生额",
                ],
                vec!["1002", "银行存款", "0", "100000", "100000", "0"],
            ],
        );
        // 合计行的身份列只写着「合计」（引擎把它当汇总标签，不算身份），
        // 金额却是全表合计——进到测算里发生额会翻倍。
        let je_refs: Vec<Vec<&str>> = vec![
            vec![
                "记账日期",
                "凭证号",
                "科目编码",
                "科目名称",
                "摘要",
                "借方金额",
                "贷方金额",
            ],
            vec![
                "2025-01-15",
                "记-1",
                "1002",
                "银行存款",
                "收款",
                "100000",
                "0",
            ],
            vec!["合计", "", "", "", "合计", "100000", "0"],
        ];
        write_fixture(&je_path, &je_refs);
        let tb = inspect(
            &json!({"source": {"inputPath": tb_path.to_string_lossy()}}),
            "tb",
        )
        .unwrap();
        let je = inspect(
            &json!({"source": {"inputPath": je_path.to_string_lossy()}}),
            "je",
        )
        .unwrap();
        let params = json!({
            "reportStart": "2025-01-01", "reportEnd": "2025-12-31", "dayBasis": "month12",
            "tbSource": {"inputPath": tb_path.to_string_lossy()}, "tbMapping": tb["suggestedMapping"],
            "jeSource": {"inputPath": je_path.to_string_lossy()}, "jeMapping": je["suggestedMapping"]
        });
        let cancel = Arc::new(AtomicBool::new(false));
        let pause = PauseCheckpoint::unpaused(cancel.clone());
        let result = run_job("deposit.preview", params, &|_, _, _, _| {}, cancel, &pause).unwrap();
        let rows = result["rows"].as_array().unwrap();
        assert_eq!(rows.len(), 1);
        let row = &rows[0];
        // 全年只有 1 月那笔 100,000 的发生额；合计行不重复计入。
        assert_eq!(row["months"][0]["debit"].as_f64().unwrap(), 100000.0);
        let mut total_debit = 0.0;
        for month in row["months"].as_array().unwrap() {
            total_debit += month["debit"].as_f64().unwrap();
        }
        assert!(
            (total_debit - 100000.0).abs() < 0.01,
            "合计行不得计入发生额: {row}"
        );
        assert!(
            (row["derivedClosingBalance"].as_f64().unwrap() - 100000.0).abs() < 0.01,
            "JE 推导的年末余额应与 TB 勾稽: {row}"
        );
        assert!(row["reconciliationDiff"].as_f64().unwrap().abs() < 0.01);

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Rust 侧必填硬校验：缺金标身份（科目名称）指名道姓报中文错，
    /// 而不是沉默算错账。此前必填只在前端手写，worker 路径不拦。
    #[test]
    fn 必填映射缺失时指名道姓报错() {
        let dir = std::env::temp_dir().join(format!("deposit-required-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let tb_path = dir.join("tb.xlsx");
        write_fixture(
            &tb_path,
            &[
                vec![
                    "科目编码",
                    "期末余额借方",
                    "本期借方发生额",
                    "本期贷方发生额",
                ],
                vec!["1002", "2000", "1000", "0"],
            ],
        );
        let tb = inspect(
            &json!({"source": {"inputPath": tb_path.to_string_lossy()}}),
            "tb",
        )
        .unwrap();
        assert!(
            tb["suggestedMapping"].get("accountName").is_none(),
            "样例本身就没有科目名称列"
        );
        let params = json!({
            "reportStart": "2025-01-01", "reportEnd": "2025-12-31",
            "tbSource": {"inputPath": tb_path.to_string_lossy()},
            "tbMapping": tb["suggestedMapping"]
        });
        let cancel = Arc::new(AtomicBool::new(false));
        let pause = PauseCheckpoint::unpaused(cancel.clone());
        let err = run_job("deposit.preview", params, &|_, _, _, _| {}, cancel, &pause).unwrap_err();
        assert_eq!(err.code, "MAPPING_INCOMPLETE");
        assert!(
            err.user_message.contains("科目名称"),
            "报错要说清缺哪个角色: {}",
            err.user_message
        );
        assert!(
            err.user_message.contains("期初"),
            "无序时账时年初余额方案必填: {}",
            err.user_message
        );
        assert!(
            err.user_message.contains("TB尚未映射"),
            "报错应说明是哪一侧: {}",
            err.user_message
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 有序时账时年初余额可缺（期末倒推，SAP Trial Balance 形态）；
    /// 不给序时账时年初余额回到必填——与前端 depositMissingRequired 同口径。
    #[test]
    fn 有序时账时年初余额可缺无序时账时必填() {
        let dir = std::env::temp_dir().join(format!("deposit-opening-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let tb_path = dir.join("tb.xlsx");
        let je_path = dir.join("je.xlsx");
        // 没有年初余额列：这正是 SAP Trial Balance 的形态。
        write_fixture(
            &tb_path,
            &[
                vec![
                    "科目编码",
                    "科目名称",
                    "期末余额借方",
                    "本期借方发生额",
                    "本期贷方发生额",
                ],
                vec!["1002", "银行存款", "50000", "50000", "0"],
            ],
        );
        let je_refs: Vec<Vec<&str>> = vec![
            vec![
                "记账日期",
                "凭证号",
                "科目编码",
                "科目名称",
                "摘要",
                "借方金额",
                "贷方金额",
            ],
            vec![
                "2025-01-15",
                "记-1",
                "1002",
                "银行存款",
                "收款",
                "25000",
                "0",
            ],
            vec![
                "2025-02-15",
                "记-2",
                "1002",
                "银行存款",
                "收款",
                "25000",
                "0",
            ],
        ];
        write_fixture(&je_path, &je_refs);
        let tb = inspect(
            &json!({"source": {"inputPath": tb_path.to_string_lossy()}}),
            "tb",
        )
        .unwrap();
        let je = inspect(
            &json!({"source": {"inputPath": je_path.to_string_lossy()}}),
            "je",
        )
        .unwrap();
        let cancel = Arc::new(AtomicBool::new(false));
        let pause = PauseCheckpoint::unpaused(cancel.clone());
        // 无序时账：年初余额必填，报错指名「期初」。
        let params = json!({
            "reportStart": "2025-01-01", "reportEnd": "2025-12-31",
            "tbSource": {"inputPath": tb_path.to_string_lossy()},
            "tbMapping": tb["suggestedMapping"]
        });
        let err = run_job(
            "deposit.preview",
            params,
            &|_, _, _, _| {},
            cancel.clone(),
            &pause,
        )
        .unwrap_err();
        assert_eq!(err.code, "MAPPING_INCOMPLETE");
        assert!(
            err.user_message.contains("期初"),
            "缺年初余额应报期初方案: {}",
            err.user_message
        );
        // 有序时账：年初倒推，正常放行且勾稽通过。
        let params = json!({
            "reportStart": "2025-01-01", "reportEnd": "2025-12-31",
            "tbSource": {"inputPath": tb_path.to_string_lossy()},
            "tbMapping": tb["suggestedMapping"],
            "jeSource": {"inputPath": je_path.to_string_lossy()},
            "jeMapping": je["suggestedMapping"]
        });
        let result = run_job("deposit.preview", params, &|_, _, _, _| {}, cancel, &pause).unwrap();
        let rows = result["rows"].as_array().unwrap();
        assert_eq!(rows.len(), 1);
        assert!(
            (rows[0]["derivedClosingBalance"].as_f64().unwrap() - 50000.0).abs() < 0.01,
            "年初倒推后年末余额应与 TB 勾稽: {rows:?}"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn manual_leaf_exclusion_wins_over_parent_and_automatic_exclusion_does_not() {
        let leaf = "66030101 财务费用-其他";
        let mut params = json!({
            "accountRoles": {leaf: "excluded", "6603 财务费用": "interest_income"},
            "accountRoleOverrides": {"6603 财务费用": "interest_income"}
        });
        assert_eq!(role_for(leaf, &params), "interest_income");
        params["accountRoleOverrides"][leaf] = json!("excluded");
        assert_eq!(role_for(leaf, &params), "excluded");
        params["accountRoleOverrides"]
            .as_object_mut()
            .unwrap()
            .remove(leaf);
        assert_eq!(role_for(leaf, &params), "interest_income");
        // 自动有明确分类的银行存款不因上级误选而变成利息收入。
        assert_eq!(
            role_for(
                "100201 银行存款",
                &json!({
                    "accountRoleOverrides": {"1002 银行存款": "interest_income"}
                })
            ),
            "deposit"
        );
        // 旧任务没有 provenance，保留原先明确传入的叶子排除口径。
        params
            .as_object_mut()
            .unwrap()
            .remove("accountRoleOverrides");
        assert_eq!(role_for(leaf, &params), "excluded");
    }

    fn write_fixture(path: &Path, rows: &[Vec<&str>]) {
        let mut workbook = Workbook::new();
        let sheet = workbook.add_worksheet();
        for (y, row) in rows.iter().enumerate() {
            for (x, value) in row.iter().enumerate() {
                match value.parse::<f64>() {
                    Ok(number) if y > 0 => {
                        sheet.write_number(y as u32, x as u16, number).unwrap();
                    }
                    _ => {
                        sheet.write_string(y as u32, x as u16, *value).unwrap();
                    }
                }
            }
        }
        workbook.save(path).unwrap();
    }

    /// 走完整链路：自动识别表头/字段 → 按序时账还原逐月余额 → 测算 → 导出。
    /// 这条测试同时锁住"导出的利率是活公式"这个用户可见的行为。
    #[test]
    fn reconstructs_monthly_balances_and_writes_live_rate_formulas() {
        let dir = std::env::temp_dir().join(format!("deposit-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let tb_path = dir.join("tb.xlsx");
        let je_path = dir.join("je.xlsx");
        let out_path = dir.join("底稿.xlsx");

        write_fixture(
            &tb_path,
            &[
                vec![
                    "科目编码",
                    "科目名称",
                    "年初余额借方",
                    "期末余额借方",
                    "本期借方发生额",
                    "本期贷方发生额",
                ],
                vec!["1002", "银行存款", "1200000", "2400000", "1200000", "0"],
                // 定期存款不自动套用利率，用来验证"待填利率"这条路径。
                vec![
                    "1012",
                    "其他货币资金-1年定期存款",
                    "500000",
                    "500000",
                    "0",
                    "0",
                ],
                vec!["6051", "利息收入", "0", "0", "0", "900"],
                vec!["1122", "应收账款", "500000", "700000", "200000", "0"],
            ],
        );
        // 全年每月借方 100,000、无贷方：期末 1,200,000 + 1,200,000 = 2,400,000，与 TB 勾稽。
        let mut je_rows = vec![vec![
            "记账日期".to_string(),
            "凭证号".to_string(),
            "科目编码".to_string(),
            "科目名称".to_string(),
            "摘要".to_string(),
            "借方金额".to_string(),
            "贷方金额".to_string(),
        ]];
        for month in 1..=12u32 {
            je_rows.push(vec![
                format!("2025-{month:02}-15"),
                format!("记-{month}"),
                "1002".into(),
                "银行存款".into(),
                "收款".into(),
                "100000".into(),
                "0".into(),
            ]);
        }
        let je_refs: Vec<Vec<&str>> = je_rows
            .iter()
            .map(|row| row.iter().map(String::as_str).collect())
            .collect();
        write_fixture(&je_path, &je_refs);

        let tb_inspect = inspect(
            &json!({"source": {"inputPath": tb_path.to_string_lossy()}}),
            "tb",
        )
        .unwrap();
        let je_inspect = inspect(
            &json!({"source": {"inputPath": je_path.to_string_lossy()}}),
            "je",
        )
        .unwrap();
        // 字段应当全部自动映射到位，用户无需手工干预。
        assert!(tb_inspect["suggestedMapping"]["openingFunctionalDebit"].is_string());
        assert!(tb_inspect["suggestedMapping"]["closingFunctionalDebit"].is_string());
        assert!(je_inspect["suggestedMapping"]["date"].is_string());
        assert!(je_inspect["suggestedMapping"]["functionalDebit"].is_string());
        assert_eq!(
            tb_inspect["suggestedAccountRoles"]["1002 银行存款"],
            json!("deposit")
        );
        assert_eq!(
            tb_inspect["suggestedAccountRoles"]["6051 利息收入"],
            json!("interest_income")
        );

        let params = json!({
            "reportStart": "2025-01-01", "reportEnd": "2025-12-31",
            "dayBasis": "month12", "rateBasis": "listed",
            "tbSource": {"inputPath": tb_path.to_string_lossy()},
            "tbMapping": tb_inspect["suggestedMapping"],
            "jeSource": {"inputPath": je_path.to_string_lossy()},
            "jeMapping": je_inspect["suggestedMapping"],
            "outputPath": out_path.to_string_lossy()
        });
        let cancel = Arc::new(AtomicBool::new(false));
        let pause = PauseCheckpoint::unpaused(cancel.clone());
        let result = run_job("deposit.export", params, &|_, _, _, _| {}, cancel, &pause).unwrap();

        let summary = &result["summary"];
        assert_eq!(summary["accountCount"], 2);
        assert_eq!(summary["monthlySource"], "序时账逐月还原");
        let rows = result["rows"].as_array().unwrap();

        // 活期：自动套用挂牌默认值，余额勾稽通过。
        let demand = rows.iter().find(|r| r["tier"] == json!("demand")).unwrap();
        assert_eq!(
            demand["derivedClosingBalance"].as_f64().unwrap(),
            2_400_000.0
        );
        assert!(demand["reconciliationDiff"].as_f64().unwrap().abs() < 0.01);
        assert_eq!(demand["status"], "已勾稽");
        assert_eq!(demand["rateSource"], "活期挂牌默认值");
        assert!(demand["rateResolved"].as_bool().unwrap());
        // 12 个月月均余额之和 21,600,000；活期挂牌 0.05% ÷ 12 → 900。
        assert!((demand["averageBalance"].as_f64().unwrap() - 1_800_000.0).abs() < 0.01);

        // 定期：不自动套用利率，利息不计入合计。
        let term = rows.iter().find(|r| r["tier"] == json!("term_1y")).unwrap();
        assert!(!term["rateResolved"].as_bool().unwrap());
        assert_eq!(term["rateSource"], "需填写实际利率");
        assert_eq!(term["status"], "待填利率");
        assert_eq!(term["annualRate"].as_f64().unwrap(), 0.0);
        assert!(term["note"].as_str().unwrap().contains("请按存款协议"));

        assert_eq!(summary["missingRateCount"], 1);
        assert_eq!(summary["missingRateTiers"], json!(["定期存款（1年）"]));
        assert!((summary["missingRateBalance"].as_f64().unwrap() - 500_000.0).abs() < 0.01);
        assert!((summary["calculatedInterest"].as_f64().unwrap() - 900.0).abs() < 0.01);
        assert!((summary["bookedInterestIncome"].as_f64().unwrap() - 900.0).abs() < 0.01);
        assert!(summary["difference"].as_f64().unwrap().abs() < 0.01);
        // 金额虽然对得上，但还有账户没定利率，测算并不完整，不能判为通过。
        assert_eq!(summary["reconciliationPassed"], json!(false));

        // 导出的月度表必须是公式而不是死值，否则用户在 Excel 里改利率不会重算。
        let mut book = calamine::open_workbook_auto(&out_path).unwrap();
        let formulas = calamine::Reader::worksheet_formula(&mut book, MONTHLY_SHEET).unwrap();
        let cells: Vec<String> = formulas.rows().flat_map(|row| row.to_vec()).collect();
        assert!(
            cells.iter().any(|f| f.contains("(G2+J2)/2")),
            "缺少月均余额公式"
        );
        assert!(
            cells
                .iter()
                .any(|f| f.contains("测算汇总") && f.contains("$H$2")),
            "月度利率未回引汇总表的可编辑利率单元格"
        );
        assert!(
            cells.iter().any(|f| f.contains("K2*L2*M2/N2")),
            "缺少当月利息公式"
        );
        // 档位、来源注释和官方入口必须一起落进底稿，否则复核的人看不到利率是哪来的。
        let sheets = calamine::Reader::sheet_names(&book);
        assert!(sheets.iter().any(|name| name == "存款利率档位"));
        let tier_sheet = calamine::Reader::worksheet_range(&mut book, "存款利率档位").unwrap();
        let text: String = tier_sheet
            .rows()
            .flat_map(|row| row.iter().map(|cell| cell.to_string()))
            .collect::<Vec<_>>()
            .join(
                "
",
            );
        assert!(
            text.contains("活期存款") && text.contains("通知存款") && text.contains("大额存单")
        );
        assert!(text.contains("实务常见区间"));
        assert!(text.contains("中国人民银行"), "缺少央行来源说明");
        assert!(text.contains("pbc.gov.cn"), "缺少官方查询入口");
        assert!(
            text.contains("以客户的存款协议、银行对账单"),
            "缺少审计依据说明"
        );

        let summary_sheet = calamine::Reader::worksheet_range(&mut book, SUMMARY_SHEET).unwrap();
        let summary_text: String = summary_sheet
            .rows()
            .flat_map(|row| row.iter().map(|cell| cell.to_string()))
            .collect::<Vec<_>>()
            .join(
                "
",
            );
        assert!(summary_text.contains("档位匹配依据"));
        assert!(summary_text.contains("未命中期限关键字，默认按活期"));
        assert!(summary_text.contains("待填利率"));
        assert!(summary_text.contains("需填写实际利率"));
        assert!(
            text.contains("只有活期自动套用默认利率"),
            "档位表缺少自动套用范围说明"
        );
        assert!(
            text.contains("仅作合理性上限参照"),
            "档位表未把央行基准降级为参照"
        );

        let recon = calamine::Reader::worksheet_range(&mut book, "与TB利息收入勾稽").unwrap();
        let recon_text: String = recon
            .rows()
            .flat_map(|row| row.iter().map(|cell| cell.to_string()))
            .collect::<Vec<_>>()
            .join(
                "
",
            );
        assert!(
            recon_text.contains("尚未确定利率"),
            "勾稽表未说明测算不完整"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }
}
