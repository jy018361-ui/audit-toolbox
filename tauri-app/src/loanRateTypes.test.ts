import { describe, expect, it } from "vitest";
import {
  detectLoanRateType,
  isNumericRateCell,
  loanRateDefaults,
  loanRateOverrides,
  loanSpreadBps,
  loanReportStart,
  resolveLoanRates,
} from "./loanRateTypes";

describe("逐行利率口径的默认判定", () => {
  it("利率列是数值就默认固定利率", () => {
    // 测试集里出现过的四种数值写法：百分数、小数、带百分号、带千分位。
    for (const cell of ["3.85", "0.0365", "5.4%", "1,200"]) {
      expect(isNumericRateCell(cell)).toBe(true);
      expect(detectLoanRateType(cell)).toBe("fixed");
    }
  });

  it("写了浮动字样就默认浮动利率", () => {
    for (const cell of [
      "浮动",
      "上浮15%",
      "下浮10%",
      "1Y-LPR+90BP",
      "按基准利率执行",
      "Floating",
    ]) {
      expect(detectLoanRateType(cell)).toBe("floating");
    }
  });

  it("已有执行利率时默认固定，只有用户手工切换才改浮动", () => {
    expect(detectLoanRateType("0.037", "浮动")).toBe("fixed");
    expect(detectLoanRateType("3.85%", "LPR+90BP")).toBe("fixed");
    expect(detectLoanRateType("0.0365", "固定")).toBe("fixed");
    expect(detectLoanRateType("", "浮动")).toBe("floating");
  });

  it("空值与认不出的写法按固定处理，交给用户在预览区改", () => {
    expect(detectLoanRateType("")).toBe("fixed");
    expect(detectLoanRateType("面议")).toBe("fixed");
  });

  it("整份台账逐行给默认值，下标与预览行对齐", () => {
    const headers = ["合同编号", "利率", "利率类型"];
    const preview = [
      ["A-01", "3.85", ""],
      ["A-02", "浮动", ""],
      ["A-03", "0.037", "浮动"],
    ];
    const defaults = loanRateDefaults(preview, headers, {
      rate: "利率",
      rateType: "利率类型",
    });
    expect(defaults.map((x) => x.rateType)).toEqual([
      "fixed",
      "floating",
      "fixed",
    ]);
    // 点数默认 0，浮动行由用户手工填。
    expect(defaults.every((x) => x.spreadBps === 0)).toBe(true);
  });

  it("利率列没映射时不报错，整列按固定给默认", () => {
    const defaults = loanRateDefaults([["A-01", "3.85"]], ["编号", "利率"], {});
    expect(defaults).toEqual([{ rateType: "fixed", spreadBps: 0 }]);
  });
});

describe("默认值与手工改动的叠加", () => {
  const defaults = [
    { rateType: "fixed" as const, spreadBps: 0 },
    { rateType: "floating" as const, spreadBps: 0 },
  ];

  it("没改过就用默认值", () => {
    expect(resolveLoanRates(defaults, {})).toEqual(defaults);
  });

  it("改动只覆盖被改的那一行那一项", () => {
    const out = resolveLoanRates(defaults, {
      0: { rateType: "floating" },
      1: { spreadBps: -25 },
    });
    expect(out[0]).toEqual({ rateType: "floating", spreadBps: 0 });
    expect(out[1]).toEqual({ rateType: "floating", spreadBps: -25 });
  });

  it("下浮记为负数", () => {
    expect(
      resolveLoanRates(defaults, { 1: { spreadBps: -85 } })[1].spreadBps,
    ).toBe(-85);
  });

  it("映射的加点保留，只有没有数值时才读取明确BP表达式", () => {
    expect(
      loanRateDefaults(
        [
          ["LPR+90BP", "75"],
          ["LPR-25BP", ""],
        ],
        ["利率", "加点"],
        { rate: "利率", spreadBps: "加点" },
      ),
    ).toEqual([
      { rateType: "floating", spreadBps: 75 },
      { rateType: "floating", spreadBps: -25 },
    ]);
    expect(loanSpreadBps("0", "LPR+90BP")).toBe(0);
    expect(loanSpreadBps("", "LPR＋90BP")).toBe(90);
    expect(loanSpreadBps("", "上浮15%")).toBe(0);
  });

  it("未操作预览不会将默认零点数发回覆盖源台账", () => {
    expect(loanRateOverrides(defaults, {})).toEqual([null, null]);
    expect(loanRateOverrides(defaults, { 1: { spreadBps: 25 } })).toEqual([
      null,
      { spreadBps: 25 },
    ]);
    expect(
      loanRateOverrides(defaults, { 0: { rateType: "floating" } }),
    ).toEqual([{ rateType: "floating" }, null]);
  });
});

describe("测算期间", () => {
  it("期间开始由资产负债表日推出所属年度年初", () => {
    expect(loanReportStart("2025-12-31")).toBe("2025-01-01");
    expect(loanReportStart("2026-06-30")).toBe("2026-01-01");
  });

  it("日期没填时返回空串，由调用方拦下", () => {
    expect(loanReportStart("")).toBe("");
    expect(loanReportStart("2025/12/31")).toBe("");
  });
});
