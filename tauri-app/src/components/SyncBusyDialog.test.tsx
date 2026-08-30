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
    expect(screen.getByText(/完成后窗口会自动关闭/)).toBeTruthy();

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
    expect(screen.getByText("正在处理 2 项操作")).toBeTruthy();
    expect(screen.getByText("正在导入文档")).toBeTruthy();
    expect(screen.getByText("正在OCR 识别")).toBeTruthy();
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

  it("后台等待把弹窗藏起来，本批不再弹，下一批慢操作照常弹出", async () => {
    render(<SyncBusyDialog />);
    let pending: Promise<unknown> = Promise.resolve({});
    act(() => {
      pending = engineCall("audipick.document_import", {});
    });
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.getByText("正在导入文档")).toBeTruthy();
    // 不是停止：操作仍在后台跑，只是用户不再干等弹窗。
    fireEvent.click(screen.getByRole("button", { name: "后台等待" }));
    expect(screen.queryByText("正在导入文档")).toBeNull();
    // 同批又有新调用进来（没经过空闲）也不重新弹。
    act(() => {
      void engineCall("audipick.ocr", {});
    });
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(screen.queryByText(/正在处理/)).toBeNull();

    // 本批结束转空闲后，新一批慢操作照常弹窗。
    act(() => {
      for (const resolve of tauri.state.resolvers) resolve({});
    });
    await pending;
    await flush();
    act(() => {
      void engineCall("audipick.ocr", {});
    });
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.getByText("正在OCR 识别")).toBeTruthy();
  });
});
