//! TB（科目余额表）与 JE（序时账）的统一映射内核。
//!
//! 五个工具——汇兑损益、存款利息、借款利息、看账、正负数凭证标记——此前各有一套
//! 表头识别与映射校验，同样的缺陷要修四遍。本模块把三件事收敛成唯一实现：
//!
//! 1. **角色词汇表**：每个业务字段的标准名、别名库、冲突词库（[`je_roles`] / [`tb_roles`]）；
//! 2. **形态型号**：TB 六型、JE 三型，按槽位整组匹配，缺一不可（[`match_forms`]）；
//! 3. **数据形态判定**：币种列归属（[`classify_currency_column`]）与借贷符号方向（[`tb_sign_evidence`] / [`je_sign_evidence_debit_credit`]）。
//!
//! 设计依据与实测样例见 `LEDGER_MAPPING_UNIFICATION.md`。

use chrono::{NaiveDate, NaiveDateTime};
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

/// TB与JE跨表对齐的公共结论。这是账表引擎能力，不属于汇兑损益业务。
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct AccountColumnAlignment {
    pub(crate) je_column: String,
    pub(crate) tb_column: String,
    pub(crate) overlap: usize,
    pub(crate) ratio: f64,
}

fn account_values(rows: &[Vec<String>], index: usize, limit: usize) -> HashSet<String> {
    rows.iter()
        .take(limit)
        .filter_map(|row| row.get(index))
        .map(|value| account_code_of(value).trim().to_uppercase())
        .filter(|value| {
            value.len() >= 3
                && value.len() <= 24
                && value.chars().any(|c| c.is_ascii_digit())
                && value
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
        })
        .collect()
}

/// 在两张账表中找出取值真正能对上的科目编码列。
///
/// 列名只能说明“像什么”；真正的科目列还必须有足够的非空编码，
/// 并且与另一张表有显著交集。混写的 `1001:库存现金` 会先拆出编码再比。
pub(crate) fn align_account_code_columns(
    je_headers: &[String],
    je_rows: &[Vec<String>],
    tb_headers: &[String],
    tb_rows: &[Vec<String>],
) -> Option<AccountColumnAlignment> {
    const MAX_ROWS: usize = 100_000;
    let je = je_headers
        .iter()
        .enumerate()
        .map(|(index, header)| (header, account_values(je_rows, index, MAX_ROWS)))
        .filter(|(_, values)| values.len() >= 2)
        .collect::<Vec<_>>();
    let tb = tb_headers
        .iter()
        .enumerate()
        .map(|(index, header)| (header, account_values(tb_rows, index, MAX_ROWS)))
        .filter(|(_, values)| values.len() >= 2)
        .collect::<Vec<_>>();
    let mut best: Option<AccountColumnAlignment> = None;
    for (je_header, je_values) in &je {
        for (tb_header, tb_values) in &tb {
            let overlap = je_values.intersection(tb_values).count();
            if overlap < 2 {
                continue;
            }
            let ratio = overlap as f64 / je_values.len().min(tb_values.len()) as f64;
            // 大表要求足够交集；小账套只有少量科目时允许两个编码举证。
            if ratio < 0.60 {
                continue;
            }
            let candidate = AccountColumnAlignment {
                je_column: (*je_header).clone(),
                tb_column: (*tb_header).clone(),
                overlap,
                ratio,
            };
            if best.as_ref().is_none_or(|current| {
                candidate.ratio > current.ratio
                    || (candidate.ratio == current.ratio && candidate.overlap > current.overlap)
            }) {
                best = Some(candidate);
            }
        }
    }
    best
}

pub(crate) fn mapped_account_overlap(
    je_headers: &[String],
    je_rows: &[Vec<String>],
    je_column: &str,
    tb_headers: &[String],
    tb_rows: &[Vec<String>],
    tb_column: &str,
) -> (usize, usize, usize) {
    let Some(je_index) = je_headers.iter().position(|header| header == je_column) else {
        return (0, 0, 0);
    };
    let Some(tb_index) = tb_headers.iter().position(|header| header == tb_column) else {
        return (0, 0, 0);
    };
    let je = account_values(je_rows, je_index, 100_000);
    let tb = account_values(tb_rows, tb_index, 100_000);
    (je.intersection(&tb).count(), je.len(), tb.len())
}

// ────────────────────────────── 角色词汇表 ──────────────────────────────

/// 一个业务字段在映射面板上的完整定义。
#[derive(Clone, Copy, Debug)]
pub(crate) struct Role {
    /// 标准名，跨工具唯一。
    pub(crate) name: &'static str,
    /// 面向用户的中文标签。
    pub(crate) label: &'static str,
    /// 实务里的各种写法，中英文都要。匹配时取**最长命中**，不是第一个命中。
    pub(crate) aliases: &'static [&'static str],
    /// 冲突词：列名里出现任一即排除本角色。防止短别名把长列名吃掉。
    pub(crate) conflicts: &'static [&'static str],
    /// 是否允许映射多列（如"科目名称一级＋二级"）。
    pub(crate) multi: bool,
}

const fn r(
    name: &'static str,
    label: &'static str,
    aliases: &'static [&'static str],
    conflicts: &'static [&'static str],
) -> Role {
    Role {
        name,
        label,
        aliases,
        conflicts,
        multi: false,
    }
}

const fn rm(
    name: &'static str,
    label: &'static str,
    aliases: &'static [&'static str],
    conflicts: &'static [&'static str],
) -> Role {
    Role {
        name,
        label,
        aliases,
        conflicts,
        multi: true,
    }
}

/// 金额列的通用冲突词：挡住"本位币""原币"这类短别名去吃金额列。
const AMT: &[&str] = &[
    "金额", "金額", "余额", "餘額", "balance", "amount", "发生", "發生", "差异", "差異",
    // 「借方(本位币) Debit」这种双语表头分段后会命中「本位币」，但它是金额列。
    "借方", "贷方", "貸方", "debit", "credit",
    // SAP 的 `Document Currency Value` 含 "currency"，但它是金额不是币种。
    "value",
];
/// 原币币种专属冲突词：[`AMT`] 的全部词条 ＋ 本位币的中文写法。
///
/// 「本币」「本位币」命名的列登记的是主体本位币，绝不是逐笔的交易币种——
/// 03 号 SAP 序时账的「本币」列整列 CNY，若被指给原币币种，整张 JE 的
/// 币种口径全反。改 [`AMT`] 时这里要跟着同步。
const NOT_LOCAL: &[&str] = &[
    "金额",
    "金額",
    "余额",
    "餘額",
    "balance",
    "amount",
    "发生",
    "發生",
    "差异",
    "差異",
    "借方",
    "贷方",
    "貸方",
    "debit",
    "credit",
    "value",
    "本位币",
    "本位幣",
    "本币",
    "本幣",
];
/// 科目编码的冲突词：挡住 `Account` 去吃 `Account Desc`、`Accounting Flexfield`。
///
/// 后半截是**对手方科目**：别名收了裸的 `科目` 之后，`抵销科目`（03 号样例的
/// SAP 对方科目列，取值同样是十位编码）、`统驭科目`（02 号样例）、`对方科目`、
/// `预算科目` 都会跟着命中。这些列长得跟本方科目一模一样，认错了整张表的
/// 科目就全串了。
const NOT_CODE: &[&str] = &[
    "desc",
    "description",
    "描述",
    "名称",
    "名稱",
    "文本",
    "flexfield",
    "segment",
    "对方",
    "對方",
    "抵销",
    "抵銷",
    "抵消",
    "统驭",
    "統馭",
    "预算",
    "預算",
    "往来",
    "往來",
];
/// 科目名称的冲突词。预算／对方是真实踩坑（4800 序时账的「预算二级科目描述」
/// 包含"科目描述"、「对方科目名称」包含"科目名称"），放进来会把账面科目名
/// 拼成对不上 TB 的长串。
const NOT_NAME: &[&str] = &[
    "flexfield",
    "segment",
    "code",
    "编码",
    "編碼",
    "代码",
    "代碼",
    "预算",
    "預算",
    "对方",
    "對方",
];
/// 辅助核算的别名。**只收汇兑损益那一份**——存款利息另有一份把「文本／科目文本／
/// 账户文本」也算辅助核算（它靠这些列认存款档次），并进来会把科目名称抢走。
/// 工具需要额外写法时在自己那边追加，标准表保持保守。
const AUX: &[&str] = &[
    "辅助核算",
    "輔助核算",
    "辅助項",
    "辅助项",
    "往来单位",
    "往來單位",
    "客户",
    "客戶",
    "供应商",
    "供應商",
    "银行账号",
    "银行帐号",
    "明细项",
    "明細項",
    "counterparty",
    "assignment",
    "profit center",
    "profitcenter",
];
/// 辅助核算的冲突词：挡住它去吃科目类与金额类的列。
const NOT_AUX: &[&str] = &["科目", "account", "金额", "amount", "余额", "balance"];
/// 借款明细标识。别名刻意取**特异写法**：`辅助`、`明细`、`客户` 这类泛词留给
/// [`AUX`]，否则同一列谁抢到全看分数，两个工具的结果会分叉。
const LOAN_ID: &[&str] = &[
    "合同编号",
    "合同編號",
    "借款编号",
    "借款編號",
    "借据",
    "借據",
    "借据号",
    "借款合同号",
    "登记编号",
    "合同号",
    "合同號",
    "loanid",
    "contractno",
];

/// 集团货币／报告货币是**第三套口径**，既不是本位币也不是原币。
/// SAP 那份 TB 就同时给了本位币与集团货币两套金额，集团货币的数字往往大出几倍——
/// 拿它跟本位币比量级会把本年累计判到错的那一列上。所有金额角色一律排除它。
const NOT_GROUP: &[&str] = &[
    "集团货币",
    "集團貨幣",
    "集团币",
    "集團幣",
    "报告货币",
    "報告貨幣",
    // `Grp Curr` 是 SAP 的实际缩写写法（`MTD Grp Curr`、`YTD Act (Grp Curr)`），
    // 实测样例 Oct+BS+PL+TB.xlsx 里就是这么写的，`groupcurr` 匹配不到它。
    "groupcurrency",
    "reportingcurrency",
    "groupcurr",
    "grpcurr",
    "grpcurrency",
];

/// 序时账角色。一行是一条分录。
pub(crate) fn je_roles() -> &'static [Role] {
    JE_ROLES
}

static JE_ROLES: &[Role] = &[
    r(
        "entity",
        "公司/核算主体",
        &[
            "公司代码",
            "公司代碼",
            "公司名称",
            "单位名称",
            "核算主体",
            "主体",
            "公司",
            "单位",
            "company",
            "companycode",
            "cocode",
            "businessunit",
            "breaksegment",
            "entity",
            "bukrs",
        ],
        &[
            "科目",
            "account",
            "金额",
            "amount",
            "辅助",
            "往来",
            "对方",
            "对手",
            "供应商",
            "客户",
            "value",
            "currency",
            "币种",
            "货币",
        ],
    ),
    r(
        "date",
        "记账日期",
        &[
            "日期",
            "记账日期",
            "記賬日期",
            "记帐日期",
            "过账日期",
            "过帐日期",
            "過賬日期",
            "凭证日期",
            "憑證日期",
            "业务日期",
            "gldate",
            "postingdate",
            "entrydate",
            "budat",
        ],
        &["期间", "period", "年", "月"],
    ),
    rm(
        "id",
        "凭证识别字段",
        &[
            "凭证号",
            "憑證號",
            "凭证号数",
            // 07 号样例把日期与凭证号拼成了一列「唯一码」，整列就是凭证键。
            "唯一码",
            "唯一碼",
            "凭证编号",
            "憑證編號",
            "凭证字",
            "憑證字",
            "凭证字号",
            "凭证名",
            "voucher",
            "voucherno",
            "documentno",
            "documentnumber",
            "batchname",
            "jebatch",
            "je批名",
            "jename",
            "belnr",
        ],
        &[
            "行号",
            "行號",
            "行项目",
            "行項目",
            "分录号",
            "分錄號",
            "line",
            "item",
            "冲销",
            "沖銷",
            "反冲",
            "反沖",
            "reversed",
            "reversal",
        ],
    ),
    r(
        "voucherType",
        "凭证类型",
        &[
            "凭证类型",
            "憑證類型",
            "凭证类别",
            "憑證類別",
            "单据类型",
            "category",
            "document type",
            "documenttype",
            "blart",
        ],
        &[],
    ),
    r(
        "accountCode",
        "科目编码",
        &[
            "科目编码",
            "科目編碼",
            "科目代码",
            "科目代碼",
            "科目号",
            "科目編號",
            "会计科目",
            "會計科目",
            "总账科目",
            "總賬科目",
            // 「帐」是「账」的旧异体字，财务导出里两种写法都常见
            //（04 PBC 的序时账表头就写作「总帐科目」），必须一并收录。
            "总帐科目",
            "總帳科目",
            "账户",
            "帳戶",
            "account",
            "glaccount",
            "accountcode",
            "saknr",
        ],
        NOT_CODE,
    ),
    rm(
        "accountName",
        "科目名称",
        &[
            "科目名称",
            "科目名稱",
            "科目描述",
            "科目文本",
            "科目全名",
            "账户名称",
            "帳戶名稱",
            "accountname",
            "accountdesc",
            "accountdescription",
            "gldescription",
            "childdescription",
        ],
        NOT_NAME,
    ),
    // 「文本」是 SAP（SGTXT 行项目文本）与 AX/D365 对摘要的叫法；
    // 「抬头」冲突词挡住「凭证抬头文本」——那是单据号不是行摘要。
    r(
        "summary",
        "摘要",
        &[
            "摘要",
            "摘要说明",
            "说明",
            "說明",
            "备注",
            "備註",
            "文本",
            "entry item",
            "line description",
            "sgtxt",
        ],
        &["科目", "account", "凭证", "憑證", "抬头", "抬頭"],
    ),
    r(
        "currency",
        "原币币种",
        &[
            "币种",
            "幣種",
            "币别",
            "幣別",
            "货币",
            "貨幣",
            "货币代码",
            "貨幣代碼",
            "原币币种",
            "交易币种",
            "凭证货币",
            "currency",
            "currencycode",
            "entercurrency",
            "documentcurrencykey",
            "waers",
        ],
        NOT_LOCAL,
    ),
    // SAP 的 `Company Code Currency Key` 记的是公司本位币，不是这笔分录的交易币种。
    // 缺了这个角色，它就会去抢 currency，把真正的 `Document Currency Key` 挤掉。
    r(
        "functionalCurrency",
        "本位币币种",
        &[
            "本位币",
            "本位幣",
            // 03 号样例的 SAP 中文导出把本位币列就叫「本币」（整列 CNY）。
            // 没有这个别名时它哪边都命不中，LLM 复核便把原币币种硬指过去。
            "本币",
            "本幣",
            "公司代码货币",
            "记账本位币",
            // SAP 中文导出的总账货币（Ledger Currency）登记的就是主体本位币；
            // 没有这个别名时它会因「含货币」反而去抢 currency 的位置。
            "总账货币",
            "總賬貨幣",
            "companycodecurrency",
            "ledgercurrency",
            "functionalcurrency",
            "localcurrency",
        ],
        AMT,
    ),
    r(
        "direction",
        "借贷方向",
        &[
            "方向",
            "借贷方向",
            "借貸方向",
            // 04 号样例的 SAP 列叫「借贷标志」，取值是 S／H。
            "借贷标志",
            "借貸標誌",
            "借贷",
            "借貸",
            "drcr",
            "dccr",
            "debitcredit",
        ],
        &[
            "金额",
            "amount",
            "usd",
            "cny",
            "hkd",
            "eur",
            // SAP 的过账代码（Posting Key）取值 40／50 也分借贷，但 01／09／11
            // 这类统驭过账码没有借贷含义，绝不是借贷方向列——03 号样例的
            // 「过账代码」就被 LLM 复核指给过 direction。
            "过账代码",
            "过账碼",
            "过账代碼",
            "postingkey",
            "bschl",
        ],
    ),
    r(
        "functionalAmount",
        "本位币净额",
        &[
            "本位币金额",
            "本位幣金額",
            "本币金额",
            "本位币",
            "本位幣",
            "借正贷负",
            "借正貸負",
            "金额",
            "金額",
            "companycodecurrencyvalue",
            "functionalamount",
        ],
        &[
            "原币", "原幣", "外币", "外幣", "借方", "贷方", "貸方", "debit", "credit",
        ],
    ),
    r(
        "functionalDebit",
        "本位币借方",
        &[
            "本位币借方",
            "本位幣借方",
            "借方金额",
            "借方金額",
            "借方发生额",
            "借方",
            "debits",
            "debit",
        ],
        &["原币", "原幣", "外币", "外幣", "贷", "貸", "credit"],
    ),
    r(
        "functionalCredit",
        "本位币贷方",
        &[
            "本位币贷方",
            "本位幣貸方",
            "贷方金额",
            "貸方金額",
            "贷方发生额",
            "贷方",
            "貸方",
            "credits",
            "credit",
        ],
        &["原币", "原幣", "外币", "外幣", "借", "debit"],
    ),
    r(
        "foreignAmount",
        "原币净额",
        &[
            "原币金额",
            "原幣金額",
            "外币金额",
            "外幣金額",
            "凭证金额",
            "憑證金額",
            // SAP 中文导出把凭证货币下的金额叫「凭证货币金额」——「凭证金额」
            // 不是它的子串（中间隔着「货币」二字），04 PBC 就因此漏了原币净额。
            "凭证货币金额",
            "憑證貨幣金額",
            "原币",
            "原幣",
            "documentcurrencyvalue",
            "foreignamount",
        ],
        &[
            "本位币",
            "本位幣",
            "借方",
            "贷方",
            "貸方",
            "debit",
            "credit",
        ],
    ),
    r(
        "foreignDebit",
        "原币借方",
        &[
            "原币借方",
            "原幣借方",
            "外币借方",
            "货币借方金额",
            "貨幣借方金額",
            "enterdebits",
        ],
        &["本位币", "本位幣", "贷", "貸"],
    ),
    r(
        "foreignCredit",
        "原币贷方",
        &[
            "原币贷方",
            "原幣貸方",
            "外币贷方",
            "货币贷方金额",
            "貨幣貸方金額",
            "entercredits",
        ],
        &["本位币", "本位幣", "借"],
    ),
    // 辅助核算此前不在标准表里，汇兑损益靠一行 `role == "auxiliary"` 特判把它
    // 当多列角色用。TB-4800 的类型表把「辅助信息」列为账表的正式组成部分，
    // 据此收编——SAP 导出常把供应商、客户分成两列，必须可多列。
    rm("auxiliary", "辅助核算", AUX, NOT_AUX),
    // 借款明细标识：借款利息此前按关键词临时找，不在标准表里。
    r(
        "loanId",
        "借款明细",
        LOAN_ID,
        &["金额", "amount", "余额", "balance"],
    ),
];

/// 科目余额表角色。一行是一个科目在某时点的余额。
pub(crate) fn tb_roles() -> &'static [Role] {
    TB_ROLES
}

static TB_ROLES: &[Role] = &[
    r(
        "entity",
        "公司/核算主体",
        &[
            "公司代码",
            "公司代碼",
            "公司名称",
            "核算主体",
            "主体",
            "company",
            "companycode",
            "break segment",
        ],
        &["科目", "account"],
    ),
    r(
        "accountCode",
        "科目编码",
        &[
            "科目编码",
            "科目編碼",
            "科目代码",
            "科目代碼",
            "科目号",
            "科目編號",
            "会计科目",
            "會計科目",
            "总账科目",
            "总帐科目",
            "總賬科目",
            "科目段组合",
            // 04／05 号样例的明细编码列就叫裸的一个「科目」，旁边另有
            // 「科目级别」放一级编码。分数比 `科目编码`（四字）低，同表里
            // 有更具体的写法时抢不过它；`抵销科目` 这类对手方列由 NOT_CODE 挡住。
            "科目",
            "account",
            "glaccount",
            "slaccount",
            "accountcode",
            "accountcombination",
        ],
        NOT_CODE,
    ),
    rm(
        "accountName",
        "科目名称",
        &[
            "科目名称",
            "科目名稱",
            "科目名称一级",
            "科目名称二级",
            "科目名称三级",
            "科目全称",
            "科目描述",
            "科目文本",
            "账户名称",
            "帳戶名稱",
            "accountname",
            "accountdesc",
            "accountdescription",
            "gldescription",
            "slaccountdesc",
        ],
        NOT_NAME,
    ),
    r(
        "currency",
        "原币币种",
        &[
            "币种",
            "幣種",
            "币别",
            "幣別",
            "货币",
            "貨幣",
            "原币币种",
            "交易币种",
            "currency",
            "ccy",
            "currencycode",
        ],
        NOT_LOCAL,
    ),
    r(
        "currencyText",
        "币种线索文本",
        &[
            "文本",
            "科目文本",
            "账户文本",
            "帳戶文本",
            "说明",
            "說明",
            "备注",
            "備註",
            "描述",
        ],
        &["金额", "余额", "amount", "balance"],
    ),
    r(
        "functionalCurrency",
        "本位币币种",
        &[
            "本位币",
            "本位幣",
            // 03 号 SAP 样例把本位币列叫「本币」，与 JE 侧同一份口径。
            "本币",
            "本幣",
            "功能货币",
            "记账本位币",
            "总账货币",
            "總賬貨幣",
            "functionalcurrency",
            "ledgercurrency",
        ],
        AMT,
    ),
    r(
        "openingDirection",
        "期初方向",
        &["期初方向", "年初方向", "期初余额方向", "openingdrcr"],
        &["期末", "本期", "本年"],
    ),
    r(
        "closingDirection",
        "期末方向",
        &[
            "期末方向",
            "年末方向",
            "期末余额方向",
            "方向",
            "closingdrcr",
            "drcr",
        ],
        &["期初", "年初"],
    ),
    r(
        "openingFunctionalAmount",
        "期初本位币余额",
        &[
            "期初本位币余额",
            "期初余额",
            "期初餘額",
            "期初金额",
            "期初金額",
            "年初余额",
            "年初金额",
            // 03 号样例把两行表头合成 `本年金额-期初`／`本期金额-本期期初`，
            // 既有别名一个都对不上。裸的「期初」分数最低，同表里有更具体的
            // 写法时抢不过它；`期初余额方向`、`期初借方` 由冲突词挡住。
            "期初",
            "beginbalance",
            "beginningbalance",
            "openingbalance",
            "opening",
        ],
        &[
            "借", "贷", "貸", "原币", "原幣", "外币", "外幣", "期末", "方向", "debit", "credit",
        ],
    ),
    r(
        "openingFunctionalDebit",
        "期初借方本位币余额",
        &[
            "期初借方本位币余额",
            "期初余额借方",
            "期初借方余额",
            "期初借方",
            "年初余额借方",
            "年初借方",
            "openingdr",
            "openingdebit",
        ],
        &["贷", "貸", "原币", "原幣", "外币", "期末", "credit"],
    ),
    r(
        "openingFunctionalCredit",
        "期初贷方本位币余额",
        &[
            "期初贷方本位币余额",
            "期初余额贷方",
            "期初贷方余额",
            "期初贷方",
            "年初余额贷方",
            "年初贷方",
            "openingcr",
            "openingcredit",
        ],
        &["借", "原币", "原幣", "外币", "期末", "debit"],
    ),
    r(
        "openingForeignAmount",
        "期初原币余额",
        &[
            "期初原币余额",
            "期初原幣餘額",
            "期初外币余额",
            "期初余额原币",
            "期初餘額原幣",
            "期初原币",
            "期初原幣",
            "openingfcy",
        ],
        &["借", "贷", "貸", "本位币", "本位幣", "期末"],
    ),
    r(
        "openingForeignDebit",
        "期初借方原币余额",
        &["期初借方原币余额", "期初借方原币", "期初原币借方"],
        &["贷", "貸", "本位币", "本位幣", "期末"],
    ),
    r(
        "openingForeignCredit",
        "期初贷方原币余额",
        &["期初贷方原币余额", "期初贷方原币", "期初原币贷方"],
        &["借", "本位币", "本位幣", "期末"],
    ),
    r(
        "closingFunctionalAmount",
        "期末本位币余额",
        &[
            "期末本位币余额",
            "期末余额",
            "期末餘額",
            // 02 号样例的期末列写作「累计余额」，配一个「累计余额方向」列。
            "累计余额",
            "累計餘額",
            "期末金额",
            "期末金額",
            "年末余额",
            "年末金额",
            "endbalance",
            "endingbalance",
            "closingbalance",
            "ytdact",
            "closing",
        ],
        &[
            "借", "贷", "貸", "原币", "原幣", "外币", "外幣", "期初", "方向", "debit", "credit",
        ],
    ),
    r(
        "closingFunctionalDebit",
        "期末借方本位币余额",
        &[
            "期末借方本位币余额",
            "期末余额借方",
            "期末借方余额",
            "期末借方",
            "年末余额借方",
            "年末借方",
            "closingdr",
            "closingdebit",
        ],
        &["贷", "貸", "原币", "原幣", "外币", "期初", "credit"],
    ),
    r(
        "closingFunctionalCredit",
        "期末贷方本位币余额",
        &[
            "期末贷方本位币余额",
            "期末余额贷方",
            "期末贷方余额",
            "期末贷方",
            "年末余额贷方",
            "年末贷方",
            "closingcr",
            "closingcredit",
        ],
        &["借", "原币", "原幣", "外币", "期初", "debit"],
    ),
    r(
        "closingForeignAmount",
        "期末原币余额",
        &[
            "期末原币余额",
            "期末原幣餘額",
            "期末外币余额",
            "期末余额原币",
            "期末餘額原幣",
            "期末原币",
            "期末原幣",
            "原币期末余额",
            "origclosing",
            "closingfcy",
        ],
        &["借", "贷", "貸", "本位币", "本位幣", "期初"],
    ),
    r(
        "closingForeignDebit",
        "期末借方原币余额",
        &["期末借方原币余额", "期末借方原币", "期末原币借方"],
        &["贷", "貸", "本位币", "本位幣", "期初"],
    ),
    r(
        "closingForeignCredit",
        "期末贷方原币余额",
        &["期末贷方原币余额", "期末贷方原币", "期末原币贷方"],
        &["借", "本位币", "本位幣", "期初"],
    ),
    r(
        "ytdFunctionalDebit",
        "本年累计本位币借方发生额",
        &[
            "本年本位币累计借方发生额",
            "本年累计借方",
            "本年累计借方发生额",
            "本年借方发生额",
            "累计借方",
            // 08／09 号样例的词序是反的：「借方累计」「贷方累计」。
            "借方累计",
            "借方累計",
            "借方发生额",
            "借方发生",
            "借方發生",
            "借方金额",
            "ytddebit",
            "ytddr",
            "perioddr",
            "perioddebit",
        ],
        &[
            "贷", "貸", "原币", "原幣", "外币", "外幣", "本期", "期初", "期末", "credit",
        ],
    ),
    r(
        "ytdFunctionalCredit",
        "本年累计本位币贷方发生额",
        &[
            "本年本位币累计贷方发生额",
            "本年累计贷方",
            "本年累计贷方发生额",
            "本年贷方发生额",
            "累计贷方",
            "贷方累计",
            "貸方累計",
            "贷方发生额",
            "贷方发生",
            "貸方發生",
            "贷方金额",
            "ytdcredit",
            "ytdcr",
            "periodcr",
            "periodcredit",
        ],
        &[
            "借", "原币", "原幣", "外币", "外幣", "本期", "期初", "期末", "debit",
        ],
    ),
    r(
        "ytdForeignDebit",
        "本年累计原币借方发生额",
        &[
            "本年原币累计借方发生额",
            "本年累计原币借方",
            "借方发生原币",
            "借方發生原幣",
            "原币借方发生额",
            "借方发生额原币",
        ],
        &["贷", "貸", "本位币", "本位幣", "本期", "期初", "期末"],
    ),
    r(
        "ytdForeignCredit",
        "本年累计原币贷方发生额",
        &[
            "本年原币累计贷方发生额",
            "本年累计原币贷方",
            "贷方发生原币",
            "貸方發生原幣",
            "原币贷方发生额",
            "贷方发生额原币",
        ],
        &["借", "本位币", "本位幣", "本期", "期初", "期末"],
    ),
    // SAP 报表型导出只给 MTD（本月）与 YTD（本年）两个净额，没有借贷分列。
    r(
        "periodFunctionalAmount",
        "本期本位币净发生额",
        &[
            "本期净发生",
            "本期发生额",
            "本月发生额",
            "periodactivity",
            "mtd",
            "mtdlocalcurr",
        ],
        &[
            "借", "贷", "貸", "原币", "原幣", "外币", "外幣", "期初", "期末", "本年", "累计",
            "debit", "credit",
        ],
    ),
    r(
        "periodFunctionalDebit",
        "本期本位币借方发生额",
        &[
            "本期发生借方",
            "本期借方发生额",
            "本期本位币借方发生额",
            "本期借方",
            "本月借方",
            "mtddebit",
        ],
        &[
            "贷", "貸", "原币", "原幣", "外币", "期初", "期末", "本年", "累计", "credit",
        ],
    ),
    rm("auxiliary", "辅助核算", AUX, NOT_AUX),
    r(
        "loanId",
        "借款明细",
        LOAN_ID,
        &["金额", "amount", "余额", "balance"],
    ),
    // 会计期间只在科目余额表上有用：没有日期列时靠它取年份。
    // 序时账侧一律走 date 列，所以 JE 表里没有这个角色。
    r(
        "period",
        "会计期间",
        &[
            "会计期间",
            "會計期間",
            "期间",
            "期間",
            "所属期间",
            "年月",
            "period",
            "fiscalperiod",
        ],
        &["金额", "余额", "amount", "balance"],
    ),
    r(
        "periodFunctionalCredit",
        "本期本位币贷方发生额",
        &[
            "本期发生贷方",
            "本期贷方发生额",
            "本期本位币贷方发生额",
            "本期贷方",
            "本月贷方",
            "mtdcredit",
        ],
        &[
            "借", "原币", "原幣", "外币", "期初", "期末", "本年", "累计", "debit",
        ],
    ),
];

// ────────────────────────────── 借款台账角色 ──────────────────────────────

/// 起算额三兄弟的公共冲突词：挡住授信额度、利息、月供这些**不是占用本金**的金额列。
/// 05 金陵润庭同时有「授信金额 120000 / 已提款金额 90000」——认错列会按授信额计息。
const NOT_PRINCIPAL: &[&str] = &[
    "授信",
    "额度",
    "額度",
    "剩余",
    "剩餘",
    "利息",
    "利率",
    "月供",
    "手续费",
    "保证金",
    "比例",
];
/// 利率列的冲突词：`利率类型` `定价方式` 不是利率值；`利息支出/费用/应付利息` 是账面数不是利率。
const NOT_RATE: &[&str] = &[
    "类型", "類型", "形式", "方式", "定价", "定價", "调整", "調整", "支出", "费用", "費用", "应付",
    "應付", "预提", "預提", "金额", "金額",
];

/// 借款台账角色。一行是一笔借款。
///
/// 这些角色**不进 TB／JE 标准表**（见 `LEDGER_MAPPING_UNIFICATION.md` §3.7）：
/// 台账不是账表，没有科目、没有借贷方向。但它复用同一套匹配机制
/// （[`alias_score`] 取最长命中、冲突词一票否决），以及同一套形态整组匹配。
pub(crate) fn loan_roles() -> &'static [Role] {
    LOAN_ROLES
}

static LOAN_ROLES: &[Role] = &[
    // —— 起算额：三者任一到位即可起算（见 [`Form::any_of`]）——
    r(
        "principal",
        "本金",
        &[
            "借款本金",
            "借款金额",
            "借款金額",
            "放款金额",
            "放款金額",
            "已提款金额",
            "已提款",
            "提款金额",
            "票面金额",
            "票面金額",
            "合同金额",
            "合同金額",
            "原币金额",
            "原幣金額",
            "借款额",
            "放款额",
            "本金",
            "金额",
            "金額",
            "amount",
            "principal",
        ],
        NOT_PRINCIPAL,
    ),
    r(
        "openingPrincipal",
        "期初余额",
        &[
            "期初本金",
            "期初余额",
            "期初餘額",
            "年初余额",
            "年初餘額",
            "年初本金",
            "期初金额",
            "期初数",
            "期初",
        ],
        &[
            "期末", "年末", "新增", "归还", "歸還", "减少", "減少", "利息", "利率",
        ],
    ),
    r(
        "closingPrincipal",
        "期末余额",
        &[
            "期末未偿还本金",
            "未偿还本金",
            "未償還本金",
            "期末余额",
            "期末餘額",
            "年末余额",
            "年末餘額",
            "未还余额",
            "未還餘額",
            "未偿余额",
            "贷款余额",
            "貸款餘額",
            "借款余额",
            "期末本金",
            "期末金额",
            "期末数",
            "余额",
            "餘額",
        ],
        &["期初", "年初", "利息", "利率"],
    ),
    // —— 期间 ——
    r(
        "startDate",
        "起始日",
        &[
            "借款起始日",
            "放款起始日",
            "放款日期",
            "放款日",
            "起息日",
            "起始日",
            "借款时间",
            "借款時間",
            "借款日期",
            "起租日",
            "借款日",
            "提款日",
            "开票日",
            "開票日",
            "drawdown",
            "startdate",
        ],
        &[
            "到期",
            "结束",
            "結束",
            "还款",
            "還款",
            "归还",
            "歸還",
            "重定价",
            "重定價",
            "付息",
        ],
    ),
    r(
        "endDate",
        "到期日",
        &[
            "到期日期",
            "贷款到期日",
            "貸款到期日",
            "到期日",
            "到期时间",
            "到期時間",
            "届满日",
            "屆滿日",
            "结束日",
            "結束日",
            "maturity",
            "enddate",
        ],
        &["起始", "放款", "起息", "剩余", "剩餘"],
    ),
    r(
        "term",
        "期限",
        &[
            "借款期限",
            "贷款期限",
            "貸款期限",
            "期限",
            "期数",
            "期數",
            "term",
        ],
        &["剩余", "剩餘", "天数", "天數", "日期", "起始", "到期"],
    ),
    // —— 利率 ——
    r(
        "rate",
        "利率",
        &[
            "执行年利率",
            "執行年利率",
            "折算年利率",
            "执行利率",
            "執行利率",
            "合同利率",
            "固定利率",
            "年利率",
            "贴现率",
            "貼現率",
            "利率",
            "利息",
            "rate",
        ],
        NOT_RATE,
    ),
    r(
        "rateType",
        "利率类型",
        &["利率类型", "利率類型", "利率形式", "定价方式", "定價方式"],
        &[],
    ),
    // —— 期间发生额 ——
    r(
        "drawdownAmount",
        "本期新增",
        &[
            "本期新增",
            "本年新增",
            "新增本金",
            "新增借款",
            "本期增加",
            "本期借款",
            "借款增加",
        ],
        &["日期", "归还", "歸還", "减少", "減少", "期初", "期末"],
    ),
    r(
        "repaymentAmount",
        "本期归还",
        &[
            "累计归还本金",
            "累計歸還本金",
            "累计归还",
            "本期归还",
            "本期歸還",
            "本年归还",
            "还款本金",
            "還款本金",
            "归还本金",
            "本期减少",
            "本期減少",
            "归还",
            "歸還",
            "已还",
            "已還",
            "偿还",
            "償還",
        ],
        &["日期", "方式", "安排", "新增", "增加", "利息"],
    ),
    // —— 以下角色不参与形态判定，但可以映射：出表、复核提示、利率推算要用 ——
    r(
        "loanId",
        "借款标识",
        &[
            "借款合同编号",
            "借款合同号",
            "合同编号",
            "合同編號",
            "借款编号",
            "借款編號",
            "借据号",
            "借據號",
            "登记编号",
            "登記編號",
            "合同号",
            "合同號",
            "编号",
            "編號",
            "loanid",
            "contractno",
        ],
        &["序号", "序號", "行号", "行號"],
    ),
    r(
        "lender",
        "贷款方",
        &[
            "贷款银行",
            "貸款銀行",
            "放款银行",
            "放款銀行",
            "贷款机构",
            "貸款機構",
            "贷款人",
            "貸款人",
            "债权人",
            "債權人",
            "出借方",
            "金融机构",
            "金融機構",
            "交易对手",
            "交易對手",
            "承兑行",
            "承兌行",
            "贷款方",
            "貸款方",
            "银行",
            "銀行",
            "lender",
        ],
        &["金额", "金額", "余额", "餘額", "利率", "日期"],
    ),
    r(
        "currency",
        "币种",
        &["币种", "幣種", "币别", "幣別", "货币", "貨幣", "currency"],
        &["金额", "金額", "余额", "餘額", "汇率", "匯率"],
    ),
    r(
        "drawdownDate",
        "新增借款日期",
        &["新增借款日期", "新增日期", "提款日期"],
        &["金额", "金額"],
    ),
    r(
        "repaymentDate",
        "还款日期",
        &[
            "还款日期",
            "還款日期",
            "归还日期",
            "歸還日期",
            "还款日",
            "還款日",
            "归还日",
            "歸還日",
        ],
        &["金额", "金額", "方式"],
    ),
    r(
        "repaymentMethod",
        "还本方式",
        &[
            "还本付息方式",
            "还本方式",
            "還本方式",
            "还款方式",
            "還款方式",
            "还本安排",
            "還本安排",
        ],
        &["日期", "金额", "金額"],
    ),
    r(
        "loanStatus",
        "借款状态",
        &[
            "借款状态",
            "借款狀態",
            "合同状态",
            "合同狀態",
            "存续状态",
            "存續狀態",
            "状态",
            "狀態",
        ],
        &[],
    ),
    r(
        "benchmarkRate",
        "基准利率",
        &["基准利率", "基準利率", "定价基准", "定價基準", "lpr"],
        &["加点", "加點", "类型", "類型"],
    ),
    r(
        "spreadBps",
        "加/减点（BP）",
        &[
            "加减点",
            "加減點",
            "加点",
            "加點",
            "基点",
            "基點",
            "bp",
            "bps",
        ],
        &["基准", "基準", "利率类型"],
    ),
    r(
        "remark",
        "备注",
        &["备注", "備註", "说明", "說明", "摘要", "remark"],
        &["金额", "金額", "日期"],
    ),
];

/// 按标准名取角色定义。
pub(crate) fn role_of(kind: &str, name: &str) -> Option<&'static Role> {
    roles(kind).iter().find(|x| x.name == name)
}

/// `kind` 接受 `"je"`、`"tb"`、`"loan"`，其余一律当作 TB——调用方都是内部代码，
/// 静默兜底比 panic 安全。
pub(crate) fn roles(kind: &str) -> &'static [Role] {
    match kind {
        "je" => je_roles(),
        "loan" => loan_roles(),
        _ => tb_roles(),
    }
}

/// 当前形态下引擎认识的全部角色与中文标签，按角色表顺序去重。
///
/// 标签直接取自 [`Role::label`]，与 [`MissingRole::label`] 同源——映射面板上
/// 「缺哪个角色」的提示和「角色叫什么名字」的对照不会出现两套叫法。
/// 识别建议响应把它原样下发给前端，前端不必再内置一份角色名对照表。
pub(crate) fn role_labels(kind: &str) -> Vec<(&'static str, &'static str)> {
    let mut out: Vec<(&'static str, &'static str)> = Vec::new();
    for role in roles(kind) {
        if !out.iter().any(|(name, _)| *name == role.name) {
            out.push((role.name, role.label));
        }
    }
    out
}

/// 将账表中指定列的空白单元格按源文件行序向下填充。
///
/// 客户 JE 常用合并单元格表示“与上一分录相同”，Excel/CSV 读取后只有合并区域
/// 的首行有值。这个规则必须在凭证分组、分类和校验之前执行。调用方只传允许继承
/// 的非金额列；金额列必须保留空白，否则会凭空复制发生额。
pub(crate) fn forward_fill_columns(
    headers: &[String],
    rows: &mut [Vec<String>],
    columns: &[String],
) -> usize {
    let indexes = columns
        .iter()
        .filter_map(|column| header_index(headers, column))
        .collect::<HashSet<_>>();
    let mut last_values = HashMap::<usize, String>::new();
    let mut filled = 0usize;
    for row in rows {
        for index in &indexes {
            let current = row.get(*index).map(|value| value.trim()).unwrap_or("");
            if current.is_empty() {
                if let (Some(previous), Some(cell)) = (last_values.get(index), row.get_mut(*index))
                {
                    *cell = previous.clone();
                    filled += 1;
                }
            } else {
                last_values.insert(*index, current.to_owned());
            }
        }
    }
    filled
}

/// [`forward_fill_columns`] 的噪声行跳过版：`keep[i] == false` 的行整体透明。
///
/// 合计行/游离数字行（见 [`ledger_junk_mask`]）本没有身份，若照常向下填充会
/// 继承上一行的科目/凭证，摇身变成真分录混进发生额——借款利息的序时账实测
/// 踩过（合计行计入本金变动）。跳过的行**既不接收也不传播**：它们可能把
/// 「合计」写在摘要这类可填充列里，传播出去会把下一个空行也染成合计。
/// 行保留在原位——报表按源表行号溯源，不能删行。
pub(crate) fn forward_fill_columns_skipping(
    headers: &[String],
    rows: &mut [Vec<String>],
    columns: &[String],
    keep: &[bool],
) -> usize {
    let indexes = columns
        .iter()
        .filter_map(|column| header_index(headers, column))
        .collect::<HashSet<_>>();
    let mut last_values = HashMap::<usize, String>::new();
    let mut filled = 0usize;
    for (i, row) in rows.iter_mut().enumerate() {
        if !keep.get(i).copied().unwrap_or(true) {
            continue;
        }
        for index in &indexes {
            let current = row.get(*index).map(|value| value.trim()).unwrap_or("");
            if current.is_empty() {
                if let (Some(previous), Some(cell)) = (last_values.get(index), row.get_mut(*index))
                {
                    *cell = previous.clone();
                    filled += 1;
                }
            } else {
                last_values.insert(*index, current.to_owned());
            }
        }
    }
    filled
}

// ────────────────────────────── 表头归一化与匹配 ──────────────────────────────

/// 表头归一化：去掉空白与各类分隔符，转小写。与 `fx::normalize_header` 行为一致。
pub(crate) fn normalize_header(v: &str) -> String {
    v.to_lowercase().replace(
        [
            ' ', '\n', '\r', '\t', '_', '-', '—', '/', '\\', '（', '）', '(', ')', '．', '.',
        ],
        "",
    )
}

/// 把表头切成语义段。双语表头（`科目描述 Description`、`过账日期\nPosting Date`）
/// 整体不等于任何别名，但其中一段正好是。
///
/// 只按**分隔符**切——换行、空格、括号、斜杠。不按字符类型切，
/// 否则 `GL Account` 会被拆成两个没有意义的碎片。
pub(crate) fn header_segments(header: &str) -> Vec<String> {
    header
        .split([
            '\n', '\r', '\t', ' ', '\u{3000}', '(', ')', '（', '）', '[', ']', '【', '】',
        ])
        .map(normalize_header)
        .filter(|s| !s.is_empty())
        .collect()
}

/// 表头的某一段是否**完整等于**该别名。
pub(crate) fn segment_exact(header: &str, alias: &str) -> bool {
    let target = normalize_header(alias);
    !target.is_empty() && header_segments(header).iter().any(|s| *s == target)
}

/// 该角色是否受集团货币口径排除约束。
///
/// 角色名有两种写法：`functionalAmount` 小写开头，`ytdFunctionalCredit` 驼峰中段。
/// 原先用 `contains("Functional")` 大小写敏感比较，**JE 的三个金额角色一个都匹配不到**，
/// 集团货币排除对序时账从来没生效过——一份只给集团货币金额、不给本位币金额的账
/// 会把它当本位币收下。`functionalCurrency` 一并纳入：集团货币列同样不该被判成本位币。
fn excludes_group_currency(role: &Role) -> bool {
    let lower = role.name.to_lowercase();
    lower.contains("functional") || lower.contains("foreign")
}

/// 一个表头对某角色的匹配强度。`None` 表示不匹配。
///
/// **取最长命中**：`借方金额` 必须落到 `functionalDebit`（别名 `借方金额`，4 字）
/// 而不是被 `functionalAmount` 的别名 `金额`（2 字）抢走。
pub(crate) fn alias_score(role: &Role, header: &str) -> Option<f64> {
    let n = normalize_header(header);
    if n.is_empty() {
        return None;
    }
    if role
        .conflicts
        .iter()
        .any(|c| n.contains(&normalize_header(c)))
    {
        return None;
    }
    // 金额角色只认本位币与原币两套口径，集团货币那一套整体排除。
    if excludes_group_currency(role) && NOT_GROUP.iter().any(|c| n.contains(&normalize_header(c))) {
        return None;
    }
    let mut best: Option<f64> = None;
    for a in role.aliases {
        let na = normalize_header(a);
        if na.is_empty() {
            continue;
        }
        let score = if n == na {
            // 完全相等最强，且长别名优于短别名。
            2.0 + na.chars().count() as f64 / 100.0
        } else if segment_exact(header, a) {
            // 双语表头的某一段正好是别名，比「表头包含别名」更可信。
            1.5 + na.chars().count() as f64 / 100.0
        } else if n.contains(&na) {
            // 表头包含别名。反向（别名包含表头）不算——否则短表头 `原币`
            // 会命中 `原币借方` 这种长别名。
            1.0 + na.chars().count() as f64 / 100.0
        } else {
            continue;
        };
        if best.is_none_or(|b| score > b) {
            best = Some(score);
        }
    }
    best
}

/// 期初与期末的方向列常常**列名完全一样**（都叫「方向 Dr/Cr」），光看名字分不出。
/// 这时按位置分配：靠前的给期初、靠后的给期末——余额表一律按期初、发生、期末排列。
///
/// 实测样例：06 艾维特苏州（Oracle EBS）就是这样两列同名。
fn disambiguate_directions(
    kind: &str,
    headers: &[String],
    assigned: &mut BTreeMap<usize, &'static str>,
) {
    // 方向列是 TB 独有的。序时账没有期初/期末方向；借款台账根本没有方向概念，
    // 掉进来会把「利率类型」这类列按位置硬派成方向列。
    if kind != "tb" {
        return;
    }
    let opening = role_of("tb", "openingDirection").expect("角色存在");
    let closing = role_of("tb", "closingDirection").expect("角色存在");
    // 期初方向已经落到某一列上，说明列名本身就分得开，不必按位置猜。
    if assigned.values().any(|r| *r == "openingDirection") {
        return;
    }
    let mut candidates: Vec<usize> = headers
        .iter()
        .enumerate()
        .filter(|(i, h)| {
            let taken = assigned.get(i).copied();
            // 已经落到别的角色上的列不动，除非它就是期末方向。
            (taken.is_none() || taken == Some("closingDirection"))
                && (alias_score(opening, h).is_some() || alias_score(closing, h).is_some())
        })
        .map(|(i, _)| i)
        .collect();
    if candidates.len() < 2 {
        return;
    }
    candidates.sort_unstable();
    let first = candidates[0];
    let last = *candidates.last().expect("至少两列");
    assigned.insert(first, "openingDirection");
    assigned.insert(last, "closingDirection");
}

/// 对一批表头逐列判定归属角色，返回 `列索引 -> 角色标准名`。
///
/// 同一列可能匹配多个角色，取分数最高者；同一角色被多列命中时，
/// 不可多列的角色只保留最高分那列。
pub(crate) fn suggest_roles(kind: &str, headers: &[String]) -> BTreeMap<usize, &'static str> {
    let all = roles(kind);
    let mut hits: Vec<(usize, &'static str, f64)> = Vec::new();
    for (i, h) in headers.iter().enumerate() {
        let mut best: Option<(&'static str, f64)> = None;
        for role in all {
            if let Some(s) = alias_score(role, h) {
                if best.is_none_or(|(_, b)| s > b) {
                    best = Some((role.name, s));
                }
            }
        }
        if let Some((name, s)) = best {
            hits.push((i, name, s));
        }
    }
    // 高分优先占位，低分让路。
    hits.sort_by(|a, b| {
        b.2.partial_cmp(&a.2)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(a.0.cmp(&b.0))
    });
    let mut used: HashSet<&'static str> = HashSet::new();
    let mut out = BTreeMap::new();
    for (i, name, _) in hits {
        let multi = role_of(kind, name).map(|r| r.multi).unwrap_or(false);
        if !multi && !used.insert(name) {
            continue;
        }
        out.insert(i, name);
    }
    disambiguate_directions(kind, headers, &mut out);
    out
}

/// 一个列对某角色的候选评分。`column` 是列下标，`hits` 是命中的别名（供界面解释理由）。
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Candidate {
    pub(crate) column: usize,
    pub(crate) header: String,
    pub(crate) score: f64,
    pub(crate) hits: Vec<&'static str>,
}

/// 按角色给出候选列清单，分数从高到低。
///
/// 与 [`suggest_roles`] 的区别：这里**不做占位裁决**，同一列可以出现在多个角色的
/// 候选里，由调用方结合自己的数据形态打分再定夺。汇兑损益那种带列画像评分的工具
/// 用这个，只要一个结论的工具用 [`suggest_roles`]。
pub(crate) fn score_columns(
    kind: &str,
    headers: &[String],
) -> BTreeMap<&'static str, Vec<Candidate>> {
    let mut out: BTreeMap<&'static str, Vec<Candidate>> = BTreeMap::new();
    for role in roles(kind) {
        let mut list: Vec<Candidate> = Vec::new();
        for (i, h) in headers.iter().enumerate() {
            let Some(score) = alias_score(role, h) else {
                continue;
            };
            let n = normalize_header(h);
            let hits: Vec<&'static str> = role
                .aliases
                .iter()
                .filter(|a| {
                    let na = normalize_header(a);
                    !na.is_empty() && n.contains(&na)
                })
                .copied()
                .collect();
            list.push(Candidate {
                column: i,
                header: h.clone(),
                score,
                hits,
            });
        }
        list.sort_by(|a, b| {
            b.score
                .partial_cmp(&a.score)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then(a.column.cmp(&b.column))
        });
        if !list.is_empty() {
            out.insert(role.name, list);
        }
    }
    out
}

/// 天然可以和别的角色共用一列的角色。
///
/// `currencyText` 不是一个独立语义，而是「去哪一列找币种线索」的**指针**：
/// 很多表的账户币种就写在科目名称里（`银行存款-中行朝阳支行美元户`），
/// 这时它必须指向科目名称列，下游才能从文本里抽出币种。
/// 只有当表里另有独立的文本/备注列时，两者才会分开。
const SHARED_COLUMN_ROLES: &[&str] = &["currencyText"];

/// 同一列被多个角色选中时，判定哪些角色该放弃它。
///
/// 汇兑损益与存款利息给每个角色独立挑最高分列，谁也不知道别人挑了什么，
/// 于是「本位币」这种列名会同时落到「本位币净额」和「本位币标识」上。
/// 一列只承载一个语义，**分数高的留下，其余放弃**。
///
/// 可多列的角色（科目名称、凭证识别字段）会为它的每一列各传一条 `picks`：
/// 那些列同样参与独占——只是该角色被挤掉某一列时，丢的是那一列而不是整个角色。
///
/// 入参是 `(角色, 列名, 分数)`，返回需要放弃的 `(角色, 列名)`。
pub(crate) fn conflicting_roles(
    kind: &str,
    picks: &[(String, String, f64)],
) -> Vec<(String, String)> {
    let mut ranked: Vec<&(String, String, f64)> = picks
        .iter()
        .filter(|(role, _, _)| !SHARED_COLUMN_ROLES.contains(&role.as_str()))
        .collect();
    ranked.sort_by(|a, b| {
        b.2.partial_cmp(&a.2)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(a.0.cmp(&b.0))
            .then(a.1.cmp(&b.1))
    });
    let mut taken: HashSet<&str> = HashSet::new();
    let mut give_up = Vec::new();
    for (role, column, _) in ranked {
        if !taken.insert(column.as_str()) {
            give_up.push((role.clone(), column.clone()));
        }
    }
    give_up
}

/// 每个工具各自启用哪些角色。
///
/// 角色留在标准表里不等于每个工具都要用它——工具只声明自己需要的那一部分，
/// 映射面板据此决定显示哪些格子、哪些必填。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Tool {
    /// 汇兑损益：唯一启用原币口径的工具。
    FxAudit,
    /// 存款利息。
    DepositInterest,
    /// 借款利息。
    LoanInterest,
    /// 看账与正负数凭证标记（只读序时账）。
    Ledger,
    /// 固定资产底稿（TBJE 勾稽）：一张 TB 加一张序时账。
    FaTbje,
}

impl Tool {
    /// 该工具在这张表上必须映射的角色。
    ///
    /// 金额／余额槽（期初、期末、金额方案）不在这里声明——它们的「净额或借贷
    /// 分列二选一」由形态槽（[`resolve_form`]）把关，平铺列表表达不了这种或然。
    pub(crate) fn required(self, kind: &str) -> &'static [&'static str] {
        match (self, kind) {
            (Tool::FxAudit, "je") => &["date", "id", "accountCode", "currency"],
            (Tool::FxAudit, _) => &["accountCode"],
            (Tool::DepositInterest, "je") => &["date", "accountCode"],
            (Tool::DepositInterest, _) => &["accountCode"],
            (Tool::LoanInterest, "je") => &["date", "accountCode"],
            (Tool::LoanInterest, _) => &["accountCode"],
            (Tool::Ledger, "je") => &["id", "accountCode"],
            (Tool::Ledger, _) => &["accountCode"],
            // 固定资产底稿自己的必填：TB 要科目＋期初＋期末，JE 要凭证号＋日期＋
            // 科目＋金额方案——除科目（金标身份槽）与凭证号／日期外，余额与金额
            // 方案都交给形态槽，与 fa_tbje 原 `validate_required` 的口径一致。
            (Tool::FaTbje, "je") => &["date", "id", "accountCode"],
            (Tool::FaTbje, _) => &["accountCode"],
        }
    }

    /// 该工具是否启用原币口径。只有汇兑损益需要——其余工具的原币列
    /// 即便映射了也不参与计算，不如不显示。
    pub(crate) fn uses_foreign(self) -> bool {
        matches!(self, Tool::FxAudit)
    }
}

/// 金标（`TB-4800.xlsx` 的 `je种类` / `tb种类` 两张表）要求的身份字段。
///
/// 与形态无关——同一张表的所有型号要求同一组身份字段，所以不放进 [`Form`]。
/// `entity` 是可选：金标 2026-08-24 修订时把它从 required 降为可选，
/// 汇兑损益仍然自己要求它（或用固定主体顶替），那是工具层加严。
pub(crate) fn identity_required(kind: &str) -> &'static [&'static str] {
    // 借款台账不是账表，没有金标身份槽——必填全部由形态（[`loan_forms`]）决定。
    if kind == "loan" {
        return &[];
    }
    if kind == "je" {
        &["date", "id", "accountCode", "accountName", "summary"]
    } else {
        &["accountCode", "accountName"]
    }
}

/// 一条缺失的必填项，带上**是谁在要求**。
///
/// 被拦下时用户要能分辨缺的是「金标要求的账表完整性」还是「本工具算这个必须有的
/// 字段」——两者都硬阻断，但前者该去找客户补资料，后者是换个工具就不需要。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct MissingRole {
    pub(crate) role: &'static str,
    pub(crate) label: &'static str,
    /// `true` ＝ 金标要求（账表完整性），`false` ＝ 本工具要求。
    pub(crate) from_gold: bool,
}

/// 校验必填角色：**金标身份槽 ∪ 金额形态槽 ∪ 工具自己声明**，三者都硬阻断。
///
/// 同一个角色被两边都要求时只报一条，且标为金标——它是更底层的要求。
pub(crate) fn missing_required(tool: Tool, kind: &str, mapped: &HashSet<&str>) -> Vec<MissingRole> {
    let mut out: Vec<MissingRole> = Vec::new();
    let mut push = |role: &'static str, from_gold: bool| {
        if mapped.contains(role) || out.iter().any(|m| m.role == role) {
            return;
        }
        if let Some(r) = role_of(kind, role) {
            out.push(MissingRole {
                role,
                label: r.label,
                from_gold,
            });
        }
    };
    for role in identity_required(kind) {
        push(role, true);
    }
    // 金额／余额形态：型号本身来自金标，缺的槽位一律算金标要求。
    if let FormVerdict::Incomplete(best) = resolve_form(kind, mapped) {
        for role in best.missing {
            push(role, true);
        }
    }
    for role in tool.required(kind) {
        push(role, false);
    }
    out
}

/// 只要中文标签的简版，供只需展示的调用方使用。
pub(crate) fn missing_required_labels(
    tool: Tool,
    kind: &str,
    mapped: &HashSet<&str>,
) -> Vec<&'static str> {
    missing_required(tool, kind, mapped)
        .into_iter()
        .map(|m| m.label)
        .collect()
}

// ────────────────────────────── 余额与发生额的折算 ──────────────────────────────
//
// 六种 TB 形态、三种 JE 形态，取一个科目的期初余额有六种写法。工具不该逐个分支，
// 而是把映射到的原始值交给这里，拿回**统一的有符号净额（借正贷负）**。

/// 一个时点（期初或期末）或一段发生额在表里的原始取值。按形态只会填其中一组。
#[derive(Clone, Debug, Default)]
pub(crate) struct AmountInputs {
    /// 净额列（TB1/TB2/TB4/TB5、JE2/JE3）。
    pub(crate) amount: Option<f64>,
    /// 借方列（TB3/TB6、JE1）。
    pub(crate) debit: Option<f64>,
    /// 贷方列。
    pub(crate) credit: Option<f64>,
    /// 方向列原文（TB2/TB5、JE2）。空表示没有方向列。
    pub(crate) direction: Option<String>,
}

impl AmountInputs {
    /// 这一组是否有任何取值——全空说明该形态槽位没映射。
    pub(crate) fn is_empty(&self) -> bool {
        self.amount.is_none() && self.debit.is_none() && self.credit.is_none()
    }
}

/// 折算成有符号净额：**借为正、贷为负**。
///
/// `convention` 决定贷方列怎么合并——它由 [`tb_sign_evidence`] 或
/// [`je_sign_evidence_debit_credit`] 判出来，不要在这里猜。
///
/// 三条规则，对应三种形态：
/// 1. 借贷分列 → `借 + s·贷`（`s` 由符号口径给出）；
/// 2. 净额＋方向 → 「符号一样」时按方向定正负，「已带符号」时直接取原值；
/// 3. 只有净额 → 原值即净额（借正贷负是它成立的前提）。
pub(crate) fn signed_amount(v: &AmountInputs, convention: SignConvention) -> f64 {
    if v.debit.is_some() || v.credit.is_some() {
        let dr = v.debit.unwrap_or(0.0);
        let cr = v.credit.unwrap_or(0.0);
        return match convention {
            SignConvention::Unsigned => dr - cr,
            // 已带符号：借贷同行时两边相减仍然成立，单边时取有值那侧原值。
            SignConvention::Signed => {
                if dr != 0.0 && cr != 0.0 {
                    dr - cr
                } else if dr != 0.0 {
                    dr
                } else {
                    cr
                }
            }
        };
    }
    let amount = v.amount.unwrap_or(0.0);
    match (&v.direction, convention) {
        // 贷方行**乘 −1，保留原符号**，不能写成 `-abs()`。
        //
        // 红字冲销的贷方行本身就记负数（贷 −50 表示冲掉之前那笔贷 50）：
        // 乘 −1 得 +50，与原来那笔 −50 相加归零，冲销凭证才平得掉；
        // 写成 `-abs()` 会得到 −50，和被冲的那笔同号，两笔永远抵不掉。
        // 这是看账小工具当年踩过的坑，统一时以它的写法为准。
        (Some(d), SignConvention::Unsigned) if !d.trim().is_empty() => {
            if is_credit_direction(d) {
                -amount
            } else {
                amount
            }
        }
        _ => amount,
    }
}

/// 科目余额表**余额列**的折算。`self_signed` 为真时忽略方向列，取数值原样。
///
/// 04／05 号样例的余额列自带负号（应付票据期初 −28,138,279.04），旁边还并排
/// 一个写着「贷」的方向列；而同一张表的**发生额列是正数**，符号口径按发生额
/// 投票只能判出 unsigned。拿这个口径去折算余额，负债和权益整片翻成正数，
/// 会计恒等式差出两倍资产。
///
/// `self_signed` 必须**按整列判**，不能按行看「这个数是不是负的」：08 号样例
/// 是标准的「绝对值＋方向」，但个别科目有异常余额（方向记贷、数值为负），
/// 按行判会把这些行漏翻，合计差出一亿七。判定见 `fx::ensure_balance_sign_mode`。
///
/// 这条规则只对余额列成立：**余额不存在红字冲销**。序时账的贷方行记 −50 表示
/// 冲掉之前那笔贷 50，必须乘 −1 得 +50 才抵得平——那种场景仍走 [`signed_amount`]。
pub(crate) fn signed_balance(
    v: &AmountInputs,
    convention: SignConvention,
    self_signed: bool,
) -> f64 {
    if !self_signed || v.debit.is_some() || v.credit.is_some() {
        return signed_amount(v, convention);
    }
    v.amount.unwrap_or(0.0)
}

/// 按借贷**两侧**拆开的取数：`(借方, 贷方)`，各自保留正负。
///
/// [`signed_amount`] 折成净额会丢掉「这笔落在哪一侧」：红字冲销的贷方行记
/// −467.02，净额是 +467.02，下游按符号归侧就翻进了借方——借贷两侧同时虚增
/// （08 号样例实测就是这么差出 467.02×2 的）。**与余额表列合计对数**的场景
/// 要的不是净额而是两侧各多少：借还是贷由列（或方向列）决定，数字的正负留在
/// 本侧冲减，与在 Excel 里对列求和看到的口径一致。
///
/// 1. 借贷分列 → 各归各侧；「已带符号」口径下贷方列记的是借正贷负值，翻回正数；
/// 2. 净额＋方向 → 原始方向定侧，红字只在原侧冲减；已带符号口径仅把贷方
///    换算成「正常贷方为正、贷方红字为负」，绝不按金额正负改判借贷；
/// 3. 净额且没有方向列 → 只剩符号这一条线索，按正负归侧。
pub(crate) fn side_amounts(v: &AmountInputs, convention: SignConvention) -> (f64, f64) {
    if v.debit.is_some() || v.credit.is_some() {
        let (dr, cr) = (v.debit.unwrap_or(0.0), v.credit.unwrap_or(0.0));
        return match convention {
            SignConvention::Unsigned => (dr, cr),
            // 贷方列记的已是借正贷负净额，翻回贷方正数；红字（正值）翻成负数冲减。
            SignConvention::Signed => (dr, -cr),
        };
    }
    let amount = v.amount.unwrap_or(0.0);
    match &v.direction {
        Some(d) if !d.trim().is_empty() => {
            if is_credit_direction(d) {
                let credit = match convention {
                    SignConvention::Unsigned => amount,
                    SignConvention::Signed => -amount,
                };
                (0.0, credit)
            } else {
                (amount, 0.0)
            }
        }
        _ if amount >= 0.0 => (amount, 0.0),
        _ => (0.0, -amount),
    }
}

/// 余额列是不是**整列自带符号**（并排的方向列只是冗余标注）。
///
/// `prefix` 传金额角色的前缀，如 `openingFunctional`；方向角色名由它剥掉币种
/// 口径后拼出（`openingDirection`），原币与本位币共用同一个方向列。
///
/// 判据：方向列写着「贷」的那些行里，余额是负数的占多数。
/// 04／05 号样例几乎全为负——列本身带符号，方向只是冗余；
/// 02／08／09 号几乎全为正——标准的「绝对值＋方向」，个别异常余额是少数。
///
/// **必须整列判**。按行看「这个数是不是负的」会把 08 号样例里的异常余额
/// （方向记贷、数值为负）漏翻，合计差出一亿七。
///
/// 借贷分列的形态没有方向列可言，直接返回 false。
pub(crate) fn balance_self_signed(
    headers: &[String],
    rows: &[Vec<String>],
    column_of: &dyn Fn(&str) -> Vec<String>,
    prefix: &str,
) -> bool {
    let index_of = |role: &str| -> Option<usize> {
        column_of(role)
            .into_iter()
            .find_map(|name| header_index(headers, &name))
    };
    if index_of(&format!("{prefix}Debit")).is_some() {
        return false;
    }
    let Some(amount_index) = index_of(&format!("{prefix}Amount")) else {
        return false;
    };
    let base = prefix
        .strip_suffix("Functional")
        .or_else(|| prefix.strip_suffix("Foreign"))
        .unwrap_or(prefix);
    let Some(direction_index) =
        index_of(&format!("{base}Direction")).or_else(|| index_of("direction"))
    else {
        return false;
    };
    let (mut credit_rows, mut negative_rows) = (0usize, 0usize);
    for row in rows {
        let direction = row.get(direction_index).map(String::as_str).unwrap_or("");
        if direction.trim().is_empty() || !is_credit_direction(direction) {
            continue;
        }
        let Some(value) = parse_amount(row.get(amount_index).map(String::as_str).unwrap_or(""))
            .ok()
            .flatten()
        else {
            continue;
        };
        if value == 0.0 {
            continue;
        }
        credit_rows += 1;
        if value < 0.0 {
            negative_rows += 1;
        }
    }
    credit_rows > 0 && negative_rows * 2 > credit_rows
}

/// 负债类科目的余额惯例是贷方为正（借款本金、应付账款）。
/// 业务层拿到有符号净额后用它翻个面，不必各自记住符号。
pub(crate) fn credit_positive(signed: f64) -> f64 {
    -signed
}

/// 界面的科目分类清单按整行取值生成，天然包含非末级汇总科目；而 TB 业务
/// 计算只读末级行（见 [`tb_leaf_mask`]）。用户在「6603 财务费用」这样的汇总
/// 行上手工指定的角色，靠**编码前缀继承**落到末级行：找编码是本科目严格
/// 前缀的最近上级，取最长前缀（最具体的上级优先）。
///
/// 仅限**纯数字编码**参与：科目首词是普通文本时，`starts_with` 的偶然前缀
/// （「利息」不是「利息收入」的上级）会误继承。也只应在自动识别给不出结论
/// 时调用——自动有结论的科目不该被上级的指定覆盖。
pub(crate) fn inherited_role_by_code_prefix<'a>(
    code: &str,
    roles: impl Iterator<Item = (&'a str, &'a str)>,
    key_of: impl Fn(&str) -> &str,
) -> Option<String> {
    if code.is_empty() || !code.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    roles
        .filter_map(|(candidate, role)| {
            let parent = key_of(candidate);
            let usable = !parent.is_empty()
                && parent.chars().all(|c| c.is_ascii_digit())
                && parent.len() < code.len()
                && code.starts_with(parent);
            (usable && !role.is_empty() && role != "unassigned").then_some((parent, role))
        })
        .max_by(|(a, _), (b, _)| a.len().cmp(&b.len()))
        .map(|(_, role)| role.to_owned())
}

/// TB 的金额角色全集。汇总行勾稽按这些列取数——多一列参与比较，
/// 「两行金额碰巧相等」的误判概率就低一个量级。
const TB_AMOUNT_ROLES: &[&str] = &[
    "openingFunctionalAmount",
    "openingFunctionalDebit",
    "openingFunctionalCredit",
    "openingForeignAmount",
    "openingForeignDebit",
    "openingForeignCredit",
    "closingFunctionalAmount",
    "closingFunctionalDebit",
    "closingFunctionalCredit",
    "closingForeignAmount",
    "closingForeignDebit",
    "closingForeignCredit",
    "ytdFunctionalDebit",
    "ytdFunctionalCredit",
    "ytdForeignDebit",
    "ytdForeignCredit",
    "periodFunctionalAmount",
    "periodFunctionalDebit",
    "periodFunctionalCredit",
];

/// 汇总行勾稽向前／向后最多扫描多少行。一个一级科目下的明细行数远小于这个数，
/// 放大只会增加「偶然凑出相等」的机会。
const ROLLUP_SCAN_LIMIT: usize = 4096;

/// 金额相等的判定。TB 金额都是两位小数，半分钱的容差足够吸收浮点误差，
/// 又不会把真实差异（最小 0.01）判成相等。
fn amounts_equal(a: f64, b: f64) -> bool {
    (a - b).abs() <= 0.005
}

/// `parent` 是不是 `code` 的上级编码。
///
/// 要求真前缀，且切口落在**分隔符边界**上：`1002.1` 不是 `1002.10` 的上级。
/// 纯数字定长编码（`1002` → `10020001`）没有分隔符可依，按数字续接放行——
/// 这类科目表的层级本来就只能靠位数表达。
fn is_ancestor_code(parent: &str, code: &str) -> bool {
    if parent.is_empty() || parent.len() >= code.len() || !code.starts_with(parent) {
        return false;
    }
    let Some(next) = code[parent.len()..].chars().next() else {
        return false;
    };
    !next.is_alphanumeric() || (parent.chars().all(|c| c.is_ascii_digit()) && next.is_ascii_digit())
}

/// 整格就是一个合计标签。
///
/// **必须整格相等**：`试剂耗材合计` 是 10 号样例里真实存在的末级科目名，
/// 用「包含合计二字」去判会把它连同余额一起删掉。带连接符的后缀
/// （`交易性金融资产-小计`）是另一回事，那种写法不可能是科目本名。
///
/// 五类报表小计（`资产小计`／`负债小计`／`权益小计`／`成本小计`／`损益小计`）
/// 收编自汇兑损益的 `is_summary_account`——科目分类清单要剔掉这类手工汇总行，
/// 这份判据不该只在汇兑损益里有一份。
pub(crate) fn is_rollup_label(value: &str) -> bool {
    const LABELS: &[&str] = &[
        "合计",
        "總計",
        "总计",
        "小计",
        "小計",
        "本期合计",
        "本年合计",
        "损益小计",
        "損益小計",
        "资产小计",
        "資產小計",
        "负债小计",
        "負債小計",
        "权益小计",
        "權益小計",
        "成本小计",
        "成本小計",
        "累计",
        "total",
        "subtotal",
        "grand total",
    ];
    let v = value
        .trim()
        .trim_end_matches(['：', ':', '.', '。', '、'])
        .trim();
    if v.is_empty() {
        return false;
    }
    LABELS.iter().any(|label| v.eq_ignore_ascii_case(label))
        || ["-小计", "－小计", "-合计", "－合计", "-小計", "-總計"]
            .iter()
            .any(|suffix| v.ends_with(suffix))
}

/// 序时账的金额角色。与 [`TB_AMOUNT_ROLES`] 合起来构成「这一列是不是金额」的全集。
const JE_AMOUNT_ROLES: &[&str] = &[
    "functionalAmount",
    "functionalDebit",
    "functionalCredit",
    "foreignAmount",
    "foreignDebit",
    "foreignCredit",
];

/// 判定一行有没有「身份」的角色：凭证识别字段、科目编码、科目名称、日期。
///
/// **摘要不算身份**。10 号样例合计行下面的手工草稿区里，摘要列写着
/// 「账面补提」「以前年度损益」，把摘要算进来这些垃圾行就赖着不走了。
const IDENTITY_ROLES: &[&str] = &["id", "accountCode", "accountName", "account", "date"];

/// Excel 公式残值。03 号样例的科目名称列是用户自建的 VLOOKUP，
/// 数据行里也会出现 `#N/A`；10 号样例草稿区最后一行是 `#REF!`。
/// 这些格子有内容但没信息，判身份时必须当空看。
fn is_formula_error(value: &str) -> bool {
    matches!(
        value.trim(),
        "#N/A" | "#REF!" | "#VALUE!" | "#DIV/0!" | "#NAME?" | "#NULL!" | "#NUM!" | "#SPILL!"
    )
}

fn is_report_footer_value(value: &str) -> bool {
    let compact = value.trim().replace(' ', "");
    [
        "核算单位：",
        "核算单位:",
        "制单人：",
        "制单人:",
        "打印时间：",
        "打印时间:",
    ]
    .iter()
    .any(|prefix| compact.starts_with(prefix))
}

/// 标记账表里**没有身份的噪声行**。返回值与 `rows` 一一对应：`true` 表示该行要算。
///
/// 剔两类，都是实测样例里静默污染合计的：
///
/// 1. **游离数字行**：凭证号、科目、日期全空，却填着金额。02 号样例的序时账有
///    三行这种，**其中两行埋在二十多万行的表体中间**，不带任何「合计」字样；
///    03 号样例是 SAP 的 ALV 分组小计，每个科目两行，标签写在一个没映射的列里。
///    关键词法对这两种完全无效，只能按「有钱没身份」判。
/// 2. **表尾噪声**：从最后一行往前扫，直到遇见第一个有身份的行为止。10 号样例的
///    序时账在合计行后面还跟着十五行审计人手工草稿（最后一行是 `#REF!`），
///    09 号样例合计行后面是「制单人 / 打印时间」页脚。**只从表尾扫**——
///    06 号样例的 `-小计` 就在表体中间，从中间截断会把后面的账全丢掉。
/// 3. **空行后的非正文**：只有整行全空才形成分隔；分隔后必须等到科目编码、
///    科目名称与可解析金额三项齐备，才重新进入正文。
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct LedgerRowAnalysis {
    /// 与源表数据行一一对应；`true` 表示该行属于正文，应交给业务模块继续处理。
    pub(crate) keep: Vec<bool>,
    /// 映射到科目编码列、但取值不符合编码语法的正文行（0 基下标、原始值）。
    pub(crate) invalid_account_code_rows: Vec<(usize, String)>,
}

/// 分析序时账正文边界与必要字段完整性。
///
/// 整行全空才构成正文分隔符。出现分隔符后，只有同时具备科目编码、科目名称和
/// 至少一个可解析金额（借方、贷方或单一金额）的行，才能重新开启下一段正文。
/// 这样既能截掉 10 号样例尾部错位进科目列的 `2556.54`，也不会把表体中仅仅
/// 少了日期或凭证号的真实分录误当页脚。
pub(crate) fn analyze_ledger_rows(
    headers: &[String],
    rows: &[Vec<String>],
    column_of: &dyn Fn(&str) -> Vec<String>,
) -> LedgerRowAnalysis {
    let indexes = |roles: &[&str]| {
        let mut v = roles
            .iter()
            .flat_map(|role| column_of(role))
            .filter_map(|name| header_index(headers, &name))
            .collect::<Vec<_>>();
        v.sort_unstable();
        v.dedup();
        v
    };
    let identity_indexes = indexes(IDENTITY_ROLES);
    let amount_indexes = indexes(&[TB_AMOUNT_ROLES, JE_AMOUNT_ROLES].concat());
    let je_amount_indexes = indexes(JE_AMOUNT_ROLES);
    let mut account_code_indexes = indexes(&["accountCode"]);
    let mut account_name_indexes = indexes(&["accountName"]);
    // 兼容历史映射：旧版把编码与名称依次放进 `account` 多列角色。
    let legacy_account_indexes = indexes(&["account"]);
    if account_code_indexes.is_empty() {
        account_code_indexes.extend(legacy_account_indexes.first().copied());
    }
    if account_name_indexes.is_empty() {
        account_name_indexes.extend(legacy_account_indexes.iter().skip(1).copied());
    }
    // 身份列都没映射就无从判断，一行不删。
    if identity_indexes.is_empty() {
        return LedgerRowAnalysis {
            keep: vec![true; rows.len()],
            invalid_account_code_rows: Vec::new(),
        };
    }
    // 合计标签不是身份。各家把「合计」写在哪一列全凭喜好——10 号样例写在日期列，
    // 07 号样例写在科目编码列。认它作身份，表尾倒扫就会停在合计行上，
    // 后面那串手工草稿反而留下来了。
    let has_identity = |row: &Vec<String>| {
        identity_indexes.iter().any(|index| {
            row.get(*index).map(|v| v.trim()).is_some_and(|v| {
                !v.is_empty()
                    && !is_formula_error(v)
                    && !is_rollup_label(v)
                    && !is_report_footer_value(v)
            })
        })
    };
    let has_amount = |row: &Vec<String>| {
        amount_indexes.iter().any(|index| {
            row.get(*index)
                .and_then(|v| parse_amount(v).ok().flatten())
                .is_some_and(|v| v.abs() > 0.005)
        })
    };

    let mut keep = rows
        .iter()
        .map(|row| has_identity(row) || !has_amount(row))
        .collect::<Vec<bool>>();
    // 表尾噪声：倒着扫到第一个有身份的行就停手。
    for index in (0..rows.len()).rev() {
        if has_identity(&rows[index]) {
            break;
        }
        keep[index] = false;
    }

    let has_field = |row: &[String], positions: &[usize]| {
        positions.iter().any(|index| {
            row.get(*index)
                .map(|value| value.trim())
                .is_some_and(|value| {
                    !value.is_empty() && !is_formula_error(value) && !is_rollup_label(value)
                })
        })
    };
    let has_parseable_je_amount = |row: &[String]| {
        je_amount_indexes.iter().any(|index| {
            row.get(*index).is_some_and(|value| {
                !value.trim().is_empty() && parse_amount(value).is_ok_and(|amount| amount.is_some())
            })
        })
    };

    // 只有 JE 三类必要角色都已映射时才启用业务行协议。TB 也共用
    // `ledger_junk_mask`，不能拿 JE 的业务行协议去截余额表。
    //
    // 是否属于 JE 只看映射列：科目编码、科目名称和至少一个可解析金额三项
    // 齐备才纳入。凭证号、备注、任意其他列有值都不能把残留行放进正文；整行
    // 空白仍是明确的段落分隔符，分隔后同样按这三项重新识别。
    let boundary_enabled = !account_code_indexes.is_empty()
        && !account_name_indexes.is_empty()
        && !je_amount_indexes.is_empty();
    if boundary_enabled {
        for (index, row) in rows.iter().enumerate() {
            if row.iter().all(|value| value.trim().is_empty()) {
                keep[index] = false;
                continue;
            }
            keep[index] = has_field(row, &account_code_indexes)
                && has_field(row, &account_name_indexes)
                && has_parseable_je_amount(row);
        }
    }

    // 科目编码必须是含数字的 ASCII 字母数字串，可用点号或连字符分级。
    // `下·` 这类版式标签不能成为科目，更不能进入勾稽或导出；混写的
    // `1001/库存现金` 先拆出编码再校验。
    let mut invalid_account_code_rows = Vec::new();
    if let Some(code_index) = account_code_indexes.first().copied() {
        for (index, row) in rows.iter().enumerate() {
            if !keep.get(index).copied().unwrap_or(false) {
                continue;
            }
            let raw = row.get(code_index).map(String::as_str).unwrap_or("").trim();
            if raw.is_empty() || is_rollup_label(raw) || is_formula_error(raw) {
                continue;
            }
            let code = account_code_of(raw);
            if !looks_like_account_code(&code) {
                keep[index] = false;
                invalid_account_code_rows.push((index, raw.to_owned()));
            }
        }
    }
    LedgerRowAnalysis {
        keep,
        invalid_account_code_rows,
    }
}

pub(crate) fn ledger_junk_mask(
    headers: &[String],
    rows: &[Vec<String>],
    column_of: &dyn Fn(&str) -> Vec<String>,
) -> Vec<bool> {
    analyze_ledger_rows(headers, rows, column_of).keep
}

/// 标记 TB 中应当计入的明细行。返回值与 `rows` 一一对应：`true` 表示该行要算。
///
/// 汇总行有三条互补的识别路径，缺一条就会有一类样例静默算重：
///
/// 1. **编码层级**：同一主体内 `1002` 与 `10020001` 并存时形成父子候选，
///    但只有期初、期末、借方、贷方的语义金额都可靠勾稽才排除父项。
/// 2. **合计标签**：科目编码列或名称列整格写着「合计」「损益小计」。
/// 3. **金额勾稽**：某行在**所有**已映射金额列上都等于相邻连续若干行之和。
///    这条覆盖前两条都够不着的形态——父行与辅助核算明细行**编码完全相同**
///    （`1121.01` 既是银行承兑汇票汇总行，也是它下面每个客户的明细行）、
///    父子编码分列写、小计行编码列留空。
///
/// 勾稽成立时，同编码的汇总／辅助明细保留汇总行；核算维度明细没有编码时
/// 同样保留有编码的父行；反过来小计行没有编码而明细行有，就删小计行。
/// 同一编码因币种拆成多行时按币种隔离，互不构成汇总关系。
///
/// 所有读取 TB 的工具都必须调用这里，业务模块不得各自实现一份“末级科目”规则。
pub(crate) fn tb_leaf_mask(
    headers: &[String],
    rows: &[Vec<String>],
    column_of: &dyn Fn(&str) -> Vec<String>,
) -> Vec<bool> {
    let indexes = |role: &str| {
        column_of(role)
            .iter()
            .filter_map(|name| header_index(headers, name))
            .collect::<Vec<_>>()
    };
    let mut account_indexes = indexes("accountCode");
    if account_indexes.is_empty() {
        // 兼容历史映射：旧版把编码与名称一起放在 `account` 多列角色里，
        // 第一列按既有约定是编码列。
        account_indexes = indexes("account");
        account_indexes.truncate(1);
    }
    let amount_indexes = {
        let mut v = TB_AMOUNT_ROLES
            .iter()
            .flat_map(|role| indexes(role))
            .collect::<Vec<_>>();
        v.sort_unstable();
        v.dedup();
        v
    };
    // 编码与金额都没有映射，无从判断层级，一行不删。
    if account_indexes.is_empty() && amount_indexes.is_empty() {
        return vec![true; rows.len()];
    }
    let entity_indexes = indexes("entity");
    let joined = |row: &[String], positions: &[usize]| {
        positions
            .iter()
            .filter_map(|index| row.get(*index))
            .map(|value| value.trim())
            .filter(|value| !value.is_empty())
            .collect::<Vec<_>>()
            .join("\u{1f}")
            .to_uppercase()
    };
    // 编码与名称混写在一格时（03 号样例整张表只有这一列科目），层级判断要用
    // 拆出来的编码——`1001/库存现金` 不是 `1001010000:库存现金-人民币` 的前缀，
    // 但 `1001` 确实是 `1001010000` 的上级。
    let identities = rows
        .iter()
        .map(|row| {
            (
                joined(row, &entity_indexes),
                account_code_of(&joined(row, &account_indexes)),
            )
        })
        .collect::<Vec<_>>();
    // 有些 ERP 的上级科目编码并不是下级编码的字面前缀（真实 03 号样例：
    // 一级 `5302` 对应二级 `5301020000`），但表内另有可靠的「级次」列。
    // 级次仅作为父子结构证据，仍须所有语义金额完整勾稽才会排除汇总行。
    let level_index = headers.iter().position(|header| {
        matches!(
            normalize_header(header).as_str(),
            "级次" | "科目级次" | "层级" | "科目层级" | "级别" | "科目级别"
        )
    });
    let levels = rows
        .iter()
        .map(|row| {
            level_index
                .and_then(|index| row.get(index))
                .and_then(|value| value.trim().parse::<u32>().ok())
        })
        .collect::<Vec<_>>();

    // ⓪ 没有身份的噪声行先剔掉，再谈层级——否则表尾那串只有金额的草稿行
    // 会混进勾稽，凑出根本不存在的父子关系。
    let mut rollup = ledger_junk_mask(headers, rows, column_of)
        .into_iter()
        .map(|keep| !keep)
        .collect::<Vec<bool>>();

    // ① 编码前缀只作为后面金额勾稽的结构证据，不能在这里直接删除父项。
    // 03 号样例的 `5302` 父项自身有余额而下级全为零：看到更长编码就剔除父项，
    // 会把真实余额静默丢掉并制造 BS/PL 不平。金额无法完整勾稽时必须原样保留。

    // ② 合计标签。编码列与名称列都看——各家系统把「合计」写在哪一列全凭喜好。
    let label_indexes = {
        let mut v = account_indexes.clone();
        v.extend(indexes("accountName"));
        v.sort_unstable();
        v.dedup();
        v
    };
    for (index, row) in rows.iter().enumerate() {
        if label_indexes
            .iter()
            .filter_map(|i| row.get(*i))
            .any(|value| is_rollup_label(value))
        {
            rollup[index] = true;
        }
    }

    // ③ 金额勾稽。余额必须先折成借正贷负的净额再比较，发生额仍按借、贷
    // 两侧分别比较。01 号样例的父行把期初 150 借 / 50 贷净额列成 100 借，
    // 辅助核算明细却保留两侧毛额；逐原始列比较会漏掉这层汇总并把发生额算重。
    if amount_indexes.len() >= 2 {
        let values = rollup_value_columns(headers, rows, column_of);
        // 同一科目按币种拆成多行时，各行之间是**平行**关系，不是父子。02 号样例
        // 有一批科目的 CNY 行与 USD 行四个金额列数值完全相同（只有方向列一个
        // 记贷一个记借），光比金额会把 CNY 行判成 USD 行的汇总。
        //
        // 只用币种列判，**不能用方向列**：04／05 号样例的小计行方向列是空的，
        // 拿方向来卡会把那边真正的小计行放过去。
        let currency_indexes = {
            let mut v = indexes("currency");
            v.extend(indexes("functionalCurrency"));
            v.sort_unstable();
            v.dedup();
            v
        };
        let currencies = rows
            .iter()
            .map(|row| joined(row, &currency_indexes))
            .collect::<Vec<_>>();
        if values.len() >= 2 {
            // 全零的父科目即使不等于下级发生额之和，排除它也不会造成
            // 任何金额丢失。存款利息等只需末级科目的工具依赖这条：
            // `6603` 零值汇总行不进测算，`66030101` 末级行仍保留。
            mark_zero_value_parents(&identities, &currencies, &levels, &values, &mut rollup);
            mark_rollup_by_sum(&identities, &currencies, &levels, &values, &mut rollup);
            // 真实TB常有多层结构：辅助明细先汇成末级科目，末级科目再汇成上级。
            // 第一轮先锁住同编码的局部关系；随后仅拿仍保留的行再勾稽，由内向外
            // 折叠。每轮都映射回原始行号，源数据和导出行号不变。
            for _ in 0..4 {
                let kept = rollup
                    .iter()
                    .enumerate()
                    .filter_map(|(index, excluded)| (!*excluded).then_some(index))
                    .collect::<Vec<_>>();
                if kept.len() < 2 {
                    break;
                }
                let compact_identities = kept
                    .iter()
                    .map(|index| identities[*index].clone())
                    .collect::<Vec<_>>();
                let compact_currencies = kept
                    .iter()
                    .map(|index| currencies[*index].clone())
                    .collect::<Vec<_>>();
                let compact_levels = kept.iter().map(|index| levels[*index]).collect::<Vec<_>>();
                let compact_values = values
                    .iter()
                    .map(|column| kept.iter().map(|index| column[*index]).collect::<Vec<_>>())
                    .collect::<Vec<_>>();
                let mut compact_rollup = vec![false; kept.len()];
                mark_rollup_by_sum(
                    &compact_identities,
                    &compact_currencies,
                    &compact_levels,
                    &compact_values,
                    &mut compact_rollup,
                );
                let removed = compact_rollup.iter().filter(|value| **value).count();
                if removed == 0 {
                    break;
                }
                for (compact_index, excluded) in compact_rollup.into_iter().enumerate() {
                    if excluded {
                        rollup[kept[compact_index]] = true;
                    }
                }
            }
        }
    }

    rollup.iter().map(|v| !v).collect()
}

fn mark_zero_value_parents(
    identities: &[(String, String)],
    currencies: &[String],
    levels: &[Option<u32>],
    values: &[Vec<f64>],
    rollup: &mut [bool],
) {
    for anchor in 0..rollup.len() {
        if rollup[anchor]
            || identities[anchor].1.is_empty()
            || !values.iter().all(|column| column[anchor].abs() <= 0.005)
        {
            continue;
        }
        let parent_code = &identities[anchor].1;
        for cursor in (anchor + 1)..rollup.len().min(anchor + 1 + ROLLUP_SCAN_LIMIT) {
            if identities[cursor].0 != identities[anchor].0
                || currencies[cursor] != currencies[anchor]
            {
                break;
            }
            let child_code = &identities[cursor].1;
            let by_code = !child_code.is_empty() && is_ancestor_code(parent_code, child_code);
            let by_level = matches!(
                (levels[anchor], levels[cursor]),
                (Some(parent), Some(child)) if child > parent
            );
            if by_code || by_level {
                rollup[anchor] = true;
                break;
            }
            if !child_code.is_empty() {
                break;
            }
        }
    }
}

/// 把 TB 的金额形态规范成汇总勾稽需要的业务口径：期初／期末余额各一列净额，
/// 本年／本期发生额各保留借贷两列。这里直接复用公共符号与余额方向内核，避免
/// 汇总识别再维护一套“贷方到底加还是减”的猜测。
fn rollup_value_columns(
    headers: &[String],
    rows: &[Vec<String>],
    column_of: &dyn Fn(&str) -> Vec<String>,
) -> Vec<Vec<f64>> {
    let index_of = |role: &str| {
        column_of(role)
            .iter()
            .find_map(|name| header_index(headers, name))
    };
    let convention = detect_tb_sign_convention(headers, rows, column_of)
        .convention
        .unwrap_or(SignConvention::Unsigned);
    let number = |row: &[String], index: usize| {
        row.get(index)
            .and_then(|value| parse_amount(value).ok().flatten())
            .unwrap_or(0.0)
    };
    let direction_index = |prefix: &str| {
        let base = prefix
            .strip_suffix("Functional")
            .or_else(|| prefix.strip_suffix("Foreign"))
            .unwrap_or(prefix);
        index_of(&format!("{base}Direction")).or_else(|| index_of("direction"))
    };

    let mut values = Vec::<Vec<f64>>::new();
    for prefix in [
        "openingFunctional",
        "openingForeign",
        "closingFunctional",
        "closingForeign",
    ] {
        let debit = index_of(&format!("{prefix}Debit"));
        let credit = index_of(&format!("{prefix}Credit"));
        let amount = index_of(&format!("{prefix}Amount"));
        let direction = direction_index(prefix);
        let self_signed = balance_self_signed(headers, rows, column_of, prefix);
        let column = match (debit, credit, amount) {
            (Some(debit), Some(credit), _) => Some(
                rows.iter()
                    .map(|row| {
                        let input = AmountInputs {
                            debit: Some(number(row, debit)),
                            credit: Some(number(row, credit)),
                            ..Default::default()
                        };
                        signed_balance(&input, convention, false)
                    })
                    .collect(),
            ),
            (_, _, Some(amount)) => Some(
                rows.iter()
                    .map(|row| {
                        let input = AmountInputs {
                            amount: Some(number(row, amount)),
                            direction: direction.and_then(|index| row.get(index).cloned()),
                            ..Default::default()
                        };
                        signed_balance(&input, convention, self_signed)
                    })
                    .collect(),
            ),
            _ => None,
        };
        if let Some(column) = column {
            values.push(column);
        }
    }

    for prefix in ["ytdFunctional", "ytdForeign", "periodFunctional"] {
        let debit = index_of(&format!("{prefix}Debit"));
        let credit = index_of(&format!("{prefix}Credit"));
        let amount = index_of(&format!("{prefix}Amount"));
        let direction = direction_index(prefix);
        if debit.is_none() && credit.is_none() && amount.is_none() {
            continue;
        }
        let sides = rows
            .iter()
            .map(|row| {
                let input = match (debit, credit, amount) {
                    (Some(debit), Some(credit), _) => AmountInputs {
                        debit: Some(number(row, debit)),
                        credit: Some(number(row, credit)),
                        ..Default::default()
                    },
                    (_, _, Some(amount)) => AmountInputs {
                        amount: Some(number(row, amount)),
                        direction: direction.and_then(|index| row.get(index).cloned()),
                        ..Default::default()
                    },
                    _ => AmountInputs::default(),
                };
                side_amounts(&input, convention)
            })
            .collect::<Vec<_>>();
        values.push(sides.iter().map(|(debit, _)| *debit).collect());
        values.push(sides.iter().map(|(_, credit)| *credit).collect());
    }
    values
}

/// 金额勾稽：找出「本行 = 相邻连续若干行之和」的行组，剔除其中一侧。
///
/// 两个方向都要扫。汇总行既可能写在明细上方（父科目行带着下面一串核算维度行），
/// 也可能写在下方（一组明细行跟一条小计行），实测样例两种都有。
fn mark_rollup_by_sum(
    identities: &[(String, String)],
    currencies: &[String],
    levels: &[Option<u32>],
    values: &[Vec<f64>],
    rollup: &mut [bool],
) {
    let len = rollup.len();
    // 该行在所有金额列上是否全为零。全零行不能当汇总锚点，否则空行会和
    // 空行互相勾稽成立。
    let all_zero = |index: usize| values.iter().all(|column| column[index].abs() <= 0.005);
    #[derive(Clone)]
    struct Candidate {
        anchor: usize,
        members: Vec<usize>,
        same_code: bool,
        single_same_code: bool,
    }
    let original_rollup = rollup.to_vec();
    let mut candidates = Vec::<Candidate>::new();
    for forward in [true, false] {
        for step in 0..len {
            let anchor = if forward { step } else { len - 1 - step };
            if original_rollup[anchor] || all_zero(anchor) {
                continue;
            }
            let mut sums = vec![0.0; values.len()];
            let mut taken = 0usize;
            let mut best = None::<Candidate>;
            for offset in 1..=ROLLUP_SCAN_LIMIT {
                let Some(cursor) = (if forward {
                    anchor.checked_add(offset).filter(|c| *c < len)
                } else {
                    anchor.checked_sub(offset)
                }) else {
                    break;
                };
                // 跨主体或跨币种就不再是同一组。已经带“小计/合计”标签的行仍可
                // 作为上层汇总的成员：真实TB会同时列“科目总计、方向小计、辅助
                // 明细”，若在方向小计处直接截断，三行金额本可完整勾稽却会被漏掉。
                if identities[cursor].0 != identities[anchor].0
                    || currencies[cursor] != currencies[anchor]
                {
                    break;
                }
                let anchor_code = &identities[anchor].1;
                let cursor_code = &identities[cursor].1;
                let explicit_child = matches!(
                    (levels.get(anchor).copied().flatten(), levels.get(cursor).copied().flatten()),
                    (Some(parent), Some(child)) if child > parent
                );
                if !anchor_code.is_empty()
                    && !cursor_code.is_empty()
                    && cursor_code != anchor_code
                    && !is_ancestor_code(anchor_code, cursor_code)
                    && !is_ancestor_code(cursor_code, anchor_code)
                    && !explicit_child
                {
                    break;
                }
                for (column, sum) in values.iter().zip(sums.iter_mut()) {
                    *sum += column[cursor];
                }
                taken += 1;
                if taken < 1 {
                    continue;
                }
                let matched = values
                    .iter()
                    .zip(sums.iter())
                    .all(|(column, sum)| amounts_equal(column[anchor], *sum));
                if !matched {
                    continue;
                }
                let members = if forward {
                    ((anchor + 1)..=(anchor + taken)).collect::<Vec<_>>()
                } else {
                    ((anchor - taken)..=(anchor - 1)).collect::<Vec<_>>()
                };
                let anchor_code = &identities[anchor].1;
                let member_codes = members
                    .iter()
                    .map(|index| identities[*index].1.as_str())
                    .filter(|code| !code.is_empty())
                    .collect::<Vec<_>>();
                let blank_side = anchor_code.is_empty() || member_codes.is_empty();
                let same_code = !anchor_code.is_empty()
                    && !member_codes.is_empty()
                    && member_codes.iter().all(|code| *code == anchor_code);
                let hierarchy = !anchor_code.is_empty()
                    && !member_codes.is_empty()
                    && member_codes.iter().all(|code| {
                        is_ancestor_code(anchor_code, code) || is_ancestor_code(code, anchor_code)
                    });
                let level_hierarchy = levels.get(anchor).copied().flatten().is_some_and(|parent| {
                    members.iter().all(|index| {
                        levels
                            .get(*index)
                            .copied()
                            .flatten()
                            .is_some_and(|child| child > parent)
                    })
                });
                if !(blank_side || hierarchy || same_code || level_hierarchy) {
                    continue;
                }
                best = Some(Candidate {
                    anchor,
                    members,
                    same_code,
                    single_same_code: same_code && taken == 1,
                });
            }
            if let Some(candidate) = best {
                candidates.push(candidate);
            }
        }
    }

    // 两条同编码、金额完全相同的行单独看无法判断谁是汇总；但同一张TB若已存在
    // “一条同编码汇总 = 两条以上辅助明细之和”的强证据，就说明该系统确实采用
    // 同编码的汇总/辅助混排格式。此时同表内的一对一完整勾稽也按相同结构处理。
    // 孤立的一对相等行仍原样保留，不凭巧合静默删除。
    let same_code_structure_confirmed = candidates
        .iter()
        .any(|candidate| candidate.same_code && candidate.members.len() >= 2);
    candidates.retain(|candidate| !candidate.single_same_code || same_code_structure_confirmed);

    // 先采用覆盖范围最大的完整关系，再锁住整组。候选收集阶段不修改 mask，
    // 因而正扫、反扫看到的是同一份原始数据；锁定后任何重叠的小候选都不能
    // 二次删除组内行。
    candidates.sort_by(|a, b| {
        // 同编码组比宽泛的父子前缀候选更具体、也更可靠；先锁住局部完整关系，
        // 避免一个跨很多行的父科目候选占住这些行，却又无法决定保留哪一侧。
        b.same_code
            .cmp(&a.same_code)
            .then_with(|| b.members.len().cmp(&a.members.len()))
            .then_with(|| a.anchor.cmp(&b.anchor))
    });
    let mut claimed = vec![false; len];
    for candidate in candidates {
        if claimed[candidate.anchor] || candidate.members.iter().any(|index| claimed[*index]) {
            continue;
        }
        claimed[candidate.anchor] = true;
        for index in &candidate.members {
            claimed[*index] = true;
        }
        let anchor_code = &identities[candidate.anchor].1;
        let coded_members = candidate
            .members
            .iter()
            .filter(|index| !identities[**index].1.is_empty())
            .collect::<Vec<_>>();
        // 同编码的辅助核算组优先保留父／汇总行；无编码的核算维度同理。
        // 小计行无编码或父子编码不同，则保留可用于按科目核对的明细。
        let keep_anchor = !anchor_code.is_empty()
            && (coded_members.is_empty()
                || coded_members
                    .iter()
                    .all(|index| identities[**index].1 == *anchor_code));
        if keep_anchor {
            for index in candidate.members {
                rollup[index] = true;
            }
        } else {
            rollup[candidate.anchor] = true;
        }
    }
}

// ────────────────────────────── 旧角色名迁移 ──────────────────────────────

/// 四个工具此前各用各的角色名。统一到标准名之后，**历史保存的映射仍要能读**——
/// 用户在设置里存过的映射、任务历史里的参数都是旧名。
///
/// 只做单向迁移：旧名 → 标准名。标准名原样返回。
pub(crate) fn migrate_role_name(kind: &str, old: &str) -> &'static str {
    // 先看是不是已经是标准名。
    if let Some(role) = role_of(kind, old) {
        return role.name;
    }
    // 借款台账自成一套旧名。前端面板此前用的角色名（maturityDate / fixedRate …）
    // 与引擎实际识别出来的（endDate / rate …）根本不是一套，映射建议落不进格子——
    // 统一到台账角色表之后，历史保存的映射靠这里读回来。
    if kind == "loan" {
        return match old {
            "outstanding" => "closingPrincipal", // 「未偿还本金」= 期末余额
            "maturityDate" => "endDate",
            "fixedRate" => "rate",
            "benchmark" => "benchmarkRate",
            "account" => "loanId",
            _ => "",
        };
    }
    let je = kind == "je";
    match (old, je) {
        // 汇兑损益：原币/本位币各有一个方向列，统一成共用的 direction。
        ("foreignDirection" | "functionalDirection", true) => "direction",
        // 存款利息 / 借款利息：凭证号。
        ("voucherId", true) => "id",
        // 三个工具都把科目编码与名称混在一个格子里，一律先落到编码。
        ("account", _) => "accountCode",
        // 存款利息 TB 的期初/期末借贷余额。
        ("openingDebit", false) => "openingFunctionalDebit",
        ("openingCredit", false) => "openingFunctionalCredit",
        ("closingDebit", false) => "closingFunctionalDebit",
        ("closingCredit", false) => "closingFunctionalCredit",
        ("openingBalance", false) => "openingFunctionalAmount",
        ("closingBalance", false) => "closingFunctionalAmount",
        // 借款利息：期初/期末本金就是期初/期末余额，负债类取贷方为正。
        ("openingPrincipal", false) => "openingFunctionalAmount",
        ("closingPrincipal", false) => "closingFunctionalAmount",
        // 本期发生额此前不分本位币/原币。
        ("periodDebit", false) => "ytdFunctionalDebit",
        ("periodCredit", false) => "ytdFunctionalCredit",
        // 金额三件套加币种口径前缀。
        ("amount", true) => "functionalAmount",
        ("debit", true) => "functionalDebit",
        ("credit", true) => "functionalCredit",
        // 认不出的旧名原样退回，由调用方决定是忽略还是报错。
        _ => "",
    }
}

/// 列名里带了该角色的冲突词——这是**确定性的否定**：别名库已经明说这类列不属于
/// 该角色（`预算二级科目描述` 不是科目名称，`对方科目名称` 也不是）。
///
/// 脚本自动映射本来就受冲突词约束，LLM 复核却是模型自由发挥，提示词讲过的纪律
/// 它照样会犯。把同一份冲突词用在复核结果上，模型只能补充别名库不认识的列，
/// 不能推翻别名库已经明确否掉的列。
pub(crate) fn role_rejects_header(kind: &str, role: &str, header: &str) -> bool {
    let name = migrate_role_name(kind, role);
    let Some(role) = role_of(kind, name) else {
        return false;
    };
    let n = normalize_header(header);
    if n.is_empty() {
        return false;
    }
    // 金额角色一律排除集团货币口径，与 [`alias_score`] 同口径。此前这里只查
    // 角色自己的冲突词，漏了这一条：实测模型建议把本年累计贷方指到
    // `MTD Grp Curr`，理由里自己都写着「为集团货币口径」，却没被拦下。
    if excludes_group_currency(role) && NOT_GROUP.iter().any(|c| n.contains(&normalize_header(c))) {
        return true;
    }
    role.conflicts
        .iter()
        .any(|c| n.contains(&normalize_header(c)))
}

// ────────────────────────────── 取值解析 ──────────────────────────────
//
// 金额与日期的写法各家系统不同，解析能力必须只有一份，否则「这个格子读不读得出来」
// 会随工具而变。**错误处理策略仍归各工具自己**：汇兑损益读不出就报错中断，
// 看账读不出按 0 处理继续——那是业务取舍，不是解析能力的差别。

/// 占位符：这些写法表示「此处无值」，不是解析失败。
fn is_placeholder(s: &str) -> bool {
    matches!(s.trim(), "-" | "—" | "–" | "N/A" | "n/a" | "NA" | "无")
}

/// 一条已经映射到金额角色、但非空值无法解析的单元格。
/// `row_index` 是 `rows` 内的零基下标，调用方可结合标题行换算源表行号。
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct AmountParseIssue {
    pub(crate) role: &'static str,
    pub(crate) label: &'static str,
    pub(crate) column: String,
    pub(crate) row_index: usize,
    pub(crate) value: String,
}

fn is_amount_value_role(role: &str) -> bool {
    let lower = role.to_ascii_lowercase();
    lower.contains("amount")
        || lower.contains("debit")
        || lower.contains("credit")
        || matches!(role, "principal" | "openingPrincipal" | "closingPrincipal")
}

/// 校验已映射金额列的所有非空值均可由公共金额解析器读取。
///
/// 空白与横杠占位符是合法的零/缺省表达；其他非空文本必须解析为数值。所有工具
/// 都可在业务计算前调用这一个入口，避免各自把坏值静默改成零。
pub(crate) fn mapped_amount_parse_issues(
    kind: &str,
    headers: &[String],
    rows: &[Vec<String>],
    column_of: &dyn Fn(&str) -> Vec<String>,
) -> Vec<AmountParseIssue> {
    let mut issues = Vec::new();
    let mut visited = HashSet::<(&'static str, usize)>::new();
    for definition in roles(kind)
        .iter()
        .filter(|definition| is_amount_value_role(definition.name))
    {
        for column in column_of(definition.name) {
            let Some(index) = header_index(headers, &column) else {
                continue;
            };
            if !visited.insert((definition.name, index)) {
                continue;
            }
            for (row_index, row) in rows.iter().enumerate() {
                let raw = row.get(index).map(String::as_str).unwrap_or("");
                let trimmed = raw.trim();
                if trimmed.is_empty() || matches!(trimmed, "-" | "—" | "–") {
                    continue;
                }
                if parse_amount(raw).is_ok_and(|value| value.is_some()) {
                    continue;
                }
                issues.push(AmountParseIssue {
                    role: definition.name,
                    label: definition.label,
                    column: column.clone(),
                    row_index,
                    value: raw.to_owned(),
                });
            }
        }
    }
    issues
}

fn normalized_unit_value(raw: &str) -> String {
    raw.trim()
        .to_uppercase()
        .replace([' ', '.', '_', '-'], "")
        .replace('㎡', "M2")
        .replace('㎥', "M3")
}

fn is_measurement_unit_value(raw: &str) -> bool {
    matches!(
        normalized_unit_value(raw).as_str(),
        "KG" | "G"
            | "MG"
            | "T"
            | "TON"
            | "LB"
            | "EA"
            | "PC"
            | "PCS"
            | "BOX"
            | "COL"
            | "M"
            | "M2"
            | "M3"
            | "CM"
            | "MM"
            | "L"
            | "ML"
            | "SET"
            | "BAG"
            | "ROLL"
            | "CASE"
            | "PAL"
            | "UNIT"
            | "H"
            | "HR"
            | "DAY"
            | "个"
            | "件"
            | "箱"
            | "盒"
            | "千克"
            | "公斤"
            | "克"
            | "吨"
            | "米"
            | "平方米"
            | "立方米"
            | "升"
            | "套"
            | "台"
            | "只"
            | "卷"
            | "袋"
    )
}

fn column_is_measurement_unit(headers: &[String], rows: &[Vec<String>], index: usize) -> bool {
    let header = headers
        .get(index)
        .map(|value| normalize_header(value))
        .unwrap_or_default();
    let explicit_unit_header = header.contains("计量单位")
        || header.contains("数量单位")
        || header.contains("物料单位")
        || matches!(header.as_str(), "uom" | "unitofmeasure");
    if explicit_unit_header {
        return true;
    }
    let ambiguous_unit_header = header == "单位";
    let values = rows
        .iter()
        .take(10_000)
        .filter_map(|row| row.get(index))
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .collect::<Vec<_>>();
    if values.is_empty() {
        return false;
    }
    let unit_count = values
        .iter()
        .filter(|value| is_measurement_unit_value(value))
        .count();
    let distinct = values
        .iter()
        .map(|value| normalized_unit_value(value))
        .collect::<HashSet<_>>()
        .len();
    let ratio = unit_count as f64 / values.len() as f64;
    // 裸「单位」仍可能真的是公司，必须同时有取值证据；没有单位型表头时则
    // 要求更多样本和更高占比，避免把恰好叫 EA 的单一公司代码误伤。
    (ambiguous_unit_header && unit_count >= 2 && ratio >= 0.60)
        || (!ambiguous_unit_header && unit_count >= 5 && distinct >= 2 && ratio >= 0.90)
}

/// 已映射的主体列是否实际是一列计量单位。
pub(crate) fn entity_column_is_measurement_unit(
    headers: &[String],
    rows: &[Vec<String>],
    column: &str,
) -> bool {
    header_index(headers, column)
        .is_some_and(|index| column_is_measurement_unit(headers, rows, index))
}

/// 把单元格文本读成金额。`None` 表示空值或占位符，`Err` 表示确实读不出来。
///
/// 认得实务里的各种写法：千分位（含全角逗号与不间断空格）、括号负数 `(500)`、
/// 尾部负号 `800-`、`CR`／`DR` 后缀、中文「借」「贷」后缀。
///
/// 此前看账那份只去引号和千分位、失败一律返回 0——`(500)`、`1,234CR` 全都
/// 静默变成 0，金额无声无息地丢掉。能力沉到这里之后三个工具共用同一套。
pub(crate) fn parse_amount(raw: &str) -> Result<Option<f64>, String> {
    let mut s = raw
        .trim()
        .trim_matches('"')
        .replace([',', '，', ' ', '\u{a0}'], "");
    if s.is_empty() || is_placeholder(&s) {
        return Ok(None);
    }
    let mut sign = 1.0;
    if s.starts_with('(') && s.ends_with(')') {
        sign = -1.0;
        s = s[1..s.len() - 1].to_owned();
    }
    if s.ends_with('-') {
        sign *= -1.0;
        s.pop();
    }
    let upper = s.to_ascii_uppercase();
    if upper.ends_with("CR") {
        sign *= -1.0;
        s.truncate(s.len() - 2);
    } else if upper.ends_with("DR") {
        s.truncate(s.len() - 2);
    }
    if s.ends_with('贷') {
        sign *= -1.0;
        s.pop();
    } else if s.ends_with('借') {
        s.pop();
    }
    if s.trim().is_empty() {
        return Ok(None);
    }
    s.trim()
        .parse::<f64>()
        .map(|v| Some(sign * v))
        .map_err(|_| format!("无法解析数值：{raw}"))
}

/// 更宽松的金额读取：先剥掉 [`parse_amount`] 不认的写法，再走同一套解析。
///
/// 多认三类：百分号 `3.5%`、货币符号 `¥`／`￥`／`$`、括号里带符号的负数
/// `$ (50.00)`。此前存款利息与借款利息各持一份本地实现，能力沉到这里共用。
/// 百分号只剥符号不除以一百——利率列读出来就是 3.5，换算与否是调用方的业务。
///
/// 与 [`parse_amount`] 的 `Result` 不同，这里读不出一律 `None`，不再区分
/// 「空值」与「读不出来」：要这个宽松度的调用方（利率、试算勾稽）本来就把
/// 读不出当缺省处理；需要区分两者的仍直接用 [`parse_amount`]。
pub(crate) fn parse_amount_lenient(raw: &str) -> Option<f64> {
    // 货币符号与百分号可能在括号内外任何位置，先整体剥掉再认括号负数。
    let stripped: String = raw
        .trim()
        .trim_matches('"')
        .chars()
        .filter(|c| !matches!(c, '%' | '$' | '¥' | '￥'))
        .collect();
    let s = stripped.trim();
    let s = if s.starts_with('(') && s.ends_with(')') && s.len() >= 2 {
        format!("-{}", &s[1..s.len() - 1])
    } else {
        s.to_owned()
    };
    parse_amount(&s).ok().flatten()
}

/// 把单元格文本读成日期。
///
/// 合并了汇兑损益与借款利息两份实现的覆盖面：**先按空格切出日期段**
/// （calamine 会把真日期读成 `2023-01-10 00:00:00`），再逐个格式试；
/// 格式表含英文月份缩写 `10-Jan-2023` 与 ISO 的 `T` 分隔写法。
pub(crate) fn parse_date(raw: &str) -> Option<NaiveDate> {
    let text = raw.trim();
    if text.is_empty() {
        return None;
    }
    const DATE_FORMATS: &[&str] = &[
        "%Y-%m-%d", "%Y/%m/%d", "%Y.%m.%d", "%Y%m%d", "%d/%m/%Y", "%d-%m-%Y", "%d-%b-%Y",
        "%d %b %Y",
    ];
    const DATETIME_FORMATS: &[&str] = &[
        "%Y-%m-%d %H:%M:%S",
        "%Y-%m-%dT%H:%M:%S",
        "%Y/%m/%d %H:%M:%S",
    ];
    for format in DATETIME_FORMATS {
        if let Ok(value) = NaiveDateTime::parse_from_str(text, format) {
            return Some(value.date());
        }
    }
    // 带时间的写法先切掉时间段，剩下的按日期格式试。
    let head = text.split_whitespace().next().unwrap_or(text);
    for candidate in [text, head] {
        for format in DATE_FORMATS {
            if let Ok(date) = NaiveDate::parse_from_str(candidate, format) {
                return Some(date);
            }
        }
    }
    // 中文日期：“2024年3月5日”“25年1月10日”（两位年按 20xx）——借款台账
    // 的常见手写体，此前只存在借款模块一份未接线的实现，内核认不出来。
    if let Some(date) = parse_cn_date(text) {
        return Some(date);
    }
    // Excel 序列号（5 位纯数字，约 1954～2119 年）：有人把日期粘贴成数值，
    // 单元格类型是数字而非日期，读取侧只能拿到 "45662" 这样的文本——
    // Excel 序列 1 即 1900-01-01（1900 闰年 bug 后与 1899-12-30 基准一致）。
    if text.len() == 5 && text.chars().all(|c| c.is_ascii_digit()) {
        if let Ok(serial) = text.parse::<i64>() {
            if (20000..80000).contains(&serial) {
                return NaiveDate::from_ymd_opt(1899, 12, 30)
                    .and_then(|epoch| epoch.checked_add_signed(chrono::Duration::days(serial)));
            }
        }
    }
    None
}

/// 中文年月日写法：年（四位或两位，两位按 20xx）＋月＋日，日后的“日”字可省。
fn parse_cn_date(text: &str) -> Option<NaiveDate> {
    let i_nian = text.find('年')?;
    let y_str = &text[..i_nian];
    let y = if y_str.chars().count() <= 2 {
        2000 + y_str.parse::<i32>().ok()?
    } else {
        y_str.parse::<i32>().ok()?
    };
    let rest = &text[i_nian + '年'.len_utf8()..];
    let i_yue = rest.find('月')?;
    let m = rest[..i_yue].parse::<u32>().ok()?;
    let d_part = &rest[i_yue + '月'.len_utf8()..];
    let d = d_part.trim_end_matches('日').trim().parse::<u32>().ok()?;
    NaiveDate::from_ymd_opt(y, m, d)
}

/// 抽查多少行来比较列的量级。扫到 200 行足以让本年累计与本期发生分出高下，
/// 又不会在几十万行的序时账上白跑一遍。
const MAGNITUDE_SAMPLE_ROWS: usize = 200;
/// 至少要看到这么多个有效数值才敢下结论——只看一两个科目会被个别大额扰动。
const MAGNITUDE_MIN_VALUES: usize = 3;

/// 宽松地把单元格文本读成数字：容忍千分位、货币符号、括号负数与百分号。
fn cell_number(text: &str) -> Option<f64> {
    let t = text.trim();
    if t.is_empty() {
        return None;
    }
    let negative = t.starts_with('(') && t.ends_with(')');
    let cleaned: String = t
        .chars()
        .filter(|c| c.is_ascii_digit() || *c == '.' || *c == '-' || *c == '+')
        .collect();
    if cleaned.is_empty() || cleaned.chars().all(|c| !c.is_ascii_digit()) {
        return None;
    }
    cleaned
        .parse::<f64>()
        .ok()
        .map(|v| if negative { -v.abs() } else { v })
}

/// 一列的量级：抽查若干行，累加绝对值。有效数值不够就返回 `None`，
/// 宁可不判也不拿一两个数字下结论。
fn column_magnitude(rows: &[Vec<String>], column: usize) -> Option<f64> {
    let mut total = 0.0;
    let mut seen = 0usize;
    for row in rows.iter().take(MAGNITUDE_SAMPLE_ROWS) {
        let Some(text) = row.get(column) else {
            continue;
        };
        if let Some(v) = cell_number(text) {
            if v != 0.0 {
                total += v.abs();
                seen += 1;
            }
        }
    }
    (seen >= MAGNITUDE_MIN_VALUES).then_some(total)
}

/// 本年累计与本期发生的四对角色。列名不带「本期／本年」时两者长得一模一样。
const CUMULATIVE_PAIRS: &[(&str, &str)] = &[
    ("ytdFunctionalDebit", "periodFunctionalDebit"),
    ("ytdFunctionalCredit", "periodFunctionalCredit"),
];

/// 同一个角色有多个候选列时，按金额量级分配：**大的是本年累计，小的是本期发生**。
///
/// 实务里一张余额表同时给「本期发生」和「本年累计」两组，却都只写「借方发生额」
/// 的情况很常见，列名分不出来。本年累计天然覆盖更长的期间，合计一定不小于本期，
/// 抽查若干行比大小就能定。数据不足以分辨时保持别名判定的结果，不硬猜。
pub(crate) fn disambiguate_cumulative(
    kind: &str,
    headers: &[String],
    rows: &[Vec<String>],
    assigned: &mut BTreeMap<usize, &'static str>,
) {
    // 本年累计与本期发生的区分只有 TB 才有。
    if kind != "tb" || rows.is_empty() {
        return;
    }
    for (ytd_name, period_name) in CUMULATIVE_PAIRS {
        let Some(ytd) = role_of("tb", ytd_name) else {
            continue;
        };
        // 候选：能匹配本年累计角色，且没有被别的角色占走的列。
        let mut candidates: Vec<(usize, f64)> = headers
            .iter()
            .enumerate()
            .filter(|(i, h)| {
                let taken = assigned.get(i).copied();
                (taken.is_none() || taken == Some(*ytd_name) || taken == Some(*period_name))
                    && alias_score(ytd, h).is_some()
            })
            .filter_map(|(i, _)| column_magnitude(rows, i).map(|m| (i, m)))
            .collect();
        if candidates.len() < 2 {
            continue;
        }
        candidates.sort_by(|a, b| {
            b.1.partial_cmp(&a.1)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then(a.0.cmp(&b.0))
        });
        // 两列量级一样时分不出谁是累计，维持原判。
        if (candidates[0].1 - candidates[1].1).abs() < f64::EPSILON {
            continue;
        }
        assigned.insert(candidates[0].0, ytd_name);
        // 次大的那列落到本期发生——前提是本期发生还没被明确写着「本期」的列占走。
        let period_taken = assigned
            .iter()
            .any(|(i, r)| *r == *period_name && *i != candidates[1].0);
        if !period_taken {
            assigned.insert(candidates[1].0, period_name);
        }
        // 再多的同名列没有对应角色，留空让用户自己决定。
        for (i, _) in candidates.iter().skip(2) {
            if assigned.get(i).copied() == Some(*ytd_name)
                || assigned.get(i).copied() == Some(*period_name)
            {
                assigned.remove(i);
            }
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
enum BalancePeriodScope {
    Annual,
    CurrentPeriod,
}

fn header_period_scope(header: &str) -> Option<BalancePeriodScope> {
    let normalized = normalize_header(header);
    if normalized.contains("本年") || normalized.contains("年度") || normalized.contains("年累计")
    {
        Some(BalancePeriodScope::Annual)
    } else if normalized.contains("本期") {
        Some(BalancePeriodScope::CurrentPeriod)
    } else {
        None
    }
}

/// LLM 只能补充别名，不能把已经成套的本年/本期发生额与另一期间的期初列混搭。
pub(crate) fn opening_period_scope_conflicts(
    kind: &str,
    role: &str,
    suggested: &str,
    movement_columns: &[String],
) -> bool {
    if kind != "tb" || role != "openingFunctionalAmount" {
        return false;
    }
    let movement_scopes = movement_columns
        .iter()
        .filter_map(|column| header_period_scope(column))
        .collect::<BTreeSet<_>>();
    movement_scopes.len() == 1
        && header_period_scope(suggested)
            .zip(movement_scopes.iter().next().copied())
            .is_some_and(|(suggested, movement)| suggested != movement)
}

/// 同一张 TB 同时列示“本年”和“本期”时，期初余额必须与当前发生额口径成套。
/// 这里只处理表头已经明确写出期间的确定性场景；没有“本年/本期”字样时不猜。
fn align_opening_period_scope(
    kind: &str,
    headers: &[String],
    assigned: &mut BTreeMap<usize, &'static str>,
) {
    if kind != "tb" {
        return;
    }
    let movement_scopes = assigned
        .iter()
        .filter(|(_, role)| matches!(**role, "ytdFunctionalDebit" | "ytdFunctionalCredit"))
        .filter_map(|(index, _)| headers.get(*index).and_then(|h| header_period_scope(h)))
        .collect::<BTreeSet<_>>();
    if movement_scopes.len() != 1 {
        return;
    }
    let scope = *movement_scopes.iter().next().expect("one movement scope");
    let Some(role) = role_of("tb", "openingFunctionalAmount") else {
        return;
    };
    let candidate = headers
        .iter()
        .enumerate()
        .filter(|(_, header)| header_period_scope(header) == Some(scope))
        .filter(|(_, header)| {
            let normalized = normalize_header(header);
            normalized.contains("期初") || normalized.contains("年初")
        })
        .filter_map(|(index, header)| alias_score(role, header).map(|score| (index, score)))
        .max_by(|left, right| {
            left.1
                .partial_cmp(&right.1)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| right.0.cmp(&left.0))
        })
        .map(|(index, _)| index);
    let Some(candidate) = candidate else {
        return;
    };
    assigned.retain(|index, mapped_role| {
        *mapped_role != "openingFunctionalAmount" || *index == candidate
    });
    assigned.insert(candidate, "openingFunctionalAmount");
}

/// 把「角色 → 列名」的映射重新过一遍两条数据形态规则：
/// **本年累计与本期发生按金额量级分配**，**期初与期末方向按列位置分配**。
///
/// 汇兑损益与存款利息有各自的候选打分（列画像、日期占比之类），映射不是由
/// [`suggest_roles`] 产出的，所以给它们一个直接作用于既有映射的入口。
/// 返回需要改动的项：`(角色, 列名)`，`None` 表示该角色应当留空。
pub(crate) fn recheck_cumulative(
    kind: &str,
    headers: &[String],
    rows: &[Vec<String>],
    current: &[(String, String)],
) -> Vec<(&'static str, Option<String>)> {
    if kind == "je" || rows.is_empty() {
        return Vec::new();
    }
    let index_of = |name: &str| headers.iter().position(|h| h == name);
    let mut assigned: BTreeMap<usize, &'static str> = BTreeMap::new();
    for (role, column) in current {
        if let (Some(i), Some(r)) = (index_of(column), role_of(kind, role)) {
            assigned.insert(i, r.name);
        }
    }
    let before = assigned.clone();
    disambiguate_cumulative(kind, headers, rows, &mut assigned);
    align_opening_period_scope(kind, headers, &mut assigned);
    disambiguate_directions(kind, headers, &mut assigned);
    if before == assigned {
        return Vec::new();
    }
    let mut touched: Vec<&'static str> = Vec::new();
    for (ytd, period) in CUMULATIVE_PAIRS {
        touched.push(ytd);
        touched.push(period);
    }
    touched.push("openingFunctionalAmount");
    touched.push("openingDirection");
    touched.push("closingDirection");
    let mut out: Vec<(&'static str, Option<String>)> = Vec::new();
    for role in touched {
        if role_of(kind, role).is_none() {
            continue;
        }
        let column = assigned
            .iter()
            .find(|(_, r)| **r == role)
            .and_then(|(i, _)| headers.get(*i).cloned());
        out.push((role, column));
    }
    out
}

/// 带数据的表头识别：在 [`suggest_roles`] 的基础上，用实际取值区分那些
/// 列名分不出来的角色（目前是本年累计与本期发生）。
///
/// 能拿到数据行时一律用这个；只有表头时才退回 [`suggest_roles`]。
pub(crate) fn suggest_roles_with_data(
    kind: &str,
    headers: &[String],
    rows: &[Vec<String>],
) -> BTreeMap<usize, &'static str> {
    let mut out = suggest_roles(kind, headers);
    // 「单位」既可能指公司，也可能指物料计量单位。若取值明显是 KG／EA／BOX，
    // 就撤销主体建议，避免它进入凭证键后拆散同一张凭证的借贷两边。
    if kind == "je" {
        if let Some(index) = out
            .iter()
            .find_map(|(index, role)| (*role == "entity").then_some(*index))
        {
            if column_is_measurement_unit(headers, rows, index) {
                out.remove(&index);
            }
        }
    }
    disambiguate_cumulative(kind, headers, rows, &mut out);
    align_opening_period_scope(kind, headers, &mut out);
    fill_combined_account_column(rows, &mut out, headers.len());
    out
}

/// 科目编码整个空缺时，找一列「编码+名称混写」的顶上。
///
/// 03 号样例非这条不可：它整张表只有一列科目，表头写作
/// `项目编码、文本/科目编码、文本`——里头既有「科目编码」又有「文本」，
/// 冲突词一票否决，按列名怎么judge都落不到科目编码上。只能看数据：
/// 整列都是 `1001010000:库存现金-人民币` 这种形态，那它就是科目列。
///
/// 只在**空缺时**补。表里另有干净的编码列时（08 号样例那种名称列里带编码的），
/// 编码角色早就有主了，这里不插手。
fn fill_combined_account_column(
    rows: &[Vec<String>],
    out: &mut BTreeMap<usize, &'static str>,
    width: usize,
) {
    if out.values().any(|role| *role == "accountCode") {
        return;
    }
    let combined = |index: usize| {
        is_combined_account_column(
            rows.iter()
                .filter_map(|row| row.get(index))
                .map(String::clone),
        )
    };
    // 先挑没人占的列；实在没有，才从币种线索文本手里抢——那是个弱角色，
    // 「文本」两个字谁都能命中，科目列比它重要得多。
    let pick = (0..width)
        .find(|index| !out.contains_key(index) && combined(*index))
        .or_else(|| {
            (0..width)
                .find(|index| out.get(index).copied() == Some("currencyText") && combined(*index))
        });
    if let Some(index) = pick {
        out.insert(index, "accountCode");
    }
}

/// [`plan_combined_account_fill`] 的判定结果：该把哪一列挂上科目编码／科目名称。
///
/// 引擎只出判断，不碰调用方的 JSON——各工具的映射表形状不同（有的用字符串、
/// 有的用数组，还有历史遗留的合并键 `account`），套用规则的那十来行留在工具侧。
pub(crate) struct CombinedAccountFill {
    /// 需要新挂到 `accountCode` 的列；`None` 表示编码角色已有主或没找到合并列。
    pub(crate) code_column: Option<String>,
    /// 需要同列兼挂 `accountName` 的列；`None` 表示名称已有主或该列不是合并写。
    pub(crate) name_column: Option<String>,
}

/// 科目编码整个空缺时，按**数据形态**找一列「编码+名称混写」的顶上。
///
/// 这是 [`fill_combined_account_column`] 的映射层版本：那份按列下标工作，服务
/// 引擎自己的角色推荐；这份按列名工作，服务已经成型的映射表。判定规则只有这
/// 一份，汇兑损益与存款利息此前各持一份近似实现，收敛于此。
///
/// 两级挑选：先挑没有任何角色占用的列；实在没有，才从**弱角色**（辅助核算、
/// 币种线索）手里抢——「文本」两个字谁都能命中，科目本体比它们重要得多。反过来
/// 强角色占着的列一概不动。抢到之后由调用方让弱角色出让该列，否则一整列科目
/// 全称会被当成银行账号参与辅助核算分摊。
///
/// 名称兼挂是独立的一条：编码列本身就是合并写时，同列再挂一次科目名称——编码
/// 与名称本来就在同一格里，两边都映射上，界面才不会一边提示「尚未映射科目名称」、
/// 一边数据其实读得出（TBJE 引擎既有口径）。
///
/// `claimed` 由调用方给出「某角色当前映射了哪些列」，`kind` 用来枚举该形态下
/// 的全部角色。历史遗留的合并键 `account` 视同编码与名称都已有主。
pub(crate) fn plan_combined_account_fill(
    kind: &str,
    headers: &[String],
    rows: &[Vec<String>],
    claimed: &dyn Fn(&str) -> Vec<String>,
) -> CombinedAccountFill {
    const WEAK_RIVALS: &[&str] = &["auxiliary", "currencyText"];
    let combined = |header: &str| -> bool {
        headers
            .iter()
            .position(|h| h == header)
            .is_some_and(|index| {
                is_combined_account_column(rows.iter().filter_map(|row| row.get(index)).cloned())
            })
    };
    let legacy_account = !claimed("account").is_empty();
    let mapped_code = claimed("accountCode");

    let code_column = if !mapped_code.is_empty() || legacy_account {
        None
    } else {
        let mut weak = HashSet::<String>::new();
        let mut strong = HashSet::<String>::new();
        for role in roles(kind).iter().map(|role| role.name).chain(["account"]) {
            if WEAK_RIVALS.contains(&role) {
                weak.extend(claimed(role));
            } else {
                strong.extend(claimed(role));
            }
        }
        headers
            .iter()
            .find(|header| {
                !strong.contains(header.as_str())
                    && !weak.contains(header.as_str())
                    && combined(header)
            })
            .or_else(|| {
                headers.iter().find(|header| {
                    weak.contains(header.as_str())
                        && !strong.contains(header.as_str())
                        && combined(header)
                })
            })
            .cloned()
    };

    let name_column = if !claimed("accountName").is_empty() || legacy_account {
        None
    } else {
        code_column
            .clone()
            .or_else(|| mapped_code.into_iter().next())
            .filter(|header| combined(header))
    };

    CombinedAccountFill {
        code_column,
        name_column,
    }
}

// ────────────────────────────── 工作表与表头行识别 ──────────────────────────────
//
// 一个工作簿里选哪张表当正表、一行文本像不像表头，判据也必须只有一份——
// 汇兑损益先趟出来的这套打分对任何「账簿文件里混着审计人自建辅助表」的场景
// 都成立。原件在 fx.rs 与 tabular.rs，消费方切换到这里之后那边删除。

/// 单行像不像表头。五个信号加权求和，满分 1.0：
///
/// | 信号 | 权重 | 含义 |
/// |---|---|---|
/// | 占格率 | 0.22 | 非空单元格 / 列数——表头行几乎没有空格 |
/// | 文本占比 | 0.18 | 非空格里读不出金额的占比——表头是文字不是数字 |
/// | 唯一词占比 | 0.12 | 归一化后互不相同的非空格 / 非空格——表头不重复 |
/// | 账表关键词 | 0.36 | [`header_semantic_hits`] 命中数（封顶 8 个）|
/// | 下一行像数据 | 0.12 | 下一行里数值/日期单元格占比——表头下面就该是数据 |
///
/// 数值与日期的解析能力走统一内核（[`parse_amount`] / [`parse_date`]），
/// 表头归一用 [`normalize_header`]。此前汇兑损益与看账各持一份等价实现，
/// 收敛于此；`i` 是候选行下标，第 `i+1` 行用于「下面是不是数据」的判定。
pub(crate) fn header_row_score(all: &[Vec<String>], i: usize) -> f64 {
    let row = &all[i];
    let n = row.len().max(1) as f64;
    let non = row.iter().filter(|v| !v.trim().is_empty()).count() as f64;
    let text = row
        .iter()
        .filter(|v| !v.trim().is_empty() && parse_amount(v).is_err())
        .count() as f64;
    let unique = row
        .iter()
        .filter(|v| !v.trim().is_empty())
        .map(|v| normalize_header(v))
        .collect::<HashSet<_>>()
        .len() as f64;
    let hits = header_semantic_hits(row) as f64;
    let next = all
        .get(i + 1)
        .map(|r| {
            r.iter()
                .filter(|v| parse_amount(v).ok().flatten().is_some() || parse_date(v).is_some())
                .count() as f64
                / r.len().max(1) as f64
        })
        .unwrap_or(0.0);
    (non / n) * 0.22
        + (text / non.max(1.0)) * 0.18
        + (unique / non.max(1.0)) * 0.12
        + (hits.min(8.0) / 8.0) * 0.36
        + next * 0.12
}

/// 表头行里的账表关键词命中数：逐格按归一化后的「表头包含关键词」计数再求和。
///
/// 词表覆盖 TB／JE 的身份列（凭证、日期、科目、摘要）与金额列（期初、期末、
/// 借贷、余额），中英文各一套。命中数在 [`header_row_score`] 里封顶 8 个——
/// 一张宽表光表头就能命中几十个，不封顶会让关键词信号吞掉其余四项。
pub(crate) fn header_semantic_hits(row: &[String]) -> usize {
    const WORDS: &[&str] = &[
        "凭证",
        "日期",
        "科目",
        "公司",
        "主体",
        "币种",
        "原币",
        "外币",
        "本位币",
        "本币",
        "期初",
        "年初",
        "期末",
        "年末",
        "借方",
        "贷方",
        "余额",
        "金额",
        "摘要",
        "currency",
        "account",
        "entity",
        "date",
        "amount",
        "debit",
        "credit",
    ];
    row.iter()
        .map(|value| {
            let normalized = normalize_header(value);
            WORDS
                .iter()
                .filter(|word| normalized.contains(*word))
                .count()
        })
        .sum()
}

/// 工作簿里选哪张表当正表。
///
/// 光比表头质量会选错：审计人常在账簿文件里自己加一张透视／核对表，
/// **右半边整块粘着对应科目余额表的副本**，那半边的表头就是标准 TB 表头，
/// 分数一点不比正表低。实测十套样例里有六个文件带这种辅助表。
///
/// 规模按**对数**计权，且权重压过表头分（满分 1.0）的常见差距。账表场景里
/// 「数据行最多的那张」就是正表——这个信号比表头长什么样可靠得多。原先是
/// 「行数/1000 × 0.08」，一千行就封顶，两三个数量级的差距完全体现不出来。
pub(crate) fn sheet_score(header: f64, populated: usize, name: &str) -> f64 {
    let scale = if populated == 0 {
        0.0
    } else {
        (populated as f64).log10() / 6.0
    };
    header + scale.min(1.0) * 0.45
        - if is_auxiliary_sheet_name(name) {
            0.15
        } else {
            0.0
        }
}

/// 表名看着就是审计人自己加的辅助表。
///
/// 只做**降权**不做排除——万一用户把正表就叫「核对表」，规模权重还能把它救回来。
pub(crate) fn is_auxiliary_sheet_name(name: &str) -> bool {
    const MARKERS: &[&str] = &[
        "透视", "透視", "pivot", "核对", "核對", "check", "分析", "修改", "副本", "备份", "備份",
    ];
    let lower = name.to_lowercase();
    MARKERS
        .iter()
        .any(|marker| lower.contains(&marker.to_lowercase()))
}

// ────────────────────────────── 形态型号与整组匹配 ──────────────────────────────

/// 一种表形态。槽位内的角色**缺一不可**——这正是 TB／JE 种类表里合并单元格的含义。
#[derive(Clone, Copy, Debug)]
pub(crate) struct Form {
    pub(crate) id: &'static str,
    /// 给用户看的型号名（`TB-类型C`）。`id` 只在代码、测试与金标表里用，
    /// 界面与提示语一律用这个——用户读不出 `TB3` 是第几型。
    pub(crate) display: &'static str,
    pub(crate) label: &'static str,
    /// 必填槽。每个槽是一组角色，组内全部到齐才算该槽满足。
    pub(crate) required: &'static [&'static [&'static str]],
    /// 必填「任一即可」槽：组内**至少一个**到位即满足。
    ///
    /// 借款台账的起算额（本金｜期初余额｜期末余额）是这种槽——三者都是"某个时点的
    /// 占用本金"，在"全期恒定"的假设下给任意一个都能起算，不必同时给。
    /// TB／JE 没有这种槽，两张表的 [`Form`] 里一律留空。
    pub(crate) any_of: &'static [&'static [&'static str]],
    /// 可选槽。**同样整组**：要么整组给全，要么整组不给；只给一半算无效。
    pub(crate) optional: &'static [&'static [&'static str]],
}

const YTD_F: &[&str] = &["ytdFunctionalDebit", "ytdFunctionalCredit"];
const YTD_X: &[&str] = &["ytdForeignDebit", "ytdForeignCredit"];

/// TB 六型。区别在两条正交的轴：**方向形态**（净额／方向＋净额／借贷分列）
/// 与**是否带原币余额**。
pub(crate) fn tb_forms() -> &'static [Form] {
    TB_FORMS
}

static TB_FORMS: &[Form] = &[
    Form {
        id: "TB1",
        display: "TB-类型A",
        label: "本位币净额",
        any_of: &[],
        required: &[
            &["openingFunctionalAmount"],
            &["closingFunctionalAmount"],
            YTD_F,
        ],
        optional: &[YTD_X],
    },
    Form {
        id: "TB2",
        display: "TB-类型B",
        label: "方向＋本位币净额",
        any_of: &[],
        required: &[
            &["openingDirection", "openingFunctionalAmount"],
            &["closingDirection", "closingFunctionalAmount"],
            YTD_F,
        ],
        optional: &[YTD_X],
    },
    Form {
        id: "TB3",
        display: "TB-类型C",
        label: "本位币借贷分列",
        any_of: &[],
        required: &[
            &["openingFunctionalDebit", "openingFunctionalCredit"],
            &["closingFunctionalDebit", "closingFunctionalCredit"],
            YTD_F,
        ],
        optional: &[YTD_X],
    },
    Form {
        id: "TB4",
        display: "TB-类型D",
        label: "本位币净额＋原币净额",
        any_of: &[],
        required: &[
            &["openingFunctionalAmount", "openingForeignAmount"],
            &["closingFunctionalAmount", "closingForeignAmount"],
            YTD_F,
        ],
        optional: &[YTD_X],
    },
    Form {
        id: "TB5",
        display: "TB-类型E",
        label: "方向＋本位币净额＋原币净额",
        any_of: &[],
        required: &[
            &[
                "openingDirection",
                "openingFunctionalAmount",
                "openingForeignAmount",
            ],
            &[
                "closingDirection",
                "closingFunctionalAmount",
                "closingForeignAmount",
            ],
            YTD_F,
        ],
        optional: &[YTD_X],
    },
    Form {
        id: "TB6",
        display: "TB-类型F",
        label: "本位币与原币双借贷分列",
        any_of: &[],
        required: &[
            &[
                "openingFunctionalDebit",
                "openingFunctionalCredit",
                "openingForeignDebit",
                "openingForeignCredit",
            ],
            &[
                "closingFunctionalDebit",
                "closingFunctionalCredit",
                "closingForeignDebit",
                "closingForeignCredit",
            ],
            YTD_F,
        ],
        optional: &[YTD_X],
    },
];

/// JE 三型。
pub(crate) fn je_forms() -> &'static [Form] {
    JE_FORMS
}

// 数组顺序是**从弱到强**：排序规则「同为完整命中时后定义的型优先」，
// 所以这里倒着放，优先级才是 JE1 ＞ JE2 ＞ JE3。
// 三型同时成立时该认最强的那个——借贷分列能推出净额，反之不行；
// 有方向列就该判方向型，判成纯净额型会与金标的类型表对不上。
static JE_FORMS: &[Form] = &[
    Form {
        id: "JE3",
        display: "JE-类型C",
        label: "本位币净额（借正贷负）",
        any_of: &[],
        required: &[&["functionalAmount"]],
        optional: &[&["foreignAmount"]],
    },
    Form {
        id: "JE2",
        display: "JE-类型B",
        label: "方向＋本位币净额",
        any_of: &[],
        required: &[&["direction", "functionalAmount"]],
        optional: &[&["foreignAmount"]],
    },
    Form {
        id: "JE1",
        display: "JE-类型A",
        label: "本位币借贷分列",
        // 借贷分列本身已表达方向，不再要求方向列——实测 9 份序时账里
        // 借贷分列的那 6 份**没有一份带方向列**，金标 2026-08-24 修订时
        // 也把型一的方向列去掉了。有方向列时它只作校验。
        any_of: &[],
        required: &[&["functionalDebit", "functionalCredit"]],
        optional: &[&["foreignDebit", "foreignCredit"]],
    },
];

/// 借款台账四型：A／B／C／D。
///
/// 四型的共同点：起算额（[`Form::any_of`]）、起始日、利率三样必给；
/// 区别只在**怎么确定计息终点**——到期日（A 型）、期限（B 型），
/// 或者靠期间发生额还原本金变动（C 型从期初推、D 型从期末推）。
///
/// **无固定期限借款不纳入**：只有起算额＋起始日＋利率、既无到期日期限也无
/// 期间发生额的那一类（股东借款、关联方拆借、集团资金池、循环贷、永续债），
/// 当前不在测算范围内。它落在「最接近 A 型、缺到期日」的未命中态，
/// 不静默当成某一型放行。以后要纳入直接往表里加一型即可。
pub(crate) fn loan_forms() -> &'static [Form] {
    LOAN_FORMS
}

// 数组顺序同样是**从弱到强**（后定义的型在同分时优先）：A ＞ B ＞ C ＞ D。
// 到期日是直接列示的，比拿期限推算准，所以两者都在时认 A 型；
// 既有到期日又有期间发生额时（04 深圳前湾）也认 A 型，四栏转为勾稽校验。
static LOAN_FORMS: &[Form] = &[
    Form {
        id: "D",
        display: "台账-类型D",
        label: "期末余额＋期间发生额",
        required: &[
            &["startDate"],
            &["rate"],
            &["drawdownAmount", "repaymentAmount"],
        ],
        any_of: &[&["closingPrincipal", "principal"]],
        optional: &[
            &["rateType"],
            &["openingPrincipal"],
            &["endDate"],
            &["term"],
        ],
    },
    Form {
        id: "C",
        display: "台账-类型C",
        label: "期初余额＋期间发生额",
        required: &[
            &["startDate"],
            &["rate"],
            &["drawdownAmount", "repaymentAmount"],
        ],
        any_of: &[&["openingPrincipal", "principal"]],
        optional: &[
            &["rateType"],
            &["closingPrincipal"],
            &["endDate"],
            &["term"],
        ],
    },
    Form {
        id: "B",
        display: "台账-类型B",
        label: "起始日＋期限",
        required: &[&["startDate"], &["term"], &["rate"]],
        any_of: &[&["principal", "openingPrincipal"]],
        optional: &[
            &["rateType"],
            &["endDate"],
            &["closingPrincipal"],
            &["repaymentAmount"],
            &["drawdownAmount"],
        ],
    },
    Form {
        id: "A",
        display: "台账-类型A",
        label: "起始日＋到期日",
        required: &[&["startDate"], &["endDate"], &["rate"]],
        any_of: &[&["principal", "openingPrincipal"]],
        optional: &[
            &["rateType"],
            &["term"],
            &["closingPrincipal"],
            &["repaymentAmount"],
            &["drawdownAmount"],
        ],
    },
];

pub(crate) fn forms(kind: &str) -> &'static [Form] {
    match kind {
        "je" => je_forms(),
        "loan" => loan_forms(),
        _ => tb_forms(),
    }
}

/// 一次形态匹配的结果。
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct FormMatch {
    pub(crate) form: &'static str,
    /// 型号的用户可见名，见 [`Form::display`]。
    pub(crate) display: &'static str,
    pub(crate) label: &'static str,
    /// 必填槽缺失的角色。空即完整命中。
    pub(crate) missing: Vec<&'static str>,
    /// 「任一即可」槽一个都没给：整组列出来，提示语要说「至少映射一个」。
    pub(crate) missing_any: Vec<&'static [&'static str]>,
    /// 可选槽给了一半的角色——**这是错误不是缺省**，要告警。
    pub(crate) partial_optional: Vec<&'static str>,
    /// 完整命中：必填槽全满，且可选槽没有半拉子。
    pub(crate) complete: bool,
}

fn slot_state<'a>(slot: &'a [&'static str], mapped: &HashSet<&str>) -> (usize, Vec<&'static str>) {
    let mut missing = Vec::new();
    let mut hit = 0usize;
    for role in slot {
        if mapped.contains(role) {
            hit += 1;
        } else {
            missing.push(*role);
        }
    }
    (hit, missing)
}

/// 把已映射的角色集合套进各个形态，按匹配度排序返回。
///
/// **完整命中优先；同为完整命中时优先借贷分列**——借贷能推出净额，反之不行，
/// 所以 Oracle 那种"借贷两列与净额列同时给"的表按借贷分列走，不报错。
pub(crate) fn match_forms(kind: &str, mapped: &HashSet<&str>) -> Vec<FormMatch> {
    let mut out: Vec<(FormMatch, usize)> = Vec::new();
    for (idx, f) in forms(kind).iter().enumerate() {
        let mut missing = Vec::new();
        for slot in f.required {
            let (_, miss) = slot_state(slot, mapped);
            missing.extend(miss);
        }
        // 「任一即可」槽：组内一个都没给才算缺，给了任意一个就满足。
        let mut missing_any: Vec<&'static [&'static str]> = Vec::new();
        for slot in f.any_of {
            if !slot.iter().any(|role| mapped.contains(role)) {
                missing_any.push(slot);
            }
        }
        let mut partial = Vec::new();
        for slot in f.optional {
            let (hit, miss) = slot_state(slot, mapped);
            if hit > 0 && !miss.is_empty() {
                partial.extend(miss);
            }
        }
        let complete = missing.is_empty() && missing_any.is_empty() && partial.is_empty();
        out.push((
            FormMatch {
                form: f.id,
                display: f.display,
                label: f.label,
                missing,
                missing_any,
                partial_optional: partial,
                complete,
            },
            idx,
        ));
    }
    // 排序：完整命中在前；其次缺得少的在前；同分时**后定义的型优先**——
    // TB3/TB6 与 JE1 都排在净额型之后，正好实现"优先借贷分列"。
    out.sort_by(|a, b| {
        b.0.complete
            .cmp(&a.0.complete)
            .then(
                (a.0.missing.len() + a.0.missing_any.len())
                    .cmp(&(b.0.missing.len() + b.0.missing_any.len())),
            )
            .then(a.0.partial_optional.len().cmp(&b.0.partial_optional.len()))
            .then(b.1.cmp(&a.1))
    });
    out.into_iter().map(|(m, _)| m).collect()
}

/// 形态匹配的最终判定：命中哪一型，或者该报什么错。
#[derive(Clone, Debug)]
pub(crate) enum FormVerdict {
    /// 完整命中。
    Matched(FormMatch),
    /// 都没命中，附最接近的那型及其缺失清单。
    Incomplete(FormMatch),
}

pub(crate) fn resolve_form(kind: &str, mapped: &HashSet<&str>) -> FormVerdict {
    let ranked = match_forms(kind, mapped);
    let best = ranked.into_iter().next().unwrap_or(FormMatch {
        form: "",
        display: "",
        label: "",
        missing: Vec::new(),
        missing_any: Vec::new(),
        partial_optional: Vec::new(),
        complete: false,
    });
    if best.complete {
        FormVerdict::Matched(best)
    } else {
        FormVerdict::Incomplete(best)
    }
}

/// 把未命中的判定写成给用户看的中文提示。
pub(crate) fn describe_incomplete(kind: &str, m: &FormMatch) -> String {
    let label = |role: &str| {
        role_of(kind, role)
            .map(|x| x.label.to_string())
            .unwrap_or_else(|| role.to_string())
    };
    let mut parts = Vec::new();
    if !m.missing.is_empty() {
        let names: Vec<String> = m.missing.iter().map(|x| label(x)).collect();
        parts.push(format!("缺少「{}」", names.join("」「")));
    }
    for slot in &m.missing_any {
        let names: Vec<String> = slot.iter().map(|x| label(x)).collect();
        parts.push(format!("「{}」至少映射一个", names.join("」「")));
    }
    if !m.partial_optional.is_empty() {
        let names: Vec<String> = m.partial_optional.iter().map(|x| label(x)).collect();
        parts.push(format!(
            "可选字段只映射了一半，「{}」也必须一并映射",
            names.join("」「")
        ));
    }
    if parts.is_empty() {
        return format!("表结构无法匹配任何已知形态（最接近 {}）", m.display);
    }
    format!("按 {}（{}）匹配，{}", m.display, m.label, parts.join("；"))
}

// ────────────────────────────── 币种归一化与列判定 ──────────────────────────────

/// 中文币名与非标准写法 → ISO 代码。`RMB` 归一到 `CNY`。
pub(crate) fn normalize_currency_code(v: &str) -> Option<&'static str> {
    let n = normalize_header(v);
    if n.is_empty() {
        return None;
    }
    const TABLE: &[(&str, &[&str])] = &[
        ("CNY", &["cny", "rmb", "人民币", "人民幣", "元", "¥"]),
        ("USD", &["usd", "us$", "美元", "美金", "美币"]),
        ("HKD", &["hkd", "港币", "港幣", "港元"]),
        ("EUR", &["eur", "欧元", "歐元", "€"]),
        ("JPY", &["jpy", "日元", "日圆", "日圓"]),
        ("GBP", &["gbp", "英镑", "英鎊", "£"]),
        ("AUD", &["aud", "澳元", "澳币", "澳大利亚元"]),
        ("CAD", &["cad", "加元", "加拿大元"]),
        ("SGD", &["sgd", "新加坡元", "新元"]),
        ("CHF", &["chf", "瑞士法郎"]),
        ("KRW", &["krw", "韩元", "韓元"]),
        ("TWD", &["twd", "ntd", "新台币", "新臺幣", "台币"]),
        ("MOP", &["mop", "澳门元", "澳門元", "澳币元"]),
        ("NZD", &["nzd", "新西兰元"]),
        ("THB", &["thb", "泰铢", "泰銖"]),
        ("MYR", &["myr", "马来西亚林吉特", "林吉特"]),
        ("RUB", &["rub", "卢布", "盧布"]),
        ("INR", &["inr", "印度卢比"]),
        ("SEK", &["sek", "瑞典克朗"]),
        ("NOK", &["nok", "挪威克朗"]),
        ("DKK", &["dkk", "丹麦克朗"]),
        ("ZAR", &["zar", "南非兰特"]),
        ("BRL", &["brl", "巴西雷亚尔"]),
        ("AED", &["aed", "迪拉姆"]),
        ("VND", &["vnd", "越南盾"]),
        ("IDR", &["idr", "印尼盾", "印尼卢比"]),
    ];
    for (code, forms) in TABLE {
        if forms.iter().any(|f| n == *f) {
            return Some(code);
        }
    }
    None
}

/// 币种代码列的角色判定结果。
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum CurrencyColumn {
    /// 原币列：逐行给出该行余额的币种。
    Foreign {
        /// 该列出现过的币种代码。
        codes: BTreeSet<&'static str>,
        /// 存在空白单元格——空白代表本位币，这列在"只标外币"。
        has_blank: bool,
    },
    /// 本位币列：填满且只有一个币种，不区分任何行。
    Functional { code: &'static str },
    /// 一个币种代码都认不出来，等同于没有这列。
    Unusable {
        /// 认不出的原始取值，用于告警。
        unknown: Vec<String>,
    },
}

/// 空白到什么程度才算「这列在只标外币」。
///
/// 实测：真正只标外币的列空白率 92–99%，而 SAP 报表那种整列同值的币种标注列
/// 只有末尾一两行零星缺失（113 行里空 2 行 ＝ 1.8%）。零星缺失不承载语义，
/// 拿它当「只标外币」会把整列 RMB 的标注列判成原币列，进而把全表科目当外币。
const BLANK_MEANS_FUNCTIONAL: f64 = 0.10;

/// 单列币种代码的角色判定。
///
/// **规则**：只出现一种币种、且空白稀少 → 本位币列；其余一切情形 → 原币列。
/// 认不出的取值当空处理并计入 `unknown`，不猜。
///
/// 依据：实测 9 份真实 TB，只标外币的写法（空白率 92–99%）与逐行都填的写法各占一半，
/// 前者空白即本位币、填了即外币；后者才需要跟本位币比对。
pub(crate) fn classify_currency_column<'a, I>(values: I) -> CurrencyColumn
where
    I: IntoIterator<Item = &'a str>,
{
    let mut codes: BTreeSet<&'static str> = BTreeSet::new();
    let mut unknown: Vec<String> = Vec::new();
    let mut blank = 0usize;
    let mut total = 0usize;
    for v in values {
        total += 1;
        let t = v.trim();
        if t.is_empty() {
            blank += 1;
            continue;
        }
        match normalize_currency_code(t) {
            Some(c) => {
                codes.insert(c);
            }
            None => {
                // 认不出 → 当空处理，但要让调用方能告警。
                blank += 1;
                if !unknown.iter().any(|x| x == t) {
                    unknown.push(t.to_string());
                }
            }
        }
    }
    if codes.is_empty() {
        return CurrencyColumn::Unusable { unknown };
    }
    let blank_ratio = if total == 0 {
        0.0
    } else {
        blank as f64 / total as f64
    };
    if codes.len() == 1 && blank_ratio < BLANK_MEANS_FUNCTIONAL {
        let code = *codes.iter().next().expect("codes 非空");
        return CurrencyColumn::Functional { code };
    }
    CurrencyColumn::Foreign {
        codes,
        has_blank: blank > 0,
    }
}

/// 本位币被用户改掉之后的反判。
///
/// 一列填满 `USD` 会被判成本位币列；若用户把本位币选成人民币，说明这是境外主体的
/// 全美元账，该列应改判为原币列。
pub(crate) fn reclassify_against_functional(
    col: CurrencyColumn,
    functional: &str,
) -> CurrencyColumn {
    if let CurrencyColumn::Functional { code } = col {
        if let Some(f) = normalize_currency_code(functional) {
            if f != code {
                let mut codes = BTreeSet::new();
                codes.insert(code);
                return CurrencyColumn::Foreign {
                    codes,
                    has_blank: false,
                };
            }
        }
        return CurrencyColumn::Functional { code };
    }
    col
}

// ────────────────────────────── 借贷符号方向判定 ──────────────────────────────
//
// 这一节整体来自看账工具（`tabular.rs`）——五个工具里它对序时账的判定最完整，
// 作为基座提升为公共内核。核心是**凭证平衡投票**：一张借贷齐全的凭证，
// 「符号一样」时 Σ借≈Σ贷，「已带符号」时 Σ原值≈0，两者互斥，是铁证。
// 没有可投票的凭证时才退到列级多数兜底（依据：红字冲销永远是少数）。
//
// TB 没有凭证可配平，改用勾稽等式 `期末 = 期初 + 借 + s·贷` 的全表成立率，
// 产出同一个 [`SignEvidence`]，让上层的展示与用户覆盖逻辑完全共用。

/// 金额符号口径：数值本身是否已区分借贷方向。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SignConvention {
    /// 已带符号（借正贷负）：净额即原值。
    Signed,
    /// 借贷符号一样（都是正数，靠分列或方向列区分）：净额需换算。
    Unsigned,
}

impl SignConvention {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            SignConvention::Signed => "signed",
            SignConvention::Unsigned => "unsigned",
        }
    }

    /// 贷方列应乘的系数。TB 的勾稽等式与 JE 的净额换算都用它。
    pub(crate) fn credit_sign(self) -> f64 {
        match self {
            SignConvention::Signed => 1.0,
            SignConvention::Unsigned => -1.0,
        }
    }
}

/// 符号口径检测的原始证据——只算数不拼文案，计算与报告共用。
#[derive(Debug, Clone)]
pub(crate) struct SignEvidence {
    /// 金额方案：`A`＝金额＋方向列，`B`＝借贷分列，`single`＝单一金额列，
    /// `tb`＝科目余额表勾稽等式，`none`＝金额字段未映射。
    pub(crate) scheme: &'static str,
    pub(crate) convention: Option<SignConvention>,
    /// 两种口径各自的得票（JE 是配平的凭证张数，TB 是等式成立的行数）。
    pub(crate) signed_votes: usize,
    pub(crate) unsigned_votes: usize,
    /// 两种口径都不成立的凭证／行数。JE 上多半是凭证识别字段组错，
    /// TB 上说明期末与期初＋发生额本身就勾稽不上。
    pub(crate) unbalanced: usize,
    /// 只有借方或只有贷方的凭证张数。账被按科目筛选过时这个占比会很高
    /// （另一半分录被筛掉了），是区分「账被筛过」和「凭证键组错」的关键信号。
    pub(crate) one_sided: usize,
    pub(crate) total_vouchers: usize,
    /// 没有凭证级证据时的说明（列级兜底或固有结论）。
    pub(crate) note: Option<String>,
}

impl SignEvidence {
    fn blank(scheme: &'static str) -> Self {
        SignEvidence {
            scheme,
            convention: None,
            signed_votes: 0,
            unsigned_votes: 0,
            unbalanced: 0,
            one_sided: 0,
            total_vouchers: 0,
            note: None,
        }
    }
}

enum VoteOutcome {
    NoVotes,
    Decided(SignConvention),
    Tie,
}

fn tally_votes(signed: usize, unsigned: usize) -> VoteOutcome {
    if signed == 0 && unsigned == 0 {
        VoteOutcome::NoVotes
    } else if signed > unsigned {
        VoteOutcome::Decided(SignConvention::Signed)
    } else if unsigned > signed {
        VoteOutcome::Decided(SignConvention::Unsigned)
    } else {
        VoteOutcome::Tie
    }
}

/// 方向列取值是否表示贷方。
pub(crate) fn is_credit_direction(value: &str) -> bool {
    let trimmed = value.trim();
    let lower = trimmed.to_lowercase();
    trimmed.contains('贷')
        || trimmed.contains('貸')
        || lower.contains("credit")
        || matches!(lower.as_str(), "c" | "cr" | "h" | "k")
        || trimmed.contains('-')
        || trimmed.contains('\u{2212}')
}

/// 列级兜底：只看贷方列数值的正负多数。红字冲销永远是少数，
/// 所以贷方全正即「符号一样」，全负即「已带符号」。
fn fallback_by_credit_column(evidence: &mut SignEvidence, credit: &[f64]) {
    let positive = credit.iter().filter(|v| **v > 0.0).count();
    let negative = credit.iter().filter(|v| **v < 0.0).count();
    match (positive, negative) {
        (0, 0) => {
            evidence.convention = Some(SignConvention::Unsigned);
            evidence.note =
                Some("没有贷方数值，两种口径算出的净额一致，按「借贷符号一样」处理。".into());
        }
        (pos, 0) => {
            evidence.convention = Some(SignConvention::Unsigned);
            evidence.note = Some(format!("贷方列 {pos} 个数值全部为正——推断借贷符号一样。"));
        }
        (0, neg) => {
            evidence.convention = Some(SignConvention::Signed);
            evidence.note = Some(format!("贷方列 {neg} 个数值全部为负——推断金额已带符号。"));
        }
        (pos, neg) if neg > pos => {
            evidence.convention = Some(SignConvention::Signed);
            evidence.note = Some(format!(
                "贷方列数值 {neg} 负 / {pos} 正，负数占多数（红字是少数）——推断金额已带符号。"
            ));
        }
        (pos, neg) if pos > neg => {
            evidence.convention = Some(SignConvention::Unsigned);
            evidence.note = Some(format!(
                "贷方列数值 {pos} 正 / {neg} 负，正数占多数——推断借贷符号一样。"
            ));
        }
        _ => {
            evidence.note = Some("贷方列正负数值各半，无法自动判定。".into());
        }
    }
}

/// JE 方案 B：借贷分列。`vouchers` 是按凭证键分好组的行下标。
pub(crate) fn je_sign_evidence_debit_credit(
    debit: &[f64],
    credit: &[f64],
    vouchers: &[Vec<usize>],
) -> SignEvidence {
    let mut evidence = SignEvidence::blank("B");
    let at = |v: &[f64], i: usize| v.get(i).copied().unwrap_or(0.0);
    let raw: Vec<f64> = debit
        .iter()
        .zip(credit.iter())
        .map(|(dr, cr)| {
            if *dr != 0.0 && *cr != 0.0 {
                dr - cr
            } else if *dr != 0.0 {
                *dr
            } else {
                *cr
            }
        })
        .collect();
    evidence.total_vouchers = vouchers.len();
    for indexes in vouchers {
        if !indexes.iter().any(|&i| at(debit, i) != 0.0)
            || !indexes.iter().any(|&i| at(credit, i) != 0.0)
        {
            evidence.one_sided += 1;
            continue;
        }
        let dr_sum: f64 = indexes.iter().map(|&i| at(debit, i)).sum();
        let cr_sum: f64 = indexes.iter().map(|&i| at(credit, i)).sum();
        let raw_sum: f64 = indexes.iter().map(|&i| at(&raw, i)).sum();
        if (dr_sum - cr_sum).abs() < 0.01 && dr_sum.abs() + cr_sum.abs() > 0.01 {
            evidence.unsigned_votes += 1;
        } else if raw_sum.abs() < 0.01 {
            evidence.signed_votes += 1;
        } else {
            evidence.unbalanced += 1;
        }
    }
    match tally_votes(evidence.signed_votes, evidence.unsigned_votes) {
        VoteOutcome::Decided(c) => evidence.convention = Some(c),
        VoteOutcome::Tie => {
            evidence.note = Some("借贷齐全凭证的口径投票打平，无法自动判定。".into())
        }
        VoteOutcome::NoVotes => fallback_by_credit_column(&mut evidence, credit),
    }
    evidence
}

/// JE 方案 A：金额＋方向列。
///
/// `has_direction` 标记该行的方向列是否有值——方向为空的行既不算借也不算贷，
/// 不能拿它去凑配平。
pub(crate) fn je_sign_evidence_amount_direction(
    amount: &[f64],
    is_credit: &[bool],
    has_direction: &[bool],
    vouchers: &[Vec<usize>],
) -> SignEvidence {
    let mut evidence = SignEvidence::blank("A");
    let flag = |v: &[bool], i: usize| v.get(i).copied().unwrap_or(false);
    evidence.total_vouchers = vouchers.len();
    for indexes in vouchers {
        let mut debit_side = 0.0;
        let mut credit_side = 0.0;
        let mut has_debit = false;
        let mut has_credit = false;
        let mut total = 0.0;
        for &i in indexes {
            let v = amount.get(i).copied().unwrap_or(0.0);
            if flag(is_credit, i) {
                has_credit = true;
                credit_side += v;
            } else if flag(has_direction, i) {
                has_debit = true;
                debit_side += v;
            }
            total += v;
        }
        if !has_debit || !has_credit {
            evidence.one_sided += 1;
            continue;
        }
        if (debit_side - credit_side).abs() < 0.01 && debit_side.abs() + credit_side.abs() > 0.01 {
            evidence.unsigned_votes += 1;
        } else if total.abs() < 0.01 {
            evidence.signed_votes += 1;
        } else {
            evidence.unbalanced += 1;
        }
    }
    match tally_votes(evidence.signed_votes, evidence.unsigned_votes) {
        VoteOutcome::Decided(c) => evidence.convention = Some(c),
        VoteOutcome::Tie => {
            evidence.note = Some("借贷齐全凭证的口径投票打平，无法自动判定。".into())
        }
        VoteOutcome::NoVotes => {
            // 兜底：负数金额落在哪个方向。已带符号的账负数集中在贷方向；
            // 符号一样的账负数是红字，集中在借方向。
            let neg_credit = amount
                .iter()
                .enumerate()
                .filter(|(i, v)| **v < 0.0 && flag(is_credit, *i))
                .count();
            let neg_debit = amount
                .iter()
                .enumerate()
                .filter(|(i, v)| **v < 0.0 && !flag(is_credit, *i) && flag(has_direction, *i))
                .count();
            match (neg_credit, neg_debit) {
                (0, 0) => {
                    evidence.convention = Some(SignConvention::Unsigned);
                    evidence.note = Some("金额全为正，方向列区分借贷——符号一样。".into());
                }
                (cr, dr) if cr > dr => {
                    evidence.convention = Some(SignConvention::Signed);
                    evidence.note = Some(format!(
                        "负数金额 {cr} 个落在贷方向、{dr} 个落在借方向——推断金额已带符号。"
                    ));
                }
                (cr, dr) if dr > cr => {
                    evidence.convention = Some(SignConvention::Unsigned);
                    evidence.note = Some(format!(
                        "负数金额 {dr} 个落在借方向（红字冲销）、{cr} 个落在贷方向——推断金额为正数、方向列区分借贷。"
                    ));
                }
                _ => {
                    evidence.note = Some("负数金额在借贷两方向各半，无法自动判定。".into());
                }
            }
        }
    }
    evidence
}

/// JE 单一金额列：不带符号凭证就无法配平，必然已带符号，无需判断。
pub(crate) fn je_sign_evidence_single(total_vouchers: usize) -> SignEvidence {
    let mut evidence = SignEvidence::blank("single");
    evidence.convention = Some(SignConvention::Signed);
    evidence.total_vouchers = total_vouchers;
    evidence.note = Some("单一金额列必然已带符号，否则凭证无法配平。".into());
    evidence
}

/// TB 勾稽等式的一行观测：`closing = opening + debit + s·credit`。
#[derive(Clone, Copy, Debug)]
pub(crate) struct BalanceRow {
    pub(crate) opening: f64,
    pub(crate) debit: f64,
    pub(crate) credit: f64,
    pub(crate) closing: f64,
}

fn holds(row: &BalanceRow, s: f64) -> bool {
    let lhs = row.closing;
    let rhs = row.opening + row.debit + s * row.credit;
    // 金额有舍入，绝对与相对容差取大者。
    let tol = (lhs.abs() * 1e-6).max(0.01);
    (lhs - rhs).abs() <= tol
}

/// TB 侧的符号判定：科目余额表没有凭证可配平，改用勾稽等式
/// `期末 = 期初 + 借方 + s·贷方` 的**全表成立率**裁决。
///
/// 逐行算、全表统计取多数，不逐行判——个别行数据错不能翻盘。
/// 实测那份 229 行 SAP 科目明细：`s=−1` 成立 100%，`s=+1` 成立 31%，判别度足够大。
pub(crate) fn tb_sign_evidence(rows: &[BalanceRow]) -> SignEvidence {
    let mut evidence = SignEvidence::blank("tb");
    let usable: Vec<&BalanceRow> = rows
        .iter()
        .filter(|r| {
            r.opening.abs() > 0.0
                || r.debit.abs() > 0.0
                || r.credit.abs() > 0.0
                || r.closing.abs() > 0.0
        })
        .collect();
    evidence.total_vouchers = usable.len();
    if usable.is_empty() {
        evidence.note = Some("科目余额表没有可用于勾稽的数据行。".into());
        return evidence;
    }
    for row in &usable {
        // 贷方为零的行对两个假设都成立，投给谁都一样，不计票。
        if row.credit.abs() == 0.0 {
            evidence.one_sided += 1;
            continue;
        }
        match (holds(row, -1.0), holds(row, 1.0)) {
            (true, false) => evidence.unsigned_votes += 1,
            (false, true) => evidence.signed_votes += 1,
            (true, true) => evidence.one_sided += 1,
            (false, false) => evidence.unbalanced += 1,
        }
    }
    match tally_votes(evidence.signed_votes, evidence.unsigned_votes) {
        VoteOutcome::Decided(c) => evidence.convention = Some(c),
        VoteOutcome::Tie => {
            evidence.note = Some("勾稽等式对两种口径的成立行数打平，无法自动判定。".into())
        }
        VoteOutcome::NoVotes => {
            let credits: Vec<f64> = usable.iter().map(|r| r.credit).collect();
            fallback_by_credit_column(&mut evidence, &credits);
        }
    }
    evidence
}

/// 在表头里找某个列名的位置：先精确匹配，再按「只留字母数字、转小写」宽松匹配。
///
/// 宽松匹配是必需的——映射里存的列名可能带空格、括号或大小写差异，
/// 与表头原文对不上。此前这个函数只存在于看账模块，别的工具用不到它，
/// 内核也因此没法按列名取数。
pub(crate) fn header_index(headers: &[String], name: &str) -> Option<usize> {
    headers.iter().position(|v| v == name).or_else(|| {
        let n = normalize_name(name);
        headers.iter().position(|v| normalize_name(v) == n)
    })
}

/// 列名的宽松归一：只保留字母数字并转小写。
///
/// 与 [`normalize_header`] 的区别：那个是**别名匹配**用的，只去分隔符、
/// 保留中文与符号；这个是**找列**用的，把所有非字母数字统统丢掉。
pub(crate) fn normalize_name(value: &str) -> String {
    value
        .chars()
        .filter(|c| c.is_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

// 很多科目余额表不设币种列，币种写在科目名称或科目文本里
// （例如“银行存款-建行USD4150-4800”）。这里按词边界从自由文本抽取币种：
// 命中唯一币种才返回，命中多个视为歧义，宁可交回上游按映射列处理。
pub(crate) fn currency_text_aliases() -> &'static [(&'static str, &'static [&'static str])] {
    &[
        ("CNY", &["CNY", "RMB", "人民币"]),
        ("USD", &["USD", "美元", "美金"]),
        ("EUR", &["EUR", "欧元"]),
        ("JPY", &["JPY", "日元", "日圆"]),
        ("HKD", &["HKD", "港币", "港元"]),
        ("GBP", &["GBP", "英镑"]),
        ("AUD", &["AUD", "澳元", "澳大利亚元"]),
        ("NZD", &["NZD", "新西兰元"]),
        ("SGD", &["SGD", "新加坡元", "新币"]),
        ("CHF", &["CHF", "瑞士法郎"]),
        ("CAD", &["CAD", "加拿大元", "加元"]),
        ("MOP", &["MOP", "澳门元", "澳门币"]),
        ("MYR", &["MYR", "林吉特"]),
        ("RUB", &["RUB", "卢布"]),
        ("ZAR", &["ZAR", "兰特"]),
        ("KRW", &["KRW", "韩元"]),
        ("AED", &["AED", "迪拉姆"]),
        ("SAR", &["SAR", "里亚尔"]),
        ("HUF", &["HUF", "福林"]),
        ("PLN", &["PLN", "兹罗提"]),
        ("DKK", &["DKK", "丹麦克朗"]),
        ("SEK", &["SEK", "瑞典克朗"]),
        ("NOK", &["NOK", "挪威克朗"]),
        ("TRY", &["TRY", "土耳其里拉"]),
        ("MXN", &["MXN", "墨西哥比索"]),
        ("THB", &["THB", "泰铢"]),
    ]
}

pub(crate) fn currency_from_text(value: &str) -> Option<String> {
    let normalized = value.to_uppercase();
    let bytes = normalized.as_bytes();
    // 三字母代码必须独立成词，避免 “PLUSD”“USDT” 这类子串误命中。
    let hit = |alias: &str| {
        if !alias.is_ascii() {
            return normalized.contains(alias);
        }
        normalized.match_indices(alias).any(|(index, _)| {
            let before = index == 0 || !bytes[index - 1].is_ascii_alphabetic();
            let end = index + alias.len();
            let after = end >= bytes.len() || !bytes[end].is_ascii_alphabetic();
            before && after
        })
    };
    let mut found = currency_text_aliases()
        .iter()
        .filter(|(_, aliases)| aliases.iter().any(|alias| hit(alias)))
        .map(|(code, _)| (*code).to_owned())
        .collect::<Vec<_>>();
    found.dedup();
    (found.len() == 1).then(|| found.remove(0))
}

/// 一段文本看着像不像科目编码。
///
/// 要求是**含数字的 ASCII 字母数字串**，可以带点号分级。这一条是
/// [`split_code_and_name`] 的守门人：06 号样例的 `交易性金融资产_结构性存款`
/// 也带下划线，但首段是中文，不是编码。
pub(crate) fn looks_like_account_code(value: &str) -> bool {
    let count = value.chars().count();
    count > 0
        && count <= 24
        && value.chars().any(|c| c.is_ascii_digit())
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-')
}

/// 编码与名称写在同一格时，把它拆成两半。
///
/// 03 号样例的余额表整张表**只有一列科目**：一级写作 `1001/库存现金`，
/// 末级写作 `1001010000:库存现金-人民币`——没有独立编码列，不拆就没法跟序时账
/// 对科目。04／05 号写作 `1001_现金`，08 号写作
/// `10020101\银行存款\在财务公司存款\活期`（编码后面跟着多级名称）。
///
/// 分隔符认 `/ : _ \ |`，外加一种受限的空格边界：首 token 本身是足位数
/// ASCII 编码时（`6701090001 财务费用-汇兑收益`）。**绝不认 `-`**，也绝不
/// 在首 token 不是编码时按空格拆——`银行存款-人民币-中国银行`、
/// `应付账款 - 应付暂估款` 是名称自己的分段，按它们拆会把科目名切碎。
pub(crate) fn split_code_and_name(value: &str) -> Option<(String, String)> {
    let (code, name) = split_code_and_name_ref(value)?;
    Some((code.to_owned(), name.to_owned()))
}

/// [`split_code_and_name`] 的引用版：匹配键的计算路径只能借用切片、
/// 不能持有 String（fx 的 `account_match_key` 返回 `&str`），用这一份。
pub(crate) fn split_code_and_name_ref(value: &str) -> Option<(&str, &str)> {
    const SEPARATORS: [char; 5] = ['/', ':', '_', '\\', '|'];
    let trimmed = value.trim();
    if let Some(position) = trimmed.find(SEPARATORS) {
        let code = trimmed[..position].trim();
        // 分隔符都是单字节 ASCII，跳过它是安全的。
        let name = trimmed[position + 1..].trim();
        if looks_like_account_code(code) && !name.is_empty() {
            return Some((code, name));
        }
    }
    // 空格边界：`6701090001 财务费用-汇兑收益-未实现`（用友导出、审计底稿
    // 的常见写法）。仅当首 token 本身是**足位数**的 ASCII 编码时才拆——
    // `应付账款 - 应付暂估款`、`3 个月定期` 这类名称自带空格的首段不是编码，
    // 绝不能拆。alpha.39 的正文行编码校验按拆出的编码判合法性，拆不开时
    // 整格都过不了 `looks_like_account_code`，合并列的正文行会被整批当垃圾
    // 剔掉（fx 损益取数返回空集即此回归）。
    let (first, rest) = trimmed.split_once(char::is_whitespace)?;
    let digits = first.chars().filter(|c| c.is_ascii_digit()).count();
    (looks_like_account_code(first) && digits >= 3 && !rest.trim().is_empty())
        .then_some((first, rest.trim()))
}

/// 整列是不是「编码+名称」混写的科目列。
///
/// 要求**四分之三以上**的非空取值都能拆开：少数拆不开是正常的（合计行、
/// 只有编码没名称的行），反过来只有零星几行能拆多半是巧合，不足以据此
/// 改写整列的语义。
pub(crate) fn is_combined_account_column(values: impl Iterator<Item = String>) -> bool {
    let (mut total, mut split) = (0usize, 0usize);
    for value in values.take(2000) {
        if value.trim().is_empty() {
            continue;
        }
        total += 1;
        if split_code_and_name(&value).is_some() {
            split += 1;
        }
    }
    total >= 4 && split * 4 >= total * 3
}

/// 从一格里取科目编码：混写时取首段，否则原样。
pub(crate) fn account_code_of(value: &str) -> String {
    split_code_and_name(value)
        .map(|(code, _)| code)
        .unwrap_or_else(|| value.trim().to_owned())
}

/// 从一格里取科目名称：混写时取编码后面那半，否则原样。
pub(crate) fn account_name_of(value: &str) -> String {
    split_code_and_name(value)
        .map(|(_, name)| name)
        .unwrap_or_else(|| value.trim().to_owned())
}

/// 会计要素类别。按《企业会计准则——会计科目和主要账务处理》的编码首位划分。
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) enum AccountCategory {
    /// 1 资产
    Asset,
    /// 2 负债
    Liability,
    /// 3 共同（金融企业专用，如清算资金往来）
    Shared,
    /// 4 所有者权益
    Equity,
    /// 5 成本
    Cost,
    /// 6 损益
    ProfitLoss,
}

impl AccountCategory {
    pub(crate) fn label(self) -> &'static str {
        match self {
            Self::Asset => "资产",
            Self::Liability => "负债",
            Self::Shared => "共同",
            Self::Equity => "所有者权益",
            Self::Cost => "成本",
            Self::ProfitLoss => "损益",
        }
    }
}

/// 按科目编码首位判会计要素。认不出返回 `None`——**绝不猜**。
///
/// 会计恒等式核对全靠这个分类，认错一个大类，结论就是错的。自定义科目表、
/// 字母开头的编码都归到「认不出」，由调用方决定是跳过整条检查还是列出来给用户看。
///
/// 编码先经 [`normalize_account_code`] 去掉前导零：SAP 那类补零到定长的编码
/// （`0000943100`）首位是 0，不去零一个都认不出来。
pub(crate) fn account_category(code: &str) -> Option<AccountCategory> {
    match normalize_account_code(code).chars().next()? {
        '1' => Some(AccountCategory::Asset),
        '2' => Some(AccountCategory::Liability),
        '3' => Some(AccountCategory::Shared),
        '4' => Some(AccountCategory::Equity),
        '5' => Some(AccountCategory::Cost),
        '6' => Some(AccountCategory::ProfitLoss),
        _ => None,
    }
}

/// 科目编码的匹配归一：去掉前导零。
///
/// SAP 一类系统把科目编码补零到定长（`0000943100`），而同一套账的余额表导出时
/// 往往把前导零去掉（`943100`）。05 号样例里序时账约一成的科目是补零写法、
/// 余额表一个都没有——不归一化，这批科目在 TB 与 JE 之间直接对不上，
/// 表现是「凭空多出一批只在序时账里出现的科目」，而不是报错。
///
/// **只去前导零**：分段编码（`1002.01`）、字母编码（`A1001`）原样保留。
/// 整串都是零时保留原样，免得把 `0000` 抹成空串。
///
/// 只用于**建匹配键**，不改展示值——界面上仍要显示账里原本的写法。
pub(crate) fn normalize_account_code(value: &str) -> String {
    let trimmed = value.trim().to_uppercase();
    let stripped = trimmed.trim_start_matches('0');
    if stripped.is_empty() {
        trimmed
    } else {
        stripped.to_owned()
    }
}

/// TB/JE 共用的科目匹配策略。
///
/// 普通科目以「主体＋归一化科目编码」为键；只有同一主体下同一编码在任一侧
/// 实际对应多个不同名称时，才把规范化名称追加到键中。这里判断的是
/// 「一个编码对应几个不同名称」，不是一张序时账里同一编码出现了多少行——
/// 后者只是正常的多笔分录，不能误判成编码不唯一。
///
/// 编码在统计歧义前先走 [`normalize_account_code`]，所以 `0000943100` 与
/// `943100` 被视为同一个编码。名称只在确有编码歧义时参与匹配；普通情况下
/// TB 的标准科目名与 JE 的账户全称即使写法不同，也不会把同一科目拆开。
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct AccountMatchPolicy {
    ambiguous_codes: HashSet<(String, String)>,
}

impl AccountMatchPolicy {
    /// 每行依次为（主体、科目编码、科目名称）。两侧分开统计，避免仅仅因为
    /// TB 与 JE 对同一科目采用不同名称，就把原本唯一的编码误判为歧义。
    pub(crate) fn from_sides(
        tb: &[(String, String, String)],
        je: &[(String, String, String)],
    ) -> Self {
        let collect = |rows: &[(String, String, String)]| {
            let mut index = HashMap::<(String, String), HashSet<String>>::new();
            for (entity, raw_code, raw_name) in rows {
                let code = normalize_account_code(&account_code_of(raw_code));
                let name = normalize_name(&account_name_of(raw_name));
                if code.is_empty() || name.is_empty() {
                    continue;
                }
                index
                    .entry((entity.trim().to_uppercase(), code))
                    .or_default()
                    .insert(name);
            }
            index
        };
        let tb_index = collect(tb);
        let je_index = collect(je);
        let ambiguous_codes = tb_index
            .iter()
            .chain(je_index.iter())
            .filter_map(|(key, names)| (names.len() > 1).then_some(key.clone()))
            .collect();
        Self { ambiguous_codes }
    }

    pub(crate) fn is_ambiguous(&self, entity: &str, raw_code: &str) -> bool {
        let key = (
            entity.trim().to_uppercase(),
            normalize_account_code(&account_code_of(raw_code)),
        );
        self.ambiguous_codes.contains(&key)
    }

    /// 返回可直接作为公共汇总键中「科目」一段的稳定值。
    pub(crate) fn account_key(&self, entity: &str, raw_code: &str, raw_name: &str) -> String {
        let code = normalize_account_code(&account_code_of(raw_code));
        let name = normalize_name(&account_name_of(raw_name));
        if code.is_empty() {
            return name;
        }
        if self.is_ambiguous(entity, &code) && !name.is_empty() {
            format!("{code}\u{1f}{name}")
        } else {
            code
        }
    }

    pub(crate) fn ambiguous_count(&self) -> usize {
        self.ambiguous_codes.len()
    }
}

/// 仅允许同主体、两张账表都存在且各自唯一的科目名称作为缺失编码的回退键。
/// 输入编码必须来自已确认映射列，不能从名称中猜测；不用于模糊匹配。
pub(crate) fn validated_account_name_keys(
    tb: &[(String, String, String)],
    je: &[(String, String, String)],
) -> std::collections::HashSet<(String, String)> {
    let collect = |rows: &[(String, String, String)]| {
        let mut index =
            std::collections::HashMap::<(String, String), std::collections::HashSet<String>>::new();
        for (entity, code, name) in rows {
            let name = normalize_name(name);
            if !name.is_empty() {
                index
                    .entry((entity.trim().to_owned(), name))
                    .or_default()
                    .insert(code.trim().to_owned());
            }
        }
        index
    };
    let left = collect(tb);
    let right = collect(je);
    left.into_iter()
        .filter_map(|(key, codes)| {
            let other = right.get(&key)?;
            (codes.len() == 1 && other.len() == 1 && (codes.contains("") || other.contains("")))
                .then_some(key)
        })
        .collect()
}

/// 从一整张表算出它的借贷符号口径。**五个工具共用这一个入口。**
///
/// 此前内核只提供投票函数这类**原料**（[`je_sign_evidence_debit_credit`] 等），
/// 「怎么从一张表算出口径」的**流程**却由各工具各写一份：看账一份、存款调看账的、
/// 借款自己拼原料、汇兑损益又是一份。改一处不会让别处跟着变，正是要消除的分裂。
///
/// 各工具的映射结构互不相同（有的是强类型结构体，有的是 JSON 字典），所以这里
/// 不接受映射本身——调用方只需回答**「某个角色对应哪一列」**，取列、分组、投票
/// 全在内核完成。
///
/// `column_of` 传入标准角色名，返回列名；多列角色（凭证识别字段）返回全部列。
pub(crate) fn detect_sign_convention(
    headers: &[String],
    rows: &[Vec<String>],
    column_of: &dyn Fn(&str) -> Vec<String>,
) -> SignEvidence {
    detect_convention(false, headers, rows, column_of)
}

/// 科目余额表侧的入口：没有凭证可配平，改用勾稽等式投票。
pub(crate) fn detect_tb_sign_convention(
    headers: &[String],
    rows: &[Vec<String>],
    column_of: &dyn Fn(&str) -> Vec<String>,
) -> SignEvidence {
    detect_convention(true, headers, rows, column_of)
}

fn detect_convention(
    is_tb: bool,
    headers: &[String],
    rows: &[Vec<String>],
    column_of: &dyn Fn(&str) -> Vec<String>,
) -> SignEvidence {
    let index_of = |role: &str| -> Option<usize> {
        column_of(role)
            .into_iter()
            .find_map(|name| header_index(headers, &name))
    };
    let numbers = |index: usize| -> Vec<f64> {
        rows.iter()
            .map(|row| {
                parse_amount(row.get(index).map(String::as_str).unwrap_or(""))
                    .ok()
                    .flatten()
                    .unwrap_or(0.0)
            })
            .collect()
    };

    if is_tb {
        // 科目余额表没有凭证可配平，改用勾稽等式：期初 ＋ 借 − 贷 ＝ 期末。
        // 期初、期末本身也有三种记法。不能只找净额列：TB3／TB6 的余额是
        // 借贷分列，字段映射虽然完整，旧逻辑却会误报“余额未映射齐全”。先把
        // 每个端点统一折成借正贷负净额，再把发生额贷方的符号留给等式投票裁决。
        let balance_values = |prefix: &str| -> Option<Vec<f64>> {
            let amount = index_of(&format!("{prefix}Amount"));
            let debit = index_of(&format!("{prefix}Debit"));
            let credit = index_of(&format!("{prefix}Credit"));
            if amount.is_none() && !(debit.is_some() && credit.is_some()) {
                return None;
            }
            let base = prefix
                .strip_suffix("Functional")
                .or_else(|| prefix.strip_suffix("Foreign"))
                .unwrap_or(prefix);
            let direction = index_of(&format!("{base}Direction")).or_else(|| index_of("direction"));
            let self_signed = balance_self_signed(headers, rows, column_of, prefix);
            Some(
                rows.iter()
                    .map(|row| {
                        let number = |index: Option<usize>| {
                            index
                                .and_then(|i| row.get(i))
                                .and_then(|value| parse_amount(value).ok().flatten())
                        };
                        let inputs = AmountInputs {
                            amount: number(amount),
                            debit: number(debit),
                            credit: number(credit),
                            direction: direction.and_then(|i| row.get(i)).map(ToOwned::to_owned),
                        };
                        signed_balance(&inputs, SignConvention::Unsigned, self_signed)
                    })
                    .collect(),
            )
        };
        let complete_unit = ["Functional", "Foreign"].into_iter().find_map(|unit| {
            let opening = balance_values(&format!("opening{unit}"))?;
            let closing = balance_values(&format!("closing{unit}"))?;
            let debit = index_of(&format!("ytd{unit}Debit"))?;
            let credit = index_of(&format!("ytd{unit}Credit"))?;
            Some((opening, closing, debit, credit))
        });
        let Some((opening, closing, debit, credit)) = complete_unit else {
            let has_opening = ["Functional", "Foreign"]
                .into_iter()
                .any(|unit| balance_values(&format!("opening{unit}")).is_some());
            let has_closing = ["Functional", "Foreign"]
                .into_iter()
                .any(|unit| balance_values(&format!("closing{unit}")).is_some());
            let has_any_debit = ["ytdFunctionalDebit", "ytdForeignDebit"]
                .into_iter()
                .any(|role| index_of(role).is_some());
            let has_any_credit = ["ytdFunctionalCredit", "ytdForeignCredit"]
                .into_iter()
                .any(|role| index_of(role).is_some());
            // 净额口径降级：本年累计借贷发生额一列都没有（借款利息的 TB 常见形态
            // ——只给期初/期末净额＋方向列）时，勾稽等式无从谈起，但符号口径
            // 只影响**贷方发生额**怎么并进净额——没有发生额列，两种口径算出的
            // 余额一致，可直接下「借贷符号一样」的无争议结论，不必判「无法判定」。
            // 与 [`fallback_by_credit_column`] 的 (0, 0) 分支同一口径；借款侧收口
            // 前自拼原料投票落到的也是它。
            if !has_any_debit && !has_any_credit && (has_opening || has_closing) {
                let mut evidence = SignEvidence::blank("tb");
                evidence.convention = Some(SignConvention::Unsigned);
                evidence.note = Some(
                    "余额表没有本年累计借贷发生额，符号口径只影响贷方发生额的合并，按「借贷符号一样」处理。"
                        .into(),
                );
                return evidence;
            }
            let mut evidence = SignEvidence::blank("tb");
            evidence.convention = None;
            evidence.note = Some("余额或发生额未映射齐全，无法用勾稽等式判定符号口径。".into());
            return evidence;
        };
        let (debit, credit) = (numbers(debit), numbers(credit));
        let balances: Vec<BalanceRow> = (0..rows.len())
            .map(|i| BalanceRow {
                opening: opening[i],
                debit: debit[i],
                credit: credit[i],
                closing: closing[i],
            })
            .collect();
        return tb_sign_evidence(&balances);
    }

    // 序时账：先按凭证分组，整张凭证借贷配平才是铁证。
    let vouchers = group_vouchers_by_roles(headers, rows, column_of);
    let debit = index_of("functionalDebit");
    let credit = index_of("functionalCredit");
    let amount = index_of("functionalAmount");
    let direction = index_of("direction");

    if let (Some(dr), Some(cr)) = (debit, credit) {
        return je_sign_evidence_debit_credit(&numbers(dr), &numbers(cr), &vouchers);
    }
    if let (Some(amount), Some(direction)) = (amount, direction) {
        // 方向为空的行既不算借也不算贷，不能拿它去凑配平。
        let raw: Vec<&str> = rows
            .iter()
            .map(|row| row.get(direction).map(String::as_str).unwrap_or("").trim())
            .collect();
        let is_credit: Vec<bool> = raw.iter().map(|v| is_credit_direction(v)).collect();
        let has_direction: Vec<bool> = raw.iter().map(|v| !v.is_empty()).collect();
        return je_sign_evidence_amount_direction(
            &numbers(amount),
            &is_credit,
            &has_direction,
            &vouchers,
        );
    }
    if amount.is_some() {
        // 只有一列净额时借正贷负是它成立的前提，没有可投票的证据。
        return je_sign_evidence_single(vouchers.len());
    }
    let mut evidence = je_sign_evidence_single(0);
    evidence.scheme = "none";
    evidence.convention = None;
    evidence.note = Some("金额字段未映射，无法判定符号口径。".into());
    evidence
}

/// 按主体＋日期＋凭证识别字段把行分组成凭证。
///
/// 凭证键的口径必须和取数端一致，否则配平投票会因为分组不同而失真。
fn group_vouchers_by_roles(
    headers: &[String],
    rows: &[Vec<String>],
    column_of: &dyn Fn(&str) -> Vec<String>,
) -> Vec<Vec<usize>> {
    let mut indexes: Vec<usize> = Vec::new();
    for role in ["entity", "date", "id"] {
        for name in column_of(role) {
            if let Some(index) = header_index(headers, &name) {
                // 已保存或人工映射也可能把「单位」指给主体。即使上游没有重新
                // 自动识别，方向引擎也不能让它参与凭证分组。
                if role == "entity" && column_is_measurement_unit(headers, rows, index) {
                    continue;
                }
                if !indexes.contains(&index) {
                    indexes.push(index);
                }
            }
        }
    }
    if indexes.is_empty() {
        // 没有凭证键就没法分组——每行自成一"张凭证"，配平投票拿不到证据，
        // 后续会退到列级兜底，不会硬猜。
        return (0..rows.len()).map(|i| vec![i]).collect();
    }
    let mut groups: BTreeMap<String, Vec<usize>> = BTreeMap::new();
    for (position, row) in rows.iter().enumerate() {
        let key = indexes
            .iter()
            .map(|i| row.get(*i).map(String::as_str).unwrap_or("").trim())
            .collect::<Vec<_>>()
            .join("\u{1f}");
        groups.entry(key).or_default().push(position);
    }
    groups.into_values().collect()
}

/// 判定是否可信：两种口径都大面积不成立时，说明表本身勾稽不上，
/// 应报错让用户查，而不是硬选一个假设。
pub(crate) const SIGN_CONFIDENCE_FLOOR: f64 = 0.95;

pub(crate) fn sign_is_trustworthy(e: &SignEvidence) -> bool {
    let decided = e.signed_votes + e.unsigned_votes;
    if decided == 0 {
        // 没有投票证据，走的是列级兜底或固有结论，不由本函数否决。
        return true;
    }
    let winner = e.signed_votes.max(e.unsigned_votes) as f64;
    winner / (decided + e.unbalanced) as f64 >= SIGN_CONFIDENCE_FLOOR
}

// ── 真实样例回归 ────────────────────────────────────────────────────────
//
// 9 家公司的科目余额表与序时账，覆盖用友／金蝶／SAP／Oracle EBS 四种导出风格，
// 含繁体（南嶺實業香港）、段式科目（艾维特苏州）、双语表头（诺桥美国）。
// 只固化表头结构，不含任何业务数据。
//
// 新收到一种形态就往这里加一条——准确率掉了就说明别名或冲突词要补。

/// (名称, 表头, 期望角色对照)。`""` 表示这一列不该映射到任何角色。
type Fixture = (
    &'static str,
    &'static [&'static str],
    &'static [&'static str],
);

const TB_FIXTURES: &[Fixture] = &[
    (
        "01 北重精工（用友，只标外币）",
        &[
            "科目编码",
            "科目名称",
            "辅助核算",
            "币种",
            "方向",
            "期初余额(原币)",
            "期初余额",
            "借方发生额",
            "贷方发生额",
            "期末余额(原币)",
            "期末余额",
        ],
        &[
            "accountCode",
            "accountName",
            "auxiliary",
            "currency",
            "closingDirection",
            "openingForeignAmount",
            "openingFunctionalAmount",
            "ytdFunctionalDebit",
            "ytdFunctionalCredit",
            "closingForeignAmount",
            "closingFunctionalAmount",
        ],
    ),
    (
        "02 泓源化工（用友，纯本币）",
        &[
            "科目代码",
            "科目名称",
            "方向",
            "期初余额",
            "借方发生额",
            "贷方发生额",
            "期末余额",
        ],
        &[
            "accountCode",
            "accountName",
            "closingDirection",
            "openingFunctionalAmount",
            "ytdFunctionalDebit",
            "ytdFunctionalCredit",
            "closingFunctionalAmount",
        ],
    ),
    (
        "03 陇能建设（方向列在末尾）",
        &[
            "科目编码",
            "科目名称",
            "期初余额",
            "借方发生额",
            "贷方发生额",
            "期末余额",
            "方向",
        ],
        &[
            "accountCode",
            "accountName",
            "openingFunctionalAmount",
            "ytdFunctionalDebit",
            "ytdFunctionalCredit",
            "closingFunctionalAmount",
            "closingDirection",
        ],
    ),
    (
        "04 恒澜重工（SAP，借贷分列＋原币期末）",
        &[
            "公司代码 Company",
            "科目 Account",
            "科目描述 Description",
            "期初余额(借) Opening Dr",
            "期初余额(贷) Opening Cr",
            "借方发生 Debit",
            "贷方发生 Credit",
            "期末余额(借) Closing Dr",
            "期末余额(贷) Closing Cr",
            "币种 Ccy",
            "原币期末余额 Orig Closing",
            "记账汇率 Rate",
        ],
        &[
            "entity",
            "accountCode",
            "accountName",
            "openingFunctionalDebit",
            "openingFunctionalCredit",
            "ytdFunctionalDebit",
            "ytdFunctionalCredit",
            "closingFunctionalDebit",
            "closingFunctionalCredit",
            "currency",
            "closingForeignAmount",
            "",
        ],
    ),
    (
        "06 艾维特苏州（Oracle EBS，两列同名方向）",
        &[
            "科目段组合 Account Combination",
            "科目描述 Description",
            "期初余额 Opening",
            "方向 Dr/Cr",
            "借方发生 Debits",
            "贷方发生 Credits",
            "期末余额 Closing",
            "方向 Dr/Cr",
            "币种 Ccy",
            "原币期末余额 Orig Closing",
            "记账汇率 Rate",
        ],
        &[
            "accountCode",
            "accountName",
            "openingFunctionalAmount",
            "openingDirection",
            "ytdFunctionalDebit",
            "ytdFunctionalCredit",
            "closingFunctionalAmount",
            "closingDirection",
            "currency",
            "closingForeignAmount",
            "",
        ],
    ),
    (
        "07 南嶺實業香港（繁体，原币本位币双列）",
        &[
            "科目編號 Account Code",
            "科目名稱 Account Name",
            "幣種 Ccy",
            "匯率 Rate",
            "期初餘額-原幣 Ob. (Fcy)",
            "期初餘額-本位幣 Ob. (HKD)",
            "借方發生-原幣 Dr (Fcy)",
            "借方發生-本位幣 Dr (HKD)",
            "貸方發生-原幣 Cr (Fcy)",
            "貸方發生-本位幣 Cr (HKD)",
            "期末餘額-原幣 End. (Fcy)",
            "期末餘額-本位幣 End. (HKD)",
            "方向 Dir",
        ],
        &[
            "accountCode",
            "accountName",
            "currency",
            "",
            "openingForeignAmount",
            "openingFunctionalAmount",
            "ytdForeignDebit",
            "ytdFunctionalDebit",
            "ytdForeignCredit",
            "ytdFunctionalCredit",
            "closingForeignAmount",
            "closingFunctionalAmount",
            "closingDirection",
        ],
    ),
    (
        "09 澄宇结算中心（原币本位币全借贷分列）",
        &[
            "科目编码",
            "科目名称",
            "币种",
            "汇率",
            "期初借方-原币",
            "期初借方-本位币",
            "期初贷方-原币",
            "期初贷方-本位币",
            "借方发生-原币",
            "借方发生-本位币",
            "贷方发生-原币",
            "贷方发生-本位币",
            "期末借方-原币",
            "期末借方-本位币",
            "期末贷方-原币",
            "期末贷方-本位币",
            "方向",
        ],
        &[
            "accountCode",
            "accountName",
            "currency",
            "",
            "openingForeignDebit",
            "openingFunctionalDebit",
            "openingForeignCredit",
            "openingFunctionalCredit",
            "ytdForeignDebit",
            "ytdFunctionalDebit",
            "ytdForeignCredit",
            "ytdFunctionalCredit",
            "closingForeignDebit",
            "closingFunctionalDebit",
            "closingForeignCredit",
            "closingFunctionalCredit",
            "closingDirection",
        ],
    ),
    (
        "SAP 科目明细（汇兑损益测试资料，TB-4800）",
        &[
            "科目名称一级",
            "科目名称二级",
            "科目代码",
            "公司代码",
            "货币",
            "文本",
            "期初金额-本位币",
            "借方金额-本位币",
            "贷方金额-本位币",
            "期末金额-本位币",
        ],
        &[
            "accountName",
            "accountName",
            "accountCode",
            "entity",
            "currency",
            "currencyText",
            "openingFunctionalAmount",
            "ytdFunctionalDebit",
            "ytdFunctionalCredit",
            "closingFunctionalAmount",
        ],
    ),
];

const JE_FIXTURES: &[Fixture] = &[
    (
        "01 北重精工（用友，借贷分列＋原币）",
        &[
            "日期",
            "凭证字号",
            "摘要",
            "科目编码",
            "科目名称",
            "借方金额",
            "贷方金额",
            "币种",
            "原币金额",
            "辅助核算",
        ],
        &[
            "date",
            "id",
            "summary",
            "accountCode",
            "accountName",
            "functionalDebit",
            "functionalCredit",
            "currency",
            "foreignAmount",
            "auxiliary",
        ],
    ),
    (
        "02 泓源化工（用友，纯本币）",
        &[
            "日期",
            "凭证字号",
            "摘要",
            "科目代码",
            "科目名称",
            "借方金额",
            "贷方金额",
        ],
        &[
            "date",
            "id",
            "summary",
            "accountCode",
            "accountName",
            "functionalDebit",
            "functionalCredit",
        ],
    ),
    (
        "04 恒澜重工（SAP，双语表头）",
        &[
            "过账日期 Posting Date",
            "凭证号 Document No.",
            "行项目 Item",
            "科目 Account",
            "科目描述 Description",
            "摘要 Narrative",
            "借方(本位币) Debit",
            "贷方(本位币) Credit",
            "币种 Ccy",
            "汇率 Rate",
            "原币金额 Orig Amt",
            "统驭对象/参考 Reference",
        ],
        &[
            "date",
            "id",
            "",
            "accountCode",
            "accountName",
            "summary",
            "functionalDebit",
            "functionalCredit",
            "currency",
            "",
            "foreignAmount",
            "",
        ],
    ),
    (
        "06 艾维特苏州（Oracle，Batch＋JE Name 组合键）",
        &[
            "JE批名 Batch",
            "凭证名 JE Name",
            "行号 Line",
            "日期 GL Date",
            "科目段 Account",
            "科目描述 Description",
            "摘要 Narrative",
            "借方 Debit",
            "贷方 Credit",
            "币种 Ccy",
            "汇率 Rate",
            "原币金额 Orig Amt",
            "参考 Reference",
        ],
        &[
            "id",
            "id",
            "",
            "date",
            "accountCode",
            "accountName",
            "summary",
            "functionalDebit",
            "functionalCredit",
            "currency",
            "",
            "foreignAmount",
            "",
        ],
    ),
    (
        "07 南嶺實業香港（繁体，原币本位币双借贷）",
        &[
            "憑證日期 Date",
            "憑證字 V-Type",
            "憑證號 V-No",
            "摘要 Description",
            "科目編號 Account Code",
            "科目名稱 Account Name",
            "幣種 Ccy",
            "匯率 Rate",
            "原幣借方 Dr (Fcy)",
            "原幣貸方 Cr (Fcy)",
            "本位幣借方 Dr (HKD)",
            "本位幣貸方 Cr (HKD)",
            "往來單位 Counterparty",
        ],
        &[
            "date",
            "id",
            "id",
            "summary",
            "accountCode",
            "accountName",
            "currency",
            "",
            "foreignDebit",
            "foreignCredit",
            "functionalDebit",
            "functionalCredit",
            "auxiliary",
        ],
    ),
    (
        "09 澄宇结算中心（原币本位币双借贷＋辅助核算）",
        &[
            "日期",
            "凭证字号",
            "摘要",
            "科目编码",
            "科目名称",
            "币种",
            "原币借方",
            "原币贷方",
            "汇率",
            "本位币借方",
            "本位币贷方",
            "辅助核算-往来单位",
            "制单人",
        ],
        &[
            "date",
            "id",
            "summary",
            "accountCode",
            "accountName",
            "currency",
            "foreignDebit",
            "foreignCredit",
            "",
            "functionalDebit",
            "functionalCredit",
            "auxiliary",
            "",
        ],
    ),
];

fn check_fixtures(kind: &str, fixtures: &[Fixture]) -> Vec<String> {
    let mut problems = Vec::new();
    for (name, headers, expected) in fixtures {
        assert_eq!(
            headers.len(),
            expected.len(),
            "{name}：表头与期望列数不一致"
        );
        let owned: Vec<String> = headers.iter().map(|x| x.to_string()).collect();
        let got = suggest_roles(kind, &owned);
        for (i, want) in expected.iter().enumerate() {
            let actual = got.get(&i).copied().unwrap_or("");
            if actual != *want {
                problems.push(format!(
                    "{name} 第{}列「{}」：期望 {} 实得 {}",
                    i + 1,
                    headers[i],
                    if want.is_empty() { "不映射" } else { want },
                    if actual.is_empty() {
                        "不映射"
                    } else {
                        actual
                    },
                ));
            }
        }
    }
    problems
}

#[cfg(test)]
mod tests {
    use super::*;

    fn set(items: &[&'static str]) -> HashSet<&'static str> {
        items.iter().copied().collect()
    }

    #[test]
    fn 公共科目匹配仅在编码真实一对多时追加名称() {
        let tb = vec![
            ("A".into(), "943100".into(), "现金".into()),
            ("A".into(), "943100".into(), "银行存款".into()),
        ];
        let je = vec![
            ("A".into(), "0000943100".into(), "现金".into()),
            // 同一科目重复多笔分录，不应额外增加歧义计数。
            ("A".into(), "0000943100".into(), "现金".into()),
            ("A".into(), "0000943100".into(), "银行存款".into()),
        ];
        let policy = AccountMatchPolicy::from_sides(&tb, &je);
        assert_eq!(policy.ambiguous_count(), 1);
        assert_eq!(
            policy.account_key("A", "943100", "现金"),
            policy.account_key("A", "0000943100", "现金")
        );
        assert_ne!(
            policy.account_key("A", "943100", "现金"),
            policy.account_key("A", "0000943100", "银行存款")
        );
    }

    #[test]
    fn 两侧名称写法不同不会把唯一编码误判为歧义() {
        let tb = vec![(
            "4800".into(),
            "1002010017".into(),
            "货币资金-银行存款-建设银行".into(),
        )];
        let je = vec![
            (
                "4800".into(),
                "1002010017".into(),
                "银行存款-建行RMB3250-4800".into(),
            ),
            (
                "4800".into(),
                "1002010017".into(),
                "银行存款-建行RMB3250-4800".into(),
            ),
        ];
        let policy = AccountMatchPolicy::from_sides(&tb, &je);
        assert_eq!(policy.ambiguous_count(), 0);
        assert_eq!(
            policy.account_key("4800", "1002010017", &tb[0].2),
            policy.account_key("4800", "1002010017", &je[0].2)
        );
    }

    #[test]
    fn 合并科目列两级挑选并让弱角色出让() {
        // 03 号样例形态：整表只有一列科目，编码与名称挤在一格。列名带「文本」
        // 两个字，辅助核算会先把它兜底占走——科目本体比辅助核算重要，要抢回来。
        let headers: Vec<String> = ["日期", "项目编码、文本", "金额"]
            .iter()
            .map(|x| x.to_string())
            .collect();
        let rows = vec![
            vec![
                "2024-01-05".into(),
                "1001010000:库存现金-人民币".into(),
                "100".into(),
            ],
            vec![
                "2024-01-06".into(),
                "1002010000:银行存款-工商银行".into(),
                "200".into(),
            ],
            vec![
                "2024-01-07".into(),
                "1002020000:银行存款-建设银行".into(),
                "300".into(),
            ],
            vec![
                "2024-01-08".into(),
                "1122010000:应收账款-甲公司".into(),
                "400".into(),
            ],
        ];
        let claimed = |role: &str| -> Vec<String> {
            match role {
                "date" => vec!["日期".to_string()],
                "auxiliary" => vec!["项目编码、文本".to_string()],
                "functionalAmount" => vec!["金额".to_string()],
                _ => vec![],
            }
        };
        let plan = plan_combined_account_fill("je", &headers, &rows, &claimed);
        assert_eq!(plan.code_column.as_deref(), Some("项目编码、文本"));
        // 同一格里既有编码又有名称，名称也挂在这一列上。
        assert_eq!(plan.name_column.as_deref(), Some("项目编码、文本"));

        // 强角色占着的列一概不抢：科目编码已有主时整体不插手。
        let has_code = |role: &str| -> Vec<String> {
            match role {
                "accountCode" => vec!["总账科目".to_string()],
                "auxiliary" => vec!["项目编码、文本".to_string()],
                _ => vec![],
            }
        };
        let plan = plan_combined_account_fill("je", &headers, &rows, &has_code);
        assert_eq!(plan.code_column, None);

        // 历史遗留的合并键 account 视同编码与名称都已有主。
        let legacy = |role: &str| -> Vec<String> {
            match role {
                "account" => vec!["科目".to_string()],
                _ => vec![],
            }
        };
        let plan = plan_combined_account_fill("je", &headers, &rows, &legacy);
        assert_eq!(plan.code_column, None);
        assert_eq!(plan.name_column, None);
    }

    #[test]
    fn 噪声行填充既不接收也不传播() {
        // 借款利息的序时账踩过：合计行本没有身份，照常向下填充会继承上一行
        // 的科目/凭证变成真分录；反过来它自己写在可填充列里的「合计」也不能
        // 传播给后面的空行。跳过版填充两头都要堵住。
        let headers = vec!["科目".to_string(), "金额".to_string()];
        let mut rows = vec![
            vec!["1001".to_string(), "1".to_string()],
            vec!["2002".to_string(), "2".to_string()], // 噪声行：带值也不许传播
            vec![String::new(), "3".to_string()],
        ];
        let keep = vec![true, false, true];
        let filled =
            forward_fill_columns_skipping(&headers, &mut rows, &["科目".to_string()], &keep);
        assert_eq!(filled, 1);
        // 第 2 行拿到的是第 0 行的 1001，不是噪声行的 2002。
        assert_eq!(rows[2][0], "1001");
    }

    #[test]
    fn 短别名不会吃掉长列名() {
        // “本位币”是 functionalCurrency 的别名，不能吃掉 SAP 那份 TB 的所有金额列。
        for h in ["期初金额-本位币", "借方金额-本位币", "期末金额-本位币"] {
            let fc = role_of("tb", "functionalCurrency").unwrap();
            assert!(alias_score(fc, h).is_none(), "{h} 不该判成本位币列");
        }
        // Account 不能吃掉 Account Desc / Accounting Flexfield。
        let code = role_of("tb", "accountCode").unwrap();
        assert!(alias_score(code, "Account Desc").is_none());
        assert!(alias_score(code, "Accounting Flexfield").is_none());
    }

    #[test]
    fn 冲销凭证号与预算对方科目不得混入多列角色() {
        // 4800 序时账的真实踩坑：「冲销凭证号」包含"凭证号"、「预算二级科目描述」
        // 包含"科目描述"、「对方科目名称」包含"科目名称"，部分匹配规则会把它们
        // 拉进 id／accountName 的多列集合——但冲销号记录的是"这张凭证冲掉了谁"，
        // 预算／对方科目也不是本方科目，混进去会直接破坏 TB↔JE 对账。
        let headers: Vec<String> = [
            "凭证号码",
            "冲销凭证号",
            "被冲销凭证号",
            "会计科目",
            "科目文本",
            "预算二级科目描述",
            "对方科目名称",
            "往来单位名称",
        ]
        .iter()
        .map(|x| x.to_string())
        .collect();
        let m = suggest_roles("je", &headers);
        assert_eq!(m.get(&0), Some(&"id"), "{m:?}");
        assert_eq!(m.get(&3), Some(&"accountCode"), "{m:?}");
        assert_eq!(m.get(&4), Some(&"accountName"), "{m:?}");
        for i in [1usize, 2, 5, 6, 7] {
            let role = m.get(&i);
            assert!(
                role != Some(&"id") && role != Some(&"accountName"),
                "{} 混入了 {:?}（完整映射 {m:?}）",
                headers[i],
                role
            );
        }
    }

    #[test]
    fn 取最长命中而非首个命中() {
        let m = suggest_roles("je", &["借方金额".into(), "贷方金额".into(), "金额".into()]);
        assert_eq!(m.get(&0), Some(&"functionalDebit"));
        assert_eq!(m.get(&1), Some(&"functionalCredit"));
        assert_eq!(m.get(&2), Some(&"functionalAmount"));
    }

    #[test]
    fn sap科目明细完整命中tb1() {
        // 汇兑损益测试资料里那份真实 SAP 导出（TB-4800 Sheet1）。
        let headers: Vec<String> = [
            "科目名称一级",
            "科目名称二级",
            "科目代码",
            "公司代码",
            "货币",
            "文本",
            "期初金额-本位币",
            "借方金额-本位币",
            "贷方金额-本位币",
            "期末金额-本位币",
        ]
        .iter()
        .map(|x| x.to_string())
        .collect();
        let m = suggest_roles("tb", &headers);
        let mapped: HashSet<&str> = m.values().copied().collect();
        assert!(mapped.contains("accountCode"), "{m:?}");
        assert!(mapped.contains("accountName"), "{m:?}");
        assert!(mapped.contains("entity"), "{m:?}");
        assert!(mapped.contains("openingFunctionalAmount"), "{m:?}");
        assert!(mapped.contains("closingFunctionalAmount"), "{m:?}");
    }

    #[test]
    fn 整组匹配缺一不可() {
        // TB2 少了期初方向 → 不完整，且提示要指名。
        let mapped = set(&[
            "closingDirection",
            "openingFunctionalAmount",
            "closingFunctionalAmount",
            "ytdFunctionalDebit",
            "ytdFunctionalCredit",
        ]);
        let ranked = match_forms("tb", &mapped);
        let tb2 = ranked.iter().find(|x| x.form == "TB2").unwrap();
        assert!(!tb2.complete);
        assert_eq!(tb2.missing, vec!["openingDirection"]);
        // TB1 不需要方向列，这批映射对 TB1 是完整的。
        let tb1 = ranked.iter().find(|x| x.form == "TB1").unwrap();
        assert!(tb1.complete, "{tb1:?}");
    }

    #[test]
    fn 可选槽给一半算无效() {
        let mapped = set(&[
            "openingFunctionalAmount",
            "closingFunctionalAmount",
            "ytdFunctionalDebit",
            "ytdFunctionalCredit",
            "ytdForeignDebit", // 只给了借方，没给贷方
        ]);
        let ranked = match_forms("tb", &mapped);
        let tb1 = ranked.iter().find(|x| x.form == "TB1").unwrap();
        assert!(!tb1.complete, "可选组只给一半不能算完整");
        assert_eq!(tb1.partial_optional, vec!["ytdForeignCredit"]);
        let msg = describe_incomplete("tb", tb1);
        assert!(msg.contains("本年累计原币贷方发生额"), "{msg}");
    }

    #[test]
    fn 同时命中多型优先借贷分列() {
        // Oracle 分月 TBD：借贷两列与净额列同时给。
        let mapped = set(&[
            "openingFunctionalAmount",
            "closingFunctionalAmount",
            "openingFunctionalDebit",
            "openingFunctionalCredit",
            "closingFunctionalDebit",
            "closingFunctionalCredit",
            "ytdFunctionalDebit",
            "ytdFunctionalCredit",
        ]);
        match resolve_form("tb", &mapped) {
            FormVerdict::Matched(m) => assert_eq!(m.form, "TB3", "应优先借贷分列"),
            other => panic!("应完整命中，实际 {other:?}"),
        }
    }

    #[test]
    fn je三型判定() {
        let je1 = set(&["direction", "functionalDebit", "functionalCredit"]);
        match resolve_form("je", &je1) {
            FormVerdict::Matched(m) => assert_eq!(m.form, "JE1"),
            other => panic!("{other:?}"),
        }
        let je3 = set(&["functionalAmount"]);
        match resolve_form("je", &je3) {
            FormVerdict::Matched(m) => assert_eq!(m.form, "JE3"),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn 币种归一化() {
        assert_eq!(normalize_currency_code("RMB"), Some("CNY"));
        assert_eq!(normalize_currency_code("人民币"), Some("CNY"));
        assert_eq!(normalize_currency_code("美元"), Some("USD"));
        assert_eq!(normalize_currency_code("港幣"), Some("HKD"));
        assert_eq!(normalize_currency_code("外币"), None);
        assert_eq!(normalize_currency_code("-"), None);
    }

    #[test]
    fn 填满且唯一才是本位币列() {
        // TB-4800：229 行全填 USD（该主体本位币）。
        let vals = vec!["USD"; 229];
        assert_eq!(
            classify_currency_column(vals.iter().copied()),
            CurrencyColumn::Functional { code: "USD" }
        );
    }

    #[test]
    fn 只标外币的列是原币列() {
        // 01 北重精工：81 行里只有 1 行填 USD，其余空白。
        let mut vals = vec![""; 80];
        vals.push("USD");
        match classify_currency_column(vals.iter().copied()) {
            CurrencyColumn::Foreign { codes, has_blank } => {
                assert!(has_blank);
                assert_eq!(codes.iter().copied().collect::<Vec<_>>(), vec!["USD"]);
            }
            other => panic!("应判为原币列，实际 {other:?}"),
        }
    }

    #[test]
    fn 每行都填多币种是原币列() {
        // 07 南嶺實業香港：HKD/RMB/USD 逐行都填。
        let vals = vec!["HKD", "USD", "RMB", "HKD"];
        match classify_currency_column(vals.iter().copied()) {
            CurrencyColumn::Foreign { codes, has_blank } => {
                assert!(!has_blank);
                assert_eq!(codes.len(), 3);
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn 认不出的取值当空且可告警() {
        let vals = vec!["外币", "其他", "-"];
        match classify_currency_column(vals.iter().copied()) {
            CurrencyColumn::Unusable { unknown } => assert_eq!(unknown.len(), 3),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn 本位币被改掉后反判为原币列() {
        // 境外主体全美元账，用户把本位币选成人民币。
        let col = CurrencyColumn::Functional { code: "USD" };
        match reclassify_against_functional(col, "CNY") {
            CurrencyColumn::Foreign { codes, .. } => {
                assert_eq!(codes.iter().copied().collect::<Vec<_>>(), vec!["USD"])
            }
            other => panic!("{other:?}"),
        }
        // 一致时保持本位币列。
        let col = CurrencyColumn::Functional { code: "USD" };
        assert_eq!(
            reclassify_against_functional(col, "usd"),
            CurrencyColumn::Functional { code: "USD" }
        );
    }

    #[test]
    fn tb贷方写绝对值时判为符号一样() {
        let rows = vec![
            BalanceRow {
                opening: 100.0,
                debit: 50.0,
                credit: 30.0,
                closing: 120.0,
            },
            BalanceRow {
                opening: 0.0,
                debit: 10.0,
                credit: 4.0,
                closing: 6.0,
            },
            BalanceRow {
                opening: -20.0,
                debit: 0.0,
                credit: 5.0,
                closing: -25.0,
            },
        ];
        let e = tb_sign_evidence(&rows);
        assert_eq!(e.convention, Some(SignConvention::Unsigned));
        assert_eq!(e.convention.unwrap().credit_sign(), -1.0);
        assert!(sign_is_trustworthy(&e), "{e:?}");
    }

    #[test]
    fn tb贷方已带负号时判为已带符号() {
        let rows = vec![
            BalanceRow {
                opening: 100.0,
                debit: 50.0,
                credit: -30.0,
                closing: 120.0,
            },
            BalanceRow {
                opening: 0.0,
                debit: 10.0,
                credit: -4.0,
                closing: 6.0,
            },
        ];
        let e = tb_sign_evidence(&rows);
        assert_eq!(e.convention, Some(SignConvention::Signed));
        assert_eq!(e.convention.unwrap().credit_sign(), 1.0);
    }

    #[test]
    fn tb贷方全零时退到列级兜底() {
        let rows = vec![BalanceRow {
            opening: 10.0,
            debit: 0.0,
            credit: 0.0,
            closing: 10.0,
        }];
        let e = tb_sign_evidence(&rows);
        assert_eq!(e.signed_votes + e.unsigned_votes, 0, "无票");
        assert!(e.note.is_some(), "应给出兜底说明");
        assert!(sign_is_trustworthy(&e), "无投票证据不等于不可信");
    }

    #[test]
    fn tb净额形态无发生额列时降级判unsigned() {
        // 借款利息的 TB 常见形态：期初/期末净额＋方向列，没有本年累计借贷发生额。
        // 符号口径只影响**贷方发生额**怎么并进净额——没有发生额列时两种口径算出的
        // 余额一致，可直接下「借贷符号一样」的无争议结论，不必判「无法判定」。
        // 借款侧收口前自拼原料投票（缺列记 0）落到的正是这个结论。
        let headers: Vec<String> = ["科目编码", "方向", "期初余额", "期末余额"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        let rows = vec![
            vec![
                "2001".into(),
                "贷".into(),
                "1000000".into(),
                "900000".into(),
            ],
            vec!["1001".into(), "借".into(), "5000".into(), "6000".into()],
        ];
        let column_of = |role: &str| -> Vec<String> {
            match role {
                "accountCode" => vec!["科目编码".into()],
                "openingDirection" | "closingDirection" => vec!["方向".into()],
                "openingFunctionalAmount" => vec!["期初余额".into()],
                "closingFunctionalAmount" => vec!["期末余额".into()],
                _ => vec![],
            }
        };
        let e = detect_tb_sign_convention(&headers, &rows, &column_of);
        assert_eq!(e.convention, Some(SignConvention::Unsigned), "{e:?}");
        assert!(
            e.note.as_deref().unwrap_or("").contains("本年累计"),
            "{e:?}"
        );
        assert!(sign_is_trustworthy(&e), "无争议结论不应被可信度门槛否决");
    }

    #[test]
    fn tb借贷分列余额也能走勾稽等式判定符号() {
        let headers: Vec<String> = [
            "期初借方",
            "期初贷方",
            "本年借方",
            "本年贷方",
            "期末借方",
            "期末贷方",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        let rows = vec![
            vec!["100", "0", "50", "30", "120", "0"],
            vec!["0", "20", "0", "5", "0", "25"],
        ]
        .into_iter()
        .map(|row| row.into_iter().map(str::to_string).collect())
        .collect::<Vec<Vec<String>>>();
        let column_of = |role: &str| -> Vec<String> {
            match role {
                "openingFunctionalDebit" => vec!["期初借方".into()],
                "openingFunctionalCredit" => vec!["期初贷方".into()],
                "ytdFunctionalDebit" => vec!["本年借方".into()],
                "ytdFunctionalCredit" => vec!["本年贷方".into()],
                "closingFunctionalDebit" => vec!["期末借方".into()],
                "closingFunctionalCredit" => vec!["期末贷方".into()],
                _ => vec![],
            }
        };
        let e = detect_tb_sign_convention(&headers, &rows, &column_of);
        assert_eq!(e.convention, Some(SignConvention::Unsigned), "{e:?}");
        assert_eq!(e.unsigned_votes, 2, "{e:?}");
        assert!(sign_is_trustworthy(&e), "完整借贷分列映射不应被误报缺列");
    }

    #[test]
    fn tb发生额只映射一侧时不硬猜() {
        // 只映射了本年累计贷方、没映射借方：不满足「一列发生额都没有」的降级
        // 条件，维持无法判定，由调用方按默认口径处理——半张等式投出来的票不可信。
        let headers: Vec<String> = ["科目编码", "期初余额", "本年贷方", "期末余额"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        let rows = vec![vec![
            "2001".into(),
            "1000".into(),
            "500".into(),
            "1500".into(),
        ]];
        let column_of = |role: &str| -> Vec<String> {
            match role {
                "openingFunctionalAmount" => vec!["期初余额".into()],
                "ytdFunctionalCredit" => vec!["本年贷方".into()],
                "closingFunctionalAmount" => vec!["期末余额".into()],
                _ => vec![],
            }
        };
        let e = detect_tb_sign_convention(&headers, &rows, &column_of);
        assert_eq!(e.convention, None, "{e:?}");
        // 余额净额列也没有时同样维持无法判定：连「净额形态」都谈不上。
        let column_of = |role: &str| -> Vec<String> {
            (role == "ytdFunctionalCredit")
                .then(|| vec!["本年贷方".into()])
                .unwrap_or_default()
        };
        let e = detect_tb_sign_convention(&headers, &rows, &column_of);
        assert_eq!(e.convention, None, "{e:?}");
    }

    #[test]
    fn tb勾稽不上时判定不可信() {
        let rows = vec![
            BalanceRow {
                opening: 100.0,
                debit: 50.0,
                credit: 30.0,
                closing: 999.0,
            },
            BalanceRow {
                opening: 0.0,
                debit: 10.0,
                credit: 4.0,
                closing: 777.0,
            },
            BalanceRow {
                opening: 5.0,
                debit: 1.0,
                credit: 1.0,
                closing: 5.0,
            },
        ];
        let e = tb_sign_evidence(&rows);
        assert!(e.unbalanced >= 2, "{e:?}");
        assert!(!sign_is_trustworthy(&e), "两个假设都不成立时应判为不可信");
    }

    #[test]
    fn je凭证配平投票是铁证() {
        // 两张凭证，借贷各一行，贷方写正数 → 符号一样。
        let debit = vec![100.0, 0.0, 50.0, 0.0];
        let credit = vec![0.0, 100.0, 0.0, 50.0];
        let vouchers = vec![vec![0, 1], vec![2, 3]];
        let e = je_sign_evidence_debit_credit(&debit, &credit, &vouchers);
        assert_eq!(e.convention, Some(SignConvention::Unsigned));
        assert_eq!(e.unsigned_votes, 2);
        assert_eq!(e.one_sided, 0);

        // 贷方带负号 → 已带符号。
        let credit = vec![0.0, -100.0, 0.0, -50.0];
        let e = je_sign_evidence_debit_credit(&debit, &credit, &vouchers);
        assert_eq!(e.convention, Some(SignConvention::Signed));
        assert_eq!(e.signed_votes, 2);
    }

    #[test]
    fn je账被筛过时靠列级兜底() {
        // 只剩借方行，没有借贷齐全的凭证——one_sided 是关键信号。
        let debit = vec![100.0, 50.0];
        let credit = vec![0.0, 0.0];
        let vouchers = vec![vec![0], vec![1]];
        let e = je_sign_evidence_debit_credit(&debit, &credit, &vouchers);
        assert_eq!(e.one_sided, 2);
        assert_eq!(e.convention, Some(SignConvention::Unsigned));
        assert!(e.note.as_deref().unwrap().contains("没有贷方数值"), "{e:?}");
    }

    #[test]
    fn je方向列方案配平投票() {
        // 金额全正、方向列区分借贷 → 符号一样。
        let amount = vec![100.0, 100.0];
        let is_credit = vec![false, true];
        let has_dir = vec![true, true];
        let vouchers = vec![vec![0, 1]];
        let e = je_sign_evidence_amount_direction(&amount, &is_credit, &has_dir, &vouchers);
        assert_eq!(e.convention, Some(SignConvention::Unsigned));

        // 贷方行金额为负、整张凭证净额为零 → 已带符号。
        let amount = vec![100.0, -100.0];
        let e = je_sign_evidence_amount_direction(&amount, &is_credit, &has_dir, &vouchers);
        assert_eq!(e.convention, Some(SignConvention::Signed));
    }

    #[test]
    fn 方向列取值判定() {
        for v in ["贷", "貸", "Credit", "CR", "c", "H", "-"] {
            assert!(is_credit_direction(v), "{v} 应判为贷方");
        }
        for v in ["借", "Debit", "DR", "d", "S", ""] {
            assert!(!is_credit_direction(v), "{v} 不该判为贷方");
        }
    }

    #[test]
    fn 已带符号金额仍由原始方向定侧且红字留在本侧() {
        let amount = |value: f64, direction: &str| AmountInputs {
            amount: Some(value),
            direction: Some(direction.to_owned()),
            ..Default::default()
        };

        assert_eq!(
            side_amounts(&amount(178_835_062.87, "S"), SignConvention::Signed),
            (178_835_062.87, 0.0)
        );
        assert_eq!(
            side_amounts(&amount(-10_102_703.78, "S"), SignConvention::Signed),
            (-10_102_703.78, 0.0)
        );
        assert_eq!(
            side_amounts(&amount(-184_664_743.69, "H"), SignConvention::Signed),
            (0.0, 184_664_743.69)
        );
        assert_eq!(
            side_amounts(&amount(32_890.46, "H"), SignConvention::Signed),
            (0.0, -32_890.46)
        );
    }

    #[test]
    fn 候选打分按分数排序() {
        let headers: Vec<String> = ["借方金额", "本位币借方", "贷方金额"]
            .iter()
            .map(|x| x.to_string())
            .collect();
        let c = score_columns("je", &headers);
        let debit = c.get("functionalDebit").expect("应有借方候选");
        // 「本位币借方」是完整别名，分数应高于靠包含命中的「借方金额」。
        assert_eq!(debit[0].header, "本位币借方");
        assert!(debit[0].score > debit[1].score);
        // 贷方不会混进借方候选。
        assert!(debit.iter().all(|x| x.header != "贷方金额"));
    }

    #[test]
    fn 工具只声明自己要的角色() {
        // 汇兑损益的序时账必须有币种，看账不需要。
        assert!(Tool::FxAudit.required("je").contains(&"currency"));
        assert!(!Tool::Ledger.required("je").contains(&"currency"));
        // 只有汇兑损益启用原币口径。
        assert!(Tool::FxAudit.uses_foreign());
        for t in [
            Tool::DepositInterest,
            Tool::LoanInterest,
            Tool::Ledger,
            Tool::FaTbje,
        ] {
            assert!(!t.uses_foreign());
        }
        // 固定资产底稿的序时账与汇兑损益一样要凭证号和日期，但不要币种。
        assert!(Tool::FaTbje.required("je").contains(&"id"));
        assert!(Tool::FaTbje.required("je").contains(&"date"));
        assert!(!Tool::FaTbje.required("je").contains(&"currency"));
    }

    #[test]
    fn 缺必填角色时给中文标签() {
        let mapped: HashSet<&str> = ["accountCode"].into_iter().collect();
        let missing = missing_required_labels(Tool::FxAudit, "je", &mapped);
        assert!(missing.contains(&"记账日期"), "{missing:?}");
        assert!(missing.contains(&"原币币种"), "{missing:?}");
        assert!(!missing.contains(&"科目编码"));
        // 金标身份槽也在并集里：科目名称、摘要、凭证识别字段都要补。
        assert!(missing.contains(&"科目名称"), "{missing:?}");
        assert!(missing.contains(&"摘要"), "{missing:?}");
    }

    #[test]
    fn 三个游离角色已收编进标准表() {
        // 此前：辅助核算靠汇兑损益一行特判、借款明细靠借款利息按关键词临时找、
        // 会计期间只存在于存款利息。金标的类型表把它们列为账表的正式组成部分。
        for kind in ["je", "tb"] {
            assert!(role_of(kind, "auxiliary").is_some(), "{kind} 缺辅助核算");
            assert!(role_of(kind, "loanId").is_some(), "{kind} 缺借款明细");
        }
        // 会计期间只对余额表有意义：序时账一律走 date 列。
        assert!(role_of("tb", "period").is_some());
        assert!(role_of("je", "period").is_none());
        // SAP 常把供应商、客户分成两列，辅助核算必须可多列。
        assert!(role_of("je", "auxiliary").expect("角色存在").multi);
        assert!(!role_of("tb", "loanId").expect("角色存在").multi);
    }

    #[test]
    fn 凭证字和凭证号共同组成公共多列凭证键() {
        let headers = vec![
            "凭证字".to_string(),
            "凭证号".to_string(),
            "摘要".to_string(),
        ];
        let got = suggest_roles("je", &headers);
        assert_eq!(got.get(&0), Some(&"id"), "{got:?}");
        assert_eq!(got.get(&1), Some(&"id"), "{got:?}");
        assert_eq!(got.get(&2), Some(&"summary"), "{got:?}");

        let id = role_of("je", "id").expect("凭证识别角色存在");
        assert!(id.multi, "凭证识别字段必须允许多列共同组成凭证键");
    }

    #[test]
    fn 辅助核算不抢科目与金额列() {
        // 存款利息那份别名把「科目文本／账户文本」也算辅助核算，并进标准表会
        // 抢走科目名称。标准表只收汇兑损益那份保守别名，冲突词挡住科目类与金额类。
        let headers: Vec<String> = ["科目编码", "科目文本", "辅助核算", "往来单位", "借方金额"]
            .iter()
            .map(|x| x.to_string())
            .collect();
        let got = suggest_roles("je", &headers);
        assert_eq!(got.get(&0), Some(&"accountCode"));
        assert_eq!(got.get(&1), Some(&"accountName"));
        assert_eq!(got.get(&2), Some(&"auxiliary"));
        assert_eq!(got.get(&3), Some(&"auxiliary"));
        assert_eq!(got.get(&4), Some(&"functionalDebit"));
    }

    #[test]
    fn 借款明细只认特异写法不与辅助核算打架() {
        // `辅助`、`明细`、`客户` 这类泛词留给辅助核算，否则同一列谁抢到全看分数。
        let headers: Vec<String> = ["科目编码", "辅助核算", "借款合同号"]
            .iter()
            .map(|x| x.to_string())
            .collect();
        let got = suggest_roles("tb", &headers);
        assert_eq!(got.get(&1), Some(&"auxiliary"));
        assert_eq!(got.get(&2), Some(&"loanId"));
    }

    #[test]
    fn 必填是金标身份槽与工具声明的并集() {
        // 看账只声明了凭证识别字段与科目编码，金标另要求日期、科目名称、摘要。
        let mapped: HashSet<&str> = ["id", "accountCode", "functionalAmount"]
            .into_iter()
            .collect();
        let missing = missing_required(Tool::Ledger, "je", &mapped);
        let roles: Vec<&str> = missing.iter().map(|m| m.role).collect();
        assert!(roles.contains(&"date"), "{roles:?}");
        assert!(roles.contains(&"accountName"), "{roles:?}");
        assert!(roles.contains(&"summary"), "{roles:?}");
        // 已映射的不报，金额形态 JE3 已成立也不报。
        assert!(!roles.contains(&"id"));
        assert!(!roles.contains(&"accountCode"));
        assert!(!roles.contains(&"functionalAmount"));
        // 每条都要说得清是谁在要求。
        assert!(missing.iter().all(|m| !m.label.is_empty()));
        assert!(
            missing
                .iter()
                .find(|m| m.role == "summary")
                .expect("有摘要")
                .from_gold
        );
    }

    #[test]
    fn 缺失项能分辨金标要求还是工具要求() {
        // 交易币种只有汇兑损益要，不是金标身份槽——被拦下时用户该知道换个工具就不需要。
        let mapped: HashSet<&str> = [
            "date",
            "id",
            "accountCode",
            "accountName",
            "summary",
            "functionalAmount",
        ]
        .into_iter()
        .collect();
        let missing = missing_required(Tool::FxAudit, "je", &mapped);
        let currency = missing
            .iter()
            .find(|m| m.role == "currency")
            .expect("缺交易币种");
        assert!(!currency.from_gold, "交易币种是工具要求，不是金标");
        // 看账不要币种，同样的映射对它就是齐的。
        assert!(missing_required(Tool::Ledger, "je", &mapped).is_empty());
    }

    #[test]
    fn tb缺本年累计发生额会被拦下() {
        // 全案风险最高的一条收紧：存款与借款今天只要期初期末就能跑，
        // 金标把本年本位币累计借贷列为 TB 必填槽，只给期初期末的余额表会被拦。
        let mapped: HashSet<&str> = [
            "accountCode",
            "accountName",
            "openingFunctionalAmount",
            "closingFunctionalAmount",
        ]
        .into_iter()
        .collect();
        for tool in [Tool::DepositInterest, Tool::LoanInterest] {
            let roles: Vec<&str> = missing_required(tool, "tb", &mapped)
                .iter()
                .map(|m| m.role)
                .collect();
            assert!(roles.contains(&"ytdFunctionalDebit"), "{tool:?} {roles:?}");
            assert!(roles.contains(&"ytdFunctionalCredit"), "{tool:?} {roles:?}");
        }
        // 补齐发生额就放行。
        let mut full = mapped.clone();
        full.insert("ytdFunctionalDebit");
        full.insert("ytdFunctionalCredit");
        assert!(missing_required(Tool::DepositInterest, "tb", &full).is_empty());
    }

    #[test]
    fn 本期发生额未经勾稽提升不能让形态放行() {
        let mut mapped: HashSet<&str> = [
            "accountCode",
            "accountName",
            "openingFunctionalDebit",
            "openingFunctionalCredit",
            "closingFunctionalDebit",
            "closingFunctionalCredit",
        ]
        .into_iter()
        .collect();
        // 两种发生额都没有：拦。
        assert!(!missing_required(Tool::DepositInterest, "tb", &mapped).is_empty());
        // 只给本期：仍然拦截；导入层勾稽通过后会把它提升为 YTD 角色。
        mapped.insert("periodFunctionalDebit");
        mapped.insert("periodFunctionalCredit");
        assert!(!missing_required(Tool::DepositInterest, "tb", &mapped).is_empty());
        // 只给半边本期发生额不算数。
        let mut half = mapped.clone();
        half.remove("periodFunctionalCredit");
        assert!(!missing_required(Tool::DepositInterest, "tb", &half).is_empty());
    }

    #[test]
    fn 真实样例tb识别() {
        let problems = check_fixtures("tb", TB_FIXTURES);
        assert!(problems.is_empty(), "\n{}", problems.join("\n"));
    }

    #[test]
    fn 真实样例je识别() {
        let problems = check_fixtures("je", JE_FIXTURES);
        assert!(problems.is_empty(), "\n{}", problems.join("\n"));
    }

    #[test]
    fn 真实样例都能匹配到形态() {
        for (name, headers, _) in TB_FIXTURES.iter().chain(JE_FIXTURES.iter()) {
            let kind = if name.contains("序时") || JE_FIXTURES.iter().any(|f| f.0 == *name) {
                "je"
            } else {
                "tb"
            };
            let owned: Vec<String> = headers.iter().map(|x| x.to_string()).collect();
            let mapped: HashSet<&str> = suggest_roles(kind, &owned).values().copied().collect();
            match resolve_form(kind, &mapped) {
                FormVerdict::Matched(_) => {}
                FormVerdict::Incomplete(m) => {
                    panic!("{name} 未匹配到形态：{}", describe_incomplete(kind, &m))
                }
            }
        }
    }

    #[test]
    fn 借贷分列折算成有符号净额() {
        let v = AmountInputs {
            debit: Some(100.0),
            credit: Some(30.0),
            ..Default::default()
        };
        assert_eq!(signed_amount(&v, SignConvention::Unsigned), 70.0);
        // 已带符号时贷方本身是负数。
        let v = AmountInputs {
            debit: Some(0.0),
            credit: Some(-30.0),
            ..Default::default()
        };
        assert_eq!(signed_amount(&v, SignConvention::Signed), -30.0);
    }

    #[test]
    fn 红字冲销的贷方行乘负一而不是取负绝对值() {
        // 贷方记 −50，表示冲掉之前那笔贷方 50。两笔相加必须归零，
        // 否则冲销凭证在净额上永远平不掉——看账当年踩过这个坑。
        let reversal = AmountInputs {
            amount: Some(-50.0),
            direction: Some("贷".into()),
            ..Default::default()
        };
        let original = AmountInputs {
            amount: Some(50.0),
            direction: Some("贷".into()),
            ..Default::default()
        };
        let a = signed_amount(&original, SignConvention::Unsigned);
        let b = signed_amount(&reversal, SignConvention::Unsigned);
        assert_eq!(a, -50.0);
        assert_eq!(b, 50.0, "红字冲销的贷方行应翻正，取负绝对值会得到 -50");
        assert_eq!(a + b, 0.0, "冲销凭证必须净额归零");
        // 借方行照常取原值，红字借方同理保号。
        let debit = AmountInputs {
            amount: Some(-30.0),
            direction: Some("借".into()),
            ..Default::default()
        };
        assert_eq!(signed_amount(&debit, SignConvention::Unsigned), -30.0);
        // 已带符号的账不看方向列，直接取原值。
        assert_eq!(signed_amount(&reversal, SignConvention::Signed), -50.0);
    }

    #[test]
    fn 按侧取数不把红字翻到对面() {
        // 08 号样例实测场景：借贷分列的序时账里，红字冲销的贷方行记 −467.02。
        // 折净额得 +467.02，按符号归侧会进借方——与余额表列合计对数时
        // 借贷两侧同时虚增。按侧取数必须把它留在贷方冲减。
        let reversal = AmountInputs {
            credit: Some(-467.02),
            ..Default::default()
        };
        assert_eq!(
            side_amounts(&reversal, SignConvention::Unsigned),
            (0.0, -467.02),
            "红字贷方留在贷方侧冲减，不得翻进借方"
        );
        // 正常分列各行归各侧。
        let normal = AmountInputs {
            debit: Some(500.0),
            credit: Some(0.0),
            ..Default::default()
        };
        assert_eq!(
            side_amounts(&normal, SignConvention::Unsigned),
            (500.0, 0.0)
        );
        // 已带符号的分列：贷方列记负数，翻回贷方正数；红字（正数）翻成冲减。
        let signed_credit = AmountInputs {
            credit: Some(-50.0),
            ..Default::default()
        };
        assert_eq!(
            side_amounts(&signed_credit, SignConvention::Signed),
            (0.0, 50.0)
        );
        let signed_reversal = AmountInputs {
            credit: Some(50.0),
            ..Default::default()
        };
        assert_eq!(
            side_amounts(&signed_reversal, SignConvention::Signed),
            (0.0, -50.0)
        );
    }

    #[test]
    fn 按侧取数的净额与方向列形态() {
        // 净额＋方向（符号一样）：方向定侧，红字负数留在本侧。
        let credit_row = AmountInputs {
            amount: Some(50.0),
            direction: Some("贷".into()),
            ..Default::default()
        };
        assert_eq!(
            side_amounts(&credit_row, SignConvention::Unsigned),
            (0.0, 50.0)
        );
        let reversal = AmountInputs {
            amount: Some(-50.0),
            direction: Some("贷".into()),
            ..Default::default()
        };
        assert_eq!(
            side_amounts(&reversal, SignConvention::Unsigned),
            (0.0, -50.0)
        );
        // 没有方向列的净额：只剩符号一条线索，按正负归侧。
        let net = AmountInputs {
            amount: Some(-50.0),
            ..Default::default()
        };
        assert_eq!(side_amounts(&net, SignConvention::Unsigned), (0.0, 50.0));
    }

    #[test]
    fn tb只保留同一主体内的末级科目() {
        let headers = vec!["主体".into(), "科目编码".into(), "科目名称".into()];
        let rows = vec![
            vec!["A".into(), "1002".into(), "银行存款".into()],
            vec!["A".into(), "10020001".into(), "基本户".into()],
            vec!["A".into(), "10020002".into(), "一般户".into()],
            vec!["B".into(), "1002".into(), "银行存款".into()],
            // 同一末级编码按币种拆成两行，两行都应保留。
            vec!["A".into(), "10020002".into(), "一般户-USD".into()],
        ];
        let columns = |role: &str| match role {
            "entity" => vec!["主体".into()],
            "accountCode" => vec!["科目编码".into()],
            _ => vec![],
        };
        assert_eq!(
            tb_leaf_mask(&headers, &rows, &columns),
            vec![true, true, true, true, true],
            "没有金额证据时不能只凭编码前缀静默排除父项"
        );
    }

    #[test]
    fn tb末级规则兼容分段编码和无编码映射() {
        let headers = vec!["科目".into()];
        let rows = vec![
            vec!["01-1002".into()],
            vec!["01-1002-0001".into()],
            vec!["02-1002".into()],
        ];
        let legacy = |role: &str| {
            (role == "account")
                .then(|| vec!["科目".into()])
                .unwrap_or_default()
        };
        assert_eq!(
            tb_leaf_mask(&headers, &rows, &legacy),
            vec![true, true, true]
        );
        assert_eq!(tb_leaf_mask(&headers, &rows, &|_| vec![]), vec![true; 3]);
    }

    /// 十套真实样例的余额表映射：编码、名称加四个金额列。
    fn 余额表映射(role: &str) -> Vec<String> {
        match role {
            "accountCode" => vec!["科目编码".into()],
            "accountName" => vec!["科目名称".into()],
            "openingFunctionalAmount" => vec!["期初余额".into()],
            "ytdFunctionalDebit" => vec!["借方发生额".into()],
            "ytdFunctionalCredit" => vec!["贷方发生额".into()],
            "closingFunctionalAmount" => vec!["期末余额".into()],
            _ => vec![],
        }
    }

    fn 余额表表头() -> Vec<String> {
        [
            "科目编码",
            "科目名称",
            "期初余额",
            "借方发生额",
            "贷方发生额",
            "期末余额",
        ]
        .into_iter()
        .map(String::from)
        .collect()
    }

    fn 行(code: &str, name: &str, amounts: [&str; 4]) -> Vec<String> {
        let mut row = vec![code.to_string(), name.to_string()];
        row.extend(amounts.iter().map(|v| (*v).to_string()));
        row
    }

    #[test]
    fn tb汇总行与辅助核算明细行编码相同时靠金额勾稽剔除() {
        // 01 号样例：`1121.01 银行承兑汇票` 既是汇总行，也是它下面每个客户
        // 明细行的编码——前缀法在这里完全失效，只有金额能分辨。
        let rows = vec![
            行("1121.01", "银行承兑汇票", ["100", "300", "50", "350"]),
            行("1121.01", "水晶火碳电子科技", ["60", "200", "30", "230"]),
            行("1121.01", "宁波杭州湾如意", ["40", "100", "20", "120"]),
        ];
        assert_eq!(
            tb_leaf_mask(&余额表表头(), &rows, &余额表映射),
            vec![true, false, false]
        );
    }

    #[test]
    fn tb同编码汇总余额按净额比较且整组只处理一次() {
        // 01 号真实形态的缩小版：汇总行把期初借150/贷50列成借方净额100，
        // 两条辅助明细仍保留借贷毛额；发生额两侧分别都能完整勾稽。
        let headers: Vec<String> = [
            "科目编码",
            "科目名称",
            "期初借方",
            "期初贷方",
            "借方发生额",
            "贷方发生额",
            "期末借方",
            "期末贷方",
        ]
        .into_iter()
        .map(String::from)
        .collect();
        let rows = vec![
            vec!["5001.01", "生产成本", "100", "0", "1000", "800", "300", "0"],
            vec!["5001.01", "部门A", "150", "0", "600", "300", "450", "0"],
            vec!["5001.01", "部门B", "0", "50", "400", "500", "0", "150"],
        ]
        .into_iter()
        .map(|row| row.into_iter().map(String::from).collect())
        .collect::<Vec<Vec<String>>>();
        let columns = |role: &str| match role {
            "accountCode" => vec!["科目编码".into()],
            "accountName" => vec!["科目名称".into()],
            "openingFunctionalDebit" => vec!["期初借方".into()],
            "openingFunctionalCredit" => vec!["期初贷方".into()],
            "ytdFunctionalDebit" => vec!["借方发生额".into()],
            "ytdFunctionalCredit" => vec!["贷方发生额".into()],
            "closingFunctionalDebit" => vec!["期末借方".into()],
            "closingFunctionalCredit" => vec!["期末贷方".into()],
            _ => vec![],
        };
        assert_eq!(
            tb_leaf_mask(&headers, &rows, &columns),
            vec![true, false, false],
            "余额净额一致时保留一套汇总金额，不能把汇总和辅助明细一起累计"
        );
    }

    #[test]
    fn tb同编码单行相等不构成可确认汇总关系() {
        // 01 号 2241.02 的辅助明细中存在金额恰好相同的相邻行。仅凭 A=B
        // 无法判断哪一行是汇总；旧版正反扫描会把正常明细二次误删。
        let rows = vec![
            行("2241.02", "客户A", ["10", "20", "5", "25"]),
            行("2241.02", "客户B", ["10", "20", "5", "25"]),
        ];
        assert_eq!(
            tb_leaf_mask(&余额表表头(), &rows, &余额表映射),
            vec![true, true]
        );
    }

    #[test]
    fn tb已确认同编码混排格式后同表一对一完整勾稽也只计一次() {
        let rows = vec![
            行("1121.01", "应收票据", ["100", "300", "50", "350"]),
            行("1121.01", "客户A", ["60", "200", "30", "230"]),
            行("1121.01", "客户B", ["40", "100", "20", "120"]),
            行("1122.09", "应收账款_未开票", ["0", "20", "0", "20"]),
            行("1122.09", "客户C", ["0", "20", "0", "20"]),
        ];
        assert_eq!(
            tb_leaf_mask(&余额表表头(), &rows, &余额表映射),
            vec![true, false, false, true, false]
        );
    }

    #[test]
    fn tb方向小计夹在科目总计与辅助明细之间仍能完整勾稽() {
        let rows = vec![
            行("2241.06.09", "应付账款", ["-100", "100", "50", "-50"]),
            行("2241.06.09", "小计", ["-100", "0", "-50", "-150"]),
            行("2241.06.09", "未开票", ["0", "100", "100", "100"]),
        ];
        assert_eq!(
            tb_leaf_mask(&余额表表头(), &rows, &余额表映射),
            vec![true, false, false]
        );
    }

    #[test]
    fn tb前缀父项只有四项金额都被子项覆盖时才排除() {
        let tied = vec![
            行("5302", "研发支出", ["100", "300", "50", "350"]),
            行("530201", "费用化支出", ["60", "200", "30", "230"]),
            行("530202", "资本化支出", ["40", "100", "20", "120"]),
        ];
        assert_eq!(
            tb_leaf_mask(&余额表表头(), &tied, &余额表映射),
            vec![false, true, true]
        );

        // 03 号样例：父项有真实余额，下级没有完整覆盖。即便编码层级明确，
        // 也必须保留父项；否则该余额会从 BS/PL 勾稽中凭空消失。
        let not_tied = vec![
            行("5302", "研发支出", ["100", "300", "50", "350"]),
            行("530201", "费用化支出", ["0", "200", "30", "170"]),
            行("530202", "资本化支出", ["0", "100", "20", "80"]),
        ];
        assert_eq!(
            tb_leaf_mask(&余额表表头(), &not_tied, &余额表映射),
            vec![true, true, true]
        );

        // 父项所有金额都为零时，排除它不会丢金额，应只保留有值末级行。
        let zero_parent = vec![
            行("6603", "财务费用", ["0", "0", "0", "0"]),
            行("66030101", "财务费用-利息支出", ["0", "0", "777", "-777"]),
        ];
        assert_eq!(
            tb_leaf_mask(&余额表表头(), &zero_parent, &余额表映射),
            vec![false, true]
        );
    }

    #[test]
    fn tb编码不成前缀时可用级次确认完整勾稽的父子行() {
        // 03 号样例的一级 `5302` 与二级 `5301020000` 不是字面前缀，
        // 但级次和全部语义金额都证明前者是后者的汇总行。
        let headers = vec![
            "级次".into(),
            "科目编码".into(),
            "科目名称".into(),
            "期初余额".into(),
            "本年借方".into(),
            "本年贷方".into(),
            "期末余额".into(),
        ];
        let rows = vec![
            vec!["1", "5302", "中方资本金", "663", "80", "4", "739"],
            vec![
                "2",
                "5301020000",
                "中方资本金-明细",
                "663",
                "80",
                "4",
                "739",
            ],
        ]
        .into_iter()
        .map(|row| row.into_iter().map(String::from).collect::<Vec<_>>())
        .collect::<Vec<_>>();
        let mapping = |role: &str| match role {
            "accountCode" => vec!["科目编码".into()],
            "openingFunctionalAmount" => vec!["期初余额".into()],
            "ytdFunctionalDebit" => vec!["本年借方".into()],
            "ytdFunctionalCredit" => vec!["本年贷方".into()],
            "closingFunctionalAmount" => vec!["期末余额".into()],
            _ => Vec::new(),
        };
        assert_eq!(tb_leaf_mask(&headers, &rows, &mapping), vec![false, true]);
    }

    #[test]
    fn tb核算维度明细行没有编码时保留父科目行() {
        // 06／10 号样例：明细按银行账户、客户拆行，这些行的科目编码是空的。
        // 删掉父行只会剩下一堆对不上序时账的无编码行，所以留父行、删维度行。
        let rows = vec![
            行("1002", "银行存款", ["100", "300", "50", "350"]),
            行("", "建设银行日元户", ["60", "200", "30", "230"]),
            行("", "江苏银行营业部", ["40", "100", "20", "120"]),
        ];
        assert_eq!(
            tb_leaf_mask(&余额表表头(), &rows, &余额表映射),
            vec![true, false, false]
        );
    }

    #[test]
    fn tb小计行写在明细下方且编码为空时被剔除() {
        // 04／05 号样例：每组明细行后面跟一条只有金额的小计行。
        // 与核算维度行方向相反——有编码的是明细，没编码的才是汇总。
        let rows = vec![
            行("1002200769", "银行存款-中行", ["60", "200", "30", "230"]),
            行("1002200770", "银行存款-建行", ["40", "100", "20", "120"]),
            行("", "", ["100", "300", "50", "350"]),
        ];
        assert_eq!(
            tb_leaf_mask(&余额表表头(), &rows, &余额表映射),
            vec![true, true, false]
        );
    }

    #[test]
    fn tb同编码多币种拆行不会被勾稽误删() {
        // 02 号样例：同一个银行账户按 CNY／EUR／USD 拆三行，谁也不等于
        // 另两行之和，三行都要留下。这是勾稽法必须放过的反例。
        let rows = vec![
            行(
                "1002010800",
                "银行存款-工行",
                ["58533.91", "966855.6", "941133.7", "84255.81"],
            ),
            行("1002010800", "银行存款-工行", ["144.5", "0", "0", "144.5"]),
            行("1002010800", "银行存款-工行", ["176.7", "0", "0", "176.7"]),
        ];
        assert_eq!(
            tb_leaf_mask(&余额表表头(), &rows, &余额表映射),
            vec![true; 3]
        );
    }

    #[test]
    fn 同科目不同币种金额恰好相等时不会被勾稽误删() {
        // 02 号样例的真实数据：`1002011802` 的 CNY 行与 USD 行四个金额列
        // **完全相同**（182699025.78/0/0/182699025.78），差别只在方向列
        // 一个记贷一个记借。光比金额会把 CNY 行判成 USD 行的汇总删掉——
        // 这是真实样例上抓到的误删，不是假想。
        let headers: Vec<String> = [
            "科目编码",
            "科目名称",
            "货币",
            "期初余额",
            "借方发生额",
            "贷方发生额",
            "期末余额",
        ]
        .into_iter()
        .map(String::from)
        .collect();
        let rows = vec![
            vec![
                "1002011802".into(),
                "银行存款-农行新洲区支行".into(),
                "CNY".into(),
                "182699025.78".into(),
                "0".into(),
                "0".into(),
                "182699025.78".into(),
            ],
            vec![
                "1002011802".into(),
                "银行存款-农行新洲区支行".into(),
                "USD".into(),
                "182699025.78".into(),
                "0".into(),
                "0".into(),
                "182699025.78".into(),
            ],
        ];
        let columns = |role: &str| match role {
            "accountCode" => vec!["科目编码".into()],
            "accountName" => vec!["科目名称".into()],
            "currency" => vec!["货币".into()],
            "openingFunctionalAmount" => vec!["期初余额".into()],
            "ytdFunctionalDebit" => vec!["借方发生额".into()],
            "ytdFunctionalCredit" => vec!["贷方发生额".into()],
            "closingFunctionalAmount" => vec!["期末余额".into()],
            _ => vec![],
        };
        assert_eq!(tb_leaf_mask(&headers, &rows, &columns), vec![true, true]);

        // 同一样例的另一处：`交易性金融资产-成本` 与 `交易性金融资产-公允价值变动`
        // 是**两个平级科目**，币种同为 CNY，四个金额列一模一样，只有方向一借一贷。
        // 单行相等这个证据太弱，必须要求两行编码相同或确有上下级关系。
        let rows = vec![
            vec![
                "1101010200".into(),
                "交易性金融资产-成本-股票投资".into(),
                "CNY".into(),
                "121616.4".into(),
                "0".into(),
                "0".into(),
                "121616.4".into(),
            ],
            vec![
                "1101020200".into(),
                "交易性金融资产-公允价值变动-股票投资".into(),
                "CNY".into(),
                "121616.4".into(),
                "0".into(),
                "0".into(),
                "121616.4".into(),
            ],
        ];
        assert_eq!(tb_leaf_mask(&headers, &rows, &columns), vec![true, true]);
    }

    #[test]
    fn tb合计标签只认整格不误杀名字里带合计的科目() {
        // 10 号样例里 `试剂耗材合计` 是真实存在的末级科目名；同一张表的
        // 末行才是真合计。用「包含合计二字」去判会把前者一起删掉。
        let rows = vec![
            行("1403.005", "试剂耗材合计", ["10", "20", "5", "25"]),
            行("2202", "应付账款", ["7", "9", "3", "13"]),
            行("", "合计", ["17", "29", "8", "38"]),
        ];
        assert_eq!(
            tb_leaf_mask(&余额表表头(), &rows, &余额表映射),
            vec![true, true, false]
        );
        // 06 号样例的 `xxx-小计`：带连接符的后缀不可能是科目本名。
        assert!(is_rollup_label("交易性金融资产-小计"));
        assert!(!is_rollup_label("试剂耗材合计"));
    }

    /// 某个角色被判到了哪几列。
    fn 落在(kind: &str, headers: &[&str], role: &str) -> Vec<String> {
        let headers: Vec<String> = headers.iter().map(|h| (*h).to_string()).collect();
        suggest_roles(kind, &headers)
            .into_iter()
            .filter(|(_, r)| *r == role)
            .map(|(i, _)| headers[i].clone())
            .collect()
    }

    #[test]
    fn 编码与名称混写在一格时能拆开() {
        // 03 号样例：一级用斜杠，末级用冒号，整张表没有独立编码列。
        assert_eq!(
            split_code_and_name("1001/库存现金"),
            Some(("1001".into(), "库存现金".into()))
        );
        assert_eq!(
            split_code_and_name("1001010000:库存现金-人民币"),
            Some(("1001010000".into(), "库存现金-人民币".into()))
        );
        // 04／05 号用下划线；08 号编码后面跟着多级名称。
        assert_eq!(
            split_code_and_name("1001_现金"),
            Some(("1001".into(), "现金".into()))
        );
        assert_eq!(
            split_code_and_name("10020101\\银行存款\\在财务公司存款\\活期"),
            Some(("10020101".into(), "银行存款\\在财务公司存款\\活期".into()))
        );

        // 反例一：06／10 号的名称列也用下划线，但拼的是**层级名**不是编码。
        assert_eq!(split_code_and_name("交易性金融资产_结构性存款"), None);
        assert_eq!(split_code_and_name("管理费用_研发费用_水电气费"), None);
        // 反例二：名称自己就带短横线和空格，按它们拆会把科目名切碎。
        assert_eq!(
            split_code_and_name("银行存款-人民币-中国银行-新乡分行"),
            None
        );
        assert_eq!(split_code_and_name("应付账款 - 应付暂估款"), None);
        assert_eq!(split_code_and_name("库存现金"), None);
    }

    /// 「编码＋空格＋名称」混写（用友导出、审计底稿常见）。alpha.39 起
    /// 正文行按拆出的编码判合法性，拆不开时整格过不了 `looks_like_account_code`，
    /// 合并列的正文行会被整批当垃圾剔掉——fx 损益取数返回空集即此回归。
    #[test]
    fn 编码加空格加名称的混写在首段是编码时拆开() {
        assert_eq!(
            split_code_and_name("6701090001 财务费用-汇兑收益-未实现"),
            Some((
                "6701090001".into(),
                "财务费用-汇兑收益-未实现".into()
            ))
        );
        assert_eq!(
            split_code_and_name("1002.01 招商银行-基本户"),
            Some(("1002.01".into(), "招商银行-基本户".into()))
        );
        // 首段不是足位数编码时绝不拆：名称自带空格、短数字打头的名称段。
        assert_eq!(split_code_and_name("应付账款 - 应付暂估款"), None);
        assert_eq!(split_code_and_name("3 个月定期存款"), None);
        assert_eq!(split_code_and_name("库存 现金"), None);
        // 纯编码（无名称半段）不构成拆分。
        assert_eq!(split_code_and_name("1002"), None);
    }

    #[test]
    fn 整张表只有一列科目时按数据认出混合列() {
        // 03 号样例的表头 `项目编码、文本/科目编码、文本` 里既有「科目编码」
        // 又有「文本」——冲突词一票否决，按列名永远落不到科目编码上。
        let headers: Vec<String> = ["级次", "项目编码、文本/科目编码、文本", "货币", "期初"]
            .into_iter()
            .map(String::from)
            .collect();
        let rows = vec![
            vec![
                "1".into(),
                "1001/库存现金".into(),
                "CNY".into(),
                "984.3".into(),
            ],
            vec![
                "2".into(),
                "1001010000:库存现金-人民币".into(),
                "CNY".into(),
                "984.3".into(),
            ],
            vec![
                "1".into(),
                "1002/银行存款".into(),
                "CNY".into(),
                "22222745.07".into(),
            ],
            vec![
                "2".into(),
                "1002101001:银行存款-中国银行".into(),
                "CNY".into(),
                "14075.88".into(),
            ],
        ];
        let roles = suggest_roles_with_data("tb", &headers, &rows);
        assert_eq!(
            roles.get(&1).copied(),
            Some("accountCode"),
            "混合列应当顶上空缺的科目编码：{roles:?}"
        );
    }

    #[test]
    fn 十套真实样例的表头都能落到正确的角色() {
        // 04／05 号：一级编码与明细编码分列，明细列就叫裸的「科目」。
        let 分级余额表 = [
            "科目级别",
            "科目级别描述",
            "科目",
            "科目描述",
            "期初余额",
            "方向",
            "借方发生额",
            "贷方发生额",
            "方向",
            "期末余额",
            "货币",
        ];
        assert_eq!(落在("tb", &分级余额表, "accountCode"), ["科目"]);
        assert_eq!(落在("tb", &分级余额表, "accountName"), ["科目描述"]);

        // 02 号：期末列写作「累计余额」，两个方向列按位置分期初／期末。
        let 累计口径余额表 = [
            "公司代码",
            "总账科目",
            "总账科目名称",
            "货币",
            "期初余额",
            "期初余额方向",
            "借方发生额",
            "贷方发生额",
            "累计余额",
            "累计余额方向",
        ];
        assert_eq!(落在("tb", &累计口径余额表, "accountCode"), ["总账科目"]);
        assert_eq!(落在("tb", &累计口径余额表, "accountName"), ["总账科目名称"]);
        assert_eq!(
            落在("tb", &累计口径余额表, "closingFunctionalAmount"),
            ["累计余额"]
        );

        // 08／09 号：本期与本年累计两套发生额并存，本年那套词序是「借方累计」。
        let 两套发生额余额表 = [
            "科目编码",
            "科目名称",
            "方向",
            "期初余额",
            "本期借方",
            "本期贷方",
            "借方累计",
            "贷方累计",
            "方向",
            "期末余额",
        ];
        assert_eq!(
            落在("tb", &两套发生额余额表, "ytdFunctionalDebit"),
            ["借方累计"]
        );
        assert_eq!(
            落在("tb", &两套发生额余额表, "ytdFunctionalCredit"),
            ["贷方累计"]
        );

        // 03 号序时账：`抵销科目` 是对方科目，取值同样是十位编码，
        // 绝不能顶掉本方的 `总账科目`。
        let sap序时账 = [
            "凭证编号",
            "凭证类型",
            "凭证日期",
            "文本",
            "抵销科目",
            "本币金额",
            "总账科目",
            "过账日期",
            "会计科目",
        ];
        assert_eq!(落在("je", &sap序时账, "accountCode"), ["总账科目"]);

        // 04 号序时账：SAP 的方向列叫「借贷标志」（S／H）。
        let sap借贷标志 = ["凭证编号", "借贷标志", "本位币金额", "总帐科目", "科目名称"];
        assert_eq!(落在("je", &sap借贷标志, "direction"), ["借贷标志"]);
        assert_eq!(落在("je", &sap借贷标志, "accountCode"), ["总帐科目"]);

        // 07 号序时账：日期与凭证号已经拼成一列「唯一码」。
        let 拼好凭证键 = ["唯一码", "日期", "凭证号数", "科目编码", "科目名称", "摘要"];
        assert!(落在("je", &拼好凭证键, "id").contains(&"唯一码".to_string()));
    }

    #[test]
    fn 余额列自带符号时方向列不再翻号() {
        let headers: Vec<String> = ["科目编码", "期末余额", "方向"]
            .into_iter()
            .map(String::from)
            .collect();
        let columns = |role: &str| match role {
            "accountCode" => vec!["科目编码".into()],
            "closingFunctionalAmount" => vec!["期末余额".into()],
            "closingDirection" => vec!["方向".into()],
            _ => vec![],
        };
        let row = |code: &str, amount: &str, direction: &str| {
            vec![code.into(), amount.into(), direction.into()]
        };

        // 04／05 号样例：余额列自带负号，方向列只是冗余标注。
        let 自带符号 = vec![
            row("1001", "200", "借"),
            row("2201", "-27247745.98", "贷"),
            row("2202", "-74061523.67", "贷"),
        ];
        assert!(balance_self_signed(
            &headers,
            &自带符号,
            &columns,
            "closingFunctional"
        ));

        // 02／08 号样例：标准的「绝对值＋方向」。第三行是异常余额
        // （方向记贷、数值为负），按行判会把它当成「整列自带符号」的证据，
        // 按列判则仍是少数，不影响结论。
        let 绝对值 = vec![
            row("1001", "300", "借"),
            row("2201", "100", "贷"),
            row("2202", "200", "贷"),
            row("2203", "-50", "贷"),
        ];
        assert!(!balance_self_signed(
            &headers,
            &绝对值,
            &columns,
            "closingFunctional"
        ));

        // 折算结果：自带符号时取原样，否则按方向翻号。
        let 贷方 = |amount: f64| AmountInputs {
            amount: Some(amount),
            direction: Some("贷".into()),
            ..Default::default()
        };
        assert_eq!(
            signed_balance(&贷方(-27247745.98), SignConvention::Unsigned, true),
            -27247745.98
        );
        assert_eq!(
            signed_balance(&贷方(100.0), SignConvention::Unsigned, false),
            -100.0
        );
        // 借贷分列没有方向列可言，`self_signed` 不该改变它的折算。
        let 分列 = AmountInputs {
            debit: Some(0.0),
            credit: Some(100.0),
            ..Default::default()
        };
        assert_eq!(
            signed_balance(&分列, SignConvention::Unsigned, true),
            -100.0
        );
        assert!(!balance_self_signed(
            &["科目编码".into(), "期末借方".into(), "期末贷方".into()],
            &[vec!["1001".into(), "0".into(), "100".into()]],
            &|role: &str| match role {
                "closingFunctionalDebit" => vec!["期末借方".into()],
                "closingFunctionalCredit" => vec!["期末贷方".into()],
                _ => vec![],
            },
            "closingFunctional"
        ));
    }

    #[test]
    fn 埋在表体中间的游离金额行被剔除() {
        // 02 号样例序时账里三行只有金额、其余全空的合计行，两行在二十多万行
        // 的表体中间；03 号样例的 SAP 分组小计把标签写在一个没映射的列里，
        // 名称列是 VLOOKUP 残值 `#N/A`。两种都不带「合计」字样。
        let headers: Vec<String> = ["凭证号", "日期", "科目编码", "科目名称", "本位币金额"]
            .into_iter()
            .map(String::from)
            .collect();
        let rows = vec![
            vec![
                "0100000000".into(),
                "2025-01-01".into(),
                "1001010000".into(),
                "库存现金".into(),
                "649.7".into(),
            ],
            vec![
                "".into(),
                "".into(),
                "".into(),
                "#N/A".into(),
                "649.7".into(),
            ],
            vec![
                "0100000001".into(),
                "2025-01-02".into(),
                "1002101001".into(),
                "银行存款".into(),
                "800".into(),
            ],
        ];
        let columns = |role: &str| match role {
            "id" => vec!["凭证号".into()],
            "date" => vec!["日期".into()],
            "accountCode" => vec!["科目编码".into()],
            "accountName" => vec!["科目名称".into()],
            "functionalAmount" => vec!["本位币金额".into()],
            _ => vec![],
        };
        assert_eq!(
            ledger_junk_mask(&headers, &rows, &columns),
            vec![true, false, true]
        );
    }

    #[test]
    fn 合计行之后的手工草稿区被截掉() {
        // 10 号样例：合计行后面还跟着十五行审计人手工草稿，摘要列写着
        // 「账面补提」，最后一行是 `#REF!`。只从表尾往前扫——06 号样例的
        // `-小计` 就在表体中间，从那里截断会把后面的账全丢掉。
        let headers: Vec<String> = ["日期", "凭证号", "摘要", "科目编码", "借方金额"]
            .into_iter()
            .map(String::from)
            .collect();
        let rows = vec![
            vec![
                "2024/1/31".into(),
                "1".into(),
                "报销".into(),
                "6602.14".into(),
                "135".into(),
            ],
            vec![
                "合计".into(),
                "".into(),
                "".into(),
                "".into(),
                "314078129.78".into(),
            ],
            vec![
                "".into(),
                "".into(),
                "账面补提".into(),
                "".into(),
                "2556.54".into(),
            ],
            vec!["".into(), "".into(), "".into(), "".into(), "#REF!".into()],
        ];
        let columns = |role: &str| match role {
            "date" => vec!["日期".into()],
            "id" => vec!["凭证号".into()],
            "summary" => vec!["摘要".into()],
            "accountCode" => vec!["科目编码".into()],
            "functionalDebit" => vec!["借方金额".into()],
            _ => vec![],
        };
        // 「合计」写在日期列里，本身算有身份，靠它挡不住后面的草稿区；
        // 表尾倒扫要一直退到第一行那条真分录才停。
        assert_eq!(
            ledger_junk_mask(&headers, &rows, &columns),
            vec![true, false, false, false]
        );
    }

    #[test]
    fn 整行空白后的草稿不能伪装成新正文() {
        let headers: Vec<String> = ["科目编码", "科目名称", "借方金额", "贷方金额", "备注"]
            .into_iter()
            .map(String::from)
            .collect();
        let rows = vec![
            vec![
                "1001".into(),
                "库存现金".into(),
                "100".into(),
                "0".into(),
                "".into(),
            ],
            // 正文中缺名称的真实分录要保留，并交给调用方报必要字段错误。
            vec![
                "1002".into(),
                "".into(),
                "0".into(),
                "100".into(),
                "".into(),
            ],
            // 只有整行全空才构成边界。
            vec!["".into(), "".into(), "".into(), "".into(), "".into()],
            // 10 号样例尾部的错位金额：有一个像编码的值，但没有名称和金额结构。
            vec![
                "2556.54".into(),
                "".into(),
                "".into(),
                "".into(),
                "账面补提".into(),
            ],
            // 分隔后的普通说明也不能重新开启正文。
            vec![
                "".into(),
                "以前年度损益".into(),
                "".into(),
                "".into(),
                "".into(),
            ],
            // 三项齐备才重新进入正文；金额为 0 也属于可解析金额。
            vec![
                "6602".into(),
                "管理费用".into(),
                "0".into(),
                "0".into(),
                "".into(),
            ],
            // 已重新进入正文，后续缺名称行仍不满足业务行三项条件。
            vec![
                "2202".into(),
                "".into(),
                "0".into(),
                "100".into(),
                "".into(),
            ],
        ];
        let columns = |role: &str| match role {
            "accountCode" => vec!["科目编码".into()],
            "accountName" => vec!["科目名称".into()],
            "functionalDebit" => vec!["借方金额".into()],
            "functionalCredit" => vec!["贷方金额".into()],
            _ => vec![],
        };

        let analysis = analyze_ledger_rows(&headers, &rows, &columns);
        assert_eq!(
            analysis.keep,
            vec![true, false, false, false, false, true, false]
        );
    }

    #[test]
    fn 单个必要映射字段空白时该行不属于业务行() {
        let headers: Vec<String> = ["科目编码", "科目名称", "金额", "备注"]
            .into_iter()
            .map(String::from)
            .collect();
        let rows = vec![
            vec!["1001".into(), "库存现金".into(), "10".into(), "".into()],
            // 科目名称为空；即使其他列有值，也不能成为业务行。
            vec!["1002".into(), "".into(), "20".into(), "".into()],
            vec!["1003".into(), "银行存款".into(), "30".into(), "".into()],
        ];
        let columns = |role: &str| match role {
            "accountCode" => vec!["科目编码".into()],
            "accountName" => vec!["科目名称".into()],
            "functionalAmount" => vec!["金额".into()],
            _ => vec![],
        };

        let analysis = analyze_ledger_rows(&headers, &rows, &columns);
        assert_eq!(analysis.keep, vec![true, false, true]);
    }

    #[test]
    fn 非法科目编码行排除且保留源值() {
        let headers: Vec<String> = ["科目编码", "科目名称", "金额"]
            .into_iter()
            .map(String::from)
            .collect();
        let rows = vec![
            vec!["1001", "库存现金", "10"],
            vec!["下·", "固定资产_已使用固定资产", "10"],
            vec!["1002.01-A", "银行存款", "20"],
        ]
        .into_iter()
        .map(|row| row.into_iter().map(String::from).collect())
        .collect::<Vec<Vec<String>>>();
        let columns = |role: &str| match role {
            "accountCode" => vec!["科目编码".into()],
            "accountName" => vec!["科目名称".into()],
            "functionalAmount" => vec!["金额".into()],
            _ => vec![],
        };
        let analysis = analyze_ledger_rows(&headers, &rows, &columns);
        assert_eq!(analysis.keep, vec![true, false, true]);
        assert_eq!(
            analysis.invalid_account_code_rows,
            vec![(1, "下·".to_owned())]
        );
    }

    #[test]
    fn 上级编码必须落在分隔符边界上() {
        // 点号分级的账里 `1002.1` 与 `1002.10` 是同级的两个科目，
        // 裸 `starts_with` 会把前者判成后者的上级。
        assert!(!is_ancestor_code("1002.1", "1002.10"));
        assert!(is_ancestor_code("1002.01", "1002.01.01"));
        // 定长纯数字编码没有分隔符可依，只能按位数续接。
        assert!(is_ancestor_code("1002", "10020001"));
        assert!(is_ancestor_code("01-1002", "01-1002-0001"));
        assert!(!is_ancestor_code("1002", "1002"));
    }

    #[test]
    fn 净额加方向列折算() {
        let v = AmountInputs {
            amount: Some(500.0),
            direction: Some("贷".into()),
            ..Default::default()
        };
        assert_eq!(signed_amount(&v, SignConvention::Unsigned), -500.0);
        let v = AmountInputs {
            amount: Some(500.0),
            direction: Some("借".into()),
            ..Default::default()
        };
        assert_eq!(signed_amount(&v, SignConvention::Unsigned), 500.0);
        // 已带符号时方向列只作校验，不再翻转。
        let v = AmountInputs {
            amount: Some(-500.0),
            direction: Some("贷".into()),
            ..Default::default()
        };
        assert_eq!(signed_amount(&v, SignConvention::Signed), -500.0);
    }

    #[test]
    fn 纯净额直接取原值() {
        let v = AmountInputs {
            amount: Some(-120.0),
            ..Default::default()
        };
        assert_eq!(signed_amount(&v, SignConvention::Signed), -120.0);
        assert_eq!(
            credit_positive(signed_amount(&v, SignConvention::Signed)),
            120.0
        );
    }

    #[test]
    fn 旧角色名能迁移到标准名() {
        assert_eq!(migrate_role_name("je", "voucherId"), "id");
        assert_eq!(migrate_role_name("je", "account"), "accountCode");
        assert_eq!(migrate_role_name("je", "amount"), "functionalAmount");
        assert_eq!(migrate_role_name("je", "foreignDirection"), "direction");
        assert_eq!(
            migrate_role_name("tb", "openingPrincipal"),
            "openingFunctionalAmount"
        );
        assert_eq!(migrate_role_name("tb", "periodDebit"), "ytdFunctionalDebit");
        // 标准名原样返回。
        assert_eq!(migrate_role_name("je", "accountCode"), "accountCode");
        assert_eq!(
            migrate_role_name("tb", "closingForeignAmount"),
            "closingForeignAmount"
        );
        // 认不出的退回空串。
        assert_eq!(migrate_role_name("tb", "不存在的角色"), "");
    }

    #[test]
    fn 集团货币口径的列不给任何金额角色() {
        // 实测 Oct+BS+PL+TB.xlsx：SAP 用 `Grp Curr` 缩写，`groupcurr` 匹配不到。
        for header in [
            "MTD Grp Curr",
            "YTD Act (Grp Curr)",
            "集团货币金额",
            "Group Currency Value",
        ] {
            assert!(
                role_rejects_header("tb", "ytdFunctionalCredit", header),
                "TB 本年累计贷方不该收下 {header}"
            );
            assert!(
                role_rejects_header("je", "functionalAmount", header),
                "JE 本位币净额不该收下 {header}"
            );
        }
        // 本位币与原币口径不受影响。
        assert!(!role_rejects_header(
            "tb",
            "ytdFunctionalCredit",
            "本年累计贷方"
        ));
        assert!(!role_rejects_header("je", "functionalAmount", "本位币金额"));
        // 非金额角色不套这条规则。
        assert!(!role_rejects_header("tb", "entity", "MTD Grp Curr"));
    }

    #[test]
    fn 只给集团货币金额的序时账不把它当本位币() {
        // 这条此前是漏的：判据大小写敏感，JE 的 functionalAmount 匹配不到，
        // 表里没有本位币金额列时，集团货币金额会被当成本位币收下。
        let headers: Vec<String> = ["凭证号", "会计科目", "集团货币金额"]
            .iter()
            .map(|x| x.to_string())
            .collect();
        let got = suggest_roles("je", &headers);
        assert_eq!(got.get(&2), None, "集团货币金额不该落到任何角色：{got:?}");
        // 本位币金额在场时当然要收下。
        let ok: Vec<String> = ["凭证号", "会计科目", "本位币金额", "集团货币金额"]
            .iter()
            .map(|x| x.to_string())
            .collect();
        let got = suggest_roles("je", &ok);
        assert_eq!(got.get(&2), Some(&"functionalAmount"));
        assert_eq!(got.get(&3), None);
    }

    #[test]
    fn 冲突词能挡住llm指错的列() {
        // 看账界面用的旧角色名也要认得（account → accountCode）。
        assert!(role_rejects_header("je", "accountName", "预算二级科目描述"));
        assert!(role_rejects_header("je", "accountName", "对方科目名称"));
        assert!(role_rejects_header("je", "accountCode", "科目文本"));
        assert!(role_rejects_header("je", "account", "科目名称"));
        // 别名库不认识的列不算否定——那正是留给 LLM 补充的空间。
        assert!(!role_rejects_header("je", "accountName", "科目文本"));
        assert!(!role_rejects_header("je", "accountCode", "会计科目"));
        assert!(!role_rejects_header(
            "je",
            "accountName",
            "Cost Center Desc"
        ));
        // 认不出的角色名一律不拦。
        assert!(!role_rejects_header("je", "不存在的角色", "随便一列"));
    }

    #[test]
    fn 两列同名发生额按金额分累计与本期() {
        // 列名都叫「借方发生额」，分不出哪个是本年、哪个是本期。
        let headers: Vec<String> = ["科目编码", "借方发生额", "借方发生额"]
            .iter()
            .map(|x| x.to_string())
            .collect();
        let rows: Vec<Vec<String>> = vec![
            vec!["1001".into(), "100".into(), "1200".into()],
            vec!["1002".into(), "200".into(), "2400".into()],
            vec!["1003".into(), "50".into(), "600".into()],
            vec!["1004".into(), "80".into(), "960".into()],
        ];
        let m = suggest_roles_with_data("tb", &headers, &rows);
        assert_eq!(m.get(&2), Some(&"ytdFunctionalDebit"), "金额大的是本年累计");
        assert_eq!(m.get(&1), Some(&"periodFunctionalDebit"), "金额小的是本期");
    }

    #[test]
    fn 列名写明本期本年时不看金额() {
        // 别名已经分得开，即便本期那列金额更大也不该翻转。
        let headers: Vec<String> = ["科目编码", "本期借方发生额", "本年累计借方发生额"]
            .iter()
            .map(|x| x.to_string())
            .collect();
        let rows: Vec<Vec<String>> = vec![
            vec!["1001".into(), "9999".into(), "100".into()],
            vec!["1002".into(), "8888".into(), "200".into()],
            vec!["1003".into(), "7777".into(), "300".into()],
        ];
        let m = suggest_roles_with_data("tb", &headers, &rows);
        assert_eq!(m.get(&1), Some(&"periodFunctionalDebit"));
        assert_eq!(m.get(&2), Some(&"ytdFunctionalDebit"));
    }

    #[test]
    fn 本年发生额必须配本年期初() {
        let headers: Vec<String> = [
            "科目编码",
            "本年金额-期初",
            "本期金额-本期期初",
            "本年金额-借方发生",
            "本年金额-贷方发生",
            "本期金额-借方发生",
            "本期金额-贷方发生",
        ]
        .into_iter()
        .map(String::from)
        .collect();
        let rows = vec![
            vec!["1001", "10", "20", "100", "80", "30", "10"],
            vec!["1002", "20", "30", "200", "160", "60", "20"],
            vec!["1003", "30", "40", "300", "240", "90", "30"],
            vec!["1004", "40", "50", "400", "320", "120", "40"],
        ]
        .into_iter()
        .map(|row| row.into_iter().map(String::from).collect())
        .collect::<Vec<Vec<String>>>();
        let mapping = suggest_roles_with_data("tb", &headers, &rows);
        assert_eq!(mapping.get(&1), Some(&"openingFunctionalAmount"));
        assert_ne!(mapping.get(&2), Some(&"openingFunctionalAmount"));
    }

    #[test]
    fn 显式本期发生额必须配本期期初() {
        let headers: Vec<String> = [
            "本年金额-期初",
            "本期金额-本期期初",
            "本期金额-借方发生",
            "本期金额-贷方发生",
        ]
        .into_iter()
        .map(String::from)
        .collect();
        let rows = vec![vec!["10", "20", "30", "10"]]
            .into_iter()
            .map(|row| row.into_iter().map(String::from).collect())
            .collect::<Vec<Vec<String>>>();
        let changes = recheck_cumulative(
            "tb",
            &headers,
            &rows,
            &[
                ("openingFunctionalAmount".into(), "本年金额-期初".into()),
                ("ytdFunctionalDebit".into(), "本期金额-借方发生".into()),
                ("ytdFunctionalCredit".into(), "本期金额-贷方发生".into()),
            ],
        );
        assert!(changes.iter().any(|(role, column)| {
            *role == "openingFunctionalAmount" && column.as_deref() == Some("本期金额-本期期初")
        }));
    }

    #[test]
    fn 有效数值不足时不硬判() {
        let headers: Vec<String> = ["科目编码", "借方发生额", "借方发生额"]
            .iter()
            .map(|x| x.to_string())
            .collect();
        // 只有一行有数，达不到抽查下限。
        let rows: Vec<Vec<String>> = vec![
            vec!["1001".into(), "100".into(), "1200".into()],
            vec!["1002".into(), "".into(), "".into()],
        ];
        let m = suggest_roles_with_data("tb", &headers, &rows);
        // 维持别名判定：只有一列拿到本年累计，另一列留空等用户处理。
        assert_eq!(
            m.values().filter(|r| **r == "ytdFunctionalDebit").count(),
            1
        );
        assert_eq!(
            m.values()
                .filter(|r| **r == "periodFunctionalDebit")
                .count(),
            0
        );
    }

    #[test]
    fn 金额解析认得实务里的各种写法() {
        let ok = |raw: &str| parse_amount(raw).expect("可解析").expect("有值");
        // 千分位：半角、全角、不间断空格。
        assert_eq!(ok("1,234.56"), 1234.56);
        assert_eq!(ok("1，234.56"), 1234.56);
        assert_eq!(ok("1\u{a0}234"), 1234.0);
        // 括号负数、尾部负号。
        assert_eq!(ok("(500)"), -500.0);
        assert_eq!(ok("800-"), -800.0);
        // 借贷后缀：CR 转负、DR 保持正，中文同理。
        assert_eq!(ok("1234CR"), -1234.0);
        assert_eq!(ok("1234DR"), 1234.0);
        assert_eq!(ok("1234贷"), -1234.0);
        assert_eq!(ok("1234借"), 1234.0);
        // 带引号的 CSV 单元格。
        assert_eq!(ok("\"1,234\""), 1234.0);
        // 空值与占位符不是解析失败。
        for blank in ["", "  ", "-", "—", "N/A", "无"] {
            assert_eq!(
                parse_amount(blank).expect("占位符不算失败"),
                None,
                "{blank}"
            );
        }
        // 真读不出来才报错，交给调用方决定是中断还是按 0 继续。
        assert!(parse_amount("待补").is_err());
    }

    #[test]
    fn 金额角色的非空坏值由公共校验拦截() {
        let headers = vec!["借方金额".into(), "贷方金额".into(), "净额".into()];
        let rows = vec![
            vec!["1,000".into(), "—".into(), "".into()],
            vec!["待补".into(), "(50)".into(), "950".into()],
            vec!["无".into(), "-".into(), "0".into()],
        ];
        let column_of = |role: &str| match role {
            "functionalDebit" => vec!["借方金额".into()],
            "functionalCredit" => vec!["贷方金额".into()],
            "functionalAmount" => vec!["净额".into()],
            _ => Vec::new(),
        };
        let issues = mapped_amount_parse_issues("je", &headers, &rows, &column_of);
        assert_eq!(
            issues.len(),
            2,
            "只有空白和横杠合法，其他非数值文本应被拦截"
        );
        assert_eq!(issues[0].role, "functionalDebit");
        assert_eq!(issues[0].row_index, 1);
        assert_eq!(issues[0].value, "待补");
        assert_eq!(issues[1].value, "无");
    }

    #[test]
    fn 计量单位不得自动识别为主体() {
        let headers = vec![
            "凭证编号".into(),
            "日期".into(),
            "单位".into(),
            "借方金额".into(),
            "贷方金额".into(),
        ];
        let rows = vec![
            vec![
                "1".into(),
                "2025-01-01".into(),
                "EA".into(),
                "100".into(),
                "".into(),
            ],
            vec![
                "1".into(),
                "2025-01-01".into(),
                "KG".into(),
                "".into(),
                "-100".into(),
            ],
        ];
        assert!(entity_column_is_measurement_unit(&headers, &rows, "单位"));
        let suggested = suggest_roles_with_data("je", &headers, &rows);
        assert!(
            !suggested.values().any(|role| *role == "entity"),
            "KG/EA 列不能成为主体：{suggested:?}"
        );
    }

    #[test]
    fn 计量单位映射不会拆碎凭证分组() {
        let headers = vec!["单位".into(), "日期".into(), "凭证编号".into()];
        let rows = vec![
            vec!["EA".into(), "2025-01-01".into(), "1".into()],
            vec!["KG".into(), "2025-01-01".into(), "1".into()],
        ];
        let column_of = |role: &str| match role {
            "entity" => vec!["单位".into()],
            "date" => vec!["日期".into()],
            "id" => vec!["凭证编号".into()],
            _ => Vec::new(),
        };
        let groups = group_vouchers_by_roles(&headers, &rows, &column_of);
        assert_eq!(groups, vec![vec![0, 1]]);
    }

    #[test]
    fn 日期解析合并了两个工具的覆盖面() {
        let d = |raw: &str| parse_date(raw).unwrap_or_else(|| panic!("{raw} 应能解析"));
        let expect = NaiveDate::from_ymd_opt(2023, 1, 10).expect("合法日期");
        // 常见分隔写法。
        for raw in ["2023-01-10", "2023/01/10", "2023.01.10", "20230110"] {
            assert_eq!(d(raw), expect, "{raw}");
        }
        // calamine 把真日期读成带时间的文本，要先切掉时间段。
        for raw in [
            "2023-01-10 00:00:00",
            "2023/01/10 08:30:00",
            "2023-01-10T00:00:00",
        ] {
            assert_eq!(d(raw), expect, "{raw}");
        }
        // 英文月份缩写：借款台账里的常见写法。
        assert_eq!(d("10-Jan-2023"), expect);
        assert_eq!(d("10 Jan 2023"), expect);
        // 日在前的欧洲写法。
        assert_eq!(d("10/01/2023"), expect);
        // 中文日期：借款台账的手写体，两位年按 20xx。
        assert_eq!(d("2023年1月10日"), expect);
        assert_eq!(d("23年1月10日"), expect);
        // Excel 序列号：日期被粘贴成数值的写法（44936 = 2023-01-10）。
        assert_eq!(d("44936"), expect);
        assert!(parse_date("").is_none());
        assert!(parse_date("待定").is_none());
    }

    #[test]
    fn 数字解析容忍千分位与括号负数() {
        assert_eq!(cell_number("1,234.56"), Some(1234.56));
        assert_eq!(cell_number("(1,200)"), Some(-1200.0));
        assert_eq!(cell_number("￥3,000"), Some(3000.0));
        assert_eq!(cell_number(""), None);
        assert_eq!(cell_number("借"), None);
        assert_eq!(cell_number("—"), None);
    }

    #[test]
    fn 集团货币不参与量级比较() {
        // TB-4800 的真实结构：本位币与集团货币各一套，集团货币数字大出七倍。
        // 拿它跟本位币比量级会把本年累计判到集团货币那一列上。
        let headers: Vec<String> = ["科目代码", "借方金额-本位币", "借方金额-集团货币"]
            .iter()
            .map(|x| x.to_string())
            .collect();
        let rows: Vec<Vec<String>> = vec![
            vec!["1001".into(), "143172".into(), "1005139".into()],
            vec!["1002".into(), "5252213".into(), "37555808".into()],
            vec!["1003".into(), "100000".into(), "700000".into()],
        ];
        let m = suggest_roles_with_data("tb", &headers, &rows);
        assert_eq!(m.get(&1), Some(&"ytdFunctionalDebit"));
        assert_eq!(m.get(&2), None, "集团货币列不该映射到任何金额角色");
    }

    #[test]
    fn 双语表头按段识别() {
        assert!(segment_exact("科目描述 Description", "科目描述"));
        assert!(segment_exact("过账日期\nPosting Date", "过账日期"));
        assert!(segment_exact("借方(本位币) Debit", "借方"));
        // 不是完整的一段就不算——避免「科目编码」命中「科目」。
        assert!(!segment_exact("科目编码", "科目"));
        assert!(!segment_exact("期初余额(原币)", "期初方向"));
    }

    #[test]
    fn 双语表头的科目描述能落到科目名称() {
        let headers: Vec<String> = [
            "科目 Account",
            "科目描述 Description",
            "借方(本位币) Debit",
            "贷方(本位币) Credit",
        ]
        .iter()
        .map(|x| x.to_string())
        .collect();
        let m = suggest_roles("je", &headers);
        assert_eq!(m.get(&0), Some(&"accountCode"));
        assert_eq!(m.get(&1), Some(&"accountName"));
        assert_eq!(m.get(&2), Some(&"functionalDebit"), "不能判成本位币列");
        assert_eq!(m.get(&3), Some(&"functionalCredit"));
    }

    #[test]
    fn 零星空白不算只标外币() {
        // SAP 报表三合一：113 行里 111 行 RMB、末尾 2 行空——这是缺失不是语义。
        let mut vals = vec!["RMB"; 111];
        vals.push("");
        vals.push("");
        assert_eq!(
            classify_currency_column(vals.iter().copied()),
            CurrencyColumn::Functional { code: "CNY" },
            "1.8% 的空白率不该判成只标外币"
        );
        // 真正只标外币的列空白率在九成以上。
        let mut sparse = vec![""; 80];
        sparse.push("USD");
        assert!(matches!(
            classify_currency_column(sparse.iter().copied()),
            CurrencyColumn::Foreign { .. }
        ));
    }

    #[test]
    fn 一列只能落到一个角色() {
        // 「本位币」既像本位币标识又像本位币金额，分数高的留下。
        let picks = vec![
            ("functionalAmount".to_string(), "本位币".to_string(), 0.94),
            ("functionalCurrency".to_string(), "本位币".to_string(), 0.88),
            ("date".to_string(), "日期".to_string(), 0.94),
        ];
        let give_up = conflicting_roles("je", &picks);
        assert_eq!(
            give_up,
            vec![("functionalCurrency".to_string(), "本位币".to_string())]
        );
    }

    #[test]
    fn 多列角色各占各的列不算冲突() {
        let picks = vec![
            ("accountName".to_string(), "科目名称一级".to_string(), 0.94),
            ("accountName".to_string(), "科目名称二级".to_string(), 0.94),
            ("id".to_string(), "凭证字".to_string(), 0.94),
            ("id".to_string(), "凭证号".to_string(), 0.94),
        ];
        assert!(conflicting_roles("je", &picks).is_empty());
    }

    #[test]
    fn 多列角色被挤掉时只丢那一列() {
        // 「摘要」分数更高，科目名称要放弃这一列，但保住另一列。
        let picks = vec![
            ("accountName".to_string(), "科目名称".to_string(), 0.94),
            ("accountName".to_string(), "摘要".to_string(), 0.72),
            ("summary".to_string(), "摘要".to_string(), 0.94),
        ];
        let give_up = conflicting_roles("je", &picks);
        assert_eq!(
            give_up,
            vec![("accountName".to_string(), "摘要".to_string())]
        );
    }

    #[test]
    fn 币种线索文本可以和科目名称共用一列() {
        // 账户币种写在科目名称里时（银行存款-中行朝阳支行美元户），
        // 币种线索文本必须指向同一列，下游才抽得出币种。
        let picks = vec![
            ("accountName".to_string(), "科目名称".to_string(), 0.94),
            ("currencyText".to_string(), "科目名称".to_string(), 0.72),
        ];
        assert!(conflicting_roles("tb", &picks).is_empty());
    }

    #[test]
    fn 每个角色的标准名唯一() {
        for kind in ["je", "tb"] {
            let mut seen = HashSet::new();
            for role in roles(kind) {
                assert!(seen.insert(role.name), "{kind} 角色重名：{}", role.name);
            }
        }
    }

    #[test]
    fn 形态里引用的角色都存在() {
        for kind in ["je", "tb"] {
            for f in forms(kind) {
                for slot in f.required.iter().chain(f.optional.iter()) {
                    for role in *slot {
                        assert!(
                            role_of(kind, role).is_some(),
                            "{} 引用了不存在的角色 {role}",
                            f.id
                        );
                    }
                }
            }
        }
    }

    #[test]
    fn 空白字段按连续上一行向下填充() {
        let headers = vec!["凭证号".to_string(), "日期".to_string(), "金额".to_string()];
        let mut rows = vec![
            vec!["JE-1".into(), "2026-01-01".into(), "100".into()],
            vec!["".into(), "".into(), "".into()],
            vec!["".into(), "".into(), "-100".into()],
        ];
        let filled = forward_fill_columns(&headers, &mut rows, &["凭证号".into(), "日期".into()]);
        assert_eq!(filled, 4);
        assert_eq!(rows[1], vec!["JE-1", "2026-01-01", ""]);
        assert_eq!(rows[2], vec!["JE-1", "2026-01-01", "-100"]);
    }

    #[test]
    fn 宽松金额解析先剥百分号货币符号与括号() {
        // parse_amount 本身不认的三类写法，宽松版剥掉后走同一套解析：
        // 尾部负号、CR/DR、借贷后缀、千分位照旧认得。
        assert_eq!(parse_amount_lenient("3.5%"), Some(3.5));
        assert_eq!(parse_amount_lenient("(1,234.56)"), Some(-1234.56));
        assert_eq!(parse_amount_lenient("¥800-"), Some(-800.0));
        assert_eq!(parse_amount_lenient("$ (50.00)"), Some(-50.0));
        assert_eq!(parse_amount_lenient("￥3,000"), Some(3000.0));
        // 原本就能解析的写法不受影响。
        assert_eq!(parse_amount_lenient("1,234.56"), Some(1234.56));
        assert_eq!(parse_amount_lenient("1,234CR"), Some(-1234.0));
        // 空值、占位符与读不出的文本一律 None——要区分「空」与「失败」的
        // 调用方走 parse_amount。
        assert_eq!(parse_amount_lenient(""), None);
        assert_eq!(parse_amount_lenient("-"), None);
        assert_eq!(parse_amount_lenient("待补"), None);
    }

    #[test]
    fn 五类报表小计整格命中() {
        // 收编自汇兑损益 is_summary_account 的词表，繁体同形。
        for label in [
            "资产小计",
            "資產小計",
            "负债小计",
            "負債小計",
            "权益小计",
            "權益小計",
            "成本小计",
            "成本小計",
        ] {
            assert!(is_rollup_label(label), "{label} 应命中");
        }
        // 原有词表不回归：合计类照旧、带连接符的后缀照旧。
        assert!(is_rollup_label("合计"));
        assert!(is_rollup_label("交易性金融资产-小计"));
        // 整格相等原则：真实末级科目名字里带「合计/小计」绝不能被连坐。
        assert!(!is_rollup_label("试剂耗材合计"));
        assert!(!is_rollup_label("资产小计-人民币户"));
    }

    #[test]
    fn 固定资产底稿的必填并集() {
        // fa_tbje 原校验：TB 必须有科目＋期初＋期末，JE 必须有凭证号＋日期＋
        // 科目＋金额方案。期初/期末/金额方案（净额或借贷分列）由形态槽把关。
        let tb_mapped = set(&[
            "accountName",
            "openingFunctionalAmount",
            "closingFunctionalAmount",
            "ytdFunctionalDebit",
            "ytdFunctionalCredit",
        ]);
        let missing: Vec<&str> = missing_required(Tool::FaTbje, "tb", &tb_mapped)
            .iter()
            .map(|m| m.role)
            .collect();
        assert!(missing.contains(&"accountCode"), "{missing:?}");
        // 补上编码后 TB 不再报缺。
        let mut tb_full = tb_mapped;
        tb_full.insert("accountCode");
        assert!(
            missing_required(Tool::FaTbje, "tb", &tb_full).is_empty(),
            "{:?}",
            missing_required(Tool::FaTbje, "tb", &tb_full)
        );

        // JE：金额走借贷分列（JE1 形态）同样算给齐。
        let je_full = set(&[
            "date",
            "id",
            "accountCode",
            "accountName",
            "summary",
            "functionalDebit",
            "functionalCredit",
        ]);
        assert!(missing_required(Tool::FaTbje, "je", &je_full).is_empty());
        // 少凭证号要被拦下。
        let mut je_no_voucher = je_full;
        je_no_voucher.remove("id");
        let missing: Vec<&str> = missing_required(Tool::FaTbje, "je", &je_no_voucher)
            .iter()
            .map(|m| m.role)
            .collect();
        assert!(missing.contains(&"id"), "{missing:?}");
    }

    #[test]
    fn 工作表打分让大规模正表压过透视副本() {
        // 02 号样例：25 万行的序时账正表，同一文件里还有一张 384 行的
        // `透视check`——右半边整块粘着科目余额表副本，表头就是标准 TB 表头。
        // 对数规模权重要翻得过表头分的劣势。
        let 正表 = sheet_score(0.72, 251_600, "Sheet1");
        let 透视 = sheet_score(0.86, 384, "透视check");
        assert!(正表 > 透视, "正表 {正表} 应压过透视副本 {透视}");
        // 04 号样例的透视表就叫 `Sheet2`，名字上看不出来，只能靠规模翻盘：
        // 两个数量级的行数差要压得住 0.14 的表头分劣势。
        assert!(sheet_score(0.72, 164_421, "Sheet1") > sheet_score(0.86, 582, "Sheet2"));
        // 10 号样例反过来：`EY 修改` 与正表行数只差一行，这时靠表名降权分开。
        assert!(sheet_score(0.80, 539, "Sheet1") > sheet_score(0.80, 540, "EY 修改"));
        // 辅助表名只降权不排除，且匹配不区分大小写。
        assert!(is_auxiliary_sheet_name("透视check"));
        assert!(is_auxiliary_sheet_name("TB 备份 2026"));
        assert!(is_auxiliary_sheet_name("Pivot Table"));
        assert!(!is_auxiliary_sheet_name("Sheet1"));
    }

    #[test]
    fn 跨表对齐会跳过空的伪科目列并选中真实编码() {
        let je_headers = vec![
            "总账科目/未过账科目".into(),
            "总账科目".into(),
            "会计科目".into(),
        ];
        let je_rows = vec![
            vec!["".into(), "1001010000".into(), "库存现金".into()],
            vec!["".into(), "1002101001".into(), "银行存款".into()],
            vec!["".into(), "6603010000".into(), "利息支出".into()],
        ];
        let tb_headers = vec!["科目".into(), "余额".into()];
        let tb_rows = vec![
            vec!["1001010000:库存现金".into(), "1".into()],
            vec!["1002101001:银行存款".into(), "2".into()],
            vec!["6603010000:利息支出".into(), "3".into()],
        ];
        let aligned =
            align_account_code_columns(&je_headers, &je_rows, &tb_headers, &tb_rows).unwrap();
        assert_eq!(aligned.je_column, "总账科目");
        assert_eq!(aligned.tb_column, "科目");
        assert_eq!(aligned.overlap, 3);
    }
}
