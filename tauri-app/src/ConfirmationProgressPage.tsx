import { useEffect, useMemo, useRef, useState } from "react";
import {
  engineCall,
  jobCancel,
  jobStart,
  listenJobEvents,
  openOutput,
  pickPath,
} from "./api";
import type { JobEvent, ToolManifest } from "./types";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import "./confirmation-progress.css";
import { PageHeader } from "@/components/PageHeader";
import { StepIndicator } from "@/components/StepIndicator";
import { ErrorBox } from "@/components/ErrorBox";
import { JobProgress } from "@/components/JobProgress";
import { Field } from "@/components/Field";
import { FileDropInput } from "@/components/FileDropInput";
import { DataTable } from "@/components/DataTable";
import { StatGrid } from "@/components/StatGrid";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { errorText } from "@/lib/errors";

export type ConfirmationMode = "both" | "bank" | "trade";

export type ConfirmationInspection = {
  path: string;
  headers: string[];
  preview: unknown[][];
  dimensions: { rows: number; columns: number };
  missingColumns: string[];
  requiredColumnsPresent: string[];
  statistics: {
    total: number;
    bank: number;
    trade: number;
    projects: number;
    units: number;
    baseDates: string[];
  };
  outputDirectory: string;
  willGenerate: { bank: boolean; trade: boolean };
};

const CACHE_KEY = "audit-toolbox:confirmation-progress:v1";

export function canGenerateConfirmation(
  path: string,
  inspection: ConfirmationInspection | undefined,
): boolean {
  return Boolean(
    path &&
    inspection &&
    inspection.path === path &&
    inspection.missingColumns.length === 0,
  );
}

export function readConfirmationCache(): {
  inputPath: string;
  mode: ConfirmationMode;
} {
  try {
    const parsed = JSON.parse(sessionStorage.getItem(CACHE_KEY) ?? "{}") as {
      inputPath?: unknown;
      mode?: unknown;
    };
    const mode =
      parsed.mode === "bank" || parsed.mode === "trade" ? parsed.mode : "both";
    return {
      inputPath: typeof parsed.inputPath === "string" ? parsed.inputPath : "",
      mode,
    };
  } catch {
    return { inputPath: "", mode: "both" };
  }
}

const CONFIRMATION_MODE_OPTIONS: Array<{
  value: ConfirmationMode;
  label: string;
  detail: string;
}> = [
  { value: "both", label: "银行 + 往来", detail: "与原工具一致，一次生成两类报告" },
  { value: "bank", label: "仅银行函证", detail: "含项目、发函单位及分基准日统计" },
  { value: "trade", label: "仅往来函证", detail: "含项目及发函单位统计" },
];

export default function ConfirmationProgressPage({
  tool,
}: {
  tool: ToolManifest;
}) {
  const cached = useMemo(readConfirmationCache, []);
  const [inputPath, setInputPath] = useState(cached.inputPath);
  const [mode, setMode] = useState<ConfirmationMode>(cached.mode);
  const [inspection, setInspection] = useState<ConfirmationInspection>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [job, setJob] = useState<JobEvent>();
  const [result, setResult] = useState<Record<string, unknown>>();
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [dragHover, setDragHover] = useState(false);
  const activeJob = useRef("");

  useEffect(() => {
    sessionStorage.setItem(CACHE_KEY, JSON.stringify({ inputPath, mode }));
  }, [inputPath, mode]);

  useEffect(() => {
    const stopEvents = listenJobEvents((event) => {
      if (event.jobId !== activeJob.current) return;
      setJob(event);
      if (event.phase === "completed") {
        setBusy(false);
        if (event.result && typeof event.result === "object")
          setResult(event.result as Record<string, unknown>);
      } else if (event.phase === "failed" || event.phase === "cancelled") {
        setBusy(false);
        const payload = event.result as
          { error?: { userMessage?: string } } | undefined;
        setError(payload?.error ? errorText(payload.error) : event.message);
      }
    });
    const stopDrops = (() => {
      if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window))
        return Promise.resolve(() => {});
      return getCurrentWebview()
        .onDragDropEvent((event) => {
          const payload = event.payload;
          if (payload.type === "over" || payload.type === "enter") {
            setDragHover(true);
          } else if (payload.type === "drop") {
            setDragHover(false);
            const picked = payload.paths.find((path) => /\.xlsx?$/i.test(path));
            if (picked) {
              setInputPath(picked);
              setInspection(undefined);
              setResult(undefined);
              setError("");
              setStep(1);
            }
          } else if (payload.type === "leave") {
            setDragHover(false);
          }
        })
        .catch(() => () => {});
    })();
    return () => {
      void stopEvents.then((stop) => stop());
      void stopDrops.then((stop) => stop());
    };
  }, []);

  async function chooseInput() {
    const value = await pickPath("file", "选择函证列表 Excel 文件", [
      "xlsx",
      "xls",
    ]);
    if (typeof value !== "string") return;
    setInputPath(value);
    setInspection(undefined);
    setResult(undefined);
    setError("");
    setStep(1);
  }

  function clearInput() {
    setInputPath("");
    setInspection(undefined);
    setResult(undefined);
    setJob(undefined);
    setError("");
    activeJob.current = "";
    setStep(1);
  }

  async function inspect() {
    if (!inputPath) {
      setError("请先选择函证清单。");
      return;
    }
    setBusy(true);
    setError("");
    setResult(undefined);
    try {
      const value = (await engineCall("confirmation.inspect", {
        inputPath,
        mode,
      })) as ConfirmationInspection;
      setInspection(value);
    } catch (reason) {
      setInspection(undefined);
      setError(errorText(reason));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (inspection && inspection.path === inputPath) void inspect();
    // Mode changes must refresh mode-specific required columns and counts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  async function generate() {
    if (!canGenerateConfirmation(inputPath, inspection)) {
      setError(
        inspection?.missingColumns.length
          ? "请先补齐缺失字段后重新检查。"
          : "请先检查函证清单。",
      );
      return;
    }
    setBusy(true);
    setError("");
    setResult(undefined);
    setJob(undefined);
    try {
      const jobId = await jobStart("confirmation.process", { inputPath, mode });
      activeJob.current = jobId;
      setJob({
        jobId,
        toolId: "confirmation_progress",
        phase: "queued",
        current: 0,
        total: mode === "both" ? 2 : 1,
        message: "任务已进入队列",
        severity: "info",
        outputPaths: [],
      });
    } catch (reason) {
      setBusy(false);
      setError(errorText(reason));
    }
  }

  async function cancel() {
    if (!activeJob.current) return;
    await jobCancel(activeJob.current);
  }

  const outputPaths =
    (result?.outputPaths as string[] | undefined) ?? job?.outputPaths ?? [];
  const reports = Array.isArray(result?.reports)
    ? (result.reports as Array<Record<string, unknown>>)
    : [];
  const generateReady = canGenerateConfirmation(inputPath, inspection) && !busy;
  const scopeSummary = CONFIRMATION_MODE_OPTIONS.find((value) => value.value === mode);

  return (
    <>
      <PageHeader
        eyebrow="函证进度统计"
        title={tool.name}
        detail="选择函证列表后，按原工具口径生成银行函证与往来函证统计报告。"
      />
      <StepIndicator
        steps={[
          { key: "1", label: "选择清单" },
          { key: "2", label: "报告范围", disabled: !inspection },
          { key: "3", label: "生成报告", disabled: !canGenerateConfirmation(inputPath, inspection) },
        ]}
        current={step - 1}
        onStepClick={(index) => setStep((index + 1) as 1 | 2 | 3)}
      />
      <div className="fa-stack">
        <Card>
          <CardHeader>
            <CardTitle>
              {step === 1
                ? "1. 选择函证清单"
                : step === 2
                  ? "2. 报告范围"
                  : "3. 生成进度报告"}
            </CardTitle>
            <Badge className="badge-ready">已就绪</Badge>
          </CardHeader>
          <CardContent>
            <ErrorBox error={error} onDismiss={() => setError("")} />
            {job && !["completed", "failed", "cancelled"].includes(job.phase) && (
              <JobProgress
                job={job}
                onCancel={() => void cancel()}
                cancelLabel="取消任务"
              />
            )}
            {step === 1 && (
              <>
                <Field label="函证清单" required>
                  <FileDropInput
                    value={inputPath}
                    placeholder="拖放或点击选择 Excel 函证清单"
                    onBrowse={() => void chooseInput()}
                    onClear={inputPath && !busy ? clearInput : undefined}
                    onDragStateChange={() => {}}
                    highlight={dragHover}
                    disabled={busy}
                  />
                </Field>
                <p className="hint">支持 XLSX、XLS；选择后点击「检查数据」读取表头、数量与必需字段。</p>
                <div className="actions">
                  <Button type="button" variant="secondary" size="sm" disabled={!inputPath || busy} onClick={() => void inspect()}>
                    {busy && !job ? "正在读取…" : "检查数据"}
                  </Button>
                  <Button type="button" variant="default" disabled={!inspection || busy} onClick={() => setStep(2)}>
                    下一步：报告范围
                  </Button>
                </div>
              </>
            )}
            {step === 2 && (
              <>
                <h3>报告范围</h3>
                <div className="confirmation-modes">
                  {CONFIRMATION_MODE_OPTIONS.map(({ value, label, detail }) => (
                    <label className={mode === value ? "selected" : ""} key={value}>
                      <input
                        type="radio"
                        name="confirmation-mode"
                        checked={mode === value}
                        onChange={() => setMode(value)}
                      />
                      <span>
                        <strong>{label}</strong>
                        <small>{detail}</small>
                      </span>
                    </label>
                  ))}
                </div>
                {inspection?.missingColumns.length ? (
                  <div className="confirmation-error">
                    缺少原处理逻辑必需字段：{inspection.missingColumns.join("、")}
                  </div>
                ) : inspection ? (
                  <div className="confirmation-success">
                    字段检查通过，报告将保存到：{inspection.outputDirectory}
                  </div>
                ) : null}
                <div className="actions">
                  <Button type="button" variant="secondary" size="sm" onClick={() => setStep(1)}>上一步</Button>
                  <Button type="button" variant="default" disabled={!canGenerateConfirmation(inputPath, inspection) || busy} onClick={() => setStep(3)}>
                    下一步：生成报告
                  </Button>
                </div>
              </>
            )}
            {step === 3 && (
              <>
                {inspection?.missingColumns.length ? (
                  <div className="confirmation-error">
                    缺少原处理逻辑必需字段：{inspection.missingColumns.join("、")}
                  </div>
                ) : inspection ? (
                  <div className="confirmation-success">
                    字段检查通过，报告将保存到：{inspection.outputDirectory}
                  </div>
                ) : null}
                <p className="hint">
                  报告范围：{scopeSummary?.label ?? "银行 + 往来"}。
                  {scopeSummary ? ` ${scopeSummary.detail}。` : ""}
                </p>
                <div className="actions">
                  <Button type="button" variant="secondary" size="sm" onClick={() => setStep(2)}>上一步</Button>
                  <Button type="button" variant="default" disabled={!generateReady} onClick={() => void generate()}>
                    生成进度报告
                  </Button>
                </div>
              </>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>数据检查与结果</CardTitle>
          </CardHeader>
          <CardContent>
            {!inspection && !job && (
              <div className="empty">
                检查后显示函证数量、必需字段和数据预览。
              </div>
            )}
            {inspection && (
              <>
                <StatGrid
                  columns={4}
                  items={[
                    { label: "总行数", value: inspection.statistics.total },
                    { label: "银行函证", value: inspection.statistics.bank },
                    { label: "往来函证", value: inspection.statistics.trade },
                    { label: "项目 / 单位", value: `${inspection.statistics.projects} / ${inspection.statistics.units}` },
                  ]}
                />
                {inspection.statistics.baseDates.length > 0 && (
                  <p className="confirmation-dates">
                    银行函证基准日：{inspection.statistics.baseDates.join("、")}
                  </p>
                )}
                <DataTable
                  columns={inspection.headers}
                  rows={inspection.preview}
                  caption={<strong>函证清单前 {inspection.preview.length} 行</strong>}
                  maxHeight={430}
                />
              </>
            )}
            {/* The engine records a per-type outcome including why a report was
                skipped.  Showing only the generated paths made a missing report
                indistinguishable from a tool failure. */}
            {reports.length > 0 && (
              <div className="confirmation-outputs">
                <h3>本次处理的报告</h3>
                {reports.map((report, index) => (
                  <p
                    key={String(report.type ?? index)}
                    className={
                      report.status === "skipped"
                        ? "confirmation-skipped"
                        : undefined
                    }
                  >
                    {String(report.label ?? report.type ?? "")}：
                    {report.status === "skipped"
                      ? `未生成（${String(report.reason ?? "没有符合类型的数据")}）`
                      : `已生成${typeof report.summaryRows === "number" ? `，${report.summaryRows} 行` : ""}`}
                  </p>
                ))}
              </div>
            )}
            {outputPaths.length > 0 && (
              <div className="confirmation-outputs">
                <h3>报告已生成</h3>
                {outputPaths.map((path) => (
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    className="confirmation-output-link"
                    key={path}
                    onClick={() => void openOutput(path)}
                  >
                    打开：{path}
                  </Button>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </>
  );
}
