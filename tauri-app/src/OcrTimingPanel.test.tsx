// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { OcrTimingPanel } from "./OcrTimingPanel";

afterEach(cleanup);

it("显示实际 HTTP 阶段、字节和请求编号，并说明等待响应头的计时边界", () => {
  render(<OcrTimingPanel run={{ started: 0, ended: 10000, pages: [{
    documentId: "d", documentName: "样例.pdf", page: 1, status: "completed", renderMs: 100, totalMs: 10000,
    worker: { setupMs: 1, imageMs: 2, recognitionMs: 9000, structureMs: 0, saveMs: 1, workerMs: 9010,
      httpRequests: [{ prepareMs: 10, headersMs: 8600, bodyMs: 200, parseMs: 3, requestBytes: 2048, responseBytes: 1024,
        httpStatus: 200, requestId: "request-123", model: "qwen3.5-ocr", host: "example.test" }] },
  }] }} />);
  expect(screen.getByText(/不能直接当作服务端计算时间/)).toBeTruthy();
  expect(screen.getByText(/等待响应头：8.60 秒/)).toBeTruthy();
  expect(screen.getByText(/接收响应：0.20 秒/)).toBeTruthy();
  expect(screen.getByText(/请求体：2.0 KB/)).toBeTruthy();
  expect(screen.getByText("服务请求编号：request-123")).toBeTruthy();
});

it("兼容旧版结果及没有服务请求编号的响应", () => {
  render(<OcrTimingPanel run={{ started: 0, ended: 1000, pages: [{
    documentId: "d", documentName: "旧结果.pdf", page: 1, status: "completed", renderMs: 100, totalMs: 1000,
  }] }} />);
  expect(screen.queryByText("查看请求")).toBeNull();
  expect(screen.getAllByText("—").length).toBeGreaterThan(0);
});

it("失败数旁仅在存在失败页时显示重试，点击不展开耗时明细，忙碌时禁用", () => {
  const retry = vi.fn();
  const run = { started: 0, ended: 1000, pages: [{ documentId: "d", documentName: "失败.pdf", page: 2, status: "failed" as const, renderMs: 1, totalMs: 1000 }] };
  const { rerender, container } = render(<OcrTimingPanel run={run} retryFailedCount={1} onRetryFailed={retry} />);
  fireEvent.click(screen.getByRole("button", { name: "重试失败页（1）" }));
  expect(retry).toHaveBeenCalledOnce();
  expect(container.querySelector("details")?.open).toBe(false);
  rerender(<OcrTimingPanel run={run} retryFailedCount={1} retryDisabled onRetryFailed={retry} />);
  expect((screen.getByRole("button", { name: "重试失败页（1）" }) as HTMLButtonElement).disabled).toBe(true);
  rerender(<OcrTimingPanel run={run} retryFailedCount={0} onRetryFailed={retry} />);
  expect(screen.queryByRole("button", { name: /重试失败页/ })).toBeNull();
});
