import { useEffect, useRef, useState } from "react";
import { MemoryRouter } from "react-router-dom";
import { ConfirmDialogHost, confirmDialog } from "@/components/ConfirmDialog";
import { JobDialogProvider } from "@/components/JobDialog";
import { SyncBusyDialog } from "@/components/SyncBusyDialog";
import { BeginnerTour, type TourStep } from "@/components/tour/BeginnerTour";
import { StepTourHint } from "@/components/tour/StepTourHint";
import { SuccessNudge } from "@/components/tour/SuccessNudge";
import { JargonTip } from "@/components/JargonTip";
import { FuzzyBatchConfirmDialog } from "@/FuzzyMatchPage";
import type { JobEvent } from "@/types";
import "./OverlayStateFixture.css";

const longText = "超长项目名称与网络路径".repeat(18);
const longPath = String.raw`\\审计共享盘\集团客户\2026年度审计\未分类底稿\${"非常长的客户名称_".repeat(16)}\最终复核版本_请勿覆盖.xlsx`;
const longError = `处理失败：${"无法读取工作簿中的受保护工作表；请关闭占用文件的 Excel 窗口后重试。".repeat(14)}`;

function job(jobId: string, toolId: string, current: number): JobEvent {
  return {
    jobId,
    toolId,
    phase: "running",
    current,
    total: 100,
    message: `${longText}：正在处理第 ${current} 批数据，请勿关闭应用。`,
    severity: current > 70 ? "warning" : "info",
    outputPaths: [],
  };
}

function ConfirmFixture() {
  const triggerRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const timer = window.setTimeout(() => {
      triggerRef.current?.focus();
      triggerRef.current?.click();
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);
  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        data-fixture-return-focus="confirm"
        onClick={() => void confirmDialog({
        title: longText,
        message: Array.from({ length: 18 }, (_, index) =>
          `第 ${index + 1} 项：${index % 2 ? longError : longPath}`,
        ).join("\n"),
        tone: "danger",
        })}
      >
        打开长错误确认框
      </button>
      <ConfirmDialogHost />
    </>
  );
}

function StepFixture() {
  const [current, setCurrent] = useState(0);
  useEffect(() => {
    const timer = window.setTimeout(() => setCurrent(1), 0);
    return () => window.clearTimeout(timer);
  }, []);
  return (
    <div className="step-indicator" data-tour="step-indicator">
      <button type="button">第一步</button>
      <button type="button">第二步</button>
      <StepTourHint
        current={current}
        autoDismissMs={60_000}
        steps={[
          { key: "one", label: "准备文件" },
          { key: "two", label: longText },
        ]}
      />
    </div>
  );
}

const tourSteps: TourStep[] = [
  {
    id: "target",
    title: longText,
    body: `${longText}。${longPath}。${longError}。`,
    targetSelector: '[data-overlay-tour-target="true"]',
  },
];

function FuzzyFixture() {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const timer = window.setTimeout(() => {
      triggerRef.current?.focus();
      triggerRef.current?.click();
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);
  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        data-fixture-return-focus="fuzzy"
        onClick={() => setOpen(true)}
      >
        打开批量确认
      </button>
      <FuzzyBatchConfirmDialog
        open={open}
        count={12888}
        onOpenChange={setOpen}
        onConfirm={() => setOpen(false)}
      />
    </>
  );
}

/** Development-only state matrix used by scripts/overlay-layout-audit.cjs. */
export function OverlayStateFixture() {
  const scenario = new URLSearchParams(window.location.search).get("overlay-fixture") ?? "confirm";
  const jobs = scenario === "job-multi"
    ? Array.from({ length: 8 }, (_, index) => job(`job-${index}`, `工具${index}${longText}`, index * 12))
    : [job("job-1", `Excel 合并${longText}`, 37)];
  const combinedJobs = [...jobs, { ...job("done", "完成工具", 100), phase: "completed" as const, outputPaths: [longPath] }];

  return (
    <MemoryRouter>
      <main className="overlay-state-fixture" data-scenario={scenario}>
        <h1>浮层状态几何夹具</h1>
        <p className="overlay-fixture-long-content">{longPath} · {longError}</p>
        <button type="button" data-overlay-tour-target="true">被引导的长文案目标按钮</button>
        {scenario === "confirm" && <ConfirmFixture />}
        {scenario === "sync" && (
          <SyncBusyDialog
            fixtureEntries={Array.from({ length: 14 }, (_, index) => ({
              id: index,
              method: index % 2 ? "audipick.document_import" : "audipick.ocr",
            }))}
          />
        )}
        {(scenario === "job-single" || scenario === "job-multi" || scenario === "job-success-stack") && (
          <JobDialogProvider jobs={jobs} nameOf={(toolId) => toolId}>
            {scenario === "job-success-stack" && (
              <SuccessNudge
                autoDismissMs={60_000}
                toolNameOf={() => longText}
                jobs={combinedJobs}
              />
            )}
            <p>任务弹窗背景：{longError}</p>
          </JobDialogProvider>
        )}
        {scenario === "tour" && (
          <BeginnerTour steps={tourSteps} onFinish={() => undefined} />
        )}
        {(scenario === "step" || scenario === "step-confirm-stack") && <StepFixture />}
        {scenario === "step-confirm-stack" && <ConfirmFixture />}
        {scenario === "success" && (
          <SuccessNudge
            autoDismissMs={60_000}
            toolNameOf={() => longText}
            jobs={[{ ...job("done", "done", 100), phase: "completed", outputPaths: ["C:\\输出\\结果.xlsx"] }]}
          />
        )}
        {scenario === "jargon" && (
          <p>组合匹配键 <JargonTip term={longText} text={`${longText}。${longText}。`} /></p>
        )}
        {scenario === "fuzzy" && <FuzzyFixture />}
        {scenario === "jargon-confirm-stack" && (
          <div><JargonTip term={longText} text={`${longPath}。${longError}`} /><ConfirmFixture /></div>
        )}
      </main>
    </MemoryRouter>
  );
}
