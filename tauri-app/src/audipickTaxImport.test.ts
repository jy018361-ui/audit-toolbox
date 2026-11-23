import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { probeTaxDocument, isTaxRuleId } from "./audipickTaxImport";

const pdf = (texts: string[]) => ({
  numPages: texts.length,
  getPage: vi.fn(async (n: number) => ({
    getTextContent: async () => ({ items: [{ str: texts[n - 1], hasEOL: true }] }),
    cleanup: vi.fn(),
  })),
});

describe("tax upload preflight", () => {
  it("indexes a tax document before any full-page OCR, including its untitled continuation", async () => {
    const recognizeHeader = vi.fn();
    const result = await probeTaxDocument(pdf([
      "中华人民共和国企业所得税年度纳税申报表\n纳税人名称：测试公司有限公司\n税款所属期间：2025-01-01至2025-12-31",
      "企业所得税年度纳税申报表填报表单 表单编号 表单名称 是否填报 A105000 纳税调整项目明细表 √",
      "A105000 纳税调整项目明细表\n行次 项目 账载金额 税收金额 调增金额 调减金额\n42 六、其他 * * 0.00 0.00",
      "43 （七）其他 * * 0.00 0.00\n44 五、特别纳税调整应税所得 * * 0.00 0.00\n46 合计 * * 10.00 20.00",
    ]), "年度申报.pdf", { recognizeHeader });
    expect(result?.taxType).toBe("corporate_income");
    expect(result?.forms.find((form) => form.formCode === "A105000")?.pages).toEqual([3, 4]);
    expect(recognizeHeader).not.toHaveBeenCalled();
  });

  it("uses only a first-page header to route an unlabelled scanned tax PDF", async () => {
    const recognizeHeader = vi.fn(async (_page: unknown, _number: number) => "增值税及附加税费申报表（一般纳税人适用）");
    const result = await probeTaxDocument(pdf(["", "", ""]), "scan.pdf", { recognizeHeader });
    expect(result?.taxType).toBe("vat");
    expect(recognizeHeader).toHaveBeenCalledTimes(1);
    expect(recognizeHeader.mock.calls[0][1]).toBe(1);
  });

  it("keeps ordinary contract preparation available and does not OCR its remaining pages", async () => {
    const recognizeHeader = vi.fn(async () => "流动资金借款合同 借款人 测试公司 贷款人 测试银行");
    expect(await probeTaxDocument(pdf(["", ""]), "scan.pdf", { recognizeHeader })).toBeUndefined();
    expect(recognizeHeader).toHaveBeenCalledTimes(1);
    expect(await probeTaxDocument(pdf(["借款合同 " + "借款人向贷款人借款，按期还本付息。".repeat(8)]), "合同.pdf", { recognizeHeader })).toBeUndefined();
    expect(recognizeHeader).toHaveBeenCalledTimes(1);
  });

  it("does not mistake contract invoice or income-tax clauses for tax returns", async () => {
    for (const text of [
      "采购合同\n付款条件：供应商须开具增值税专用发票。".repeat(8),
      "流动资金借款合同\n借款人须遵守企业所得税相关规定，按期申报纳税。".repeat(8),
    ]) expect(await probeTaxDocument(pdf([text]), "合同.pdf")).toBeUndefined();
  });

  it("defers scanned PDFs explicitly uploaded as tax returns even without OCR configured", async () => {
    expect(await probeTaxDocument(pdf([""]), "scan.pdf", { forceTax: true })).toMatchObject({ taxType: "unknown" });
    expect(isTaxRuleId("tax_declaration")).toBe(true);
    expect(isTaxRuleId("tax_vat")).toBe(true);
    expect(isTaxRuleId("tax_corporate_income")).toBe(true);
    expect(isTaxRuleId("tax_audit_report")).toBe(false);
  });
});

it("offers two tax templates and still reads the legacy declaration template", () => {
  const context = vm.createContext({ window: { RULE_PROMPTS: {} } });
  vm.runInContext(readFileSync("assets/audipick/rules/prompts/tax_declaration.js", "utf8"), context);
  vm.runInContext(readFileSync("assets/audipick/rules/registry.js", "utf8"), context);
  const engine = context.window.RuleEngine;
  const ids = engine.getAllSelectableRules().map((rule: { id: string }) => rule.id);
  expect(ids).toContain("tax_vat");
  expect(ids).toContain("tax_corporate_income");
  expect(ids).not.toContain("tax_declaration");
  expect(engine.getRulePrompt("tax_declaration")).toContain("纳税申报表");
});
