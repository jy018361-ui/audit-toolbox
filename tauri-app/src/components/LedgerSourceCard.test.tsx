// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { LedgerSourceCard, LedgerSourceControls } from "./LedgerSourceCard";
import { LedgerMappingPreview } from "./LedgerMappingPreview";

vi.mock("@/ledgerForms", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/ledgerForms")>(),
  useLedgerForms: () => [],
}));

afterEach(cleanup);

function renderControls(props: Partial<Parameters<typeof LedgerSourceControls>[0]> = {}) {
  const onHeaderRowChange = vi.fn();
  render(
    <LedgerSourceControls
      sheet=""
      knownSheets={[]}
      headerRow={0}
      onSheetChange={() => {}}
      onHeaderRowChange={onHeaderRowChange}
      {...props}
    />,
  );
  return { onHeaderRowChange };
}

describe("凭证预览读取设置", () => {
  it("默认「自动识别」，改成具体行号后原样回传", () => {
    const { onHeaderRowChange } = renderControls();
    const select = screen.getByLabelText("标题行") as HTMLSelectElement;
    expect(select.value).toBe("0");
    expect(screen.getByRole("option", { name: "自动识别" })).toBeTruthy();
    fireEvent.change(select, { target: { value: "3" } });
    expect(onHeaderRowChange).toHaveBeenCalledWith(3);
  });

  it("上传区不重复设置，预览清空后设置仍可操作", () => {
    const onSheetChange = vi.fn();
    const { container } = render(<>
      <LedgerSourceCard inputPath="C:/t/je.xlsx" onBrowse={() => {}} onInspect={() => {}} />
      <LedgerMappingPreview toolbar={<LedgerSourceControls sheet="明细" knownSheets={["明细", "总账"]} headerRow={0}
        onSheetChange={onSheetChange} onHeaderRowChange={() => {}} />} />
    </>);
    const source = screen.getByText("加载数据").closest("section");
    expect(source?.querySelector("select")).toBeNull();
    const sheet = screen.getByLabelText("Sheet");
    expect(container.querySelector(".mapping-panel")?.contains(sheet)).toBe(true);
    fireEvent.change(sheet, { target: { value: "总账" } });
    expect(onSheetChange).toHaveBeenCalledWith("总账");
  });

  it("表头层数可自动识别，也可人工覆盖", () => {
    const onHeaderDepthChange = vi.fn();
    renderControls({ headerDepth: 0, onHeaderDepthChange });
    const select = screen.getByLabelText("表头层数") as HTMLSelectElement;
    expect(select.value).toBe("0");
    fireEvent.change(select, { target: { value: "2" } });
    expect(onHeaderDepthChange).toHaveBeenCalledWith(2);
  });

  it("手选非预设标题行仍能回显，不丢失已恢复的行号", () => {
    renderControls({ headerRow: 25 });
    expect((screen.getByLabelText("标题行") as HTMLSelectElement).value).toBe("25");
  });
});
