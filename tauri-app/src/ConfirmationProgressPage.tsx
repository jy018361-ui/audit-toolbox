import { useEffect, useMemo, useRef, useState } from "react";
import { formatCount } from "@/lib/numberFormat";
import {
  engineCall,
  jobCancel,
  jobStart,
  listenJobEvents,
  openOutput,
  pickPath,
} from "./api";
import type { JobEvent, ToolManifest } from "./types";
import { useTaskRestore } from "./restore";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import "./confirmation-progress.css";
import { PageHeader } from "@/components/PageHeader";
import { StepIndicator } from "@/components/StepIndicator";
import { ErrorBox } from "@/components/ErrorBox";
import { JobProgress } from "@/components/JobProgress";
import { cancelJobWithFeedback } from "@/components/JobCommandNotice";
import { Field } from "@/components/Field";
import { FileDropInput } from "@/components/FileDropInput";
import { displayFileName } from "@/fileDisplay";
import { DataTable } from "@/components/DataTable";
import { StatGrid } from "@/components/StatGrid";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/EmptyState";
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
  {
    value: "both",
    label: "银行 + 往来",
    detail: "一次生成银行与往来两类报告",
  },
  {
    value: "bank",
    label: "仅银行函证",
    detail: "含项目、发函单位及分基准日统计",
  },
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
  // 清单检查表默认折叠成一行摘要：报告生成后，长预览表会把结果挤出首屏。
  const [checklistOpen, setChecklistOpen] = useState(false);
  const activeJob = useRef("");

  useEffect(() => {
    sessionStorage.setItem(CACHE_KEY, JSON.stringify({ inputPath, mode }));
  }, [inputPath, mode]);

  // 历史记录「继续任务」：回填台账路径与函证类型，不自动重新检查。
  useTaskRestore(tool.id, (restore) => {
    const params = restore.params as { inputPath?: string; mode?: string };
    if (typeof params.inputPath === "string" && params.inputPath) {
      // 恢复的是另一个任务＝切换数据现场：旧「本次报告」卡、进度条与步骤
      // 都属于上一轮，不清掉会顶着新回填的参数继续显示。
      activeJob.current = "";
      setBusy(false);
      setJob(undefined);
      setResult(undefined);
      setInspection(undefined);
      setStep(1);
      setInputPath(params.inputPath);
    }
    if (params.mode === "bank" || params.mode === "trade" || params.mode === "both")
      setMode(params.mode);
  });

  useEffect(() => {
    const stopEvents = listenJobEvents((event) => {
      if (event.jobId !== activeJob.current) return;
      setJob(event);
      if (event.phase === "completed") {
        setBusy(false);
        if (event.result && typeof event.result === "object")
          setResult(event.result as Record<string, unknown>);
      } else if (event.phase === "cancelled") {
        setBusy(false);
        setError("");
      } else if (event.phase === "failed") {
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
              activeJob.current = "";
              setInputPath(picked);
              setInspection(undefined);
              setResult(undefined);
              setJob(undefined);
              setBusy(false);
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
    activeJob.current = "";
    setInputPath(value);
    setInspection(undefined);
    setResult(undefined);
    setJob(undefined);
    setBusy(false);
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
    // 重新检查即重置结果现场：上一轮报告卡与输出文件不再对应当前输入，
    // 否则切换函证类型后旧报告会顶着新口径继续显示。
    setResult(undefined);
    setJob(undefined);
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
    // 生成进行中不自动重查，避免把正在跑的任务显示清掉。
    if (inspection && inspection.path === inputPath && !busy) void inspect();
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
    if (!activeJob.current) return false;
    return jobCancel(activeJob.current);
  }

  const outputPaths =
    (result?.outputPaths as string[] | undefined) ?? job?.outputPaths ?? [];
  const reports = Array.isArray(result?.reports)
    ? (result.reports as Array<Record<string, unknown>>)
    : [];
  const generateReady = canGenerateConfirmation(inputPath, inspection) && !busy;
  // 报告已生成（结果带报告行或输出文件）时，步骤条第 3 步打勾收尾——
  // 否则报告出来了指示条还停在第 3 步「激活」，与实际进度脱节（UI 审核）。
  const reportsReady = reports.length > 0 || outputPaths.length > 0;
  const scopeSummary = CONFIRMATION_MODE_OPTIONS.find(
    (value) => value.value === mode,
  );

  return (
    <div className="confirmation-page">
      <PageHeader
        eyebrow="函证进度统计"
        title={tool.name}
        detail="检查函证清单，按项目、发函单位与基准日生成银行及往来函证进度报告。"
      />
      <StepIndicator
        steps={[
          { key: "1", label: "选择清单" },
          { key: "2", label: "报告范围", disabled: !inspection },
          {
            key: "3",
            label: "生成报告",
            disabled: !canGenerateConfirmation(inputPath, inspection),
            status: reportsReady ? "done" : undefined,
          },
        ]}
        current={step - 1}
        onStepClick={(index) => setStep((index + 1) as 1 | 2 | 3)}
      />
      <div className="fa-stack">
        {/* 报告生成后「本次报告」升到步骤条正下方第一位：结果屏先看到结果，
            输入与检查表靠后（UI 审核：报告曾沉在 1400px 页底）。 */}
        {(reports.length > 0 || outputPaths.length > 0) && (
          <Card className="confirmation-report-card">
            <CardHeader>
              <CardTitle>本次报告</CardTitle>
              <Badge
                variant={reports.some((report) => report.status === "skipped") ? "warning" : "success"}
              >
                {reports.some((report) => report.status === "skipped") ? "部分未生成" : "已完成"}
              </Badge>
            </CardHeader>
            <CardContent>
              {reports.length > 0 && (
                <div className="confirmation-report-list" role="status">
                  {reports.map((report, index) => (
                    <div
                      key={String(report.type ?? index)}
                      className={report.status === "skipped" ? "confirmation-report-row is-skipped" : "confirmation-report-row"}
                    >
                      <strong>{String(report.label ?? report.type ?? "报告")}</strong>
                      <span>
                        {report.status === "skipped"
                          ? `未生成：${String(report.reason ?? "没有符合类型的数据")}`
                          : `已生成${typeof report.summaryRows === "number" ? ` · ${report.summaryRows} 行` : ""}`}
                      </span>
                    </div>
                  ))}
                </div>
              )}
              {outputPaths.length > 0 && (
                <div className="confirmation-output-actions" aria-label="报告文件">
                  {outputPaths.map((path, index) => (
                    <Button
                      type="button"
                      variant={index === 0 ? "default" : "secondary"}
                      size="sm"
                      className="confirmation-output-link"
                      key={path}
                      title={path}
                      onClick={() => void openOutput(path)}
                    >
                      {/* 深色主按钮让给交付物入口；其余报告次级排后。 */}
                      {index === 0 ? "打开报告" : `打开：${displayFileName(path)}`}
                    </Button>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        )}
        <Card>
          <CardHeader>
            <CardTitle>
              {step === 1
                ? "1. 选择函证清单"
                : step === 2
                  ? "2. 报告范围"
                  : "3. 生成进度报告"}
            </CardTitle>
            {/* 「待检查数据/字段检查通过/字段待补充」是第 1 步「检查数据」的
                结果状态，跟着第 2/3 步标题挂会张冠李戴（UI 审核）：检查状态
                只在第 1 步显示；处理中徽章与任务相关，任何步骤都显示。 */}
            {(step === 1 || busy) && (
              <Badge
                variant="outline"
                className={
                  busy
                    ? "badge-info"
                    : canGenerateConfirmation(inputPath, inspection)
                      ? "badge-ready"
                      : inspection
                        ? "badge-warning"
                        : "badge-neutral"
                }
              >
                {busy
                  ? "处理中"
                  : canGenerateConfirmation(inputPath, inspection)
                    ? "字段检查通过"
                    : inspection
                      ? "字段待补充"
                      : "待检查数据"}
              </Badge>
            )}
          </CardHeader>
          <CardContent>
            <ErrorBox error={error} onDismiss={() => setError("")} />
            {job &&
              !["completed", "failed"].includes(job.phase) && (
                <JobProgress
                  job={job}
                  onCancel={() => cancel()}
                  cancelLabel="取消任务"
                />
              )}
            {step === 1 && (
              <>
                <Field label="函证清单" required>
                  <FileDropInput
                    value={inputPath}
                    placeholder="拖放或点击选择 Excel 函证清单"
                    hideFilledLabel
                    onBrowse={() => void chooseInput()}
                    onClear={inputPath && !busy ? clearInput : undefined}
                    onDragStateChange={() => {}}
                    highlight={dragHover}
                    disabled={busy}
                  />
                </Field>
                <p className="hint">支持 XLSX、XLS。</p>
                <div className="actions" data-button-size="default">
                  <Button
                    type="button"
                    variant="secondary"
                    size="default"
                    disabled={!inputPath || busy}
                    onClick={() => void inspect()}
                  >
                    {busy && !job ? "正在读取…" : "检查数据"}
                  </Button>
                  <Button
                    type="button"
                    variant="default"
                    disabled={!inspection || busy}
                    onClick={() => setStep(2)}
                  >
                    下一步：报告范围
                  </Button>
                </div>
              </>
            )}
            {step === 2 && (
              <>
                <div className="confirmation-modes">
                  {CONFIRMATION_MODE_OPTIONS.map(({ value, label, detail }) => (
                    <label
                      className={mode === value ? "selected" : ""}
                      key={value}
                    >
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
                    缺少报告必需字段：
                    {inspection.missingColumns.join("、")}
                  </div>
                ) : null}
                <div className="actions" data-button-size="default">
                  <Button
                    type="button"
                    variant="secondary"
                    size="default"
                    onClick={() => setStep(1)}
                  >
                    上一步
                  </Button>
                  <Button
                    type="button"
                    variant="default"
                    disabled={
                      !canGenerateConfirmation(inputPath, inspection) || busy
                    }
                    onClick={() => setStep(3)}
                  >
                    下一步：生成报告
                  </Button>
                </div>
              </>
            )}
            {step === 3 && (
              <>
                {inspection?.missingColumns.length ? (
                  <div className="confirmation-error">
                    缺少报告必需字段：
                    {inspection.missingColumns.join("、")}
                  </div>
                ) : null}
                <p className="hint">
                  报告范围：{scopeSummary?.label ?? "银行 + 往来"}。
                  {scopeSummary ? ` ${scopeSummary.detail}。` : ""}
                </p>
                <div className="actions" data-button-size="default">
                  <Button
                    type="button"
                    variant="secondary"
                    size="default"
                    onClick={() => setStep(2)}
                  >
                    上一步
                  </Button>
                  {/* 运行中主按钮换成"停止"次按钮，与折旧政策对比 / FA List
                      一致；仅禁用不够醒目，审计（P1-3）仍会误读为可再点。
                      报告已生成后主按钮转次级「重新生成」，深色让给报告卡里
                      的「打开报告」（UI 审核）。 */}
                  {busy && job ? (
                    <Button
                      type="button"
                      variant="secondary"
                      size="default"
                      onClick={() => void cancelJobWithFeedback(job.jobId)}
                    >
                      停止
                    </Button>
                  ) : reportsReady ? (
                    <Button
                      type="button"
                      variant="secondary"
                      size="default"
                      disabled={!generateReady}
                      onClick={() => void generate()}
                    >
                      重新生成
                    </Button>
                  ) : (
                    <Button
                      type="button"
                      variant="default"
                      disabled={!generateReady}
                      onClick={() => void generate()}
                    >
                      生成进度报告
                    </Button>
                  )}
                </div>
              </>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>清单检查</CardTitle>
          </CardHeader>
          <CardContent>
            {!inspection && !job && (
              <EmptyState
                compact
                title="准备函证清单"
                description={
                  inputPath
                    ? "尚未检查所选清单。"
                    : "请添加 Excel 函证清单。"
                }
              />
            )}
            {inspection && (
              checklistOpen ? (
                <>
                  <StatGrid
                    columns={4}
                    items={[
                      { label: "总行数", value: inspection.statistics.total },
                      { label: "银行函证", value: inspection.statistics.bank },
                      { label: "往来函证", value: inspection.statistics.trade },
                      {
                        label: "项目 / 单位",
                        value: `${formatCount(inspection.statistics.projects)} / ${formatCount(inspection.statistics.units)}`,
                      },
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
                    resizeKey="confirmation.preview"
                    caption={
                      <strong>函证清单前 {inspection.preview.length} 行</strong>
                    }
                    maxHeight={430}
                  />
                  <div className="confirmation-checklist-toggle-row">
                    <button
                      type="button"
                      className="confirmation-checklist-summary"
                      aria-expanded="true"
                      onClick={() => setChecklistOpen(false)}
                    >
                      <span>收起检查明细</span>
                      <span aria-hidden="true">▴ 收起</span>
                    </button>
                  </div>
                </>
              ) : (
                /* 折叠成一行摘要：检查数字一眼可查，长表按需展开（UI 审核）。 */
                <button
                  type="button"
                  className="confirmation-checklist-summary"
                  aria-expanded="false"
                  onClick={() => setChecklistOpen(true)}
                >
                  <span>
                    {formatCount(inspection.statistics.total)} 行 · 银行{" "}
                    {formatCount(inspection.statistics.bank)} · 往来{" "}
                    {formatCount(inspection.statistics.trade)}
                  </span>
                  <span aria-hidden="true">▸ 展开</span>
                </button>
              )
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
