// 货币资金/利息类三个工具的演示数据：存款利息收入测算（deposit.*）、
// 借款利息测算（loan.*）、汇兑损益测算（fx.*），以及它们共用的公共账表
// 引擎方法（ledger.forms / ledger.review_* / ledger.check_mapping_alignment）。
//
// 覆盖的是"上传 → 识别 → 科目/利率确认"链路上的全部同步 engineCall 方法；
// 测算预览/导出走 jobStart 事件流（deposit.preview|export、fx.preview|export、
// loan.preview|export），不在本文件范围内——job 任务在预览模式仍会提示用桌面应用。
//
// 数据设计要点（布局审查用）：
// - 各 TB 识别结果 12 条以上科目，其中 4 条以上超长科目名（≥24 个汉字）
//   用于测科目清单折行；
// - TB/JE 都带外币账户（美元 USD / 港币 HKD），供汇兑损益页的币种下拉与
//   accountCurrencyDetails 展示；deposit TB 里也留了两户外币计息账户；
// - 利率档位 14 档（活期/协定/通知/定期/大额存单/自定义），金额一律千分位。
// 形状对齐 Rust 引擎同名方法的返回（见 fx.rs / deposit_interest.rs /
// ledger_mapping.rs 的 inspect / classify / rate_tiers），可对照排查字段。

type Dict = Record<string, unknown>;

const COMPANY = "北京华远国际贸易有限公司";
const REPORT_END = "2025-12-31";
const DATA_YEARS = [2025];
const DEMO_PATH = "C:\\演示数据\\样例文件.xlsx";

/** 千分位金额（保留两位小数），演示数据统一走这里，避免手抄错。 */
const money = (value: number) =>
  value.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

/** 引擎随识别结果下发的角色标签表（{name,label}）。 */
const roleLabels = (pairs: Array<[string, string]>) =>
  pairs.map(([name, label]) => ({ name, label }));

const sourceSheet = (params: Dict): string => {
  const source = params.source as Dict | undefined;
  const sheet = source?.sheet;
  return typeof sheet === "string" ? sheet : "";
};

const scriptKind = (params: Dict): "je" | "tb" => {
  const payload = params.payload as Dict | undefined;
  const kind = payload?.scriptKind;
  return kind === "je" ? "je" : "tb";
};

// ---------------------------------------------------------------------------
// 工作簿分类（deposit.classify_source / fx.classify_source）
// 与 Rust classify_source 同形状：逐 Sheet 返回 kind、scores、headers、preview。
// 预览模式下 pickPath 永远返回同一个"样例文件"，所以一个工作簿内放齐
// TB + JE + 一张低置信度 Sheet，既让"一次拖入自动配对"能走通，
// 也让"N 个来源已识别；M 张低置信度 Sheet 已忽略"这句话有数据可依。
// ---------------------------------------------------------------------------

type SheetSpec = {
  sheet: string;
  kind: "je" | "tb";
  jeScore: number;
  tbScore: number;
  reasons: string[];
  headers: string[];
  preview: string[][];
};

const classify = (sheetOrder: string[], specs: Record<string, SheetSpec>, params: Dict) => {
  const wanted = sourceSheet(params);
  const spec = specs[wanted] ?? specs[sheetOrder[0]];
  const kind = spec.kind;
  const score = Math.max(spec.jeScore, spec.tbScore);
  const best = kind === "je" ? spec.jeScore : spec.tbScore;
  const ceiling = kind === "je" ? 13 : 11;
  return {
    kind,
    confidence: best === 0 ? 0 : Math.min(best / ceiling, 1),
    needsLlm: score < 5 || Math.abs(spec.jeScore - spec.tbScore) < 2,
    scores: { je: spec.jeScore, tb: spec.tbScore },
    reasons: spec.reasons,
    path: DEMO_PATH,
    sheet: spec.sheet,
    sheets: sheetOrder,
    headerRow: 1,
    headerDepth: 1,
    headers: spec.headers,
    preview: spec.preview,
  };
};

// ---------------------------------------------------------------------------
// 公共数据：存款利息工作簿的 TB / JE 两张 Sheet
// ---------------------------------------------------------------------------

const DEPOSIT_TB_HEADERS = [
  "公司",
  "科目编码",
  "科目名称",
  "辅助核算/银行账户",
  "币种",
  "期初余额",
  "期末余额",
  "本年累计借方",
  "本年累计贷方",
];

const DEPOSIT_TB_ACCOUNTS = [
  "1001 库存现金-人民币",
  "1002010101 银行存款-中国工商银行股份有限公司北京朝阳支行营业部-基本存款账户-人民币",
  "1002010102 银行存款-招商银行股份有限公司上海浦东支行-一般存款账户-人民币",
  "1002020101 银行存款-汇丰银行（中国）有限公司上海分行-外币存款账户-美元",
  "1002030101 银行存款-中国银行股份有限公司深圳福田支行-外币存款账户-港币",
  "1012010101 其他货币资金-支付宝（中国）网络技术有限公司-备付金存款-人民币",
  "1012020101 其他货币资金-银行承兑汇票保证金-中国建设银行股份有限公司-人民币",
  "6603010101 财务费用-利息收入-银行存款利息-人民币",
  "6603010201 财务费用-利息收入-外币存款利息-美元及港币",
  "2202010101 应付账款-关联方-合并范围内全资子公司-直接采购-库存商品",
  "2501010101 短期借款-银行借款-中国工商银行北京分行-流动资金借款-人民币",
  "2241010101 其他应付款-关联方资金往来-集团财务有限责任公司-内部拆借",
  "1501010101 长期待摊费用-办公室装修改造工程款项-按五年平均摊销",
  "6602010101 管理费用-银行手续费-账户管理费与支付渠道手续费",
];

const DEPOSIT_TB_PREVIEW = [
  [COMPANY, "1001", "库存现金-人民币", "本部出纳", "CNY", money(85600), money(112800), money(1265000), money(1237800)],
  [COMPANY, "1002010101", "银行存款-中国工商银行股份有限公司北京朝阳支行营业部-基本存款账户-人民币", "工行基本户-0200", "CNY", money(4580000), money(5236500), money(58210000), money(57574500)],
  [COMPANY, "1002010102", "银行存款-招商银行股份有限公司上海浦东支行-一般存款账户-人民币", "招行一般户-6606", "CNY", money(8650000), money(7980000), money(32150000), money(32820000)],
  [COMPANY, "1002020101", "银行存款-汇丰银行（中国）有限公司上海分行-外币存款账户-美元", "汇丰外币户-8801", "USD", money(1284000), money(1452800), money(9625000), money(9456200)],
  [COMPANY, "1002030101", "银行存款-中国银行股份有限公司深圳福田支行-外币存款账户-港币", "中行港币户-2210", "HKD", money(765300), money(698400), money(5120600), money(5187500)],
  [COMPANY, "1012010101", "其他货币资金-支付宝（中国）网络技术有限公司-备付金存款-人民币", "支付宝备付金", "CNY", money(2340000), money(1876000), money(9860000), money(10324000)],
  [COMPANY, "6603010101", "财务费用-利息收入-银行存款利息-人民币", "", "CNY", money(0), money(0), money(1200), money(86300)],
  [COMPANY, "2202010101", "应付账款-关联方-合并范围内全资子公司-直接采购-库存商品", "华远（香港）贸易", "USD", money(2150000), money(1876000), money(12480000), money(12722000)],
];

const DEPOSIT_TB_ROLES = roleLabels([
  ["entity", "公司/核算主体"],
  ["accountCode", "科目编码"],
  ["accountName", "科目名称"],
  ["auxiliary", "辅助核算/银行账户"],
  ["currency", "币种"],
  ["period", "会计期间（选填）"],
  ["openingDirection", "期初方向"],
  ["closingDirection", "期末方向"],
  ["openingFunctionalAmount", "年初余额（净额）"],
  ["openingFunctionalDebit", "年初余额借方"],
  ["openingFunctionalCredit", "年初余额贷方"],
  ["closingFunctionalAmount", "期末余额（净额）"],
  ["closingFunctionalDebit", "期末余额借方"],
  ["closingFunctionalCredit", "期末余额贷方"],
  ["ytdFunctionalDebit", "本年累计借方发生额"],
  ["ytdFunctionalCredit", "本年累计贷方发生额"],
]);

const DEPOSIT_TB_MAPPING: Dict = {
  entity: "公司",
  accountCode: "科目编码",
  accountName: "科目名称",
  auxiliary: "辅助核算/银行账户",
  currency: "币种",
  openingFunctionalAmount: "期初余额",
  closingFunctionalAmount: "期末余额",
  ytdFunctionalDebit: "本年累计借方",
  ytdFunctionalCredit: "本年累计贷方",
};

/** 存款页的科目角色建议：货币资金计息、利息收入做勾稽基准，其余排除。 */
const depositAccountRole = (account: string): string => {
  if (account.startsWith("1002")) return "deposit";
  if (account.startsWith("1012")) return "other_monetary";
  if (account.startsWith("1001")) return "cash_on_hand";
  if (account.startsWith("660301")) return "interest_income";
  return "excluded";
};

const depositSuggestedRoles = (accounts: string[]): Record<string, string> =>
  Object.fromEntries(accounts.map((account) => [account, depositAccountRole(account)]));

const depositSuggestedTiers = (accounts: string[]): Record<string, string> =>
  Object.fromEntries(
    accounts.map((account) => {
      let tier = "demand";
      if (account.includes("备付金存款")) tier = "notice_7d";
      else if (account.includes("保证金")) tier = "term_6m";
      return [account, tier];
    }),
  );

const DEPOSIT_JE_HEADERS = [
  "记账日期",
  "凭证类型",
  "凭证号",
  "公司",
  "科目编码",
  "科目名称",
  "辅助核算/银行账户",
  "摘要",
  "币种",
  "借方金额",
  "贷方金额",
];

const bankName = (code: string) => {
  const found = DEPOSIT_TB_ACCOUNTS.find((account) => account.startsWith(`${code} `));
  return found ? found.slice(code.length + 1) : code;
};

const DEPOSIT_JE_PREVIEW = [
  ["2025-03-21", "收", "0007", COMPANY, "1002010101", bankName("1002010101"), "工行基本户-0200", "收到工行一季度存款利息", "CNY", money(12458.3), ""],
  ["2025-03-31", "记", "0089", COMPANY, "6603010101", bankName("6603010101"), "", "结转一季度银行存款利息", "CNY", "", money(12458.3)],
  ["2025-06-21", "收", "0054", COMPANY, "1002020101", bankName("1002020101"), "汇丰外币户-8801", "收到汇丰二季度美元存款利息", "USD", money(1860), ""],
  ["2025-06-30", "记", "0142", COMPANY, "6603010201", bankName("6603010201"), "", "结转外币存款利息", "USD", "", money(1860)],
  ["2025-09-20", "收", "0131", COMPANY, "1002030101", bankName("1002030101"), "中行港币户-2210", "收到中行三季度港币存款利息", "HKD", money(9240), ""],
  ["2025-09-30", "记", "0208", COMPANY, "6603010201", bankName("6603010201"), "", "结转外币存款利息", "HKD", "", money(9240)],
  ["2025-12-21", "收", "0288", COMPANY, "1012010101", bankName("1012010101"), "支付宝备付金", "收到支付宝备付金四季度利息", "CNY", money(5312.45), ""],
  ["2025-12-31", "记", "0301", COMPANY, "6603010101", bankName("6603010101"), "", "结转四季度存款利息", "CNY", "", money(5312.45)],
];

/** JE 侧科目用「名称＋编码」的相反拼法，页面按编码归并后仍与 TB 对上。 */
const DEPOSIT_JE_ACCOUNTS = [
  "银行存款-中国工商银行股份有限公司北京朝阳支行营业部-基本存款账户-人民币 1002010101",
  "银行存款-招商银行股份有限公司上海浦东支行-一般存款账户-人民币 1002010102",
  "银行存款-汇丰银行（中国）有限公司上海分行-外币存款账户-美元 1002020101",
  "银行存款-中国银行股份有限公司深圳福田支行-外币存款账户-港币 1002030101",
  "其他货币资金-支付宝（中国）网络技术有限公司-备付金存款-人民币 1012010101",
  "财务费用-利息收入-银行存款利息-人民币 6603010101",
  "财务费用-利息收入-外币存款利息-美元及港币 6603010201",
  "库存现金-人民币 1001",
];

const DEPOSIT_JE_ROLES = roleLabels([
  ["date", "记账日期"],
  ["id", "凭证号"],
  ["voucherType", "凭证类型"],
  ["entity", "公司/核算主体"],
  ["accountCode", "科目编码"],
  ["accountName", "科目名称"],
  ["auxiliary", "辅助核算/银行账户"],
  ["summary", "摘要"],
  ["currency", "币种"],
  ["functionalDebit", "借方金额"],
  ["functionalCredit", "贷方金额"],
  ["functionalAmount", "本位币有符号金额"],
  ["direction", "借贷方向"],
]);

const DEPOSIT_JE_MAPPING: Dict = {
  date: "记账日期",
  id: ["凭证类型", "凭证号"],
  entity: "公司",
  accountCode: "科目编码",
  accountName: "科目名称",
  auxiliary: "辅助核算/银行账户",
  summary: "摘要",
  currency: "币种",
  functionalDebit: "借方金额",
  functionalCredit: "贷方金额",
};

const depositInspection = (kind: "tb" | "je") => ({
  kind,
  path: DEMO_PATH,
  sheet: kind === "tb" ? "TB科目余额表" : "银行存款序时账",
  sheets: ["TB科目余额表", "银行存款序时账", "填表说明"],
  headerRow: 1,
  headerDepth: 1,
  headerDetection: { needsConfirmation: false, candidates: [{ row: 1, score: 0.96 }] },
  headers: kind === "tb" ? DEPOSIT_TB_HEADERS : DEPOSIT_JE_HEADERS,
  preview: kind === "tb" ? DEPOSIT_TB_PREVIEW : DEPOSIT_JE_PREVIEW,
  rowCount: kind === "tb" ? 386 : 1462,
  mappingCandidates: [
    {
      role: kind === "tb" ? "closingFunctionalAmount" : "functionalDebit",
      candidates: [
        {
          column: kind === "tb" ? "期末余额" : "借方金额",
          confidence: 0.94,
          conflictTerms: [],
        },
      ],
    },
  ],
  suggestedMapping: kind === "tb" ? DEPOSIT_TB_MAPPING : DEPOSIT_JE_MAPPING,
  roles: kind === "tb" ? DEPOSIT_TB_ROLES : DEPOSIT_JE_ROLES,
  entities: [COMPANY],
  accounts: kind === "tb" ? DEPOSIT_TB_ACCOUNTS : DEPOSIT_JE_ACCOUNTS,
  suggestedAccountRoles:
    kind === "tb"
      ? depositSuggestedRoles(DEPOSIT_TB_ACCOUNTS)
      : depositSuggestedRoles(DEPOSIT_JE_ACCOUNTS),
  suggestedAccountTiers:
    kind === "tb"
      ? depositSuggestedTiers(DEPOSIT_TB_ACCOUNTS)
      : depositSuggestedTiers(DEPOSIT_JE_ACCOUNTS),
  dataYears: DATA_YEARS,
  suggestedBalanceSheetDate: REPORT_END,
});

// ---------------------------------------------------------------------------
// 公共数据：汇兑损益工作簿（TB 带 币种 列 + 美元/港币账户）
// ---------------------------------------------------------------------------

const FX_TB_HEADERS = [
  "公司",
  "科目编码",
  "科目名称",
  "辅助核算",
  "币种",
  "期初方向",
  "期初余额",
  "期末方向",
  "期末余额",
  "本年累计借方",
  "本年累计贷方",
];

const FX_TB_ACCOUNTS = [
  "1001 库存现金-人民币",
  "1002010101 银行存款-汇丰银行（中国）有限公司上海分行-外币结算账户-美元",
  "1002030101 银行存款-中国银行股份有限公司深圳福田支行-外币结算账户-港币",
  "1002010201 银行存款-中国工商银行股份有限公司北京朝阳支行-基本存款账户-人民币",
  "1122010101 应收账款-境外客户-北美区域销售公司-出口货款-美元结算",
  "2202010101 应付账款-关联方-合并范围内全资子公司-直接采购-库存商品",
  "2202010102 应付账款-非关联方-境外设备供应商-进口设备合同尾款-美元计价",
  "2202020101 应付账款-关联方-香港全资子公司-代垫市场服务费-港币计价",
  "2241010101 其他应付款-境外中介机构-年度审计费与专业咨询费-港币",
  "6603010101 财务费用-汇兑损益-已实现汇兑损益",
  "6603010201 财务费用-汇兑损益-未实现汇兑损益",
  "1601010101 固定资产-电子设备-办公用",
];

const fxAccountRole = (account: string): string => {
  if (account.startsWith("660301")) return "fx_gain_loss";
  if (account.startsWith("1601")) return "non_monetary";
  if (account.startsWith("2202") || account.startsWith("2241")) return "monetary_liability";
  return "monetary_asset";
};

const fxAccountCurrency = (account: string): string => {
  if (account.includes("美元")) return "USD";
  if (account.includes("港币")) return "HKD";
  return "CNY";
};

const fxAccountRoleDetails = (accounts: string[]): Dict =>
  Object.fromEntries(
    accounts.map((account) => {
      const role = fxAccountRole(account);
      const needsConfirmation = account.startsWith("1122");
      const reason = needsConfirmation
        ? "编码 1122 属应收款项类，通常为货币性项目；是否与经营相关的非货币项目请复核。"
        : account.startsWith("660301")
          ? "编码 6603 且名称含「汇兑损益」，归入汇兑损益科目。"
          : `按科目编码 ${account.split(" ")[0]} 的首位段与名称词典归类。`;
      return [
        account,
        {
          role,
          confidence: needsConfirmation ? 0.62 : 0.95,
          needsConfirmation,
          reason,
          subtype: null,
        },
      ];
    }),
  );

const fxAccountCurrencyDetails = (accounts: string[]): Dict =>
  Object.fromEntries(
    accounts.map((account) => {
      const detected = fxAccountCurrency(account);
      // 应收账款一行故意不给币种列取值（列里是空），币种只出现在科目名里，
      // 让"科目文本"这条依据链路在演示里可见。
      const fromText = account.startsWith("1122");
      return [
        account,
        {
          detected: fromText ? "USD" : detected,
          source: fromText ? "科目文本" : detected === "" ? "" : "币种列",
          seen: fromText ? ["USD"] : [detected],
          needsConfirmation: fromText,
          columnSeen: fromText ? [] : [detected],
          columnDetected: fromText ? "" : detected,
          textDetected: fromText ? "USD" : detected,
          functionalDetected: "CNY",
        },
      ];
    }),
  );

const FX_TB_PREVIEW = [
  [COMPANY, "1001", "库存现金-人民币", "本部出纳", "CNY", "借", money(85600), "借", money(112800), money(1265000), money(1237800)],
  [COMPANY, "1002010101", "银行存款-汇丰银行（中国）有限公司上海分行-外币结算账户-美元", "汇丰外币户-8801", "USD", "借", money(1284000), "借", money(1452800), money(9625000), money(9456200)],
  [COMPANY, "1002030101", "银行存款-中国银行股份有限公司深圳福田支行-外币结算账户-港币", "中行港币户-2210", "HKD", "借", money(765300), "借", money(698400), money(5120600), money(5187500)],
  [COMPANY, "1002010201", "银行存款-中国工商银行股份有限公司北京朝阳支行-基本存款账户-人民币", "工行基本户-0200", "CNY", "借", money(4580000), "借", money(5236500), money(58210000), money(57574500)],
  [COMPANY, "1122010101", "应收账款-境外客户-北美区域销售公司-出口货款-美元结算", "北美销售", "", "借", money(3215000), "借", money(2874000), money(15230000), money(15574000)],
  [COMPANY, "2202010101", "应付账款-关联方-合并范围内全资子公司-直接采购-库存商品", "华远（香港）贸易", "USD", "贷", money(2150000), "贷", money(1876000), money(12480000), money(12722000)],
  [COMPANY, "2202020101", "应付账款-关联方-香港全资子公司-代垫市场服务费-港币计价", "香港子公司", "HKD", "贷", money(432600), "贷", money(398100), money(2154000), money(2189500)],
  [COMPANY, "6603010201", "财务费用-汇兑损益-未实现汇兑损益", "", "CNY", "贷", money(0), "贷", money(0), money(35600), money(98400)],
];

const FX_TB_ROLES = roleLabels([
  ["entity", "公司/核算主体"],
  ["accountCode", "科目编码"],
  ["accountName", "科目名称"],
  ["currency", "原币币种列"],
  ["currencyText", "币种线索文本"],
  ["auxiliary", "辅助核算"],
  ["functionalCurrency", "本位币币种"],
  ["openingDirection", "期初方向"],
  ["closingDirection", "期末方向"],
  ["openingFunctionalAmount", "期初本位币净额"],
  ["openingFunctionalDebit", "期初本位币借方"],
  ["openingFunctionalCredit", "期初本位币贷方"],
  ["openingForeignAmount", "期初原币净额"],
  ["closingFunctionalAmount", "期末本位币净额"],
  ["closingFunctionalDebit", "期末本位币借方"],
  ["closingFunctionalCredit", "期末本位币贷方"],
  ["closingForeignAmount", "期末原币净额"],
  ["ytdFunctionalDebit", "本年累计本位币借方"],
  ["ytdFunctionalCredit", "本年累计本位币贷方"],
  ["ytdForeignDebit", "本年累计原币借方"],
  ["ytdForeignCredit", "本年累计原币贷方"],
]);

const FX_TB_MAPPING: Dict = {
  entity: "公司",
  accountCode: "科目编码",
  accountName: "科目名称",
  auxiliary: "辅助核算",
  currency: "币种",
  openingFunctionalAmount: "期初余额",
  closingFunctionalAmount: "期末余额",
  ytdFunctionalDebit: "本年累计借方",
  ytdFunctionalCredit: "本年累计贷方",
};

const FX_JE_HEADERS = [
  "记账日期",
  "凭证类型",
  "凭证号",
  "公司",
  "科目编码",
  "科目名称",
  "辅助核算",
  "摘要",
  "原币币种",
  "本位币币种",
  "原币借方",
  "原币贷方",
  "本位币借方",
  "本位币贷方",
];

const FX_JE_ACCOUNTS = [
  "1002010101 银行存款-汇丰银行上海分行美元户",
  "1002030101 银行存款-中行深圳福田支行港币户",
  "1002010201 银行存款-工行基本户",
  "1122010101 应收账款-北美客户",
  "2202010101 应付账款-合并范围内子公司-美元",
  "2202020101 应付账款-香港子公司-港币",
  "2241010101 其他应付款-境外审计机构-港币",
  "6603010101 财务费用-汇兑损益",
];

const FX_JE_PREVIEW = [
  ["2025-01-08", "收", "0006", COMPANY, "1002010101", "银行存款-汇丰银行上海分行美元户", "汇丰外币户-8801", "收到北美客户出口货款", "USD", "CNY", money(186000), "", money(1341120), ""],
  ["2025-01-31", "记", "0112", COMPANY, "6603010101", "财务费用-汇兑损益", "", "月末外币账户按中间价重估", "CNY", "CNY", "", money(23500), "", money(23500)],
  ["2025-02-05", "付", "0021", COMPANY, "2202020101", "应付账款-香港子公司-港币", "香港子公司", "支付代垫市场服务费", "HKD", "CNY", "", money(85000), "", money(78540)],
  ["2025-03-20", "收", "0044", COMPANY, "1002030101", "银行存款-中行深圳福田支行港币户", "中行港币户-2210", "收到港币账户存款利息", "HKD", "CNY", money(9240), "", money(8530), ""],
  ["2025-06-30", "记", "0233", COMPANY, "6603010101", "财务费用-汇兑损益", "", "半年末外币项目重估", "CNY", "CNY", money(41200), "", money(41200), ""],
  ["2025-09-12", "付", "0157", COMPANY, "2241010101", "其他应付款-境外审计机构-港币", "境外审计", "支付年度审计费首期款", "HKD", "CNY", "", money(236000), "", money(217860)],
  ["2025-12-15", "收", "0288", COMPANY, "1002010201", "银行存款-工行基本户", "工行基本户-0200", "收到工行四季度存款利息", "CNY", "CNY", money(12458.3), "", money(12458.3), ""],
  ["2025-12-31", "记", "0301", COMPANY, "2202010101", "应付账款-合并范围内子公司-美元", "华远（香港）贸易", "年末应付账款重估", "USD", "CNY", "", money(86000), "", money(619430)],
];

const FX_JE_ROLES = roleLabels([
  ["id", "凭证识别字段"],
  ["voucherType", "凭证类型"],
  ["entity", "公司/核算主体"],
  ["date", "记账日期"],
  ["accountCode", "科目编码"],
  ["accountName", "科目名称"],
  ["currency", "原币币种"],
  ["functionalCurrency", "本位币币种"],
  ["summary", "摘要"],
  ["auxiliary", "辅助核算"],
  ["direction", "借贷方向（原币与本位币共用）"],
  ["foreignAmount", "原币净额"],
  ["foreignDebit", "原币借方"],
  ["foreignCredit", "原币贷方"],
  ["functionalAmount", "本位币净额"],
  ["functionalDebit", "本位币借方"],
  ["functionalCredit", "本位币贷方"],
]);

const FX_JE_MAPPING: Dict = {
  id: ["凭证类型", "凭证号"],
  voucherType: "凭证类型",
  entity: "公司",
  date: "记账日期",
  accountCode: "科目编码",
  accountName: "科目名称",
  auxiliary: "辅助核算",
  summary: "摘要",
  currency: "原币币种",
  functionalCurrency: "本位币币种",
  foreignDebit: "原币借方",
  foreignCredit: "原币贷方",
  functionalDebit: "本位币借方",
  functionalCredit: "本位币贷方",
};

const fxInspection = (kind: "tb" | "je") => ({
  kind,
  path: DEMO_PATH,
  sheet: kind === "tb" ? "TB" : "JE",
  sheets: ["TB", "JE", "附注-已弃用"],
  headerRow: 1,
  headerDepth: 1,
  headerDetection: { needsConfirmation: false, candidates: [{ row: 1, score: 0.97 }] },
  headers: kind === "tb" ? FX_TB_HEADERS : FX_JE_HEADERS,
  preview: kind === "tb" ? FX_TB_PREVIEW : FX_JE_PREVIEW,
  rowCount: kind === "tb" ? 96 : 640,
  mappingCandidates: [
    {
      role: kind === "tb" ? "currency" : "currency",
      candidates: [
        {
          column: kind === "tb" ? "币种" : "原币币种",
          confidence: 0.92,
          conflictTerms: [],
        },
      ],
    },
  ],
  suggestedMapping: kind === "tb" ? FX_TB_MAPPING : FX_JE_MAPPING,
  roles: kind === "tb" ? FX_TB_ROLES : FX_JE_ROLES,
  entities: [COMPANY],
  accounts: kind === "tb" ? FX_TB_ACCOUNTS : FX_JE_ACCOUNTS,
  accountRoleSuggestions:
    kind === "tb"
      ? Object.fromEntries(FX_TB_ACCOUNTS.map((account) => [account, fxAccountRole(account)]))
      : Object.fromEntries(FX_JE_ACCOUNTS.map((account) => [account, fxAccountRole(account)])),
  accountRoleDetails:
    kind === "tb" ? fxAccountRoleDetails(FX_TB_ACCOUNTS) : fxAccountRoleDetails(FX_JE_ACCOUNTS),
  accountCurrencyDetails:
    kind === "tb"
      ? fxAccountCurrencyDetails(FX_TB_ACCOUNTS)
      : fxAccountCurrencyDetails(FX_JE_ACCOUNTS),
  foreignCurrencyCandidates:
    kind === "tb"
      ? [{ column: "币种", confidence: 0.92, foreignCurrencies: ["USD", "HKD"] }]
      : [],
  foreignCurrencyNeedsConfirmation: false,
  uniformCurrency: null,
  sampledPreview: false,
  currencies: ["CNY", "USD", "HKD"],
  dataYears: DATA_YEARS,
  suggestedBalanceSheetDate: REPORT_END,
});

// ---------------------------------------------------------------------------
// 借款利息：完整台账 / 利率台账 / TB / JE
// ---------------------------------------------------------------------------

const LOAN_ROLES = roleLabels([
  ["principal", "本金"],
  ["openingPrincipal", "期初余额"],
  ["closingPrincipal", "期末余额"],
  ["startDate", "起始日"],
  ["endDate", "到期日"],
  ["term", "期限"],
  ["rate", "利率"],
  ["rateType", "利率类型"],
  ["drawdownAmount", "本期新增"],
  ["repaymentAmount", "本期归还"],
  ["loanId", "借款标识"],
  ["lender", "贷款方"],
  ["currency", "币种"],
  ["drawdownDate", "新增借款日期"],
  ["repaymentDate", "还款日期"],
  ["repaymentMethod", "还本方式"],
  ["loanStatus", "借款状态"],
  ["benchmarkRate", "基准利率"],
  ["spreadBps", "加/减点（BP）"],
  ["remark", "备注"],
]);

/** 台账四型（与 Rust `loan_forms` 同序：从弱到强 D/C/B/A）。 */
const LOAN_FORMS = [
  {
    id: "D",
    display: "台账-类型D",
    label: "期末余额＋期间发生额",
    anyOf: [["closingPrincipal", "principal"]],
    required: [["startDate"], ["rate"], ["drawdownAmount", "repaymentAmount"]],
    optional: [["rateType"], ["openingPrincipal"], ["endDate"], ["term"]],
  },
  {
    id: "C",
    display: "台账-类型C",
    label: "期初余额＋期间发生额",
    anyOf: [["openingPrincipal", "principal"]],
    required: [["startDate"], ["rate"], ["drawdownAmount", "repaymentAmount"]],
    optional: [["rateType"], ["closingPrincipal"], ["endDate"], ["term"]],
  },
  {
    id: "B",
    display: "台账-类型B",
    label: "起始日＋期限",
    anyOf: [["principal", "openingPrincipal"]],
    required: [["startDate"], ["term"], ["rate"]],
    optional: [["rateType"], ["endDate"], ["closingPrincipal"], ["repaymentAmount"], ["drawdownAmount"]],
  },
  {
    id: "A",
    display: "台账-类型A",
    label: "起始日＋到期日",
    anyOf: [["principal", "openingPrincipal"]],
    required: [["startDate"], ["endDate"], ["rate"]],
    optional: [["rateType"], ["term"], ["closingPrincipal"], ["repaymentAmount"], ["drawdownAmount"]],
  },
];

const LOAN_LEDGER_HEADERS = [
  "借款编号",
  "贷款方",
  "币种",
  "借款本金",
  "起始日",
  "到期日",
  "利率（%）",
  "利率类型",
  "加减点（BP）",
  "还本方式",
  "借款状态",
  "备注",
];

const LOAN_LEDGER_ROWS = [
  ["JK-2025-001", "中国工商银行股份有限公司北京朝阳支行", "CNY", money(20000000), "2025-01-15", "2026-01-14", "3.45", "固定", "", "到期一次还本", "存续", "流动资金借款"],
  ["JK-2025-002", "招商银行股份有限公司上海分行", "CNY", money(15000000), "2025-02-20", "2026-02-19", "LPR+90BP", "浮动", "90", "按季付息、到期还本", "存续", "挂钩一年期LPR"],
  ["JK-2025-003", "汇丰银行（中国）有限公司上海分行", "USD", money(2500000), "2025-03-10", "2025-12-10", "6.10", "固定", "", "到期一次还本", "存续", "外币流动资金借款"],
  ["JK-2025-004", "中国银行股份有限公司深圳市分行", "HKD", money(8000000), "2025-04-01", "2026-03-31", "HIBOR+120BP", "浮动", "120", "按月付息、到期还本", "存续", "港币流动资金"],
  ["JK-2025-005", "交通银行股份有限公司北京分行", "CNY", money(30000000), "2024-06-28", "2027-06-27", "4.25", "固定", "", "按季付息、到期还本", "存续", "并购贷款"],
  ["JK-2025-006", "国家开发银行北京市分行", "CNY", money(50000000), "2025-05-15", "2028-05-14", "3.85", "固定", "", "按半年付息", "存续", "设备更新专项贷款"],
  ["JK-2025-007", "北京农村商业银行股份有限公司朝阳支行", "CNY", money(5000000), "2025-07-01", "", "", "浮动", "", "按月付息", "存续", "利率待定价，走利率台账"],
  ["JK-2025-008", "三井住友银行（中国）有限公司", "JPY", money(300000000), "2025-08-20", "2026-02-19", "2.10", "固定", "", "到期一次还本", "存续", "进口设备配套融资"],
  ["JK-2025-009", "中国建设银行股份有限公司北京朝阳支行", "CNY", money(12000000), "2025-09-01", "2026-08-31", "3.60", "固定", "", "按月付息、到期还本", "已结清", "2026年8月提前结清"],
  ["JK-2025-010", "渣打银行（中国）有限公司北京分行", "USD", money(1200000), "2025-10-15", "2026-10-14", "SOFR+85BP", "浮动", "85", "按季付息、到期还本", "存续", "美元浮息借款"],
];

const LOAN_LEDGER_MAPPING: Record<string, string> = {
  loanId: "借款编号",
  lender: "贷款方",
  currency: "币种",
  principal: "借款本金",
  startDate: "起始日",
  endDate: "到期日",
  rate: "利率（%）",
  rateType: "利率类型",
  spreadBps: "加减点（BP）",
  repaymentMethod: "还本方式",
  loanStatus: "借款状态",
  remark: "备注",
};

const LOAN_RATE_HEADERS = [
  "借款编号",
  "贷款方",
  "利率（%）",
  "利率类型",
  "加减点（BP）",
  "基准利率（%）",
  "备注",
];

const LOAN_RATE_ROWS = [
  ["JK-2025-001", "中国工商银行股份有限公司北京朝阳支行", "3.45", "固定", "", "3.10", "合同约定固定利率"],
  ["JK-2025-002", "招商银行股份有限公司上海分行", "LPR+90BP", "浮动", "90", "3.10", "季度重定价"],
  ["JK-2025-003", "汇丰银行（中国）有限公司上海分行", "6.10", "固定", "", "5.20", "美元固定"],
  ["JK-2025-004", "中国银行股份有限公司深圳市分行", "HIBOR+120BP", "浮动", "120", "4.35", "港币浮息"],
  ["JK-2025-005", "交通银行股份有限公司北京分行", "4.25", "固定", "", "3.85", "并购贷款"],
  ["JK-2025-006", "国家开发银行北京市分行", "3.85", "固定", "", "3.20", "专项贷款"],
  ["JK-2025-007", "北京农村商业银行股份有限公司朝阳支行", "3.90", "固定", "", "3.10", "利率以补充协议为准"],
  ["JK-2025-008", "三井住友银行（中国）有限公司", "2.10", "固定", "", "1.80", "日元固定"],
  ["JK-2025-009", "中国建设银行股份有限公司北京朝阳支行", "3.60", "固定", "", "3.10", "结清前利率"],
  ["JK-2025-010", "渣打银行（中国）有限公司北京分行", "SOFR+85BP", "浮动", "85", "4.60", "美元浮息"],
];

const LOAN_TB_HEADERS = [
  "公司",
  "科目编码",
  "科目名称",
  "借款明细/辅助核算",
  "币种",
  "期初方向",
  "期初余额",
  "期末方向",
  "期末余额",
  "本年累计借方",
  "本年累计贷方",
];

const LOAN_TB_ROWS = [
  [COMPANY, "2201", "短期借款", "工行流动资金借款", "CNY", "贷", money(18000000), "贷", money(20000000), money(2000000), money(4000000)],
  [COMPANY, "2201", "短期借款", "招行流动资金借款", "CNY", "贷", money(15000000), "贷", money(15000000), money(15000000), money(15000000)],
  [COMPANY, "2201", "短期借款", "汇丰美元借款", "USD", "贷", money(1780000), "贷", money(1765000), money(1780000), money(1765000)],
  [COMPANY, "2501", "长期借款-中国工商银行股份有限公司北京朝阳支行-固定资产贷款-人民币", "工行固资贷款", "CNY", "贷", money(24600000), "贷", money(23400000), money(1200000), money(0)],
  [COMPANY, "2501", "长期借款-国家开发银行北京市分行-设备更新专项贷款-人民币", "国开行专项", "CNY", "贷", money(50000000), "贷", money(50000000), money(0), money(0)],
  [COMPANY, "2501", "长期借款-关联方借款-华远控股集团有限公司-统借统还-人民币", "集团统借统还", "CNY", "贷", money(12000000), "贷", money(12000000), money(0), money(0)],
  [COMPANY, "2241", "其他流动负债-一年内到期的长期借款", "一年内到期", "CNY", "贷", money(12000000), "贷", money(13000000), money(13000000), money(14000000)],
  [COMPANY, "6603010201", "财务费用-利息支出-借款利息", "", "CNY", "平", money(0), "平", money(0), money(650000), money(0)],
];

const LOAN_TB_MAPPING: Record<string, string> = {
  entity: "公司",
  accountCode: "科目编码",
  accountName: "科目名称",
  loanId: "借款明细/辅助核算",
  currency: "币种",
  openingFunctionalAmount: "期初余额",
  closingFunctionalAmount: "期末余额",
  ytdFunctionalDebit: "本年累计借方",
  ytdFunctionalCredit: "本年累计贷方",
};

const LOAN_JE_HEADERS = [
  "记账日期",
  "凭证类型",
  "凭证号",
  "公司",
  "科目编码",
  "科目名称",
  "借款明细/辅助核算",
  "摘要",
  "借方金额",
  "贷方金额",
];

const LOAN_JE_ROWS = [
  ["2025-01-15", "记", "0012", COMPANY, "2201", "短期借款", "工行流动资金借款", "借入工行流动资金借款", "", money(4000000)],
  ["2025-01-15", "记", "0012", COMPANY, "1002010101", "银行存款-工行基本户", "工行基本户-0200", "借入工行流动资金借款", money(4000000), ""],
  ["2025-03-21", "付", "0034", COMPANY, "2201", "短期借款", "招行流动资金借款", "归还招行到期本金", money(15000000), ""],
  ["2025-03-21", "记", "0035", COMPANY, "2201", "短期借款", "招行流动资金借款", "续借招行流动资金借款", "", money(15000000)],
  ["2025-06-30", "付", "0102", COMPANY, "6603010201", "财务费用-利息支出-借款利息", "", "支付二季度借款利息", money(186300), ""],
  ["2025-09-30", "付", "0219", COMPANY, "6603010201", "财务费用-利息支出-借款利息", "", "支付三季度借款利息", money(174500), ""],
  ["2025-12-31", "计", "0310", COMPANY, "6603010201", "财务费用-利息支出-借款利息", "", "计提四季度借款利息", money(168200), ""],
  ["2025-12-31", "计", "0311", COMPANY, "2241", "其他流动负债-一年内到期的长期借款", "一年内到期", "计提应付借款利息", "", money(168200)],
];

const LOAN_JE_MAPPING: Record<string, string> = {
  date: "记账日期",
  id: "凭证号",
  accountCode: "科目编码",
  accountName: "科目名称",
  loanId: "借款明细/辅助核算",
  summary: "摘要",
  functionalDebit: "借方金额",
  functionalCredit: "贷方金额",
};

const loanInspection = (kind: string) => {
  if (kind === "tb") {
    return {
      headers: LOAN_TB_HEADERS,
      preview: LOAN_TB_ROWS,
      rowCount: 132,
      sheet: "TB科目余额表",
      sheets: ["TB科目余额表", "银行存款序时账", "填表说明"],
      headerRow: 1,
      headerDepth: 1,
      suggestedMapping: LOAN_TB_MAPPING,
    };
  }
  if (kind === "je") {
    return {
      headers: LOAN_JE_HEADERS,
      preview: LOAN_JE_ROWS,
      rowCount: 864,
      sheet: "银行存款序时账",
      sheets: ["TB科目余额表", "银行存款序时账", "填表说明"],
      headerRow: 1,
      headerDepth: 1,
      suggestedMapping: LOAN_JE_MAPPING,
    };
  }
  if (kind === "rateLedger") {
    return {
      headers: LOAN_RATE_HEADERS,
      preview: LOAN_RATE_ROWS,
      rowCount: 24,
      sheet: "利率台账",
      sheets: ["利率台账"],
      headerRow: 1,
      headerDepth: 1,
      suggestedMapping: {
        loanId: "借款编号",
        lender: "贷款方",
        rate: "利率（%）",
        rateType: "利率类型",
        spreadBps: "加减点（BP）",
        benchmarkRate: "基准利率（%）",
        remark: "备注",
      },
      roles: LOAN_ROLES,
    };
  }
  return {
    headers: LOAN_LEDGER_HEADERS,
    preview: LOAN_LEDGER_ROWS,
    rowCount: 24,
    sheet: "借款台账",
    sheets: ["借款台账"],
    headerRow: 1,
    headerDepth: 1,
    suggestedMapping: LOAN_LEDGER_MAPPING,
    roles: LOAN_ROLES,
    forms: LOAN_FORMS,
  };
};

// ---------------------------------------------------------------------------
// ledger.forms：TB 六型 / JE 三型 / 台账四型（与 Rust `forms()` 同序同槽）
// ---------------------------------------------------------------------------

const ledgerFormCatalog = (kind: string) => {
  if (kind === "loan") return LOAN_FORMS;
  if (kind === "je") {
    // 从弱到强：JE3（净额）→ JE2（方向＋净额）→ JE1（借贷分列）。
    return [
      {
        id: "JE3",
        display: "JE-类型C",
        label: "本位币净额（借正贷负）",
        anyOf: [] as string[][],
        required: [["functionalAmount"]],
        optional: [["foreignAmount"]],
      },
      {
        id: "JE2",
        display: "JE-类型B",
        label: "方向＋本位币净额",
        anyOf: [] as string[][],
        required: [["direction", "functionalAmount"]],
        optional: [["foreignAmount"]],
      },
      {
        id: "JE1",
        display: "JE-类型A",
        label: "本位币借贷分列",
        anyOf: [] as string[][],
        required: [["functionalDebit", "functionalCredit"]],
        optional: [["foreignDebit", "foreignCredit"]],
      },
    ];
  }
  // TB 六型：方向形态（净额/方向/借贷分列）× 是否带原币。
  const ytdF = ["ytdFunctionalDebit", "ytdFunctionalCredit"];
  const ytdX = ["ytdForeignDebit", "ytdForeignCredit"];
  return [
    {
      id: "TB1", display: "TB-类型A", label: "本位币净额", anyOf: [] as string[][],
      required: [["openingFunctionalAmount"], ["closingFunctionalAmount"], ytdF],
      optional: [ytdX],
    },
    {
      id: "TB2", display: "TB-类型B", label: "方向＋本位币净额", anyOf: [] as string[][],
      required: [["openingDirection", "openingFunctionalAmount"], ["closingDirection", "closingFunctionalAmount"], ytdF],
      optional: [ytdX],
    },
    {
      id: "TB3", display: "TB-类型C", label: "本位币借贷分列", anyOf: [] as string[][],
      required: [["openingFunctionalDebit", "openingFunctionalCredit"], ["closingFunctionalDebit", "closingFunctionalCredit"], ytdF],
      optional: [ytdX],
    },
    {
      id: "TB4", display: "TB-类型D", label: "本位币净额＋原币净额", anyOf: [] as string[][],
      required: [["openingFunctionalAmount", "openingForeignAmount"], ["closingFunctionalAmount", "closingForeignAmount"], ytdF],
      optional: [ytdX],
    },
    {
      id: "TB5", display: "TB-类型E", label: "方向＋本位币净额＋原币净额", anyOf: [] as string[][],
      required: [
        ["openingDirection", "openingFunctionalAmount", "openingForeignAmount"],
        ["closingDirection", "closingFunctionalAmount", "closingForeignAmount"],
        ytdF,
      ],
      optional: [ytdX],
    },
    {
      id: "TB6", display: "TB-类型F", label: "本位币与原币双借贷分列", anyOf: [] as string[][],
      required: [
        ["openingFunctionalDebit", "openingFunctionalCredit", "openingForeignDebit", "openingForeignCredit"],
        ["closingFunctionalDebit", "closingFunctionalCredit", "closingForeignDebit", "closingForeignCredit"],
        ytdF,
      ],
      optional: [ytdX],
    },
  ];
};

// ---------------------------------------------------------------------------
// deposit.rate_tiers：存款利率档位（数值与口径对齐 Rust RATE_TIERS）
// ---------------------------------------------------------------------------

const tier = (
  key: string,
  category: string,
  categoryLabel: string,
  termLabel: string,
  benchmarkRate: number | null,
  listedRate: number | null,
  autoApply: boolean,
  practiceLow: number | null,
  practiceHigh: number | null,
  practiceNote: string,
) => ({
  key,
  category,
  categoryLabel,
  termLabel,
  label: termLabel ? `${categoryLabel}（${termLabel}）` : categoryLabel,
  benchmarkRate,
  listedRate,
  autoApply,
  practiceLow,
  practiceHigh,
  practiceNote,
});

const DEPOSIT_RATE_TIERS = {
  benchmarkDate: "2015-10-24",
  listedDate: "2025-05-20",
  benchmarkSource:
    "中国人民银行《金融机构人民币存款基准利率调整表》，2015-10-24 起执行，至今未再调整。仅作合理性上限参照，不参与测算。",
  listedSource:
    "各大商业银行 2025-05-20 公布的人民币存款挂牌利率；实际执行利率以存款协议为准。",
  practiceSource: "实务区间是常见报价范围的经验值，不是官方公布数据，仅用来提示填入的利率是否明显离谱。",
  authority: "以上三组都只是默认值和合理性参照。审计依据应当是客户的存款协议、银行对账单或银行出具的利息清单。",
  autoApplyPolicy:
    "只有活期自动套用默认利率——对公活期没有议价空间。协定、通知、定期、大额存单的利率逐笔合同约定，默认留空，须填入实际利率后才计入测算。",
  links: [
    { label: "中国人民银行", url: "http://www.pbc.gov.cn/", hint: "「货币政策」—「货币政策工具」—利率政策，可查《金融机构人民币存款基准利率调整表》", group: "official" },
    { label: "中国货币网（全国银行间同业拆借中心）", url: "https://www.chinamoney.com.cn/", hint: "市场利率定价自律机制的存款利率相关公告发布渠道", group: "official" },
    { label: "国家外汇管理局", url: "https://www.safe.gov.cn/", hint: "外币存款相关政策与人民币汇率中间价查询", group: "official" },
    { label: "中国工商银行", url: "https://www.icbc.com.cn/", hint: "首页搜索「人民币存款利率」查当前挂牌利率表", group: "bank" },
    { label: "中国建设银行", url: "http://www.ccb.com/", hint: "首页搜索「人民币存款利率」查当前挂牌利率表", group: "bank" },
    { label: "中国农业银行", url: "https://www.abchina.com/", hint: "首页搜索「人民币存款利率」查当前挂牌利率表", group: "bank" },
    { label: "中国银行", url: "https://www.boc.cn/", hint: "首页搜索「人民币存款利率」查当前挂牌利率表", group: "bank" },
  ],
  linkGroups: [
    { key: "official", label: "官方发布渠道", hint: "基准利率与政策公告的权威出处，可直接作为底稿引用来源。" },
    { key: "bank", label: "各行挂牌利率表", hint: "实际计息利率的参照；最终仍应以客户的存款协议或银行对账单为准。" },
  ],
  listedRateDate: "2025-05-20",
  rateAgeMonths: 16,
  ratesStale: true,
  staleMessage:
    "挂牌利率基准日期为 2025-05-20，距今已超过 12 个月；期间银行可能下调挂牌利率，测算前请到官方渠道核对最新挂牌利率。",
  categories: [
    { key: "demand", label: "活期存款", terms: [{ key: "demand", label: "" }] },
    { key: "agreement", label: "协定存款", terms: [{ key: "agreement", label: "" }] },
    {
      key: "notice",
      label: "通知存款",
      terms: [
        { key: "notice_1d", label: "1天" },
        { key: "notice_7d", label: "7天" },
      ],
    },
    {
      key: "term",
      label: "定期存款",
      terms: [
        { key: "term_3m", label: "3个月" },
        { key: "term_6m", label: "6个月" },
        { key: "term_1y", label: "1年" },
        { key: "term_2y", label: "2年" },
        { key: "term_3y", label: "3年" },
        { key: "term_5y", label: "5年" },
      ],
    },
    {
      key: "large_cd",
      label: "大额存单",
      terms: [
        { key: "cd_1y", label: "1年" },
        { key: "cd_2y", label: "2年" },
        { key: "cd_3y", label: "3年" },
      ],
    },
    { key: "custom", label: "自定义（按存款协议）", terms: [{ key: "custom", label: "" }] },
  ],
  tiers: [
    tier("demand", "demand", "活期存款", "", 0.0035, 0.0005, true, 0.0005, 0.0035,
      "对公活期几乎没有议价空间，国有大行普遍就是挂牌 0.05%；老协议里仍挂 0.35% 的情况也见得到。这是唯一自动套用默认利率的档位。"),
    tier("agreement", "agreement", "协定存款", "", 0.0115, 0.002, false, 0.002, 0.015,
      "挂牌与实际差最大的一档。超出约定留存额的部分按协定利率计息，大客户议价后普遍高于挂牌，务必看协议。"),
    tier("notice_1d", "notice", "通知存款", "1天", 0.008, 0.001, false, 0.001, 0.0045,
      "2024 年 5 月起银行下调通知存款利率并取消自律上限加点，实际水平明显低于央行基准。"),
    tier("notice_7d", "notice", "通知存款", "7天", 0.0135, 0.0055, false, 0.0055, 0.01,
      "企业闲置资金最常用的一档；股份制银行和城商行通常高于国有大行。"),
    tier("term_3m", "term", "定期存款", "3个月", 0.011, 0.0065, false, 0.0065, 0.011,
      "股份制银行、城商行普遍在大行挂牌上加 20~40BP。"),
    tier("term_6m", "term", "定期存款", "6个月", 0.013, 0.0085, false, 0.0085, 0.013,
      "股份制银行、城商行普遍在大行挂牌上加 20~40BP。"),
    tier("term_1y", "term", "定期存款", "1年", 0.015, 0.0095, false, 0.0095, 0.015,
      "最常见的企业定存期限；中小银行 1 年期做到 1.3%~1.5% 并不少见。"),
    tier("term_2y", "term", "定期存款", "2年", 0.021, 0.0105, false, 0.0105, 0.016,
      "期限越长，挂牌与中小银行报价的差距越大。"),
    tier("term_3y", "term", "定期存款", "3年", 0.0275, 0.0125, false, 0.0125, 0.019,
      "央行基准 2.75% 已严重脱离实际，只能当上限参照；拿它测算会把利息放大一倍以上。"),
    tier("term_5y", "term", "定期存款", "5年", null, 0.013, false, 0.013, 0.02,
      "央行从未公布 5 年期存款基准；部分银行 5 年期报价甚至低于 3 年期。"),
    tier("cd_1y", "large_cd", "大额存单", "1年", null, 0.011, false, 0.01, 0.014,
      "大额存单通常比同期定存高 10~25BP，按 20 万/100 万/1000 万起存分档，起存越高利率越高。"),
    tier("cd_2y", "large_cd", "大额存单", "2年", null, 0.012, false, 0.011, 0.0155,
      "大额存单通常比同期定存高 10~25BP。"),
    tier("cd_3y", "large_cd", "大额存单", "3年", null, 0.014, false, 0.013, 0.0185,
      "部分国有大行已阶段性停发 3 年期大额存单，若账上有则多为往年存续单。"),
    tier("custom", "custom", "自定义（按存款协议）", "", null, null, false, null, null,
      "没有公开档位可参照，按存款协议利率测算，底稿中注明协议出处。"),
  ],
};

// ---------------------------------------------------------------------------
// 工作簿与处理器注册表
// ---------------------------------------------------------------------------

const MONEY_SHEETS = ["TB科目余额表", "银行存款序时账", "填表说明"];
const MONEY_SPECS: Record<string, SheetSpec> = {
  TB科目余额表: {
    sheet: "TB科目余额表",
    kind: "tb",
    jeScore: 1,
    tbScore: 11,
    reasons: ["表头含期初余额/期末余额/本年累计借方", "无凭证号与记账日期列"],
    headers: DEPOSIT_TB_HEADERS,
    preview: DEPOSIT_TB_PREVIEW,
  },
  银行存款序时账: {
    sheet: "银行存款序时账",
    kind: "je",
    jeScore: 12,
    tbScore: 1,
    reasons: ["表头含记账日期/凭证号/摘要/借贷金额", "行数多且日期连续"],
    headers: DEPOSIT_JE_HEADERS,
    preview: DEPOSIT_JE_PREVIEW,
  },
  填表说明: {
    sheet: "填表说明",
    kind: "tb",
    jeScore: 2,
    tbScore: 3,
    reasons: ["无典型账表表头，只有文字说明"],
    headers: ["项目", "说明"],
    preview: [
      ["编制单位", COMPANY],
      ["会计期间", "2025年1月1日至2025年12月31日"],
      ["金额单位", "人民币元"],
    ],
  },
};

const FX_SHEETS = ["TB", "JE", "附注-已弃用"];
const FX_SPECS: Record<string, SheetSpec> = {
  TB: {
    sheet: "TB",
    kind: "tb",
    jeScore: 1,
    tbScore: 10,
    reasons: ["表头含期初/期末余额与本年累计借贷方", "带原币币种列"],
    headers: FX_TB_HEADERS,
    preview: FX_TB_PREVIEW,
  },
  JE: {
    sheet: "JE",
    kind: "je",
    jeScore: 13,
    tbScore: 0,
    reasons: ["表头含凭证类型/凭证号/记账日期/借贷金额"],
    headers: FX_JE_HEADERS,
    preview: FX_JE_PREVIEW,
  },
  "附注-已弃用": {
    sheet: "附注-已弃用",
    kind: "tb",
    jeScore: 1,
    tbScore: 2,
    reasons: ["旧版附注表，列名与账表内核不匹配"],
    headers: ["附注项", "内容"],
    preview: [["外币折算方法", "交易发生日即期汇率折算；期末按中间价重估"]],
  },
};

export const handlers: Record<string, (params: Record<string, unknown>) => unknown> = {
  // —— 存款利息收入测算 ——
  "deposit.rate_tiers": () => DEPOSIT_RATE_TIERS,
  "deposit.classify_source": (params) => classify(MONEY_SHEETS, MONEY_SPECS, params),
  "deposit.classify_source_llm": (params) => ({ kind: scriptKind(params) }),
  "deposit.inspect_je": () => depositInspection("je"),
  "deposit.inspect_tb": () => depositInspection("tb"),

  // —— 汇兑损益测算 ——
  "fx.classify_source": (params) => classify(FX_SHEETS, FX_SPECS, params),
  "fx.classify_source_llm": (params) => ({ kind: scriptKind(params) }),
  "fx.inspect_je": () => fxInspection("je"),
  "fx.inspect_tb": () => fxInspection("tb"),

  // —— 借款利息测算 ——
  "loan.inspect": (params) =>
    loanInspection(typeof params.kind === "string" ? params.kind : "ledger"),

  // —— 公共账表引擎（三个工具共用） ——
  "ledger.forms": (params) =>
    ledgerFormCatalog(typeof params.kind === "string" ? params.kind : "tb"),
  "ledger.review_mapping": () => ({ changes: [] }),
  "ledger.review_pair_mapping": () => ({ tbChanges: [], jeChanges: [], pairFindings: [] }),
  "ledger.check_mapping_alignment": () => ({
    aligned: true,
    errors: [],
    warnings: [
      "TB 的「币种」列同时出现 CNY/USD/HKD：人民币科目请确认币种取值为 CNY，外币科目按该列币种重估。",
    ],
    fix: null,
  }),
};
