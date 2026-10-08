import { describe, expect, it } from "vitest";
import type { JobEvent } from "@/types";
import { reconcileJobState } from "./useJobEvents";

const event = (phase: string): JobEvent => ({
  jobId: "job-fast",
  toolId: "fa_dep_calc",
  phase,
  current: phase === "queued" ? 0 : 1,
  total: 1,
  message: phase,
  severity: phase === "failed" ? "error" : "info",
  outputPaths: [],
});

describe("useJobEvents state reconciliation", () => {
  it("does not let a synthetic queued state overwrite an early terminal event", () => {
    expect(reconcileJobState(event("failed"), event("queued"))?.phase).toBe(
      "failed",
    );
    expect(
      reconcileJobState(event("completed"), event("queued"))?.phase,
    ).toBe("completed");
  });

  it("accepts queued for a different job and later progress for the same job", () => {
    const queued = { ...event("queued"), jobId: "job-next" };
    expect(reconcileJobState(event("completed"), queued)).toEqual(queued);
    expect(reconcileJobState(event("queued"), event("load"))?.phase).toBe(
      "load",
    );
  });
});
