// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { FileDropInput } from "./FileDropInput";
import { FileInput } from "./FileInput";
import { StepIndicator } from "./StepIndicator";

afterEach(cleanup);

describe("shared workflow inputs", () => {
  it("does not mark preceding mode tabs as completed", () => {
    render(<StepIndicator current={1} showCompleted={false} steps={[{key:"a",label:"模式甲"},{key:"b",label:"模式乙"}]} />);
    expect(screen.getByRole("button", {name:"1 模式甲"}).className).not.toContain("done");
  });
  it("disables all file actions during processing", () => {
    const onBrowse = vi.fn();
    const onClear = vi.fn();
    render(<FileInput value="C:\\明细.xlsx" disabled onBrowse={onBrowse} onClear={onClear} ariaLabel="文件" />);
    fireEvent.click(screen.getByRole("button", {name:"浏览"}));
    fireEvent.click(screen.getByRole("button", {name:"清空"}));
    expect(onBrowse).not.toHaveBeenCalled();
    expect(onClear).not.toHaveBeenCalled();
  });
  it("marks the current step and blocks disabled steps", () => {
    const onStepClick = vi.fn();
    render(
      <StepIndicator
        current={1}
        onStepClick={onStepClick}
        steps={[
          { key: "source", label: "选择文件" },
          { key: "mapping", label: "字段映射" },
          { key: "export", label: "导出", disabled: true },
        ]}
      />,
    );
    expect(screen.getByRole("button", { name: "2 字段映射" }).getAttribute("aria-current")).toBe("step");
    expect((screen.getByRole("button", { name: "3 导出" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("keeps file paths private in FileInput and exposes validation text", () => {
    render(
      <FileInput
        value="C:\\客户资料\\明细.xlsx"
        onBrowse={() => undefined}
        ariaLabel="账表文件"
        invalid="请选择有效的 Excel 文件"
      />,
    );
    const input = screen.getByLabelText("账表文件") as HTMLInputElement;
    expect(input.value).toBe("明细.xlsx");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByRole("alert").textContent).toContain("Excel");
  });

  it("supports replacing and clearing a filled drop slot", () => {
    const onBrowse = vi.fn();
    const onClear = vi.fn();
    render(
      <FileDropInput
        value="C:\\客户资料\\底稿.xlsx"
        onBrowse={onBrowse}
        onClear={onClear}
        onDragStateChange={() => undefined}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /重新选择文件/ }));
    fireEvent.click(screen.getByRole("button", { name: "清空" }));
    expect(onBrowse).toHaveBeenCalledOnce();
    expect(onClear).toHaveBeenCalledOnce();
  });
});
