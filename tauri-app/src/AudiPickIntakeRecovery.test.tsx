// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import type { ReactNode } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AudiPickPage } from "./AudiPickPage";
import type { ToolManifest } from "./types";
const api = vi.hoisted(() => ({ engineCall: vi.fn(), pickPath: vi.fn(), audipickPdfBytes: vi.fn(), recognize: vi.fn() }));
vi.mock("./api", () => ({
  ...api, settingsGet: vi.fn(async () => ({})), settingsSet: vi.fn(), jobStart: vi.fn(),
  jobCancel: vi.fn(), listenJobEvents: vi.fn(async () => () => {}),
}));
vi.mock("./audipickPdfPreparation", async (original) => ({ ...await original<object>(), recognizePdfPage: api.recognize }));
vi.mock("./restore", () => ({ useTaskRestore: vi.fn() }));
vi.mock("./audipickAssets", () => ({ audipickAssetsReady: () => true, loadAudipickAssets: vi.fn() }));
vi.mock("@/components/JobDialog", () => ({ useJobPause: () => ({ isPaused: false, togglePause: vi.fn() }) }));
vi.mock("./AudiPickLegacyShell", () => ({
  AudiPickLegacyShell: ({ children, onNavigate }: { children: ReactNode; onNavigate: (page: string) => void }) =>
    <><button onClick={() => onNavigate("workbench")}>工作台入口</button>{children}</>,
}));
vi.mock("./AudiPickLegacyDashboard", () => ({
  AudiPickLegacyDashboard: ({ projects, onContinueProject }: any) =>
    <button disabled={!projects.length} onClick={() => onContinueProject(projects[0])}>打开项目</button>,
}));
vi.mock("./AudiPickLegacyProject", () => ({
  AudiPickLegacyProject: ({ actions, associationSuggestions = [], busy, uploadStatus }: any) => <section aria-label="合同列表">
    <button disabled={busy} onClick={() => actions.onManageAssociation("a")}>关联资料</button>
    <button disabled={busy} onClick={actions.onPickPdfs}>上传合同</button>
    <button disabled={busy} onClick={actions.onPickFolder}>上传文件夹</button>
    <button disabled={busy} onClick={() => actions.onResumeOcr("a")}>继续识别</button>
    {associationSuggestions[0] && <button onClick={() => actions.onDismissAssociation(associationSuggestions[0].fileId, associationSuggestions[0].anchorFileId)}>忽略建议</button>}
    <output>{uploadStatus}</output>
  </section>,
}));
vi.mock("./AudiPickLegacyContract", () => ({ AudiPickLegacyContract: () => <p>合同详情页面</p> }));
let stored: any; let texts: Record<string, string>; let scanned: boolean; let ocrReady: boolean; let saveFails: boolean;
let docs: Array<{ id: string; name: string }>;
const text = "完整合同条款正文".repeat(20);
beforeEach(() => {
  vi.resetAllMocks(); scanned = false; ocrReady = true; saveFails = false; texts = {};
  docs = [{ id: "a", name: "主合同.pdf" }, { id: "b", name: "补充协议.pdf" }];
  stored = { project: { id: "p", name: "回归项目", defaultRuleId: "loan_covenant", relationGroups: [] },
    contracts: [], results: [{ id: "untouched", excerpt: "保留原有结果" }] };
  api.engineCall.mockImplementation(async (method, params) => {
    if (method === "audipick.projects") return { projects: [structuredClone(stored)] };
    if (method === "audipick.documents") return { documents: docs };
    if (method === "audipick.config_status") return { llm: { ready: false }, ocr: { engine: "baidu", ready: ocrReady } };
    if (method === "audipick.document_text") return { text: texts[params.documentId] ?? "" };
    if (method === "audipick.document_text_save") { texts[params.documentId] = params.text; return {}; }
    if (method === "audipick.project_save") { if (saveFails) throw new Error("保存关联失败"); stored = structuredClone(params); return {}; }
    if (method === "audipick.document_import") return docs[params.path.includes("补充") ? 1 : 0];
    if (method === "audipick.document_import_folder") return { documents: docs, imported: 2, skipped: 0 };
    return {};
  });
  api.pickPath.mockResolvedValue(["C:/主合同.pdf", "C:/补充协议.pdf"]);
  api.audipickPdfBytes.mockResolvedValue([]);
  api.recognize.mockResolvedValue("OCR 已识别正文");
  vi.stubGlobal("RuleEngine", { getAllSelectableRules: () => [{ id: "loan_covenant", name: "限制性契约" }], getFieldsForRule: () => [], setCustomRules: vi.fn() });
  vi.stubGlobal("pdfjsLib", { GlobalWorkerOptions: {}, getDocument: () => ({ promise: Promise.resolve({
    numPages: 1, destroy: vi.fn(), getPage: async () => ({
      getTextContent: async () => ({ items: [{ str: scanned ? "" : text }] }),
      getViewport: () => ({ width: 100, height: 100 }), render: () => ({ promise: Promise.resolve() }), cleanup: vi.fn(),
    }),
  }) }) });
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as any);
  vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue("data:image/jpeg;base64,dGVzdA==");
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); localStorage.clear(); });
async function openProject() {
  render(<MemoryRouter><AudiPickPage tool={{ id: "audipick", name: "AudiPick" } as ToolManifest} /></MemoryRouter>);
  fireEvent.click(screen.getByText("工作台入口"));
  await waitFor(() => expect(screen.getByText("打开项目")).toBeEnabled());
  fireEvent.click(screen.getByText("打开项目"));
  await screen.findByRole("region", { name: "合同列表" });
  await waitFor(() => expect(screen.getByText("关联资料")).toBeEnabled());
}
it("列表打开关联、保存和重开均不跳详情，不读PDF；支持解除关联", async () => {
  await openProject();
  fireEvent.click(screen.getByText("关联资料"));
  expect(await screen.findByRole("dialog")).toBeInTheDocument();
  expect(screen.queryByText("合同详情页面")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("checkbox", { name: "选择补充协议.pdf" }));
  fireEvent.click(screen.getByText("保存关联"));
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  expect(stored.project.relationGroups[0].anchorFileId).toBe("a");
  expect(stored.results[0].id).toBe("untouched");
  expect(api.audipickPdfBytes).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText("关联资料"));
  expect(screen.getByRole("checkbox", { name: "选择补充协议.pdf" })).toBeChecked();
  fireEvent.click(screen.getByRole("checkbox", { name: "选择补充协议.pdf" }));
  fireEvent.click(screen.getByText("保存关联"));
  await waitFor(() => expect(stored.project.relationGroups).toEqual([]));
});
it("关联取消/Escape不写数据，保存失败保留弹窗和勾选", async () => {
  await openProject();
  fireEvent.click(screen.getByText("关联资料"));
  fireEvent.click(screen.getByRole("checkbox", { name: "选择补充协议.pdf" }));
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  expect(stored.project.relationGroups).toEqual([]);
  fireEvent.click(screen.getByText("关联资料"));
  fireEvent.click(screen.getByRole("checkbox", { name: "选择补充协议.pdf" }));
  saveFails = true; fireEvent.click(screen.getByText("保存关联"));
  await screen.findByText("保存关联失败");
  expect(screen.getByRole("checkbox", { name: "选择补充协议.pdf" })).toBeChecked();
  expect(screen.queryByText("合同详情页面")).not.toBeInTheDocument();
});
it("上传多个文字PDF自动读取且留在列表，不需要AI；两份进度及历史结果均保留", async () => {
  await openProject();
  fireEvent.click(screen.getByText("上传合同"));
  await screen.findByText(/已完成 2 份合同的文字读取/);
  expect(texts.a).toContain(text); expect(texts.b).toContain(text);
  expect(stored.contracts).toEqual(expect.arrayContaining([expect.objectContaining({ id: "a", ocrPending: false }), expect.objectContaining({ id: "b", ocrPending: false })]));
  expect(stored.results[0].id).toBe("untouched");
  expect(api.recognize).not.toHaveBeenCalled();
  expect(screen.queryByText("合同详情页面")).not.toBeInTheDocument();
});
it("文件夹上传扫描件自动调用OCR，AI未配置不阻挡百度OCR", async () => {
  scanned = true; api.pickPath.mockResolvedValue("C:/合同目录");
  await openProject(); fireEvent.click(screen.getByText("上传文件夹"));
  await screen.findByText(/已完成 2 份合同的文字读取/);
  expect(api.recognize).toHaveBeenCalledTimes(2);
  expect(texts.a).toContain("OCR 已识别正文");
  expect(screen.queryByText("合同详情页面")).not.toBeInTheDocument();
});
it("OCR未配置不会假报完成；配置后从列表继续识别并复用已有页", async () => {
  scanned = true; ocrReady = false;
  await openProject(); fireEvent.click(screen.getByText("上传合同"));
  await screen.findByText(/需要 OCR。请完成 OCR 配置/);
  expect(stored.contracts.find((item: any) => item.id === "a").ocrPending).toBe(true);
  expect(api.recognize).not.toHaveBeenCalled();
  ocrReady = true;
  fireEvent.click(screen.getByText("继续识别"));
  await screen.findByText(/已完成 1 份合同的文字读取/);
  expect(api.recognize).toHaveBeenCalledOnce();
  expect(screen.queryByText("合同详情页面")).not.toBeInTheDocument();
});
it("中置信关联建议可忽略并持久化，重新派生时不再出现", async () => {
  docs = [{ id: "a", name: "项目主合同.pdf" }, { id: "b", name: "技术附件.pdf" }];
  texts = { a: "合同编号：LOAN-ABCD", b: "技术附件\n合同编号：LOAN-ABCD" };
  await openProject();
  fireEvent.click(await screen.findByText("忽略建议"));
  await waitFor(() => expect(stored.project.dismissedAssociations).toContain("a>b"));
  await waitFor(() => expect(screen.queryByText("忽略建议")).not.toBeInTheDocument());
});
it("高置信质押资料自动关联并保留 AI 来源", async () => {
  docs = [{ id: "a", name: "C320借款合同.pdf" }, { id: "b", name: "C320借款合同_质押合同.pdf" }];
  await openProject();
  await waitFor(() => expect(stored.project.relationGroups?.[0]?.members?.[0]).toEqual(expect.objectContaining({
    fileId: "b",
    role: "担保/抵质押资料",
    source: "ai",
    confidence: "high",
  })));
});
