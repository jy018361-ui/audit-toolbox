// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAuxiliaryLink } from "./useAuxiliaryLink";
const verify = vi.hoisted(() => vi.fn());
vi.mock("../ledgerMapping", () => ({ verifyAuxiliaryLink: verify }));

beforeEach(() => {
  verify.mockReset();
});

describe("公共辅助验证最新输入状态", () => {
  it("触发键变化立即隐藏旧结论，旧请求晚到不覆盖新结果", async () => {
    let resolveOld!: (value: unknown) => void;
    let resolveNew!: (value: unknown) => void;
    verify.mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; }))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveNew = resolve; }));
    const { result, rerender } = renderHook(
      ({ params, key }) => useAuxiliaryLink(params, key),
      { initialProps: { params: { account: "1002" }, key: "k1" } },
    );
    rerender({ params: { account: "2001" }, key: "k2" });
    expect(result.current).toBeNull();
    await act(async () => resolveNew({ status: "verified" }));
    await waitFor(() => expect(result.current?.status).toBe("verified"));
    await act(async () => resolveOld({ status: "noMatch" }));
    expect(result.current?.status).toBe("verified");
  });

  it("非辅助映射调整（触发键不变）不重新验证，结论沿用", async () => {
    verify.mockResolvedValue({ status: "verified" });
    const { result, rerender } = renderHook(
      ({ params, key }) => useAuxiliaryLink(params, key),
      {
        initialProps: {
          params: { tbMapping: { auxiliary: "辅助列", currency: "币种列" } },
          key: "源1|辅助列",
        },
      },
    );
    await waitFor(() => expect(result.current?.status).toBe("verified"));
    // 币种、金额等角色的映射变了，但数据源与辅助列映射没变：不再发请求。
    rerender({
      params: { tbMapping: { auxiliary: "辅助列", currency: "新币种列" } },
      key: "源1|辅助列",
    });
    expect(verify).toHaveBeenCalledTimes(1);
    expect(result.current?.status).toBe("verified");
  });

  it("辅助列映射变化重新验证，且发送的是当次最新完整参数", async () => {
    verify.mockResolvedValue({ status: "noMatch" });
    const { rerender } = renderHook(
      ({ params, key }) => useAuxiliaryLink(params, key),
      {
        initialProps: {
          params: { tbMapping: { auxiliary: "旧辅助列" }, jeMapping: {} },
          key: "源1|旧辅助列",
        },
      },
    );
    await waitFor(() => expect(verify).toHaveBeenCalledTimes(1));
    rerender({
      params: { tbMapping: { auxiliary: "新辅助列" }, jeMapping: { currency: "币种列" } },
      key: "源1|新辅助列",
    });
    await waitFor(() => expect(verify).toHaveBeenCalledTimes(2));
    const second = verify.mock.calls[1][0] as Record<string, unknown>;
    expect(second.tbMapping).toEqual({ auxiliary: "新辅助列" });
    expect(second.jeMapping).toEqual({ currency: "币种列" });
  });

  it("来源清空后不再验证，旧结论随之隐藏", async () => {
    verify.mockResolvedValue({ status: "verified" });
    const { result, rerender } = renderHook<
      ReturnType<typeof useAuxiliaryLink>,
      { params: Record<string, unknown> | null; key: string | null }
    >(({ params, key }) => useAuxiliaryLink(params, key),
      {
        initialProps: {
          params: { tbMapping: { auxiliary: "辅助列" } },
          key: "源1|辅助列",
        },
      },
    );
    await waitFor(() => expect(result.current?.status).toBe("verified"));
    rerender({ params: null, key: null });
    expect(result.current).toBeNull();
    expect(verify).toHaveBeenCalledTimes(1);
  });
});
