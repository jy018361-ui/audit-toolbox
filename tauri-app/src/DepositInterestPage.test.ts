import { describe, expect, it } from "vitest";
import {
  depositAccountCode, mergeAccountList,
  depositAutoRate, depositDropTargetInside, depositEffectiveTierRate, depositFirstTierOf,
  depositMissingRequired, depositMonthlyAverage, depositMonthlyInterest, depositRateAboveBenchmark,
  depositPercentToRate, depositRateOutOfPractice, depositRateToPercent, depositReportStart,
  depositTermsOf, depositJeLayout, JE_LAYOUT_LABEL,
} from "./DepositInterestPage";

describe("deposit account list merge", () => {
  it("TB 与 JE 的两种拼法按科目编码归并成一条", () => {
    // 用户实测：TB 是「编码＋名称」，JE 反过来「名称＋编码」，全名去重剩两条。
    expect(
      mergeAccountList(
        ["66030002 利息", "1002 银行存款"],
        ["利息 66030002", "银行存款 1002"],
      ),
    ).toEqual(["66030002 利息", "1002 银行存款"]);
  });
  it("提码只认足位数的数字 token，纯名称不拆", () => {
    expect(depositAccountCode("66030002 财务费用-利息收入")).toBe("66030002");
    expect(depositAccountCode("银行存款")).toBe("银行存款");
    expect(depositAccountCode("1002.01 招商银行")).toBe("1002.01");
  });
});

describe("deposit interest upload and mapping parity", () => {
  it("shows missing TB mappings until an opening and closing balance scheme exists", () => {
    expect(depositMissingRequired("tb", {})).toEqual(["科目编码", "科目名称", "期末余额方案", "期初余额方案（或上传序时账）"]);
    expect(depositMissingRequired("tb", {accountCode: "科目编码", accountName: "科目名称", openingFunctionalDebit: "年初借方", closingFunctionalAmount: "期末余额"})).toEqual([]);
    // 历史保存的映射把编码与名称混在一个 account 里，仍然要能读。
    expect(depositMissingRequired("tb", {account: ["科目编码"], openingFunctionalDebit: "年初借方", closingFunctionalAmount: "期末余额"})).toEqual([]);
  });
  it("drops the opening-balance requirement once a journal is supplied", () => {
    // SAP 的 Trial Balance LC/GC 只有 MTD/YTD，没有年初余额列。
    const sap = {accountCode: "GL Account", accountName: "GL Description", closingFunctionalAmount: "YTD Act (Local Curr)"};
    expect(depositMissingRequired("tb", sap)).toEqual(["期初余额方案（或上传序时账）"]);
    expect(depositMissingRequired("tb", sap, true)).toEqual([]);
  });
  it("only requires a period and amount scheme for the optional journal", () => {
    expect(depositMissingRequired("je", {})).toEqual(["记账日期", "凭证识别字段", "科目编码", "科目名称", "摘要", "发生额方案"]);
    expect(depositMissingRequired("je", {accountCode: "科目", accountName: "科目名称", id: "凭证号", summary: "摘要", date: "记账日期", functionalDebit: "借方金额"})).toEqual([]);
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
  practiceLow: number | null = null, practiceHigh: number | null = null) =>
  ({key, category, categoryLabel, termLabel, label: termLabel ? `${categoryLabel}（${termLabel}）` : categoryLabel,
    benchmarkRate, listedRate, autoApply, practiceLow, practiceHigh, practiceNote: ""});

const demandTier = tier("demand", "demand", "活期存款", "", 0.0035, 0.0005, true, 0.0005, 0.0035);
const threeYearTier = tier("term_3y", "term", "定期存款", "3年", 0.0275, 0.0125, false, 0.0125, 0.019);
const customTier = tier("custom", "custom", "自定义（按存款协议）", "", null, null);

describe("only demand deposits get an automatic rate", () => {
  it("auto-applies the listed rate for current accounts", () => {
    expect(depositAutoRate(demandTier)).toBe(0.0005);
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
    expect(JE_LAYOUT_LABEL.none).toBe("尚未映射金额字段");
  });
});
