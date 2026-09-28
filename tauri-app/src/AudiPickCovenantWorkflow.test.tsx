// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import type { ReactNode } from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AudiPickPage } from "./AudiPickPage";
import type { AudiPickLegacyContractProps } from "./AudiPickLegacyContract";
import type { AudiPickLegacyProjectActions } from "./AudiPickLegacyProject";
import type { JobEvent, ToolManifest } from "./types";
import { COVENANT_LABELS, PROCEDURE_LEVELS } from "./audipickCovenant";

const mocks = vi.hoisted(() => ({
  engineCall: vi.fn(),
  pickPath: vi.fn(),
  jobStart: vi.fn(),
  jobListeners: new Set<(event: JobEvent) => void>(),
}));
vi.mock("./api", () => ({
  engineCall: mocks.engineCall,
  pickPath: mocks.pickPath,
  settingsGet: vi.fn(async () => ({})),
  settingsSet: vi.fn(),
  audipickPdfBytes: vi.fn(async () => []),
  jobCancel: vi.fn(),
  jobStart: mocks.jobStart,
  listenJobEvents: vi.fn(async (listener: (event: JobEvent) => void) => {
    mocks.jobListeners.add(listener);
    return () => mocks.jobListeners.delete(listener);
  }),
}));
vi.mock("./restore", () => ({ useTaskRestore: vi.fn() }));
vi.mock("./audipickAssets", () => ({
  audipickAssetsReady: () => true,
  loadAudipickAssets: vi.fn(),
}));
vi.mock("@/components/JobDialog", () => ({
  useJobPause: () => ({ isPaused: false, togglePause: vi.fn() }),
}));
// Keep the real page's data flow; layout interactions have their own parity tests.
vi.mock("./AudiPickLegacyShell", () => ({
  AudiPickLegacyShell: ({
    children,
    onNavigate,
  }: {
    children: ReactNode;
    onNavigate: (page: string) => void;
  }) => (
    <>
      <button onClick={() => onNavigate("workbench")}>进入工作台</button>
      {children}
    </>
  ),
}));
vi.mock("./AudiPickLegacyDashboard", () => ({
  AudiPickLegacyDashboard: ({
    projects,
    onContinueProject,
  }: {
    projects: { id: string }[];
    onContinueProject: (project: { id: string }) => void;
  }) => (
    <button
      disabled={!projects.length}
      onClick={() => onContinueProject(projects[0])}
    >
      打开测试项目
    </button>
  ),
}));
vi.mock("./AudiPickLegacyProject", () => ({
  AudiPickLegacyProject: ({
    actions,
  }: {
    actions: AudiPickLegacyProjectActions;
  }) => (
    <>
      <button onClick={() => actions.onViewWorkpaper("doc", "loan_covenant")}>
        打开测试底稿
      </button>
      <button onClick={() => actions.onExportProject()}>测试项目导出</button>
      <button onClick={() => actions.onExtractDocument("doc")}>测试列表单份提取</button>
      <button onClick={() => actions.onBatchExtract(["doc"])}>测试批量契约提取</button>
    </>
  ),
}));
vi.mock("./AudiPickLegacyContract", () => ({
  AudiPickLegacyContract: (props: AudiPickLegacyContractProps) => (
    <>
      <output data-testid="rows">{JSON.stringify(props.workpaper.rows)}</output>
      <output data-testid="diagnostics">{JSON.stringify(props.workpaper.covenantDiagnostics)}</output>
      <output data-testid="count">
        {props.workpaper.rows.length}/{props.workpaper.totalCount}
      </output>
      <output data-testid="preview-open">{String(props.previewOpen)}</output>
      <button
        disabled={props.busy}
        onClick={() => props.workpaper.onProcedureLevelChange?.("one", "3")}
      >
        测试降级
      </button>
      <button
        disabled={props.busy}
        onClick={() => props.workpaper.onProcedureLevelChange?.("one", "auto")}
      >
        恢复自动
      </button>
      <button onClick={() => props.workpaper.onProcedureFilterChange?.("1")}>
        只看一级
      </button>
      <button onClick={() => props.workpaper.onProcedureFilterChange?.("3")}>
        只看三级
      </button>
      <button disabled={props.busy} onClick={props.fileFlow.onExtract}>
        测试单份提取
      </button>
      <button disabled={props.busy} onClick={props.fileFlow.onExportCurrent}>
        测试完整导出
      </button>
      <button disabled={props.busy} onClick={props.fileFlow.onExportAll}>
        测试文件导出
      </button>
      <button disabled={props.busy} onClick={props.workpaper.onExportFiltered}>
        测试筛选导出
      </button>
      <button onClick={props.onBackProject}>回项目</button>
    </>
  ),
}));

type StoredProject = {
  project: { id: string; name: string; defaultRuleId: string };
  contracts: { id: string; ruleId: string; ruleConfirmed: boolean }[];
  results: Record<string, unknown>[];
};
let stored: StoredProject;
let failSave: boolean;
beforeEach(() => {
  mocks.engineCall.mockReset();
  mocks.pickPath.mockReset().mockResolvedValue("C:\\test\\程序建议.xlsx");
  mocks.jobStart.mockReset();
  mocks.jobListeners.clear();
  mocks.jobStart.mockImplementation(async (method: string) => {
    const jobId = `extract-${mocks.jobStart.mock.calls.length}`;
    window.setTimeout(() => {
      for (const listener of mocks.jobListeners) {
        listener({
          jobId,
          toolId: "audipick",
          phase: "completed",
          current: 1,
          total: 1,
          message: "完成",
          severity: "success",
          outputPaths: [],
          result: method === "audipick.extract" ? { parsed: { coverage_complete: true, items: [{
            title: "资产负债率不超过65%",
            evidence: [{ line_start: 2, line_end: 2, role: "obligation" }],
          }] } } : {},
        });
      }
    }, 0);
    return jobId;
  });
  failSave = false;
  stored = {
    project: {
      id: "project",
      name: "契约测试",
      defaultRuleId: "loan_covenant",
    },
    contracts: [{ id: "doc", ruleId: "loan_covenant", ruleConfirmed: true }],
    results: [
      {
        id: "one",
        contractId: "doc",
        ruleId: "loan_covenant",
        excerpt: "资产负债率不得超过【】%。",
        breach_consequence: "贷款人有权要求提前还款。",
        covenant_scope: "repayment",
        title: "财务指标及资本金",
        pages: "1",
        reviewed: true,
      },
      {
        id: "three",
        contractId: "doc",
        ruleId: "loan_covenant",
        excerpt: "每季度报送财务报表。",
        breach_consequence: "逾期报送应支付违约金。",
        covenant_scope: "supplementary",
        title: "报送义务",
        pages: "2",
      },
      { id: "other", contractId: "doc", ruleId: "revenue", amount: "100元" },
    ],
  };
  mocks.engineCall.mockImplementation(
    async (method: string, params: unknown) => {
      if (method === "audipick.projects")
        return { projects: [structuredClone(stored)] };
      if (method === "audipick.documents")
        return {
          documents: [
            {
              id: "doc",
              name: "测试合同.pdf",
              path: "test.pdf",
              status: "ready",
            },
          ],
        };
      if (method === "audipick.document_text")
        return { text: "PDF第1页\n第19.1条 借款人资产负债率不得超过65%。\n第21.2条 违反第19.1条构成违约事件。\n第21.18条 发生违约事件，贷款人有权通知借款人要求提前还款。" };
      if (method === "audipick.extract") {
        return { parsed: { coverage_complete: true, items: [{
          title: "资产负债率不超过65%",
          evidence: [{ line_start: 2, line_end: 2, role: "obligation" }],
        }] } };
      }
      if (method === "audipick.config_status")
        return { llm: { ready: false }, ocr: { ready: false } };
      if (method === "audipick.project_save") {
        if (failSave) throw new Error("测试保存失败");
        stored = structuredClone(params as StoredProject);
        return { saved: true };
      }
      return {};
    },
  );
  vi.stubGlobal("RuleEngine", {
    getAllSelectableRules: () => [
      { id: "loan_covenant", name: "限制性契约" },
      { id: "revenue", name: "收入合同" },
    ],
    getFieldsForRule: () =>
      Object.entries(COVENANT_LABELS).map(([key, label]) => ({ key, label })),
    getRulePrompt: () => "限制性契约测试模板",
    setCustomRules: vi.fn(),
  });
  vi.stubGlobal("pdfjsLib", {
    GlobalWorkerOptions: {},
    getDocument: () => ({
      promise: Promise.resolve({
        numPages: 1,
        getPage: async () => ({
          getTextContent: async () => ({
            items: [{ str: "合同测试正文".repeat(20) }],
          }),
        }),
      }),
    }),
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

async function openWorkpaper() {
  render(
    <MemoryRouter>
      <AudiPickPage
        tool={{ id: "audipick", name: "AudiPick" } as ToolManifest}
      />
    </MemoryRouter>,
  );
  fireEvent.click(screen.getByText("进入工作台"));
  await waitFor(() => expect(screen.getByText("打开测试项目")).toBeEnabled());
  fireEvent.click(screen.getByText("打开测试项目"));
  fireEvent.click(await screen.findByText("打开测试底稿"));
  await waitFor(() => expect(screen.getByText("测试降级")).toBeEnabled());
  expect(screen.getByTestId("count")).toHaveTextContent("1/2");
}
const lastCall = (method: string) =>
  mocks.engineCall.mock.calls.filter(([name]) => name === method).at(-1)?.[1];

describe("AudiPick 页面程序等级存储和导出链路", () => {
  it("列表开始提取时留在项目页，先确认字段再启动后台任务", async () => {
    render(
      <MemoryRouter>
        <AudiPickPage tool={{ id: "audipick", name: "AudiPick" } as ToolManifest} />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByText("进入工作台"));
    fireEvent.click(await screen.findByText("打开测试项目"));
    fireEvent.click(await screen.findByText("测试列表单份提取"));
    expect(await screen.findByRole("dialog")).toHaveTextContent("选择提取字段");
    expect(screen.getByText("测试项目导出")).toBeInTheDocument();
    expect(screen.queryByTestId("rows")).not.toBeInTheDocument();
    expect(mocks.jobStart).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "开始提取" }));
    await waitFor(() => expect(mocks.jobStart).toHaveBeenCalledWith("audipick.extract", expect.any(Object)));
    expect(screen.getByText("测试项目导出")).toBeInTheDocument();
    expect(screen.queryByTestId("rows")).not.toBeInTheDocument();
  });

  it("进入合同详情时 PDF 预览默认保持关闭", async () => {
    await openWorkpaper();
    expect(screen.getByTestId("preview-open")).toHaveTextContent("false");
  });

  it("未完成关联保留可见诊断，正式底稿仍排除未验证证据", async () => {
    stored.results.push(
      { id: "unresolved-1", contractId: "doc", ruleId: "loan_covenant", covenant_scope: "unresolved", clause_ref: "第二十三条", _covenant_review_reason: "引用未定位", _covenant_rejected_evidence: [{ quote: "模型错误引文" }], excerpt: "真实后果锚点" },
      { id: "unresolved-2", contractId: "doc", ruleId: "loan_covenant", covenant_scope: "unresolved", clause_ref: "第二十三条", _covenant_review_reason: "引用未定位", excerpt: "另一段后果锚点" },
    );
    await openWorkpaper();
    expect(screen.getByTestId("diagnostics")).toHaveTextContent("引用未定位");
    expect(screen.getByTestId("diagnostics")).toHaveTextContent("模型错误引文");
    expect(screen.getByTestId("diagnostics")).toHaveTextContent('"count":2');
    expect(screen.getByTestId("rows")).not.toHaveTextContent("模型错误引文");
  });
  it("人工等级通过 project_save 保存，重开恢复；可恢复自动，原始证据和其他模板不变", async () => {
    await openWorkpaper();
    fireEvent.click(screen.getByText("测试降级"));
    await waitFor(() =>
      expect(stored.results[0].procedure_level_override).toBe(3),
    );
    expect(stored.results[0].reviewed).toBe(false);
    expect(stored.results[0].excerpt).toBe("资产负债率不得超过【】%。");
    expect(stored.results[2]).toMatchObject({ id: "other", amount: "100元" });
    cleanup();
    await openWorkpaper();
    expect(screen.getByTestId("rows")).toHaveTextContent(
      '"procedure_level_override":3',
    );
    fireEvent.click(screen.getByText("恢复自动"));
    await waitFor(() =>
      expect(stored.results[0]).not.toHaveProperty("procedure_level_override"),
    );
    expect(screen.getByTestId("rows")).not.toHaveTextContent(
      "procedure_level_override",
    );
    expect(
      mocks.engineCall.mock.calls.some(
        ([method]) => method === "audipick.extract",
      ),
    ).toBe(false);
  });
  it("保存失败提示错误且不改变界面等级或持久化结果", async () => {
    await openWorkpaper();
    failSave = true;
    fireEvent.click(screen.getByText("测试降级"));
    expect(await screen.findByText("测试保存失败")).toBeInTheDocument();
    expect(stored.results[0]).not.toHaveProperty("procedure_level_override");
    expect(screen.getByTestId("rows")).not.toHaveTextContent(
      "procedure_level_override",
    );
    expect(screen.getByText("测试降级")).toBeEnabled();
  });
  it("筛选导出仅含筛选项，完整导出始终保留全部当前结果", async () => {
    await openWorkpaper();
    fireEvent.click(screen.getByText("只看一级"));
    expect(screen.getByTestId("count")).toHaveTextContent("1/2");
    fireEvent.click(screen.getByText("测试筛选导出"));
    await waitFor(() =>
      expect(lastCall("audipick.export")?.results).toHaveLength(1),
    );
    expect(lastCall("audipick.export").results[0]).toMatchObject({
      建议等级: PROCEDURE_LEVELS[1],
      违反约定的后果: "提前还款（贷款人有权要求）",
    });
    expect(Object.keys(lastCall("audipick.export").results[0])).toEqual(["分类", "建议等级", "条款及限制内容", "触发标准", "合同原文摘录", "原文引用出处", "违反约定的后果", "建议审计程序"]);
    expect(lastCall("audipick.export").results[0].合同原文摘录).not.toContain("文件：测试合同.pdf");
    expect(lastCall("audipick.export").results[0].原文引用出处).toContain("测试合同.pdf");
    expect(lastCall("audipick.export").columns).not.toContain("证据待复核");
    expect(mocks.pickPath.mock.calls.at(-1)?.[3]).toContain("筛选结果");
    await waitFor(() => expect(screen.getByText("测试完整导出")).toBeEnabled());
    fireEvent.click(screen.getByText("测试完整导出"));
    await waitFor(() =>
      expect(lastCall("audipick.export")?.results).toHaveLength(1),
    );
    expect(lastCall("audipick.export").columns).not.toContain("建议核查方式");
  });
  it("当前文件和项目导出均添加契约建议，不修改收入模板字段", async () => {
    await openWorkpaper();
    fireEvent.click(screen.getByText("只看一级"));
    fireEvent.click(screen.getByText("测试文件导出"));
    await waitFor(() =>
      expect(lastCall("audipick.export_bundle")?.sheets).toHaveLength(2),
    );
    const sheets = lastCall("audipick.export_bundle").sheets;
    expect(sheets[0].rows).toHaveLength(2);
    expect(sheets[0].columns).toEqual(["分类", "建议等级", "条款及限制内容", "触发标准", "合同原文摘录", "原文引用出处", "违反约定的后果", "建议审计程序"]);
    expect(sheets[0].columns).not.toContain("所需资料／已有底稿");
    expect(sheets[1].rows).toEqual([
      { 文件名称: "测试合同.pdf", amount: "100元" },
    ]);
    await waitFor(() => expect(screen.getByText("测试文件导出")).toBeEnabled());
    fireEvent.click(screen.getByText("回项目"));
    fireEvent.click(await screen.findByText("测试项目导出"));
    await waitFor(() =>
      expect(
        mocks.engineCall.mock.calls.filter(
          ([method]) => method === "audipick.export_bundle",
        ),
      ).toHaveLength(2),
    );
    expect(lastCall("audipick.export_bundle").sheets).toEqual(sheets);
  });
  it("相同合同文字和提取版本再次提取时复用已核验结果", async () => {
    await openWorkpaper();
    fireEvent.click(screen.getByText("测试单份提取"));
    fireEvent.click(await screen.findByRole("button", { name: "开始提取" }));
    await waitFor(() => expect(mocks.jobStart.mock.calls.filter(([method]) => method === "audipick.extract")).toHaveLength(1));
    await waitFor(() => expect(screen.getByText("测试单份提取")).toBeEnabled());
    fireEvent.click(screen.getByText("测试单份提取"));
    fireEvent.click(await screen.findByRole("button", { name: "开始提取" }));
    await waitFor(() => expect(screen.getByText("测试单份提取")).toBeEnabled());
    expect(mocks.jobStart.mock.calls.filter(([method]) => method === "audipick.extract")).toHaveLength(1);
  });

  it("批量限制性契约使用与单合同相同的案例库流水线并直接保存", async () => {
    render(
      <MemoryRouter>
        <AudiPickPage tool={{ id: "audipick", name: "AudiPick" } as ToolManifest} />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByText("进入工作台"));
    fireEvent.click(await screen.findByText("打开测试项目"));
    fireEvent.click(await screen.findByText("测试批量契约提取"));
    fireEvent.click(await screen.findByRole("button", { name: "开始提取" }));
    await waitFor(() => expect(stored.results).toHaveLength(4));
    expect(stored.results.at(-1)).toMatchObject({
      contractId: "doc",
      ruleId: "loan_covenant",
      covenant_scope: "repayment",
      covenant_category: "财务报表指标",
      excerpt: "第19.1条 借款人资产负债率不得超过65%。",
    });
    expect(mocks.jobStart.mock.calls.filter(([method]) => method === "audipick.extract")).toHaveLength(1);
  });
});
