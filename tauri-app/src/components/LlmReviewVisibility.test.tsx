// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LlmReview } from "./LlmReview";
import { LedgerLlmReview } from "./LedgerLlmReview";

afterEach(cleanup);

describe("LLM 复核零调整结论", () => {
  it("FA 公共复核卡不会隐藏无调整结果", () => {
    render(
      <LlmReview
        title="LLM 映射复核"
        busy={false}
        passed
        enabled
        message="LLM 复核完成：现有映射与 LLM 判断一致，未做改动。"
        changes={[]}
        pending={[]}
        onUndo={vi.fn()}
        onAccept={vi.fn()}
        onKeep={vi.fn()}
        onSkip={vi.fn()}
      />,
    );
    expect(screen.getByText("无调整")).toBeVisible();
    expect(screen.getByText(/现有映射与 LLM 判断一致/)).toBeVisible();
  });

  it("凭证公共复核卡不会隐藏无调整结果", () => {
    render(
      <LedgerLlmReview
        busy={false}
        failed={false}
        status="LLM 复核完成：现有字段映射与 LLM 判断一致，未做改动。"
        mapping={{ id: [], accountName: [] }}
        changes={[]}
        pending={[]}
        onSkip={vi.fn()}
        onUndo={vi.fn()}
        onAccept={vi.fn()}
        onKeep={vi.fn()}
      />,
    );
    expect(screen.getByText("无调整")).toBeVisible();
    expect(screen.getByText(/现有字段映射与 LLM 判断一致/)).toBeVisible();
  });
});
