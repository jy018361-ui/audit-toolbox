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

use std::collections::{BTreeMap, BTreeSet, HashSet};

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
    Role { name, label, aliases, conflicts, multi: false }
}

const fn rm(
    name: &'static str,
    label: &'static str,
    aliases: &'static [&'static str],
    conflicts: &'static [&'static str],
) -> Role {
    Role { name, label, aliases, conflicts, multi: true }
}

/// 金额列的通用冲突词：挡住"本位币""原币"这类短别名去吃金额列。
const AMT: &[&str] = &[
    "金额", "金額", "余额", "餘額", "balance", "amount", "发生", "發生", "差异", "差異",
    // 「借方(本位币) Debit」这种双语表头分段后会命中「本位币」，但它是金额列。
    "借方", "贷方", "貸方", "debit", "credit",
    // SAP 的 `Document Currency Value` 含 "currency"，但它是金额不是币种。
    "value",
];
/// 科目编码的冲突词：挡住 `Account` 去吃 `Account Desc`、`Accounting Flexfield`。
const NOT_CODE: &[&str] = &["desc", "description", "名称", "名稱", "文本", "flexfield", "segment"];
/// 科目名称的冲突词。预算／对方是真实踩坑（4800 序时账的「预算二级科目描述」
/// 包含"科目描述"、「对方科目名称」包含"科目名称"），放进来会把账面科目名
/// 拼成对不上 TB 的长串。
const NOT_NAME: &[&str] = &["flexfield", "segment", "code", "编码", "編碼", "代码", "代碼", "预算", "預算", "对方", "對方"];
/// 辅助核算的别名。**只收汇兑损益那一份**——存款利息另有一份把「文本／科目文本／
/// 账户文本」也算辅助核算（它靠这些列认存款档次），并进来会把科目名称抢走。
/// 工具需要额外写法时在自己那边追加，标准表保持保守。
const AUX: &[&str] = &[
    "辅助核算", "輔助核算", "辅助項", "辅助项", "往来单位", "往來單位", "客户", "客戶",
    "供应商", "供應商", "银行账号", "银行帐号", "明细项", "明細項",
    "counterparty", "assignment", "profit center", "profitcenter",
];
/// 辅助核算的冲突词：挡住它去吃科目类与金额类的列。
const NOT_AUX: &[&str] = &["科目", "account", "金额", "amount", "余额", "balance"];
/// 借款明细标识。别名刻意取**特异写法**：`辅助`、`明细`、`客户` 这类泛词留给
/// [`AUX`]，否则同一列谁抢到全看分数，两个工具的结果会分叉。
const LOAN_ID: &[&str] = &[
    "合同编号", "合同編號", "借款编号", "借款編號", "借据", "借據", "借据号", "借款合同号",
    "登记编号", "合同号", "合同號", "loanid", "contractno",
];

/// 集团货币／报告货币是**第三套口径**，既不是本位币也不是原币。
/// SAP 那份 TB 就同时给了本位币与集团货币两套金额，集团货币的数字往往大出几倍——
/// 拿它跟本位币比量级会把本年累计判到错的那一列上。所有金额角色一律排除它。
const NOT_GROUP: &[&str] = &[
    "集团货币", "集團貨幣", "集团币", "集團幣", "报告货币", "報告貨幣",
    // `Grp Curr` 是 SAP 的实际缩写写法（`MTD Grp Curr`、`YTD Act (Grp Curr)`），
    // 实测样例 Oct+BS+PL+TB.xlsx 里就是这么写的，`groupcurr` 匹配不到它。
    "groupcurrency", "reportingcurrency", "groupcurr", "grpcurr", "grpcurrency",
];

/// 序时账角色。一行是一条分录。
pub(crate) fn je_roles() -> &'static [Role] {
    JE_ROLES
}

static JE_ROLES: &[Role] = &[
        r("entity", "公司/核算主体", &["公司代码", "公司代碼", "公司名称", "单位名称", "核算主体", "主体", "公司", "单位", "company", "companycode", "cocode", "businessunit", "breaksegment", "entity", "bukrs"], &["科目", "account", "金额", "amount", "辅助", "往来", "对方", "对手", "供应商", "客户", "value", "currency", "币种", "货币"]),
        r("date", "记账日期", &["日期", "记账日期", "記賬日期", "记帐日期", "过账日期", "过帐日期", "過賬日期", "凭证日期", "憑證日期", "业务日期", "gldate", "postingdate", "entrydate", "budat"], &["期间", "period", "年", "月"]),
        rm("id", "凭证识别字段", &["凭证号", "憑證號", "凭证号数", "凭证编号", "憑證編號", "凭证字", "憑證字", "凭证字号", "凭证名", "voucher", "voucherno", "documentno", "documentnumber", "batchname", "jebatch", "je批名", "jename", "belnr"], &["行号", "行號", "行项目", "行項目", "分录号", "分錄號", "line", "item", "冲销", "沖銷", "反冲", "反沖", "reversed", "reversal"]),
        r("voucherType", "凭证类型", &["凭证类型", "憑證類型", "凭证类别", "憑證類別", "单据类型", "category", "document type", "documenttype", "blart"], &[]),
        r("accountCode", "科目编码", &["科目编码", "科目編碼", "科目代码", "科目代碼", "科目号", "科目編號", "会计科目", "會計科目", "总账科目", "總賬科目", "账户", "帳戶", "account", "glaccount", "accountcode", "saknr"], NOT_CODE),
        rm("accountName", "科目名称", &["科目名称", "科目名稱", "科目描述", "科目文本", "科目全名", "账户名称", "帳戶名稱", "accountname", "accountdesc", "accountdescription", "gldescription", "childdescription"], NOT_NAME),
        // 「文本」是 SAP（SGTXT 行项目文本）与 AX/D365 对摘要的叫法；
        // 「抬头」冲突词挡住「凭证抬头文本」——那是单据号不是行摘要。
        r("summary", "摘要", &["摘要", "摘要说明", "说明", "說明", "备注", "備註", "文本", "entry item", "line description", "sgtxt"], &["科目", "account", "凭证", "憑證", "抬头", "抬頭"]),
        r("currency", "交易币种", &["币种", "幣種", "币别", "幣別", "货币", "貨幣", "货币代码", "貨幣代碼", "原币币种", "交易币种", "凭证货币", "currency", "currencycode", "entercurrency", "documentcurrencykey", "waers"], AMT),
        // SAP 的 `Company Code Currency Key` 记的是公司本位币，不是这笔分录的交易币种。
        // 缺了这个角色，它就会去抢 currency，把真正的 `Document Currency Key` 挤掉。
        r("functionalCurrency", "本位币", &["本位币", "本位幣", "公司代码货币", "记账本位币", "companycodecurrency", "ledgercurrency", "functionalcurrency", "localcurrency"], AMT),
        r("direction", "借贷方向", &["方向", "借贷方向", "借貸方向", "借贷", "借貸", "drcr", "dccr", "debitcredit"], &["金额", "amount", "usd", "cny", "hkd", "eur"]),
        r("functionalAmount", "本位币净额", &["本位币金额", "本位幣金額", "本币金额", "本位币", "本位幣", "借正贷负", "借正貸負", "金额", "金額", "companycodecurrencyvalue", "functionalamount"], &["原币", "原幣", "外币", "外幣", "借方", "贷方", "貸方", "debit", "credit"]),
        r("functionalDebit", "本位币借方", &["本位币借方", "本位幣借方", "借方金额", "借方金額", "借方发生额", "借方", "debits", "debit"], &["原币", "原幣", "外币", "外幣", "贷", "貸", "credit"]),
        r("functionalCredit", "本位币贷方", &["本位币贷方", "本位幣貸方", "贷方金额", "貸方金額", "贷方发生额", "贷方", "貸方", "credits", "credit"], &["原币", "原幣", "外币", "外幣", "借", "debit"]),
        r("foreignAmount", "原币净额", &["原币金额", "原幣金額", "外币金额", "外幣金額", "凭证金额", "憑證金額", "原币", "原幣", "documentcurrencyvalue", "foreignamount"], &["本位币", "本位幣", "借方", "贷方", "貸方", "debit", "credit"]),
        r("foreignDebit", "原币借方", &["原币借方", "原幣借方", "外币借方", "货币借方金额", "貨幣借方金額", "enterdebits"], &["本位币", "本位幣", "贷", "貸"]),
        r("foreignCredit", "原币贷方", &["原币贷方", "原幣貸方", "外币贷方", "货币贷方金额", "貨幣貸方金額", "entercredits"], &["本位币", "本位幣", "借"]),
        // 辅助核算此前不在标准表里，汇兑损益靠一行 `role == "auxiliary"` 特判把它
        // 当多列角色用。TB-4800 的类型表把「辅助信息」列为账表的正式组成部分，
        // 据此收编——SAP 导出常把供应商、客户分成两列，必须可多列。
        rm("auxiliary", "辅助核算", AUX, NOT_AUX),
        // 借款明细标识：借款利息此前按关键词临时找，不在标准表里。
        r("loanId", "借款明细", LOAN_ID, &["金额", "amount", "余额", "balance"]),
];

/// 科目余额表角色。一行是一个科目在某时点的余额。
pub(crate) fn tb_roles() -> &'static [Role] {
    TB_ROLES
}

static TB_ROLES: &[Role] = &[
        r("entity", "公司/核算主体", &["公司代码", "公司代碼", "公司名称", "核算主体", "主体", "company", "companycode", "break segment"], &["科目", "account"]),
        r("accountCode", "科目编码", &["科目编码", "科目編碼", "科目代码", "科目代碼", "科目号", "科目編號", "会计科目", "會計科目", "总账科目", "科目段组合", "account", "glaccount", "slaccount", "accountcode", "accountcombination"], NOT_CODE),
        rm("accountName", "科目名称", &["科目名称", "科目名稱", "科目名称一级", "科目名称二级", "科目名称三级", "科目全称", "科目描述", "科目文本", "账户名称", "帳戶名稱", "accountname", "accountdesc", "accountdescription", "gldescription", "slaccountdesc"], NOT_NAME),
        r("currency", "原币币种", &["币种", "幣種", "币别", "幣別", "货币", "貨幣", "原币币种", "交易币种", "currency", "ccy", "currencycode"], AMT),
        r("currencyText", "币种线索文本", &["文本", "科目文本", "账户文本", "帳戶文本", "说明", "說明", "备注", "備註", "描述"], &["金额", "余额", "amount", "balance"]),
        r("functionalCurrency", "本位币", &["本位币", "本位幣", "功能货币", "记账本位币", "functionalcurrency", "ledgercurrency"], AMT),
        r("openingDirection", "期初方向", &["期初方向", "年初方向", "期初余额方向", "openingdrcr"], &["期末", "本期", "本年"]),
        r("closingDirection", "期末方向", &["期末方向", "年末方向", "期末余额方向", "方向", "closingdrcr", "drcr"], &["期初", "年初"]),
        r("openingFunctionalAmount", "期初本位币余额", &["期初本位币余额", "期初余额", "期初餘額", "期初金额", "期初金額", "年初余额", "年初金额", "beginbalance", "beginningbalance", "openingbalance", "opening"], &["借", "贷", "貸", "原币", "原幣", "外币", "外幣", "期末", "方向", "debit", "credit"]),
        r("openingFunctionalDebit", "期初借方本位币余额", &["期初借方本位币余额", "期初余额借方", "期初借方余额", "期初借方", "年初余额借方", "年初借方", "openingdr", "openingdebit"], &["贷", "貸", "原币", "原幣", "外币", "期末", "credit"]),
        r("openingFunctionalCredit", "期初贷方本位币余额", &["期初贷方本位币余额", "期初余额贷方", "期初贷方余额", "期初贷方", "年初余额贷方", "年初贷方", "openingcr", "openingcredit"], &["借", "原币", "原幣", "外币", "期末", "debit"]),
        r("openingForeignAmount", "期初原币余额", &["期初原币余额", "期初原幣餘額", "期初外币余额", "期初余额原币", "期初餘額原幣", "期初原币", "期初原幣", "openingfcy"], &["借", "贷", "貸", "本位币", "本位幣", "期末"]),
        r("openingForeignDebit", "期初借方原币余额", &["期初借方原币余额", "期初借方原币", "期初原币借方"], &["贷", "貸", "本位币", "本位幣", "期末"]),
        r("openingForeignCredit", "期初贷方原币余额", &["期初贷方原币余额", "期初贷方原币", "期初原币贷方"], &["借", "本位币", "本位幣", "期末"]),
        r("closingFunctionalAmount", "期末本位币余额", &["期末本位币余额", "期末余额", "期末餘額", "期末金额", "期末金額", "年末余额", "年末金额", "endbalance", "endingbalance", "closingbalance", "ytdact", "closing"], &["借", "贷", "貸", "原币", "原幣", "外币", "外幣", "期初", "方向", "debit", "credit"]),
        r("closingFunctionalDebit", "期末借方本位币余额", &["期末借方本位币余额", "期末余额借方", "期末借方余额", "期末借方", "年末余额借方", "年末借方", "closingdr", "closingdebit"], &["贷", "貸", "原币", "原幣", "外币", "期初", "credit"]),
        r("closingFunctionalCredit", "期末贷方本位币余额", &["期末贷方本位币余额", "期末余额贷方", "期末贷方余额", "期末贷方", "年末余额贷方", "年末贷方", "closingcr", "closingcredit"], &["借", "原币", "原幣", "外币", "期初", "debit"]),
        r("closingForeignAmount", "期末原币余额", &["期末原币余额", "期末原幣餘額", "期末外币余额", "期末余额原币", "期末餘額原幣", "期末原币", "期末原幣", "原币期末余额", "origclosing", "closingfcy"], &["借", "贷", "貸", "本位币", "本位幣", "期初"]),
        r("closingForeignDebit", "期末借方原币余额", &["期末借方原币余额", "期末借方原币", "期末原币借方"], &["贷", "貸", "本位币", "本位幣", "期初"]),
        r("closingForeignCredit", "期末贷方原币余额", &["期末贷方原币余额", "期末贷方原币", "期末原币贷方"], &["借", "本位币", "本位幣", "期初"]),
        r("ytdFunctionalDebit", "本年累计本位币借方发生额", &["本年本位币累计借方发生额", "本年累计借方", "本年累计借方发生额", "本年借方发生额", "累计借方", "借方发生额", "借方发生", "借方發生", "借方金额", "ytddebit", "ytddr", "perioddr", "perioddebit"], &["贷", "貸", "原币", "原幣", "外币", "外幣", "本期", "期初", "期末", "credit"]),
        r("ytdFunctionalCredit", "本年累计本位币贷方发生额", &["本年本位币累计贷方发生额", "本年累计贷方", "本年累计贷方发生额", "本年贷方发生额", "累计贷方", "贷方发生额", "贷方发生", "貸方發生", "贷方金额", "ytdcredit", "ytdcr", "periodcr", "periodcredit"], &["借", "原币", "原幣", "外币", "外幣", "本期", "期初", "期末", "debit"]),
        r("ytdForeignDebit", "本年累计原币借方发生额", &["本年原币累计借方发生额", "本年累计原币借方", "借方发生原币", "借方發生原幣", "原币借方发生额", "借方发生额原币"], &["贷", "貸", "本位币", "本位幣", "本期", "期初", "期末"]),
        r("ytdForeignCredit", "本年累计原币贷方发生额", &["本年原币累计贷方发生额", "本年累计原币贷方", "贷方发生原币", "貸方發生原幣", "原币贷方发生额", "贷方发生额原币"], &["借", "本位币", "本位幣", "本期", "期初", "期末"]),
        // SAP 报表型导出只给 MTD（本月）与 YTD（本年）两个净额，没有借贷分列。
        r("periodFunctionalAmount", "本期本位币净发生额", &["本期净发生", "本期发生额", "本月发生额", "periodactivity", "mtd", "mtdlocalcurr"], &["借", "贷", "貸", "原币", "原幣", "外币", "外幣", "期初", "期末", "本年", "累计", "debit", "credit"]),
        r("periodFunctionalDebit", "本期本位币借方发生额", &["本期发生借方", "本期借方发生额", "本期本位币借方发生额", "本期借方", "本月借方", "mtddebit"], &["贷", "貸", "原币", "原幣", "外币", "期初", "期末", "本年", "累计", "credit"]),
        rm("auxiliary", "辅助核算", AUX, NOT_AUX),
        r("loanId", "借款明细", LOAN_ID, &["金额", "amount", "余额", "balance"]),
        // 会计期间只在科目余额表上有用：没有日期列时靠它取年份。
        // 序时账侧一律走 date 列，所以 JE 表里没有这个角色。
        r("period", "会计期间", &["会计期间", "會計期間", "期间", "期間", "所属期间", "年月", "period", "fiscalperiod"], &["金额", "余额", "amount", "balance"]),
        r("periodFunctionalCredit", "本期本位币贷方发生额", &["本期发生贷方", "本期贷方发生额", "本期本位币贷方发生额", "本期贷方", "本月贷方", "mtdcredit"], &["借", "原币", "原幣", "外币", "期初", "期末", "本年", "累计", "debit"]),
];

/// 按标准名取角色定义。
pub(crate) fn role_of(kind: &str, name: &str) -> Option<&'static Role> {
    roles(kind).iter().find(|x| x.name == name)
}

/// `kind` 只接受 `"je"` 与 `"tb"`，其余一律当作 TB——调用方都是内部代码，
/// 静默兜底比 panic 安全。
pub(crate) fn roles(kind: &str) -> &'static [Role] {
    if kind == "je" { je_roles() } else { tb_roles() }
}

// ────────────────────────────── 表头归一化与匹配 ──────────────────────────────

/// 表头归一化：去掉空白与各类分隔符，转小写。与 `fx::normalize_header` 行为一致。
pub(crate) fn normalize_header(v: &str) -> String {
    v.to_lowercase()
        .replace([' ', '\n', '\r', '\t', '_', '-', '—', '/', '\\', '（', '）', '(', ')', '．', '.'], "")
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
    if role.conflicts.iter().any(|c| n.contains(&normalize_header(c))) {
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
    if kind == "je" {
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
    hits.sort_by(|a, b| b.2.partial_cmp(&a.2).unwrap_or(std::cmp::Ordering::Equal).then(a.0.cmp(&b.0)));
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
            list.push(Candidate { column: i, header: h.clone(), score, hits });
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

/// 五个工具各自启用哪些角色。
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
}

impl Tool {
    /// 该工具在这张表上必须映射的角色。
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
            out.push(MissingRole { role, label: r.label, from_gold });
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
        (Some(d), SignConvention::Unsigned) if !d.trim().is_empty() => {
            if is_credit_direction(d) {
                -amount.abs()
            } else {
                amount.abs()
            }
        }
        _ => amount,
    }
}

/// 负债类科目的余额惯例是贷方为正（借款本金、应付账款）。
/// 业务层拿到有符号净额后用它翻个面，不必各自记住符号。
pub(crate) fn credit_positive(signed: f64) -> f64 {
    -signed
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
        let Some(text) = row.get(column) else { continue };
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
    if kind == "je" || rows.is_empty() {
        return;
    }
    for (ytd_name, period_name) in CUMULATIVE_PAIRS {
        let Some(ytd) = role_of("tb", ytd_name) else { continue };
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
    disambiguate_directions(kind, headers, &mut assigned);
    if before == assigned {
        return Vec::new();
    }
    let mut touched: Vec<&'static str> = Vec::new();
    for (ytd, period) in CUMULATIVE_PAIRS {
        touched.push(ytd);
        touched.push(period);
    }
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
    disambiguate_cumulative(kind, headers, rows, &mut out);
    out
}

// ────────────────────────────── 形态型号与整组匹配 ──────────────────────────────

/// 一种表形态。槽位内的角色**缺一不可**——这正是 TB／JE 种类表里合并单元格的含义。
#[derive(Clone, Copy, Debug)]
pub(crate) struct Form {
    pub(crate) id: &'static str,
    pub(crate) label: &'static str,
    /// 必填槽。每个槽是一组角色，组内全部到齐才算该槽满足。
    pub(crate) required: &'static [&'static [&'static str]],
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
            label: "本位币净额",
            required: &[&["openingFunctionalAmount"], &["closingFunctionalAmount"], YTD_F],
            optional: &[YTD_X],
        },
        Form {
            id: "TB2",
            label: "方向＋本位币净额",
            required: &[
                &["openingDirection", "openingFunctionalAmount"],
                &["closingDirection", "closingFunctionalAmount"],
                YTD_F,
            ],
            optional: &[YTD_X],
        },
        Form {
            id: "TB3",
            label: "本位币借贷分列",
            required: &[
                &["openingFunctionalDebit", "openingFunctionalCredit"],
                &["closingFunctionalDebit", "closingFunctionalCredit"],
                YTD_F,
            ],
            optional: &[YTD_X],
        },
        Form {
            id: "TB4",
            label: "本位币净额＋原币净额",
            required: &[
                &["openingFunctionalAmount", "openingForeignAmount"],
                &["closingFunctionalAmount", "closingForeignAmount"],
                YTD_F,
            ],
            optional: &[YTD_X],
        },
        Form {
            id: "TB5",
            label: "方向＋本位币净额＋原币净额",
            required: &[
                &["openingDirection", "openingFunctionalAmount", "openingForeignAmount"],
                &["closingDirection", "closingFunctionalAmount", "closingForeignAmount"],
                YTD_F,
            ],
            optional: &[YTD_X],
        },
        Form {
            id: "TB6",
            label: "本位币与原币双借贷分列",
            required: &[
                &["openingFunctionalDebit", "openingFunctionalCredit", "openingForeignDebit", "openingForeignCredit"],
                &["closingFunctionalDebit", "closingFunctionalCredit", "closingForeignDebit", "closingForeignCredit"],
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
            label: "本位币净额（借正贷负）",
            required: &[&["functionalAmount"]],
            optional: &[&["foreignAmount"]],
        },
        Form {
            id: "JE2",
            label: "方向＋本位币净额",
            required: &[&["direction", "functionalAmount"]],
            optional: &[&["foreignAmount"]],
        },
        Form {
            id: "JE1",
            label: "本位币借贷分列",
            // 借贷分列本身已表达方向，不再要求方向列——实测 9 份序时账里
            // 借贷分列的那 6 份**没有一份带方向列**，金标 2026-08-24 修订时
            // 也把型一的方向列去掉了。有方向列时它只作校验。
            required: &[&["functionalDebit", "functionalCredit"]],
            optional: &[&["foreignDebit", "foreignCredit"]],
        },
];

pub(crate) fn forms(kind: &str) -> &'static [Form] {
    if kind == "je" { je_forms() } else { tb_forms() }
}

/// 一次形态匹配的结果。
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct FormMatch {
    pub(crate) form: &'static str,
    pub(crate) label: &'static str,
    /// 必填槽缺失的角色。空即完整命中。
    pub(crate) missing: Vec<&'static str>,
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
        // 本年累计发生额缺失、而本期发生额借贷齐全时按次选口径放行。
        // 金标的类型表只写了本年累计，但实测样例里确有只给本期的余额表
        // （用友导出的「本期发生借方／贷方」），汇兑损益的必填校验本来也接受
        // 「本年累计（或本期）」——形态判定跟它对齐，否则那三个本期角色形同虚设。
        if !missing.is_empty()
            && missing.iter().all(|r| r.starts_with("ytdFunctional"))
            && mapped.contains("periodFunctionalDebit")
            && mapped.contains("periodFunctionalCredit")
        {
            missing.clear();
        }
        let mut partial = Vec::new();
        for slot in f.optional {
            let (hit, miss) = slot_state(slot, mapped);
            if hit > 0 && !miss.is_empty() {
                partial.extend(miss);
            }
        }
        let complete = missing.is_empty() && partial.is_empty();
        out.push((
            FormMatch {
                form: f.id,
                label: f.label,
                missing,
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
            .then(a.0.missing.len().cmp(&b.0.missing.len()))
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
        label: "",
        missing: Vec::new(),
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
    if !m.partial_optional.is_empty() {
        let names: Vec<String> = m.partial_optional.iter().map(|x| label(x)).collect();
        parts.push(format!(
            "可选字段只映射了一半，「{}」也必须一并映射",
            names.join("」「")
        ));
    }
    if parts.is_empty() {
        return format!("表结构无法匹配任何已知形态（最接近 {}）", m.form);
    }
    format!("按 {}（{}）匹配，{}", m.form, m.label, parts.join("；"))
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
    CurrencyColumn::Foreign { codes, has_blank: blank > 0 }
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
                return CurrencyColumn::Foreign { codes, has_blank: false };
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
        || matches!(lower.as_str(), "c" | "cr" | "h")
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
type Fixture = (&'static str, &'static [&'static str], &'static [&'static str]);

const TB_FIXTURES: &[Fixture] = &[
    (
        "01 北重精工（用友，只标外币）",
        &["科目编码", "科目名称", "辅助核算", "币种", "方向", "期初余额(原币)", "期初余额", "借方发生额", "贷方发生额", "期末余额(原币)", "期末余额"],
        &["accountCode", "accountName", "auxiliary", "currency", "closingDirection", "openingForeignAmount", "openingFunctionalAmount", "ytdFunctionalDebit", "ytdFunctionalCredit", "closingForeignAmount", "closingFunctionalAmount"],
    ),
    (
        "02 泓源化工（用友，纯本币）",
        &["科目代码", "科目名称", "方向", "期初余额", "借方发生额", "贷方发生额", "期末余额"],
        &["accountCode", "accountName", "closingDirection", "openingFunctionalAmount", "ytdFunctionalDebit", "ytdFunctionalCredit", "closingFunctionalAmount"],
    ),
    (
        "03 陇能建设（方向列在末尾）",
        &["科目编码", "科目名称", "期初余额", "借方发生额", "贷方发生额", "期末余额", "方向"],
        &["accountCode", "accountName", "openingFunctionalAmount", "ytdFunctionalDebit", "ytdFunctionalCredit", "closingFunctionalAmount", "closingDirection"],
    ),
    (
        "04 恒澜重工（SAP，借贷分列＋原币期末）",
        &["公司代码 Company", "科目 Account", "科目描述 Description", "期初余额(借) Opening Dr", "期初余额(贷) Opening Cr", "借方发生 Debit", "贷方发生 Credit", "期末余额(借) Closing Dr", "期末余额(贷) Closing Cr", "币种 Ccy", "原币期末余额 Orig Closing", "记账汇率 Rate"],
        &["entity", "accountCode", "accountName", "openingFunctionalDebit", "openingFunctionalCredit", "ytdFunctionalDebit", "ytdFunctionalCredit", "closingFunctionalDebit", "closingFunctionalCredit", "currency", "closingForeignAmount", ""],
    ),
    (
        "06 艾维特苏州（Oracle EBS，两列同名方向）",
        &["科目段组合 Account Combination", "科目描述 Description", "期初余额 Opening", "方向 Dr/Cr", "借方发生 Debits", "贷方发生 Credits", "期末余额 Closing", "方向 Dr/Cr", "币种 Ccy", "原币期末余额 Orig Closing", "记账汇率 Rate"],
        &["accountCode", "accountName", "openingFunctionalAmount", "openingDirection", "ytdFunctionalDebit", "ytdFunctionalCredit", "closingFunctionalAmount", "closingDirection", "currency", "closingForeignAmount", ""],
    ),
    (
        "07 南嶺實業香港（繁体，原币本位币双列）",
        &["科目編號 Account Code", "科目名稱 Account Name", "幣種 Ccy", "匯率 Rate", "期初餘額-原幣 Ob. (Fcy)", "期初餘額-本位幣 Ob. (HKD)", "借方發生-原幣 Dr (Fcy)", "借方發生-本位幣 Dr (HKD)", "貸方發生-原幣 Cr (Fcy)", "貸方發生-本位幣 Cr (HKD)", "期末餘額-原幣 End. (Fcy)", "期末餘額-本位幣 End. (HKD)", "方向 Dir"],
        &["accountCode", "accountName", "currency", "", "openingForeignAmount", "openingFunctionalAmount", "ytdForeignDebit", "ytdFunctionalDebit", "ytdForeignCredit", "ytdFunctionalCredit", "closingForeignAmount", "closingFunctionalAmount", "closingDirection"],
    ),
    (
        "09 澄宇结算中心（原币本位币全借贷分列）",
        &["科目编码", "科目名称", "币种", "汇率", "期初借方-原币", "期初借方-本位币", "期初贷方-原币", "期初贷方-本位币", "借方发生-原币", "借方发生-本位币", "贷方发生-原币", "贷方发生-本位币", "期末借方-原币", "期末借方-本位币", "期末贷方-原币", "期末贷方-本位币", "方向"],
        &["accountCode", "accountName", "currency", "", "openingForeignDebit", "openingFunctionalDebit", "openingForeignCredit", "openingFunctionalCredit", "ytdForeignDebit", "ytdFunctionalDebit", "ytdForeignCredit", "ytdFunctionalCredit", "closingForeignDebit", "closingFunctionalDebit", "closingForeignCredit", "closingFunctionalCredit", "closingDirection"],
    ),
    (
        "SAP 科目明细（汇兑损益测试资料，TB-4800）",
        &["科目名称一级", "科目名称二级", "科目代码", "公司代码", "货币", "文本", "期初金额-本位币", "借方金额-本位币", "贷方金额-本位币", "期末金额-本位币"],
        &["accountName", "accountName", "accountCode", "entity", "currency", "currencyText", "openingFunctionalAmount", "ytdFunctionalDebit", "ytdFunctionalCredit", "closingFunctionalAmount"],
    ),
];

const JE_FIXTURES: &[Fixture] = &[
    (
        "01 北重精工（用友，借贷分列＋原币）",
        &["日期", "凭证字号", "摘要", "科目编码", "科目名称", "借方金额", "贷方金额", "币种", "原币金额", "辅助核算"],
        &["date", "id", "summary", "accountCode", "accountName", "functionalDebit", "functionalCredit", "currency", "foreignAmount", "auxiliary"],
    ),
    (
        "02 泓源化工（用友，纯本币）",
        &["日期", "凭证字号", "摘要", "科目代码", "科目名称", "借方金额", "贷方金额"],
        &["date", "id", "summary", "accountCode", "accountName", "functionalDebit", "functionalCredit"],
    ),
    (
        "04 恒澜重工（SAP，双语表头）",
        &["过账日期 Posting Date", "凭证号 Document No.", "行项目 Item", "科目 Account", "科目描述 Description", "摘要 Narrative", "借方(本位币) Debit", "贷方(本位币) Credit", "币种 Ccy", "汇率 Rate", "原币金额 Orig Amt", "统驭对象/参考 Reference"],
        &["date", "id", "", "accountCode", "accountName", "summary", "functionalDebit", "functionalCredit", "currency", "", "foreignAmount", ""],
    ),
    (
        "06 艾维特苏州（Oracle，Batch＋JE Name 组合键）",
        &["JE批名 Batch", "凭证名 JE Name", "行号 Line", "日期 GL Date", "科目段 Account", "科目描述 Description", "摘要 Narrative", "借方 Debit", "贷方 Credit", "币种 Ccy", "汇率 Rate", "原币金额 Orig Amt", "参考 Reference"],
        &["id", "id", "", "date", "accountCode", "accountName", "summary", "functionalDebit", "functionalCredit", "currency", "", "foreignAmount", ""],
    ),
    (
        "07 南嶺實業香港（繁体，原币本位币双借贷）",
        &["憑證日期 Date", "憑證字 V-Type", "憑證號 V-No", "摘要 Description", "科目編號 Account Code", "科目名稱 Account Name", "幣種 Ccy", "匯率 Rate", "原幣借方 Dr (Fcy)", "原幣貸方 Cr (Fcy)", "本位幣借方 Dr (HKD)", "本位幣貸方 Cr (HKD)", "往來單位 Counterparty"],
        &["date", "id", "id", "summary", "accountCode", "accountName", "currency", "", "foreignDebit", "foreignCredit", "functionalDebit", "functionalCredit", "auxiliary"],
    ),
    (
        "09 澄宇结算中心（原币本位币双借贷＋辅助核算）",
        &["日期", "凭证字号", "摘要", "科目编码", "科目名称", "币种", "原币借方", "原币贷方", "汇率", "本位币借方", "本位币贷方", "辅助核算-往来单位", "制单人"],
        &["date", "id", "summary", "accountCode", "accountName", "currency", "foreignDebit", "foreignCredit", "", "functionalDebit", "functionalCredit", "auxiliary", ""],
    ),
];

fn check_fixtures(kind: &str, fixtures: &[Fixture]) -> Vec<String> {
    let mut problems = Vec::new();
    for (name, headers, expected) in fixtures {
        assert_eq!(headers.len(), expected.len(), "{name}：表头与期望列数不一致");
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
                    if actual.is_empty() { "不映射" } else { actual },
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
            "凭证号码", "冲销凭证号", "被冲销凭证号", "会计科目", "科目文本",
            "预算二级科目描述", "对方科目名称", "往来单位名称",
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
            "科目名称一级", "科目名称二级", "科目代码", "公司代码", "货币", "文本",
            "期初金额-本位币", "借方金额-本位币", "贷方金额-本位币", "期末金额-本位币",
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
            BalanceRow { opening: 100.0, debit: 50.0, credit: 30.0, closing: 120.0 },
            BalanceRow { opening: 0.0, debit: 10.0, credit: 4.0, closing: 6.0 },
            BalanceRow { opening: -20.0, debit: 0.0, credit: 5.0, closing: -25.0 },
        ];
        let e = tb_sign_evidence(&rows);
        assert_eq!(e.convention, Some(SignConvention::Unsigned));
        assert_eq!(e.convention.unwrap().credit_sign(), -1.0);
        assert!(sign_is_trustworthy(&e), "{e:?}");
    }

    #[test]
    fn tb贷方已带负号时判为已带符号() {
        let rows = vec![
            BalanceRow { opening: 100.0, debit: 50.0, credit: -30.0, closing: 120.0 },
            BalanceRow { opening: 0.0, debit: 10.0, credit: -4.0, closing: 6.0 },
        ];
        let e = tb_sign_evidence(&rows);
        assert_eq!(e.convention, Some(SignConvention::Signed));
        assert_eq!(e.convention.unwrap().credit_sign(), 1.0);
    }

    #[test]
    fn tb贷方全零时退到列级兜底() {
        let rows = vec![BalanceRow { opening: 10.0, debit: 0.0, credit: 0.0, closing: 10.0 }];
        let e = tb_sign_evidence(&rows);
        assert_eq!(e.signed_votes + e.unsigned_votes, 0, "无票");
        assert!(e.note.is_some(), "应给出兜底说明");
        assert!(sign_is_trustworthy(&e), "无投票证据不等于不可信");
    }

    #[test]
    fn tb勾稽不上时判定不可信() {
        let rows = vec![
            BalanceRow { opening: 100.0, debit: 50.0, credit: 30.0, closing: 999.0 },
            BalanceRow { opening: 0.0, debit: 10.0, credit: 4.0, closing: 777.0 },
            BalanceRow { opening: 5.0, debit: 1.0, credit: 1.0, closing: 5.0 },
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
        for t in [Tool::DepositInterest, Tool::LoanInterest, Tool::Ledger] {
            assert!(!t.uses_foreign());
        }
    }

    #[test]
    fn 缺必填角色时给中文标签() {
        let mapped: HashSet<&str> = ["accountCode"].into_iter().collect();
        let missing = missing_required_labels(Tool::FxAudit, "je", &mapped);
        assert!(missing.contains(&"记账日期"), "{missing:?}");
        assert!(missing.contains(&"交易币种"), "{missing:?}");
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
        let mapped: HashSet<&str> = ["id", "accountCode", "functionalAmount"].into_iter().collect();
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
        assert!(missing.iter().find(|m| m.role == "summary").expect("有摘要").from_gold);
    }

    #[test]
    fn 缺失项能分辨金标要求还是工具要求() {
        // 交易币种只有汇兑损益要，不是金标身份槽——被拦下时用户该知道换个工具就不需要。
        let mapped: HashSet<&str> =
            ["date", "id", "accountCode", "accountName", "summary", "functionalAmount"]
                .into_iter()
                .collect();
        let missing = missing_required(Tool::FxAudit, "je", &mapped);
        let currency = missing.iter().find(|m| m.role == "currency").expect("缺交易币种");
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
    fn 只给本期发生额的余额表按次选口径放行() {
        // 实测样例「科目余额表.xls」（用友导出）只有本期发生借方／贷方，
        // 没有本年累计。金标的类型表没写这种情况，但它真实存在。
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
        // 只给本期：放行。
        mapped.insert("periodFunctionalDebit");
        mapped.insert("periodFunctionalCredit");
        assert!(
            missing_required(Tool::DepositInterest, "tb", &mapped).is_empty(),
            "{:?}",
            missing_required(Tool::DepositInterest, "tb", &mapped)
        );
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
        let v = AmountInputs { debit: Some(100.0), credit: Some(30.0), ..Default::default() };
        assert_eq!(signed_amount(&v, SignConvention::Unsigned), 70.0);
        // 已带符号时贷方本身是负数。
        let v = AmountInputs { debit: Some(0.0), credit: Some(-30.0), ..Default::default() };
        assert_eq!(signed_amount(&v, SignConvention::Signed), -30.0);
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
        let v = AmountInputs { amount: Some(-120.0), ..Default::default() };
        assert_eq!(signed_amount(&v, SignConvention::Signed), -120.0);
        assert_eq!(credit_positive(signed_amount(&v, SignConvention::Signed)), 120.0);
    }

    #[test]
    fn 旧角色名能迁移到标准名() {
        assert_eq!(migrate_role_name("je", "voucherId"), "id");
        assert_eq!(migrate_role_name("je", "account"), "accountCode");
        assert_eq!(migrate_role_name("je", "amount"), "functionalAmount");
        assert_eq!(migrate_role_name("je", "foreignDirection"), "direction");
        assert_eq!(migrate_role_name("tb", "openingPrincipal"), "openingFunctionalAmount");
        assert_eq!(migrate_role_name("tb", "periodDebit"), "ytdFunctionalDebit");
        // 标准名原样返回。
        assert_eq!(migrate_role_name("je", "accountCode"), "accountCode");
        assert_eq!(migrate_role_name("tb", "closingForeignAmount"), "closingForeignAmount");
        // 认不出的退回空串。
        assert_eq!(migrate_role_name("tb", "不存在的角色"), "");
    }

    #[test]
    fn 集团货币口径的列不给任何金额角色() {
        // 实测 Oct+BS+PL+TB.xlsx：SAP 用 `Grp Curr` 缩写，`groupcurr` 匹配不到。
        for header in ["MTD Grp Curr", "YTD Act (Grp Curr)", "集团货币金额", "Group Currency Value"] {
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
        assert!(!role_rejects_header("tb", "ytdFunctionalCredit", "本年累计贷方"));
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
        assert!(!role_rejects_header("je", "accountName", "Cost Center Desc"));
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
        assert_eq!(m.values().filter(|r| **r == "ytdFunctionalDebit").count(), 1);
        assert_eq!(m.values().filter(|r| **r == "periodFunctionalDebit").count(), 0);
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
}
