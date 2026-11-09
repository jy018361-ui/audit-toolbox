import { useEffect, useState } from "react";
import { diagnosticsClear, diagnosticsExport, diagnosticsSetEnabled, diagnosticsStatus, type DiagnosticsStatus } from "../diagnostics";
import { pickPath, openOutput, runningInDesktopApp } from "../api";
import { errorText } from "../lib/errors";
import { SwitchInput } from "./SwitchInput";
import { Button } from "./ui/button";
import { confirmDialog } from "./ConfirmDialog";
import { DiagnosticsLogDialog } from "./DiagnosticsLogDialog";

const size = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

export function DiagnosticsSettings() {
  const [status, setStatus] = useState<DiagnosticsStatus>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [exportPath, setExportPath] = useState("");
  const [logOpen, setLogOpen] = useState(false);
  const desktop = runningInDesktopApp();

  async function refresh() {
    try { setStatus(await diagnosticsStatus()); setError(""); }
    catch (err) { setError(errorText(err)); }
  }
  useEffect(() => {
    if (!desktop) return;
    let active = true;
    void diagnosticsStatus().then(value => { if (active) setStatus(value); })
      .catch(err => { if (active) setError(errorText(err)); });
    return () => { active = false; };
  }, [desktop]);

  async function run(action: () => Promise<void>) {
    setBusy(true); setError(""); setMessage("");
    try { await action(); }
    catch (err) { setError(errorText(err)); }
    finally { setBusy(false); }
  }

  return <section className="list-card diagnostics-settings" aria-labelledby="diagnostics-title">
    <h2 id="diagnostics-title">诊断日志</h2>
    {!desktop ? <p className="settings-note">仅桌面版可用。</p> : <>
      <label className="field settings-toggle">
        <span>记录本地诊断日志</span>
        <SwitchInput checked={status?.enabled ?? false} disabled={!status || busy}
          onChange={enabled => void run(async () => { setStatus(await diagnosticsSetEnabled(enabled));
            setMessage(enabled ? "已开启日志记录。" : "已关闭日志记录。"); })} />
      </label>
      {status && <p className="cache-usage" aria-live="polite">已记录 {size(status.bytes)} · {status.files} 个日志文件</p>}
      <div className="actions">
        <Button variant="outline" disabled={busy} onClick={() => setLogOpen(true)}>查看日志</Button>
        <Button variant="outline" disabled={busy || !status} onClick={() => void run(async () => {
          const path = await pickPath("save", "导出诊断包", ["zip"], `审计工具箱诊断-${new Date().toISOString().slice(0, 10)}.zip`);
          if (typeof path !== "string") return;
          await diagnosticsExport(path); setExportPath(path);
          setMessage("诊断包已导出。");
          setStatus(await diagnosticsStatus());
        })}>{busy ? "处理中…" : "导出诊断包"}</Button>
        <Button variant="outline" disabled={busy || !status} onClick={() => void run(async () => {
          const confirmed = await confirmDialog({ title: "清空诊断日志", message: "确定清空已有日志？此操作无法撤销。", confirmLabel: "清空", tone: "danger" });
          if (!confirmed) return;
          setStatus(await diagnosticsClear()); setMessage("日志已清空。");
        })}>清空日志</Button>
        {exportPath && <Button variant="outline" disabled={busy} onClick={() => void run(() => openOutput(exportPath))}>打开所在文件夹</Button>}
      </div>
      <DiagnosticsLogDialog open={logOpen} onOpenChange={setLogOpen} />
      {message && <p role="status" className="settings-note">{message}</p>}
      {(error || status?.writeError) && <div role="alert" className="settings-auto-error">
        <span>{error || status?.writeError}</span><Button variant="outline" size="sm" disabled={busy} onClick={() => void refresh()}>重试读取</Button>
      </div>}
    </>}
  </section>;
}
