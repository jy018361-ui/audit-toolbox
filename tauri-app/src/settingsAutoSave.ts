/** Serial, coalescing writes. Failure keeps the latest change available to retry. */
export type AutoSaveState = "idle" | "pending" | "saving" | "saved" | "error";
export class SettingsAutoSave {
  private static pendingWrites = new Set<SettingsAutoSave>();
  static async finishPendingWrites() {
    for (const writer of this.pendingWrites) await writer.flush();
  }
  private task?: () => Promise<void>;
  private running?: Promise<void>;
  private timer?: ReturnType<typeof setTimeout>;
  constructor(private notify: (state: AutoSaveState, error?: unknown) => void) {}
  get pending() { return Boolean(this.task || this.running); }
  schedule(task: () => Promise<void>, delay = 450) {
    SettingsAutoSave.pendingWrites.add(this);
    this.task = task;
    clearTimeout(this.timer);
    this.notify("pending");
    this.timer = setTimeout(() => { void this.flush().catch(() => undefined); }, delay);
  }
  flush(): Promise<void> {
    clearTimeout(this.timer);
    if (this.running) return this.running;
    if (!this.task) return Promise.resolve();
    this.running = (async () => {
      this.notify("saving");
      while (this.task) {
        const task = this.task;
        this.task = undefined;
        try { await task(); }
        catch (error) {
          this.task ??= task;
          clearTimeout(this.timer);
          this.notify("error", error);
          throw error;
        }
      }
      this.notify("saved");
    })().finally(() => {
      this.running = undefined;
      if (!this.task) SettingsAutoSave.pendingWrites.delete(this);
    });
    return this.running;
  }
}
