import { useEffect, useState } from "react";
import { diagnosticsRecent, type DiagnosticsLogEntry } from "../diagnostics";
import { errorText } from "../lib/errors";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./ui/dialog";

const eventLabels: Record<string, string> = {
  process_start: "进程启动",
  process_exit: "进程退出",
  navigation: "页面导航",
  ui_action: "界面操作",
  frontend_call: "界面调用",
  frontend_error: "界面异常",
  call_start: "开始处理",
  call_end: "处理结束",
  job_event: "任务进度",
  worker_spawn: "启动后台任务",
  worker_request: "后台任务开始",
  worker_exit: "后台任务退出",
  app_error: "应用错误",
  panic: "进程异常",
  settings_change: "设置变更",
  logging_enabled: "开启日志",
  path_selection: "选择文件位置",
};

const formatTime = new Intl.DateTimeFormat("zh-CN", {
  month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  second: "2-digit", hourCycle: "h23",
});

function LogList() {
  const [revision, setRevision] = useState(0);
  const [entries, setEntries] = useState<DiagnosticsLogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    void diagnosticsRecent()
      .then(result => { if (active) setEntries(result); })
      .catch(err => { if (active) setError(errorText(err)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [revision]);

  return <>
    <div className="flex items-center justify-between gap-2">
      <DialogDescription>最近 200 条 · 最新在前</DialogDescription>
      <Button size="sm" variant="outline" disabled={loading} onClick={() => {
        setLoading(true);
        setError("");
        setRevision(value => value + 1);
      }}>刷新</Button>
    </div>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {loading && <p role="status" className="text-sm text-muted-foreground">读取中…</p>}
    {!loading && !error && entries.length === 0 && <p className="text-sm text-muted-foreground">暂无日志。</p>}
    {entries.length > 0 && <div className="min-h-0 divide-y overflow-auto overscroll-contain">
      {entries.map((entry, index) => {
        const { at, session, event, data } = entry;
        const context = [data.method ?? data.command ?? data.route, data.phase ?? data.errorCode ?? data.code]
          .filter(value => typeof value === "string").join(" · ");
        return <details key={`${at}:${session}:${event}:${index}`} className="py-2 text-sm">
          <summary className="cursor-pointer break-all">
            <time dateTime={at} className="mr-3 tabular-nums text-muted-foreground">{formatTime.format(new Date(at))}</time>
            <span className="font-medium">{Object.hasOwn(eventLabels, event) ? eventLabels[event] : event}</span>
            {context && <span className="ml-2 text-muted-foreground">{context}</span>}
          </summary>
          <pre className="mt-2 whitespace-pre-wrap break-all rounded-md bg-muted p-3 text-xs">{JSON.stringify(entry, null, 2)}</pre>
        </details>;
      })}
    </div>}
  </>;
}

export function DiagnosticsLogDialog({ open, onOpenChange }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="flex max-w-3xl flex-col overflow-hidden">
      <DialogHeader>
        <DialogTitle>诊断日志</DialogTitle>
      </DialogHeader>
      <LogList />
    </DialogContent>
  </Dialog>;
}
