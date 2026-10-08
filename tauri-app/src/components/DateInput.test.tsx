// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { DateInput, formatDateDigits, formatDateEdit, isValidIsoDate } from "./DateInput";

describe("DateInput", () => {
  it("formats eight continuously typed digits as an ISO date", () => {
    const onChange = vi.fn();
    render(<DateInput aria-label="资产负债表日" value="" onChange={onChange} />);
    const input = screen.getByLabelText("资产负债表日");

    fireEvent.change(input, { target: { value: "2026" } });
    expect(input).toHaveValue("2026");
    fireEvent.change(input, { target: { value: "20261" } });
    expect(input).toHaveValue("2026-1");
    fireEvent.change(input, { target: { value: "2026-12-31" } });

    expect(input).toHaveValue("2026-12-31");
    expect(onChange).toHaveBeenLastCalledWith("2026-12-31");
    expect(input).toHaveAttribute("inputmode", "numeric");
    expect(input).toHaveAttribute("maxlength", "10");
    expect(input).toBeValid();
  });

  it("keeps partial or invalid input out of page state", () => {
    function Example() {
      const [value, setValue] = useState("2025-12-31");
      return <DateInput aria-label="报告日" value={value} onChange={setValue} />;
    }
    render(<Example />);
    const input = screen.getByLabelText("报告日");

    fireEvent.change(input, { target: { value: "2026023" } });
    expect(input).toHaveValue("2026-02-3");
    fireEvent.change(input, { target: { value: "2026-02-30" } });
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect((input as HTMLInputElement).validity.patternMismatch).toBe(false);
  });

  it("supports pasting digits and editing with Backspace", () => {
    const onChange = vi.fn();
    render(<DateInput aria-label="日期" value="" onChange={onChange} />);
    const input = screen.getByLabelText("日期");

    fireEvent.change(input, { target: { value: "20261231" } });
    expect(input).toHaveValue("2026-12-31");
    expect(onChange).toHaveBeenLastCalledWith("2026-12-31");

    fireEvent.change(input, { target: { value: "2026-12-3" } });
    expect(input).toHaveValue("2026-12-3");
    expect(onChange).toHaveBeenLastCalledWith("");
  });

  it("keeps month and day fixed while a digit in the year is replaced", () => {
    const onChange = vi.fn();
    render(<DateInput aria-label="编辑日" value="2025-12-31" onChange={onChange} />);
    const input = screen.getByLabelText("编辑日");

    fireEvent.change(input, { target: { value: "202-12-31" } });
    expect(input).toHaveValue("202-12-31");
    expect(onChange).toHaveBeenLastCalledWith("");
    fireEvent.change(input, { target: { value: "2026-12-31" } });
    expect(input).toHaveValue("2026-12-31");
    expect(onChange).toHaveBeenLastCalledWith("2026-12-31");

    fireEvent.change(input, { target: { value: "2026-1-31" } });
    expect(input).toHaveValue("2026-1-31");
    expect(onChange).toHaveBeenLastCalledWith("");
    expect(formatDateEdit("2026-12-3")).toBe("2026-12-3");
  });

  it("validates month lengths and leap years", () => {
    expect(formatDateDigits("20261231")).toBe("2026-12-31");
    expect(isValidIsoDate("2024-02-29")).toBe(true);
    expect(isValidIsoDate("2025-02-29")).toBe(false);
    expect(isValidIsoDate("2025-13-01")).toBe(false);
  });
});
