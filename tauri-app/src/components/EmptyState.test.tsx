// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { EmptyState } from "./EmptyState";

afterEach(cleanup);

describe("EmptyState", () => {
  it("shows an explanation and a caller-provided next action", () => {
    render(
      <EmptyState
        title="尚无历史任务"
        description="完成一次处理后会显示在这里。"
        action={<button type="button">开始首个任务</button>}
      />,
    );

    expect(screen.getByRole("region", { name: "尚无历史任务" })).toBeTruthy();
    expect(screen.getByText("完成一次处理后会显示在这里。")).toBeTruthy();
    expect(screen.getByRole("button", { name: "开始首个任务" })).toBeTruthy();
  });
});
