import { describe, expect, it } from "vitest";
import { formatCount, formatMoney, isNumericCellText } from "./numberFormat";

describe("formatMoney 统一金额口径", () => {
  it("千位分隔 + 固定两位小数", () => {
    expect(formatMoney(1234567.89)).toBe("1,234,567.89");
    expect(formatMoney(1234.5)).toBe("1,234.50");
    expect(formatMoney(0.1)).toBe("0.10");
    expect(formatMoney(-9876543.21)).toBe("-9,876,543.21");
  });

  it("零与极小值统一按零显示，-0 不再显示成 -0.00", () => {
    expect(formatMoney(0)).toBe("0.00");
    expect(formatMoney(-0)).toBe("0.00");
    expect(formatMoney(-0.001)).toBe("0.00");
  });

  it("零值占位可自定义（固定资产透视与导出格式对齐用短横线）", () => {
    expect(formatMoney(0, { zeroText: "-" })).toBe("-");
    expect(formatMoney(-0.004, { zeroText: "-" })).toBe("-");
    expect(formatMoney(0.005, { zeroText: "-" })).toBe("0.01");
  });

  it("非数字占位", () => {
    expect(formatMoney(null)).toBe("—");
    expect(formatMoney(undefined)).toBe("—");
    expect(formatMoney(Number.NaN)).toBe("—");
    expect(formatMoney("abc")).toBe("—");
    expect(formatMoney(true)).toBe("—");
    expect(formatMoney("abc", { invalidText: "-" })).toBe("-");
  });

  it("接受后端序列化成字符串的数字", () => {
    expect(formatMoney("1234.5")).toBe("1,234.50");
    expect(formatMoney("")).toBe("—");
  });
});

describe("formatCount 统一计数口径", () => {
  it("整数加千位分隔", () => {
    expect(formatCount(12345)).toBe("12,345");
    expect(formatCount(999)).toBe("999");
    expect(formatCount(0)).toBe("0");
    expect(formatCount(-1234)).toBe("-1,234");
  });

  it("非数字原样返回，空值给空串", () => {
    expect(formatCount(null)).toBe("");
    expect(formatCount(undefined)).toBe("");
    expect(formatCount("abc")).toBe("abc");
    expect(formatCount("12,345")).toBe("12,345");
  });

  it("需要小数的计数可保留位数（如工时）", () => {
    expect(formatCount(1234.5, { maxFractionDigits: 2 })).toBe("1,234.5");
    expect(formatCount(1234.567, { maxFractionDigits: 2 })).toBe("1,234.57");
  });
});

describe("isNumericCellText 表格数值单元格判定", () => {
  it.each([
    "85,600.00",
    "20,000,000.00",
    "-3,112,068",
    "(1,234.50)",
    "0.00",
    "4.38",
    "4.38%",
    "12,345",
    "  2,860,000.00  ",
  ])("%s 判为数值右对齐", (text) => {
    expect(isNumericCellText(text)).toBe(true);
  });

  it.each([
    "1001",
    "100101",
    "2026",
    "JK-2025-008",
    "2026-01-01",
    "借款汇总",
    "",
    "1.1.1",
    "36 KB",
  ])("%s 保持左对齐", (text) => {
    expect(isNumericCellText(text)).toBe(false);
  });
});
