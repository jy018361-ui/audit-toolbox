import { ErrorBox } from "@/components/ErrorBox";
import { JobProgress } from "@/components/JobProgress";
import { ResultView } from "@/components/ResultView";
import { Button } from "@/components/ui/button";
import type { JobEvent } from "@/types";

export const TASK_STATE_TOOL_IDS = [
  "fx_audit",
  "deposit_interest",
  "loan_interest",
  "fa_list",
  "fa_dep_calc",
  "fa_policy_compare",
  "kanzhang",
  "je_sign_mark",
  "ts_manager",
  "confirmation_progress",
  "Excel_Merger",
  "file_list_directory",
  "pdf_to_excel",
  "audipick",
  "audit_roll_forward",
  "wp_service_generator",
  "fuzzy_match",
  "tbje_check",
] as const;

export const TASK_STATE_SCENARIOS = [
  "loading",
  "queued",
  "running",
  "paused",
  "cancelled",
  "failed",
  "completed",
  "partial",
  "restored",
  "history_resume",
] as const;

export type TaskStateScenario = (typeof TASK_STATE_SCENARIOS)[number];

const LONG_NAME =
  "客户集团_2026年度_合并范围变更后重新导出的特别长文件名_包含多层级说明与无空格识别码_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.xlsx";
const LONG_PATH = [
  "C:",
  "客户资料",
  "集团审计",
  "2026年度",
  "期末审计",
  "第十七次修订",
  LONG_NAME,
].join("\\");
const LONG_ERROR =
  "任务失败：字段映射与源文件表头不一致。请重新检查来源工作表、标题行和必填字段后重试。诊断信息：COLUMN_MAPPING_VALIDATION_FAILED_WITH_A_VERY_LONG_UNBROKEN_IDENTIFIER_0123456789";

function event(toolId: string, scenario: TaskStateScenario): JobEvent {
  const common = {
    jobId: `fixture-${toolId}`,
    toolId,
    outputPaths: [] as string[],
  };
  if (scenario === "queued")
    return { ...common, phase: "queued", current: 0, total: 0, message: `“${LONG_NAME}”已进入队列，正在等待本机处理资源…`, severity: "info" };
  if (scenario === "paused")
    return { ...common, phase: "memory_paused", current: 38, total: 100, message: "内存紧张，任务已在安全检查点暂停；释放内存后可继续。", severity: "warning" };
  if (scenario === "cancelled")
    return { ...common, phase: "cancelled", current: 41, total: 100, message: "任务已取消；未发布未完成的输出文件。", severity: "warning" };
  if (scenario === "failed")
    return { ...common, phase: "failed", current: 63, total: 100, message: LONG_ERROR, severity: "error" };
  if (scenario === "completed")
    return { ...common, phase: "completed", current: 100, total: 100, message: "处理完成，已生成 2 个结果文件。", severity: "success", outputPaths: [LONG_PATH] };
  if (scenario === "partial")
    return { ...common, phase: "completed", current: 100, total: 100, message: "处理完成，但有 27 项需要复核。", severity: "warning", result: { warnings: Array.from({ length: 27 }, (_, index) => `第 ${index + 1} 项：${LONG_PATH}`) } };
  if (scenario === "loading")
    return { ...common, phase: "read", current: 12860, total: 0, message: `正在读取 ${LONG_PATH}`, severity: "info" };
  return { ...common, phase: "running", current: 67, total: 100, message: `正在处理 ${LONG_PATH}`, severity: "info" };
}

export function TaskStateFixture() {
  const params = new URLSearchParams(window.location.search);
  const toolId = params.get("tool") || TASK_STATE_TOOL_IDS[0];
  const requested = params.get("state") as TaskStateScenario | null;
  const scenario = TASK_STATE_SCENARIOS.includes(requested as TaskStateScenario)
    ? (requested as TaskStateScenario)
    : "running";
  const job = event(toolId, scenario);
  const completed = scenario === "completed" || scenario === "partial";

  return (
    <main className="task-state-fixture" data-tool-id={toolId} data-state={scenario}>
      <header>
        <p>任务状态布局夹具 · {toolId}</p>
        <h1>{scenario}</h1>
      </header>
      <section className="form-card">
        <h2>动态字段映射</h2>
        <div className="task-state-mapping-grid">
          {Array.from({ length: 8 }, (_, index) => (
            <label className="field" key={index}>
              字段 {index + 1}：包含较长的自动识别说明
              <select defaultValue="long">
                <option value="long">{LONG_NAME}</option>
              </select>
            </label>
          ))}
        </div>
      </section>
      <section className="result-card">
        <h2>任务进度与结果</h2>
        {!['restored', 'history_resume'].includes(scenario) && (
          <JobProgress job={job} onCancel={() => undefined} />
        )}
        {scenario === "failed" && <ErrorBox error={LONG_ERROR} onRetry={() => undefined} onDismiss={() => undefined} />}
        {completed && (
          <ResultView
            value={scenario === "partial" ? job.result : { message: job.message, outputPaths: [LONG_PATH, `${LONG_PATH}.副本.xlsx`], rows: 128600 }}
          />
        )}
        {scenario === "restored" && (
          <div className="restore-notice" role="status">
            <strong>已恢复上次任务的输入。</strong>
            <p>原文件已不存在：{LONG_PATH}，请重新选择后再运行。</p>
          </div>
        )}
        {scenario === "history_resume" && (
          <article className="task-row">
            <div><strong>{LONG_NAME}</strong><p>{LONG_ERROR}</p></div>
            <time dateTime="2026-09-05T08:00:00+08:00">2026/09/05 08:00</time>
            <Button type="button">继续任务</Button>
          </article>
        )}
      </section>
    </main>
  );
}
