import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JobStartDelivery } from "./jobStartDelivery";

describe("任务启动与完成通知顺序", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("完成通知等到调用方记录任务编号与排队状态后再投递", async () => {
    const delivery = new JobStartDelivery();
    const finish = delivery.begin();
    const state = { id: "", phase: "" };
    delivery.deliver("fast", () => {
      if (state.id === "fast") state.phase = "completed";
    });
    finish("fast");
    await Promise.resolve();
    state.id = "fast";
    state.phase = "queued";
    expect(state.phase).toBe("queued");
    await vi.runAllTimersAsync();
    expect(state.phase).toBe("completed");
  });

  it("两个并发启动分别释放，慢请求不阻挡已返回的快任务", async () => {
    const delivery = new JobStartDelivery();
    const slow = delivery.begin();
    const fast = delivery.begin();
    const phases: string[] = [];
    delivery.deliver("fast", () => phases.push("completed"));
    fast("fast");
    await vi.runAllTimersAsync();
    expect(phases).toEqual(["completed"]);
    delivery.deliver("fast", () => phases.push("late"));
    expect(phases).toEqual(["completed", "late"]);
    slow("slow");
    await vi.runAllTimersAsync();
  });

  it("其他启动请求不延迟已运行任务的进度", async () => {
    const delivery = new JobStartDelivery();
    const callback = vi.fn();
    delivery.deliver("running", callback);
    const finish = delivery.begin();
    delivery.deliver("running", callback);
    expect(callback).toHaveBeenCalledTimes(2);
    finish();
    await vi.runAllTimersAsync();
  });

  it("启动失败也释放外部任务事件，并保持同任务通知顺序", async () => {
    const delivery = new JobStartDelivery();
    const finish = delivery.begin();
    const phases: string[] = [];
    for (const phase of ["queued", "running", "failed"])
      delivery.deliver("external", () => phases.push(phase));
    finish();
    finish();
    expect(phases).toEqual([]);
    await vi.runAllTimersAsync();
    expect(phases).toEqual(["queued", "running", "failed"]);
  });
});
