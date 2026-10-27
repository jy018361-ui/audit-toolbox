import { beforeEach, expect, it, vi } from "vitest";
import type { JobEvent } from "./types";
const mocks = vi.hoisted(() => ({
  engineCall: vi.fn(), jobStart: vi.fn(), off: vi.fn(), listener: undefined as undefined | ((event: JobEvent) => void),
  listeners: new Set<(event: JobEvent) => void>(),
}));
vi.mock("./api", () => ({
  engineCall: mocks.engineCall, jobStart: mocks.jobStart,
  listenJobEvents: vi.fn(async (listener) => {
    mocks.listener = listener;
    mocks.listeners.add(listener);
    return () => { mocks.listeners.delete(listener); mocks.off(); };
  }),
}));
import { ocrCall, runOcrJob } from "./ocrApi";
const event = (overrides: Partial<JobEvent> = {}): JobEvent => ({
  jobId: "j1", toolId: "ocr", phase: "completed", current: 1, total: 1, message: "完成", severity: "success", outputPaths: [], result: { outputPaths: ["C:\\样例.xlsx"] }, ...overrides,
});
beforeEach(() => { vi.clearAllMocks(); mocks.listener = undefined; mocks.listeners.clear(); });

it("rejects malformed engine results instead of showing a completed project", async () => {
  mocks.engineCall.mockResolvedValue({ projects: [{ id: "broken" }] });
  await expect(ocrCall("ocr.projects", {})).rejects.toThrow("数据格式不完整");
});
it("does not dispatch unknown methods", async () => {
  await expect(ocrCall("ocr.unknown", {})).rejects.toThrow("未找到");
  expect(mocks.engineCall).not.toHaveBeenCalled();
});
it("receives completion emitted before job_start returns and ignores other jobs", async () => {
  mocks.jobStart.mockImplementation(async () => {
    mocks.listener!(event({ jobId: "another" }));
    mocks.listener!(event({ toolId: "audipick" }));
    mocks.listener!(event());
    return "j1";
  });
  const onEvent = vi.fn();
  await expect(runOcrJob("ocr.export", {}, undefined, onEvent)).resolves.toEqual({ outputPaths: ["C:\\样例.xlsx"] });
  expect(onEvent).toHaveBeenCalledTimes(1);
  expect(mocks.off).toHaveBeenCalledOnce();
});
it("cleans up subscriptions when the worker cannot start", async () => {
  mocks.jobStart.mockRejectedValue(new Error("启动失败"));
  await expect(runOcrJob("ocr.extract", {})).rejects.toThrow("启动失败");
  expect(mocks.off).toHaveBeenCalledOnce();
});
it("rejects invalid completed page payloads and surfaces structured worker failures", async () => {
  mocks.jobStart.mockImplementation(async () => { mocks.listener!(event({ result: { text: "只有文字" } })); return "j1"; });
  await expect(runOcrJob("ocr.recognize_page", {})).rejects.toThrow("数据格式不完整");
  mocks.jobStart.mockImplementation(async () => { mocks.listener!(event({ phase: "failed", result: { error: { userMessage: "表格结果被截断" } } })); return "j1"; });
  await expect(runOcrJob("ocr.recognize_page", {})).rejects.toThrow("表格结果被截断");
});

it("isolates concurrent jobs including early out-of-order completion and releases every listener", async () => {
  const starts = new Map<number, (id: string) => void>();
  mocks.jobStart.mockImplementation((_method, params) => new Promise((resolve) => starts.set(params.page, resolve)));
  const timing = vi.fn();
  const jobs = [1, 2, 3].map((page) => runOcrJob("ocr.export", { page }, undefined, undefined, timing));
  await vi.waitFor(() => expect(starts.size).toBe(3));
  const emit = (page: number) => {
    for (const listener of mocks.listeners) listener(event({ jobId: `j${page}`, result: { outputPaths: [`page-${page}.xlsx`] } }));
  };
  emit(2);
  starts.get(2)!("j2");
  await expect(jobs[1]).resolves.toEqual({ outputPaths: ["page-2.xlsx"] });
  expect(mocks.listeners.size).toBe(2);
  starts.get(1)!("j1");
  starts.get(3)!("j3");
  await Promise.resolve();
  emit(3);
  emit(1);
  await expect(Promise.all(jobs)).resolves.toEqual([1, 2, 3].map((page) => ({ outputPaths: [`page-${page}.xlsx`] })));
  expect(mocks.off).toHaveBeenCalledTimes(3);
  expect(mocks.listeners.size).toBe(0);
  expect(timing).toHaveBeenCalledTimes(3);
  expect(timing).toHaveBeenCalledWith({ startMs: expect.any(Number), totalMs: expect.any(Number) });
});

it("reports elapsed time when submission fails and rejects invalid stage timings", async () => {
  mocks.jobStart.mockRejectedValueOnce(new Error("启动失败"));
  const timing = vi.fn();
  await expect(runOcrJob("ocr.export", {}, undefined, undefined, timing)).rejects.toThrow("启动失败");
  expect(timing).toHaveBeenCalledWith({ startMs: expect.any(Number), totalMs: expect.any(Number) });
  expect(mocks.listeners.size).toBe(0);
  const page = { page: 1, text: "原文", originalText: "原文", tables: [], originalTables: [], revision: 1, status: "completed", warnings: [] };
  const timings = { setupMs: 1, imageMs: 2, recognitionMs: 30, structureMs: 0, saveMs: 3, workerMs: 40 };
  mocks.engineCall.mockResolvedValueOnce({ ...page, timings });
  await expect(ocrCall("ocr.recognize_page", {})).resolves.toEqual({ ...page, timings });
  mocks.engineCall.mockResolvedValueOnce({ ...page, timings: { ...timings, queueMs: 125 } });
  await expect(ocrCall("ocr.recognize_page", {})).resolves.toEqual({ ...page, timings: { ...timings, queueMs: 125 } });
  mocks.engineCall.mockResolvedValueOnce({ ...page, timings: { ...timings, queueMs: -1 } });
  await expect(ocrCall("ocr.recognize_page", {})).rejects.toThrow("数据格式不完整");
  mocks.engineCall.mockResolvedValueOnce({ ...page, timings: { ...timings, recognitionMs: -1 } });
  await expect(ocrCall("ocr.recognize_page", {})).rejects.toThrow("数据格式不完整");
});
