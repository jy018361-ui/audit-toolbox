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

/* 统一 12×12 画布和线宽，让三种窗口动作具有一致的视觉重量。 */
function IconMinimize() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 12 12"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M2 6h8"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinecap="round"
      />
    </svg>
  );
}

function IconMaximize() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
      <rect
        x="2"
        y="2"
        width="8"
        height="8"
        rx="1"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.25"
      />
    </svg>
  );
}

function IconRestore() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 12 12"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M4 2h5a1 1 0 0 1 1 1v5"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinecap="round"
      />
      <rect
        x="2"
        y="4"
        width="6"
        height="6"
        rx="1"
        stroke="currentColor"
        strokeWidth="1.25"
      />
    </svg>
  );
}

function IconClose() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 12 12"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="m2.5 2.5 7 7m0-7-7 7"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinecap="round"
      />
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
