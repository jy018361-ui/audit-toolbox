import { useEffect, useState } from "react";
import { diagnosticsClear, diagnosticsExport, diagnosticsSetEnabled, diagnosticsStatus, type DiagnosticsStatus } from "../diagnostics";
import { pickPath, openOutput, runningInDesktopApp } from "../api";
import { errorText } from "../lib/errors";
import { SwitchInput } from "./SwitchInput";
import { Button } from "./ui/button";
import { confirmDialog } from "./ConfirmDialog";

const size = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

export function DiagnosticsSettings() {
  const [status, setStatus] = useState<DiagnosticsStatus>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [exportPath, setExportPath] = useState("");
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
    <p className="settings-note">无论是否报错，都会记录操作顺序、参数与结果的结构摘要、任务进度和耗时。遇到结果不对或操作异常时，导出诊断包并附上问题描述，便于定位。</p>
    {!desktop ? <p className="settings-note">请在桌面应用中使用诊断日志。</p> : <>
      <label className="field settings-toggle">
        <span>记录本地诊断日志</span>
        <SwitchInput checked={status?.enabled ?? false} disabled={!status || busy}
          onChange={enabled => void run(async () => { setStatus(await diagnosticsSetEnabled(enabled));
            setMessage(enabled ? "已开启日志记录。" : "已停止记录；已有日志仍可导出或清空。"); })} />
      </label>
      <p className="settings-note">仅保存在本机，默认开启；保留最近 7 天，上限约 24 MB，不会自动上传。路径、自由文本和业务数值仅留脱敏指纹，不包含 API Key、账表原文或录音。数据问题可能仍需脱敏样例。</p>
      {status && <p className="cache-usage" aria-live="polite">已记录 {size(status.bytes)} · {status.files} 个日志文件</p>}
      <div className="actions">
        <Button variant="outline" disabled={busy || !status} onClick={() => void run(async () => {
          const path = await pickPath("save", "导出诊断包", ["zip"], `审计工具箱诊断-${new Date().toISOString().slice(0, 10)}.zip`);
          if (typeof path !== "string") return;
          await diagnosticsExport(path); setExportPath(path);
          setMessage("诊断包已导出。请附上问题现象、预期结果和发生时间。");
          setStatus(await diagnosticsStatus());
        })}>{busy ? "处理中…" : "导出诊断包"}</Button>
        <Button variant="outline" disabled={busy || !status} onClick={() => void run(async () => {
          const confirmed = await confirmDialog({ title: "清空诊断日志", message: "清空后无法再导出此前的问题记录。已导出的诊断包会保留。", confirmLabel: "清空", tone: "danger" });
          if (!confirmed) return;
          setStatus(await diagnosticsClear()); setMessage("已有诊断日志已清空；开关开启时会继续记录新操作。");
        })}>清空日志</Button>
        {exportPath && <Button variant="outline" disabled={busy} onClick={() => void run(() => openOutput(exportPath))}>打开所在文件夹</Button>}
      </div>
      {message && <p role="status" className="settings-note">{message}</p>}
      {(error || status?.writeError) && <div role="alert" className="settings-auto-error">
        <span>{error || status?.writeError}</span><Button variant="outline" size="sm" disabled={busy} onClick={() => void refresh()}>重试读取</Button>
      </div>}
    </>}
  </section>;
}
