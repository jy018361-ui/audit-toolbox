// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 把 Tauri 的 invoke 换成可控开关：manual 模式挂起等手动放行（模拟慢导入），
// fast 模式立即返回（模拟快操作）。组件、api 层的登记/广播逻辑全走真实代码。
const tauri = vi.hoisted(() => {
  const state = {
    mode: "manual" as "manual" | "fast",
    resolvers: [] as Array<(value: unknown) => void>,
  };
  const invokeMock = vi.fn(() => {
    if (state.mode === "fast") return Promise.resolve({});
    return new Promise((resolve) => {
      state.resolvers.push(resolve);
    });
  });
  return { state, invokeMock };
});
vi.mock("@tauri-apps/api/core", () => ({ invoke: tauri.invokeMock }));

import { engineCall } from "@/api";
import { SyncBusyDialog } from "./SyncBusyDialog";

function flush() {
  return act(async () => {});
}

describe("同步操作等待弹窗", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("__TAURI_INTERNALS__", {});
    tauri.state.mode = "manual";
    tauri.state.resolvers = [];
    tauri.invokeMock.mockClear();
  });
  afterEach(async () => {
    // 把仍挂起的调用放行并等登记清空：否则「进行中」名单带着旧条目
    // 漏进下一个测试，快照里凭空多出一条，断言全串台。
    for (const resolve of tauri.state.resolvers) resolve({});
    await act(async () => {});
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("一秒内完成的快操作不弹窗", async () => {
    tauri.state.mode = "fast";
    render(<SyncBusyDialog />);
    await act(async () => {
      await engineCall("audipick.document_import", {});
    });
    act(() => {
      vi.advanceTimersByTime(1200);
    });
    expect(screen.queryByText("正在导入文档")).toBeNull();
  });

  it("超过一秒仍在跑时弹出，并显示中文操作名", async () => {
    render(<SyncBusyDialog />);
    let pending: Promise<unknown> = Promise.resolve({});
    act(() => {
      pending = engineCall("audipick.document_import", {});
    });
    act(() => {
      vi.advanceTimersByTime(999);
    });
    expect(screen.queryByText("正在导入文档")).toBeNull();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.getByText("正在导入文档")).toBeTruthy();
    expect(screen.getByText(/可以最小化后继续浏览/)).toBeTruthy();

    // 完成后自动关闭
    act(() => {
      for (const resolve of tauri.state.resolvers) resolve({});
    });
    await pending;
    await flush();
    expect(screen.queryByText("正在导入文档")).toBeNull();
  });

  it("英文方法名没登记时退回通用文案，不会把技术词露给用户", async () => {
    render(<SyncBusyDialog />);
    act(() => {
      void engineCall("some.unknown_method", {});
    });
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.getByText("正在处理")).toBeTruthy();
    expect(screen.queryByText(/unknown_method/)).toBeNull();
  });

  it("多个操作同时在跑时逐条列出", () => {
    render(<SyncBusyDialog />);
    act(() => {
      void engineCall("audipick.document_import", {});
      void engineCall("audipick.ocr", {});
    });
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.getByText("正在处理")).toBeTruthy();
    expect(screen.getByText("2 项进行中")).toBeTruthy();
    expect(screen.getByText("导入文档")).toBeTruthy();
    expect(screen.getByText("OCR 识别")).toBeTruthy();
  });

  it("同类并发操作聚合数量，并保留不同处理对象", () => {
    render(<SyncBusyDialog />);
    act(() => {
      void engineCall("fx.inspect_tb", {}, "01TB.xlsx / Sheet1");
      void engineCall("fx.inspect_tb", {}, "02TB.xlsx / Sheet1");
      void engineCall("fx.inspect_tb", {}, "02TB.xlsx / Sheet1");
    });
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.getByText("3 项进行中")).toBeTruthy();
    expect(screen.getByText("读取 TB 账表")).toBeTruthy();
    expect(screen.getByText("×3")).toBeTruthy();
    fireEvent.click(screen.getByText("查看 2 个处理对象"));
    expect(screen.getByText("01TB.xlsx / Sheet1")).toBeTruthy();
    expect(screen.getByText("02TB.xlsx / Sheet1 ×2")).toBeTruthy();
  });

  it("调用方给了明细时，把在处理哪份数据一并亮出来", () => {
    render(<SyncBusyDialog />);
    act(() => {
      void engineCall(
        "ledger.review_pair_mapping",
        {},
        "04TB.XLSX ＋ 04序时账.xlsx",
      );
    });
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(
      screen.getByText("正在联合复核字段映射：04TB.XLSX ＋ 04序时账.xlsx"),
    ).toBeTruthy();
  });

  it("批量场景下每条各报各的文件，不再一排「正在处理」", () => {
    render(<SyncBusyDialog />);
    act(() => {
      void engineCall("fx.inspect_tb", {}, "04TB.XLSX / Sheet1");
      void engineCall("fx.inspect_je", {}, "04序时账.xlsx / 序时账");
      void engineCall(
        "ledger.review_pair_mapping",
        {},
        "01科目余额表（TB）.xls ＋ 01序时账 (JE).xlsx",
      );
    });
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.getByText("正在处理")).toBeTruthy();
    expect(screen.getByText("3 项进行中")).toBeTruthy();
    expect(screen.getByText("读取 TB 账表：04TB.XLSX / Sheet1")).toBeTruthy();
    expect(screen.getByText("读取序时账：04序时账.xlsx / 序时账")).toBeTruthy();
    expect(
      screen.getByText(
        "联合复核字段映射：01科目余额表（TB）.xls ＋ 01序时账 (JE).xlsx",
      ),
    ).toBeTruthy();
  });

  it("LLM 来源复核、币种校验等并发调用也各报各的名字，不再一排「正在处理」", () => {
    render(<SyncBusyDialog />);
    act(() => {
      void engineCall("ledger.review_pair_mapping", {}, "04TB.XLSX ＋ 04序时账.xlsx");
      void engineCall("fx.classify_source_llm", {}, "04TB.XLSX / Sheet1");
      void engineCall("fx.validate_currency_mapping", {});
    });
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.getByText("正在处理")).toBeTruthy();
    expect(screen.getByText("3 项进行中")).toBeTruthy();
    expect(
      screen.getByText("复核外汇来源分类：04TB.XLSX / Sheet1"),
    ).toBeTruthy();
    expect(screen.getByText("校验币种映射")).toBeTruthy();
  });

  it("ESC 和点遮罩关不掉：这类操作没法安全中止，弹窗只能等它完成", () => {
    render(<SyncBusyDialog />);
    act(() => {
      void engineCall("audipick.document_import", {});
    });
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(screen.getByText("正在导入文档")).toBeTruthy();
  });

  it("停止等待：页面立刻收到失败、弹窗关闭，后台迟到的结果被丢弃", async () => {
    render(<SyncBusyDialog />);
    const caught: unknown[] = [];
    let pending: Promise<unknown> = Promise.resolve({});
    act(() => {
      pending = engineCall("fx.inspect_je", {}, "04序时账.xlsx").catch(
        (error: unknown) => {
          caught.push(error);
          return undefined;
        },
      );
    });
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.getByText("正在读取序时账：04序时账.xlsx")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "停止等待" }));
    await pending;
    await flush();
    expect(caught).toHaveLength(1);
    expect((caught[0] as Error).message).toContain("已停止等待");
    // 弹窗关闭，也不留右下角小条：终止就是不要了。
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByText(/点击展开/)).toBeNull();

    // 后台迟到的结果放行回来也被吞掉：不弹窗、不再刷新登记。
    act(() => {
      for (const resolve of tauri.state.resolvers) resolve({ late: true });
    });
    await flush();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByText(/点击展开/)).toBeNull();
  });

  it("最小化收成右下角小条：点小条展开回来，清空后小条自动消失", async () => {
    render(<SyncBusyDialog />);
    let pending: Promise<unknown> = Promise.resolve({});
    act(() => {
      pending = engineCall("audipick.document_import", {});
    });
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.getByRole("dialog")).toBeTruthy();

    // 最小化：弹窗收起，右下角小条接管，操作仍在后台跑。
    fireEvent.click(screen.getByRole("button", { name: "最小化" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByText("正在导入文档")).toBeTruthy();

    // 同批又有新调用进来（没经过空闲）不重新弹窗，小条合并计数。
    act(() => {
      void engineCall("audipick.ocr", {});
    });
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByText("2 项操作处理中")).toBeTruthy();

    // 点小条展开回弹窗。
    fireEvent.click(screen.getByRole("button", { name: /展开处理进度/ }));
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByText("正在处理")).toBeTruthy();
    expect(screen.getByText("2 项进行中")).toBeTruthy();

    // 全部完成弹窗关闭；转空闲后新一批慢操作照常弹出，小条不残留。
    act(() => {
      for (const resolve of tauri.state.resolvers) resolve({});
    });
    await pending;
    await flush();
    expect(screen.queryByRole("dialog")).toBeNull();
    act(() => {
      void engineCall("audipick.ocr", {});
    });
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByText("正在OCR 识别")).toBeTruthy();
    expect(screen.queryByText(/点击展开/)).toBeNull();
  });

  it("夹具注入的最小化形态直接呈现右下角小条", () => {
    render(
      <SyncBusyDialog
        fixtureEntries={[{ id: 1, method: "fx.inspect_je" }]}
        fixtureMinimized
      />,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByText("正在读取序时账")).toBeTruthy();
  });
});
