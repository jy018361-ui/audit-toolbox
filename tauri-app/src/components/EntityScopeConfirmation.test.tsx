// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EntityScopeConfirmation } from "./EntityScopeConfirmation";
import { STRICT_ENTITY_SCOPE } from "@/entityScope";

afterEach(cleanup);

describe("公共主体口径确认", () => {
  const suggestions = {
    anchors: ["甲公司"],
    candidates: [
      {
        sourceSide: "tb" as const,
        sourceEntity: "10008529 乙公司",
        targetEntity: "乙公司",
      },
    ],
  };

  it("默认严格区分，部分归集只写入人工勾选项", () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <EntityScopeConfirmation
        suggestions={suggestions}
        value={STRICT_ENTITY_SCOPE}
        onChange={onChange}
      />,
    );

    expect(
      (screen.getByRole("radio", { name: /严格区分/ }) as HTMLInputElement)
        .checked,
    ).toBe(true);
    fireEvent.click(screen.getByRole("radio", { name: /部分归集/ }));
    expect(onChange).toHaveBeenLastCalledWith({ mode: "aggregate", mappings: [] });

    rerender(
      <EntityScopeConfirmation
        suggestions={suggestions}
        value={{ mode: "aggregate", mappings: [] }}
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByRole("checkbox", { name: /10008529 乙公司/ }));
    expect(onChange).toHaveBeenLastCalledWith({
      mode: "aggregate",
      mappings: [{ side: "tb", source: "10008529 乙公司", target: "乙公司" }],
    });
    expect(screen.getByText(/双方已完全匹配主体：甲公司/)).toBeTruthy();
  });
});
