// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useLedgerDictReviews } from "./LedgerReviewAll";

function deferred() {
  let resolve!: (value: unknown) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<unknown>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const slot = (onApplied = vi.fn(), column = "A编码") => ({
  headers: [column],
  preview: [],
  mapping: { accountCode: column },
  labels: { accountCode: "科目编码" },
  onApplied,
});
afterEach(cleanup);

describe("共享账表复核生命周期", () => {
  it("换源 A→B 后即使 A 无修改建议也不回写旧映射", async () => {
    const request = deferred();
    const call = vi.fn(() => request.promise);
    const applied = vi.fn();
    const { result, rerender } = renderHook(
      ({ source }) => useLedgerDictReviews(call, { tb: source }),
      { initialProps: { source: "A.xlsx|S1|1" } },
    );
    let pending!: ReturnType<typeof result.current.reviewAll>;
    act(() => {
      pending = result.current.reviewAll({ tb: slot(applied) });
    });
    const isCurrent = result.current.currentGuard();
    expect(result.current.reviewing.tb).toBe(true);
    rerender({ source: "B.xlsx|S2|3" });
    expect(isCurrent()).toBe(false);
    expect(result.current.reviewing.tb).toBe(false);
    await act(async () => {
      request.resolve({ changes: [] });
      await pending;
    });
    expect(applied).not.toHaveBeenCalled();
    expect(await pending).toEqual({});
    expect(result.current.status.tb).toBe("");
  });

  it("clear 后旧响应不会解除新请求的锁定，只有新请求可回写", async () => {
    const first = deferred(),
      second = deferred();
    const call = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const firstApplied = vi.fn(),
      nextApplied = vi.fn();
    const { result } = renderHook(() => useLedgerDictReviews(call));
    let old!: ReturnType<typeof result.current.reviewAll>,
      next!: ReturnType<typeof result.current.reviewAll>;
    act(() => {
      old = result.current.reviewAll({ tb: slot(firstApplied) });
    });
    act(() => {
      result.current.clearReview("tb");
      next = result.current.reviewAll({ tb: slot(nextApplied, "B编码") });
    });
    await act(async () => {
      first.resolve({ changes: [] });
      await old;
    });
    expect(result.current.reviewing.tb).toBe(true);
    expect(firstApplied).not.toHaveBeenCalled();
    await act(async () => {
      second.resolve({ changes: [] });
      await next;
    });
    expect(nextApplied).toHaveBeenCalledWith({ accountCode: "B编码" });
    expect(result.current.reviewing.tb).toBe(false);
  });

  it("移除一个文件只丢弃该文件结果，另一文件仍可完成", async () => {
    const pair = deferred();
    const call = vi.fn(() => pair.promise);
    const jeApplied = vi.fn(),
      tbApplied = vi.fn();
    const { result, rerender } = renderHook(
      ({ source }) => useLedgerDictReviews(call, { je: source, tb: "TB" }),
      { initialProps: { source: "JE" } },
    );
    let pending!: ReturnType<typeof result.current.reviewAll>;
    act(() => {
      pending = result.current.reviewAll({
        je: slot(jeApplied),
        tb: slot(tbApplied),
      });
    });
    rerender({ source: "" });
    await act(async () => {
      pair.resolve({ jeChanges: [], tbChanges: [] });
      await pending;
    });
    expect(jeApplied).not.toHaveBeenCalled();
    expect(tbApplied).toHaveBeenCalledOnce();
    expect(Object.keys(await pending)).toEqual(["tb"]);
  });

  it("联合请求失败时两边都保留 Coding 映射且不阻塞页面", async () => {
    const pair = deferred();
    const call = vi.fn(() => pair.promise);
    const jeApplied = vi.fn(),
      tbApplied = vi.fn();
    const { result } = renderHook(() => useLedgerDictReviews(call));
    let pending!: ReturnType<typeof result.current.reviewAll>;
    act(() => {
      pending = result.current.reviewAll({
        je: slot(jeApplied),
        tb: slot(tbApplied),
      });
    });
    await act(async () => {
      pair.reject(new Error("复核不可用"));
      await pending;
    });
    expect(jeApplied).not.toHaveBeenCalled();
    expect(tbApplied).not.toHaveBeenCalled();
    expect(result.current.status.je).toContain("复核不可用");
    expect(result.current.status.tb).toContain("复核不可用");
    expect(result.current.reviewing).toEqual({ je: false, tb: false });
  });

  it("TB 与 JE 同时存在时只发一次真正的联合请求", async () => {
    const call = vi.fn().mockResolvedValue({
      tbChanges: [{
        role: "accountCode",
        suggestedColumn: "TB新编码",
        confidence: 0.82,
      }],
      jeChanges: [{
        role: "accountCode",
        suggestedColumn: "JE新编码",
        confidence: 0.65,
      }],
    });
    const tbApplied = vi.fn(), jeApplied = vi.fn();
    const { result } = renderHook(() => useLedgerDictReviews(call));
    await act(async () => {
      await result.current.reviewAll({
        tb: {
          ...slot(tbApplied, "TB旧编码"),
          headers: ["TB旧编码", "TB新编码"],
        },
        je: {
          ...slot(jeApplied, "JE旧编码"),
          headers: ["JE旧编码", "JE新编码"],
        },
      });
    });
    expect(call).toHaveBeenCalledOnce();
    expect(call).toHaveBeenCalledWith(
      "ledger.review_pair_mapping",
      expect.objectContaining({ payload: expect.objectContaining({ tb: expect.any(Object), je: expect.any(Object) }) }),
    );
    expect(tbApplied).toHaveBeenCalledWith({ accountCode: "TB新编码" });
    expect(jeApplied).toHaveBeenCalledWith({ accountCode: "JE新编码" });
    expect(result.current.results.je?.applied[0].attention).toBe(true);
  });

  it("组件卸载后不调用页面回写，也不返回可供二次回写的旧结果", async () => {
    const request = deferred();
    const applied = vi.fn();
    const { result, unmount } = renderHook(() =>
      useLedgerDictReviews(() => request.promise),
    );
    let pending!: ReturnType<typeof result.current.reviewAll>;
    act(() => {
      pending = result.current.reviewAll({ tb: slot(applied) });
    });
    unmount();
    request.resolve({ changes: [] });
    expect(await pending).toEqual({});
    expect(applied).not.toHaveBeenCalled();
  });

  it("没有建议但必填字段仍缺时，结论不许说无需调整", async () => {
    const request = deferred();
    const { result } = renderHook(() =>
      useLedgerDictReviews(() => request.promise),
    );
    let pending!: ReturnType<typeof result.current.reviewAll>;
    act(() => {
      pending = result.current.reviewAll({
        je: {
          ...slot(),
          missingAfter: () => ["原币币种", "原币金额方案"],
        },
      });
    });
    await act(async () => {
      request.resolve({ changes: [] });
      await pending;
    });
    expect(result.current.status.je).toContain("LLM 未提出调整建议");
    expect(result.current.status.je).toContain(
      "仍有未映射：原币币种、原币金额方案",
    );
    expect(result.current.status.je).not.toContain("无需调整");
  });

  it("已应用建议但仍有缺口的，结论要把剩余缺口一并交代", async () => {
    const request = deferred();
    const applied = vi.fn();
    const { result } = renderHook(() =>
      useLedgerDictReviews(() => request.promise),
    );
    let pending!: ReturnType<typeof result.current.reviewAll>;
    act(() => {
      pending = result.current.reviewAll({
        tb: {
          headers: ["A编码", "B编码"],
          preview: [],
          mapping: { accountCode: "A编码" },
          labels: { accountCode: "科目编码" },
          onApplied: applied,
          missingAfter: (mapping) =>
            mapping.accountCode ? ["期初余额"] : [],
        },
      });
    });
    await act(async () => {
      request.resolve({
        changes: [
          {
            role: "accountCode",
            suggestedColumn: "B编码",
            confidence: 0.9,
          },
        ],
      });
      await pending;
    });
    expect(applied).toHaveBeenCalledWith({ accountCode: "B编码" });
    expect(result.current.status.tb).toContain("已应用 1 项建议");
    expect(result.current.status.tb).toContain("仍有未映射：期初余额");
  });
});
