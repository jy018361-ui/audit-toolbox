import { describe, expect, it } from "vitest";
import { covenantExportRows, covenantUserView, FINANCIAL_METRIC_LABELS, isFormalCovenantRow } from "./audipickCovenant";

describe("广义财务契约四列结果", () => {
  const row = {
    _financial_metrics_only: true, covenant_scope: "repayment",
    covenant_category: "C03 财务行为和交易限制", trigger_standard: "未经同意不得分红",
    excerpt: "借款人未经同意不得分红。", pages: "3", clause_ref: "8.1",
    _covenant_evidence: [
      { role: "obligation", quote: "借款人未经同意不得分红。", document_name: "合同.pdf", pages: "3", clause_ref: "8.1" },
      { role: "consequence", quote: "违反上述约定，贷款人有权提前收回贷款。", document_name: "合同.pdf", pages: "5", clause_ref: "10" },
    ],
  };
  it("界面及导出统一四列，保留类别、触发条件及共同后果出处", () => {
    const result = covenantExportRows([row], () => "合同.pdf")[0];
    expect(Object.values(FINANCIAL_METRIC_LABELS)).toEqual(["财务契约类型", "限制或触发标准", "合同原文摘录", "原文引用出处"]);
    expect(Object.keys(result)).toEqual(Object.values(FINANCIAL_METRIC_LABELS));
    expect(result.财务契约类型).toBe(row.covenant_category);
    expect(result.限制或触发标准).toBe(row.trigger_standard);
    expect(result.合同原文摘录).toBe(row.excerpt);
    expect(result.原文引用出处).toContain("法律后果：文件：合同.pdf；页码：5；条款：10");
    expect(covenantUserView(row).covenant_category).toBe(row.covenant_category);
  });
  it("待新增案例不得混入正式结果和导出", () => {
    const pending = { ...row, _covenant_pending_case: true };
    expect(isFormalCovenantRow(pending)).toBe(false);
    expect(covenantExportRows([pending], () => "合同.pdf")).toEqual([]);
  });
  it("保留案例库 C01-C05 的正式类别名称", () => {
    for (const category of [
      "财务报表指标",
      "盈利与现金流趋势",
      "财务行为与交易限制",
      "资金账户与资本条件",
      "金额型风险事件",
    ]) {
      expect(covenantUserView({ ...row, covenant_category: category }).covenant_category).toBe(category);
    }
  });
});
