import { describe, expect, it } from "vitest";
import {
  depositAccountReviewRows,
  depositAccountCode, mergeAccountList,
  depositAutoRate, depositDropTargetInside, depositEffectiveTierRate, depositFirstTierOf,
  depositMissingRequired, depositMissingDetails, depositMonthlyAverage, depositMonthlyInterest, depositRateAboveBenchmark,
  depositPercentToRate, depositRateOutOfPractice, depositRateToPercent, depositReportStart,
  depositTermsOf, depositJeLayout, JE_LAYOUT_LABEL,
  depositBalanceCheckStatus, depositRateCheckStatus,
  depositDisplayAmount,
  depositAccountOverrideKey, depositConfirmationImport,
} from "./DepositInterestPage";
import { DEFAULT_ENTITY, ledgerEntitiesByAccount } from "./ledgerMapping";

describe("存款第二步主体拆行", () => {
  it("源行按主体、科目名称、有效辅助项和币种保留独立身份", () => {
    const accounts = ["1002 银行存款", "1002 其他存款"];
    const identities = [
      { entity: "甲", account: accounts[0], auxiliary: "", currency: "CNY" },
      { entity: "乙", account: accounts[0], auxiliary: "", currency: "CNY" },
      { entity: "甲", account: accounts[1], auxiliary: "", currency: "CNY" },
      { entity: "甲", account: accounts[0], auxiliary: "", currency: "USD" },
    ];
    const rows = depositAccountReviewRows(accounts, null,
      new Map([[accounts[0], ["甲", "乙"]], [accounts[1], ["甲"]]]), identities);
    expect(rows).toHaveLength(4);
    expect(new Set(rows.map((row) => row.key)).size).toBe(4);
  });
  const combos = [
    { entity: "2000", account: "100201 银行存款" },
    { entity: "2002", account: "100201 银行存款" },
    { entity: "2000", account: "660301 财务费用-利息收入" },
  ];
  const byAccount = ledgerEntitiesByAccount(combos, depositAccountCode);

  it("多主体账套按主体×科目拆行，各行带主体", () => {
    expect(depositAccountReviewRows(["100201 银行存款"], null, byAccount)).toEqual([
      { key: "2000\u001f100201 银行存款", account: "100201 银行存款", entity: "2000" },
      { key: "2002\u001f100201 银行存款", account: "100201 银行存款", entity: "2002" },
    ]);
  });
  it("仅单主体出现的科目只出一行且标注该主体", () => {
    expect(depositAccountReviewRows(["660301 财务费用-利息收入"], null, byAccount)).toEqual([
      { key: "2000\u001f660301 财务费用-利息收入", account: "660301 财务费用-利息收入", entity: "2000" },
    ]);
  });
  it("组合缺失或只有默认主体时维持一科一行", () => {
    expect(depositAccountReviewRows(["100201 银行存款"], null, null)).toEqual([
      { key: "100201 银行存款", account: "100201 银行存款" },
    ]);
    const single = ledgerEntitiesByAccount(
      [{ entity: DEFAULT_ENTITY, account: "100201 银行存款" }],
      depositAccountCode,
    );
    expect(depositAccountReviewRows(["100201 银行存款"], null, single)).toEqual([
      { key: "100201 银行存款", account: "100201 银行存款" },
    ]);
  });
  it("已验证辅助的主体不再补科目兜底行，未验证的主体补兜底", () => {
    const link = {
      tbAuxMapped: true, status: "verified", column: "账户", anchorHits: 1, anchorTotal: 1,
      coverage: 1, competingColumns: [], warnings: [],
      groups: [
        { entity: "2000", account: "100201", reviewVerified: true,
          details: [{ key: "a银行", display: "A银行" }], tbAuxMapped: true,
          status: "verified", column: "账户", anchorHits: 1, anchorTotal: 1,
          coverage: 1, competingColumns: [], warnings: [] },
      ],
    } as Parameters<typeof depositAccountReviewRows>[1];
    const rows = depositAccountReviewRows(["100201 银行存款"], link, byAccount);
    expect(rows.filter((row) => row.auxiliaryKey).map((row) => row.entity)).toEqual(["2000"]);
    expect(rows.filter((row) => !row.auxiliaryKey).map((row) => row.entity)).toEqual(["2002"]);
  });
});

describe("存款余额勾稽与利率状态分别显示", () => {
  it("第二步发生额保留红字方向并使用千分位", () => {
    expect(depositDisplayAmount(-923800.5)).toBe("-923,800.5");
    expect(depositDisplayAmount(null)).toBe("—");
  });
  it("差异为零但使用暂估利率时仍显示已勾稽", () => {
    expect(depositBalanceCheckStatus({ jeReconciled: true, reconciliationDiff: -0.00001 })).toBe("已勾稽");
    expect(depositBalanceCheckStatus({ jeReconciled: true, reconciliationDiff: 0.006 })).toBe("待复核");
    expect(depositRateCheckStatus({ rateResolved: true, rateSource: "市场中枢暂估值（待确认）", status: "待确认利率" })).toBe("待确认利率");
  });

  it("来源文案统一后，是否待确认只看标记位不看文案", () => {
    expect(depositRateCheckStatus({ rateResolved: true, rateSource: "市场中枢暂估值", rateProvisional: true, status: "已勾稽" })).toBe("待确认利率");
    expect(depositRateCheckStatus({ rateResolved: true, rateSource: "市场中枢暂估值", rateProvisional: false, status: "已勾稽" })).toBe("已填利率");
  });

  it("两点法的零差异不冒充 JE 勾稽，余额差异不被利率状态掩盖", () => {
    expect(depositBalanceCheckStatus({ jeReconciled: false, reconciliationDiff: 0 })).toBe("未做JE核对");
    expect(depositBalanceCheckStatus({ jeReconciled: true, reconciliationDiff: 10 })).toBe("待复核");
    expect(depositRateCheckStatus({ rateResolved: false, rateSource: "", status: "待填利率" })).toBe("待填利率");
  });
});

describe("存款第二步辅助明细", () => {
  it("仅完整验证成功的主体科目组展开", () => {
    const result = depositAccountReviewRows(["100201 银行存款"], {
      tbAuxMapped: true, status: "partialCoverage", column: "银行账户", anchorHits: 1,
      anchorTotal: 2, coverage: 0.5, competingColumns: [], warnings: [],
      groups: [
        { entity: "甲", account: "100201", reviewVerified: true,
          details: [{ key: "a银行", display: "A银行" }], tbAuxMapped: true,
          status: "verified", column: "银行账户", anchorHits: 1, anchorTotal: 1,
          coverage: 1, competingColumns: [], warnings: [] },
        { entity: "乙", account: "100201", reviewVerified: false, details: [], tbAuxMapped: true,
          status: "noMatch", column: null, anchorHits: 0, anchorTotal: 1,
          coverage: 0, competingColumns: [], warnings: [] },
      ],
    });
    expect(result.map((row) => row.auxiliary ?? "末级")).toEqual(["A银行", "末级"]);
  });
});

describe("deposit account list merge", () => {
  it("同编码异名按真实主体组合列示，不复制辅助验证组", () => {
    const accounts = ["6711.03 制造部", "6711.03 销售部"];
    const entities = new Map([
      [accounts[0], ["甲公司"]],
      [accounts[1], ["乙公司"]],
    ]);
    const rows = depositAccountReviewRows(accounts, null, entities);
    expect(rows.map((row) => [row.entity, row.account])).toEqual([
      ["甲公司", accounts[0]], ["乙公司", accounts[1]],
    ]);
  });

  it("清单只来自 TB：同科目编码去重，保留 TB 首见写法", () => {
    expect(
      mergeAccountList(["66030002 利息", "利息 66030002", "1002 银行存款"]),
    ).toEqual(["66030002 利息", "1002 银行存款"]);
  });
  it("提码只认足位数的数字 token，纯名称不拆", () => {
    expect(depositAccountCode("66030002 财务费用-利息收入")).toBe("66030002");
    expect(depositAccountCode("银行存款")).toBe("银行存款");
    expect(depositAccountCode("1002.01 招商银行")).toBe("1002.01");
  });
});

describe("deposit interest upload and mapping parity", () => {
  it("shows missing TB mappings until a closing balance scheme exists", () => {
    expect(depositMissingRequired("tb", {})).toEqual(["科目编码／科目名称（任一）", "期末余额方案"]);
    expect(depositMissingRequired("tb", {accountCode: "科目编码", accountName: "科目名称", openingFunctionalDebit: "年初借方", closingFunctionalAmount: "期末余额"})).toEqual([]);
    expect(depositMissingRequired("tb", {accountName: "科目名称", openingFunctionalDebit: "年初借方", closingFunctionalAmount: "期末余额"})).toEqual([]);
    // 历史保存的映射把编码与名称混在一个 account 里，仍然要能读。
    expect(depositMissingRequired("tb", {account: ["科目编码"], openingFunctionalDebit: "年初借方", closingFunctionalAmount: "期末余额"})).toEqual([]);
  });
  it("把存款金额方案展开为可选的具体列", () => {
    expect(depositMissingDetails("tb", {})).toContain(
      "期末余额方案（期末本位币净额、借方或贷方，任选一列）",
    );
    expect(depositMissingDetails("je", {})).toContain(
      "发生额方案（本位币净额、借方或贷方，任选一列）",
    );
  });
  it("opening balance is optional regardless of journal (missing treated as zero)", () => {
    // SAP 的 Trial Balance LC/GC 只有 MTD/YTD，没有年初余额列：
    // 有序时账按「期末 − 期间发生额」倒推，无序时账依据按 0 参与全年平均。
    const sap = {accountCode: "GL Account", accountName: "GL Description", closingFunctionalAmount: "YTD Act (Local Curr)"};
    expect(depositMissingRequired("tb", sap)).toEqual([]);
    expect(depositMissingRequired("tb", sap, true)).toEqual([]);
  });
  it("only requires a period and amount scheme for the optional journal", () => {
    expect(depositMissingRequired("je", {})).toEqual(["记账日期", "凭证识别字段", "科目编码／科目名称（任一）", "发生额方案"]);
    expect(depositMissingRequired("je", {accountCode: "科目", accountName: "科目名称", id: "凭证号", summary: "摘要", date: "记账日期", functionalDebit: "借方金额"})).toEqual([]);
    expect(depositMissingRequired("je", {accountName: "科目名称", id: "凭证号", date: "记账日期", functionalDebit: "借方金额"})).toEqual([]);
    expect(depositMissingRequired("je", {accountCode: "G/L Account", accountName: "GL Description", id: "Document Number", summary: "Text", date: "Posting Date", functionalAmount: "Company Code Currency Value"})).toEqual([]);
    // 序时账只映射会计期间不再放行——后端一直硬性要求日期列，
    // 旧版在这里放过去，用户点下测算才撞上「尚未映射记账日期」。
    expect(depositMissingRequired("je", {accountCode: "G/L Account", accountName: "GL Description", id: "Document Number", summary: "Text", period: "Fiscal year/period", functionalAmount: "值"})).toEqual(["记账日期"]);
  });
  it("derives the audit year start from the balance sheet date", () => {
    expect(depositReportStart("2025-12-31")).toBe("2025-01-01");
    expect(depositReportStart("")).toBe("");
  });
  it("routes native drops by the upload box rectangle", () => {
    const rect = {left: 0, right: 400, top: 100, bottom: 200};
    expect(depositDropTargetInside(200, 150, rect)).toBe(true);
    expect(depositDropTargetInside(500, 150, rect)).toBe(false);
    expect(depositDropTargetInside(200, 150, undefined)).toBe(false);
  });
});

describe("deposit interest calculation", () => {
  it("averages the opening and closing balance of each month", () => {
    expect(depositMonthlyAverage(1_000_000, 2_000_000)).toBe(1_500_000);
    expect(depositMonthlyAverage(0, 0)).toBe(0);
  });
  it("splits an annual rate across twelve months by default", () => {
    // 1,200,000 月均余额 × 0.95% ÷ 12 = 950
    expect(depositMonthlyInterest(1_200_000, 0.0095, 1, 12)).toBeCloseTo(950, 6);
  });
  it("supports the actual-days bank convention", () => {
    // 1,200,000 × 0.95% × 31/360
    expect(depositMonthlyInterest(1_200_000, 0.0095, 31, 360)).toBeCloseTo(981.6667, 3);
  });
  it("keeps a full year of monthly interest equal to the annual amount", () => {
    const monthly = Array.from({length: 12}, () => depositMonthlyInterest(1_200_000, 0.0095, 1, 12));
    expect(monthly.reduce((sum, x) => sum + x, 0)).toBeCloseTo(1_200_000 * 0.0095, 6);
  });
});

const tier = (key: string, category: string, categoryLabel: string, termLabel: string,
  benchmarkRate: number | null, listedRate: number | null, autoApply = false,
  practiceLow: number | null = null, practiceHigh: number | null = null,
  defaultRate: number | null = listedRate) =>
  ({key, category, categoryLabel, termLabel, label: termLabel ? `${categoryLabel}（${termLabel}）` : categoryLabel,
    benchmarkRate, listedRate, defaultRate, autoApply, practiceLow, practiceHigh, practiceNote: ""});

const demandTier = tier("demand", "demand", "活期存款", "", 0.0035, 0.0005, true, 0.0005, 0.0035);
// 合同议价档位（不自动套用）。
const threeYearTier = tier("term_3y", "term", "定期存款", "3年", 0.0275, 0.0125, false, 0.0125, 0.019);
// 标准 3 年定存：挂牌 1.25%（参考下限），中枢默认 1.55%，实务区间 1.25%~1.90%。
const autoThreeYearTier = tier("term_3y", "term", "定期存款", "3年", 0.0275, 0.0125, true, 0.0125, 0.019, 0.0155);
const customTier = tier("custom", "custom", "自定义（按存款协议）", "", null, null);

describe("automatic rates default to the market-center value", () => {
  it("keeps the listed rate for current accounts (listed = market there)", () => {
    expect(depositAutoRate(demandTier)).toBe(0.0005);
  });
  it("prefers the market-center default over the listed floor and falls back for old backends", () => {
    expect(depositAutoRate(autoThreeYearTier)).toBe(0.0155);
    // 旧后端负载没有 defaultRate 字段时回落挂牌值，不显示空白。
    const legacy = {...autoThreeYearTier, defaultRate: null};
    expect(depositAutoRate(legacy)).toBe(0.0125);
  });
  it("leaves contract-negotiated tiers blank so the auditor must fetch the real rate", () => {
    expect(depositAutoRate(threeYearTier)).toBeUndefined();
    expect(depositAutoRate(customTier)).toBeUndefined();
    expect(depositAutoRate(undefined)).toBeUndefined();
  });
});

describe("the PBC benchmark is a ceiling reference, never a calculation basis", () => {
  it("never supplies a rate for calculation", () => {
    // 3 年期基准 2.75% 存在，但绝不能被自动套用。
    expect(threeYearTier.benchmarkRate).toBe(0.0275);
    expect(depositAutoRate(threeYearTier)).toBeUndefined();
    expect(depositEffectiveTierRate(threeYearTier, {})).toBeUndefined();
  });
  it("flags a rate entered above the benchmark", () => {
    expect(depositRateAboveBenchmark(threeYearTier, 0.0135)).toBe(false);
    expect(depositRateAboveBenchmark(threeYearTier, 0.03)).toBe(true);
    // 央行未公布基准的档位不提示。
    expect(depositRateAboveBenchmark(customTier, 0.03)).toBe(false);
  });
});

describe("deposit tier category and term selection", () => {
  const tiers = {
    benchmarkDate: "2015-10-24", listedDate: "2025-05-20",
    benchmarkSource: "", listedSource: "", practiceSource: "", authority: "",
    autoApplyPolicy: "", links: [], linkGroups: [],
    listedRateDate: "2025-05-20", rateAgeMonths: 15, ratesStale: true, staleMessage: "",
    categories: [
      {key: "demand", label: "活期存款", terms: [{key: "demand", label: ""}]},
      {key: "notice", label: "通知存款", terms: [{key: "notice_1d", label: "1天"}, {key: "notice_7d", label: "7天"}]},
      {key: "term", label: "定期存款", terms: [
        {key: "term_3m", label: "3个月"}, {key: "term_6m", label: "6个月"},
        {key: "term_1y", label: "1年"}, {key: "term_2y", label: "2年"}, {key: "term_3y", label: "3年"},
      ]},
    ],
    tiers: [demandTier],
  };
  it("offers no second dropdown for categories without a term", () => {
    expect(depositTermsOf(tiers, "demand")).toEqual([]);
  });
  it("offers 1天/7天 for notice deposits and the term list for time deposits", () => {
    expect(depositTermsOf(tiers, "notice").map((x) => x.label)).toEqual(["1天", "7天"]);
    expect(depositTermsOf(tiers, "term").map((x) => x.label)).toEqual(["3个月", "6个月", "1年", "2年", "3年"]);
  });
  it("lands on the first term when the category changes", () => {
    expect(depositFirstTierOf(tiers, "notice")).toBe("notice_1d");
    expect(depositFirstTierOf(tiers, "term")).toBe("term_3m");
    expect(depositFirstTierOf(tiers, "demand")).toBe("demand");
  });
});

describe("user-customised tier rates", () => {
  it("prefers the user's rate over the built-in default", () => {
    expect(depositEffectiveTierRate(demandTier, {})).toBe(0.0005);
    expect(depositEffectiveTierRate(demandTier, {demand: 0.002})).toBe(0.002);
  });
  it("keeps a zero override instead of falling back to the default", () => {
    expect(depositEffectiveTierRate(demandTier, {demand: 0})).toBe(0);
  });
  it("makes a blank tier usable once the auditor fills it in", () => {
    expect(depositEffectiveTierRate(threeYearTier, {})).toBeUndefined();
    expect(depositEffectiveTierRate(threeYearTier, {term_3y: 0.0135})).toBe(0.0135);
  });
  it("flags rates outside the observed practice range", () => {
    expect(depositRateOutOfPractice(demandTier, 0.001)).toBe(false);
    expect(depositRateOutOfPractice(demandTier, 0.05)).toBe(true);
    expect(depositRateOutOfPractice(customTier, 0.05)).toBe(false);
  });
});

describe("rates are shown as percentages, stored as decimals", () => {
  it("renders a decimal rate as a percent number", () => {
    expect(depositRateToPercent(0.0005)).toBe("0.05");
    expect(depositRateToPercent(0.0135)).toBe("1.35");
    expect(depositRateToPercent(0)).toBe("0");
    expect(depositRateToPercent(undefined)).toBe("");
    expect(depositRateToPercent(Number.NaN)).toBe("");
  });
  it("reads a typed percentage back as a decimal", () => {
    expect(depositPercentToRate("0.05")).toBeCloseTo(0.0005, 12);
    expect(depositPercentToRate("1.35")).toBeCloseTo(0.0135, 12);
    expect(depositPercentToRate("")).toBeNaN();
    expect(depositPercentToRate("abc")).toBeNaN();
  });
  it("round-trips without drifting", () => {
    for (const rate of [0.0005, 0.002, 0.0055, 0.0095, 0.0125, 0.0275]) {
      expect(depositPercentToRate(depositRateToPercent(rate))).toBeCloseTo(rate, 12);
    }
  });
});

describe("序时账的金额形态", () => {
  // 布局由映射了哪几列决定，不是用户选的；符号记法也不再让用户选——
  // 后端按凭证配平等数据形态自动判定，判定结论与依据写进测算结果。
  it("按映射的列判断布局", () => {
    // 角色名与统一映射内核一致（4800 样例就是 金额＋方向列）。
    expect(depositJeLayout({functionalDebit: "借方金额", functionalCredit: "贷方金额"})).toBe("split");
    expect(depositJeLayout({functionalAmount: "本位币金额", direction: "借贷"})).toBe("directed");
    expect(depositJeLayout({functionalAmount: "本位币金额"})).toBe("single");
    expect(depositJeLayout({date: "记账日期"})).toBe("none");
  });
  it("三种布局各有中文名", () => {
    expect(JE_LAYOUT_LABEL.split).toBe("借贷分列");
    expect(JE_LAYOUT_LABEL.directed).toBe("金额＋方向列");
    expect(JE_LAYOUT_LABEL.single).toBe("单一金额列");
    expect(JE_LAYOUT_LABEL.none).toBe("尚未映射本位币净额、借方或贷方");
  });
});

describe("存款科目确认表回传", () => {
  const importTiers = {
    benchmarkDate: "2015-10-24", listedDate: "2025-05-20",
    benchmarkSource: "", listedSource: "", practiceSource: "", authority: "",
    autoApplyPolicy: "", links: [], linkGroups: [],
    listedRateDate: "2025-05-20", rateAgeMonths: 15, ratesStale: true, staleMessage: "",
    categories: [
      {key: "demand", label: "活期存款", terms: [{key: "demand", label: ""}]},
      {key: "term", label: "定期存款", terms: [
        {key: "term_3m", label: "3个月"}, {key: "term_1y", label: "1年"},
      ]},
    ],
    tiers: [
      tier("demand", "demand", "活期存款", "", 0.0035, 0.0005, true, 0.0005, 0.0035),
      tier("term_3m", "term", "定期存款", "3个月", null, 0.011),
    ],
  };
  // sourceIdentities 路径：行键是 JSON 数组串（alpha.99 起）。
  const plainRow = { key: JSON.stringify(["", "1002 银行存款", "", ""]), account: "1002 银行存款" };
  const auxRow = {
    key: JSON.stringify(["甲", "1002 银行存款", "工行基本户", ""]),
    account: "1002 银行存款", auxiliary: "工行基本户", auxiliaryKey: "工行基本户",
  };
  const rows = [plainRow, auxRow];

  it("利率写到页面读取的覆盖键：普通行用科目全文，辅助行用行键", () => {
    const plan = depositConfirmationImport([
      { key: plainRow.key, values: ["1002 银行存款", "银行存款（计息）", "定期存款", "3个月", "1.35"] },
      { key: auxRow.key, values: ["1002 银行存款 · 工行基本户", "银行存款（计息）", "活期存款", "", "0.5"] },
    ], rows, importTiers, true);
    expect(plan.rateUpdates).toEqual({
      "1002 银行存款": depositPercentToRate("1.35"),
      [auxRow.key]: depositPercentToRate("0.5"),
    });
    expect(plan.rateByRowKey).toEqual({
      [plainRow.key]: depositPercentToRate("1.35"),
      [auxRow.key]: depositPercentToRate("0.5"),
    });
  });
  it("存款类型分表：普通行按科目键，辅助行按行键", () => {
    const plan = depositConfirmationImport([
      { key: plainRow.key, values: ["1002 银行存款", "银行存款（计息）", "定期存款", "3个月", ""] },
    ], rows, importTiers, true);
    expect(plan.tierAccountUpdates).toEqual({ "1002 银行存款": "term_3m" });
    expect(plan.tierDetailUpdates).toEqual({});
    expect(plan.rateUpdates[plainRow.key]).toBeUndefined();
  });
  it("辅助行的类型进明细表，利率留空表示回到档位默认", () => {
    const plan = depositConfirmationImport([
      { key: auxRow.key, values: ["1002 银行存款 · 工行基本户", "其他货币资金（计息）", "活期存款", "", ""] },
    ], rows, importTiers, true);
    expect(plan.tierDetailUpdates).toEqual({ [auxRow.key]: "demand" });
    expect(plan.tierAccountUpdates).toEqual({});
    expect(plan.rateUpdates).toEqual({ [auxRow.key]: undefined });
  });
  it("旧路径（无源行身份）时分类按科目键写科目级表", () => {
    const legacyRow = { key: "1002 银行存款", account: "1002 银行存款" };
    const plan = depositConfirmationImport([
      { key: legacyRow.key, values: ["1002 银行存款", "利息收入（勾稽基准）", "", "", ""] },
    ], [legacyRow], importTiers, false);
    expect(plan.roleAccountUpdates).toEqual({ "1002 银行存款": "interest_income" });
    expect(plan.rateUpdates).toEqual({ "1002 银行存款": undefined });
  });
  it("非计息角色的利率覆盖一并清空", () => {
    const plan = depositConfirmationImport([
      { key: plainRow.key, values: ["1002 银行存款", "不参与测算", "", "", ""] },
    ], rows, importTiers, true);
    expect(plan.rateUpdates).toEqual({ "1002 银行存款": undefined });
  });
  it("非法输入按中文报错", () => {
    expect(() => depositConfirmationImport([
      { key: plainRow.key, values: ["1002 银行存款", "未知分类", "", "", ""] },
    ], rows, importTiers, true)).toThrow("请选择有效的科目分类");
    expect(() => depositConfirmationImport([
      { key: plainRow.key, values: ["1002 银行存款", "银行存款（计息）", "定期存款", "8个月", ""] },
    ], rows, importTiers, true)).toThrow("存款类型与期限不匹配");
    expect(() => depositConfirmationImport([
      { key: plainRow.key, values: ["1002 银行存款", "银行存款（计息）", "定期存款", "3个月", "abc"] },
    ], rows, importTiers, true)).toThrow("年利率须填写数字百分比");
    expect(() => depositConfirmationImport([
      { key: "不存在的行", values: ["", "", "", "", ""] },
    ], rows, importTiers, true)).toThrow("已不在当前确认清单");
  });
});

describe("账户级覆盖键", () => {
  it("辅助行用行键、普通行用科目全文，读写同键", () => {
    const auxRow = {
      key: JSON.stringify(["甲", "1002 银行存款", "工行基本户", ""]),
      account: "1002 银行存款", auxiliary: "工行基本户", auxiliaryKey: "工行基本户",
    };
    const plainRow = { key: JSON.stringify(["", "1002 银行存款", "", ""]), account: "1002 银行存款" };
    const legacyAuxRow = {
      key: "甲\u001f1002\u001f工行基本户", account: "1002 银行存款",
      auxiliaryKey: "工行基本户",
    };
    expect(depositAccountOverrideKey(auxRow)).toBe(auxRow.key);
    expect(depositAccountOverrideKey(plainRow)).toBe("1002 银行存款");
    expect(depositAccountOverrideKey(legacyAuxRow)).toBe(legacyAuxRow.key);
  });
});
