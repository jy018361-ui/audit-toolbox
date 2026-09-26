import React from "react";
import ReactDOM from "react-dom/client";
import { createHashRouter, RouterProvider } from "react-router-dom";
import App from "./App";
import AudiPickWindow from "./AudiPickWindow";
import "./styles.css";
import "./settings.css";
import "./merger.css";
import "./fa-dep-calc.css";
import "./table-resize.css";
import { restoreSavedTheme } from "./theme";
import { ApplicationErrorBoundary } from "./components/ApplicationErrorBoundary";

// Before the first paint, so the window never flashes the default theme.
restoreSavedTheme();

// 无边框窗口：右上角有自绘的最小化/最大化/关闭按钮，主区顶部要为其留白。
// 首帧前打上标记，避免界面先渲染再整体下移（布局跳动）。预览模式没有标记。
if ("__TAURI_INTERNALS__" in window) {
  document.documentElement.classList.add("frameless");
}

const root = ReactDOM.createRoot(document.getElementById("root")!);
const appRouter = createHashRouter([{ path: "*", element: <App /> }]);

async function renderApp() {
  const params = new URLSearchParams(window.location.search);
  let content: React.ReactNode = <RouterProvider router={appRouter} />;
  // 几何验收夹具仅由开发服务器按需加载；生产构建不会把夹具及其
  // 依赖打进主包，也不会改变桌面应用的启动路径。
  if (import.meta.env.DEV && params.has("overlay-fixture")) {
    const { OverlayStateFixture } = await import("./preview/OverlayStateFixture");
    content = <OverlayStateFixture />;
  } else if (import.meta.env.DEV && params.has("task-state-fixture")) {
    const { TaskStateFixture } = await import("./preview/TaskStateFixture");
    content = <TaskStateFixture />;
  } else if (import.meta.env.DEV && params.has("fa-pivot-fixture")) {
    const { FaPivotFixture } = await import("./preview/FaPivotFixture");
    content = <FaPivotFixture />;
  } else if (import.meta.env.DEV && params.has("col-resize-fixture")) {
    const { ColResizeFixture } = await import("./preview/ColResizeFixture");
    content = <ColResizeFixture />;
  }
  root.render(
    <React.StrictMode>
      <ApplicationErrorBoundary>{content}</ApplicationErrorBoundary>
    </React.StrictMode>,
  );
}

void renderApp();
