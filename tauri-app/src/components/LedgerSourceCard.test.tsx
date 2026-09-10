// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { LedgerSourceCard } from "./LedgerSourceCard";

afterEach(cleanup);

function renderCard(props: Partial<Parameters<typeof LedgerSourceCard>[0]> = {}) {
  const onHeaderRowChange = vi.fn();
  render(
    <LedgerSourceCard
      inputPath="C:\\t\\je.xlsx"
      sheet=""
      knownSheets={[]}
      headerRow={0}
      onBrowse={() => {}}
      onSheetChange={() => {}}
      onHeaderRowChange={onHeaderRowChange}
      onInspect={() => {}}
      {...props}
    />,
  );
  return { onHeaderRowChange };
}

describe("LedgerSourceCard 标题行", () => {
  it("默认「自动识别」，改成具体行号后原样回传", () => {
    const { onHeaderRowChange } = renderCard();
    const select = screen.getByLabelText("标题行") as HTMLSelectElement;
    expect(select.value).toBe("0");
    expect(screen.getByRole("option", { name: "自动识别" })).toBeTruthy();
    fireEvent.change(select, { target: { value: "3" } });
    expect(onHeaderRowChange).toHaveBeenCalledWith(3);
  });

  it("自动模式下回显后端探测到的行号，手选行号时不显示", () => {
    renderCard({ headerRow: 0, detectedHeaderRow: 4 });
    expect(screen.getByText("已自动按第 4 行识别表头。")).toBeTruthy();
    cleanup();
    renderCard({ headerRow: 4, detectedHeaderRow: 4 });
    expect(screen.queryByText("已自动按第 4 行识别表头。")).toBeNull();
  });
});
