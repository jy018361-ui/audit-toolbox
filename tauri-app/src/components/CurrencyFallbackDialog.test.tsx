// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { describe, expect, it, vi } from "vitest";
import { CurrencyFallbackDialog } from "./CurrencyFallbackDialog";

describe("多币种测算方式弹窗", () => {
  it("说明影响范围并要求用户明确选择后继续", () => {
    const change = vi.fn();
    const proceed = vi.fn();
    const { rerender } = render(
      <CurrencyFallbackDialog
        open
        affectedGroupCount={3}
        missingCurrencies={["USD", "HKD"]}
        value=""
        onChange={change}
        onCancel={vi.fn()}
        onContinue={proceed}
      />,
    );
    expect(screen.getByRole("dialog")).toHaveTextContent("涉及 3 个多币种账户");
    expect(screen.getByRole("dialog")).toHaveTextContent("USD、HKD");
    expect(screen.getByRole("button", { name: "按所选口径继续" })).toBeDisabled();
    fireEvent.click(
      screen.getByRole("radio", { name: /按币种使用年初、年末平均值/ }),
    );
    expect(change).toHaveBeenCalledWith("twoPointByCurrency");

    rerender(
      <CurrencyFallbackDialog
        open
        affectedGroupCount={3}
        missingCurrencies={["USD", "HKD"]}
        value="twoPointByCurrency"
        onChange={change}
        onCancel={vi.fn()}
        onContinue={proceed}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "按所选口径继续" }));
    expect(proceed).toHaveBeenCalledOnce();
  });
});
