import { useEffect, useState } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { engineCall, jobCancel, jobStart, listenJobEvents, pickPath } from "./api";
import type { JobEvent, ToolManifest } from "./types";
import { ErrorBox } from "@/components/ErrorBox";
import { FileDropInput } from "@/components/FileDropInput";
import { JobProgress } from "@/components/JobProgress";
import { PageHeader } from "@/components/PageHeader";
import { ResultView } from "@/components/ResultView";
import { StepIndicator } from "@/components/StepIndicator";
import { Button } from "@/components/ui/button";

function wpErrorText(error: unknown) {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object") {
    const value = error as Record<string, unknown>;
    return String(
      value.userMessage ?? value.message ?? value.detail ?? "操作失败，请查看日志诊断。",
    );
  }
  return String(error);
}

export function WpServicePage({ tool }: { tool: ToolManifest }) {
  const [folder, setFolder] = useState("");
  const [dragHover, setDragHover] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [job, setJob] = useState<JobEvent>();
  const [result, setResult] = useState<unknown>();

  useEffect(() => {
    if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) return;
    let off: () => void = () => undefined;
    void getCurrentWebview()
      .onDragDropEvent((event) => {
        const payload = event.payload;
        if (payload.type === "over" || payload.type === "enter") {
          setDragHover(true);
        } else if (payload.type === "drop") {
          setDragHover(false);
          if (payload.paths.length) selectFolder(payload.paths[0]);
        } else if (payload.type === "leave") {
          setDragHover(false);
        }
      })
      .then((unlisten) => {
        off = unlisten;
      });
    return () => off();
  }, []);

  useEffect(() => {
    let off: () => void = () => undefined;
    void listenJobEvents((event) => {
      if (event.toolId !== "wp_service_generator") return;
      setJob(event);
      const done = ["completed", "failed", "cancelled"].includes(event.phase);
      setBusy(!done);
      if (event.phase === "completed" && event.result) setResult(event.result);
      if (event.phase === "failed") setError(event.message);
    }).then((unlisten) => {
      off = unlisten;
    });
    return () => off();
  }, []);

  function selectFolder(value: string) {
    setFolder(value);
    setError("");
    setResult(undefined);
    setJob(undefined);
  }

  async function chooseFolder() {
    const value = await pickPath("folder", "选择 WP 服务单工作目录");
    if (typeof value === "string") selectFolder(value);
  }

  async function validate() {
    if (!folder) {
      setError("请先选择工作目录。");
      return;
    }
    setBusy(true);
    setError("");
    setResult(undefined);
    try {
      setResult(await engineCall("wp.validate", { folder }));
    } catch (reason) {
      setError(wpErrorText(reason));
    } finally {
      setBusy(false);
    }
  }

  async function generate() {
    if (!folder) {
      setError("请先选择工作目录。");
      return;
    }
    setBusy(true);
    setError("");
    setResult(undefined);
    try {
      const jobId = await jobStart("wp.generate", { folder });
      setJob({
        jobId,
        toolId: "wp_service_generator",
        phase: "queued",
        current: 0,
        total: 1,
        message: "任务已进入队列",
        severity: "info",
        outputPaths: [],
      });
    } catch (reason) {
      setBusy(false);
      setError(wpErrorText(reason));
    }
  }

  return (
    <>
      <PageHeader
        eyebrow="WP 服务单生成"
        title={tool.name}
        detail="校验工作目录中的 WP 服务单与 Section List，并生成拆分及汇总文件。"
      />
      <StepIndicator
        steps={[
          { key: "1", label: "选择目录" },
          { key: "2", label: "检查输入" },
          { key: "3", label: "生成结果" },
        ]}
        current={job?.phase === "completed" ? 2 : folder ? 1 : 0}
      />
      <div className="workspace wp-workspace">
        <section className="form-card">
          <div className="section-title">
            <h2>选择工作目录</h2>
          </div>
          <FileDropInput
            value={folder}
            disabled={busy}
            placeholder="拖放或单击选择目录"
            onBrowse={chooseFolder}
            onClear={folder && !busy ? () => selectFolder("") : undefined}
            onDragStateChange={() => undefined}
            highlight={dragHover}
          />

          <div className="wp-directory-requirements" aria-label="目录内文件要求">
            <h3>目录内文件要求</h3>
            <p>所选目录第一层需各有一个符合关键词规则的 Excel 文件：</p>
            <ul>
              <li>WP 服务单：文件名包含“WP服务单”</li>
              <li>Section List：文件名包含“section list”（忽略空格和大小写）</li>
            </ul>
            <p className="wp-requirement-note">
              每类输入文件只能保留一个。临时文件、模板和已生成的汇总文件会自动忽略；请勿修改表头。
            </p>
          </div>

          {error && <ErrorBox error={error} onDismiss={() => setError("")} />}
          <div className="actions">
            <Button variant="secondary" disabled={busy} onClick={() => void validate()}>
              检查输入
            </Button>
            <Button disabled={busy} onClick={() => void generate()}>
              {busy ? "处理中…" : "生成服务方案"}
            </Button>
          </div>
          {busy && job && (
            <JobProgress
              job={job}
              onCancel={(jobId) => void jobCancel(jobId)}
              cancelLabel="取消任务"
            />
          )}
        </section>

        <section className="result-card">
          <h2>检查与结果</h2>
          {result ? (
            <ResultView value={result} />
          ) : (
            <div className="empty">选择目录后先检查输入，再生成服务方案。</div>
          )}
        </section>
      </div>
    </>
  );
}
