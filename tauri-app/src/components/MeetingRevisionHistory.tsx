import { useEffect, useRef, useState } from "react";
import { meetingRevisionGet, meetingRevisionList } from "../api";
import { meetingErrorText } from "../lib/errors";
import { editableMinutesHtml } from "../meetingMinutesEditing";
import type { MeetingResult, MeetingRevision } from "../types";
import { Button } from "./ui/button";

export function MeetingRevisionHistory({ source, disabled, jobPhase, onRestore }: {
  source: string; disabled: boolean; jobPhase?: string; onRestore: (id: string) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<MeetingRevision[]>([]);
  const [selected, setSelected] = useState("");
  const [preview, setPreview] = useState<MeetingResult>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const mounted = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => {
    if (!open) return;
    let disposed = false;
    setLoading(true);
    setError("");
    void meetingRevisionList(source).then(items => {
      if (!disposed) setRows(items);
    }).catch(problem => {
      if (!disposed) setError(meetingErrorText(problem));
    }).finally(() => {
      if (!disposed) setLoading(false);
    });
    return () => { disposed = true; };
  }, [source, open, jobPhase, restoring]);
  useEffect(() => {
    if (!selected || !open) return;
    let disposed = false;
    setPreview(undefined);
    setError("");
    void meetingRevisionGet(source, selected).then(result => {
      if (!disposed) setPreview(result);
    }).catch(problem => {
      if (!disposed) setError(meetingErrorText(problem));
    });
    return () => { disposed = true; };
  }, [source, selected, open]);

  async function restore() {
    setError("");
    setRestoring(true);
    try {
      await onRestore(selected);
      if (mounted.current) {
        setPreview(undefined);
        setSelected("");
      }
    } catch (problem) {
      if (mounted.current) setError(meetingErrorText(problem));
    } finally {
      if (mounted.current) setRestoring(false);
    }
  }

  return <details className="meeting-review-panel" open={open} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>纪要版本记录</summary>
    {open && <div>
      {loading ? <p role="status">正在读取版本记录…</p> : !error && !rows.length && <p>重新生成前会保留当前纪要。</p>}
      {!!rows.length && <label>选择历史版本
        <select value={selected} onChange={event => setSelected(event.target.value)} disabled={restoring}>
          <option value="">请选择</option>
          {rows.map(row => <option key={row.id} value={row.id}>
            {new Date(row.createdAt).toLocaleString("zh-CN")} · {row.title || "会议纪要"}
          </option>)}
        </select>
      </label>}
      {error && <p role="alert" className="meeting-ask-error">{error}</p>}
      {preview && <div className="meeting-revision-preview">
        {(preview.minutesVersions ?? [{ ...preview, label: "会议纪要" }]).map(version => {
          if (!version.minutesMarkdown) return null;
          const html = editableMinutesHtml(version.sourceMarkdown ?? version.minutesMarkdown,
            version.sourceMarkdown ? version.speakerNames ?? {} : {});
          return <details key={version.label} open>
            <summary>{version.label}</summary>
            <div className="meeting-minutes-content" dangerouslySetInnerHTML={{ __html: html }} />
          </details>;
        })}
        <Button variant="secondary" disabled={disabled || restoring} onClick={() => void restore()}>
          {restoring ? "正在恢复…" : "恢复此版本"}
        </Button>
      </div>}
    </div>}
  </details>;
}
