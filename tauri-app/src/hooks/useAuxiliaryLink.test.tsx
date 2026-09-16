// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useAuxiliaryLink } from "./useAuxiliaryLink";
const verify = vi.hoisted(() => vi.fn());
vi.mock("../ledgerMapping", () => ({ verifyAuxiliaryLink: verify }));

describe("公共辅助验证最新输入状态", () => {
  it("范围变化立即隐藏旧结论，旧请求晚到不覆盖新结果", async () => {
    let resolveOld!: (value: unknown) => void;
    let resolveNew!: (value: unknown) => void;
    verify.mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; }))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveNew = resolve; }));
    const { result, rerender } = renderHook(({ account }) => useAuxiliaryLink({ account }), {
      initialProps: { account: "1002" },
    });
    rerender({ account: "2001" });
    expect(result.current).toBeNull();
    await act(async () => resolveNew({ status: "verified" }));
    await waitFor(() => expect(result.current?.status).toBe("verified"));
    await act(async () => resolveOld({ status: "noMatch" }));
    expect(result.current?.status).toBe("verified");
  });
});
