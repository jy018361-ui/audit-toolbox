// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AudiPickPage } from "./AudiPickPage";
import type { ToolManifest } from "./types";

const api = vi.hoisted(() => ({ engineCall: vi.fn(), pickPath: vi.fn(), jobStart: vi.fn() }));
vi.mock("./api", () => ({ ...api, settingsGet: async () => ({}), settingsSet: vi.fn(),
  audipickPdfBytes: async () => [1], jobCancel: vi.fn(), listenJobEvents: async () => () => {} }));
vi.mock("./restore", () => ({ useTaskRestore: vi.fn() }));
vi.mock("@/components/ConfirmDialog", () => ({ confirmDialog: async () => true }));
vi.mock("./audipickAssets", () => ({ audipickAssetsReady: () => true, loadAudipickAssets: vi.fn() }));
vi.mock("@/components/JobDialog", () => ({ useJobPause: () => ({ isPaused: false, togglePause: vi.fn() }) }));
vi.mock("./AudiPickLegacyShell", () => ({ AudiPickLegacyShell: ({ children, onNavigate }: any) => <><button onClick={() => onNavigate("workbench")}>工作台入口</button>{children}</> }));
vi.mock("./AudiPickLegacyDashboard", () => ({ AudiPickLegacyDashboard: ({ projects, onContinueProject }: any) => <button disabled={!projects.length} onClick={() => onContinueProject(projects[0])}>项目入口</button> }));
vi.mock("./AudiPickLegacyProject", () => ({ AudiPickLegacyProject: ({ actions }: any) => <>
  <button onClick={() => actions.onPickPdfs()}>导入测试PDF</button>
  <button onClick={() => actions.onExtractDocument("tax")}>税表单份提取</button>
  <button onClick={() => actions.onBatchExtract(["tax"])}>税表批量提取</button>
  <button onClick={() => actions.onOpenDocument("tax")}>打开税表</button>
  <button onClick={() => actions.onDeleteDocument("tax")}>删除测试税表</button>
</> }));
vi.mock("./AudiPickTaxWorkflow", () => ({ AudiPickTaxWorkflow: ({ documents, onClose }: any) => <section data-testid="tax-workflow">
  {documents.map((doc: any) => doc.name).join("、")}<button onClick={onClose}>关闭税表流程</button>
</section> }));

let stored: any;
beforeEach(() => {
  vi.clearAllMocks();
  stored = { project: { id: "p", name: "测试税表项目", defaultRuleId: "tax_corporate_income" },
    contracts: [{ id: "tax", ruleId: "tax_corporate_income", ruleConfirmed: true }], results: [] };
  api.pickPath.mockResolvedValue(["D:/test/申报.pdf"]);
  api.engineCall.mockImplementation(async (method: string, params: any) => {
    if (method === "audipick.projects") return { projects: [structuredClone(stored)] };
    if (method === "audipick.documents") return { documents: [{ id: "tax", name: "申报.pdf", path: "D:/test/申报.pdf", status: "ready", size: 1, sha256: "hash" }] };
    if (method === "audipick.config_status") return { llm: { ready: true }, ocr: { ready: true } };
    if (method === "audipick.document_import") return { id: "tax", name: "申报.pdf" };
    if (method === "audipick.project_save") { stored = structuredClone(params); return {}; }
    if (method === "audipick.document_text") return { text: "" };
    return {};
  });
  vi.stubGlobal("RuleEngine", {
    getAllSelectableRules: () => [{ id: "tax_corporate_income", name: "纳税申报表·企业所得税", version: "2.0" }],
    getFieldsForRule: () => [{ key: "pages", label: "页码" }], getRulePrompt: () => "税表", getCustomRules: () => [], setCustomRules: vi.fn(),
  });
  vi.stubGlobal("pdfjsLib", { GlobalWorkerOptions: {}, getDocument: () => ({ promise: Promise.resolve({ numPages: 2, destroy: vi.fn(),
    getPage: async (n: number) => ({ getTextContent: async () => ({ items: [{ str: n === 1 ? "企业所得税年度纳税申报表\n纳税人名称：测试企业有限公司" : "" }] }), cleanup: vi.fn() }),
  }) }) });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

async function openProject() {
  render(<MemoryRouter><AudiPickPage tool={{ id: "audipick", name: "AudiPick" } as ToolManifest} /></MemoryRouter>);
  fireEvent.click(await screen.findByText("工作台入口"));
  await waitFor(() => expect(screen.getByText("项目入口")).toBeEnabled());
  fireEvent.click(screen.getByText("项目入口"));
  await screen.findByText("导入测试PDF");
}

it("defers full OCR on tax upload and opens the page/type selection workflow", async () => {
  await openProject();
  fireEvent.click(screen.getByText("导入测试PDF"));
  await screen.findByTestId("tax-workflow");
  expect(api.jobStart).not.toHaveBeenCalled();
  expect(api.engineCall.mock.calls.some(([method]) => method === "audipick.document_text_save")).toBe(false);
  expect(stored.taxWorkflow.indexes.tax.taxType).toBe("corporate_income");
});

it.each(["税表单份提取", "税表批量提取", "打开税表"])("routes %s to tax selection rather than the contract extractor", async (label) => {
  await openProject();
  fireEvent.click(screen.getByText(label));
  expect(await screen.findByTestId("tax-workflow")).toHaveTextContent("申报.pdf");
  expect(api.jobStart).not.toHaveBeenCalled();
});

it("deletes the tax index, page cache and tables with their document", async () => {
  stored.taxWorkflow = { indexes: { tax: { taxType: "corporate_income" } }, pageTexts: { tax: { 1: "税表" } }, pageTextVersions: { tax: { 1: "tax-structured-page-v3" } },
    pageOverrides: { tax: { A105000: "1" } }, selectedFormKeys: ["A105000"], tables: [{ documentId: "tax", formKey: "A105000" }] };
  await openProject();
  fireEvent.click(screen.getByText("删除测试税表"));
  await waitFor(() => expect(api.engineCall.mock.calls.some(([method]) => method === "audipick.document_delete")).toBe(true));
  await waitFor(() => expect(stored.taxWorkflow.tables).toEqual([]));
  expect(stored.taxWorkflow.indexes).toEqual({});
  expect(stored.taxWorkflow.pageTexts).toEqual({});
  expect(stored.taxWorkflow.pageTextVersions).toEqual({});
  expect(stored.taxWorkflow.pageOverrides).toEqual({});
});
