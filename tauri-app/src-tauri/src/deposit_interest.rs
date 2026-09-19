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

fn scoped_entity(
    raw: &str,
    enabled: bool,
    side: ledger_mapping::EntitySide,
    scope: &ledger_mapping::EntityScope,
) -> String {
    let entity = ledger_mapping::effective_entity(raw, enabled);
    if !enabled {
        return entity;
    }
    ledger_mapping::apply_entity_scope(side, &entity, scope)
}

fn entity_scope(params: &Value) -> ledger_mapping::EntityScope {
    params
        .get("entityScope")
        .cloned()
        .and_then(|value| serde_json::from_value(value).ok())
        .unwrap_or_default()
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
    /// 是否自动套用挂牌暂估利率。有挂牌值的标准人民币档位为 true；
    /// 自定义、外币特殊产品没有统一报价，仍须填写实际利率。
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
        "对公活期几乎没有议价空间，国有大行普遍就是挂牌 0.05%；老协议里仍挂 0.35% 的情况也见得到。默认值仅用于暂估，仍需核对实际利率。",
    ),
    tier(
        "agreement",
        "agreement",
        "协定存款",
        "",
        Some(0.0115),
        Some(0.0020),
        true,
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
        true,
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
        true,
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
        true,
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
        true,
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
        true,
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
        true,
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
        true,
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
        true,
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
        true,
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
        true,
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
        true,
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

/// 自动套用的暂估利率。有挂牌值的人民币标准档位均可先形成测算；
/// 自定义、外币特殊产品没有可靠统一报价，仍须用户填实际利率。
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

/// TB/JE 常把同一币种写成中文名称或 ISO 代码；归集键统一为 ISO 代码。
fn currency_key(raw: &str) -> String {
    let value = raw.trim().to_uppercase();
    if value.is_empty() || value == "未标币种" {
        return String::new();
    }
    for (name, code) in [
        ("人民币", "CNY"),
        ("RMB", "CNY"),
        ("中国元", "CNY"),
        ("美元", "USD"),
        ("港币", "HKD"),
        ("港元", "HKD"),
        ("欧元", "EUR"),
        ("日元", "JPY"),
        ("英镑", "GBP"),
        ("澳大利亚元", "AUD"),
        ("澳元", "AUD"),
        ("新加坡元", "SGD"),
        ("瑞士法郎", "CHF"),
        ("加元", "CAD"),
    ] {
        if value == name || value == code {
            return code.into();
        }
    }
    value
}

/// 账户名称／辅助核算里明确写出的币种是账户级证据；独立币种列在部分
/// SAP 导出中只是公司本位币，只有前两者没有线索时才用它。
fn account_currency(account: &str, auxiliary: &str, raw_currency: &str) -> String {
    let identity = format!("{account} {auxiliary}");
    let normalized = normalize_header(&identity);
    if ["rmb", "cny", "人民币"]
        .iter()
        .any(|token| normalized.contains(token))
    {
        return "CNY".into();
    }
    detect_foreign_currency(&identity)
        .map(str::to_uppercase)
        .unwrap_or_else(|| currency_key(raw_currency))
}

pub(crate) fn suggest_tier(text: &str) -> (&'static str, String) {
    // 外币存款仍按活期兜底（认不出类型时统一落活期）。测算先沿用活期
    // 0.05% 默认值，但必须把外币身份和复核提示写进结果，提醒用户按对账单改写。
    if let Some(code) = detect_foreign_currency(text) {
        return (
            "demand",
            format!(
                "科目为 {} 外币户，大类按活期兜底并暂按 0.05% 测算，请按对账单核对实际利率",
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

    // 利息收入：名称线索为主；中国科目表 6051 是「其他业务收入」，只有明细名
    // 也带「利息」时才算（02 号样例整级 6051 下挂着材料销售、水费，编码前缀
    // 单独兜底会把它们全认成勾稽基准）。名称恰为「利息」两字的也认——07 号
    // 样例的 66030002 就叫「利息」，与手续费、汇兑损益并列在 6603 财务费用下。
    // 资产类编码（首位 1）先挡在门外：08 号样例的 1604010310 在建工程\待摊投资
    // \存款利息收入是资本化利息，混进基准会把勾稽差异直接撑大。
    let name_part: String = account
        .split_whitespace()
        .filter(|token| *token != code)
        .collect::<Vec<_>>()
        .join("");
    if !not_deposit_interest
        && code.chars().next() != Some('1')
        && ((code.starts_with("6051") && value.contains("利息"))
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
            ])
            || normalize_header(&name_part) == "利息")
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
        "中转",
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

fn detail_tier_for<'a>(
    account: &str,
    auxiliary: &str,
    detail_key: &str,
    params: &'a Value,
) -> (&'a str, String) {
    if let Some(tier) = params
        .get("accountDetailTierOverrides")
        .and_then(Value::as_object)
        .and_then(|values| values.get(detail_key))
        .and_then(Value::as_str)
        .filter(|tier| find_tier(tier).is_some())
    {
        return (tier, "用户按辅助明细指定存款类型".into());
    }
    tier_for(account, auxiliary, params)
}

fn is_deposit_role(role: &str) -> bool {
    matches!(role, "deposit" | "other_monetary" | "cash_on_hand")
}

// ---------------------------------------------------------------------------
// 字段词典
// ---------------------------------------------------------------------------

type Candidate = (String, f64, Vec<String>, Vec<String>);

/// 本工具在公共角色表之外的自有角色（角色, 命中词, 冲突词）：
/// JE 的数量列（识别计息天数之类的辅助信息）、TB 的会计期间
/// （没有日期列时靠它取年份）。它们的别名不在公共表里，随本工具维护。
fn tool_roles(kind: &str) -> Vec<(&'static str, Vec<&'static str>, Vec<&'static str>)> {
    if kind == "je" {
        vec![(
            "quantity",
            vec!["数量", "quantity", "menge"],
            vec!["金额", "amount"],
        )]
    } else {
        vec![(
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
        )]
    }
}

/// 辅助核算的银行业务特有写法。公共引擎先判；内核没占到辅助核算时，再用
/// 这批扩充别名本地补一刀。TB 侧的泛化「文本」只留在 TB——部分银行余额表
/// 的「文本」确实承载账户维度，而 JE 的「文本」必须留给摘要，否则 SAP 行
/// 项目文本会与成本中心一起被错误挂成辅助核算多列。
fn auxiliary_extra_aliases(kind: &str) -> Vec<&'static str> {
    let mut out = vec!["账户", "财务项目"];
    if kind == "tb" {
        out.extend(["文本", "科目文本", "账户文本"]);
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
///
/// 标准角色的裁判权在公共引擎：alias_score 的全链豁免（SAP 行级摘要、
/// 借正贷负金额、「年月」式记账日期、过账日期优先、本币加成）、科目数据
/// 冷启动与外币双语义仲裁都由内核统一裁定，内核胜者是各角色的首选列。
/// 此前本地自持一份完整打分，内核每修一条豁免这里就漏一条——04/05 号 SAP
/// 序时账摘要错挂「功能范围文本」、「年-月」不挂记账日期皆因此起。本地
/// 打分降级为替补候选（永远排在胜者之后），只保留冲突消解落败改派所需
/// 的多列弹药与本工具自有角色（数量／会计期间）。
fn suggest_mappings(table: &FxTable, kind: &str) -> BTreeMap<String, Vec<Candidate>> {
    let mut out: BTreeMap<String, Vec<Candidate>> = BTreeMap::new();
    let mut claimed: Vec<String> = Vec::new();
    for (index, role) in ledger_mapping::suggest_roles_with_data(kind, &table.headers, &table.rows)
    {
        // 币种线索文本（currencyText）是汇兑损益专用角色，那类列在存款/FA
        // 语义里要留给辅助核算，角色标签表也不下发它。
        if role == "currencyText" {
            continue;
        }
        if let Some(header) = table.headers.get(index) {
            claimed.push(header.clone());
            out.entry((*role).to_string()).or_default().push((
                header.clone(),
                0.94,
                vec![normalize_header(header)],
                vec![],
            ));
        }
    }
    // 本地旧打分整体降级为「替补候选」：按标准角色的内核别名补齐内核胜者
    // 之外的列，永远排在胜者之后——裁判权仍在公共引擎，但冲突消解的落败
    // 改派需要每角色多列弹药（同名「借/贷」两列时 closingDirection 靠它
    // 拿回次选列，上实城开的 GL Account Name 靠 partial 命中顶上）。
    for (role, aliases, conflicts) in standard_roles(kind) {
        let Some(mut alternates) = local_choices(table, &aliases, &conflicts) else {
            continue;
        };
        alternates.retain(|c| !claimed.contains(&c.0));
        out.entry(role.to_string()).or_default().extend(alternates);
    }
    // 辅助核算的银行业务特有写法并入替补池（「账户」「财务项目」，TB 侧
    // 另有泛化「文本」）；冲突词沿用内核定义。
    {
        let conflicts = ledger_mapping::role_of(kind, "auxiliary")
            .map(|role| role.conflicts.to_vec())
            .unwrap_or_default();
        let mut alternates =
            local_choices(table, &auxiliary_extra_aliases(kind), &conflicts).unwrap_or_default();
        alternates.retain(|c| !claimed.contains(&c.0));
        out.entry("auxiliary".to_string())
            .or_default()
            .extend(alternates);
    }
    // 本工具自有角色（数量／会计期间）继续本地打分。
    for (role, aliases, conflicts) in tool_roles(kind) {
        if let Some(choices) = local_choices(table, &aliases, &conflicts) {
            out.insert(role.to_string(), choices);
        }
    }
    // TB 侧「年月」在存款语义里是会计期间：内核对 date×年月的豁免不分侧别，
    // 若 date 抢了 period 的列，让回去——TB 没有日期列时靠 period 取年份。
    if kind == "tb"
        && let Some(periods) = out.get("period")
    {
        let owned: Vec<String> = periods.iter().map(|c| c.0.clone()).collect();
        if let Some(dates) = out.get_mut("date") {
            dates.retain(|c| !owned.contains(&c.0));
        }
    }
    out
}

/// 标准角色的（角色, 别名, 冲突词）三元组，来源与顺序同公共引擎；
/// 仅供替补打分使用，不给 currencyText（存款语义留给辅助核算）。
fn standard_roles(kind: &str) -> Vec<(&'static str, Vec<&'static str>, Vec<&'static str>)> {
    ledger_mapping::roles(kind)
        .iter()
        .filter(|role| role.name != "currencyText")
        .map(|role| (role.name, role.aliases.to_vec(), role.conflicts.to_vec()))
        .collect()
}

/// 本地简化打分：只服务本工具自有角色与辅助核算补刀，标准角色一律走公共
/// 引擎（档位、豁免与数据加成不再有第二套）。冲突词仍是排除条件：
/// 「冲销凭证号」含别名「凭证号」，按分扣不动，必须整条归零。
fn local_choices(table: &FxTable, aliases: &[&str], conflicts: &[&str]) -> Option<Vec<Candidate>> {
    let mut choices = table
        .headers
        .iter()
        .enumerate()
        .map(|(_index, header)| {
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
            let score: f64 = if !bad.is_empty() {
                0.0
            } else if !exact.is_empty() {
                0.94
            } else if !segment.is_empty() {
                0.88
            } else if !partial.is_empty() {
                0.72
            } else {
                0.0
            };
            (
                header.clone(),
                score,
                if exact.is_empty() { partial } else { exact },
                bad,
            )
        })
        .filter(|choice| choice.1 > 0.15)
        .collect::<Vec<_>>();
    choices.sort_by(|a, b| b.1.total_cmp(&a.1));
    choices.truncate(3);
    (!choices.is_empty()).then_some(choices)
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
        "autoApplyPolicy": "有挂牌参考值的活期、协定、通知、定期和大额存单档位均先按默认值暂估并纳入测算，状态标记为待确认利率；用户填写的档位或账户实际利率优先。自定义、外币特殊产品仍须手填实际利率。",
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
    // 两列同名「借/贷」按位置定归属：余额表一律期初在前、期末在后，
    // 与汇兑损益/TBJE 走同一份公共摆正（北重精工等样例的仲裁 R4）。
    if kind == "tb" {
        ledger_mapping::align_tb_direction_pair(&table.headers, &mut mapping);
    }
    // 合并科目列的兜底与汇兑损益共用同一份（判定在公共引擎、套用在 fx 侧），
    // 存款利息不再自持一份近似实现。
    crate::fx::fill_combined_account_column(kind, &table, &mut mapping);
    let identity =
        ledger_mapping::account_identity_columns_by_data(kind, &table.headers, &table.rows);
    let code_invalid = mapping
        .get("accountCode")
        .and_then(Value::as_str)
        .and_then(|column| table.headers.iter().position(|header| header == column))
        .is_some_and(|index| {
            ledger_mapping::account_column_shape(
                table.rows.iter().filter_map(|row| row.get(index)).cloned(),
            ) == ledger_mapping::AccountColumnShape::Name
        });
    if (mapping.get("accountCode").is_none() || code_invalid)
        && let Some(column) = identity.code
    {
        mapping.insert("accountCode".into(), json!(column));
    }
    if !mapping.contains_key("accountName") && !identity.names.is_empty() {
        mapping.insert("accountName".into(), json!(identity.names));
    }
    if kind == "tb" {
        crate::fx::promote_period_movement(&table, &mut mapping);
    }
    // 用友式「月/日分列无年份」的序时账：把日列一并挂进 date（09 号样例
    // 整本账没有年份列，单列纯月份原本全行跳过、误报科目不匹配）。
    if kind == "je" {
        ledger_mapping::pair_month_day_date_columns(&table.headers, &table.rows, &mut mapping);
    }
    // 科目/主体清单必须使用用户当前确认的映射重新计算。初次识别仍返回自动
    // 建议；FA List 在进入科目复核前会把人工调整后的 mapping 传回来，避免
    // 界面已选“核算组织”，清单却仍按初始的“默认主体”生成。
    if let Some(confirmed) = params.get("mapping").and_then(Value::as_object)
        && !confirmed.is_empty()
    {
        mapping = confirmed.clone();
    }
    let accounts = distinct_accounts(&table, &mapping);
    // 科目确认目录按末级口径下发（2026-09-18 定案）：多层级 TB 的分类界面只列
    // 末级科目。父子层级（1101.01 分段编码、无编码映射、多主体等形态）只有
    // 公共引擎的目录末级掩码认得，前端不得自造规则。全量 accounts 继续下发，
    // FA 等页面与历史口径仍在用。
    let accounts_leaf =
        if kind == "tb" {
            let leaf = ledger_mapping::tb_catalog_leaf_mask(&table.headers, &table.rows, &|role| {
                match mapping.get(role) {
                    Some(Value::String(value)) => vec![value.clone()],
                    Some(Value::Array(values)) => values
                        .iter()
                        .filter_map(Value::as_str)
                        .map(str::to_owned)
                        .collect(),
                    _ => vec![],
                }
            });
            let indexes = account_columns(&table, &mapping);
            table
                .rows
                .iter()
                .enumerate()
                .filter(|(index, _)| leaf.get(*index).copied().unwrap_or(true))
                .map(|(_, row)| join_columns(row, &indexes))
                .filter(|value| !value.is_empty() && !ledger_mapping::is_report_footer_value(value))
                .collect::<BTreeSet<_>>()
                .into_iter()
                .collect::<Vec<_>>()
        } else {
            accounts.clone()
        };
    let entities = distinct_values(&table, &mapping, "entity");
    let entity_accounts = distinct_entity_accounts(&table, &mapping);
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
        "entities": entities, "accounts": accounts, "accountsLeaf": accounts_leaf,
        "entityAccounts": entity_accounts,
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
        .filter(|value| !value.is_empty() && !ledger_mapping::is_report_footer_value(value))
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect()
}

/// 主体×科目的真实组合：供科目复核按账里实际存在的搭配铺清单，
/// 不再由前端做“主体×科目”笛卡尔积（会造出数据里不存在的幻影组合）。
/// 主体单元格留空时归“默认主体”，与匹配引擎的空主体口径一致。
fn distinct_entity_accounts(
    table: &FxTable,
    mapping: &Map<String, Value>,
) -> Vec<Map<String, Value>> {
    let indexes = account_columns(table, mapping);
    if indexes.is_empty() {
        return vec![];
    }
    let entity_index = column_index(table, mapping, "entity");
    let mut seen = BTreeSet::<(String, String)>::new();
    for row in &table.rows {
        let account = join_columns(row, &indexes);
        if account.is_empty() || ledger_mapping::is_report_footer_value(&account) {
            continue;
        }
        let entity = entity_index
            .and_then(|index| row.get(index))
            .map(|value| value.trim().to_owned())
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| ledger_mapping::DEFAULT_ENTITY.to_owned());
        seen.insert((entity, account));
    }
    seen.into_iter()
        .map(|(entity, account)| {
            let mut pair = Map::new();
            pair.insert("entity".to_owned(), Value::String(entity));
            pair.insert("account".to_owned(), Value::String(account));
            pair
        })
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
    /// 利率是否直接取自内置挂牌表（未经任何用户改写）。来源文案统一为
    /// 「挂牌暂估值」后，「待确认利率」状态与"系统预设利率"汇总都由它驱动。
    #[serde(default)]
    pub(crate) rate_provisional: bool,
    /// 填入的利率高于该档央行基准时的提示（基准只作上限参照）。
    pub(crate) rate_warning: String,
    pub(crate) opening_balance: f64,
    /// 该户在 TB 里由几行合并而来。SAP 余额表同一科目按辅助维度拆多行，
    /// 逐行当独立户会拿「半个科目」去和序时账勾稽；大于 1 时行注要点名。
    #[serde(default)]
    pub(crate) merged_rows: usize,
    /// 年初余额是否直接取自 TB。SAP 的 Trial Balance LC/GC 只有 MTD/YTD，
    /// 没有年初余额列，这时用"期末余额 − 全年发生额"倒推。
    pub(crate) opening_from_tb: bool,
    pub(crate) tb_closing_balance: f64,
    pub(crate) derived_closing_balance: f64,
    /// 年初直接取自 TB，且 JE 有该户发生额，或 JE 零发生额与 TB 年初＝年末
    /// 相互印证时，期末推导才是独立勾稽证据。
    #[serde(default)]
    pub(crate) je_reconciled: bool,
    pub(crate) reconciliation_diff: f64,
    pub(crate) average_balance: f64,
    pub(crate) calculated_interest: f64,
    pub(crate) months: Vec<MonthCell>,
    /// JE 未覆盖该户时使用全年期初/期末两点法。
    #[serde(default)]
    pub(crate) two_point: bool,
    pub(crate) status: String,
    pub(crate) note: String,
}

#[derive(Clone)]
struct TbCandidate {
    source_index: usize,
    entity: String,
    account: String,
    auxiliary: String,
    currency: String,
    role: String,
    opening: Option<f64>,
    closing: f64,
    debit_raw: f64,
    credit_raw: f64,
    net: f64,
    note: String,
    occurrence_direction_confirmed: bool,
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
    let entity_scope = entity_scope(params);
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
    let je_mapping = params
        .get("jeMapping")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let entity_key_enabled = ledger_mapping::entity_key_enabled(
        !column_indexes(&tb, &tb_map, "entity").is_empty(),
        has_je
            && je_mapping
                .get("entity")
                .is_some_and(|value| !value.is_null() && value != ""),
    );
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
    // 是否具备年初余额，要按整张 TB 的映射方案判断，不能按每个辅助明细格
    // 是否非空判断。维度拆行里空白年初就是 0；此前任一子行为空都会把整户
    // 标成“TB 未提供年初余额”，继而错误地用 JE 发生额倒推整户年初。
    let opening_from_tb = [
        "openingFunctionalAmount",
        "openingFunctionalDebit",
        "openingFunctionalCredit",
    ]
    .iter()
    .any(|role| !column_indexes(&tb, &tb_map, role).is_empty());
    let closing_self_signed = ledger_mapping::balance_self_signed(
        &tb.headers,
        &tb.rows,
        &tb_columns,
        "closingFunctional",
    );
    // 科目登记方向推断要查上级科目名：把全表「编码→名称」收一份（含非
    // 末级汇总行——方向信息恰恰在 `6603 财务费用` 这类父行上）。
    let tb_account_names: BTreeMap<String, String> = tb
        .rows
        .iter()
        .map(|row| {
            let text = join_columns(row, &account_cols);
            (
                ledger_mapping::account_code_of(&text),
                ledger_mapping::account_name_of(&text),
            )
        })
        .filter(|(code, name)| !code.is_empty() && !name.is_empty() && code != name)
        .collect();
    // 第一遍扫描只抽「原料」：末级行的身份（主体/科目/币种/辅助）与金额。
    // 同一科目的维度拆行是否合并成一户，等公共匹配口径（主体＋科目键）确定
    // 后在第二遍决定——SAP 余额表同一科目按维度拆多行，逐行当独立户会拿
    // 「半个科目」去和序时账勾稽，必然出成对的假差异。
    let mut deposit_candidates: Vec<TbCandidate> = vec![];
    let mut interest_candidates: Vec<TbCandidate> = vec![];
    for (row_index, row) in tb.rows.iter().enumerate() {
        if !tb_leaf[row_index] {
            continue;
        }
        let account = join_columns(row, &account_cols);
        if account.is_empty() {
            continue;
        }
        let role = role_for(&account, params);
        let entity = scoped_entity(
            &cell_text(&tb, row, &tb_map, "entity"),
            entity_key_enabled,
            ledger_mapping::EntitySide::Tb,
            &entity_scope,
        );
        if role == "interest_income" {
            // 利息收入是损益类贷方科目：优先用本期发生额净额，只有余额
            // 可用时退回期末余额净额。已结转形态（借贷同额）按红字与
            // 科目登记方向定收入/费用符号——费用性质的科目计入负数，
            // 冲减勾稽基准，而不是冒充一笔利息收入。
            let direction = registered_direction(&account, &tb_account_names);
            // 期末余额按「借正贷负」净额列示（与表内两栏口径一致）；
            // 退到发生额/余额路径时取负号还原成贷方为正的收入数。
            let closing_balance = signed(
                &tb,
                row,
                &tb_map,
                "closingFunctionalDebit",
                "closingFunctionalCredit",
            )
            .or_else(|| cell_number(&tb, row, &tb_map, "closingFunctionalAmount"))
            .unwrap_or(0.0);
            let (net, note, debit_raw, credit_raw, occurrence_direction_confirmed) =
                match booked_occurrence(
                    &tb,
                    row,
                    &tb_map,
                    tb_convention,
                    direction,
                    explicit_interest_income_name(&account),
                ) {
                    Some((net, note, debit, credit, confirmed)) => {
                        (net, note, debit, credit, confirmed)
                    }
                    None => (
                        -closing_balance,
                        "仅据期末余额推定，不能确认本期发生方向".into(),
                        0.0,
                        0.0,
                        false,
                    ),
                };
            interest_candidates.push(TbCandidate {
                source_index: row_index,
                entity,
                account,
                auxiliary: String::new(),
                currency: String::new(),
                role,
                opening: None,
                closing: closing_balance,
                debit_raw,
                credit_raw,
                net,
                note,
                occurrence_direction_confirmed,
            });
            continue;
        }
        if !is_deposit_role(&role) {
            continue;
        }
        if role == "cash_on_hand" && !params["includeCashOnHand"].as_bool().unwrap_or(false) {
            continue;
        }
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
        deposit_candidates.push(TbCandidate {
            source_index: row_index,
            entity,
            account,
            auxiliary,
            currency,
            role,
            opening,
            closing,
            debit_raw: 0.0,
            credit_raw: 0.0,
            net: 0.0,
            note: String::new(),
            occurrence_direction_confirmed: false,
        });
    }
    if deposit_candidates.is_empty() {
        return Err(error(
            "NO_DEPOSIT_ACCOUNTS",
            "未从 TB 识别到货币资金科目；请在科目分类中确认银行存款/其他货币资金科目。",
            None,
        ));
    }

    // JE 打开一次：身份预扫供公共匹配口径判定两侧编码歧义，逐月归集复用
    // 同一份表/磁盘缓存，不再按参数各读各的。
    let je_input = open_je_input(params, cancel, progress, total)?;
    let policy = {
        let tb_identities: Vec<(String, String, String)> = deposit_candidates
            .iter()
            .chain(interest_candidates.iter())
            .map(|candidate| {
                (
                    candidate.entity.clone(),
                    ledger_mapping::account_code_of(&candidate.account),
                    ledger_mapping::account_name_of(&candidate.account),
                )
            })
            .collect();
        let je_identities = match &je_input {
            Some(je) => je_account_identities(je, entity_key_enabled, &entity_scope, cancel)?,
            None => Vec::new(),
        };
        ledger_mapping::AccountMatchPolicy::from_sides(&tb_identities, &je_identities)
    };
    let auxiliary_plan = deposit_auxiliary_plan(
        &tb,
        &tb_map,
        &tb_leaf,
        je_input.as_ref(),
        &policy,
        params,
        entity_key_enabled,
        &entity_scope,
        cancel,
    )?;
    let mut auxiliary_warnings: Vec<String> = Vec::new();
    for group in &auxiliary_plan.verdicts {
        let verdict = &group.verdict;
        let prefix = format!("{} / {}", group.entity, group.account);
        match verdict.status {
            "noMatch" => auxiliary_warnings.push(format!(
                "{prefix}：JE 无对应列或辅助列未通过验证，本组不按辅助核算拆分，按主体＋科目执行测算。"
            )),
            "ambiguous" => auxiliary_warnings.push(format!(
                "{prefix}：JE 中多列命中辅助值（{}），本组不按辅助核算拆分，按主体＋科目执行测算。",
                verdict.competing_columns.join("、")
            )),
            "partialCoverage" => auxiliary_warnings.push(format!(
                "{prefix}：JE 辅助列「{}」覆盖不全（{}/{}），本组不按辅助核算拆分，按主体＋科目执行测算。",
                verdict.column.clone().unwrap_or_default(),
                verdict.anchor_hits,
                verdict.anchor_total
            )),
            _ => {}
        }
    }
    let currency_fallback_mode = params
        .get("currencyFallbackMode")
        .and_then(Value::as_str)
        .unwrap_or("");
    let combine_functional_currency = currency_fallback_mode == "functional";
    let force_currency_two_point = currency_fallback_mode == "twoPointByCurrency";
    // 第二遍：验证成功的组按辅助拆户；其他状态整组按主体＋科目。用户选择
    // “统一本位币匡算”时不把币种并入账户键；按币种两点法仍保留币种。
    struct AccountFold {
        first: TbCandidate,
        rows: usize,
        opening_sum: f64,
        closing_sum: f64,
        auxiliaries: BTreeSet<String>,
    }
    let mut fold_order: Vec<(String, String, String, String)> = vec![];
    let mut folds: BTreeMap<(String, String, String, String), AccountFold> = BTreeMap::new();
    for mut candidate in deposit_candidates {
        let group = (
            candidate.entity.clone(),
            matched_account_key(&candidate.entity, &candidate.account, &policy),
        );
        if let Some(index) = auxiliary_plan.tb_columns.get(&group) {
            candidate.auxiliary = tb.rows[candidate.source_index]
                .get(*index)
                .cloned()
                .unwrap_or_default();
        }
        let detail_key = format!(
            "{}\u{1f}{}\u{1f}{}",
            group.0,
            group.1,
            ledger_mapping::anchor_norm(&candidate.auxiliary)
        );
        if let Some(role) = params
            .get("accountDetailRoleOverrides")
            .and_then(Value::as_object)
            .and_then(|values| values.get(&detail_key))
            .and_then(Value::as_str)
        {
            candidate.role = role.to_owned();
        }
        if !is_deposit_role(&candidate.role)
            || (candidate.role == "cash_on_hand"
                && !params["includeCashOnHand"].as_bool().unwrap_or(false))
        {
            continue;
        }
        let currency = if combine_functional_currency {
            String::new()
        } else {
            account_currency(
                &candidate.account,
                &candidate.auxiliary,
                &candidate.currency,
            )
        };
        let key = (
            group.0.clone(),
            group.1.clone(),
            auxiliary_plan.key_for_tb(&group, &candidate.auxiliary),
            currency.clone(),
        );
        let auxiliary = candidate.auxiliary.trim().to_owned();
        candidate.currency = currency;
        let Some(fold) = folds.get_mut(&key) else {
            fold_order.push(key.clone());
            folds.insert(
                key,
                AccountFold {
                    opening_sum: candidate.opening.unwrap_or(0.0),
                    closing_sum: candidate.closing,
                    auxiliaries: (!auxiliary.is_empty())
                        .then(|| BTreeSet::from([auxiliary]))
                        .unwrap_or_default(),
                    first: candidate,
                    rows: 1,
                },
            );
            continue;
        };
        fold.rows += 1;
        fold.opening_sum += candidate.opening.unwrap_or(0.0);
        fold.closing_sum += candidate.closing;
        if !auxiliary.is_empty() {
            fold.auxiliaries.insert(auxiliary);
        }
    }
    let mut accounts: Vec<AccountRow> = vec![];
    // 测算行键 → 科目确认表的辅助明细键。逐户利率改写按明细键匹配，
    // 与存款类型覆盖同一键空间；行键里拼了币种，不能直接当明细键用。
    let mut detail_keys: BTreeMap<String, String> = BTreeMap::new();
    let mut currencies_by_group: BTreeMap<(String, String, String), BTreeSet<String>> =
        BTreeMap::new();
    for key in &fold_order {
        currencies_by_group
            .entry((key.0.clone(), key.1.clone(), key.2.clone()))
            .or_default()
            .insert(key.3.clone());
    }
    let multi_currency_group_count = currencies_by_group
        .values()
        .filter(|set| set.len() > 1)
        .count();
    for key in &fold_order {
        let fold = folds.remove(key).expect("聚合桶按 fold_order 落键");
        let currency_label = if key.3.is_empty() {
            if combine_functional_currency {
                "本位币合并"
            } else {
                "未标币种"
            }
        } else {
            key.3.as_str()
        };
        let row_key = [
            key.0.as_str(),
            key.1.as_str(),
            key.2.as_str(),
            currency_label,
        ]
        .into_iter()
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(" | ");
        let auxiliary = if key.2 == "未分辅助" {
            String::new()
        } else {
            fold.auxiliaries
                .iter()
                .cloned()
                .collect::<Vec<_>>()
                .join("；")
        };
        let currency = currency_label.to_owned();
        let account_text = fold.first.account.clone();
        let detail_key = format!(
            "{}\u{1f}{}\u{1f}{}",
            key.0,
            key.1,
            ledger_mapping::anchor_norm(&auxiliary)
        );
        let (tier, matched_by) = detail_tier_for(&account_text, &auxiliary, &detail_key, params);
        detail_keys.insert(row_key.clone(), detail_key.clone());
        let meta = find_tier(tier);
        accounts.push(AccountRow {
            key: row_key,
            entity: key.0.clone(),
            account: account_text,
            auxiliary,
            currency,
            role: fold.first.role.clone(),
            tier: tier.into(),
            tier_label: tier_label(tier),
            category: meta.map(|x| x.category).unwrap_or("demand").into(),
            term_label: meta.map(|x| x.term_label).unwrap_or("").into(),
            tier_matched_by: matched_by,
            rate_source: String::new(),
            annual_rate: 0.0,
            rate_resolved: false,
            rate_provisional: false,
            rate_warning: String::new(),
            opening_balance: if opening_from_tb {
                fold.opening_sum
            } else {
                0.0
            },
            merged_rows: fold.rows,
            opening_from_tb,
            tb_closing_balance: fold.closing_sum,
            derived_closing_balance: fold.closing_sum,
            je_reconciled: false,
            reconciliation_diff: 0.0,
            average_balance: 0.0,
            calculated_interest: 0.0,
            months: vec![],
            two_point: false,
            status: String::new(),
            note: String::new(),
        });
    }

    // 账面利息收入同样按（主体＋科目）合并：维度拆行各自只有部分发生额，
    // 合并后的借贷与净额才是该科目的完整口径（合计不变，行数去重）。
    let mut booked_interest_rows: Vec<Value> = vec![];
    let mut booked_interest = 0.0_f64;
    let mut booked_direction_unconfirmed_count = 0usize;
    {
        struct BookedFold {
            first: TbCandidate,
            rows: usize,
            debit: f64,
            credit: f64,
            closing: f64,
            net: f64,
            occurrence_direction_confirmed: bool,
        }
        let mut booked_order: Vec<(String, String)> = vec![];
        let mut booked_folds: BTreeMap<(String, String), BookedFold> = BTreeMap::new();
        for candidate in interest_candidates {
            let key = (
                candidate.entity.clone(),
                matched_account_key(&candidate.entity, &candidate.account, &policy),
            );
            let Some(fold) = booked_folds.get_mut(&key) else {
                booked_order.push(key.clone());
                let debit = candidate.debit_raw;
                let credit = candidate.credit_raw;
                let closing = candidate.closing;
                let net = candidate.net;
                let occurrence_direction_confirmed = candidate.occurrence_direction_confirmed;
                booked_folds.insert(
                    key,
                    BookedFold {
                        first: candidate,
                        rows: 1,
                        debit,
                        credit,
                        closing,
                        net,
                        occurrence_direction_confirmed,
                    },
                );
                continue;
            };
            fold.rows += 1;
            fold.debit += candidate.debit_raw;
            fold.credit += candidate.credit_raw;
            fold.closing += candidate.closing;
            fold.net += candidate.net;
            fold.occurrence_direction_confirmed &= candidate.occurrence_direction_confirmed;
        }
        for key in booked_order {
            let fold = booked_folds.remove(&key).expect("利息科目按序落键");
            if !fold.occurrence_direction_confirmed {
                booked_direction_unconfirmed_count += 1;
            }
            booked_interest += fold.net;
            booked_interest_rows.push(json!({
                "entity": key.0,
                "account": fold.first.account,
                "debit": fold.debit,
                "credit": fold.credit,
                "closing": fold.closing,
                "bookedAmount": fold.net,
                "occurrenceDirectionConfirmed": fold.occurrence_direction_confirmed,
                "note": if fold.rows > 1 {
                    format!("{}（{} 行合并）", fold.first.note, fold.rows)
                } else {
                    fold.first.note.clone()
                }
            }));
        }
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
    let movements = match (&je_input, force_currency_two_point) {
        (_, true) => None,
        (Some(je), false) => monthly_movements(
            je,
            &policy,
            &accounts,
            &auxiliary_plan,
            entity_key_enabled,
            &entity_scope,
            start,
            end,
            cancel,
            pause,
            progress,
            total,
        )?,
        (None, false) => None,
    };
    let has_je = movements.is_some();
    let unallocated_currency_rows = movements
        .as_ref()
        .map(|aggregate| aggregate.unallocated_currency_rows)
        .unwrap_or(0);
    let unallocated_currency_keys = movements
        .as_ref()
        .map(|aggregate| aggregate.unallocated_currency_keys.clone())
        .unwrap_or_default();
    let je_currency_allocation_warning =
        currency_allocation_warning(unallocated_currency_rows, multi_currency_group_count);
    let amount_scheme = movements
        .as_ref()
        .map(|aggregate| aggregate.scheme.clone())
        .unwrap_or_default();
    let amount_evidence = movements
        .as_ref()
        .map(|aggregate| aggregate.evidence.clone())
        .unwrap_or_default();
    checkpoint(cancel, pause)?;

    progress("interest", 3, total, "正在按月均余额和存款利率测算利息…");
    let overrides = params.get("rateOverrides").and_then(Value::as_object);
    let account_rates = params.get("accountRateOverrides").and_then(Value::as_object);
    let custom_rates = params.get("tierRates").and_then(Value::as_object);
    for account in &mut accounts {
        let detail_key = detail_keys
            .get(&account.key)
            .map(String::as_str)
            .unwrap_or("");
        let resolved = resolve_rate(account, overrides, account_rates, custom_rates, detail_key);
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
        account.rate_provisional = resolved.provisional;
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
        let series = movements
            .as_ref()
            .and_then(|aggregate| aggregate.series.get(&account.key));
        // 序时账覆盖按户判定：期间内一行都没归集到该科目时，硬按 JE 逐月
        // 还原会得到全年发生额为 0 的假平线（余额恒等于年初），比不提供
        // 序时账还糟；退回两点法至少月均口径是"期初→期末"的合理近似。
        // 例外有二：TB 自证休眠的户（年初=期末且余额直接取自 TB）零归集与
        // 「全年无发生」一致；年初期末全零的户没有可勾稽的金额。两者都按
        // 已覆盖处理，休眠户照常显示"已勾稽"、全零户不制造未覆盖噪音。
        let je_rows = movements
            .as_ref()
            .and_then(|aggregate| aggregate.matched_rows.get(&account.key))
            .copied()
            .unwrap_or(0);
        let dormant = (account.opening_from_tb
            && (account.tb_closing_balance - account.opening_balance).abs() <= 0.01)
            || (account.opening_balance.abs() <= 0.01 && account.tb_closing_balance.abs() <= 0.01);
        let je_backed = has_je && (je_rows > 0 || dormant);
        account.two_point = !je_backed;
        // 已提供 JE、但该账户在期间内没有任何发生额时，发生额就是 0。
        // 若 TB 同时证明年初＝年末，这条“0 发生额”仍是有效勾稽证据：
        // JE 推导期末 = TB 年初 + 0 = TB 年末。此前虽然内部按休眠户生成
        // 平线，却把 jeReconciled 留成 false，界面和底稿反而显示“未执行”。
        account.je_reconciled = je_backed && account.opening_from_tb;
        if !account.opening_from_tb {
            let net: f64 = series
                .map(|all| all.iter().map(|(debit, credit)| debit - credit).sum())
                .unwrap_or(0.0);
            account.opening_balance = account.tb_closing_balance - net;
        }

        let mut opening = account.opening_balance;
        let two_point_average = (account.opening_balance + account.tb_closing_balance) / 2.0;
        let mut months = Vec::with_capacity(period.len());
        let span = period.len() as f64;
        for (index, month) in period.iter().copied().enumerate() {
            let (debit, credit) = series
                .map(|all| all[(month - 1) as usize])
                .unwrap_or((0.0, 0.0));
            let closing = if je_backed {
                opening + debit - credit
            } else {
                // closing 只维持内部期间分摊序列；两点法的实际平均余额在下方
                // 直接取（期初＋期末）÷2，不把这里的插值披露成月末余额。
                account.opening_balance
                    + (account.tb_closing_balance - account.opening_balance) * (index as f64 + 1.0)
                        / span
            };
            let (days, denominator) = month_days(basis_key, year, month, start, end);
            // 两点法直接用期初、期末的算术平均数作为全年暂估余额；不构造、
            // 不声称取得了任何月末余额。按月循环只用于把全年利息分摊到期间。
            let average = if je_backed {
                (opening + closing) / 2.0
            } else {
                two_point_average
            };
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
        let default_rate = account.rate_provisional;
        account.status = if !account.rate_resolved {
            "待填利率".into()
        } else if !je_backed {
            "两点法推算".into()
        } else if default_rate {
            "待确认利率".into()
        } else if !account.opening_from_tb {
            "年初倒推".into()
        } else if !account.je_reconciled {
            "两点法推算".into()
        } else if account.reconciliation_diff.abs() < 0.01 {
            "已勾稽".into()
        } else {
            "待复核".into()
        };
        let mut notes: Vec<String> = vec![];
        if account.merged_rows > 1 {
            notes.push(format!(
                "TB 中该科目按辅助维度拆成 {} 行，已按「主体＋科目编码」合并为一户测算。",
                account.merged_rows
            ));
        }
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
        if default_rate {
            notes.push(
                "当前利率为内置挂牌暂估值，已纳入测算；请按存款协议、银行对账单或利息清单确认。"
                    .into(),
            );
        }
        if unallocated_currency_keys.contains(&account.key) && !account.je_reconciled {
            notes.push(
                "该科目在 TB 中按币种拆行，但对应 JE 发生额缺少可用币种，无法分配到本币种；本行退回 TB 年初/年末两点法，JE 勾稽为 N/A。"
                    .into(),
            );
        }
        if !je_backed {
            notes.push(if has_je {
                "序时账期间内没有任何行匹配到该科目，已直接按（期初余额＋期末余额）÷2 暂估全年平均余额；不推导月末余额，也不执行 JE 勾稽。".into()
            } else {
                "未提供序时账，已直接按（期初余额＋期末余额）÷2 暂估全年平均余额；不推导月末余额，也不执行 JE 勾稽。".into()
            });
        } else if !account.je_reconciled && account.opening_from_tb {
            notes.push(
                "该科目无 JE 发生额，期初与期末相同不能证明全年休眠；未执行独立 JE 勾稽。".into(),
            );
        } else if account.reconciliation_diff.abs() >= 0.01 {
            notes.push(format!(
                "JE 推导的年末余额与 TB 相差 {:.2}，请确认科目映射与序时账完整性。",
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
    let default_rate: Vec<&AccountRow> = accounts
        .iter()
        .filter(|account| account.rate_provisional)
        .collect();
    let default_rate_count = default_rate.len();
    let default_rate_balance: f64 = default_rate.iter().map(|a| a.average_balance).sum();
    // 基准数保持符号：负数＝账面是净利息支出（费用性科目计入负数）。
    // 此前对合计取绝对值是为迁就用友符号惯例，但会把费用翻成一笔正的
    // 利息收入，差异方向失真；符号已在逐行按口径归一，合计不再翻正。
    let booked = booked_interest;
    let difference = calculated - booked;
    let ratio = (booked.abs() > 0.005).then(|| difference / booked.abs());
    let mut booked_notes = Vec::new();
    if booked_direction_unconfirmed_count > 0 {
        booked_notes.push(format!(
            "{booked_direction_unconfirmed_count} 个利息科目只有期末余额，或科目登记方向无法识别；当前金额只能估计，确认前不判勾稽通过。"
        ));
    }
    if booked < -0.005 {
        booked_notes
            .push("账面利息收入合计为负（净利息支出），请复核科目分类里的利息收入科目。".into());
    }
    let booked_note = booked_notes.join(" ");
    let review = accounts.iter().filter(|a| a.status != "已勾稽").count();
    // 序时账覆盖体检：TB 里有余额的主体，整家不在序时账里（典型：TB 是两家
    // 公司、序时账只导了一家）必须在汇总里点名，而不是让用户对着每行
    // 「JE 推导的年末余额与 TB 相差…」逐行猜原因。
    let uncovered_count = accounts
        .iter()
        .filter(|a| {
            let uncovered = movements.as_ref().is_some_and(|aggregate| {
                aggregate.matched_rows.get(&a.key).copied().unwrap_or(0) == 0
            });
            // 与逐户判定同一口径：TB 自证休眠（年初=期末）或年初期末全零
            // 的户不算未覆盖。
            let dormant = (a.opening_from_tb
                && (a.tb_closing_balance - a.opening_balance).abs() <= 0.01)
                || (a.opening_balance.abs() <= 0.01 && a.tb_closing_balance.abs() <= 0.01);
            uncovered && !dormant
        })
        .count();
    let uncovered_entities: Vec<String> = if has_je {
        let mut active: BTreeSet<String> = accounts
            .iter()
            .filter(|a| a.tb_closing_balance.abs() > 0.01 || a.opening_balance.abs() > 0.01)
            .map(|a| a.entity.clone())
            .collect();
        if let Some(aggregate) = movements.as_ref() {
            for entity in &aggregate.je_entities {
                active.remove(entity);
            }
        }
        active.into_iter().collect()
    } else {
        Vec::new()
    };
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
            "bookedNote": booked_note,
            "bookedDirectionConfirmed": booked_direction_unconfirmed_count == 0,
            "bookedDirectionUnconfirmedCount": booked_direction_unconfirmed_count,
            "difference": difference,
            "differenceRatio": ratio,
            // 还有账户没填利率时，测算合计本身就不完整，谈不上勾稽通过。
            "reconciliationPassed": missing_rate_count == 0
                && default_rate_count == 0
                && booked_direction_unconfirmed_count == 0
                && ratio.map(|r| r.abs() <= 0.05).unwrap_or(false),
            "reviewCount": review,
            "missingRateCount": missing_rate_count,
            "missingRateBalance": missing_rate_balance,
            "missingRateTiers": missing_rate_tiers,
            "defaultRateCount": default_rate_count,
            "defaultRateBalance": default_rate_balance,
            "monthlySource": if !has_je {
                "期初/期末两点法".to_string()
            } else if uncovered_count == 0 {
                "序时账逐月还原".to_string()
            } else {
                format!("序时账逐月还原（{uncovered_count} 户未覆盖，退回两点法）")
            },
            "jeUncoveredEntities": uncovered_entities,
            "jeUncoveredAccountCount": uncovered_count,
            "auxiliaryMatch": auxiliary_plan.verdicts.first().map(|group| {
                let verdict = &group.verdict;
                json!({
                    "status": verdict.status,
                    "column": verdict.column,
                    "anchorHits": verdict.anchor_hits,
                    "anchorTotal": verdict.anchor_total,
                    "competingColumns": verdict.competing_columns,
                })
            }),
            "auxiliaryGroups": auxiliary_plan.verdicts.iter().map(|group| json!({
                "entity": group.entity, "account": group.account,
                "status": group.verdict.status, "column": group.verdict.column,
                "anchorHits": group.verdict.anchor_hits, "anchorTotal": group.verdict.anchor_total,
            })).collect::<Vec<_>>(),
            "auxiliaryWarnings": auxiliary_warnings,
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
            "listedRateDate": LISTED_REFERENCE_DATE,
            "ratesStale": rates_stale,
            "rateAgeMonths": stale_months,
            "jeCurrencyAllocationWarningCount": multi_currency_group_count,
            "jeCurrencyAllocationWarning": je_currency_allocation_warning,
            "currencyFallbackMode": currency_fallback_mode,
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
        "entityScopeSelection": params.get("entityScope").cloned().unwrap_or_else(|| json!({"mode":"strict","mappings":[]})),
        "outputPaths": []
    }))
}

/// 利率优先级：账户级手填 > 用户改写的档位利率 > 内置挂牌暂估值。
/// 账户级手填有两个入口：测算结果表的历史覆盖（rateOverrides，按测算行键）
/// 与科目确认表的逐户改写（accountRateOverrides，按科目/辅助明细键）。
/// 来源文案保留真实来源；是否"直接取自内置挂牌表、未经用户确认"
/// 另由 `provisional` 标记表达，驱动待确认提示与汇总口径。
/// `resolved` 为 false 表示这一户还没有可用利率，不能算作"已勾稽"，
/// 也不该把 0 当成一个正常的测算结果。
struct ResolvedRate {
    tier: String,
    rate: f64,
    source: String,
    resolved: bool,
    provisional: bool,
}

fn resolve_rate(
    account: &AccountRow,
    overrides: Option<&Map<String, Value>>,
    account_rates: Option<&Map<String, Value>>,
    custom_rates: Option<&Map<String, Value>>,
    detail_key: &str,
) -> ResolvedRate {
    let over = overrides.and_then(|all| all.get(&account.key));
    let tier = over
        .and_then(|value| value.get("tier"))
        .and_then(Value::as_str)
        .unwrap_or(&account.tier)
        .to_owned();
    let done = |rate: f64, source: &str, provisional: bool| ResolvedRate {
        tier: tier.clone(),
        rate: normalize_rate(rate),
        source: source.into(),
        resolved: true,
        provisional,
    };
    if let Some(rate) = over
        .and_then(|value| value.get("annualRate"))
        .and_then(Value::as_f64)
    {
        return done(rate, "本账户手工指定", false);
    }
    if let Some(rate) = account_rate_for(account, detail_key, account_rates) {
        return done(rate, "科目确认表手工指定", false);
    }
    if let Some(rate) = custom_rates
        .and_then(|all| all.get(&tier))
        .and_then(Value::as_f64)
    {
        return done(rate, "自定义档位利率", false);
    }
    // 内置挂牌值只作暂估，必须明确提示用户按协议或对账单复核。
    match auto_rate(&tier) {
        Some(rate) => done(rate, "挂牌暂估值", true),
        None => ResolvedRate {
            tier,
            rate: 0.0,
            source: "需填写实际利率".into(),
            resolved: false,
            provisional: false,
        },
    }
}

/// 科目确认表（第二步）的逐户利率改写。键空间与存款类型覆盖同一套：
/// 辅助明细键（主体␟科目␟辅助）优先，其次科目全文；全文因 TB/JE 拼法
/// 不同对不上时按科目编码回退。
fn account_rate_for(
    account: &AccountRow,
    detail_key: &str,
    rates: Option<&Map<String, Value>>,
) -> Option<f64> {
    let rates = rates?;
    if let Some(rate) = rates.get(detail_key).and_then(Value::as_f64) {
        return Some(rate);
    }
    if let Some(rate) = rates.get(&account.account).and_then(Value::as_f64) {
        return Some(rate);
    }
    let code = account_code(&account.account);
    if code.is_empty() {
        return None;
    }
    rates.iter().find_map(|(candidate, rate)| {
        (account_code(candidate) == code)
            .then(|| rate.as_f64())
            .flatten()
    })
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
type DepositAccountIndex = BTreeMap<(String, String, String), Vec<usize>>;

fn je_target_for_currency(
    index: &DepositAccountIndex,
    accounts: &[AccountRow],
    group: &(String, String, String),
    account: &str,
    auxiliary: &str,
    raw_currency: &str,
) -> Option<usize> {
    let candidates = index.get(group)?;
    if candidates.len() == 1 && accounts[candidates[0]].currency == "本位币合并" {
        return Some(candidates[0]);
    }
    let currency = account_currency(account, auxiliary, raw_currency);
    if currency.is_empty() {
        return (candidates.len() == 1).then_some(candidates[0]);
    }
    candidates
        .iter()
        .copied()
        .find(|candidate| currency_key(&accounts[*candidate].currency) == currency)
        .or_else(|| {
            (candidates.len() == 1 && currency_key(&accounts[candidates[0]].currency).is_empty())
                .then_some(candidates[0])
        })
}

/// 返回逐月发生额，以及金额口径是怎么判出来的——底稿要能交代清楚
/// "这本序时账是按哪种方案、哪种符号口径读的"。
/// 公共匹配口径下的科目键：主体＋`AccountMatchPolicy` 判定的键。TB 建户
/// 聚合与 JE 归集两侧都从这里取键，同一科目不会因为维度拆行对不上；
/// 前导零、编码/名称混写、名称歧义复合等口径全部由公共引擎裁决。
fn matched_account_key(
    entity: &str,
    account_text: &str,
    policy: &ledger_mapping::AccountMatchPolicy,
) -> String {
    // 科目文本可能是「名称在前、编码在后」的多列合并（4800 样例就是
    // 一级名称＋二级名称＋编码）。公共口径的编码提取只认首词是编码的
    // 形态，先用本模块的全文扫描器把编码词提出来再交给它，避免编码
    // 被提空、键退化成名称串。
    policy.account_key(
        entity,
        account_code(account_text),
        &ledger_mapping::account_name_of(account_text),
    )
}

/// 打开一次的序时账输入：小文件进内存表，大文件落磁盘规范化缓存。
/// 身份预扫（供匹配口径）与逐月归集复用同一份，避免同一文件读两遍。
enum JeInput {
    Memory(Arc<FxTable>, Map<String, Value>),
    Disk(crate::tabular::PreparedDiskLedger, Map<String, Value>),
}

#[derive(Default)]
struct DepositAuxiliaryPlan {
    tb_columns: BTreeMap<ledger_mapping::AuxiliaryGroupKey, usize>,
    /// 只有组判定为 verified 才入表；值为该组在 JE 中认定的列。
    verified_columns: BTreeMap<ledger_mapping::AuxiliaryGroupKey, String>,
    verdicts: Vec<ledger_mapping::AuxiliaryLinkGroupVerdict>,
}

impl DepositAuxiliaryPlan {
    fn column_for(&self, group: &ledger_mapping::AuxiliaryGroupKey) -> Option<&str> {
        self.verified_columns.get(group).map(String::as_str)
    }

    fn key_for_tb(&self, group: &ledger_mapping::AuxiliaryGroupKey, raw: &str) -> String {
        if self.column_for(group).is_none() {
            return String::new();
        }
        let normalized = ledger_mapping::anchor_norm(raw);
        if normalized.is_empty() {
            "未分辅助".to_owned()
        } else {
            normalized
        }
    }

    fn key_for_je(
        &self,
        group: &ledger_mapping::AuxiliaryGroupKey,
        headers: &[String],
        row: &[String],
    ) -> String {
        let Some(column) = self.column_for(group) else {
            return String::new();
        };
        let raw = ledger_mapping::header_index(headers, column)
            .and_then(|index| row.get(index))
            .map(String::as_str)
            .unwrap_or("");
        let normalized = ledger_mapping::anchor_norm(raw);
        if normalized.is_empty() {
            "未分辅助".to_owned()
        } else {
            normalized
        }
    }
}

fn open_je_input(
    params: &Value,
    cancel: &AtomicBool,
    progress: &dyn Fn(&str, usize, usize, &str),
    total: usize,
) -> Result<Option<JeInput>, AppError> {
    if params.get("jeSource").is_none_or(Value::is_null) {
        return Ok(None);
    }
    let spec: SourceSpec = serde_json::from_value(
        params.get("jeSource").cloned().unwrap_or(Value::Null),
    )
    .map_err(|e| {
        error(
            "MISSING_SOURCE",
            "缺少 jeSource 数据源或参数不完整。",
            Some(e.to_string()),
        )
    })?;
    let je_map = params
        .get("jeMapping")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let path = PathBuf::from(&spec.input_path);
    if crate::tabular::disk_ledger_applies(&path) {
        require_mappings("je", &je_map, false)?;
        let disk_progress = |_: &str, current: usize, inner_total: usize, message: &str| {
            let percent = if inner_total == 0 {
                0
            } else {
                current.saturating_mul(100) / inner_total
            };
            progress(
                "movement",
                2,
                total,
                &format!("{message}（磁盘处理 {percent}%）"),
            );
        };
        let ledger = crate::tabular::open_prepared_disk_ledger(
            &path,
            spec.header_row.max(1),
            spec.header_depth.max(1),
            &je_map,
            &disk_progress,
            cancel,
        )?;
        return Ok(Some(JeInput::Disk(ledger, je_map)));
    }
    let (table, mapping) = table_for(params, "jeSource", "jeMapping")?;
    Ok(Some(JeInput::Memory(table, mapping)))
}

/// 序时账侧的（主体、编码、名称）身份清单，喂给 `AccountMatchPolicy` 判
/// 两侧编码歧义。只收集身份，不解析金额。
fn je_account_identities(
    je: &JeInput,
    entity_key_enabled: bool,
    entity_scope: &ledger_mapping::EntityScope,
    cancel: &AtomicBool,
) -> Result<Vec<(String, String, String)>, AppError> {
    let mut seen = BTreeSet::new();
    match je {
        JeInput::Memory(table, mapping) => {
            let account_cols = account_columns(table, mapping);
            if account_cols.is_empty() {
                return Ok(Vec::new());
            }
            for row in &table.rows {
                let account = join_columns(row, &account_cols);
                if account.is_empty() {
                    continue;
                }
                let code = account_code(&account).to_owned();
                if code.is_empty() {
                    continue;
                }
                seen.insert((
                    scoped_entity(
                        &cell_text(table, row, mapping, "entity"),
                        entity_key_enabled,
                        ledger_mapping::EntitySide::Je,
                        entity_scope,
                    ),
                    code,
                    ledger_mapping::account_name_of(&account),
                ));
            }
        }
        JeInput::Disk(ledger, mapping) => {
            let headers = ledger.headers();
            let indexes = |role: &str| -> Vec<usize> {
                let columns = match mapping.get(role) {
                    Some(Value::String(value)) => vec![value.as_str()],
                    Some(Value::Array(values)) => values.iter().filter_map(Value::as_str).collect(),
                    _ => Vec::new(),
                };
                columns
                    .into_iter()
                    .filter_map(|column| headers.iter().position(|header| header == column))
                    .collect()
            };
            let mut account_cols = indexes("accountCode");
            for index in indexes("accountName") {
                if !account_cols.contains(&index) {
                    account_cols.push(index);
                }
            }
            if account_cols.is_empty() {
                account_cols = indexes("account");
            }
            account_cols.sort_unstable();
            if account_cols.is_empty() {
                return Ok(Vec::new());
            }
            let entity_index = indexes("entity").first().copied();
            ledger.visit(false, cancel, |row| {
                let account = join_columns(&row.values, &account_cols);
                if account.is_empty() {
                    return Ok(());
                }
                let code = account_code(&account).to_owned();
                if code.is_empty() {
                    return Ok(());
                }
                seen.insert((
                    scoped_entity(
                        entity_index
                            .and_then(|index| row.values.get(index))
                            .map(String::as_str)
                            .unwrap_or(""),
                        entity_key_enabled,
                        ledger_mapping::EntitySide::Je,
                        entity_scope,
                    ),
                    code,
                    ledger_mapping::account_name_of(&account),
                ));
                Ok(())
            })?;
        }
    }
    Ok(seen.into_iter().collect())
}

/// 存款户的辅助键按（有效主体，公共科目键）逐组验证。
/// 验证只看已选货币资金科目，且故意不接收报告期间；
/// 某组不是 verified 时，整组退回主体＋科目。
fn deposit_auxiliary_plan(
    tb: &FxTable,
    tb_map: &Map<String, Value>,
    tb_leaf: &[bool],
    je: Option<&JeInput>,
    policy: &ledger_mapping::AccountMatchPolicy,
    params: &Value,
    entity_key_enabled: bool,
    entity_scope: &ledger_mapping::EntityScope,
    cancel: &AtomicBool,
) -> Result<DepositAuxiliaryPlan, AppError> {
    let Some(je) = je else {
        return Ok(DepositAuxiliaryPlan::default());
    };
    if ledger_mapping::mapped_column_names(tb_map, "auxiliary").is_empty() {
        return Ok(DepositAuxiliaryPlan::default());
    }
    let account_cols = account_columns(tb, tb_map);
    let inherited_accounts =
        ledger_mapping::tb_dimension_rows(&tb.headers, &tb.rows, tb_map, "auxiliary", None)
            .into_iter()
            .map(|row| {
                (
                    row.index,
                    format!("{} {}", row.code, row.name).trim().to_owned(),
                )
            })
            .collect::<BTreeMap<_, _>>();
    let anchors = ledger_mapping::tb_auxiliary_anchor_groups(
        &tb.headers,
        &tb.rows,
        tb_map,
        "auxiliary",
        |index, row| {
            let account = inherited_accounts
                .get(&index)
                .cloned()
                .unwrap_or_else(|| join_columns(row, &account_cols));
            if account.is_empty() || !is_deposit_role(&role_for(&account, params)) {
                return None;
            }
            let entity = scoped_entity(
                &cell_text(tb, row, tb_map, "entity"),
                entity_key_enabled,
                ledger_mapping::EntitySide::Tb,
                entity_scope,
            );
            Some((
                entity.clone(),
                matched_account_key(&entity, &account, policy),
            ))
        },
    );
    if anchors.is_empty() {
        return Ok(DepositAuxiliaryPlan::default());
    }
    let (headers, je_map) = match je {
        JeInput::Memory(table, mapping) => (table.headers.as_slice(), mapping),
        JeInput::Disk(disk, mapping) => (disk.headers(), mapping),
    };
    let preferred = ledger_mapping::mapped_column_names(je_map, "auxiliary");
    let mut accumulator = ledger_mapping::GroupedAnchorColumnAccumulator::new(headers.len());
    let mut totals = BTreeMap::<ledger_mapping::AuxiliaryGroupKey, usize>::new();
    let mut feed = |row: &[String]| {
        let account_cols = column_indexes_from_headers(headers, je_map, "accountCode")
            .into_iter()
            .chain(column_indexes_from_headers(headers, je_map, "accountName"))
            .collect::<Vec<_>>();
        let account_cols = if account_cols.is_empty() {
            column_indexes_from_headers(headers, je_map, "account")
        } else {
            account_cols
        };
        let account = join_columns(row, &account_cols);
        if account.is_empty() {
            return;
        }
        let entity = scoped_entity(
            &column_indexes_from_headers(headers, je_map, "entity")
                .first()
                .and_then(|index| row.get(*index))
                .cloned()
                .unwrap_or_default(),
            entity_key_enabled,
            ledger_mapping::EntitySide::Je,
            entity_scope,
        );
        let group = (
            entity.clone(),
            matched_account_key(&entity, &account, policy),
        );
        let Some(group_anchors) = anchors.get(&group) else {
            return;
        };
        *totals.entry(group.clone()).or_default() += 1;
        accumulator.feed(group, row, group_anchors);
    };
    match je {
        JeInput::Memory(table, _) => {
            for row in &table.rows {
                feed(row);
            }
        }
        JeInput::Disk(disk, _) => {
            disk.visit(false, cancel, |row| {
                feed(&row.values);
                Ok(())
            })?;
        }
    }
    let je_scans = accumulator.finish(headers);
    let mut tb_accumulator = ledger_mapping::GroupedAnchorColumnAccumulator::new(tb.headers.len());
    for (index, row) in tb.rows.iter().enumerate() {
        let account = inherited_accounts
            .get(&index)
            .cloned()
            .unwrap_or_else(|| join_columns(row, &account_cols));
        let entity = scoped_entity(
            &cell_text(tb, row, tb_map, "entity"),
            entity_key_enabled,
            ledger_mapping::EntitySide::Tb,
            entity_scope,
        );
        let group = (
            entity.clone(),
            matched_account_key(&entity, &account, policy),
        );
        if let Some(values) = anchors.get(&group) {
            tb_accumulator.feed(group, row, values);
        }
    }
    let tb_scans = tb_accumulator.finish(&tb.headers);
    let verdicts = ledger_mapping::auxiliary_link_group_verdicts_by_tb_columns(
        &anchors,
        &tb_scans,
        &je_scans,
        &totals,
        tb_map,
        "auxiliary",
        &preferred,
    );
    let columns = ledger_mapping::auxiliary_verified_columns(
        &verdicts,
        &tb_scans,
        &je_scans,
        &tb.headers,
        headers,
        tb_map,
        "auxiliary",
    );
    let tb_columns = columns
        .iter()
        .map(|(group, (tb_index, _))| (group.clone(), *tb_index))
        .collect();
    let verified_columns = columns
        .into_iter()
        .map(|(group, (_, je_index))| (group, headers[je_index].clone()))
        .collect();
    Ok(DepositAuxiliaryPlan {
        tb_columns,
        verified_columns,
        verdicts,
    })
}

/// 序时账逐月归集结果。
struct JeMovements {
    series: MonthlySeries,
    /// 每个账户归集到的有效发生额行数（净额≠0）；0 表示序时账未覆盖该户。
    matched_rows: BTreeMap<String, usize>,
    /// 科目命中 TB，但 JE 币种缺失/不匹配，不能分配到多币种行的发生额数。
    unallocated_currency_rows: usize,
    unallocated_currency_keys: BTreeSet<String>,
    /// 序时账期间内出现过的核算主体（scoped），供覆盖体检点名。
    je_entities: BTreeSet<String>,
    scheme: String,
    evidence: String,
}

fn monthly_movements(
    je: &JeInput,
    policy: &ledger_mapping::AccountMatchPolicy,
    accounts: &[AccountRow],
    auxiliary_plan: &DepositAuxiliaryPlan,
    entity_key_enabled: bool,
    entity_scope: &ledger_mapping::EntityScope,
    start: NaiveDate,
    end: NaiveDate,
    cancel: &AtomicBool,
    pause: &PauseCheckpoint,
    progress: &dyn Fn(&str, usize, usize, &str),
    total: usize,
) -> Result<Option<JeMovements>, AppError> {
    // 同一主体、科目、辅助键下可有多种币种；无币种 JE 只能归唯一候选。
    let mut key_index: DepositAccountIndex = BTreeMap::new();
    for (index, account) in accounts.iter().enumerate() {
        key_index
            .entry((
                account.entity.clone(),
                matched_account_key(&account.entity, &account.account, policy),
                auxiliary_plan.key_for_tb(
                    &(
                        account.entity.clone(),
                        matched_account_key(&account.entity, &account.account, policy),
                    ),
                    if account.auxiliary == "未分辅助" {
                        ""
                    } else {
                        &account.auxiliary
                    },
                ),
            ))
            .or_default()
            .push(index);
    }
    let mut series: MonthlySeries = accounts
        .iter()
        .map(|account| (account.key.clone(), [(0.0, 0.0); 12]))
        .collect();
    let mut matched_rows: BTreeMap<String, usize> = BTreeMap::new();
    let mut unallocated_currency_rows = 0usize;
    let mut unallocated_currency_keys = BTreeSet::new();
    let mut je_entities: BTreeSet<String> = BTreeSet::new();
    let mut matched = 0usize;
    // 进入日期解析的行数与解析失败的行数：全灭时「没有任何行匹配货币资金
    // 科目」会把人引去查科目映射，实际死因在日期（09 号样例：整本序时账
    // 没有「年」列，单列纯月份解析不出任何日期）。
    let mut considered_rows = 0usize;
    let mut unparsed_dates = 0usize;
    let (scheme, evidence) = match je {
        JeInput::Memory(table, mapping) => {
            // 抽样表只解析了开头若干行，拿它还原逐月余额会得到一份看似完整、
            // 实则缺了大半发生额的结果——宁可报错也不能悄悄算错。
            if table.sampled {
                return Err(error(
                    "JE_SAMPLED",
                    "序时账过大，当前只读取了部分行，无法据此还原逐月余额。请改用不含序时账的两点法，或提供按期间拆分后的序时账。",
                    None,
                ));
            }
            // 序时账只在提供时校验（与前端一致）；年初余额的放松只对 TB 一侧有意义。
            require_mappings("je", mapping, false)?;
            let date_indexes = column_indexes(table, mapping, "date");
            if date_indexes.is_empty() {
                return Err(error(
                    "MAPPING_INCOMPLETE",
                    "序时账尚未映射记账日期，无法还原逐月余额。",
                    None,
                ));
            }
            let account_cols = account_columns(table, mapping);
            if account_cols.is_empty() {
                return Err(error(
                    "MAPPING_INCOMPLETE",
                    "序时账尚未映射科目编码/名称。",
                    None,
                ));
            }
            let scheme = detect_amount_scheme(table, mapping)?;
            // 垃圾行剔除走引擎一份规则（`ledger_junk_mask`）：合计行、表尾手工草稿、
            // 游离数字行在此显式挡掉。此前这些行进不来靠的是「日期读不出／科目对不上」
            // 的间接效果——哪天循环放宽了其中一个条件它们就会漏进来，把合计翻倍。
            // 掩码语义是 `true` 表示该行要算。
            let keep = ledger_mapping::ledger_junk_mask(&table.headers, &table.rows, &|role| {
                column_indexes(table, mapping, role)
                    .into_iter()
                    .filter_map(|index| table.headers.get(index).cloned())
                    .collect()
            });
            for (row_index, row) in table.rows.iter().enumerate() {
                if !keep.get(row_index).copied().unwrap_or(true) {
                    continue;
                }
                considered_rows += 1;
                let Some(date) = ledger_mapping::parse_mapped_date(
                    &table.headers,
                    row,
                    &date_indexes,
                    Some(end.year()),
                ) else {
                    unparsed_dates += 1;
                    continue;
                };
                if date < start || date > end {
                    continue;
                }
                let account = join_columns(row, &account_cols);
                if account.is_empty() {
                    continue;
                }
                let entity = scoped_entity(
                    &cell_text(table, row, mapping, "entity"),
                    entity_key_enabled,
                    ledger_mapping::EntitySide::Je,
                    entity_scope,
                );
                je_entities.insert(entity.clone());
                let net = scheme.net(row);
                if net == 0.0 {
                    continue;
                }
                let group = (
                    entity.clone(),
                    matched_account_key(&entity, &account, policy),
                    auxiliary_plan.key_for_je(
                        &(
                            entity.clone(),
                            matched_account_key(&entity, &account, policy),
                        ),
                        &table.headers,
                        row,
                    ),
                );
                let Some(target) = je_target_for_currency(
                    &key_index,
                    accounts,
                    &group,
                    &account,
                    &group.2,
                    &cell_text(table, row, mapping, "currency"),
                ) else {
                    if key_index
                        .get(&group)
                        .is_some_and(|candidates| candidates.len() > 1)
                    {
                        unallocated_currency_rows += 1;
                        for candidate in &key_index[&group] {
                            unallocated_currency_keys.insert(accounts[*candidate].key.clone());
                        }
                    }
                    continue;
                };
                let (debit, credit) = if net < 0.0 { (0.0, -net) } else { (net, 0.0) };
                matched += 1;
                *matched_rows
                    .entry(accounts[target].key.clone())
                    .or_insert(0) += 1;
                let slot = &mut series.get_mut(&accounts[target].key).unwrap()
                    [(date.month() - 1) as usize];
                slot.0 += debit;
                slot.1 += credit;
            }
            (scheme.label(), scheme.evidence.clone())
        }
        JeInput::Disk(ledger, mapping) => {
            let headers = ledger.headers();
            let indexes = |role: &str| -> Vec<usize> {
                let columns = match mapping.get(role) {
                    Some(Value::String(value)) => vec![value.as_str()],
                    Some(Value::Array(values)) => values.iter().filter_map(Value::as_str).collect(),
                    _ => Vec::new(),
                };
                columns
                    .into_iter()
                    .filter_map(|column| headers.iter().position(|header| header == column))
                    .collect()
            };
            let date_indexes = indexes("date");
            if date_indexes.is_empty() {
                return Err(error(
                    "MAPPING_INCOMPLETE",
                    "序时账尚未映射记账日期，无法还原逐月余额。",
                    None,
                ));
            }
            let mut account_cols = indexes("accountCode");
            for index in indexes("accountName") {
                if !account_cols.contains(&index) {
                    account_cols.push(index);
                }
            }
            if account_cols.is_empty() {
                account_cols = indexes("account");
            }
            account_cols.sort_unstable();
            if account_cols.is_empty() {
                return Err(error(
                    "MAPPING_INCOMPLETE",
                    "序时账尚未映射科目编码/名称。",
                    None,
                ));
            }
            let entity_index = indexes("entity").first().copied();
            let row_count = ledger.row_count();
            let currency_index = indexes("currency").first().copied();
            let mut visited = 0usize;
            ledger.visit(false, cancel, |row| {
                visited += 1;
                if visited % 10_000 == 0 {
                    checkpoint(cancel, pause)?;
                }
                if visited % 50_000 == 0 {
                    progress(
                        "movement",
                        2,
                        total,
                        &format!(
                            "正在从磁盘汇总序时账月度发生额…已处理 {} / {} 行",
                            visited, row_count
                        ),
                    );
                }
                let Some(date) = ledger_mapping::parse_mapped_date(
                    headers,
                    &row.values,
                    &date_indexes,
                    Some(end.year()),
                ) else {
                    unparsed_dates += 1;
                    considered_rows += 1;
                    return Ok(());
                };
                considered_rows += 1;
                if date < start || date > end {
                    return Ok(());
                }
                let account = join_columns(&row.values, &account_cols);
                if account.is_empty() {
                    return Ok(());
                }
                let entity = scoped_entity(
                    entity_index
                        .and_then(|index| row.values.get(index))
                        .map(String::as_str)
                        .unwrap_or(""),
                    entity_key_enabled,
                    ledger_mapping::EntitySide::Je,
                    entity_scope,
                );
                je_entities.insert(entity.clone());
                if row.net == 0.0 {
                    return Ok(());
                }
                let group = (
                    entity.clone(),
                    matched_account_key(&entity, &account, policy),
                    auxiliary_plan.key_for_je(
                        &(
                            entity.clone(),
                            matched_account_key(&entity, &account, policy),
                        ),
                        headers,
                        &row.values,
                    ),
                );
                let currency = currency_index
                    .and_then(|index| row.values.get(index))
                    .map(String::as_str)
                    .unwrap_or("");
                let Some(target) = je_target_for_currency(
                    &key_index, accounts, &group, &account, &group.2, currency,
                ) else {
                    if key_index
                        .get(&group)
                        .is_some_and(|candidates| candidates.len() > 1)
                    {
                        unallocated_currency_rows += 1;
                        for candidate in &key_index[&group] {
                            unallocated_currency_keys.insert(accounts[*candidate].key.clone());
                        }
                    }
                    return Ok(());
                };
                let (debit, credit) = if row.net < 0.0 {
                    (0.0, -row.net)
                } else {
                    (row.net, 0.0)
                };
                matched += 1;
                *matched_rows
                    .entry(accounts[target].key.clone())
                    .or_insert(0) += 1;
                let slot = &mut series.get_mut(&accounts[target].key).unwrap()
                    [(date.month() - 1) as usize];
                slot.0 += debit;
                slot.1 += credit;
                Ok(())
            })?;
            checkpoint(cancel, pause)?;
            let convention = ledger.convention();
            let layout = if !indexes("functionalDebit").is_empty()
                && !indexes("functionalCredit").is_empty()
            {
                "借贷分列"
            } else if !indexes("functionalAmount").is_empty() && !indexes("direction").is_empty() {
                "金额＋方向列"
            } else {
                "单一金额列"
            };
            let scheme = format!(
                "{layout}，{}",
                if convention == ledger_mapping::SignConvention::Signed {
                    "数值已带符号（借正贷负）"
                } else {
                    "借贷符号一样（靠分列/方向区分）"
                }
            );
            let evidence = ledger.amount_evidence(cancel)?;
            (scheme, evidence)
        }
    };
    if matched == 0 && unallocated_currency_rows == 0 {
        if considered_rows > 0 && unparsed_dates == considered_rows {
            return Err(error(
                "NO_JE_DATE",
                "序时账的记账日期列解析不出任何一行日期：常见原因是「年/月/日」分列但源表没写年份，或日期角色映射到了非日期列。请回到第一步检查「记账日期」的映射。",
                None,
            ));
        }
        return Err(error(
            "NO_JE_MATCH",
            "序时账中没有任何行匹配到 TB 的货币资金科目；请检查科目映射或改用不含序时账的两点法。",
            None,
        ));
    }
    Ok(Some(JeMovements {
        series,
        matched_rows,
        unallocated_currency_rows,
        unallocated_currency_keys,
        je_entities,
        scheme,
        evidence,
    }))
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
        id: column_indexes(table, mapping, "id")
            .into_iter()
            .filter_map(|index| table.headers.get(index).cloned())
            .collect(),
        account_code: column("accountCode"),
        entity: column("entity"),
        date: column_indexes(table, mapping, "date")
            .into_iter()
            .filter_map(|index| table.headers.get(index).cloned())
            .collect(),
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

/// JE 发生额命中科目却缺少可用币种时，逐币种行只能退回 TB 两点法。
fn currency_allocation_warning(unallocated_rows: usize, multi_currency_groups: usize) -> String {
    if unallocated_rows == 0 {
        return String::new();
    }
    format!(
        "TB 中有 {multi_currency_groups} 个主体科目按多个币种列示；{unallocated_rows} 条 JE 有对应科目却缺少可用币种，不能分配到逐币种行。受影响账户按各自 TB 年初/年末两点法暂估月均余额，JE 推导和勾稽显示 N/A；请补充 JE 币种后重新测算。"
    )
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
    let kind = if source_key.eq_ignore_ascii_case("jeSource") {
        "je"
    } else {
        "tb"
    };
    let keep = if kind == "je" {
        ledger_mapping::ledger_junk_mask(&table.headers, &table.rows, &|role| {
            crate::fx::mapped_cols(&mapping, role)
        })
    } else {
        ledger_mapping::tb_leaf_mask(&table.headers, &table.rows, &|role| {
            crate::fx::mapped_cols(&mapping, role)
        })
    };
    crate::fx::validate_mapped_amount_values(
        &table,
        &mapping,
        kind,
        if kind == "je" { "JE" } else { "TB" },
        Some(&keep),
    )?;
    let table = if kind == "je" {
        crate::fx::forward_filled_je_table(&table, &mapping)
    } else {
        table
    };
    Ok((table, mapping))
}

fn column_indexes(table: &FxTable, mapping: &Map<String, Value>, role: &str) -> Vec<usize> {
    column_indexes_from_headers(&table.headers, mapping, role)
}

fn column_indexes_from_headers(
    headers: &[String],
    mapping: &Map<String, Value>,
    role: &str,
) -> Vec<usize> {
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
        .filter_map(|column| headers.iter().position(|header| header == column))
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

/// 利息收入科目的登记方向（正常发生额记借还是记贷）。
///
/// 已结转的损益科目借贷同额、期末为零，收入还是费用只能按「活动落在
/// 登记方向的哪一侧」判：红字（负数）＝与登记方向相反的活动。登记方向
/// 本身不在余额表里，只能从科目身份推——**费用类关键词优先于收入类**，
/// 且自身名称与 TB 里的上级科目名都查：挂在财务费用下、只有“利息”的
/// 子科目通常以红字借方冲减费用；`6051 其他业务收入` 这类独立收入科目
/// 按贷方向。末级明确写“利息收入”且借贷同为正数的结转形态，另由
/// [`explicit_interest_income_name`] 保留其贷方收入语义。
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum AccountDirection {
    Debit,
    Credit,
    Unknown,
}

const EXPENSE_DIRECTION_KEYWORDS: &[&str] = &[
    "费用",
    "手续费",
    "支出",
    "损失",
    "expense",
    "charge",
    "fee",
    "cost",
];
const INCOME_DIRECTION_KEYWORDS: &[&str] = &["收入", "收益", "income"];

fn registered_direction(account: &str, tb_accounts: &BTreeMap<String, String>) -> AccountDirection {
    let code = ledger_mapping::account_code_of(account);
    let name = ledger_mapping::account_name_of(account);
    let lower = name.to_lowercase();
    // 由近及远走编码前缀查上级科目；编码允许 `.`/`-` 分段（"6603.02"），
    // 全 ASCII 同样保证字节切片安全。此前只认纯数字：带点分段的末级永远
    // 查不到上级，"6603.02 利息收入"落在自身名称的「收入」关键词上，上级
    // "6603 财务费用"的费用属性失效，红字方向随之判反（10 号 PBC 样例）。
    let ancestor_hits = |keywords: &[&str]| -> bool {
        if code.len() < 2
            || !code
                .chars()
                .all(|c| c.is_ascii_digit() || c == '.' || c == '-')
        {
            return false;
        }
        (1..code.len())
            .rev()
            .filter_map(|length| tb_accounts.get(&code[..length]))
            .any(|parent| keywords.iter().any(|k| parent.to_lowercase().contains(k)))
    };
    if EXPENSE_DIRECTION_KEYWORDS.iter().any(|k| lower.contains(k))
        || ancestor_hits(EXPENSE_DIRECTION_KEYWORDS)
    {
        return AccountDirection::Debit;
    }
    if INCOME_DIRECTION_KEYWORDS.iter().any(|k| lower.contains(k))
        || ancestor_hits(INCOME_DIRECTION_KEYWORDS)
    {
        return AccountDirection::Credit;
    }
    AccountDirection::Unknown
}

/// 科目自身是否明确写的是“利息收入”。
///
/// `财务费用-利息收入` 在科目层级上仍属于借方费用类，但不少账套把该末级
/// 直接按贷方登记收入，再以年末借方结转，余额表因此呈现“借贷同正”。这与
/// 只有“利息”的用友红字冲减费用形态不同，必须保留这条末级语义证据。
fn explicit_interest_income_name(account: &str) -> bool {
    let name = ledger_mapping::account_name_of(account).to_lowercase();
    let compact: String = name
        .chars()
        .filter(|ch| !ch.is_whitespace() && !['-', '_', '/', '\\'].contains(ch))
        .collect();
    compact.contains("利息收入") || compact.contains("interestincome")
}

/// 已结转形态（借贷发生同额、净额为 0）下的账面利息收入取数。
/// 返回（金额, 口径说明）。
///
/// - **Unsigned 表**（负数＝红字，经济上归属对面一侧）：红字对＝与登记
///   方向相反的活动。费用方向科目＋红字对＝冲减费用＝收入（用友记法的
///   `财务费用-利息` 即此）；费用方向科目＋正常对＝活动在借方，这不是
///   利息收入而是费用，计负数冲减基准。收入方向科目对称相反。
/// - **Signed 表**（贷方列本身借正贷负）：导出口径已把红字与正常抹平，
///   只能按登记方向定符号。
fn closed_pair_baseline(
    convention: ledger_mapping::SignConvention,
    direction: AccountDirection,
    credit: f64,
    debit: f64,
    explicit_interest_income: bool,
) -> (f64, &'static str) {
    let magnitude = credit.abs().max(debit.abs());
    let red = credit < 0.0 || debit < 0.0;
    // “利息收入”末级借贷同为正数时，贷方是本年收入、借方是期末结转，
    // 经济发生额应取正的贷方全额。不能仅因上级叫“财务费用”就把它判成
    // 借方费用并取负；陇能建设样例的 660302 正是这种标准形态。
    if explicit_interest_income && !red {
        return (magnitude, "已结转·末级明确为利息收入，按贷方全额计入");
    }
    match (convention, direction) {
        (ledger_mapping::SignConvention::Unsigned, AccountDirection::Debit) => {
            if red {
                (magnitude, "已结转·红字冲减费用，按收入计入")
            } else {
                (-magnitude, "已结转·费用性质，按负数计入")
            }
        }
        (ledger_mapping::SignConvention::Unsigned, AccountDirection::Credit) => {
            if red {
                (-magnitude, "已结转·红字冲减收入，按负数计入")
            } else {
                (magnitude, "已结转·按贷方全额计入")
            }
        }
        (_, AccountDirection::Debit) => (
            -magnitude,
            "已结转·费用性质，按负数计入（表为借正贷负口径）",
        ),
        (_, AccountDirection::Credit) => (magnitude, "已结转·按贷方全额计入（表为借正贷负口径）"),
        (_, AccountDirection::Unknown) => (
            magnitude,
            "已结转·科目方向未识别，按全额计入，请复核红字方向",
        ),
    }
}

/// 账面利息收入的发生额口径：本年累计优先，表里只给本期时退而求其次。
/// 返回（金额, 口径说明, 借方原值, 贷方原值, 发生方向已由金额确认）——借贷原值供底稿的
/// 「账面利息收入科目明细」整行列示，审计人员要能看到取数来源的两栏。
/// `None` 表示该口径下没有可用数据（借贷均未映射或全为 0），让调用方退到期末余额。
///
/// 金额一律折成「贷方正」的经济净额：Unsigned 表的负数是红字（经济上
/// 归属对面一侧），净额 `贷－借` 天然正确；Signed 表贷方列本身借正贷负，
/// 净额要按 `－贷－借` 折——此前不分口径一律 `贷－借`，Signed 表的
/// 已结转行会算出 2 倍金额的双倍净额。
fn booked_occurrence(
    table: &FxTable,
    row: &[String],
    mapping: &Map<String, Value>,
    convention: ledger_mapping::SignConvention,
    direction: AccountDirection,
    explicit_interest_income: bool,
) -> Option<(f64, String, f64, f64, bool)> {
    for (credit_role, debit_role) in [
        ("ytdFunctionalCredit", "ytdFunctionalDebit"),
        ("periodFunctionalCredit", "periodFunctionalDebit"),
    ] {
        let credit = cell_number(table, row, mapping, credit_role);
        let debit = cell_number(table, row, mapping, debit_role);
        if credit.is_none() && debit.is_none() {
            continue;
        }
        let (cr, dr) = (credit.unwrap_or(0.0), debit.unwrap_or(0.0));
        let net = match convention {
            ledger_mapping::SignConvention::Unsigned => cr - dr,
            ledger_mapping::SignConvention::Signed => -cr - dr,
        };
        if net.abs() > 0.005 {
            let side = if net > 0.0 { "贷方" } else { "借方" };
            return Some((
                net,
                format!("{side}净发生额（按借贷金额判定）"),
                dr,
                cr,
                true,
            ));
        }
        // 年末已结转的损益科目：结转分录使借贷发生同额，净额恒为 0，
        // 期末余额也是 0。此时按红字与科目登记方向定收入/费用符号。
        if cr.abs() <= 0.005 && dr.abs() <= 0.005 {
            return None;
        }
        let (amount, note) =
            closed_pair_baseline(convention, direction, cr, dr, explicit_interest_income);
        return Some((
            amount,
            format!("{note}；借贷同额，按科目登记方向与红字符号判定"),
            dr,
            cr,
            direction != AccountDirection::Unknown,
        ));
    }
    None
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
    // 勾稽比较直接接在汇总表下方：单独一张 sheet 只有一屏数据，
    // 翻页反而割裂；同 sheet 还让「审计测算存款利息」能直接引用 N 列合计。
    let day_basis = summary["dayBasis"].as_str().unwrap_or("month12");
    let summary_sheet = workbook.add_worksheet();
    write_summary(summary_sheet, &rows, &ranges)?;
    write_reconciliation(summary_sheet, &rows, summary, result, rows.len() as u32 + 2)?;
    write_monthly(workbook.add_worksheet(), &rows, day_basis)?;
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
    // 列顺序对应公式里的字母：
    // G=年利率(输入) H=年初 I=年末(TB) J=年末(JE推导) K=勾稽差异 L=勾稽结论 M=月均 N=测算利息
    let headers = [
        "核算主体",
        "科目",
        "辅助核算/账户",
        "币种",
        "存款档位",
        "利率来源",
        "年利率（可修改）",
        "年初余额",
        "年末余额(TB)",
        "年末余额(JE推导)",
        "勾稽差异",
        "勾稽结论",
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
        let line = y + 1;
        let (first, last) = ranges[index];
        sheet
            .write_string(
                y,
                0,
                if row.entity == ledger_mapping::DEFAULT_ENTITY {
                    "未区分主体"
                } else {
                    &row.entity
                },
            )
            .map_err(xlsx)?;
        sheet.write_string(y, 1, &row.account).map_err(xlsx)?;
        sheet.write_string(y, 2, &row.auxiliary).map_err(xlsx)?;
        sheet.write_string(y, 3, &row.currency).map_err(xlsx)?;
        sheet.write_string(y, 4, &row.tier_label).map_err(xlsx)?;
        sheet.write_string(y, 5, &row.rate_source).map_err(xlsx)?;
        // 没确定利率的留空白输入格：写 0 会算出"0 元利息"这种看似有效的结论。
        if row.rate_resolved {
            sheet
                .write_number_with_format(y, 6, row.annual_rate, &input)
                .map_err(xlsx)?;
        } else {
            sheet.write_blank(y, 6, &input).map_err(xlsx)?;
        }
        sheet
            .write_number_with_format(y, 7, row.opening_balance, &amount)
            .map_err(xlsx)?;
        sheet
            .write_number_with_format(y, 8, row.tb_closing_balance, &amount)
            .map_err(xlsx)?;
        // TB 给了独立年初余额，且 JE 有发生额或以零发生额与年初＝年末相互
        // 印证时才可勾稽；否则两点法的期末不能冒充 JE 推导。
        if row.je_reconciled {
            sheet
                .write_formula_with_format(
                    y,
                    9,
                    Formula::new(format!(
                        "H{line}+SUM('{MONTHLY_SHEET}'!H{first}:H{last})-SUM('{MONTHLY_SHEET}'!I{first}:I{last})"
                    ))
                    .set_result(row.derived_closing_balance.to_string()),
                    &amount,
                )
                .map_err(xlsx)?;
        } else {
            sheet.write_string(y, 9, "N/A").map_err(xlsx)?;
        }
        // 仅已取得独立 JE 证据的行输出活公式，其余行显式不可用。
        if row.je_reconciled {
            sheet
                .write_formula_with_format(
                    y,
                    10,
                    Formula::new(format!("J{line}-I{line}"))
                        .set_result(row.reconciliation_diff.to_string()),
                    &amount,
                )
                .map_err(xlsx)?;
            sheet
                .write_formula_with_format(
                    y,
                    11,
                    Formula::new(format!("IF(ABS(K{line})<0.01,\"勾稽一致\",\"存在差异\")"))
                        .set_result(if row.reconciliation_diff.abs() < 0.01 {
                            "勾稽一致".to_string()
                        } else {
                            "存在差异".to_string()
                        }),
                    &Format::new(),
                )
                .map_err(xlsx)?;
        } else {
            sheet.write_string(y, 10, "N/A").map_err(xlsx)?;
            sheet.write_string(y, 11, "未执行 JE 勾稽").map_err(xlsx)?;
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
    sheet.set_column_width(15, 46).map_err(xlsx)?;
    sheet.autofit();
    if rows.iter().all(|row| row.auxiliary.trim().is_empty()) {
        sheet.set_column_hidden(2).map_err(xlsx)?;
    }
    Ok(())
}

fn write_monthly(
    sheet: &mut Worksheet,
    rows: &[AccountRow],
    day_basis: &str,
) -> Result<(), AppError> {
    sheet.set_name(MONTHLY_SHEET).map_err(xlsx)?;
    let amount = Format::new().set_num_format("#,##0.00;[Red](#,##0.00);-");
    let percent = Format::new().set_num_format("0.0000%");
    // 按月平均口径里 M 列的 1 是「1 期＝1/12 年」，不是 1 天——列名跟着
    // 口径走，审计人员才不会把 1 误读成计息天数只有一天。
    let period_title = if day_basis == "month12" {
        "计息期数（月）"
    } else {
        "计息天数"
    };
    // 列顺序必须与下面公式里的字母严格一致：
    // G=月初余额 H=借方 I=贷方 J=月末余额 K=月均余额 L=年利率 M=计息期数/天数 N=年基数 O=当月利息
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
        period_title,
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
            sheet
                .write_string(
                    y,
                    0,
                    if row.entity == ledger_mapping::DEFAULT_ENTITY {
                        "未区分主体"
                    } else {
                        &row.entity
                    },
                )
                .map_err(xlsx)?;
            sheet.write_string(y, 1, &row.account).map_err(xlsx)?;
            sheet.write_string(y, 2, &row.auxiliary).map_err(xlsx)?;
            sheet
                .write_string(y, 3, format!("{}月", month.month))
                .map_err(xlsx)?;
            sheet.write_string(y, 4, &row.tier_label).map_err(xlsx)?;
            sheet.write_string(y, 5, &row.currency).map_err(xlsx)?;
            if row.two_point {
                // 两点法没有月初/月末证据，不导出内部分摊用的插值。
                for column in 6..=9 {
                    sheet.write_blank(y, column, &amount).map_err(xlsx)?;
                }
            } else {
                for (offset, value) in [month.opening, month.debit, month.credit, month.closing]
                    .iter()
                    .enumerate()
                {
                    sheet
                        .write_number_with_format(y, 6 + offset as u16, *value, &amount)
                        .map_err(xlsx)?;
                }
            }
            let average_formula = if row.two_point {
                format!("('{SUMMARY_SHEET}'!H{summary_row}+'{SUMMARY_SHEET}'!I{summary_row})/2")
            } else {
                format!("(G{line}+J{line})/2")
            };
            sheet
                .write_formula_with_format(
                    y,
                    10,
                    Formula::new(average_formula).set_result(month.average.to_string()),
                    &amount,
                )
                .map_err(xlsx)?;
            // 年利率回引汇总表的输入格：在汇总表改一次，整列月度利息跟着变。
            sheet
                .write_formula_with_format(
                    y,
                    11,
                    Formula::new(format!("'{SUMMARY_SHEET}'!$G${summary_row}"))
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
    if rows.iter().all(|row| row.auxiliary.trim().is_empty()) {
        sheet.set_column_hidden(2).map_err(xlsx)?;
    }
    Ok(())
}

/// 与 TB 利息收入的勾稽比较：写在汇总表（`SUMMARY_SHEET`）正文下方，
/// `offset` 是本块首行在整张 sheet 里的 0 基行号（调用方传正文后留一空行）。
fn write_reconciliation(
    sheet: &mut Worksheet,
    rows: &[AccountRow],
    summary: &Value,
    result: &Value,
    offset: u32,
) -> Result<(), AppError> {
    let amount = Format::new().set_num_format("#,##0.00;[Red](#,##0.00);-");
    let percent = Format::new().set_num_format("0.00%");
    let bold = Format::new().set_bold();
    let last = rows.len() as u32 + 1;
    let booked = summary["bookedInterestIncome"].as_f64().unwrap_or(0.0);
    // 同一张 sheet，公式不再带 sheet 前缀；行号全部平移 offset。
    let (row_calc, row_booked, row_diff, row_ratio) =
        (offset + 2, offset + 3, offset + 4, offset + 5);
    sheet
        .write_string_with_format(offset, 0, "存款利息测算与账面利息收入比较", &bold)
        .map_err(xlsx)?;
    sheet
        .write_string(row_calc, 0, "审计测算存款利息")
        .map_err(xlsx)?;
    sheet
        .write_formula_with_format(
            row_calc,
            1,
            Formula::new(format!("SUM(N2:N{last})")).set_result(
                summary["calculatedInterest"]
                    .as_f64()
                    .unwrap_or(0.0)
                    .to_string(),
            ),
            &amount,
        )
        .map_err(xlsx)?;
    sheet
        .write_string(row_booked, 0, "TB 账面利息收入（取自利息收入类科目）")
        .map_err(xlsx)?;
    sheet
        .write_number_with_format(row_booked, 1, booked, &amount)
        .map_err(xlsx)?;
    sheet
        .write_string(row_diff, 0, "差异（测算－账面）")
        .map_err(xlsx)?;
    sheet
        .write_formula_with_format(
            row_diff,
            1,
            Formula::new(format!("B{}-B{}", row_calc + 1, row_booked + 1)),
            &amount,
        )
        .map_err(xlsx)?;
    sheet.write_string(row_ratio, 0, "差异率").map_err(xlsx)?;
    sheet
        .write_formula_with_format(
            row_ratio,
            1,
            Formula::new(format!(
                "IFERROR(ABS(B{}/B{}),0)",
                row_diff + 1,
                row_booked + 1
            )),
            &percent,
        )
        .map_err(xlsx)?;
    let mut y = offset + 6;
    y += 2;
    sheet
        .write_string_with_format(y, 0, "账面利息收入科目明细", &bold)
        .map_err(xlsx)?;
    y += 1;
    // 明细把取数来源整行列示（借贷发生额、期末余额），审计人员才能
    // 不回到源表就复核基准数是怎么来的。
    for (column, title) in [
        "核算主体",
        "科目",
        "本期借方发生额",
        "本期贷方发生额",
        "期末余额(借正贷负)",
        "账面利息收入",
        "口径",
    ]
    .iter()
    .enumerate()
    {
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
        for (key, column) in [
            ("debit", 2u16),
            ("credit", 3u16),
            ("closing", 4u16),
            ("bookedAmount", 5u16),
        ] {
            sheet
                .write_number_with_format(y, column, item[key].as_f64().unwrap_or(0.0), &amount)
                .map_err(xlsx)?;
        }
        sheet
            .write_string(y, 6, item["note"].as_str().unwrap_or(""))
            .map_err(xlsx)?;
    }
    // 列宽由上方的汇总表统一决定（autofit 已含本块），不再单独设置。
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
        "默认暂估范围：有挂牌参考值的活期、协定、通知、定期和大额存单档位均先按默认值暂估并纳入测算；用户改写值优先。自定义、外币特殊产品仍须填实际利率。所有暂估值均须按存款协议、对账单或利息清单确认。".to_string(),
        format!("央行基准来源：中国人民银行《金融机构人民币存款基准利率调整表》，{PBC_BENCHMARK_DATE} 起执行，至今未再调整。仅作合理性上限参照，不参与测算——3 年期基准 2.75% 对比实际约 1.25%，拿它算会把利息放大一倍以上。"),
        format!("大行挂牌来源：国有大型商业银行人民币存款挂牌利率，{LISTED_REFERENCE_DATE} 调整后水平；2022 年建立存款利率市场化调整机制后由各行自主报价，已多轮下调。"),
        "实务常见区间：常见报价范围的经验值，不是官方公布数据，只用于提示填入的利率是否明显偏离。".to_string(),
        "审计依据：以上都只是默认值和合理性参照。实际计息利率应以客户的存款协议、银行对账单或银行出具的利息清单为准。".to_string(),
        "官方查询入口：中国人民银行 http://www.pbc.gov.cn/ （货币政策—利率政策）；中国货币网 https://www.chinamoney.com.cn/ （利率自律机制公告）；各行挂牌利率见其官网“人民币存款利率表”栏目。".to_string(),
        "修改方式：档位利率可在工具界面的「存款利率档位」中改写；单个账户的利率可在「测算汇总」G 列直接改写，单户改写优先于档位默认值。".to_string(),
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
    let mut items: Vec<(String, String)> = vec![
        ("测算期间".into(), format!(
            "{} 至 {}",
            summary["reportStart"].as_str().unwrap_or(""),
            summary["reportEnd"].as_str().unwrap_or("")
        )),
        ("月度余额来源".into(), summary["monthlySource"].as_str().unwrap_or("").into()),
        (
            "多币种处理口径".into(),
            match summary["currencyFallbackMode"].as_str().unwrap_or("") {
                "functional" => "统一使用本位币匡算：各币种余额合并，使用 JE 本位币发生额还原逐月余额。",
                "twoPointByCurrency" => "按币种使用年初、年末平均值：分别填写利率，不使用 JE 还原逐月余额。",
                _ => "TB、JE 按币种正常匹配。",
            }
            .into(),
        ),
        ("序时账金额口径".into(), summary["amountScheme"].as_str().unwrap_or("—").into()),
        ("口径判定依据".into(), summary["amountEvidence"].as_str().unwrap_or("—").into()),
        (
            "序时账未覆盖主体".into(),
            match summary["jeUncoveredEntities"].as_array() {
                Some(entities) if !entities.is_empty() => entities
                    .iter()
                    .filter_map(Value::as_str)
                    .collect::<Vec<_>>()
                    .join("、"),
                _ => "无（或未提供序时账）".into(),
            },
        ),
        ("计息口径".into(), summary["dayBasisLabel"].as_str().unwrap_or("").into()),
        ("纳入测算账户数".into(), rows.len().to_string()),
        ("待复核账户数".into(), summary["reviewCount"].to_string()),
        ("待填利率账户数".into(), summary["missingRateCount"].to_string()),
        ("计算口径".into(), if summary["dayBasis"].as_str() == Some("month12") {
            "JE 月度法：月均余额 =（月初＋月末）÷2；两点法：年均余额 =（年初＋年末）÷2，无月末余额证据。当期利息 = 平均余额 × 年利率 ÷ 12（月度表 M 列为期数）。".to_string()
        } else {
            "JE 月度法：月均余额 =（月初＋月末）÷2；两点法：年均余额 =（年初＋年末）÷2，无月末余额证据。当期利息 = 平均余额 × 年利率 × 计息天数 ÷ 年基数。".to_string()
        }),
        ("勾稽口径".into(), "测算利息合计与 TB 利息收入类科目本期发生额净额比较，差异率超过 5% 提示复核。".into()),
        ("修改方式".into(), format!("在「{SUMMARY_SHEET}」G 列黄色「年利率」单元格直接改写利率，「{MONTHLY_SHEET}」的月度利息、汇总的测算利息与勾稽差异/结论会自动重算。")),
        ("利率确认".into(), "有挂牌参考值的标准档位已预填暂估利率并纳入测算；黄色利率格均可改写。空白表示自定义或特殊产品尚无可用利率，填入实际利率后金额自动出现。".into()),
    ];
    if let Some(warnings) = summary["auxiliaryWarnings"].as_array() {
        let messages = warnings
            .iter()
            .filter_map(Value::as_str)
            .filter(|text| !text.is_empty())
            .collect::<Vec<_>>();
        if !messages.is_empty() {
            items.push((
                "辅助核算联动".into(),
                messages
                    .iter()
                    .enumerate()
                    .map(|(index, message)| format!("{}. {message}", index + 1))
                    .collect::<Vec<_>>()
                    .join("\n"),
            ));
        }
    }
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

    #[test]
    fn 序时账年月拆列自动挂记账日期() {
        // 金蝶 08/09 导出：日期拆成「年-月」「年-日」两列。归一后「年-月」
        // 是「年月」，正撞 date 的冲突词「年」「月」；不放行的话 FA List／
        // 存款利息页的记账日期永远空着。
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("je.xlsx");
        write_fixture(
            &path,
            &[
                vec![
                    "年-月",
                    "年-日",
                    "凭证号",
                    "分录号",
                    "摘要",
                    "科目编码",
                    "科目名称",
                    "借方金额",
                    "贷方金额",
                ],
                vec![
                    "2025-01",
                    "6",
                    "记-1",
                    "1",
                    "提取现金",
                    "1001",
                    "库存现金",
                    "500",
                    "",
                ],
                vec![
                    "2025-01",
                    "6",
                    "记-1",
                    "2",
                    "提取现金",
                    "100201",
                    "银行存款",
                    "",
                    "500",
                ],
                vec![
                    "2025-02",
                    "11",
                    "记-2",
                    "1",
                    "支付货款",
                    "220201",
                    "应付账款",
                    "800",
                    "",
                ],
                vec![
                    "2025-02",
                    "11",
                    "记-2",
                    "2",
                    "支付货款",
                    "100201",
                    "银行存款",
                    "",
                    "800",
                ],
            ],
        );
        let inspected = inspect(
            &json!({"source": {"inputPath": path.to_string_lossy()}}),
            "je",
        )
        .unwrap();
        assert_eq!(inspected["suggestedMapping"]["date"], json!("年-月"));
    }

    #[test]
    fn 科目余额表年月列仍归会计期间不给记账日期() {
        // TB 侧「年月」是本地 period 角色的别名（没有日期列时靠它取年份），
        // 放行只限 JE：这里 period 必须留住，date 不得抢列。
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("tb.xlsx");
        write_fixture(
            &path,
            &[
                vec!["科目编码", "科目名称", "年月", "期初余额", "期末余额"],
                vec!["1001", "库存现金", "2025-01", "1000", "1500"],
                vec!["100201", "银行存款", "2025-01", "20000", "18000"],
                vec!["220201", "应付账款", "2025-01", "5000", "6000"],
                vec!["600101", "主营业务收入", "2025-01", "", "3000"],
            ],
        );
        let inspected = inspect(
            &json!({"source": {"inputPath": path.to_string_lossy()}}),
            "tb",
        )
        .unwrap();
        assert_eq!(inspected["suggestedMapping"]["period"], json!("年月"));
        assert!(inspected["suggestedMapping"].get("date").is_none());
    }

    #[test]
    fn 科目复核按人工映射重新提取主体科目组合() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("je.xlsx");
        write_fixture(
            &path,
            &[
                vec!["凭证号", "科目编码", "核算组织", "金额", "日期"],
                vec![
                    "1",
                    "160104",
                    "浙江沪杭甬高速公路股份有限公司",
                    "100",
                    "2025-12-31",
                ],
                vec![
                    "1",
                    "1001",
                    "浙江沪杭甬高速公路股份有限公司",
                    "-100",
                    "2025-12-31",
                ],
            ],
        );
        let inspected = inspect(
            &json!({
                "source": {"inputPath": path.to_string_lossy()},
                "mapping": {
                    "id": ["凭证号"],
                    "accountCode": "科目编码",
                    "entity": "核算组织",
                    "functionalAmount": "金额",
                    "date": ["日期"]
                }
            }),
            "je",
        )
        .unwrap();
        assert_eq!(inspected["suggestedMapping"]["entity"], "核算组织");
        assert!(
            inspected["entityAccounts"]
                .as_array()
                .unwrap()
                .iter()
                .any(|pair| {
                    pair["entity"] == "浙江沪杭甬高速公路股份有限公司"
                        && pair["account"] == "160104"
                })
        );
    }

    #[test]
    fn 存款主体归集按账表侧别应用且未选主体不变() {
        let params = json!({"entityScope": {
            "mode": "aggregate",
            "mappings": [{"side":"tb", "source":"母公司杭州管理处", "target":"母公司"}]
        }});
        assert_eq!(
            scoped_entity(
                "母公司杭州管理处",
                true,
                ledger_mapping::EntitySide::Tb,
                &entity_scope(&params),
            ),
            "母公司"
        );
        assert_eq!(
            scoped_entity(
                "母公司宁波管理处",
                true,
                ledger_mapping::EntitySide::Tb,
                &entity_scope(&params)
            ),
            "母公司宁波管理处"
        );
        assert_eq!(
            scoped_entity(
                "母公司杭州管理处",
                true,
                ledger_mapping::EntitySide::Je,
                &entity_scope(&params)
            ),
            "母公司杭州管理处"
        );
    }

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
    fn tjepbc_tb_role_rules() {
        // 6051 是「其他业务收入」：整级 6051 下挂的材料销售、水费与手续费
        // 不是存款利息的勾稽基准（02/06 号 TBJEPBC 样例）。
        assert_eq!(
            suggest_account_role("6051050000 其他业务收入-材料销售"),
            "excluded"
        );
        assert_eq!(
            suggest_account_role("6051080000 其他业务收入-水"),
            "excluded"
        );
        assert_eq!(
            suggest_account_role("6051.01 其他业务收入_手续费收入"),
            "excluded"
        );
        // 6051 下的利息明细仍要认（名称带「利息」）。
        assert_eq!(
            suggest_account_role("6051990001 其他业务收入-利息收入"),
            "interest_income"
        );
        // 资产类编码下的资本化利息（08 号样例：在建工程-待摊投资-存款利息收入）
        // 不进勾稽基准。
        assert_eq!(
            suggest_account_role("1604010310 1604010310\\在建工程\\原值\\待摊投资\\存款利息收入"),
            "excluded"
        );
        // 名称恰为「利息」两字（07 号样例 66030002，与手续费/汇兑损益并列在
        // 6603 下）是收入侧科目。
        assert_eq!(suggest_account_role("66030002 利息"), "interest_income");
        // 外币中转户不是可计息存款（05 号样例）。
        assert_eq!(
            suggest_account_role("1002989999 银行存款-外币中转"),
            "excluded"
        );
        // 财务费用下的利息收入照旧。
        assert_eq!(
            suggest_account_role("6603020000 财务费用-利息收入"),
            "interest_income"
        );
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
        for row in result["rows"].as_array().unwrap() {
            if row["status"] != json!("已勾稽") {
                eprintln!("非勾稽行: {}", serde_json::to_string(row).unwrap());
            }
        }

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
        // 全部落活期档（含三个美元户），自动套用 0.05%，所以一定测得出数且没有待填利率。
        // 外币户必须在利率来源中明确提示这是默认值，提醒用户按对账单复核。
        assert_eq!(summary["missingRateCount"], json!(0));
        assert_eq!(summary["missingRateTiers"], json!([]));
        assert!(summary["calculatedInterest"].as_f64().unwrap() > 0.0);
        let usd = rows_of(&result, "USD BOA");
        assert_eq!(usd["tier"], "demand");
        assert!(usd["rateResolved"].as_bool().unwrap());
        assert_eq!(usd["annualRate"], json!(0.0005));
        // 来源统一为「挂牌暂估值」，外币默认值的待确认提示交给标记位。
        assert_eq!(usd["rateSource"], json!("挂牌暂估值"));
        assert_eq!(usd["rateProvisional"], json!(true));
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

    /// SAP 余额表同一科目按维度（银行/款项性质）拆多行、序时账按整科目记账、
    /// 且只覆盖其中一家公司：合并后必须整户勾稽；未覆盖主体逐户退回两点法，
    /// 并在汇总里点名（2000&2002 样本的合成回归，金额取自真实数据）。
    #[test]
    fn sap维度拆行按科目合并整户勾稽且未覆盖主体点名() {
        let dir = std::env::temp_dir().join(format!("deposit-sap-fold-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let tb_path = dir.join("tb.xlsx");
        let je_path = dir.join("je.xlsx");
        write_fixture(
            &tb_path,
            &[
                vec![
                    "Company Code",
                    "GL Account",
                    "GL Account Desc.",
                    "Subitem",
                    "Bank",
                    "Currency",
                    "Begin Amt.",
                    "Debit Amount",
                    "Credit Amount",
                    "Closing Balance",
                ],
                // 2002 的中行户：不带银行维度的行 + Bank=BOC 的行，互斥分区，
                // 加总才是科目全量（金额取自真实样本 1002010200）。
                vec![
                    "2002",
                    "1002010200",
                    "Cash in bank-BOC-EUR",
                    "0641",
                    "",
                    "EUR",
                    "771229.55",
                    "40265114.05",
                    "47179803.92",
                    "-6143460.32",
                ],
                vec![
                    "2002",
                    "1002010200",
                    "Cash in bank-BOC-EUR",
                    "0641",
                    "BOC",
                    "EUR",
                    "0",
                    "6584325.21",
                    "0",
                    "6584325.21",
                ],
                // 2002 的 DBS 户：单行小户。
                vec![
                    "2002",
                    "1002010600",
                    "Cash in bank-DBS-U",
                    "5022",
                    "",
                    "EUR",
                    "57.96",
                    "0",
                    "20.57",
                    "37.39",
                ],
                // 2000 的户：序时账整家没有，年内有发生，必须点名并退回两点法。
                vec![
                    "2000",
                    "1002010500",
                    "Cash in bank-DBS-E",
                    "5444",
                    "",
                    "USD",
                    "6484.16",
                    "8241797.2",
                    "10020354.54",
                    "-1772073.18",
                ],
                // 利息收入科目也按维度拆两行（贷方发生额，收入方向）。
                vec![
                    "2002",
                    "6603020100",
                    "Interest income",
                    "",
                    "",
                    "CNY",
                    "0",
                    "0",
                    "248787.96",
                    "-248787.96",
                ],
                vec![
                    "2002",
                    "6603020100",
                    "Interest income",
                    "",
                    "BOC",
                    "CNY",
                    "0",
                    "0",
                    "30441.2",
                    "-30441.2",
                ],
            ],
        );
        write_fixture(
            &je_path,
            &[
                vec![
                    "公司代码",
                    "凭证号码",
                    "过帐日期",
                    "科目号",
                    "公司代码货币金额",
                ],
                vec!["2002", "0100000001", "2025-01-15", "1002010200", "1000000"],
                vec![
                    "2002",
                    "0100000002",
                    "2025-06-15",
                    "1002010200",
                    "-1330364.66",
                ],
                vec!["2002", "0100000003", "2025-03-10", "1002010600", "-20.57"],
                // 干扰行：非货币资金科目，一条都不该归集进测算。
                vec![
                    "2002",
                    "0100000004",
                    "2025-02-10",
                    "6401010000",
                    "-731271.42",
                ],
            ],
        );
        let params = json!({
            "reportStart": "2025-01-01", "reportEnd": "2025-12-31",
            "dayBasis": "month12",
            "tbSource": {"inputPath": tb_path.to_string_lossy()},
            "tbMapping": {
                "entity": "Company Code",
                "accountCode": "GL Account",
                "accountName": "GL Account Desc.",
                "currency": "Currency",
                "auxiliary": "Bank",
                "openingFunctionalAmount": "Begin Amt.",
                "ytdFunctionalDebit": "Debit Amount",
                "ytdFunctionalCredit": "Credit Amount",
                "closingFunctionalAmount": "Closing Balance"
            },
            "jeSource": {"inputPath": je_path.to_string_lossy()},
            "jeMapping": {
                "entity": "公司代码",
                "id": "凭证号码",
                "date": "过帐日期",
                "accountCode": "科目号",
                "functionalAmount": "公司代码货币金额"
            },
            "accountRoles": {
                "6603020100 Interest income": "interest_income"
            }
        });
        let cancel = Arc::new(AtomicBool::new(false));
        let pause = PauseCheckpoint::unpaused(cancel.clone());
        let result = run_job("deposit.preview", params, &|_, _, _, _| {}, cancel, &pause).unwrap();
        let rows = result["rows"].as_array().unwrap();
        assert_eq!(rows.len(), 3, "{result:#?}");

        let row_of = |needle: &str| {
            rows.iter()
                .find(|row| row["account"].as_str().unwrap_or("").contains(needle))
                .unwrap_or_else(|| panic!("找不到科目 {needle}: {result:#?}"))
        };
        // 中行户：两行维度拆分合并成一户，年初/期末加总，与序时账整户勾稽。
        let boc = row_of("1002010200");
        assert_eq!(boc["mergedRows"], json!(2));
        assert!((boc["openingBalance"].as_f64().unwrap() - 771_229.55).abs() < 0.01);
        assert!((boc["tbClosingBalance"].as_f64().unwrap() - 440_864.89).abs() < 0.01);
        assert!((boc["derivedClosingBalance"].as_f64().unwrap() - 440_864.89).abs() < 0.01);
        assert_eq!(boc["status"], "待确认利率");
        assert_eq!(boc["jeReconciled"], true);
        assert!(boc["note"].as_str().unwrap().contains("合并"), "{boc:#?}");
        // DBS 户：单行小户照常勾稽。
        let dbs = row_of("1002010600");
        assert_eq!(dbs["mergedRows"], json!(1));
        assert_eq!(dbs["status"], "待确认利率");
        // 2000 的户：序时账未覆盖，退回两点法，年末仍推到 TB 期末。
        let uncovered = row_of("1002010500");
        assert_eq!(uncovered["status"], "两点法推算");
        assert_eq!(uncovered["jeReconciled"], false);
        assert!(
            uncovered["note"]
                .as_str()
                .unwrap()
                .contains("序时账期间内没有任何行匹配"),
            "{uncovered:#?}"
        );
        assert!(
            (uncovered["derivedClosingBalance"].as_f64().unwrap() - (-1_772_073.18)).abs() < 0.01
        );
        // 覆盖体检：汇总点名 2000，账面利息按科目合并。
        let summary = &result["summary"];
        assert_eq!(summary["jeUncoveredEntities"], json!(["2000"]));
        assert_eq!(summary["jeUncoveredAccountCount"], json!(1));
        assert!(
            summary["monthlySource"]
                .as_str()
                .unwrap()
                .contains("未覆盖")
        );
        assert!((summary["bookedInterestIncome"].as_f64().unwrap() - 279_229.16).abs() < 0.01);
        let booked = result["bookedInterestRows"].as_array().unwrap();
        assert_eq!(booked.len(), 1, "{booked:#?}");
        assert!(booked[0]["note"].as_str().unwrap().contains("2 行合并"));
        let _ = std::fs::remove_dir_all(&dir);
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
        // 裁判权交回公共引擎后，本币「金额」与带符号的「借正贷负」净额列
        // （原公式列，读入即正负值）同为精确别名，内核按净额数据形态择优。
        // 两种取数口径在下方全量勾稽断言里等价，这里不做单一断言。
        let amount_column = je["suggestedMapping"]["functionalAmount"].as_str().unwrap();
        assert!(["金额", "借正贷负"].contains(&amount_column));
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
        let mut je_map = je_map.clone();
        // 该 SAP 导出的编码列叫「会计科目」；这是跨 ERP 歧义标题，
        // Coding 故意留空，此处模拟 LLM／用户确认后再进入业务测算。
        je_map["accountCode"] = json!("会计科目");

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
        // 10 个外币户（USD/HKD）大类兜底为活期，暂按 0.05% 测算并提示复核。
        assert_eq!(summary["missingRateCount"], json!(0));
        assert_eq!(summary["missingRateTiers"], json!([]));
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
    /// 暂按 0.05% 默认值测算，同时明确提示用户核对实际利率。
    #[test]
    fn foreign_currency_falls_back_to_demand_with_default_rate_and_warning() {
        let (tier, reason) = suggest_tier("100332 USD BOC-CPCSC-SH");
        assert_eq!(tier, "demand");
        assert!(reason.contains("USD") && reason.contains("活期"));
        let row = AccountRow {
            account: "100332 USD BOC-CPCSC-SH".into(),
            tier: "demand".into(),
            ..blank_row()
        };
        let resolved = resolve_rate(&row, None, None, None, "");
        assert!(resolved.resolved);
        assert_eq!(resolved.rate, 0.0005);
        // 来源文案已统一：外币户与人民币户同显「挂牌暂估值」，
        // 待确认提示由 provisional 标记承担。
        assert_eq!(resolved.source, "挂牌暂估值");
        assert!(resolved.provisional);
        // 人民币户不受影响，仍自动套活期挂牌。
        let rmb = AccountRow {
            account: "100201 RMB CMB-CPCSC-SH".into(),
            // 一些 SAP 导出的独立币种列是公司默认币种，可能整列写 USD；
            // 账户名上明确的 RMB 必须优先，否则人民币户也会被强制待填利率。
            currency: "USD".into(),
            tier: "demand".into(),
            ..blank_row()
        };
        assert!(resolve_rate(&rmb, None, None, None, "").resolved);
        // 认不出的档位键也回落活期，不再冒出"自定义"。
        assert_eq!(RATE_TIERS[0].key, "demand", "第一档必须是活期，兜底靠它");
        assert_eq!(tier_label("不存在的档位"), "活期存款");
    }

    #[test]
    fn 账户文字中的币种优先于可能是本位币的币种列() {
        assert_eq!(
            account_currency("100485 USD BOA CPCSC Cash", "", "人民币"),
            "USD"
        );
        assert_eq!(account_currency("100201 银行存款", "RMB CMB", "USD"), "CNY");
        assert_eq!(account_currency("100201 银行存款", "", "美元"), "USD");
    }

    #[test]
    fn warns_only_when_je_movements_cannot_be_allocated_by_currency() {
        assert!(currency_allocation_warning(0, 1).is_empty());
        let warned = currency_allocation_warning(12, 1);
        assert!(warned.contains("12 条 JE"), "{warned}");
        assert!(warned.contains("1 个主体科目"), "{warned}");
    }

    /// 09 号样例实案：用友式序时账整本没有「年」列，date 只映射到月份列时
    /// 值是纯月份数字。公共内核按报告期年份还原后，逐月归集必须照常工作，
    /// 而不是全行跳过误报「没有任何行匹配货币资金科目」。
    #[test]
    fn 单列纯月份的序时账按报告期年份逐月还原() {
        let dir = tempfile::tempdir().unwrap();
        let tb_path = dir.path().join("tb.xlsx");
        let je_path = dir.path().join("je.xlsx");
        write_fixture(
            &tb_path,
            &[
                vec!["科目编码", "科目名称", "年初余额借方本位币", "期末余额借方本位币"],
                vec!["10020101", "银行存款_基本户", "1000000", "1200000"],
            ],
        );
        write_fixture(
            &je_path,
            &[
                vec!["年-月", "凭证号", "科目编码", "科目名称", "借方", "贷方"],
                vec!["01", "记-0001", "10020101", "银行存款_基本户", "50000", "0"],
                vec!["02", "记-0002", "10020101", "银行存款_基本户", "0", "30000"],
            ],
        );
        let cancel = Arc::new(AtomicBool::new(false));
        let pause = PauseCheckpoint::unpaused(cancel.clone());
        let result = run_job(
            "deposit.preview",
            json!({
                "reportStart": "2025-01-01", "reportEnd": "2025-06-30",
                "tbSource": {"inputPath": tb_path.to_string_lossy()},
                "tbMapping": {
                    "accountCode": "科目编码", "accountName": "科目名称",
                    "openingFunctionalDebit": "年初余额借方本位币",
                    "closingFunctionalDebit": "期末余额借方本位币"
                },
                "jeSource": {"inputPath": je_path.to_string_lossy()},
                "jeMapping": {
                    "date": "年-月", "id": "凭证号", "accountCode": "科目编码",
                    "accountName": "科目名称",
                    "functionalDebit": "借方", "functionalCredit": "贷方"
                }
            }),
            &|_, _, _, _| {},
            cancel,
            &pause,
        )
        .unwrap();
        let source = result["summary"]["monthlySource"].as_str().unwrap();
        assert!(
            source.contains("序时账逐月还原"),
            "单列纯月份应按报告期年份逐月还原，实际：{source}"
        );
    }

    /// 日期列整体解析不出任何一行时，报错必须点名日期映射，而不是把人
    /// 引去查科目映射的「没有任何行匹配货币资金科目」。
    #[test]
    fn 序时账日期全灭时报日期专属错误() {
        let dir = tempfile::tempdir().unwrap();
        let tb_path = dir.path().join("tb.xlsx");
        let je_path = dir.path().join("je.xlsx");
        write_fixture(
            &tb_path,
            &[
                vec!["科目编码", "科目名称", "年初余额借方本位币", "期末余额借方本位币"],
                vec!["10020101", "银行存款_基本户", "1000000", "1200000"],
            ],
        );
        write_fixture(
            &je_path,
            &[
                vec!["期次", "凭证号", "科目编码", "科目名称", "借方", "贷方"],
                vec!["一季度", "记-0001", "10020101", "银行存款_基本户", "50000", "0"],
                vec!["二季度", "记-0002", "10020101", "银行存款_基本户", "0", "30000"],
            ],
        );
        let cancel = Arc::new(AtomicBool::new(false));
        let pause = PauseCheckpoint::unpaused(cancel.clone());
        let err = run_job(
            "deposit.preview",
            json!({
                "reportStart": "2025-01-01", "reportEnd": "2025-06-30",
                "tbSource": {"inputPath": tb_path.to_string_lossy()},
                "tbMapping": {
                    "accountCode": "科目编码", "accountName": "科目名称",
                    "openingFunctionalDebit": "年初余额借方本位币",
                    "closingFunctionalDebit": "期末余额借方本位币"
                },
                "jeSource": {"inputPath": je_path.to_string_lossy()},
                "jeMapping": {
                    "date": "期次", "id": "凭证号", "accountCode": "科目编码",
                    "accountName": "科目名称",
                    "functionalDebit": "借方", "functionalCredit": "贷方"
                }
            }),
            &|_, _, _, _| {},
            cancel,
            &pause,
        )
        .unwrap_err();
        let text = format!("{err:?}");
        assert!(
            text.contains("NO_JE_DATE") && text.contains("记账日期"),
            "应报日期专属错误，实际：{text}"
        );
    }

    #[test]
    fn 同科目不同币种分别建户填利率且无je币种时不复制发生额() {
        let dir = tempfile::tempdir().unwrap();
        let tb_path = dir.path().join("tb.xlsx");
        let je_path = dir.path().join("je.xlsx");
        write_fixture(
            &tb_path,
            &[
                vec![
                    "科目编码",
                    "科目名称",
                    "币别",
                    "年初余额借方本位币",
                    "期末余额借方本位币",
                ],
                vec![
                    "10020101",
                    "银行存款_自有_活期",
                    "人民币",
                    "1000000",
                    "2000000",
                ],
                vec![
                    "10020101",
                    "银行存款_自有_活期",
                    "美元",
                    "3000000",
                    "4000000",
                ],
            ],
        );
        write_fixture(
            &je_path,
            &[
                vec![
                    "记账日期",
                    "凭证号",
                    "科目编码",
                    "科目名称",
                    "摘要",
                    "币种",
                    "借方",
                    "贷方",
                ],
                vec![
                    "2025-01-15",
                    "记-1",
                    "10020101",
                    "银行存款_自有_活期",
                    "收款",
                    "人民币",
                    "1000000",
                    "0",
                ],
                vec![
                    "2025-01-16",
                    "记-2",
                    "10020101",
                    "银行存款_自有_活期",
                    "收款",
                    "USD",
                    "1000000",
                    "0",
                ],
            ],
        );
        let mut params = json!({
            "reportStart": "2025-01-01", "reportEnd": "2025-12-31",
            "tbSource": {"inputPath": tb_path.to_string_lossy()},
            "tbMapping": {
                "accountCode": "科目编码", "accountName": "科目名称", "currency": "币别",
                "openingFunctionalDebit": "年初余额借方本位币",
                "closingFunctionalDebit": "期末余额借方本位币"
            },
            "jeSource": {"inputPath": je_path.to_string_lossy()},
            "jeMapping": {
                "date": "记账日期", "id": "凭证号", "accountCode": "科目编码",
                "accountName": "科目名称", "summary": "摘要", "currency": "币种",
                "functionalDebit": "借方", "functionalCredit": "贷方"
            }
        });
        let preview = |params: &Value| {
            let cancel = Arc::new(AtomicBool::new(false));
            let pause = PauseCheckpoint::unpaused(cancel.clone());
            run_job(
                "deposit.preview",
                params.clone(),
                &|_, _, _, _| {},
                cancel,
                &pause,
            )
            .unwrap()
        };
        let result = preview(&params);
        let rows = result["rows"].as_array().unwrap();
        assert_eq!(rows.len(), 2, "{result:#?}");
        assert_ne!(rows[0]["key"], rows[1]["key"]);
        let row_of = |currency: &str| rows.iter().find(|row| row["currency"] == currency).unwrap();
        assert_eq!(row_of("CNY")["tbClosingBalance"], json!(2_000_000.0));
        assert_eq!(row_of("USD")["tbClosingBalance"], json!(4_000_000.0));
        assert_eq!(row_of("CNY")["jeReconciled"], true);
        assert_eq!(row_of("USD")["jeReconciled"], true);
        let overrides = json!({
            row_of("CNY")["key"].as_str().unwrap(): {"annualRate": 0.005},
            row_of("USD")["key"].as_str().unwrap(): {"annualRate": 0.02}
        });
        params["rateOverrides"] = overrides;
        let rated = preview(&params);
        let rated_rows = rated["rows"].as_array().unwrap();
        let cny = rated_rows
            .iter()
            .find(|row| row["currency"] == "CNY")
            .unwrap();
        let usd = rated_rows
            .iter()
            .find(|row| row["currency"] == "USD")
            .unwrap();
        assert_eq!(cny["annualRate"], json!(0.005));
        assert_eq!(usd["annualRate"], json!(0.02));
        assert!(
            usd["calculatedInterest"].as_f64().unwrap()
                > cny["calculatedInterest"].as_f64().unwrap()
        );

        params["jeMapping"]
            .as_object_mut()
            .unwrap()
            .remove("currency");
        let without_currency = preview(&params);
        for row in without_currency["rows"].as_array().unwrap() {
            assert_eq!(row["jeReconciled"], false, "{row:#?}");
            assert_eq!(row["status"], "两点法推算", "{row:#?}");
        }
        assert!(
            without_currency["summary"]["jeCurrencyAllocationWarning"]
                .as_str()
                .unwrap()
                .contains("不能分配")
        );

        params["currencyFallbackMode"] = json!("functional");
        let functional = preview(&params);
        assert_eq!(
            functional["rows"].as_array().unwrap().len(),
            1,
            "{functional:#?}"
        );
        assert_eq!(functional["rows"][0]["currency"], "本位币合并");
        assert_eq!(
            functional["rows"][0]["tbClosingBalance"],
            json!(6_000_000.0)
        );
        assert_eq!(functional["summary"]["currencyFallbackMode"], "functional");

        params["currencyFallbackMode"] = json!("twoPointByCurrency");
        let two_point = preview(&params);
        assert_eq!(
            two_point["rows"].as_array().unwrap().len(),
            2,
            "{two_point:#?}"
        );
        assert!(
            two_point["rows"]
                .as_array()
                .unwrap()
                .iter()
                .all(|row| { row["status"] == "两点法推算" && row["jeReconciled"] == false })
        );
        assert_eq!(
            two_point["summary"]["currencyFallbackMode"],
            "twoPointByCurrency"
        );
    }

    #[test]
    fn je零发生额账户按零推导并确认与tb勾稽() {
        let dir = tempfile::tempdir().unwrap();
        let tb_path = dir.path().join("tb.xlsx");
        let je_path = dir.path().join("je.xlsx");
        write_fixture(
            &tb_path,
            &[
                vec!["科目编码", "科目名称", "年初余额借方", "期末余额借方"],
                vec!["100201", "银行存款-休眠户", "42360000", "42360000"],
                vec!["100202", "银行存款-有发生户", "100", "150"],
            ],
        );
        write_fixture(
            &je_path,
            &[
                vec!["记账日期", "凭证号", "科目编码", "科目名称", "借方", "贷方"],
                vec![
                    "2025-06-01",
                    "记-1",
                    "100202",
                    "银行存款-有发生户",
                    "50",
                    "0",
                ],
            ],
        );
        let params = json!({
            "reportStart": "2025-01-01", "reportEnd": "2025-12-31",
            "tbSource": {"inputPath": tb_path.to_string_lossy()},
            "tbMapping": {
                "accountCode": "科目编码", "accountName": "科目名称",
                "openingFunctionalDebit": "年初余额借方",
                "closingFunctionalDebit": "期末余额借方"
            },
            "jeSource": {"inputPath": je_path.to_string_lossy()},
            "jeMapping": {
                "date": "记账日期", "id": "凭证号", "accountCode": "科目编码",
                "accountName": "科目名称", "functionalDebit": "借方",
                "functionalCredit": "贷方"
            }
        });
        let cancel = Arc::new(AtomicBool::new(false));
        let pause = PauseCheckpoint::unpaused(cancel.clone());
        let result = run_job("deposit.preview", params, &|_, _, _, _| {}, cancel, &pause).unwrap();
        let dormant = result["rows"]
            .as_array()
            .unwrap()
            .iter()
            .find(|row| row["account"].as_str().unwrap_or("").contains("休眠户"))
            .unwrap();
        assert_eq!(dormant["jeReconciled"], true, "{dormant:#?}");
        assert_eq!(dormant["derivedClosingBalance"], json!(42_360_000.0));
        assert_eq!(dormant["reconciliationDiff"], json!(0.0));
        assert!(
            !dormant["note"]
                .as_str()
                .unwrap_or("")
                .contains("没有任何行匹配"),
            "JE 零发生额不能再被描述成未执行勾稽: {dormant:#?}"
        );
    }

    /// 用户验收样例：存在即跑，不把本机 Downloads 文件变成常规测试依赖。
    #[test]
    #[ignore = "依赖用户提供的陇能建设真实 Excel"]
    fn 陇能建设利息收入方向与零发生额账户() {
        let Some(home) = std::env::var_os("USERPROFILE") else {
            return;
        };
        let base = PathBuf::from(home).join("Downloads/TBJE黄金测试/1_原始件/02_测试集");
        let tb_path = base.join("03-陇能建设_TB科目余额表.xlsx");
        let je_path = base.join("03-陇能建设_JE序时账.xlsx");
        if !tb_path.exists() || !je_path.exists() {
            return;
        }
        let tb = inspect(&json!({"source": {"inputPath": tb_path}}), "tb").unwrap();
        let je = inspect(&json!({"source": {"inputPath": je_path}}), "je").unwrap();
        let params = json!({
            "reportStart": "2025-01-01", "reportEnd": "2025-12-31",
            "tbSource": {"inputPath": tb_path}, "tbMapping": tb["suggestedMapping"],
            "jeSource": {"inputPath": je_path}, "jeMapping": je["suggestedMapping"],
            "accountRoles": tb["suggestedAccountRoles"],
            "accountRoleOverrides": {"660302 财务费用-利息收入": "interest_income"}
        });
        let cancel = Arc::new(AtomicBool::new(false));
        let pause = PauseCheckpoint::unpaused(cancel.clone());
        let result = run_job("deposit.preview", params, &|_, _, _, _| {}, cancel, &pause).unwrap();
        assert!(
            (result["summary"]["bookedInterestIncome"].as_f64().unwrap() - 15_286_550.0).abs()
                < 0.01,
            "陇能建设利息收入不应翻成负数: {}",
            result["summary"]
        );
        for code in ["100202", "100206"] {
            let row = result["rows"]
                .as_array()
                .unwrap()
                .iter()
                .find(|row| row["account"].as_str().unwrap_or("").contains(code))
                .unwrap_or_else(|| panic!("找不到陇能建设账户 {code}: {result:#?}"));
            assert_eq!(row["jeReconciled"], true, "{row:#?}");
            assert!(row["reconciliationDiff"].as_f64().unwrap().abs() < 0.01);
        }
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
        // 活期的内置默认：来源统一为「挂牌暂估值」，且必须标记待确认。
        let resolved = resolve_rate(&row, None, None, None, "");
        assert_eq!(
            (resolved.rate, resolved.source.as_str()),
            (0.0005, "挂牌暂估值")
        );
        assert!(resolved.provisional);
        // 档位级改写盖过内置默认：属于用户改写，不再是待确认的暂估。
        let resolved = resolve_rate(&row, None, None, custom, "");
        assert_eq!(
            (resolved.rate, resolved.source.as_str()),
            (0.002, "自定义档位利率")
        );
        assert!(!resolved.provisional);
        // 账户级改写优先于档位级；百分数写法自动归一
        let overrides = json!({"K": {"annualRate": 1.25}});
        let resolved = resolve_rate(&row, overrides.as_object(), None, custom, "");
        assert_eq!(
            (resolved.rate, resolved.source.as_str()),
            (0.0125, "本账户手工指定")
        );
        assert!(!resolved.provisional);
        // 切到定期档后自动带出该档挂牌暂估值
        let overrides = json!({"K": {"tier": "term_3y"}});
        let resolved = resolve_rate(&row, overrides.as_object(), None, None, "");
        assert_eq!(resolved.tier, "term_3y");
        assert!(resolved.resolved);
        assert!(resolved.provisional);
        assert!((resolved.rate - 0.0125).abs() < 1e-12);
        // 档位级填了就能用
        let tier_rates = json!({"term_3y": 1.35});
        let resolved = resolve_rate(&row, overrides.as_object(), None, tier_rates.as_object(), "");
        assert!(resolved.resolved);
        assert!(!resolved.provisional);
        assert!((resolved.rate - 0.0135).abs() < 1e-12);
    }

    #[test]
    fn confirmation_table_rate_overrides_match_detail_key_then_account() {
        let row = AccountRow {
            key: "默认主体 | 1002 银行存款 | 工行 | CNY".into(),
            account: "1002 银行存款".into(),
            tier: "demand".into(),
            ..blank_row()
        };
        // 辅助明细键（第二步展开行写入的键空间）优先命中。
        let rates = json!({"默认主体\u{1f}1002 银行存款\u{1f}工行": 0.0031});
        let resolved = resolve_rate(
            &row,
            None,
            rates.as_object(),
            None,
            "默认主体\u{1f}1002 银行存款\u{1f}工行",
        );
        assert_eq!(resolved.rate, 0.0031);
        assert!(!resolved.provisional);
        // 没有明细键时按科目全文回退；全文对不上再按科目编码回退
        // （TB/JE 拼法差异，与存款类型覆盖同一口径）。
        let rates = json!({"1002 银行存款": 0.0042});
        let resolved = resolve_rate(&row, None, rates.as_object(), None, "别的明细键");
        assert_eq!(resolved.rate, 0.0042);
        let rates = json!({"1002 银行存款-人民币户": 0.0053});
        let resolved = resolve_rate(&row, None, rates.as_object(), None, "别的明细键");
        assert_eq!(resolved.rate, 0.0053);
        // 表里没写就回落内置挂牌暂估。
        let resolved = resolve_rate(&row, None, None, None, "别的明细键");
        assert_eq!(resolved.rate, 0.0005);
        assert!(resolved.provisional);
    }

    fn blank_row() -> AccountRow {
        AccountRow {
            key: String::new(),
            merged_rows: 1,
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
            rate_provisional: false,
            rate_warning: String::new(),
            opening_balance: 0.0,
            opening_from_tb: true,
            tb_closing_balance: 0.0,
            derived_closing_balance: 0.0,
            je_reconciled: false,
            reconciliation_diff: 0.0,
            average_balance: 0.0,
            calculated_interest: 0.0,
            months: vec![],
            two_point: false,
            status: String::new(),
            note: String::new(),
        }
    }

    #[test]
    fn standard_listed_tiers_get_provisional_rates() {
        // 有挂牌值的标准档位都自动带出暂估值。
        assert_eq!(auto_rate("demand"), Some(0.0005));
        assert_eq!(auto_rate("agreement"), Some(0.0020));
        assert_eq!(auto_rate("notice_7d"), Some(0.0055));
        assert_eq!(auto_rate("term_1y"), Some(0.0095));
        assert_eq!(auto_rate("term_3y"), Some(0.0125));
        assert_eq!(auto_rate("cd_1y"), Some(0.0110));
        assert_eq!(auto_rate("custom"), None);
        assert_eq!(tier_rate("term_3y"), Some(0.0125));
        assert_eq!(tier_rate("custom"), None);
    }

    #[test]
    fn rate_source_distinguishes_account_tier_and_listed_values() {
        let row = AccountRow {
            key: "K".into(),
            account: "100201 银行存款".into(),
            tier: "demand".into(),
            ..blank_row()
        };
        let account_override = serde_json::from_value::<Map<String, Value>>(json!({
            "100201 银行存款": 0.013
        })).unwrap();
        let resolved = resolve_rate(&row, None, Some(&account_override), None, "");
        assert_eq!(resolved.source, "科目确认表手工指定");
        assert!(!resolved.provisional);

        let tier_override = serde_json::from_value::<Map<String, Value>>(json!({
            "demand": 0.002
        })).unwrap();
        let resolved = resolve_rate(&row, None, None, Some(&tier_override), "");
        assert_eq!(resolved.source, "自定义档位利率");
        assert!(!resolved.provisional);

        let resolved = resolve_rate(&row, None, None, None, "");
        assert_eq!(resolved.source, "挂牌暂估值");
        assert!(resolved.provisional);
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
        let resolved = resolve_rate(&row, None, None, None, "");
        assert!(resolved.resolved);
        assert_eq!(resolved.rate, 0.0125);
        assert_eq!(resolved.source, "挂牌暂估值");
        assert!(resolved.provisional);
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
        // 两点法不拟造月末余额；导出公式直接引用年初、年末。
        let opening = 1_200_000.0;
        let closing = 2_400_000.0;
        let mut row = blank_row();
        row.opening_balance = opening;
        row.tb_closing_balance = closing;
        row.average_balance = (opening + closing) / 2.0;
        row.two_point = true;
        row.months.push(MonthCell {
            month: 1,
            opening,
            debit: 0.0,
            credit: 0.0,
            closing,
            average: row.average_balance,
            days: 1.0,
            denominator: 12.0,
            interest: 0.0,
        });
        let path =
            std::env::temp_dir().join(format!("deposit-two-point-{}.xlsx", std::process::id()));
        let mut book = Workbook::new();
        write_summary(book.add_worksheet(), &[row.clone()], &[(2, 2)]).unwrap();
        write_monthly(book.add_worksheet(), &[row], "month12").unwrap();
        book.save(&path).unwrap();
        let mut saved = calamine::open_workbook_auto(&path).unwrap();
        let cells = calamine::Reader::worksheet_range(&mut saved, MONTHLY_SHEET).unwrap();
        let formulas = calamine::Reader::worksheet_formula(&mut saved, MONTHLY_SHEET).unwrap();
        for column in 6..=9 {
            assert!(
                cells
                    .get((1, column))
                    .is_none_or(|cell| matches!(cell, calamine::Data::Empty))
            );
        }
        assert!(
            formulas
                .rows()
                .flatten()
                .any(|formula| formula == "('测算汇总'!H2+'测算汇总'!I2)/2"),
            "两点法平均余额必须直接引用年度期初和期末"
        );
        std::fs::remove_file(path).unwrap();
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

    /// 年末已结转的损益科目（用友等账套）：结转分录使借贷发生额同额、
    /// 期末余额为 0，发生净额恒为 0。用户实测：科目分类里已人工指定
    /// 「利息收入（勾稽基准）」，基准数仍显示 0——净额口径在这种形态下
    /// 必须退到发生全额，否则勾稽差异整体失真。且费用类科目下的红字对
    /// ＝冲减费用＝收入，取正数计入（真实用户文件实测 923,800.50）。
    #[test]
    fn closed_pl_occurrence_uses_gross_credit_as_baseline() {
        let dir = std::env::temp_dir().join(format!("deposit-closed-pl-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let tb_path = dir.join("tb.xlsx");
        write_fixture(
            &tb_path,
            &[
                vec![
                    "科目编码",
                    "科目名称",
                    "期初余额借方",
                    "期初余额贷方",
                    "本期发生借方",
                    "本期发生贷方",
                    "期末余额借方",
                    "期末余额贷方",
                ],
                vec![
                    "1002",
                    "银行存款",
                    "1200000",
                    "0",
                    "1200000",
                    "0",
                    "2400000",
                    "0",
                ],
                // 汇总行：登记方向推断靠它把「66030002 利息」认成费用方向。
                vec!["6603", "财务费用", "0", "0", "0", "0", "0", "0"],
                // 用友形态：利息收入以红字借方冲减费用，结转对应红字贷方，
                // 借贷两列同额同负。
                vec![
                    "66030002",
                    "利息",
                    "0",
                    "0",
                    "-923800.50",
                    "-923800.50",
                    "0",
                    "0",
                ],
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
            "accountRoles": tb["suggestedAccountRoles"],
            "accountRoleOverrides": {"66030002 利息": "interest_income"}
        });
        let cancel = Arc::new(AtomicBool::new(false));
        let pause = PauseCheckpoint::unpaused(cancel.clone());
        let result = run_job("deposit.preview", params, &|_, _, _, _| {}, cancel, &pause).unwrap();
        let summary = &result["summary"];
        assert!(summary["hasInterestIncomeAccount"].as_bool().unwrap());
        assert!(
            (summary["bookedInterestIncome"].as_f64().unwrap() - 923_800.50).abs() < 0.01,
            "费用类科目下的红字对是冲减费用的利息收入，应按正数计入: {summary}"
        );
        assert!(
            !summary["bookedNote"]
                .as_str()
                .unwrap_or("")
                .contains("净利息支出"),
            "红字收入不是净支出，不应出负数提示: {summary}"
        );
        let rows = result["bookedInterestRows"].as_array().unwrap();
        assert_eq!(rows.len(), 1, "汇总行不进基准: {rows:?}");
        assert!(
            rows[0]["note"].as_str().unwrap_or("").contains("红字"),
            "口径说明应写明红字: {rows:?}"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 同一张已结转的表，费用性科目（手续费）被选成利息收入基准时，
    /// 正常对（借贷同正）表示活动在借方——这不是利息收入而是费用，
    /// 必须按负数计入基准，否则一笔费用被冒充成收入。
    #[test]
    fn closed_expense_baseline_counts_negative() {
        let dir = std::env::temp_dir().join(format!("deposit-closed-fee-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let tb_path = dir.join("tb.xlsx");
        write_fixture(
            &tb_path,
            &[
                vec![
                    "科目编码",
                    "科目名称",
                    "期初余额借方",
                    "期初余额贷方",
                    "本期发生借方",
                    "本期发生贷方",
                    "期末余额借方",
                    "期末余额贷方",
                ],
                vec![
                    "1002",
                    "银行存款",
                    "1200000",
                    "0",
                    "1200000",
                    "0",
                    "2400000",
                    "0",
                ],
                vec!["6603", "财务费用", "0", "0", "0", "0", "0", "0"],
                vec![
                    "66030001",
                    "手续费",
                    "0",
                    "0",
                    "4429.49",
                    "4429.49",
                    "0",
                    "0",
                ],
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
            "accountRoles": tb["suggestedAccountRoles"],
            "accountRoleOverrides": {"66030001 手续费": "interest_income"}
        });
        let cancel = Arc::new(AtomicBool::new(false));
        let pause = PauseCheckpoint::unpaused(cancel.clone());
        let result = run_job("deposit.preview", params, &|_, _, _, _| {}, cancel, &pause).unwrap();
        let summary = &result["summary"];
        assert!(
            (summary["bookedInterestIncome"].as_f64().unwrap() + 4_429.49).abs() < 0.01,
            "费用性质科目应按负数冲减基准: {summary}"
        );
        assert!(
            summary["bookedNote"]
                .as_str()
                .unwrap_or("")
                .contains("净利息支出"),
            "合计为负时应提示净利息支出: {summary}"
        );
        let rows = result["bookedInterestRows"].as_array().unwrap();
        assert!(
            rows[0]["note"].as_str().unwrap_or("").contains("费用"),
            "口径说明应写明费用性质: {rows:?}"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 独立收入类科目（6051 其他业务收入）的已结转正常对：活动在贷方，
    /// 按正数计入。名称自身的「收入」关键词足以定方向，不依赖父行。
    #[test]
    fn closed_revenue_baseline_stays_positive() {
        let dir = std::env::temp_dir().join(format!("deposit-closed-rev-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let tb_path = dir.join("tb.xlsx");
        write_fixture(
            &tb_path,
            &[
                vec![
                    "科目编码",
                    "科目名称",
                    "期初余额借方",
                    "期初余额贷方",
                    "本期发生借方",
                    "本期发生贷方",
                    "期末余额借方",
                    "期末余额贷方",
                ],
                vec![
                    "1002",
                    "银行存款",
                    "1200000",
                    "0",
                    "1200000",
                    "0",
                    "2400000",
                    "0",
                ],
                vec![
                    "6051",
                    "其他业务收入",
                    "0",
                    "0",
                    "16534.97",
                    "16534.97",
                    "0",
                    "0",
                ],
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
            "accountRoles": tb["suggestedAccountRoles"],
            "accountRoleOverrides": {"6051 其他业务收入": "interest_income"}
        });
        let cancel = Arc::new(AtomicBool::new(false));
        let pause = PauseCheckpoint::unpaused(cancel.clone());
        let result = run_job("deposit.preview", params, &|_, _, _, _| {}, cancel, &pause).unwrap();
        let summary = &result["summary"];
        assert!(
            (summary["bookedInterestIncome"].as_f64().unwrap() - 16_534.97).abs() < 0.01,
            "收入类科目的正常对应按贷方全额计入: {summary}"
        );
        assert!(
            result["bookedInterestRows"][0]["note"]
                .as_str()
                .unwrap_or("")
                .contains("贷方全额"),
            "口径说明应写明贷方全额: {}",
            result["bookedInterestRows"]
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 方向推断与已结转取数的单元口径。Signed 表（贷方列借正贷负）的
    /// 已结转行借贷列互为相反数，旧逻辑不分口径算 `贷－借` 会得到 2 倍
    /// 金额——这是必须守住的双倍计入防线。
    #[test]
    fn direction_inference_and_signed_closed_pair() {
        use std::collections::BTreeMap;
        let mut tb_accounts = BTreeMap::new();
        tb_accounts.insert("6603".to_string(), "财务费用".to_string());
        // 财务费用下的利息收入仍在借方登记；负数借方是红字
        // 冲减费用，后续换算为经济上的贷方发生。
        assert_eq!(
            registered_direction("66030002 财务费用-利息收入", &tb_accounts),
            AccountDirection::Debit
        );
        // 自身名称无关键词时走上级科目。
        assert_eq!(
            registered_direction("66030002 利息", &tb_accounts),
            AccountDirection::Debit
        );
        // 分段编码（10 号 PBC 样例形态）也必须查得到上级：6603.02 自身
        // 名称只有「收入」，费用属性在上级 6603 财务费用身上——此前祖先
        // 查询只认纯数字编码，把它判成贷方收入，红字方向随之整组判反。
        assert_eq!(
            registered_direction("6603.02 利息收入", &tb_accounts),
            AccountDirection::Debit
        );
        assert_eq!(
            registered_direction("6603-02 利息收入", &tb_accounts),
            AccountDirection::Debit
        );
        // 独立收入科目按贷方向。
        assert_eq!(
            registered_direction("6051 其他业务收入", &BTreeMap::new()),
            AccountDirection::Credit
        );
        // 无任何线索时保持未知，交给默认口径＋复核提示。
        assert_eq!(
            registered_direction("66030002 利息", &BTreeMap::new()),
            AccountDirection::Unknown
        );
        assert_eq!(
            registered_direction("66030001 手续费", &BTreeMap::new()),
            AccountDirection::Debit
        );

        // Unsigned 红字对（用户文件形态）：费用方向 → 收入正数。
        assert_eq!(
            closed_pair_baseline(
                ledger_mapping::SignConvention::Unsigned,
                AccountDirection::Debit,
                -923_800.50,
                -923_800.50,
                false,
            )
            .0,
            923_800.50
        );
        // Unsigned 正常对：费用方向 → 负数（费用冲减基准）。
        assert_eq!(
            closed_pair_baseline(
                ledger_mapping::SignConvention::Unsigned,
                AccountDirection::Debit,
                4_429.49,
                4_429.49,
                false,
            )
            .0,
            -4_429.49
        );
        // Signed 已结转行（贷方列已是负数）：按单一金额计入，绝不双倍。
        assert_eq!(
            closed_pair_baseline(
                ledger_mapping::SignConvention::Signed,
                AccountDirection::Credit,
                -900.0,
                900.0,
                false,
            )
            .0,
            900.0
        );
        assert_eq!(
            closed_pair_baseline(
                ledger_mapping::SignConvention::Signed,
                AccountDirection::Debit,
                -900.0,
                900.0,
                false,
            )
            .0,
            -900.0
        );
        // 方向未知：尊重科目分类里「利息收入」的指定，按正数计入并提示复核。
        let (amount, note) = closed_pair_baseline(
            ledger_mapping::SignConvention::Unsigned,
            AccountDirection::Unknown,
            -500.0,
            -500.0,
            false,
        );
        assert_eq!(amount, 500.0);
        assert!(note.contains("复核"));
    }

    #[test]
    fn 财务费用下的利息收入按红字借方判定贷方发生() {
        let mut tb_accounts = BTreeMap::new();
        tb_accounts.insert("6603".into(), "财务费用".into());
        assert_eq!(
            registered_direction("66030002 财务费用-利息收入", &tb_accounts),
            AccountDirection::Debit,
        );
        let (amount, note) = closed_pair_baseline(
            ledger_mapping::SignConvention::Unsigned,
            AccountDirection::Debit,
            -72_868.20,
            -72_868.20,
            true,
        );
        assert_eq!(amount, 72_868.20);
        assert!(note.contains("红字冲减费用"));

        // 陇能建设形态：660302「财务费用-利息收入」本年借贷同为正数，
        // 贷方是收入发生、借方是期末结转；上级费用属性不能把收入翻成负数。
        let (amount, note) = closed_pair_baseline(
            ledger_mapping::SignConvention::Unsigned,
            AccountDirection::Debit,
            15_286_550.0,
            15_286_550.0,
            true,
        );
        assert_eq!(amount, 15_286_550.0);
        assert!(note.contains("利息收入"));
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

    #[test]
    fn 存款inspect保留歧义科目给llm并自动识别摘要() {
        let dir = std::env::temp_dir().join(format!("deposit-sap-je-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("je.xlsx");
        write_fixture(
            &path,
            &[
                vec![
                    "凭证编号",
                    "凭证日期",
                    "文本",
                    "成本中心",
                    "本币金额",
                    "会计科目",
                    "总账科目",
                ],
                vec![
                    "1",
                    "2025-01-01",
                    "发放工资",
                    "CC01",
                    "100",
                    "库存现金-人民币",
                    "1001010000",
                ],
                vec![
                    "2",
                    "2025-01-02",
                    "支付货款",
                    "CC02",
                    "200",
                    "银行存款-人民币",
                    "1002101001",
                ],
                vec![
                    "3",
                    "2025-01-03",
                    "计提利息",
                    "CC03",
                    "300",
                    "财务费用-利息支出",
                    "6603010000",
                ],
                vec![
                    "4",
                    "2025-01-04",
                    "收到回款",
                    "CC04",
                    "400",
                    "应收账款-客户",
                    "1122010000",
                ],
            ],
        );
        let inspected = inspect(
            &json!({"source": {"inputPath": path.to_string_lossy()}}),
            "je",
        )
        .unwrap();
        let mapping = &inspected["suggestedMapping"];
        // 两可表头不再留白：按数据形态冷启动定性（编码→accountCode、
        // 名称文本→accountName），摘要与辅助核算断言保持不变。
        assert_eq!(mapping["accountCode"], json!("总账科目"), "{mapping:#?}");
        assert_eq!(mapping["accountName"], json!(["会计科目"]), "{mapping:#?}");
        assert_eq!(mapping["summary"], json!("文本"));
        assert_eq!(mapping["auxiliary"], json!(["成本中心"]));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn inspect下发末级科目清单且兼容分段编码() {
        let dir = std::env::temp_dir().join(format!("deposit-leaf-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("tb.xlsx");
        write_fixture(
            &path,
            &[
                vec!["科目编码", "科目名称", "期初余额", "期末余额"],
                vec!["1002", "银行存款", "100", "120"],
                vec!["1101", "交易性金融资产", "0", "0"],
                vec!["1101.01", "银行理财产品", "10", "10"],
                vec!["6603", "财务费用", "0", "0"],
                vec!["6603.02", "利息收入", "-72", "-72"],
            ],
        );
        let inspected = inspect(
            &json!({"source": {"inputPath": path.to_string_lossy()}}),
            "tb",
        )
        .unwrap();
        let names = |list: &serde_json::Value| {
            list.as_array()
                .unwrap()
                .iter()
                .filter_map(|value| value.as_str().map(str::to_owned))
                .collect::<Vec<String>>()
        };
        let accounts = names(&inspected["accounts"]);
        let leaf = names(&inspected["accountsLeaf"]);
        // 全量清单父子都在（FA 等页面继续用）；末级清单只留真正记账的行——
        // 分段编码 1101.01/6603.02 的父子关系由公共引擎的目录末级掩码判定。
        assert!(
            accounts.iter().any(|name| name == "1101 交易性金融资产"),
            "全量清单应包含父级：{accounts:?}"
        );
        assert!(leaf.iter().any(|name| name == "1002 银行存款"), "{leaf:?}");
        assert!(
            leaf.iter().any(|name| name == "1101.01 银行理财产品"),
            "{leaf:?}"
        );
        assert!(
            leaf.iter().any(|name| name == "6603.02 利息收入"),
            "{leaf:?}"
        );
        assert!(
            !leaf
                .iter()
                .any(|name| name.starts_with("1101 ") || name.starts_with("6603 ")),
            "父级汇总行不得混进末级清单：{leaf:?}"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    #[ignore = "依赖本机样例目录，用 LEDGER_SAMPLES=<TBJEPBC路径> 显式运行"]
    fn 存款inspect真实03序时账映射() {
        let root = std::env::var_os("LEDGER_SAMPLES")
            .map(PathBuf::from)
            .filter(|path| path.is_dir())
            .expect("请设置 LEDGER_SAMPLES");
        let inspected = inspect(
            &json!({"source": {
                "inputPath": root.join("03序时账 (2).xlsx"),
                "sheet": "", "headerRow": 0, "headerDepth": 0
            }}),
            "je",
        )
        .unwrap();
        let mapping = &inspected["suggestedMapping"];
        // 真实 03 号样例：总帐科目（帐/账混写）装数字编码，冷启动归 accountCode。
        assert_eq!(mapping["accountCode"], json!("总帐科目"), "{mapping:#?}");
        assert_eq!(mapping["summary"], json!("文本"));
        assert_eq!(mapping["auxiliary"], json!(["成本中心"]));
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

    #[test]
    fn 小型csv强制磁盘月度聚合与内存路径等价() {
        let dir = std::env::temp_dir().join(format!(
            "deposit-disk-equivalence-{}-{}",
            std::process::id(),
            Local::now().timestamp_nanos_opt().unwrap_or_default()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("je.csv");
        std::fs::write(
            &path,
            concat!(
                "记账日期,凭证号,核算主体,科目编码,科目名称,辅助核算,摘要,借方金额,贷方金额\n",
                "2025-01-15,记-1,公司A,1002,银行存款,工行,收款,100,0\n",
                ",,,6001,主营业务收入,,收款,0,100\n",
                "2025-01-20,记-2,公司A,1002,银行存款,工行,付款,0,30\n",
                ",,,6603,财务费用,,付款,30,0\n",
                "2025-02-01,记-3,公司A,1002,银行存款,工行,收款,25,0\n",
                ",,,6001,主营业务收入,,收款,0,25\n",
                "2025-01-25,记-4,公司B,1002,银行存款,工行,收款,400,50\n"
            ),
        )
        .unwrap();
        let mapping = json!({
            "date": "记账日期",
            "id": "凭证号",
            "entity": "核算主体",
            "accountCode": "科目编码",
            "accountName": ["科目名称"],
            "auxiliary": "辅助核算",
            "summary": "摘要",
            "functionalDebit": "借方金额",
            "functionalCredit": "贷方金额"
        });
        let params = json!({
            "jeSource": {"inputPath": path.to_string_lossy(), "headerRow": 1},
            "jeMapping": mapping
        });
        let mut account = blank_row();
        account.entity = "公司A".into();
        account.account = "1002 银行存款".into();
        account.auxiliary = "工行".into();
        account.key = account_key(&account.entity, &account.account, &account.auxiliary);
        let mut other = account.clone();
        other.entity = "公司B".into();
        other.key = account_key(&other.entity, &other.account, &other.auxiliary);
        let accounts = vec![account, other];
        let start = NaiveDate::from_ymd_opt(2025, 1, 1).unwrap();
        let end = NaiveDate::from_ymd_opt(2025, 12, 31).unwrap();
        let cancel = Arc::new(AtomicBool::new(false));
        let pause = PauseCheckpoint::unpaused(cancel.clone());
        let memory_input = open_je_input(&params, &cancel, &|_, _, _, _| {}, 3)
            .unwrap()
            .expect("小文件应走内存路径");
        let tb_sides = accounts
            .iter()
            .map(|account| {
                (
                    account.entity.clone(),
                    ledger_mapping::account_code_of(&account.account),
                    ledger_mapping::account_name_of(&account.account),
                )
            })
            .collect::<Vec<_>>();
        let je_sides =
            je_account_identities(&memory_input, true, &entity_scope(&params), &cancel).unwrap();
        let policy = ledger_mapping::AccountMatchPolicy::from_sides(&tb_sides, &je_sides);
        let memory = monthly_movements(
            &memory_input,
            &policy,
            &accounts,
            &DepositAuxiliaryPlan::default(),
            true,
            &entity_scope(&params),
            start,
            end,
            &cancel,
            &pause,
            &|_, _, _, _| {},
            3,
        )
        .unwrap()
        .unwrap();

        // 生产分支仅在动态策略选中大文件时调用；测试直接打开同一小文件，
        // 以低成本锁定磁盘规范化与原内存口径逐项一致。
        let mapping = params["jeMapping"].as_object().unwrap().clone();
        let ledger = crate::tabular::open_prepared_disk_ledger(
            &path,
            1,
            1,
            &mapping,
            &|_, _, _, _| {},
            &cancel,
        )
        .unwrap();
        let disk_input = JeInput::Disk(ledger, mapping);
        let disk = monthly_movements(
            &disk_input,
            &policy,
            &accounts,
            &DepositAuxiliaryPlan::default(),
            true,
            &entity_scope(&params),
            start,
            end,
            &cancel,
            &pause,
            &|_, _, _, _| {},
            3,
        )
        .unwrap()
        .expect("磁盘路径同样应归集到发生额");
        assert_eq!(disk.scheme, memory.scheme, "金额方案说明必须保持一致");
        assert_eq!(disk.evidence, memory.evidence, "金额口径证据必须保持一致");
        let key_a = &accounts[0].key;
        let key_b = &accounts[1].key;
        assert_eq!(disk.series[key_a], memory.series[key_a]);
        assert_eq!(disk.series[key_b], memory.series[key_b]);
        assert_eq!(disk.series[key_a][0], (100.0, 30.0));
        assert_eq!(disk.series[key_a][1], (25.0, 0.0));
        // 当前样例被公共金额判型识别为有符号净额，因此 400-50 归入借方净额；
        // 关键断言是它只进入公司B，不能串到公司A。
        assert_eq!(disk.series[key_b][0], (350.0, 0.0));
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
    fn 辅助明细空白年初按零合并而不是整户倒推() {
        let dir = std::env::temp_dir().join(format!(
            "deposit-opening-blank-detail-{}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let tb_path = dir.join("tb.xlsx");
        let je_path = dir.join("je.xlsx");
        write_fixture(
            &tb_path,
            &[
                vec![
                    "科目编码",
                    "科目名称",
                    "辅助核算",
                    "年初余额借方",
                    "期末余额借方",
                ],
                vec!["100201", "银行存款", "A银行", "100", "120"],
                // 空白表示该辅助明细期初为 0，不表示整户没有年初余额方案。
                vec!["100201", "银行存款", "B银行", "", "50"],
            ],
        );
        write_fixture(
            &je_path,
            &[
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
                    "2025-06-30",
                    "记-1",
                    "100201",
                    "银行存款",
                    "收款",
                    "60",
                    "0",
                ],
            ],
        );
        let params = json!({
            "reportStart": "2025-01-01",
            "reportEnd": "2025-12-31",
            "tbSource": {"inputPath": tb_path.to_string_lossy()},
            "tbMapping": {
                "accountCode": "科目编码",
                "accountName": "科目名称",
                "auxiliary": ["辅助核算"],
                "openingFunctionalDebit": "年初余额借方",
                "closingFunctionalDebit": "期末余额借方"
            },
            "jeSource": {"inputPath": je_path.to_string_lossy()},
            "jeMapping": {
                "date": "记账日期",
                "id": ["凭证号"],
                "accountCode": "科目编码",
                "accountName": ["科目名称"],
                "summary": "摘要",
                "functionalDebit": "借方金额",
                "functionalCredit": "贷方金额"
            }
        });
        let cancel = Arc::new(AtomicBool::new(false));
        let pause = PauseCheckpoint::unpaused(cancel.clone());
        let result = run_job("deposit.preview", params, &|_, _, _, _| {}, cancel, &pause).unwrap();
        let row = &result["rows"][0];
        assert_eq!(row["openingFromTb"], json!(true), "{row:#?}");
        assert_eq!(row["openingBalance"], json!(100.0), "{row:#?}");
        assert_eq!(row["tbClosingBalance"], json!(170.0), "{row:#?}");
        assert_eq!(row["derivedClosingBalance"], json!(160.0), "{row:#?}");
        assert_eq!(row["reconciliationDiff"], json!(-10.0), "{row:#?}");
        assert!(
            !row["note"]
                .as_str()
                .unwrap_or("")
                .contains("TB 未提供年初余额"),
            "{row:#?}"
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

    #[test]
    fn tb_closed_pair_uses_registered_direction_and_red_letter_without_recalculating_je() {
        let dir = std::env::temp_dir().join(format!(
            "deposit-interest-direction-test-{}",
            std::process::id()
        ));
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
                vec!["1002", "银行存款", "1000", "1060", "100", "40"],
                // 独立收入科目正数同额：按贷方登记方向取正。
                vec!["605101", "利息收入-A", "0", "0", "100", "100"],
                vec!["6603", "财务费用", "0", "0", "0", "0"],
                // 1–3 月真实 TB 形态：财务费用下的利息收入借贷同额且都为负，
                // 即红字借方冲减费用，经济上判为贷方发生。
                vec!["660301", "财务费用-利息收入-B", "0", "0", "-40", "-40"],
            ],
        );
        write_fixture(
            &je_path,
            &[
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
                    "2025-06-30",
                    "记-1",
                    "1002",
                    "银行存款",
                    "收到利息",
                    "100",
                    "0",
                ],
                vec![
                    "2025-06-30",
                    "记-1",
                    "605101",
                    "利息收入-A",
                    "收到利息",
                    "0",
                    "100",
                ],
                vec![
                    "2025-12-31",
                    "记-2",
                    "605101",
                    "利息收入-A",
                    "结转损益",
                    "100",
                    "0",
                ],
                vec![
                    "2025-12-31",
                    "记-2",
                    "4103",
                    "本年利润",
                    "结转损益",
                    "0",
                    "100",
                ],
                vec![
                    "2025-07-31",
                    "记-3",
                    "660301",
                    "利息收入-B",
                    "冲减利息",
                    "40",
                    "0",
                ],
                vec![
                    "2025-07-31",
                    "记-3",
                    "1002",
                    "银行存款",
                    "冲减利息",
                    "0",
                    "40",
                ],
                vec![
                    "2025-12-31",
                    "记-4",
                    "4103",
                    "本年利润",
                    "结转损益",
                    "40",
                    "0",
                ],
                vec![
                    "2025-12-31",
                    "记-4",
                    "660301",
                    "利息收入-B",
                    "结转损益",
                    "0",
                    "40",
                ],
            ],
        );
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
            "reportStart": "2025-01-01",
            "reportEnd": "2025-12-31",
            "tbSource": {"inputPath": tb_path.to_string_lossy()},
            "tbMapping": tb["suggestedMapping"],
            "jeSource": {"inputPath": je_path.to_string_lossy()},
            "jeMapping": je["suggestedMapping"],
            "accountRoleOverrides": {
                "605101 利息收入-A": "interest_income",
                "660301 财务费用-利息收入-B": "interest_income"
            }
        });
        let cancel = Arc::new(AtomicBool::new(false));
        let pause = PauseCheckpoint::unpaused(cancel.clone());
        let result = run_job("deposit.preview", params, &|_, _, _, _| {}, cancel, &pause).unwrap();
        let summary = &result["summary"];
        assert!((summary["bookedInterestIncome"].as_f64().unwrap() - 140.0).abs() < 0.01);
        assert_eq!(summary["bookedDirectionConfirmed"], json!(true));
        assert_eq!(summary["bookedDirectionUnconfirmedCount"], json!(0));
        let booked_rows = result["bookedInterestRows"].as_array().unwrap();
        assert!(booked_rows.iter().any(|row| {
            row["bookedAmount"] == json!(100.0)
                && row["note"].as_str().unwrap().contains("贷方全额")
        }));
        assert!(booked_rows.iter().any(|row| {
            row["bookedAmount"] == json!(40.0)
                && row["note"].as_str().unwrap().contains("红字冲减费用")
        }));
        assert!(
            booked_rows
                .iter()
                .all(|row| !row["note"].as_str().unwrap_or("").contains("剔除"))
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 辅助核算联动（公共锚点反查）：存款工具不改测算口径，只披露认定
    /// 结论；TB 映射了辅助列而 JE 对不上时必须有降级提示，不能无声吞掉。
    #[test]
    fn 存款工具披露辅助核算联动认定与降级提示() {
        let dir = std::env::temp_dir().join(format!("deposit-aux-link-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let tb_path = dir.join("tb.xlsx");
        write_fixture(
            &tb_path,
            &[
                vec![
                    "科目编码",
                    "科目名称",
                    "辅助核算",
                    "期初余额借方",
                    "期初余额贷方",
                    "本期发生借方",
                    "本期发生贷方",
                    "期末余额借方",
                    "期末余额贷方",
                ],
                vec![
                    "1002",
                    "银行存款",
                    "工行理财",
                    "1200000",
                    "0",
                    "1200000",
                    "0",
                    "2400000",
                    "0",
                ],
            ],
        );
        let je_linked = dir.join("je-linked.xlsx");
        write_fixture(
            &je_linked,
            &[
                vec![
                    "记账日期",
                    "凭证号",
                    "科目编码",
                    "科目名称",
                    "辅助核算",
                    "借方金额",
                    "贷方金额",
                ],
                vec![
                    "2025-06-30",
                    "记-1",
                    "1002",
                    "银行存款",
                    "工行理财",
                    "100",
                    "0",
                ],
            ],
        );
        let tb = inspect(
            &json!({"source": {"inputPath": tb_path.to_string_lossy()}}),
            "tb",
        )
        .unwrap();
        let je = inspect(
            &json!({"source": {"inputPath": je_linked.to_string_lossy()}}),
            "je",
        )
        .unwrap();
        let mut tb_mapping = tb["suggestedMapping"].clone();
        tb_mapping["auxiliary"] = json!("辅助核算");
        let params = json!({
            "reportStart": "2025-01-01", "reportEnd": "2025-12-31",
            "tbSource": {"inputPath": tb_path.to_string_lossy()},
            "tbMapping": tb_mapping,
            "accountRoles": tb["suggestedAccountRoles"],
            "jeSource": {"inputPath": je_linked.to_string_lossy()},
            "jeMapping": je["suggestedMapping"],
        });
        let cancel = Arc::new(AtomicBool::new(false));
        let pause = PauseCheckpoint::unpaused(cancel.clone());
        let result = run_job("deposit.preview", params, &|_, _, _, _| {}, cancel, &pause).unwrap();
        let summary = &result["summary"];
        assert_eq!(
            summary["auxiliaryMatch"]["status"],
            json!("verified"),
            "{summary:#?}"
        );
        assert!(
            summary["auxiliaryWarnings"]
                .as_array()
                .map(Vec::is_empty)
                .unwrap_or(true),
            "{summary:#?}"
        );

        // JE 换成没有辅助列的版本：noMatch 降级＋提示，测算数字不受影响。
        let je_plain = dir.join("je-plain.xlsx");
        write_fixture(
            &je_plain,
            &[
                vec![
                    "记账日期",
                    "凭证号",
                    "科目编码",
                    "科目名称",
                    "借方金额",
                    "贷方金额",
                ],
                vec!["2025-06-30", "记-1", "1002", "银行存款", "100", "0"],
            ],
        );
        let je_plain_inspected = inspect(
            &json!({"source": {"inputPath": je_plain.to_string_lossy()}}),
            "je",
        )
        .unwrap();
        let cancel = Arc::new(AtomicBool::new(false));
        let pause = PauseCheckpoint::unpaused(cancel.clone());
        let result = run_job(
            "deposit.preview",
            json!({
                "reportStart": "2025-01-01", "reportEnd": "2025-12-31",
                "tbSource": {"inputPath": tb_path.to_string_lossy()},
                "tbMapping": tb_mapping,
                "accountRoles": tb["suggestedAccountRoles"],
                "jeSource": {"inputPath": je_plain.to_string_lossy()},
                "jeMapping": je_plain_inspected["suggestedMapping"],
            }),
            &|_, _, _, _| {},
            cancel,
            &pause,
        )
        .unwrap();
        let summary = &result["summary"];
        assert_eq!(
            summary["auxiliaryMatch"]["status"],
            json!("noMatch"),
            "{summary:#?}"
        );
        assert!(
            summary["auxiliaryWarnings"]
                .as_array()
                .map(|warnings| warnings.iter().any(|warning| warning
                    .as_str()
                    .map(|text| text.contains("JE 无对应列"))
                    .unwrap_or(false)))
                .unwrap_or(false),
            "降级必须带提示: {summary:#?}"
        );

        let _ = std::fs::remove_dir_all(&dir);
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
                // 定期存款自动带出挂牌暂估利率，状态必须提示待确认。
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
        assert_eq!(demand["status"], "待确认利率");
        assert_eq!(demand["rateSource"], "挂牌暂估值");
        assert_eq!(demand["rateProvisional"], json!(true));
        assert!(demand["rateResolved"].as_bool().unwrap());
        // 12 个月月均余额之和 21,600,000；活期挂牌 0.05% ÷ 12 → 900。
        assert!((demand["averageBalance"].as_f64().unwrap() - 1_800_000.0).abs() < 0.01);

        // 定期：自动套用挂牌暂估值并纳入测算，但状态明确待确认。
        let term = rows.iter().find(|r| r["tier"] == json!("term_1y")).unwrap();
        assert!(term["rateResolved"].as_bool().unwrap());
        assert_eq!(term["rateSource"], "挂牌暂估值");
        assert_eq!(term["rateProvisional"], json!(true));
        assert_eq!(term["status"], "待确认利率");
        // 该定期户在 JE 中没有发生额，且 TB 年初＝年末；按零发生额推导后
        // 期末与 TB 一致，仍属于有效勾稽。
        assert_eq!(term["jeReconciled"], true);
        assert!((term["annualRate"].as_f64().unwrap() - 0.0095).abs() < 1e-12);

        assert_eq!(summary["missingRateCount"], 0);
        assert_eq!(summary["defaultRateCount"], 2);
        assert!((summary["calculatedInterest"].as_f64().unwrap() - 5_650.0).abs() < 0.01);
        assert!((summary["bookedInterestIncome"].as_f64().unwrap() - 900.0).abs() < 0.01);
        assert!((summary["difference"].as_f64().unwrap() - 4_750.0).abs() < 0.01);
        // 暂估利率尚未确认，不能判为最终勾稽通过。
        assert_eq!(summary["reconciliationPassed"], json!(false));

        // 导出的月度表必须是公式而不是死值，否则用户在 Excel 里改利率不会重算。
        let mut book = calamine::open_workbook_auto(&out_path).unwrap();
        // 勾稽比较已并入汇总表：不再有单独的「与TB利息收入勾稽」sheet。
        let sheets = calamine::Reader::sheet_names(&book);
        assert!(
            !sheets.iter().any(|name| name == "与TB利息收入勾稽"),
            "勾稽比较应并入「{SUMMARY_SHEET}」：{sheets:?}"
        );
        let summary_formulas =
            calamine::Reader::worksheet_formula(&mut book, SUMMARY_SHEET).unwrap();
        let summary_formula_text: Vec<String> = summary_formulas
            .rows()
            .flat_map(|row| row.to_vec())
            .collect();
        assert!(
            summary_formula_text.iter().any(|f| f.contains("J2-I2")),
            "汇总表勾稽差异必须是活公式（JE推导−TB）：{summary_formula_text:?}"
        );
        assert!(
            summary_formula_text
                .iter()
                .any(|f| f.contains("\"勾稽一致\"")),
            "勾稽结论列必须由公式判定并输出「勾稽一致」：{summary_formula_text:?}"
        );
        assert!(
            summary_formula_text
                .iter()
                .any(|f| f.contains("H2+SUM('月度余额与利息'!H")
                    && f.contains("-SUM('月度余额与利息'!I")),
            "JE推导期末必须=年初+Σ借−Σ贷（回引月度表）：{summary_formula_text:?}"
        );
        let formulas = calamine::Reader::worksheet_formula(&mut book, MONTHLY_SHEET).unwrap();
        let cells: Vec<String> = formulas.rows().flat_map(|row| row.to_vec()).collect();
        assert!(
            cells.iter().any(|f| f.contains("(G2+J2)/2")),
            "缺少月均余额公式"
        );
        assert!(
            cells
                .iter()
                .any(|f| f.contains("测算汇总") && f.contains("$G$2")),
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
        assert_eq!(summary_sheet.get((2, 9)).unwrap().to_string(), "500000");
        assert_eq!(summary_sheet.get((2, 10)).unwrap().to_string(), "0");
        assert_eq!(summary_sheet.get((2, 11)).unwrap().to_string(), "勾稽一致");
        let summary_text: String = summary_sheet
            .rows()
            .flat_map(|row| row.iter().map(|cell| cell.to_string()))
            .collect::<Vec<_>>()
            .join(
                "
",
            );
        assert!(!summary_text.contains("档位匹配依据"));
        assert!(summary_text.contains("待确认利率"));
        assert!(summary_text.contains("挂牌暂估值"));
        // 勾稽块并入汇总表后，比较标题与账面明细必须在同一张 sheet 里。
        assert!(
            summary_text.contains("存款利息测算与账面利息收入比较"),
            "勾稽比较标题应在「{SUMMARY_SHEET}」内"
        );
        assert!(
            summary_text.contains("本期借方发生额") && summary_text.contains("期末余额(借正贷负)"),
            "账面利息收入科目明细应列示借贷发生额与期末余额"
        );
        assert!(
            text.contains("有挂牌参考值的活期、协定、通知、定期和大额存单")
                && text.contains("暂估")
                && text.contains("确认"),
            "档位表缺少标准档位默认暂估政策说明"
        );
        assert!(
            text.contains("仅作合理性上限参照"),
            "档位表未把央行基准降级为参照"
        );

        // 按月平均口径下，月度表的期数列必须写「期数（月）」而不是「天数」，
        // 否则 M 列的 1 会被误读成只计息一天。
        let monthly_sheet = calamine::Reader::worksheet_range(&mut book, MONTHLY_SHEET).unwrap();
        let monthly_text: String = monthly_sheet
            .rows()
            .flat_map(|row| row.iter().map(|cell| cell.to_string()))
            .collect::<Vec<_>>()
            .join("");
        assert!(
            monthly_text.contains("计息期数（月）"),
            "按月平均口径的期数列名应写明单位是月：{monthly_text}"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }
}
