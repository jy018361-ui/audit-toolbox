export const OCR_CONCURRENCY = 5;

/** A document stays open until every in-flight page has settled, even on cancel. */
export async function runOcrPool<T>(
  items: readonly T[],
  work: (item: T) => Promise<void>,
  concurrency = OCR_CONCURRENCY,
): Promise<void> {
  let next = 0;
  let stopped = false;
  const results = await Promise.allSettled(
    Array.from({ length: Math.min(items.length, concurrency) }, async () => {
      try {
        while (!stopped && next < items.length) {
          const item = items[next++];
          await work(item);
        }
      } catch (error) {
        stopped = true;
        throw error;
      }
    }),
  );
  const failed = results.find((result) => result.status === "rejected");
  if (failed?.status === "rejected") throw failed.reason;
}

export class OcrOperation {
  cancelled = false;
  paused = false;
  readonly jobIds = new Set<string>();
  private readonly waiters = new Set<() => void>();

  wake() {
    for (const resolve of this.waiters) resolve();
    this.waiters.clear();
  }

  async checkpoint() {
    while (this.paused && !this.cancelled) {
      await new Promise<void>((resolve) => this.waiters.add(resolve));
    }
    if (this.cancelled) {
      throw new Error("任务已取消，已完成内容已保存，可稍后继续。");
    }
  }
}
