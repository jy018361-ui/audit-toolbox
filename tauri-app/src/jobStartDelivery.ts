/** job_start 的通知可能早于 IPC 返回；下一轮事件循环再投递，
 * 让调用方先保存返回的 jobId 和排队状态。只等待启动响应，不等待任务结束。
 */
export class JobStartDelivery {
  private readonly pending = new Set<object>();
  private readonly knownJobs = new Set<string>();
  private readonly waiting = new Map<string, Array<() => void>>();

  begin(): (jobId?: string) => void {
    const token = {};
    this.pending.add(token);
    let finished = false;
    return (jobId) => {
      if (finished) return;
      finished = true;
      setTimeout(() => {
        this.pending.delete(token);
        if (jobId) {
          this.remember(jobId);
          this.flush(jobId);
        }
        if (!this.pending.size)
          for (const id of this.waiting.keys()) this.flush(id);
      }, 0);
    };
  }

  deliver(jobId: string, callback: () => void): void {
    // 已在运行的任务不被另一项尚未返回的启动请求拖住。
    if (!this.pending.size || this.knownJobs.has(jobId)) {
      this.remember(jobId);
      callback();
      return;
    }
    const callbacks = this.waiting.get(jobId) ?? [];
    callbacks.push(callback);
    this.waiting.set(jobId, callbacks);
  }

  private remember(jobId: string): void {
    this.knownJobs.add(jobId);
    if (this.knownJobs.size > 256)
      this.knownJobs.delete(this.knownJobs.values().next().value!);
  }

  private flush(jobId: string): void {
    const callbacks = this.waiting.get(jobId) ?? [];
    this.waiting.delete(jobId);
    for (const callback of callbacks) callback();
  }
}
