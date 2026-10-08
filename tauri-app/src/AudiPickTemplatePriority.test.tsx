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
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AudiPickPage } from "./AudiPickPage";
import type { JobEvent, ToolManifest } from "./types";

const api = vi.hoisted(() => ({
  engineCall: vi.fn(),
  pickPath: vi.fn(),
  jobStart: vi.fn(),
  jobListeners: new Set<(event: JobEvent) => void>(),
}));

vi.mock("./api", () => ({
  ...api,
  settingsGet: vi.fn(async () => ({})),
  settingsSet: vi.fn(),
  audipickPdfBytes: vi.fn(async () => [1, 2, 3]),
  jobCancel: vi.fn(),
  listenJobEvents: vi.fn(async (listener: (event: JobEvent) => void) => {
    api.jobListeners.add(listener);
    return () => api.jobListeners.delete(listener);
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
    projects: Array<{ id: string }>;
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
    documents,
  }: {
    actions: {
      onRuleChange: (id: string, ruleId: string) => void;
      onConfirmRule: (id: string, ruleId: string) => void;
      onExtractDocument: (id: string) => void;
      onBatchExtract: (ids: string[]) => void;
      onViewWorkpaper: (id: string, ruleId: string) => void;
    };
    documents: Array<{ id: string }>;
  }) => (
    <section>
      <button onClick={() => actions.onRuleChange("doc", "loan_covenant")}>
        列表选择限制性契约
      </button>
      <button onClick={() => actions.onConfirmRule("doc", "loan_covenant")}>
        列表确认限制性契约
      </button>
      <button onClick={() => actions.onExtractDocument("doc")}>
        列表开始提取
      </button>
      <button onClick={() => actions.onBatchExtract(documents.map((item) => item.id))}>
        列表批量提取
      </button>
      <button onClick={() => actions.onViewWorkpaper("doc", "loan_covenant")}>
        打开底稿
      </button>
    </section>
  ),
}));
vi.mock("./AudiPickLegacyContract", () => ({
  AudiPickLegacyContract: (props: any) => (
    <section>
      <output data-testid="detail-rule">{props.fileFlow.ruleId}</output>
      <output data-testid="detail-confirmed">
        {String(props.fileFlow.ruleConfirmed)}
      </output>
      <output data-testid="detail-version">{props.fileFlow.ruleVersion}</output>
      <output data-testid="wp-used">{props.workpaper.usedRuleName ?? ""}</output>
      <button onClick={() => props.fileFlow.onRuleChange("loan_covenant")}>
        详情选择限制性契约
      </button>
      <button onClick={() => props.fileFlow.onConfirmRule("loan_covenant")}>
        详情确认限制性契约
      </button>
      <button
        disabled={Boolean(props.busy || props.fileFlow.extractDisabled)}
        onClick={props.fileFlow.onExtract}
      >
        详情提取
      </button>
    </section>
  ),
}));

type StoredProject = {
  project: { id: string; name: string; defaultRuleId: string };
  contracts: Array<Record<string, unknown>>;
  results: Array<Record<string, unknown>>;
};
type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void };

const docs = [
  { id: "doc", name: "主合同.pdf", path: "doc.pdf", status: "ready" },
  { id: "doc2", name: "补充协议.pdf", path: "doc2.pdf", status: "ready" },
];
const contractText =
  "PDF第1页\n第19.1条 借款人资产负债率不得超过65%。\n第21.2条 违反第19.1条构成违约事件。\n第21.18条 发生违约事件，贷款人有权通知借款人要求提前还款。";

let stored: StoredProject;
let llmReady: boolean;
let classifyGate: Deferred<{ parsed: Record<string, unknown> }> | undefined;
let mutateRuleOnExtract: boolean;
let mutatedRuleOnExtract: boolean;

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function classifyResult() {
  return {
    parsed: {
      rule_id: "loan_general",
      doc_label: "借款·通用条款(高)",
      confidence: "high",
      reason: "测试：自动识别结果故意晚于用户确认。",
    },
  };
}

function extractionResult(params: Record<string, unknown>) {
  const prompt = String(params.prompt ?? "");
  if (mutateRuleOnExtract && !mutatedRuleOnExtract) {
    mutatedRuleOnExtract = true;
    stored.contracts = stored.contracts.map((contract) => ({
      ...contract,
      ruleId: "loan_general",
      ruleConfirmed: false,
      ruleSource: "user",
    }));
  }
  if (params.ruleId === "loan_covenant") {
    const line = Number(String(params.text ?? "").match(/\[L(\d+)\][^\n]*资产负债率/)?.[1] ?? 2);
    return {
      parsed: {
        coverage_complete: true,
        items: [{
          title: "资产负债率不超过65%",
          evidence: [{ line_start: line, line_end: line, role: "obligation" }],
        }],
      },
    };
  }
  if (prompt.includes("这是第一阶段")) {
    return {
      parsed: {
        coverage_complete: true,
        items: [
          {
            kind: "consequence",
            document_id: "doc",
            source_segment_id: "doc::s0",
            clause_ref: "第21.18条",
            anchor: "贷款人有权通知借款人要求提前还款",
            search_terms: ["第21.2条"],
          },
        ],
      },
    };
  }
  if (prompt.includes("这是第二阶段")) {
    return {
      parsed: {
        coverage_complete: true,
        items: [
          {
            candidate_id: "c1",
            title: "资产负债率不超过65%",
            clause_ref: "第19.1条、第21.2条、第21.18条",
            covenant_category: "财务类",
            contract_classification: "指标类",
            is_financial: "是",
            breach_consequence:
              "违反该指标构成违约事件，贷款人有权通知借款人要求提前还款。",
            covenant_scope: "repayment",
            auditor_summary: "按合同口径使用审定数据重新计算。",
            chain_complete: true,
            references_resolved: true,
            evidence: [
              {
                document_id: "doc",
                quote: "借款人资产负债率不得超过65%。",
                role: "obligation",
                clause_ref: "第19.1条",
              },
              {
                document_id: "doc",
                quote: "违反第19.1条构成违约事件。",
                role: "default",
                clause_ref: "第21.2条",
              },
              {
                document_id: "doc",
                quote: "发生违约事件，贷款人有权通知借款人要求提前还款。",
                role: "consequence",
                clause_ref: "第21.18条",
              },
            ],
          },
        ],
      },
    };
  }
  return { parsed: { items: [] } };
}

beforeEach(() => {
  vi.clearAllMocks();
  llmReady = false;
  classifyGate = undefined;
  mutateRuleOnExtract = false;
  mutatedRuleOnExtract = false;
  api.jobListeners.clear();
  stored = {
    project: { id: "project", name: "模板优先级测试", defaultRuleId: "loan_covenant" },
    contracts: [
      {
        id: "doc",
        ruleId: "loan_covenant",
        ruleConfirmed: true,
        ruleSource: "user",
      },
    ],
    results: [],
  };
  api.pickPath.mockResolvedValue("C:/test/result.xlsx");
  api.jobStart.mockImplementation(
    async (method: string, params: Record<string, unknown>) => {
      const jobId = `job-${api.jobStart.mock.calls.length}`;
      window.setTimeout(() => {
        for (const listener of api.jobListeners) {
          listener({
            jobId,
            toolId: "audipick",
            phase: "completed",
            current: 1,
            total: 1,
            message: "完成",
            severity: "success",
            outputPaths: [],
            result:
              method === "audipick.extract" ? extractionResult(params) : {},
          });
        }
      }, 0);
      return jobId;
    },
  );
  api.engineCall.mockImplementation(
    async (method: string, params: Record<string, unknown>) => {
      if (method === "audipick.projects") return { projects: [clone(stored)] };
      if (method === "audipick.documents") return { documents: docs };
      if (method === "audipick.config_status")
        return { llm: { ready: llmReady }, ocr: { ready: true } };
      if (method === "audipick.document_text") return { text: contractText };
      if (method === "audipick.document_text_save") return {};
      if (method === "audipick.project_save") {
        stored = clone(params as StoredProject);
        return {};
      }
      if (method === "audipick.classify") {
        if (classifyGate) return classifyGate.promise;
        return classifyResult();
      }
      if (method === "audipick.extract") return extractionResult(params);
      return {};
    },
  );
  vi.stubGlobal("RuleEngine", {
    getAllSelectableRules: () => [
      {
        id: "loan_covenant",
        name: "借款·限制性契约",
        version: "1.1",
      },
      {
        id: "loan_general",
        name: "借款·通用条款(高)",
        version: "2.0",
      },
    ],
    getFieldsForRule: (ruleId: string) =>
      ruleId === "loan_covenant"
        ? [
            { key: "excerpt", label: "合同原文摘录" },
            { key: "breach_consequence", label: "触发后果" },
          ]
        : [{ key: "summary", label: "摘要" }],
    getRulePrompt: () => "测试模板提示词",
    setCustomRules: vi.fn(),
  });
  vi.stubGlobal("pdfjsLib", {
    GlobalWorkerOptions: {},
    getDocument: () => ({
      promise: Promise.resolve({
        numPages: 1,
        destroy: vi.fn(),
        getPage: async () => ({
          getTextContent: async () => ({
            items: [{ str: contractText }],
          }),
          getViewport: () => ({ width: 100, height: 100 }),
          render: () => ({ promise: Promise.resolve() }),
          cleanup: vi.fn(),
        }),
      }),
    }),
  });
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as any);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function openProject() {
  render(
    <MemoryRouter>
      <AudiPickPage
        tool={{ id: "audipick", name: "AudiPick" } as ToolManifest}
      />
    </MemoryRouter>,
  );
  fireEvent.click(await screen.findByText("进入工作台"));
  await waitFor(() => expect(screen.getByText("打开测试项目")).toBeEnabled());
  fireEvent.click(screen.getByText("打开测试项目"));
  await screen.findByText("列表选择限制性契约");
}

async function openContract() {
  fireEvent.click(screen.getByText("打开底稿"));
  await waitFor(() => expect(screen.getByText("详情提取")).toBeEnabled());
}

async function confirmExtractionFields() {
  fireEvent.click(await screen.findByRole("button", { name: "开始提取" }));
}

it("用户确认限制性契约后，迟到的自动识别和重复提取都不得改写模板快照", async () => {
  stored.contracts = [{ id: "doc" }];
  llmReady = true;
  classifyGate = deferred();
  await openProject();
  await openContract();

  await waitFor(() =>
    expect(
      api.engineCall.mock.calls.some(([method]) => method === "audipick.classify"),
    ).toBe(true),
  );
  fireEvent.click(screen.getByText("详情选择限制性契约"));
  fireEvent.click(screen.getByText("详情确认限制性契约"));
  await waitFor(() =>
    expect(stored.contracts[0]).toMatchObject({
      ruleId: "loan_covenant",
      ruleConfirmed: true,
      ruleSource: "user",
    }),
  );

  classifyGate.resolve(classifyResult());
  await waitFor(() =>
    expect(stored.contracts[0].detectedRuleId).toBe("loan_general"),
  );
  expect(stored.contracts[0]).toMatchObject({
    ruleId: "loan_covenant",
    ruleConfirmed: true,
    ruleSource: "user",
    detectedLabel: "借款·通用条款(高)",
  });
  expect(screen.getByTestId("detail-rule")).toHaveTextContent("loan_covenant");
  expect(screen.getByTestId("detail-confirmed")).toHaveTextContent("true");
  expect(screen.getByTestId("detail-version")).toHaveTextContent("1.1");

  fireEvent.click(screen.getByText("详情提取"));
  await confirmExtractionFields();
  await waitFor(() => expect(api.jobStart.mock.calls.filter(([method]) => method === "audipick.extract")).toHaveLength(1));
  await waitFor(() => expect(stored.results).toHaveLength(1));
  expect(stored.results[0]).toMatchObject({
    contractId: "doc",
    ruleId: "loan_covenant",
    ruleName: "借款·限制性契约",
    ruleVersion: "1.1",
    fieldKeys: ["excerpt", "breach_consequence"],
  });
  await waitFor(() =>
    expect(screen.getByTestId("wp-used")).toHaveTextContent("借款·限制性契约"),
  );

  fireEvent.click(screen.getByText("详情提取"));
  await confirmExtractionFields();
  await waitFor(() => expect(stored.results).toHaveLength(2));
  expect(stored.results[1]).toMatchObject({
    ruleId: "loan_covenant",
    ruleName: "借款·限制性契约",
    ruleVersion: "1.1",
  });
  expect(
    api.jobStart.mock.calls
      .filter(([method]) => method === "audipick.extract")
      .every(([, params]) => params.ruleId === "loan_covenant"),
  ).toBe(true);
});

it("文件列表手工选择并确认限制性契约后，开始提取使用该模板", async () => {
  stored.contracts = [{ id: "doc" }];
  await openProject();
  fireEvent.click(screen.getByText("列表选择限制性契约"));
  fireEvent.click(screen.getByText("列表确认限制性契约"));
  await waitFor(() =>
    expect(stored.contracts[0]).toMatchObject({
      ruleId: "loan_covenant",
      ruleConfirmed: true,
      ruleSource: "user",
    }),
  );
  fireEvent.click(screen.getByText("列表开始提取"));
  await confirmExtractionFields();
  await waitFor(() => expect(api.jobStart.mock.calls.filter(([method]) => method === "audipick.extract")).toHaveLength(1));
  await waitFor(() => expect(stored.results).toHaveLength(1));
  expect(stored.results[0]).toMatchObject({
    contractId: "doc",
    ruleId: "loan_covenant",
    ruleName: "借款·限制性契约",
    ruleVersion: "1.1",
    fieldKeys: ["excerpt", "breach_consequence"],
  });
});
it("页面刷新/恢复后已确认模板保持最高优先级，不再自动识别覆盖", async () => {
  llmReady = true;
  await openProject();
  await openContract();
  expect(
    api.engineCall.mock.calls.filter(([method]) => method === "audipick.classify"),
  ).toHaveLength(0);
  expect(screen.getByTestId("detail-rule")).toHaveTextContent("loan_covenant");

  cleanup();
  await openProject();
  await openContract();
  expect(
    api.engineCall.mock.calls.filter(([method]) => method === "audipick.classify"),
  ).toHaveLength(0);
  expect(stored.contracts[0]).toMatchObject({
    ruleId: "loan_covenant",
    ruleConfirmed: true,
    ruleSource: "user",
  });
});

it("非契约模板批量任务也把模板快照传给 worker", async () => {
  stored.contracts = [
    {
      id: "doc",
      ruleId: "loan_general",
      ruleConfirmed: true,
      ruleSource: "user",
    },
    {
      id: "doc2",
      ruleId: "loan_general",
      ruleConfirmed: true,
      ruleSource: "user",
    },
  ];
  await openProject();
  fireEvent.click(screen.getByText("列表批量提取"));
  await confirmExtractionFields();
  await waitFor(() => expect(api.jobStart).toHaveBeenCalled());
  expect(api.jobStart.mock.calls[0][0]).toBe("audipick.extract");
  expect(api.jobStart.mock.calls[0][1]).toMatchObject({
    ruleId: "loan_general",
    ruleName: "借款·通用条款(高)",
    ruleVersion: "2.0",
    fieldKeys: ["summary"],
    fieldSetId: "loan_general:summary",
  });
});
it("批量提取锁定启动时每个文件的模板 ID/版本/字段", async () => {
  stored.contracts = [
    {
      id: "doc",
      ruleId: "loan_covenant",
      ruleConfirmed: true,
      ruleSource: "user",
    },
    {
      id: "doc2",
      ruleId: "loan_covenant",
      ruleConfirmed: true,
      ruleSource: "user",
    },
  ];
  mutateRuleOnExtract = true;
  await openProject();
  fireEvent.click(screen.getByText("列表批量提取"));
  await confirmExtractionFields();
  await waitFor(() => expect(stored.results).toHaveLength(2));

  for (const row of stored.results) {
    expect(row).toMatchObject({
      ruleId: "loan_covenant",
      ruleName: "借款·限制性契约",
      ruleVersion: "1.1",
    });
    expect(row.fieldKeys).toEqual(["excerpt", "breach_consequence"]);
  }
  expect(
    api.jobStart.mock.calls.filter(([method]) => method === "audipick.extract"),
  ).toHaveLength(2);
  expect(
    api.jobStart.mock.calls
      .filter(([method]) => method === "audipick.extract")
      .every(([, params]) => params.ruleId === "loan_covenant"),
  ).toBe(true);
});
