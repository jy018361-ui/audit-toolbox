import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

/**
 * 无边框窗口（tauri.conf.json `decorations: false`）右上角的自绘按钮：
 * 最小化 / 最大化-还原 / 关闭。
 *
 * 拖动窗口的职责不在这里，而在品牌区与页头（`data-tauri-drag-region`）；
 * 按钮上绝不能带 drag-region，否则点不下去。
 * 预览模式（浏览器直接开 dev server）没有 Tauri 窗口 API，渲染为空。
 */
const inTauriEnv =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/* 与 App.tsx 里 IconHome 同一套路：10×10 描边小图标，不用 emoji。 */
function IconMinimize() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
      <path d="M0.5 5h9" stroke="currentColor" strokeWidth="1" />
    </svg>
  );
}

function IconMaximize() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
      <rect
        x="0.5"
        y="0.5"
        width="9"
        height="9"
        fill="none"
        stroke="currentColor"
        strokeWidth="1"
      />
    </svg>
  );
}

function IconRestore() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
      <rect
        x="3"
        y="0.5"
        width="6.5"
        height="6.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1"
      />
      <path
        d="M0.5 3v6.5H7"
        fill="none"
        stroke="currentColor"
        strokeWidth="1"
      />
    </svg>
  );
}

function IconClose() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
      <path d="M1 1l8 8M9 1l-8 8" stroke="currentColor" strokeWidth="1" />
    </svg>
  );
}

export function WindowControls() {
  const [maximized, setMaximized] = useState(false);
  useEffect(() => {
    if (!inTauriEnv) return;
    const appWindow = getCurrentWindow();
    let alive = true;
    // 最大化/还原要换图标，跟随窗口尺寸变化重新查询；
    // 查询失败（窗口销毁竞态）静默忽略即可。
    const sync = () => {
      void appWindow
        .isMaximized()
        .then((value) => {
          if (alive) setMaximized(value);
        })
        .catch(() => undefined);
    };
    const off = appWindow.onResized(() => sync());
    sync();
    return () => {
      alive = false;
      void off.then((fn) => fn()).catch(() => undefined);
    };
  }, []);
  if (!inTauriEnv) return null;
  const appWindow = getCurrentWindow();
  return (
    <div className="window-controls" role="group" aria-label="窗口控制">
      <button
        type="button"
        title="最小化"
        aria-label="最小化"
        onClick={() => void appWindow.minimize()}
      >
        <IconMinimize />
      </button>
      <button
        type="button"
        title={maximized ? "向下还原" : "最大化"}
        aria-label={maximized ? "向下还原" : "最大化"}
        onClick={() => void appWindow.toggleMaximize()}
      >
        {maximized ? <IconRestore /> : <IconMaximize />}
      </button>
      <button
        type="button"
        className="window-controls-close"
        title="关闭"
        aria-label="关闭"
        onClick={() => void appWindow.close()}
      >
        <IconClose />
      </button>
    </div>
  );
}
