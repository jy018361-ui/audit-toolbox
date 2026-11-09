import { expect, it, vi } from "vitest";
import { OcrOperation, runOcrPool } from "./ocrBatch";

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

it("defaults to five slots and drains them after a fatal error before returning", async () => {
  const pages = Array.from({ length: 7 }, deferred);
  const entered: number[] = [];
  const run = runOcrPool([0, 1, 2, 3, 4, 5, 6], async (page) => {
    entered.push(page);
    await pages[page].promise;
  });
  const settled = vi.fn();
  const result = run.then(
    () => undefined,
    (error) => {
      settled();
      return error;
    },
  );
  expect(entered).toEqual([0, 1, 2, 3, 4]);
  pages[1].resolve();
  await vi.waitFor(() => expect(entered).toEqual([0, 1, 2, 3, 4, 5]));
  pages[0].reject(new Error("取消"));
  await Promise.resolve();
  expect(settled).not.toHaveBeenCalled();
  pages[2].resolve();
  pages[3].resolve();
  pages[4].resolve();
  pages[5].resolve();
  expect((await result)?.message).toBe("取消");
  expect(entered).toEqual([0, 1, 2, 3, 4, 5]);
});

it("wakes every paused slot on resume and cancel", async () => {
  const active = new OcrOperation();
  active.paused = true;
  const resumed = vi.fn();
  const waits = [1, 2, 3, 4, 5].map(async () => {
    await active.checkpoint();
    resumed();
  });
  expect(resumed).not.toHaveBeenCalled();
  active.paused = false;
  active.wake();
  await Promise.all(waits);
  expect(resumed).toHaveBeenCalledTimes(5);
  active.paused = true;
  const cancelled = Promise.allSettled(
    [1, 2, 3, 4, 5].map(() => active.checkpoint()),
  );
  active.cancelled = true;
  active.wake();
  expect(
    (await cancelled).every((result) => result.status === "rejected"),
  ).toBe(true);
});
