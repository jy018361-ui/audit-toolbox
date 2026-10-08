// @vitest-environment jsdom
import {
  act,
  cleanup,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { completeLedgerPairReviewKey, LedgerReviewAll, useLedgerDictReviews } from "./LedgerReviewAll";

it("自动复核键只在 TB 与 JE 都完整时生成", () => {
  expect(completeLedgerPairReviewKey(["tb.xlsx"], undefined)).toBe("");
  expect(completeLedgerPairReviewKey(undefined, ["je.xlsx"])).toBe("");
  expect(completeLedgerPairReviewKey(["tb.xlsx"], ["je.xlsx"]))
    .toBe(JSON.stringify([["tb.xlsx"], ["je.xlsx"]]));
});

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
  it("每个新来源身份默认自动复核一次", async () => {
    const review = vi.fn();
    const view = render(
      <LedgerReviewAll
        present={["tb"]}
        names={{ je: "JE", tb: "TB" }}
        reviewing={{ je: false, tb: false }}
        status={{ je: "", tb: "" }}
        autoReviewKey="TB-A"
        onReviewAll={review}
      />,
    );
    await waitFor(() => expect(review).toHaveBeenCalledTimes(1));
    view.rerender(
      <LedgerReviewAll
        present={["tb"]}
        names={{ je: "JE", tb: "TB" }}
        reviewing={{ je: false, tb: false }}
        status={{ je: "", tb: "" }}
        autoReviewKey="TB-A"
        onReviewAll={review}
      />,
    );
    expect(review).toHaveBeenCalledTimes(1);
    view.rerender(
      <LedgerReviewAll
        present={["tb"]}
        names={{ je: "JE", tb: "TB" }}
        reviewing={{ je: false, tb: false }}
        status={{ je: "", tb: "" }}
        autoReviewKey="TB-B"
        onReviewAll={review}
      />,
    );
    await waitFor(() => expect(review).toHaveBeenCalledTimes(2));
  });

  it("步骤切换卸载后返回不会对同一来源重复自动复核", async () => {
    const review = vi.fn();
    const owner = {};
    const props = {
      present: ["tb"] as Array<"tb">,
      names: { je: "JE", tb: "TB" },
      reviewing: { je: false, tb: false },
      status: { je: "", tb: "" },
      autoReviewKey: "TB-A",
      autoReviewOwner: owner,
      onReviewAll: review,
    };
    const first = render(<LedgerReviewAll {...props} />);
    await waitFor(() => expect(review).toHaveBeenCalledTimes(1));
    first.unmount();
    render(<LedgerReviewAll {...props} />);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(review).toHaveBeenCalledTimes(1);
  });

  it("删除任一侧不触发，补齐为新完整组合后才再次自动复核", async () => {
    const review = vi.fn();
    const owner = {};
    const common = {
      present: ["je", "tb"] as Array<"je" | "tb">,
      names: { je: "JE", tb: "TB" },
      reviewing: { je: false, tb: false },
      status: { je: "", tb: "" },
      autoReviewOwner: owner,
      onReviewAll: review,
    };
    const firstPair = completeLedgerPairReviewKey(
      ["C:/data/TB-A.xlsx", "Sheet1", 1, 1],
      ["C:/data/JE-A.xlsx", "Sheet1", 1, 1],
    );
    const replacedPair = completeLedgerPairReviewKey(
      ["C:/data/TB-B.xlsx", "Sheet1", 1, 1],
      ["C:/data/JE-A.xlsx", "Sheet1", 1, 1],
    );
    const view = render(
      <LedgerReviewAll {...common} autoReviewKey={firstPair} />,
    );
    await waitFor(() => expect(review).toHaveBeenCalledTimes(1));

    // 删除 TB 后调用方会把 key 清空；单侧仍保留手工复核入口，但不能自动调用 LLM。
    view.rerender(
      <LedgerReviewAll
        {...common}
        present={["je"]}
        autoReviewKey={completeLedgerPairReviewKey(undefined, ["JE-A"])}
      />,
    );
    await act(async () => undefined);
    expect(review).toHaveBeenCalledTimes(1);

    // 换入一份新 TB 并重新形成完整组合，来源身份改变，只再触发一次。
    view.rerender(
      <LedgerReviewAll {...common} autoReviewKey={replacedPair} />,
    );
    await waitFor(() => expect(review).toHaveBeenCalledTimes(2));
    view.rerender(
      <LedgerReviewAll {...common} autoReviewKey={replacedPair} />,
    );
    expect(review).toHaveBeenCalledTimes(2);
  });

  it("映射取值告警明确标注来自 TB 还是 JE", () => {
    render(
      <LedgerReviewAll
        present={["je", "tb"]}
        names={{ je: "JE", tb: "TB" }}
        reviewing={{ je: false, tb: false }}
        status={{ je: "", tb: "" }}
        results={{
          je: {
            mapping: { accountName: "科目描述" },
            appliedCount: 0,
            failed: false,
            error: "",
            applied: [],
            pending: [],
            pairFindings: [],
            mappingWarnings: [
              "科目名称所选列「科目描述」在预览行中全为空，请核对",
            ],
          },
        }}
        onReviewAll={() => undefined}
      />,
    );
    expect(
      screen.getByText(
        "JE：科目名称所选列「科目描述」在预览行中全为空，请核对",
      ),
    ).toBeTruthy();
  });

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
    expect(nextApplied).not.toHaveBeenCalled();
    expect(result.current.results.tb?.mapping).toEqual({ accountCode: "B编码" });
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
    expect(tbApplied).not.toHaveBeenCalled();
    expect(result.current.results.tb?.mapping).toEqual({ accountCode: "A编码" });
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
      tbChanges: [
        {
          role: "accountCode",
          suggestedColumn: "TB新编码",
          confidence: 0.82,
        },
      ],
      jeChanges: [
        {
          role: "accountCode",
          suggestedColumn: "JE新编码",
          confidence: 0.65,
        },
      ],
    });
    const tbApplied = vi.fn(),
      jeApplied = vi.fn();
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
      expect.objectContaining({
        payload: expect.objectContaining({
          tb: expect.any(Object),
          je: expect.any(Object),
        }),
      }),
    );
    expect(tbApplied).toHaveBeenCalledWith({ accountCode: "TB新编码" });
    expect(jeApplied).not.toHaveBeenCalled();
    expect(result.current.results.tb?.applied).toHaveLength(1);
    expect(result.current.results.tb?.pending).toHaveLength(0);
    expect(result.current.results.je?.pending[0].attention).toBe(true);
  });

  it("只上传一侧时单表复核请求要带上 tool 供后端区分工具纪律", async () => {
    const call = vi.fn().mockResolvedValue({ changes: [] });
    const { result } = renderHook(() => useLedgerDictReviews(call));
    await act(async () => {
      await result.current.reviewAll({
        je: { ...slot(), tool: "fx_audit" },
      });
    });
    expect(call).toHaveBeenCalledWith(
      "ledger.review_mapping",
      expect.objectContaining({
        kind: "je",
        payload: expect.objectContaining({ tool: "fx_audit" }),
      }),
    );
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
    expect(result.current.status.je).toContain("已复核 · 仍缺 2 项");
    expect(result.current.status.je).toContain("原币币种、原币金额方案");
    expect(result.current.status.je).not.toContain("无需调整");
  });

  it("有待确认建议且仍有缺口的，结论要把两件事一并交代", async () => {
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
          missingAfter: (mapping) => (mapping.accountCode ? ["期初余额"] : []),
        },
      });
    });
    await act(async () => {
      request.resolve({
        changes: [
          {
            role: "accountCode",
            suggestedColumn: "B编码",
            confidence: 0.7,
          },
        ],
      });
      await pending;
    });
    expect(applied).not.toHaveBeenCalled();
    expect(result.current.status.tb).toContain("1 项建议待确认");
    expect(result.current.status.tb).toContain("仍缺 1 项：期初余额");
  });

  it("低于 60% 的建议不展示，采纳后仍可撤销并实时重算复核状态", async () => {
    const applied = vi.fn();
    const { result } = renderHook(() =>
      useLedgerDictReviews(async () => ({
        changes: [
          { role: "accountCode", suggestedColumn: "B编码", confidence: 0.7 },
          { role: "accountName", suggestedColumn: "B名称", confidence: 0.59 },
        ],
      })),
    );
    await act(async () => {
      await result.current.reviewAll({
        tb: {
          headers: ["A编码", "B编码", "B名称"],
          preview: [],
          mapping: { accountCode: "A编码" },
          labels: { accountCode: "科目编码", accountName: "科目名称" },
          onApplied: applied,
        },
      });
    });
    expect(applied).not.toHaveBeenCalled();
    expect(result.current.status.tb).toContain("1 项建议待确认");
    expect(result.current.results.tb?.pending).toHaveLength(1);

    act(() => result.current.acceptPending("tb", 0));
    expect(applied).toHaveBeenCalledWith({ accountCode: "B编码" });
    expect(result.current.status.tb).toContain("已自动调整 1 项");

    act(() => result.current.undoChange("tb", 0));
    expect(result.current.status.tb).not.toContain("已自动调整");
    expect(result.current.status.tb).not.toContain("建议待确认");
  });
});
