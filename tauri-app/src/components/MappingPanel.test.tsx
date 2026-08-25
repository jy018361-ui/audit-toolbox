// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MappingPanel, type MappingDict } from "./MappingPanel";

afterEach(cleanup);

const HEADERS = ["会计科目", "科目文本", "本位币金额"];
const ROWS = [["6401050002", "营业成本-运费", "1200.00"]];
const ROLES: [string, string][] = [
  ["accountCode", "科目编码"],
  ["accountName", "科目名称"],
  ["functionalAmount", "本位币净额"],
  ["currencyText", "币种线索文本"],
];

function panel(overrides: Record<string, unknown> = {}) {
  const onChange = vi.fn();
  render(
    <MappingPanel
      title="文件预览"
      headers={HEADERS}
      rows={ROWS}
      mapping={{} as MappingDict}
      roles={ROLES}
      onChange={onChange}
      {...overrides}
    />,
  );
  return { onChange, selects: screen.getAllByRole("combobox") as HTMLSelectElement[] };
}

const pick = (select: HTMLSelectElement, role: string) =>
  fireEvent.change(select, { target: { value: role } });

describe("共用字段映射面板", () => {
  it("每一列给一个角色下拉，选中后回写映射", () => {
    const { onChange, selects } = panel();
    expect(selects).toHaveLength(HEADERS.length);
    pick(selects[0], "accountCode");
    expect(onChange).toHaveBeenCalledWith({ accountCode: "会计科目" });
  });

  it("换一列承担某角色时，原来那列自动让出", () => {
    const { onChange, selects } = panel({ mapping: { accountCode: "会计科目" } });
    pick(selects[1], "accountCode");
    expect(onChange).toHaveBeenCalledWith({ accountCode: "科目文本" });
  });

  it("可多列的角色收下多列而不是相互覆盖", () => {
    const { onChange, selects } = panel({
      mapping: { accountName: ["科目文本"] },
      multi: new Set(["accountName"]),
    });
    pick(selects[0], "accountName");
    expect(onChange).toHaveBeenCalledWith({ accountName: ["科目文本", "会计科目"] });
  });

  it("被方案互斥锁定的角色标为已停用", () => {
    const { selects } = panel({ isLocked: (role: string) => role === "functionalAmount" });
    const option = selects[0].querySelector('option[value="functionalAmount"]');
    expect(option?.textContent).toContain("已停用");
  });

  it("已被别的角色占用的单列角色标为已用", () => {
    const { selects } = panel({ mapping: { accountCode: "会计科目" } });
    const option = selects[1].querySelector('option[value="accountCode"]');
    expect(option?.textContent).toContain("已用");
  });

  it("尚未映射的必填项直接列出来", () => {
    panel({ missing: ["记账日期", "摘要"] });
    expect(screen.getByText(/尚未映射：记账日期、摘要/)).toBeTruthy();
  });

  it("给了分组就按组渲染下拉", () => {
    const { selects } = panel({
      groups: [{ title: "科目与主体", roles: ["accountCode", "accountName"] }],
    });
    expect(selects[0].querySelector("optgroup")?.getAttribute("label")).toBe("科目与主体");
  });

  it("toggle 模式下一列可以叠加多个角色，并显示已承担的语义", () => {
    // 汇兑损益的场景：账户币种写在科目名称里（银行存款-中行朝阳支行美元户），
    // 那一列同时是科目名称与币种线索文本。按「一列一角色」会丢掉这个能力。
    const onToggle = vi.fn();
    render(
      <MappingPanel
        title="TB 文件预览"
        headers={HEADERS}
        rows={ROWS}
        mapping={{ accountName: ["科目文本"], currencyText: "科目文本" }}
        roles={ROLES}
        mode="toggle"
        rolesOf={(header) => (header === "科目文本" ? ["accountName", "currencyText"] : [])}
        onToggle={onToggle}
        onChange={() => {}}
      />,
    );
    const selects = screen.getAllByRole("combobox") as HTMLSelectElement[];
    expect(selects[1].querySelector("option")?.textContent).toBe("科目名称 ＋ 币种线索文本");
    // 已承担的角色带勾，再点一次是取消。
    expect(selects[1].querySelector('option[value="accountName"]')?.textContent).toContain("✓");
    pick(selects[1], "accountCode");
    expect(onToggle).toHaveBeenCalledWith("科目文本", "accountCode");
  });
});
