import { describe, expect, it } from "vitest";
import { planLedgerChanges, resolveRoleLabels } from "./ledgerMapping";

// 五个账表工具此前各抄一份「角色名→中文标签」，改成后端下发＋本地兜底之后，
// 这里钉住三条：后端优先、缺项回落、整段缺失时行为与从前完全一致。
describe("resolveRoleLabels", () => {
  const local = { accountCode: "科目编码", accountName: "科目名称" };

  it("后端下发的标签优先于页面本地表", () => {
    const labels = resolveRoleLabels(
      [{ name: "accountCode", label: "总账科目" }],
      local,
    );
    expect(labels.accountCode).toBe("总账科目");
    // 后端没提到的角色仍用本地叫法，不会凭空消失。
    expect(labels.accountName).toBe("科目名称");
  });

  it("后端整段缺失时退回本地表", () => {
    expect(resolveRoleLabels(undefined, local)).toEqual(local);
    expect(resolveRoleLabels([], local)).toEqual(local);
  });

  it("角色清单以本地表为准，引擎多下发的角色不进表", () => {
    const labels = resolveRoleLabels(
      [
        { name: "accountCode", label: "总账科目" },
        { name: "originalAmount", label: "原币金额" },
      ],
      local,
    );
    expect(Object.keys(labels).sort()).toEqual(["accountCode", "accountName"]);
  });

  it("下发项残缺时不覆盖本地叫法", () => {
    const labels = resolveRoleLabels(
      [{ name: "accountCode", label: "" } as { name: string; label: string }],
      local,
    );
    expect(labels.accountCode).toBe("科目编码");
  });
});

describe("planLedgerChanges", () => {
  it("按整批建议原子交换科目身份且让摘要接管辅助核算中的文本列", () => {
    const result = planLedgerChanges(
      ["文本", "成本中心", "总账科目", "会计科目"],
      [["发放工资", "CC01", "1001010000", "库存现金-人民币"]],
      {
        accountCode: "会计科目",
        auxiliary: ["文本", "成本中心"],
      },
      {
        accountCode: "科目编码",
        accountName: "科目名称",
        summary: "摘要",
        auxiliary: "辅助核算",
      },
      [
        {
          role: "accountName",
          currentColumn: "",
          suggestedColumn: "会计科目",
          confidence: 0.95,
        },
        {
          role: "summary",
          currentColumn: "",
          suggestedColumn: "文本",
          confidence: 0.95,
        },
        {
          role: "accountCode",
          currentColumn: "会计科目",
          suggestedColumn: "总账科目",
          confidence: 0.95,
        },
      ],
    );
    expect(result.mapping.accountCode).toBe("总账科目");
    expect(result.mapping.accountName).toEqual(["会计科目"]);
    expect(result.mapping.summary).toBe("文本");
    expect(result.mapping.auxiliary).toEqual(["成本中心"]);
    expect(result.applied).toHaveLength(3);
  });

  it("只有经样例确认的编码名称混写列才允许两个科目角色共列", () => {
    const combinedRows = [
      ["1001/库存现金"],
      ["1002/银行存款"],
      ["1003/存放央行"],
      ["1004/其他货币资金"],
    ];
    const accepted = planLedgerChanges(
      ["科目"],
      combinedRows,
      { accountCode: "科目" },
      { accountCode: "科目编码", accountName: "科目名称" },
      [
        {
          role: "accountName",
          suggestedColumn: "科目",
          confidence: 0.95,
        },
      ],
    );
    expect(accepted.mapping.accountCode).toBe("科目");
    expect(accepted.mapping.accountName).toEqual(["科目"]);

    const rejected = planLedgerChanges(
      ["科目"],
      [["1001"], ["1002"], ["1003"], ["1004"]],
      { accountCode: "科目" },
      { accountCode: "科目编码", accountName: "科目名称" },
      [
        {
          role: "accountName",
          suggestedColumn: "科目",
          confidence: 0.95,
        },
      ],
    );
    expect(rejected.mapping).toEqual({ accountCode: "科目" });
    expect(rejected.applied).toHaveLength(0);
  });

  it("混写列也不允许摘要等其他角色与科目编码共列", () => {
    const result = planLedgerChanges(
      ["科目"],
      [
        ["1001/库存现金"],
        ["1002/银行存款"],
        ["1003/存放央行"],
        ["1004/其他货币资金"],
      ],
      { accountCode: "科目" },
      { accountCode: "科目编码", summary: "摘要" },
      [
        {
          role: "summary",
          suggestedColumn: "科目",
          confidence: 0.95,
        },
      ],
    );
    expect(result.mapping).toEqual({ accountCode: "科目" });
    expect(result.applied).toHaveLength(0);
  });
});
