// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cancelDemoJob,
  DEMO_FLAG_KEY,
  demoLookup,
  demoReplayJobs,
  injectDemoJobEvent,
  registerDemoReplayJob,
  resumeDemoReplayJob,
  setDemoAutoPlayback,
  subscribeDemoJobs,
  type DemoJobEvent,
} from "./demoRegistry";

let sequence = 0;
const id = () => `demo-job-test-${++sequence}`;
const events: DemoJobEvent[] = [
  { phase: "queued", current: 0, total: 2, message: "排队", severity: "info", outputPaths: [] },
  { phase: "running", current: 1, total: 2, message: "处理", severity: "info", outputPaths: [] },
  { phase: "completed", current: 2, total: 2, message: "完成", severity: "success", outputPaths: ["C:\\结果.xlsx"], result: { rows: 2 } },
];

afterEach(() => {
  setDemoAutoPlayback(true);
  localStorage.removeItem(DEMO_FLAG_KEY);
  vi.useRealTimers();
});

describe("browser preview task replay", () => {
  it("holds automatic playback and injects terminal events through the normal listeners", () => {
    vi.useFakeTimers();
    setDemoAutoPlayback(false);
    const jobId = id();
    const seen: string[] = [];
    const unsubscribe = subscribeDemoJobs((event) => {
      if (event.jobId === jobId) seen.push(event.phase);
    });
    registerDemoReplayJob(jobId, "tbje_check.run_batch", "tbje_check", events);
    vi.advanceTimersByTime(2_000);
    expect(seen).toEqual([]);
    expect(demoReplayJobs().find((job) => job.jobId === jobId)).toMatchObject({
      method: "tbje_check.run_batch", toolId: "tbje_check", plannedPhases: ["queued", "running", "completed"],
    });
    injectDemoJobEvent(jobId, "running", { message: "审计长文件名与错误排版" });
    const finished = injectDemoJobEvent(jobId, "completed");
    expect(seen).toEqual(["running", "completed"]);
    expect(finished?.result).toEqual({ rows: 2 });
    expect(finished?.outputPaths).toEqual(["C:\\结果.xlsx"]);
    expect(resumeDemoReplayJob(jobId)).toBe(false);
    unsubscribe();
  });

  it("can stop scheduled playback and later resume from the next event", () => {
    vi.useFakeTimers();
    setDemoAutoPlayback(true);
    const jobId = id();
    const seen: string[] = [];
    const unsubscribe = subscribeDemoJobs((event) => {
      if (event.jobId === jobId) seen.push(event.phase);
    });
    registerDemoReplayJob(jobId, "file_list.scan", "file_list_directory", events);
    vi.advanceTimersByTime(270);
    expect(seen).toEqual(["queued"]);
    setDemoAutoPlayback(false);
    vi.advanceTimersByTime(2_000);
    expect(seen).toEqual(["queued"]);
    expect(resumeDemoReplayJob(jobId)).toBe(true);
    vi.advanceTimersByTime(600);
    expect(seen).toEqual(["queued", "running", "completed"]);
    unsubscribe();
  });

  it("emits a cancelled event when a preview job is stopped", () => {
    vi.useFakeTimers();
    setDemoAutoPlayback(false);
    const jobId = id();
    const seen: string[] = [];
    const unsubscribe = subscribeDemoJobs((event) => {
      if (event.jobId === jobId) seen.push(event.phase);
    });
    registerDemoReplayJob(jobId, "fx.run", "fx_audit", events);
    expect(cancelDemoJob(jobId)).toBe(true);
    expect(seen).toEqual(["cancelled"]);
    expect(injectDemoJobEvent(jobId, "completed")).toBeUndefined();
    unsubscribe();
  });
});

describe("browser preview shared engine handlers", () => {
  it("keeps FX currency mappings while preserving the TBJE sheet fixture", () => {
    localStorage.setItem(DEMO_FLAG_KEY, "1");
    const inspectTb = demoLookup("fx.inspect_tb");

    const fx = inspectTb?.({ source: { sheet: "TB" } }) as {
      suggestedMapping?: Record<string, unknown>;
    };
    const tbje = inspectTb?.({ source: { sheet: "科目余额表" } }) as {
      suggestedMapping?: Record<string, unknown>;
    };

    expect(fx.suggestedMapping).toMatchObject({
      currency: "币种",
      openingFunctionalAmount: "期初余额",
      closingFunctionalAmount: "期末余额",
    });
    expect(tbje.suggestedMapping).toMatchObject({
      accountCode: "科目编码",
      closingFunctionalAmount: "期末余额",
    });
    expect(tbje.suggestedMapping).not.toHaveProperty("currency");
  });
});
