/**
 * 新手引导的本地记忆：哪些引导看过、是否自动播放工具引导。
 * 纯界面偏好，与主题一样存 localStorage（键名沿用 audit-toolbox 前缀），
 * 不走后端 settings，避免为一条界面标记增加跨进程读写。
 */
const TOUR_STORAGE_KEY = "audit-toolbox.newbie-tour.v2";

export type TourState = {
  /** 新手模式总开关（侧边栏标题旁），默认开；关掉后不自动播放任何引导。 */
  newbieMode?: boolean;
  /** 工作台导览是否播放过（含用户主动跳过）。 */
  workspaceDone?: boolean;
};

/** 只有 Tauri 桌面端才做"首次启动自动播放"；浏览器预览/测试环境不主动打扰。 */
export function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export function loadTourState(): TourState {
  try {
    const raw = window.localStorage.getItem(TOUR_STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    return parsed as TourState;
  } catch {
    return {};
  }
}

export function saveTourState(patch: TourState): TourState {
  const next = { ...loadTourState(), ...patch };
  try {
    window.localStorage.setItem(TOUR_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // 隐私模式下写不进去也不影响本次引导，只是下次会再播一遍。
  }
  return next;
}
