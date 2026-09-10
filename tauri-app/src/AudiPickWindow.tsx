import { lazy, Suspense, useEffect, useState } from "react";
import { invalidateHistoryCache, listenJobEvents, toolCatalog } from "./api";
import type { JobEvent, ToolManifest } from "./types";
import { errorText } from "@/lib/errors";
import { JobDialogProvider } from "@/components/JobDialog";
import { SyncBusyDialog } from "@/components/SyncBusyDialog";
import { WindowControls } from "@/components/WindowControls";
import { listenForThemeChanges, restoreSavedTheme } from "./theme";

const AudiPickPage = lazy(() =>
  import("./AudiPickPage").then((module) => ({ default: module.AudiPickPage })),
);

export default function AudiPickWindow() {
  const [tool, setTool] = useState<ToolManifest>();
  const [jobs, setJobs] = useState<Record<string, JobEvent>>({});
  const [startupError, setStartupError] = useState("");

  useEffect(() => {
    restoreSavedTheme();
    return listenForThemeChanges();
  }, []);

  useEffect(() => {
    void toolCatalog()
      .then((catalog) => {
        const manifest = catalog.find((item) => item.id === "audipick");
        if (!manifest) throw new Error("工具目录中找不到 AudiPick。");
        setTool(manifest);
      })
      .catch((error) => setStartupError(errorText(error)));
    let off: () => void = () => undefined;
    void listenJobEvents((event) => {
      if (event.toolId !== "audipick") return;
      invalidateHistoryCache();
      setJobs((current) => ({ ...current, [event.jobId]: event }));
    }).then((value) => {
      off = value;
    });
    return () => off();
  }, []);

  return (
    <JobDialogProvider jobs={Object.values(jobs)} nameOf={() => "AudiPick 合同摘录"}>
      <SyncBusyDialog />
      <div className="audipick-window-shell">
        <div className="audipick-window-dragbar" data-tauri-drag-region />
        <WindowControls />
        <main className="audipick-window-main">
          {startupError ? (
            <section className="form-card">
              <div className="error-box">{startupError}</div>
            </section>
          ) : tool ? (
            <Suspense fallback={<section className="form-card">正在加载 AudiPick…</section>}>
              <AudiPickPage tool={tool} />
            </Suspense>
          ) : (
            <section className="form-card">正在连接工具箱数据与规则库…</section>
          )}
        </main>
      </div>
    </JobDialogProvider>
  );
}
