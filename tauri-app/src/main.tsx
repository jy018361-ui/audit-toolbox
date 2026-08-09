import React from "react";
import ReactDOM from "react-dom/client";
import { HashRouter } from "react-router-dom";
import App from "./App";
import "./styles.css";
import "./settings.css";
import "./merger.css";
import { restoreSavedTheme } from "./theme";

// Before the first paint, so the window never flashes the default theme.
restoreSavedTheme();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode><HashRouter><App /></HashRouter></React.StrictMode>
);
