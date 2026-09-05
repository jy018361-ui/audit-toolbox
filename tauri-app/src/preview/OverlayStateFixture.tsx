import { useEffect, useState } from "react";
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

const longText = "超长项目名称与网络路径".repeat(18);

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
  useEffect(() => {
    const timer = window.setTimeout(() => {
      void confirmDialog({
        title: longText,
        message: Array.from({ length: 18 }, (_, index) =>
          `第 ${index + 1} 项：${longText}`,
        ).join("\n"),
        tone: "danger",
      });
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);
  return <ConfirmDialogHost />;
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
    body: `${longText}。${longText}。${longText}。`,
    targetSelector: '[data-overlay-tour-target="true"]',
  },
];

/** Development-only state matrix used by scripts/overlay-layout-audit.cjs. */
export function OverlayStateFixture() {
  const scenario = new URLSearchParams(window.location.search).get("overlay-fixture") ?? "confirm";
  const jobs = scenario === "job-multi"
    ? Array.from({ length: 8 }, (_, index) => job(`job-${index}`, `工具${index}${longText}`, index * 12))
    : [job("job-1", `Excel 合并${longText}`, 37)];
  const [fuzzyOpen, setFuzzyOpen] = useState(true);

  return (
    <MemoryRouter>
      <main className="overlay-state-fixture" data-scenario={scenario}>
        <h1>浮层状态几何夹具</h1>
        <p>{longText}</p>
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
        {(scenario === "job-single" || scenario === "job-multi") && (
          <JobDialogProvider jobs={jobs} nameOf={(toolId) => toolId}>
            <p>任务弹窗背景</p>
          </JobDialogProvider>
        )}
        {scenario === "tour" && (
          <BeginnerTour steps={tourSteps} onFinish={() => undefined} />
        )}
        {scenario === "step" && <StepFixture />}
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
        {scenario === "fuzzy" && (
          <FuzzyBatchConfirmDialog
            open={fuzzyOpen}
            count={12888}
            onOpenChange={setFuzzyOpen}
            onConfirm={() => setFuzzyOpen(false)}
          />
        )}
      </main>
    </MemoryRouter>
  );
}
