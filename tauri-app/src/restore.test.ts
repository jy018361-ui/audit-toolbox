// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  consumeTaskRestore,
  publishTaskRestore,
  subscribeTaskRestore,
  useTaskRestore,
} from "./restore";
import type { TaskRestore } from "./types";

const make = (
  toolId: string,
  params: Record<string, unknown> = { inputPath: "C:\\a.xlsx" },
): TaskRestore => ({
  jobId: `job-${toolId}`,
  toolId,
  params,
  missingPaths: [],
  authorizedPathCount: 1,
});

describe("task restore channel", () => {
  beforeEach(() => {
    // 模块级 pending 会跨用例残留：用一个哨兵恢复包顶掉再取走，保证排空。
    publishTaskRestore({
      jobId: "",
      toolId: "__drain__",
      params: { sentinel: true },
      missingPaths: [],
      authorizedPathCount: 0,
    });
    expect(consumeTaskRestore("__drain__")).not.toBeNull();
  });

  it("consumes a matching restore exactly once and ignores other tools", () => {
    publishTaskRestore(make("fx_audit"));
    expect(consumeTaskRestore("deposit_interest")).toBeNull();
    const restore = consumeTaskRestore("fx_audit");
    expect(restore?.jobId).toBe("job-fx_audit");
    expect(consumeTaskRestore("fx_audit")).toBeNull();
  });

  it("notifies subscribers on publish", () => {
    const seen: string[] = [];
    const stop = subscribeTaskRestore((restore) => seen.push(restore.toolId));
    publishTaskRestore(make("kanzhang"));
    expect(seen).toEqual(["kanzhang"]);
    stop();
    publishTaskRestore(make("ts_manager"));
    expect(seen).toEqual(["kanzhang"]);
  });

  it("routes fa_list restores by params shape to the matching sub-page", () => {
    publishTaskRestore(
      make("fa_list", {
        tbSource: { inputPath: "C:\\tb.xlsx" },
        jeSource: { inputPath: "C:\\je.xlsx" },
      }),
    );
    expect(consumeTaskRestore("fa_list")).toBeNull();
    expect(consumeTaskRestore("fa_list:cards")).toBeNull();
    expect(consumeTaskRestore("fa_list:tbje")?.toolId).toBe("fa_list");

    publishTaskRestore(
      make("fa_list", { beginPath: "C:\\begin.xlsx", endPath: "C:\\end.xlsx" }),
    );
    expect(consumeTaskRestore("fa_list:tbje")).toBeNull();
    expect(consumeTaskRestore("fa_list:cards")?.toolId).toBe("fa_list");
  });

  it("delivers to mounted pages and skips empty params", () => {
    const apply = vi.fn();
    const { result, rerender, unmount } = renderHook(
      ({ toolId }: { toolId: string }) => useTaskRestore(toolId, apply),
      { initialProps: { toolId: "wp_service_generator" } },
    );
    expect(result.current).toBeUndefined();

    // 页面已挂载：publish 即送达。
    act(() => {
      publishTaskRestore(make("wp_service_generator", { folder: "C:\\wp" }));
    });
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply.mock.calls[0][0].params).toEqual({ folder: "C:\\wp" });

    // 其他工具的恢复不送达。
    act(() => {
      publishTaskRestore(make("fx_audit"));
    });
    expect(apply).toHaveBeenCalledTimes(1);

    // 空参数（旧版本任务）不触发回填。
    act(() => {
      publishTaskRestore(make("wp_service_generator", {}));
    });
    expect(apply).toHaveBeenCalledTimes(1);
    rerender({ toolId: "wp_service_generator" });
    unmount();

    // 页面未挂载：publish 后挂载，挂载时消费 pending。
    const late = vi.fn();
    act(() => {
      publishTaskRestore(make("wp_service_generator", { folder: "C:\\late" }));
    });
    renderHook(() => useTaskRestore("wp_service_generator", late));
    expect(late).toHaveBeenCalledTimes(1);
    expect(late.mock.calls[0][0].params).toEqual({ folder: "C:\\late" });
  });
});
