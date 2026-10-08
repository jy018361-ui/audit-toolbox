import { describe, expect, it, vi } from "vitest";
import type { JobEvent } from "./types";

const api = vi.hoisted(() => ({
  start: vi.fn(async () => "extract-1"),
  listener: undefined as undefined | ((event: JobEvent) => void),
}));
vi.mock("./api", () => ({
  jobStart: api.start,
  listenJobEvents: async (listener: (event: JobEvent) => void) => {
    api.listener = listener;
    return () => { api.listener = undefined; };
  },
}));

import { runAudiPickExtractJob } from "./audipickExtractJob";

function operation() {
  return {
    id: "operation-1",
    update: vi.fn(),
    finish: vi.fn(),
    attachJob: vi.fn(),
    detachJob: vi.fn(),
    checkpoint: vi.fn(async () => undefined),
  };
}

describe("runAudiPickExtractJob", () => {
  it("attaches the worker and returns its completed result", async () => {
    const handle = operation();
    const pending = runAudiPickExtractJob<{ parsed: { items: unknown[] } }>(
      { prompt: "p", text: "t" },
      handle,
    );
    await vi.waitFor(() => expect(api.listener).toBeTypeOf("function"));
    api.listener?.({
      jobId: "extract-1", toolId: "audipick", phase: "completed",
      current: 1, total: 1, message: "完成", severity: "success",
      outputPaths: [], result: { parsed: { items: [{ id: 1 }] } },
    });
    await expect(pending).resolves.toEqual({ parsed: { items: [{ id: 1 }] } });
    expect(handle.attachJob).toHaveBeenCalledWith("extract-1");
    expect(handle.detachJob).toHaveBeenCalledWith("extract-1");
  });

  it("rejects cancelled work without returning a partial result", async () => {
    const handle = operation();
    const pending = runAudiPickExtractJob({ prompt: "p", text: "t" }, handle);
    await vi.waitFor(() => expect(api.listener).toBeTypeOf("function"));
    api.listener?.({
      jobId: "extract-1", toolId: "audipick", phase: "cancelled",
      current: 0, total: 1, message: "提取已终止。", severity: "warning",
      outputPaths: [],
    });
    await expect(pending).rejects.toThrow("提取已终止");
  });
});
