import { describe, expect, it } from "vitest";
import {
  dropUnlinkedTbAuxiliary,
  type AuxiliaryLinkResult,
} from "./ledgerMapping";

function verdict(
  status: AuxiliaryLinkResult["status"],
): AuxiliaryLinkResult {
  return {
    tbAuxMapped: true,
    status,
    column: ["noMatch", "noAnchors"].includes(status) ? null : "核算维度",
    anchorHits: ["noMatch", "noAnchors"].includes(status) ? 0 : 1,
    anchorTotal: 1,
    coverage: ["noMatch", "noAnchors"].includes(status) ? 0 : 1,
    competingColumns: [],
    warnings: [],
  };
}

describe("TB 辅助核算映射须通过 JE 联动验证", () => {
  it.each(["noMatch", "noAnchors", "partialCoverage", "ambiguous"] as const)(
    "%s 时撤销 TB 辅助核算映射并保留其他角色",
    (status) => {
      const mapping = {
        accountCode: "科目编码",
        auxiliary: ["核算维度编码", "核算维度名称"],
        closingFunctionalAmount: "期末余额",
      };
      expect(dropUnlinkedTbAuxiliary(mapping, verdict(status))).toEqual({
        accountCode: "科目编码",
        closingFunctionalAmount: "期末余额",
      });
    },
  );

  it("完整验证通过时保留原映射对象", () => {
    const mapping = { auxiliary: ["核算维度"] };
    expect(dropUnlinkedTbAuxiliary(mapping, verdict("verified"))).toBe(mapping);
  });

  it("借款明细角色验证失败时同样撤销", () => {
    const mapping = { accountCode: "科目编码", loanId: "借款合同号" };
    expect(
      dropUnlinkedTbAuxiliary(mapping, verdict("noMatch"), "loanId"),
    ).toEqual({ accountCode: "科目编码" });
  });
});
