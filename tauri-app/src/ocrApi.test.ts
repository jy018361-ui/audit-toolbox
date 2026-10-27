import { beforeEach, expect, it, vi } from "vitest";
import type { JobEvent } from "./types";
const mocks = vi.hoisted(() => ({
  engineCall: vi.fn(), jobStart: vi.fn(), off: vi.fn(), listener: undefined as undefined | ((event: JobEvent) => void),
}));
vi.mock("./api", () => ({
  engineCall: mocks.engineCall, jobStart: mocks.jobStart,
  listenJobEvents: vi.fn(async (listener) => { mocks.listener = listener; return mocks.off; }),
}));
import { ocrCall, runOcrJob } from "./ocrApi";
const event = (overrides: Partial<JobEvent> = {}): JobEvent => ({
  jobId: "j1", toolId: "ocr", phase: "completed", current: 1, total: 1, message: "完成", severity: "success", outputPaths: [], result: { outputPaths: ["C:\\样例.xlsx"] }, ...overrides,
});
beforeEach(() => { vi.clearAllMocks(); mocks.listener = undefined; });

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
