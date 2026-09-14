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
    column: status === "noMatch" ? null : "核算维度",
    anchorHits: status === "noMatch" ? 0 : 1,
    anchorTotal: 1,
    coverage: status === "noMatch" ? 0 : 1,
    competingColumns: [],
    warnings: [],
  };
}

describe("TB 辅助核算联动清理", () => {
  it("JE 完全无对应列时取消 TB 辅助核算，但保留其他映射", () => {
    expect(
      dropUnlinkedTbAuxiliary(
        {
          accountCode: "科目编码",
          auxiliary: ["核算维度编码", "核算维度名称"],
          closingFunctionalAmount: "期末余额",
        },
        verdict("noMatch"),
      ),
    ).toEqual({
      accountCode: "科目编码",
      closingFunctionalAmount: "期末余额",
    });
  });

  it("已认定、覆盖不全或多列歧义时不擅自取消", () => {
    const mapping = { auxiliary: ["核算维度"] };
    expect(dropUnlinkedTbAuxiliary(mapping, verdict("verified"))).toBe(mapping);
    expect(dropUnlinkedTbAuxiliary(mapping, verdict("partialCoverage"))).toBe(
      mapping,
    );
    expect(dropUnlinkedTbAuxiliary(mapping, verdict("ambiguous"))).toBe(mapping);
  });

  it("借款工具可以清理 loanId 角色", () => {
    expect(
      dropUnlinkedTbAuxiliary(
        { accountCode: "科目编码", loanId: "借款合同号" },
        verdict("noMatch"),
        "loanId",
      ),
    ).toEqual({ accountCode: "科目编码" });
  });
});
