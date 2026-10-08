import { describe, expect, it } from "vitest";
import {
  applyLedgerReviewsTogether,
  ledgerMappingValueWarnings,
  ledgerReviewCoverageWarnings,
} from "./ledgerMapping";

describe("科目映射预览体检", () => {
  it("科目名称错指全空描述列时不宣称无需调整", () => {
    const warnings = ledgerMappingValueWarnings(
      ["帐号", "账号描述", "账号描述_3"],
      [["1111000010", "现金", ""], ["2111109990", "短期借款", ""]],
      { accountCode: "帐号", accountName: "账号描述_3" },
    );
    expect(warnings).toEqual(["科目名称所选列「账号描述_3」在预览行中全为空，请核对"]);
  });

  it("正确科目列与无样例时不作猜测", () => {
    const headers = ["帐号", "账号描述"];
    const mapping = { accountCode: "帐号", accountName: "账号描述" };
    expect(ledgerMappingValueWarnings(headers, [["1111000010", "现金"]], mapping)).toEqual([]);
    expect(ledgerMappingValueWarnings(headers, [], mapping)).toEqual([]);
  });
});

describe("LLM 逐项复核覆盖", () => {
  it("把未覆盖角色转为中文警告，不能把零修改包装成全部通过", () => {
    expect(
      ledgerReviewCoverageWarnings(
        { complete: false, unreviewedRoles: ["accountCode", "accountName"] },
        { accountCode: "科目编码", accountName: "科目名称" },
      ),
    ).toEqual(["LLM 未逐项覆盖已有映射：科目编码、科目名称；请人工核对"]);
    expect(
      ledgerReviewCoverageWarnings({ complete: true }, { accountCode: "科目编码" }),
    ).toEqual([]);
  });

  it("单表和联合复核都消费后端覆盖率", async () => {
    const target = {
      headers: ["科目编码"],
      preview: [["1001"]],
      mapping: { accountCode: "科目编码" },
      labels: { accountCode: "科目编码" },
    };
    const single = await applyLedgerReviewsTogether(
      async () => ({
        changes: [],
        reviewCoverage: { complete: false, unreviewedRoles: ["accountCode"] },
      }),
      { tb: target },
    );
    expect(single.tb?.mappingWarnings).toContain(
      "LLM 未逐项覆盖已有映射：科目编码；请人工核对",
    );

    const pair = await applyLedgerReviewsTogether(
      async () => ({
        tbChanges: [],
        jeChanges: [],
        tbReviewCoverage: { complete: true, unreviewedRoles: [] },
        jeReviewCoverage: { complete: false, unreviewedRoles: ["accountCode"] },
      }),
      { tb: target, je: target },
    );
    expect(pair.tb?.mappingWarnings).toEqual([]);
    expect(pair.je?.mappingWarnings).toContain(
      "LLM 未逐项覆盖已有映射：科目编码；请人工核对",
    );
  });
});
