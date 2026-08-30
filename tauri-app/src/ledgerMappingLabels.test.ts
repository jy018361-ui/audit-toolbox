import { describe, expect, it } from "vitest";
import { resolveRoleLabels } from "./ledgerMapping";

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
