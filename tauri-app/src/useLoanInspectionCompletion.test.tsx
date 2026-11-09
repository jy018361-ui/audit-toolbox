// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { JobEvent } from "./types";
const mock = vi.hoisted(() => ({ start: vi.fn(), cancel: vi.fn(), listeners: new Set<(event: JobEvent) => void>() }));
vi.mock("./api", () => ({
  jobStart: mock.start, jobCancel: mock.cancel,
  listenJobEvents: vi.fn(async (fn: (event: JobEvent) => void) => {
    mock.listeners.add(fn); return () => { mock.listeners.delete(fn); };
  }),
}));
import { useLoanInspectionCompletion } from "./useLoanInspectionCompletion";
const full = { headers: ["日期"], preview: [["2027-12-31"]], rowCount: 2000,
  sheet: "JE", sheets: ["JE"], headerRow: 1, headerDepth: 1, suggestedMapping: { date: "日期" },
  sampledPreview: false, metadataComplete: true, dataYears: [2026, 2027] };
const event = (jobId: string, phase = "completed", result: unknown = full): JobEvent => ({
  jobId, phase, toolId: "loan_interest", current: 0, total: 0, message: "读取结果", severity: "info", outputPaths: [], result,
});
const emit = (e: JobEvent) => mock.listeners.forEach((fn) => fn(e));
afterEach(cleanup);
beforeEach(() => { vi.clearAllMocks(); mock.listeners.clear(); mock.start.mockResolvedValue("one"); mock.cancel.mockResolvedValue(true); });
it("接住启动返回前的完成事件，并按来源键固定请求，编辑映射不重读", async () => {
  const completed = vi.fn();
  mock.start.mockImplementation(async () => { emit(event("one")); return "one"; });
  const { rerender } = renderHook(({ mapping }) => useLoanInspectionCompletion("source-one", { mapping }, completed), { initialProps: { mapping: "日期" } });
  await waitFor(() => expect(completed).toHaveBeenCalledWith(full));
  rerender({ mapping: "手工日期" });
  expect(mock.start).toHaveBeenCalledTimes(1);
  expect(mock.cancel).not.toHaveBeenCalled();
});
it("换文件后取消旧任务，迟到的完成结果不能写入新来源", async () => {
  let release: (id: string) => void = () => undefined;
  mock.start.mockImplementationOnce(() => new Promise<string>((resolve) => { release = resolve; })).mockResolvedValueOnce("two");
  const completed = vi.fn();
  const { rerender } = renderHook(({ key }) => useLoanInspectionCompletion(key, { source: key }, completed), { initialProps: { key: "one" } });
  await waitFor(() => expect(mock.start).toHaveBeenCalledTimes(1));
  rerender({ key: "two" });
  await waitFor(() => expect(mock.start).toHaveBeenCalledTimes(2));
  await act(async () => { release("one"); });
  expect(mock.cancel).toHaveBeenCalledWith("one");
  act(() => emit(event("one")));
  expect(completed).not.toHaveBeenCalled();
  act(() => emit(event("two")));
  expect(completed).toHaveBeenCalledOnce();
});
it("拒绝不完整结果，显示错误并允许重试；卸载取消自己的任务", async () => {
  const completed = vi.fn();
  const { result, unmount } = renderHook(() => useLoanInspectionCompletion("one", {}, completed));
  await waitFor(() => expect(mock.start).toHaveBeenCalledOnce());
  act(() => emit(event("one", "completed", { ...full, sampledPreview: true, metadataComplete: false })));
  expect(completed).not.toHaveBeenCalled();
  expect(result.current.error).toContain("尚未补齐");
  mock.start.mockResolvedValue("retry");
  act(() => result.current.retry());
  await waitFor(() => expect(mock.start).toHaveBeenCalledTimes(2));
  unmount();
  expect(mock.cancel).toHaveBeenCalledWith("retry");
});
