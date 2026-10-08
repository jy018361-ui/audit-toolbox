// 工具页「有现场」登记表。
//
// 规则（2026-09 与用户确认）：页面一旦发生过用户交互（点击/输入）、
// 启动过任务、恢复过历史参数或带着草稿缓存重挂载，就视为「有现场」；
// 有现场的页面不参与「最近使用」淘汰，一直保活到应用退出。
// 只有从未动过的空白页面才按 LRU 清理。登记表只存在内存里，
// EXE 退出即全部清空，不做持久化。
//
// 信号来源（防止漏标）：
// - PersistentToolPages 在页面容器上委托监听 click/change；
// - App 收到任何任务事件（job-event）时按 toolId 登记；
// - 历史页「继续任务」回填成功时登记（程序赋值不触发 DOM 事件）；
// - 自带草稿缓存的页面重挂载且缓存非空时登记。
const liveToolPages = new Set<string>();

/** 把一个工具页标记为「有现场」。空 id 忽略。 */
export function markToolPageLive(toolId: string | null | undefined): void {
  if (toolId) liveToolPages.add(toolId);
}

export function toolPageIsLive(toolId: string): boolean {
  return liveToolPages.has(toolId);
}

/** 当前有现场的页集合快照（PersistentToolPages 每次重算保活名单时读取）。 */
export function liveToolPageIds(): Set<string> {
  return new Set(liveToolPages);
}

/** 仅测试用：隔离各用例的登记状态。 */
export function clearToolPageActivityForTests(): void {
  liveToolPages.clear();
}
