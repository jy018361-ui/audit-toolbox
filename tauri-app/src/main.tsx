import React from "react";
import ReactDOM from "react-dom/client";
import { HashRouter } from "react-router-dom";
import App from "./App";
import "./styles.css";
import "./settings.css";
import "./merger.css";
import "./fa-dep-calc.css";
import { restoreSavedTheme } from "./theme";

// Before the first paint, so the window never flashes the default theme.
restoreSavedTheme();

// 无边框窗口：右上角有自绘的最小化/最大化/关闭按钮，主区顶部要为其留白。
// 首帧前打上标记，避免界面先渲染再整体下移（布局跳动）。预览模式没有标记。
if ("__TAURI_INTERNALS__" in window) {
  document.documentElement.classList.add("frameless");
}

const root = ReactDOM.createRoot(document.getElementById("root")!);

async function renderApp() {
  const params = new URLSearchParams(window.location.search);
  let content: React.ReactNode = <HashRouter><App /></HashRouter>;
  // 几何验收夹具仅由开发服务器按需加载；生产构建不会把夹具及其
  // 依赖打进主包，也不会改变桌面应用的启动路径。
  if (import.meta.env.DEV && params.has("overlay-fixture")) {
    const { OverlayStateFixture } = await import("./preview/OverlayStateFixture");
    content = <OverlayStateFixture />;
  } else if (import.meta.env.DEV && params.has("task-state-fixture")) {
    const { TaskStateFixture } = await import("./preview/TaskStateFixture");
    content = <TaskStateFixture />;
  }
  root.render(<React.StrictMode>{content}</React.StrictMode>);
}

void renderApp();
