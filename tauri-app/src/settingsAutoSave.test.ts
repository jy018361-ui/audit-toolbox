import { afterEach, expect, it, vi } from "vitest";
import { SettingsAutoSave } from "./settingsAutoSave";
afterEach(() => vi.useRealTimers());

it("coalesces typing and serializes changes arriving during a write", async () => {
  vi.useFakeTimers();
  let release!: () => void;
  const order: string[] = [];
  const writer = new SettingsAutoSave(vi.fn());
  writer.schedule(async () => { order.push("discarded"); });
  writer.schedule(async () => { order.push("first"); await new Promise<void>(resolve => { release = resolve; }); });
  await vi.advanceTimersByTimeAsync(450);
  writer.schedule(async () => { order.push("latest"); });
  expect(order).toEqual(["first"]);
  release();
  await writer.flush();
  expect(order).toEqual(["first", "latest"]);
  expect(writer.pending).toBe(false);
});

it("keeps a failed change retryable and waits for writes before reopening", async () => {
  const notify = vi.fn();
  const writer = new SettingsAutoSave(notify);
  const save = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(undefined);
  writer.schedule(save);
  await expect(writer.flush()).rejects.toThrow("offline");
  expect(writer.pending).toBe(true);
  expect(notify).toHaveBeenLastCalledWith("error", expect.any(Error));
  await SettingsAutoSave.finishPendingWrites();
  expect(save).toHaveBeenCalledTimes(2);
  expect(writer.pending).toBe(false);
  expect(notify).toHaveBeenLastCalledWith("saved");
});
