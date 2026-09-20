import { describe, expect, it } from "vitest";
import {
  DEFAULT_LOAN_RATE,
  loanEffectiveRate,
  loanDisplayNumber,
  loanEquation,
  loanMissing,
  loanAccountReviewRows,
  mergeRestoredLoanMapping,
} from "./LoanInterestPage";

describe("借款利息测算", () => {
  it("未提供合同利率时预填当前一年期LPR 3.00%", () =>
    expect(DEFAULT_LOAN_RATE).toBe(0.03));
  it("正零和负零都只显示0", () => {
    expect(loanDisplayNumber(0, { minimumFractionDigits: 2 })).toBe("0");
    expect(loanDisplayNumber(-0, { minimumFractionDigits: 2 })).toBe("0");
  });
  it("辅助整组经 JE 验证后才在第二步展开", () => {
    const account = { key: "200101", code: "200101", name: "银行借款", account: "200101 银行借款", opening: 100, closing: 90 };
    expect(loanAccountReviewRows([account], {
      tbAuxMapped: true, status: "verified", column: "辅助", anchorHits: 1, anchorTotal: 1,
      coverage: 1, competingColumns: [], warnings: [],
      groups: [{ entity: "甲", account: "200101", reviewVerified: true,
        details: [{ key: "a银行", display: "A银行" }], tbAuxMapped: true,
        status: "verified", column: "辅助", anchorHits: 1, anchorTotal: 1,
        coverage: 1, competingColumns: [], warnings: [] }],
    })).toMatchObject([{ entity: "甲", auxiliary: "A银行" }]);
    expect(loanAccountReviewRows([account], null)).toMatchObject([{ reviewKey: "200101" }]);
  });
  it("恢复旧任务时保留人工映射并补入新版主体建议", () => {
    expect(
      mergeRestoredLoanMapping(
        {
          entity: "核算组织",
          accountCode: "科目编码",
          accountName: "科目名称",
        },
        { accountCode: "科目编码", accountName: "科目名称" },
        ["核算组织", "科目编码", "科目名称"],
      ),
    ).toEqual({
      accountCode: "科目编码",
      accountName: "科目名称",
      entity: "核算组织",
    });
  });
  it("恢复任务的人工选择优先且不让新建议复用同一物理列", () => {
    expect(
      mergeRestoredLoanMapping(
        { entity: "核算组织", auxiliary: "核算维度" },
        { entity: "核算维度" },
        ["核算组织", "核算维度"],
      ),
    ).toEqual({ entity: "核算维度" });
  });
  it("按基准利率加BP换算浮动利率", () =>
    expect(loanEffectiveRate("floating", 0, 0.035, 75)).toBeCloseTo(0.0425));
  it("未提供基准时显示原执行利率，不将加点当全部利率", () =>
    expect(loanEffectiveRate("floating", 0.042, undefined, 90)).toBeCloseTo(
      0.042,
    ));
  it("显式零基准仍然适用BP，不误认为空值", () =>
    expect(loanEffectiveRate("floating", 0.042, 0, 90)).toBeCloseTo(0.009));
  it("勾稽期初+增加-减少-期末", () =>
    expect(
      loanEquation({
        openingPrincipal: 100,
        additions: 30,
        reductions: 20,
        closingPrincipal: 110,
        ledgerClosing: 110,
      }),
    ).toBe(0));
  // 台账无期末余额列时无从对照：不出假 0，返回空由界面显示为空。
  it("台账无期末列时勾稽差异为空", () =>
    expect(
      loanEquation({
        openingPrincipal: 100,
        additions: 30,
        reductions: 20,
        closingPrincipal: 110,
      }),
    ).toBeNull());
  // 金标要求 TB 的科目编码与名称都到位，缺名称同样拦。借款明细/辅助核算
  // 按业务口径是选填：不进必填清单，缺了由引擎在测算入口明确报错。
  it("不允许TB明细缺少借款识别和本金余额", () =>
    expect(loanMissing("tb", { accountCode: "科目编码" })).toEqual([
      "科目名称",
      "期初余额",
      "期末余额",
    ]));
  it("借款明细/辅助核算为选填，缺它不拦映射", () =>
    expect(
      loanMissing("tb", {
        accountCode: "科目",
        accountName: "科目名称",
        openingFunctionalAmount: "期初余额",
        closingFunctionalAmount: "期末余额",
      }),
    ).toEqual([]));
  it("六种TB形态的期初期末任一到位即可", () => {
    // 借贷分列（TB3/TB6）。
    expect(
      loanMissing("tb", {
        accountCode: "科目",
        accountName: "科目名称",
        loanId: "辅助",
        openingFunctionalCredit: "期初贷方",
        closingFunctionalCredit: "期末贷方",
      }),
    ).toEqual([]);
    // 净额（TB1/TB4）。
    expect(
      loanMissing("tb", {
        accountCode: "科目",
        accountName: "科目名称",
        loanId: "辅助",
        openingFunctionalAmount: "期初余额",
        closingFunctionalAmount: "期末余额",
      }),
    ).toEqual([]);
  });
  it("历史保存的旧角色名仍然认", () =>
    expect(
      loanMissing("tb", {
        account: "科目",
        loanId: "辅助",
        openingPrincipal: "期初本金",
        closingPrincipal: "期末本金",
      }),
    ).toEqual([]));
});
