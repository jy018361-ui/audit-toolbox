import { useEffect, useState } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import {
  engineCall,
  jobCancel,
  jobStart,
  listenJobEvents,
  pickPath,
} from "./api";
import type { JobEvent, ToolManifest } from "./types";
import { useTaskRestore } from "./restore";
import { ErrorBox } from "@/components/ErrorBox";
import { FileDropInput } from "@/components/FileDropInput";
import { JobProgress } from "@/components/JobProgress";
import { PageHeader } from "@/components/PageHeader";
import { ResultView } from "@/components/ResultView";
import { StepIndicator } from "@/components/StepIndicator";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/EmptyState";

function wpErrorText(error: unknown) {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object") {
    const value = error as Record<string, unknown>;
    return String(
      value.userMessage ??
        value.message ??
        value.detail ??
        "操作失败，请检查输入后重试。",
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
    if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window))
      return;
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

  // 历史记录「继续任务」：回填上次的工作目录，不自动生成。
  useTaskRestore(tool.id, (restore) => {
    const folder = restore.params.folder;
    if (typeof folder === "string" && folder) selectFolder(folder);
  });

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

  // 生成任务失败/取消后 job 事件仍留在 state 里；此时第 2 步绝不能按
  // "已完成"渲染（P2-004：红色报错与绿色对勾并存自相矛盾）。
  // 失败 → 第 2 步显示警示态；取消/失败 → current 回退到第 2 步等待重试。
  const jobInterrupted =
    job?.phase === "failed" || job?.phase === "cancelled";
  const jobFailed = job?.phase === "failed";

  return (
    <>
      <PageHeader
        eyebrow="WP 服务单生成"
        title={tool.name}
        detail="校验工作目录中的 WP 服务单、Section List 与我的订单，并生成拆分及汇总文件。"
      />
      <StepIndicator
        steps={[
          { key: "1", label: "选择目录" },
          {
            key: "2",
            label: "检查输入",
            status: jobFailed ? "error" : undefined,
          },
          { key: "3", label: "生成结果" },
        ]}
        current={job && !jobInterrupted ? 2 : folder ? 1 : 0}
      />
      {job?.phase === "cancelled" && (
        <div className="flex flex-wrap items-center gap-2" role="status">
          <Badge variant="warning">已取消</Badge>
          <span className="hint">本次生成已停止；工作目录仍保留，可检查输入后重新生成。</span>
        </div>
      )}
      <div className="workspace wp-workspace">
        <Card variant="section">
          <CardHeader>
            <CardTitle>选择工作目录</CardTitle>
          </CardHeader>
          <CardContent>
            <FileDropInput
              value={folder}
              disabled={busy}
              placeholder="拖放或单击选择目录"
              onBrowse={chooseFolder}
              onClear={folder && !busy ? () => selectFolder("") : undefined}
              onDragStateChange={() => undefined}
              highlight={dragHover}
            />

            <div
              className="wp-directory-requirements"
              aria-label="目录内文件要求"
            >
              <h3>目录内文件要求</h3>
              <p>所选目录第一层需各有一个符合关键词规则的 Excel 文件：</p>
              <ul>
                <li>WP 服务单：文件名包含“WP服务单”</li>
                <li>
                  Section List：文件名包含“section list”（忽略空格和大小写）
                </li>
                <li>我的订单：文件名包含“我的订单”</li>
              </ul>
              <p className="wp-requirement-note">
                每类输入文件只能保留一个。临时文件、模板和已生成的汇总文件会自动忽略；请勿修改表头。
              </p>
            </div>

            {error && <ErrorBox error={error} onDismiss={() => setError("")} />}
            <div className="actions">
              <Button
                variant="secondary"
                disabled={busy}
                onClick={() => void validate()}
              >
                检查输入
              </Button>
              <Button disabled={busy} onClick={() => void generate()}>
                {busy ? "处理中…" : "生成服务方案"}
              </Button>
            </div>
            {busy && job && (
              <JobProgress
                job={job}
                onCancel={(jobId) => jobCancel(jobId)}
                cancelLabel="取消任务"
              />
            )}
          </CardContent>
        </Card>

        <Card variant="section">
          <CardHeader>
            <CardTitle>检查与结果</CardTitle>
          </CardHeader>
          <CardContent>
            {result ? (
              <ResultView
                value={result}
                // 任务失败/取消后旧结果仍会留在这里，必须标注以免被当成
                // 本次成功产物（P1：失败后不得宣称"处理完成"）。
                stale={Boolean(
                  job && (job.phase === "failed" || job.phase === "cancelled"),
                )}
              />
            ) : (
              <EmptyState
                title={job?.phase === "cancelled" ? "生成已取消" : busy ? "正在处理工作目录" : "尚未生成结果"}
                description={job?.phase === "cancelled" ? "工作目录仍保留，可检查输入后重新生成。" : "选择目录后先检查输入，再生成服务方案。"}
              />
            )}
          </CardContent>
        </Card>
      </div>
    </>
  );
}
