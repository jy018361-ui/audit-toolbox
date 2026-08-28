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

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode><HashRouter><App /></HashRouter></React.StrictMode>
);
