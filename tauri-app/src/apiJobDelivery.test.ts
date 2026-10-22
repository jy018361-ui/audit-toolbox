// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JobEvent } from "./types";

const native = vi.hoisted(() => ({
  invoke: vi.fn(),
  listeners: new Set<(event: { payload: unknown }) => void>(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: native.invoke }));
vi.mock("@tauri-apps/api/event", () => ({
  emit: vi.fn(),
  listen: vi.fn(async (_name: string, handler: (event: { payload: unknown }) => void) => {
    native.listeners.add(handler);
    return () => { native.listeners.delete(handler); };
  }),
}));
import { jobStart, listenJobEvents } from "./api";

const event = (jobId: string, toolId: string, phase = "completed"): JobEvent => ({
  jobId, toolId, phase, current: 1, total: 1,
  message: phase, severity: "info", outputPaths: ["C:/output.xlsx"],
  result: { outputPaths: ["C:/output.xlsx"] },
});
function emit(value: JobEvent) {
  for (const listener of native.listeners) listener({ payload: value });
}

describe("桌面任务公共事件投递", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("__TAURI_INTERNALS__", {});
    native.invoke.mockReset();
  });
  afterEach(async () => {
    await vi.runAllTimersAsync();
    native.listeners.clear();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it.each([
    ["deposit.export", "deposit_interest"],
    ["fx.export", "fx_audit"],
    ["loan.export", "loan_interest"],
    ["tbje_check.export_batch", "tbje_check"],
    ["excel_merger.merge", "Excel_Merger"],
    ["fa.dep_export", "fa_dep_calc"],
    ["fa.policy_export", "fa_policy_compare"],
    ["file_list.export", "file_list_directory"],
    ["confirmation.process", "confirmation_progress"],
    ["fuzzy.export", "fuzzy_match"],
    ["roll_forward.process", "audit_roll_forward"],
    ["ts.export", "ts_manager"],
    ["pdf2excel.convert", "pdf_to_excel"],
    ["wp.generate", "wp_service_generator"],
  ])("%s 的提前完成通知不会丢失或被排队状态覆盖", async (method, toolId) => {
    let active = "previous";
    let phase = "previous-completed";
    let busy = true;
    const accepted: JobEvent[] = [];
    const off = await listenJobEvents((value) => {
      if (value.jobId !== active) return;
      phase = value.phase;
      busy = false;
      accepted.push(value);
    });
    native.invoke.mockImplementationOnce(async () => {
      emit(event(method, toolId));
      return method;
    });
    active = await jobStart(method, {});
    phase = "queued";
    expect(accepted).toEqual([]);
    await vi.runAllTimersAsync();
    expect(phase).toBe("completed");
    expect(busy).toBe(false);
    expect(accepted).toHaveLength(1);
    expect(accepted[0].outputPaths).toEqual(["C:/output.xlsx"]);
    off();
  });

  it.each(["failed", "cancelled"])("提前 %s 通知也交给页面恢复状态", async (phase) => {
    const callback = vi.fn();
    const off = await listenJobEvents(callback);
    native.invoke.mockImplementationOnce(async () => {
      emit(event(`${phase}-terminal`, "deposit_interest", phase));
      return `${phase}-terminal`;
    });
    await jobStart("deposit.export", {});
    expect(callback).not.toHaveBeenCalled();
    await vi.runAllTimersAsync();
    expect(callback).toHaveBeenCalledWith(expect.objectContaining({ phase }));
    off();
  });

  it("启动拒绝不锁住其他事件，退订后不投递延迟事件", async () => {
    const callback = vi.fn();
    const off = await listenJobEvents(callback);
    native.invoke.mockImplementationOnce(async () => {
      emit(event("other", "loan_interest"));
      throw new Error("启动失败");
    });
    await expect(jobStart("deposit.export", {})).rejects.toThrow("启动失败");
    off();
    await vi.runAllTimersAsync();
    expect(callback).not.toHaveBeenCalled();
    const next = vi.fn();
    const stop = await listenJobEvents(next);
    emit(event("after", "loan_interest"));
    expect(next).toHaveBeenCalledOnce();
    stop();
  });
});
