// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import OcrPage from "./OcrPage";
import { JobDialogProvider } from "./components/JobDialog";
import { openOcrSource } from "./ocrSource";
import type { OcrDocumentDetail, OcrProject } from "./ocrTypes";

const mocks = vi.hoisted(() => ({
  call: vi.fn(),
  job: vi.fn(),
  pick: vi.fn(),
  cancel: vi.fn(),
  pause: vi.fn(),
  extract: vi.fn(),
  dispose: vi.fn(),
  renderSource: vi.fn(),
  openOutput: vi.fn(),
  nativeDrag: vi.fn(
    async (_callback: (event: { type: string; paths?: string[] }) => void) =>
      () => {},
  ),
  confirm: vi.fn(),
}));
vi.mock("@/components/ConfirmDialog", () => ({ confirmDialog: mocks.confirm }));
vi.mock("./ocrApi", () => ({ ocrCall: mocks.call, runOcrJob: mocks.job }));
vi.mock("./api", () => ({
  jobCancel: mocks.cancel,
  jobPause: mocks.pause,
  pickPath: mocks.pick,
  listenNativeFileDragEvents: mocks.nativeDrag,
  openOutput: mocks.openOutput,
}));
vi.mock("./ocrSource", () => ({
  openOcrSource: vi.fn(async () => ({
    totalPages: 2,
    render: mocks.renderSource,
    dispose: mocks.dispose,
  })),
}));
vi.mock("./ocrScenarios", () => ({
  loadOcrScenarios: async () => [
    {
      id: "loan_general",
      name: "借款通用条款",
      version: "1",
      fields: [],
      defaultPrompts: [
        { id: "extract", label: "条款提取", prompt: "默认完整提取提示词" },
        { id: "consolidate", label: "分段汇总", prompt: "默认完整汇总提示词" },
      ],
    },
    {
      id: "custom",
      name: "自定义摘录",
      version: "1",
      fields: [],
      defaultPrompts: [
        { id: "extract", label: "自定义", prompt: "自定义默认提示词" },
      ],
    },
  ],
  withSavedOcrScenarios: (defaults: any[], saved: any[] = []) => [
    ...defaults,
    ...saved.map((item) => ({ ...item, defaultPrompts: item.stages })),
  ],
  getOcrPromptStages: (scenario: any, overrides?: any) =>
    structuredClone(overrides?.[scenario.id] ?? scenario.defaultPrompts),
  extractOcrScenario: mocks.extract,
}));
let savedProject: OcrProject;
let detail: OcrDocumentDetail;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.confirm.mockResolvedValue(true);
  vi.mocked(openOcrSource).mockImplementation(async () => ({
    totalPages: 2,
    render: mocks.renderSource,
    dispose: mocks.dispose,
  }));
  mocks.renderSource.mockResolvedValue("data:image/png;base64,aW1hZ2U=");
  mocks.openOutput.mockResolvedValue(undefined);
  savedProject = {
    id: "p",
    name: "测试项目",
    prompts: {},
    createdAt: "2026-10-27",
    updatedAt: "2026-10-27",
  };
  detail = {
    document: {
      id: "d",
      projectId: "p",
      name: "合成扫描件.pdf",
      mimeType: "application/pdf",
      totalPages: 2,
      revision: 1,
      status: "partial",
      sha256: "demo",
    },
    pages: [
      {
        page: 1,
        text: "原始正文",
        originalText: "原始正文",
        tables: [
          {
            id: "t",
            title: "明细表",
            rows: [
              ["账号", "金额"],
              ["001", "100.00"],
            ],
          },
        ],
        originalTables: [
          {
            id: "t",
            title: "明细表",
            rows: [
              ["账号", "金额"],
              ["001", "100.00"],
            ],
          },
        ],
        revision: 1,
        status: "completed",
        warnings: [],
      },
    ],
    extractions: [
      {
        id: "old",
        scenarioId: "loan_general",
        prompts: [],
        sourceRevision: 1,
        rows: [],
        columns: [],
        createdAt: "2026-10-27",
      },
    ],
  };
  mocks.call.mockImplementation(async (method, params) => {
    if (method === "ocr.projects")
      return { projects: [structuredClone(savedProject)] };
    if (method === "ocr.output_directory") return { outputDir: "C:/输出" };
    if (method === "ocr.config_status")
      return {
        ocr: { ready: true, engine: "测试" },
        llm: { ready: true, visionReady: true },
      };
    if (method === "ocr.documents")
      return { documents: [structuredClone(detail.document)] };
    if (method === "ocr.document") return structuredClone(detail);
    if (method === "ocr.document_prepare") {
      detail.document.totalPages = params.totalPages;
      return structuredClone(detail.document);
    }
    if (method === "ocr.project_save") {
      savedProject = { ...savedProject, ...params };
      return structuredClone(savedProject);
    }
    if (method === "ocr.page_save") {
      const page = {
        ...structuredClone(params.page),
        revision: params.expectedRevision + 1,
      };
      detail.pages = detail.pages.map((item) =>
        item.page === page.page ? page : item,
      );
      detail.document.revision++;
      return structuredClone(page);
    }
    if (method === "ocr.extraction_save") {
      const result = { ...params, id: "new", createdAt: "2026-10-27" };
      detail.extractions.push(result);
      return result;
    }
    if (method === "ocr.document_import")
      return { documents: [detail.document], failed: [] };
    return detail.document;
  });
  mocks.pause.mockResolvedValue(true);
  mocks.cancel.mockResolvedValue(true);
  mocks.pick.mockResolvedValue("C:/输出");
  mocks.extract.mockResolvedValue({
    rows: [
      { sourceFile: "合成扫描件.pdf", sourcePage: "1", evidence: "原始正文" },
    ],
    columns: [{ key: "evidence", label: "逐字证据" }],
  });
  mocks.job.mockImplementation(async (method, params, onJob) => {
    onJob?.("j");
    if (method === "ocr.export")
      return { outputPaths: ["C:/输出/合成扫描件.xlsx"] };
    const page = {
      ...detail.pages[0],
      page: params.page,
      revision: 1,
      text: "第二页完整正文",
      originalText: "第二页完整正文",
    };
    const oldIndex = detail.pages.findIndex(
      (item) => item.page === params.page,
    );
    if (oldIndex < 0) detail.pages.push(page);
    else detail.pages.splice(oldIndex, 1, page);
    return page;
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it("分段摘录、保存与自动导出共用持续进度，暂停阻止下一段且后台状态不被重开", async () => {
  const requests: { method: string; resolve: (value: any) => void; event: (value: any) => void }[] = [];
  mocks.job.mockImplementation((method, _params, onJob, onEvent) => {
    onJob?.(`batch-progress-${requests.length}`);
    return new Promise((resolve) => requests.push({ method, resolve, event: onEvent }));
  });
  mocks.extract.mockImplementation(async (options) => {
    for (let index = 0; index < 2; index++) {
      options.onProgress(`正在核对第 ${index + 1}/2 段`);
      options.onWorkProgress({ completed: index, total: 2 });
      await options.request({ prompt: "合成提示词", text: "合成原文" });
      options.onWorkProgress({ completed: index + 1, total: 2 });
    }
    return { rows: [], columns: [] };
  });
  await openDocument(false, true);
  fireEvent.click(screen.getByRole("button", { name: "下一步：场景摘录" }));
  await waitFor(() => expect(screen.getByLabelText("摘录场景")).toBeEnabled());
  fireEvent.change(screen.getByLabelText("摘录场景"), { target: { value: "loan_general" } });
  await waitFor(() => expect(screen.getByRole("button", { name: "开始摘录" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "开始摘录" }));
  await waitFor(() => expect(requests).toHaveLength(1));
  const dialog = screen.getByRole("dialog", { name: "OCR 摘录与导出" });
  expect(screen.getAllByRole("dialog")).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "暂停" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "继续" })).toBeEnabled());
  await act(async () => requests[0].resolve({}));
  expect(requests).toHaveLength(1);
  expect(screen.getByRole("progressbar", { name: "分段摘录进度" })).toHaveAttribute("value", "1");
  fireEvent.click(screen.getByRole("button", { name: "继续" }));
  await waitFor(() => expect(requests).toHaveLength(2));
  expect(screen.getByRole("dialog")).toBe(dialog);
  fireEvent.click(screen.getByRole("button", { name: "后台运行" }));
  await act(async () => requests[1].resolve({}));
  await waitFor(() => expect(requests).toHaveLength(3));
  expect(requests[2].method).toBe("ocr.export");
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "展开 OCR 摘录与导出进度" }));
  expect(screen.getByText("正在导出")).toBeInTheDocument();
  expect(screen.getByText("已处理 1 / 1 份文件")).toBeInTheDocument();
  expect(screen.getByRole("progressbar", { name: "导出进度" })).not.toHaveAttribute("value");
  mocks.pause.mockClear();
  fireEvent.click(screen.getByRole("button", { name: "暂停" }));
  await waitFor(() => expect(mocks.pause).toHaveBeenCalledWith("batch-progress-2", true));
  expect(mocks.pause).toHaveBeenCalledTimes(1);
  await waitFor(() => expect(screen.getByRole("button", { name: "继续" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "继续" }));
  await act(async () => requests[2].resolve({ outputPaths: ["C:/输出/合同.xlsx"] }));
  await screen.findByRole("status", { name: "导出结果" });
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

async function openDocument(showOriginal = true, managed = false) {
  render(
    <MemoryRouter>
      {managed ? (
        <JobDialogProvider jobs={[]} nameOf={() => "OCR"}>
          <OcrPage />
        </JobDialogProvider>
      ) : (
        <OcrPage />
      )}
    </MemoryRouter>,
  );
  const entry = await screen.findByRole("button", { name: /^合成扫描件.pdf/ });
  await waitFor(() => expect(entry).toBeEnabled());
  fireEvent.click(entry);
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "开始扫描" })).toBeEnabled(),
  );
  if (showOriginal && detail.pages.length) {
    fireEvent.click(screen.getByRole("button", { name: "原文查看" }));
    await screen.findByRole("region", { name: "全篇初始原文" });
  }
}

it("整批摘录取消通知当前请求，阻止保存与自动导出并关闭进度窗", async () => {
  let rejectRequest!: (error: Error) => void;
  mocks.job.mockImplementation((_method, _params, onJob) => {
    onJob?.("cancel-extraction-progress");
    return new Promise((_resolve, reject) => { rejectRequest = reject; });
  });
  mocks.extract.mockImplementation(async (options) => {
    await options.request({ prompt: "合成提示词", text: "合成原文" });
    return { rows: [], columns: [] };
  });
  await openDocument(false, true);
  fireEvent.click(screen.getByRole("button", { name: "下一步：场景摘录" }));
  await waitFor(() => expect(screen.getByLabelText("摘录场景")).toBeEnabled());
  fireEvent.change(screen.getByLabelText("摘录场景"), { target: { value: "loan_general" } });
  await waitFor(() => expect(screen.getByRole("button", { name: "开始摘录" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "开始摘录" }));
  await waitFor(() => expect(mocks.job).toHaveBeenCalledTimes(1));
  fireEvent.click(screen.getByRole("button", { name: "取消任务" }));
  await waitFor(() => expect(mocks.cancel).toHaveBeenCalledWith("cancel-extraction-progress"));
  expect(screen.getByRole("button", { name: "正在取消…" })).toBeDisabled();
  await act(async () => rejectRequest(new Error("合成摘录任务已取消")));
  await screen.findByText("合成摘录任务已取消");
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(mocks.job).toHaveBeenCalledTimes(1);
  expect(mocks.call.mock.calls.some(([method]) => method === "ocr.extraction_save")).toBe(false);
});

it("单独导出仅显示一个进度窗，未知进度动态等待，失败后可重新导出", async () => {
  let rejectExport!: (error: Error) => void;
  mocks.job.mockImplementation((_method, _params, onJob, onEvent) => {
    onJob?.("standalone-export-progress");
    onEvent?.({ phase: "export", current: 0, total: 1, message: "正在生成项目 Excel" });
    return new Promise((_resolve, reject) => { rejectExport = reject; });
  });
  await openDocument(false, true);
  fireEvent.click(screen.getByRole("button", { name: "导出文件" }));
  fireEvent.click(screen.getByRole("button", { name: "导出到目标目录" }));
  await screen.findByRole("dialog", { name: "OCR 摘录与导出" });
  await waitFor(() => expect(mocks.job).toHaveBeenCalledTimes(1));
  expect(screen.getAllByRole("dialog")).toHaveLength(1);
  expect(await screen.findByText("正在生成项目 Excel")).toBeInTheDocument();
  expect(screen.getByRole("progressbar", { name: "导出进度" })).toHaveClass("is-working");
  await act(async () => rejectExport(new Error("合成导出失败")));
  await screen.findByText("合成导出失败");
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "导出文件" })).toBeEnabled();
});

it("OCR 复用上传槽，点击选择与原生拖入文件/文件夹走相同导入流程", async () => {
  await openDocument();
  mocks.pick.mockResolvedValueOnce(["C:/扫描件/一.pdf", "C:/扫描件/二.png"]);
  fireEvent.click(screen.getByRole("button", { name: "导入文件" }));
  await waitFor(() =>
    expect(mocks.call).toHaveBeenCalledWith("ocr.document_import", {
      projectId: "p",
      paths: ["C:/扫描件/一.pdf", "C:/扫描件/二.png"],
      folder: undefined,
    }),
  );
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "导入文件" })).toBeEnabled(),
  );
  const receive = mocks.nativeDrag.mock.calls[0][0];
  await act(async () => receive({ type: "enter" }));
  expect(
    screen
      .getByRole("button", { name: "导入文件" })
      .closest(".file-drop-input"),
  ).toHaveClass("drag-hover");
  await act(async () =>
    receive({ type: "drop", paths: ["C:/扫描目录", "C:/额外.tiff"] }),
  );
  await waitFor(() =>
    expect(mocks.call).toHaveBeenCalledWith("ocr.document_import", {
      projectId: "p",
      paths: ["C:/扫描目录", "C:/额外.tiff"],
      folder: undefined,
    }),
  );
  expect(
    screen
      .getByRole("button", { name: "导入文件" })
      .closest(".file-drop-input"),
  ).not.toHaveClass("drag-hover");
});

it("OCR 保活隐藏页不导入其他工具收到的文件", async () => {
  await openDocument();
  const upload = screen.getByRole("button", { name: "导入文件" });
  const page = upload.closest(".ocr-page")!;
  page.setAttribute("hidden", "");
  await act(async () =>
    mocks.nativeDrag.mock.calls[0][0]({ type: "drop", paths: ["C:/会议.mp4"] }),
  );
  expect(mocks.call).not.toHaveBeenCalledWith(
    "ocr.document_import",
    expect.anything(),
  );
});

it("OCR 可直接导出，不要求选择场景或调用摘录", async () => {
  await openDocument();
  expect(screen.queryByLabelText("摘录场景")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "导出文件" }));
  fireEvent.click(
    await screen.findByRole("button", { name: "导出到目标目录" }),
  );
  await screen.findByRole("button", { name: "合成扫描件.xlsx" });
  expect(mocks.job).toHaveBeenCalledWith(
    "ocr.export",
    expect.objectContaining({ mode: "per_document", documentIds: ["d"] }),
    expect.any(Function),
    expect.any(Function),
  );
  expect(mocks.extract).not.toHaveBeenCalled();
  const operations = screen.getByRole("region", { name: "扫描操作" });
  const notice = within(operations).getByRole("status", { name: "导出结果" });
  expect(notice).toHaveTextContent("导出文件成功");
  expect(notice).toHaveTextContent("导出目录：C:/输出");
  expect(
    screen
      .getByRole("button", { name: "开始扫描" })
      .compareDocumentPosition(notice) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  fireEvent.click(within(notice).getByRole("button", { name: "打开导出目录" }));
  await waitFor(() => expect(mocks.openOutput).toHaveBeenCalledWith("C:/输出"));
});

it("第二步只展示自然语言摘录要求，保留内部汇总并保存实际使用版本", async () => {
  await openDocument();
  fireEvent.click(screen.getByRole("button", { name: "2 场景摘录" }));
  await screen.findByLabelText("摘录场景");
  await waitFor(() => expect(screen.getByLabelText("摘录场景")).toBeEnabled());
  fireEvent.change(screen.getByLabelText("摘录场景"), {
    target: { value: "loan_general" },
  });
  await screen.findByLabelText("条款提取摘录要求");
  await waitFor(() =>
    expect(screen.getByLabelText("条款提取摘录要求")).toBeEnabled(),
  );
  expect(screen.getByLabelText("条款提取摘录要求")).toHaveValue(
    "默认完整提取提示词",
  );
  expect(screen.queryByLabelText("分段汇总摘录要求")).not.toBeInTheDocument();
  expect(screen.getByText(/用自然语言说明想摘录什么/)).toHaveTextContent("未指定时自动安排合适的列");
  expect(screen.getAllByRole("textbox")).toHaveLength(1);
  fireEvent.change(screen.getByLabelText("条款提取摘录要求"), {
    target: { value: "只提取借款利率，附逐字证据" },
  });
  fireEvent.click(screen.getByRole("button", { name: "开始摘录" }));
  await waitFor(() => expect(mocks.extract).toHaveBeenCalled());
  expect(mocks.extract.mock.calls[0][0].stages[0].prompt).toBe(
    "只提取借款利率，附逐字证据",
  );
  expect(savedProject.prompts.loan_general[0].prompt).toBe(
    "只提取借款利率，附逐字证据",
  );
  expect(mocks.extract.mock.calls[0][0].stages[1]).toMatchObject({ id: "consolidate", prompt: "默认完整汇总提示词" });
  await waitFor(() =>
    expect(mocks.call).toHaveBeenCalledWith(
      "ocr.extraction_save",
      expect.objectContaining({
        sourceRevision: 1,
        prompts: expect.arrayContaining([
          expect.objectContaining({ prompt: "只提取借款利率，附逐字证据" }),
        ]),
      }),
    ),
  );
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "恢复默认" })).toBeEnabled(),
  );
  fireEvent.click(screen.getByRole("button", { name: "恢复默认" }));
  expect(screen.getByLabelText("条款提取摘录要求")).toHaveValue(
    "默认完整提取提示词",
  );
});

it("旧项目隐藏汇总为空时仍使用自然语言要求直接摘录导出，不要求确认列名", async () => {
  savedProject.prompts.loan_general = [
    { id: "extract", label: "条款提取", prompt: "列出借款人、金额和利率，每份合同一行。" },
    { id: "consolidate", label: "分段汇总", prompt: "" },
  ];
  await openDocument(false);
  fireEvent.click(screen.getByRole("button", { name: "下一步：场景摘录" }));
  await waitFor(() => expect(screen.getByLabelText("摘录场景")).toBeEnabled());
  fireEvent.change(screen.getByLabelText("摘录场景"), { target: { value: "loan_general" } });
  const requirement = await screen.findByLabelText("条款提取摘录要求");
  expect(requirement).toHaveValue("列出借款人、金额和利率，每份合同一行。");
  expect(requirement).toHaveAccessibleDescription(/未指定时自动安排合适的列/);
  expect(screen.queryByLabelText("分段汇总摘录要求")).not.toBeInTheDocument();
  await waitFor(() => expect(screen.getByRole("button", { name: "开始摘录" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "开始摘录" }));
  const notice = await screen.findByRole("status", { name: "导出结果" });
  expect(notice).toHaveTextContent("导出文件成功");
  expect(mocks.extract.mock.calls[0][0].stages[0].prompt).toBe("列出借款人、金额和利率，每份合同一行。");
  expect(mocks.pick).not.toHaveBeenCalled();
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

it("开始扫描只处理未完成页，横向表格默认不拆页", async () => {
  await openDocument();
  fireEvent.click(screen.getByRole("button", { name: "开始扫描" }));
  await waitFor(() =>
    expect(mocks.job).toHaveBeenCalledWith(
      "ocr.recognize_page",
      expect.objectContaining({
        page: 2,
        layout: "full",
        expectedRevision: 0,
        imageBase64: "aW1hZ2U=",
      }),
      expect.any(Function),
      expect.any(Function),
      expect.any(Function),
    ),
  );
  expect(
    mocks.job.mock.calls.filter(([method]) => method === "ocr.recognize_page"),
  ).toHaveLength(1);
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "下一页" })).toBeEnabled(),
  );
  fireEvent.click(screen.getByRole("button", { name: "下一页" }));
  await waitFor(() =>
    expect(
      screen.getByRole("region", { name: "全篇初始原文" }),
    ).toHaveTextContent("第二页完整正文"),
  );
  expect(mocks.dispose).toHaveBeenCalled();
});

it("切换场景前保存当前提示词，并在重新选择时恢复项目版本", async () => {
  await openDocument();
  fireEvent.click(screen.getByRole("button", { name: "2 场景摘录" }));
  await screen.findByLabelText("摘录场景");
  await waitFor(() => expect(screen.getByLabelText("摘录场景")).toBeEnabled());
  fireEvent.change(screen.getByLabelText("摘录场景"), {
    target: { value: "loan_general" },
  });
  await screen.findByLabelText("条款提取摘录要求");
  await waitFor(() =>
    expect(screen.getByLabelText("条款提取摘录要求")).toBeEnabled(),
  );
  fireEvent.change(screen.getByLabelText("条款提取摘录要求"), {
    target: { value: "项目专用利率提示词" },
  });
  fireEvent.change(screen.getByLabelText("摘录场景"), {
    target: { value: "custom" },
  });
  await screen.findByLabelText("自定义摘录要求");
  expect(savedProject.prompts.loan_general[0].prompt).toBe(
    "项目专用利率提示词",
  );
  await waitFor(() => expect(screen.getByLabelText("摘录场景")).toBeEnabled());
  fireEvent.change(screen.getByLabelText("摘录场景"), {
    target: { value: "loan_general" },
  });
  await waitFor(() =>
    expect(screen.getByLabelText("条款提取摘录要求")).toHaveValue(
      "项目专用利率提示词",
    ),
  );
});

it("离开工具页时保留编辑后的提示词", async () => {
  await openDocument();
  fireEvent.click(screen.getByRole("button", { name: "2 场景摘录" }));
  await screen.findByLabelText("摘录场景");
  await waitFor(() => expect(screen.getByLabelText("摘录场景")).toBeEnabled());
  fireEvent.change(screen.getByLabelText("摘录场景"), {
    target: { value: "loan_general" },
  });
  await screen.findByLabelText("条款提取摘录要求");
  await waitFor(() =>
    expect(screen.getByLabelText("条款提取摘录要求")).toBeEnabled(),
  );
  fireEvent.change(screen.getByLabelText("条款提取摘录要求"), {
    target: { value: "离开前的提示词编辑" },
  });
  cleanup();
  await waitFor(() =>
    expect(savedProject.prompts.loan_general?.[0].prompt).toBe(
      "离开前的提示词编辑",
    ),
  );
});

it("暂停和取消传到当前页任务，取消后仍可查看已完成页", async () => {
  await openDocument();
  let rejectPage: ((reason: Error) => void) | undefined;
  mocks.job.mockImplementation(async (_method, _params, onJob) => {
    onJob?.("slow-page");
    return new Promise((_resolve, reject) => {
      rejectPage = reject;
    });
  });
  fireEvent.click(screen.getByRole("button", { name: "开始扫描" }));
  const pause = await screen.findByRole("button", { name: "暂停" });
  await waitFor(() => expect(rejectPage).toBeDefined());
  fireEvent.click(pause);
  await waitFor(() =>
    expect(mocks.pause).toHaveBeenCalledWith("slow-page", true),
  );
  fireEvent.click(screen.getByRole("button", { name: "取消任务" }));
  await waitFor(() => expect(mocks.cancel).toHaveBeenCalledWith("slow-page"));
  rejectPage?.(new Error("已取消，已完成页保留"));
  await waitFor(() =>
    expect(
      screen.getByRole("region", { name: "全篇初始原文" }),
    ).toHaveTextContent("原始正文"),
  );
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "开始扫描" })).toBeEnabled(),
  );
  expect(detail.pages).toHaveLength(1);
});

it("提示词保存失败时保留当前场景和未保存编辑", async () => {
  await openDocument();
  fireEvent.click(screen.getByRole("button", { name: "2 场景摘录" }));
  await screen.findByLabelText("摘录场景");
  await waitFor(() => expect(screen.getByLabelText("摘录场景")).toBeEnabled());
  fireEvent.change(screen.getByLabelText("摘录场景"), {
    target: { value: "loan_general" },
  });
  await screen.findByLabelText("条款提取摘录要求");
  await waitFor(() =>
    expect(screen.getByLabelText("条款提取摘录要求")).toBeEnabled(),
  );
  fireEvent.change(screen.getByLabelText("条款提取摘录要求"), {
    target: { value: "尚未保存的提示词" },
  });
  mocks.call.mockImplementationOnce(async () => {
    throw new Error("提示词写入失败");
  });
  fireEvent.change(screen.getByLabelText("摘录场景"), {
    target: { value: "custom" },
  });
  await screen.findByText("提示词写入失败");
  expect(screen.getByLabelText("摘录场景")).toHaveValue("loan_general");
  expect(screen.getByLabelText("条款提取摘录要求")).toHaveValue(
    "尚未保存的提示词",
  );
});

it.each(["application/pdf", "image/tiff"])(
  "%s 未识别文件预览时保存真实页数，支持在 OCR 前翻页",
  async (mimeType) => {
    detail.document.mimeType = mimeType;
    detail.document.totalPages = 0;
    detail.document.status = "pending";
    detail.pages = [];
    detail.extractions = [];
    render(
      <MemoryRouter>
        <OcrPage />
      </MemoryRouter>,
    );
    const entry = await screen.findByRole("button", {
      name: /^合成扫描件.pdf/,
    });
    await waitFor(() => expect(entry).toBeEnabled());
    fireEvent.click(entry);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "下一页" })).toBeEnabled(),
    );
    expect(mocks.call).toHaveBeenCalledWith("ocr.document_prepare", {
      documentId: "d",
      totalPages: 2,
    });
    expect(screen.getByRole("option", { name: "2" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "下一页" }));
    await waitFor(() =>
      expect(screen.getByLabelText("当前页")).toHaveValue("2"),
    );
    fireEvent.click(screen.getByRole("button", { name: "分页查看" }));
    await screen.findByRole("img", { name: "合成扫描件.pdf 第 2 页" });
    fireEvent.click(screen.getByRole("button", { name: "原文查看" }));
    expect(
      await screen.findByRole("article", { name: "第 2 页原文" }),
    ).toHaveTextContent("本页尚未扫描");
    expect(detail.document.totalPages).toBe(2);
    expect(mocks.job).not.toHaveBeenCalled();
    expect(mocks.extract).not.toHaveBeenCalled();
  },
);

it("原文只读显示初始识别版本，已有校对内容继续保留但不提供编辑框", async () => {
  detail.pages[0].text = "此前保存的人工校对正文";
  await openDocument();
  expect(
    screen.getByRole("region", { name: "全篇初始原文" }),
  ).toHaveTextContent("原始正文");
  expect(
    screen.queryByRole("textbox", { name: "本页完整正文" }),
  ).not.toBeInTheDocument();
  expect(screen.getByText("此前保存的人工校对正文")).toBeInTheDocument();
  expect(screen.getByText(/导出和摘录继续使用此版本/)).toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "新增表格" }),
  ).not.toBeInTheDocument();
  expect(
    mocks.call.mock.calls.some(([method]) => method === "ocr.page_save"),
  ).toBe(false);
});

it("两步导引独立切换，第二步不混入识别工作区或新增表格入口", async () => {
  await openDocument();
  expect(screen.getByRole("button", { name: "1 原文识别" })).toHaveAttribute(
    "aria-current",
    "step",
  );
  fireEvent.click(screen.getByRole("button", { name: "下一步：场景摘录" }));
  await screen.findByLabelText("摘录场景");
  expect(
    screen.queryByRole("region", { name: "全篇初始原文" }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "开始扫描" }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "导入文件" }),
  ).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "1 原文识别" }));
  await screen.findByRole("region", { name: "全篇初始原文" });
  expect(screen.queryByLabelText("摘录场景")).not.toBeInTheDocument();
});

it("取消自定义范围重扫不调用 OCR，不替换原有表格校对", async () => {
  mocks.confirm.mockResolvedValue(false);
  detail.pages[0].tables[0].rows[1][0] = "已人工校对的账号";
  await openDocument();
  fireEvent.change(screen.getByLabelText("扫描范围"), {
    target: { value: "custom" },
  });
  fireEvent.change(screen.getByLabelText("扫描页码"), {
    target: { value: "1-2" },
  });
  fireEvent.click(screen.getByRole("button", { name: "开始扫描" }));
  await waitFor(() =>
    expect(mocks.confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "重新扫描所选页面？",
        message: expect.stringContaining("已有页面的识别正文及表格校对内容"),
      }),
    ),
  );
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "开始扫描" })).toBeEnabled(),
  );
  expect(mocks.job).not.toHaveBeenCalled();
  expect(detail.pages[0].tables[0].rows[1][0]).toBe("已人工校对的账号");
});

it("确认自定义范围重扫只处理当前文件所选页面，并携带各页已存修订号", async () => {
  detail.pages[0].revision = 4;
  detail.pages.push({
    ...structuredClone(detail.pages[0]),
    page: 2,
    revision: 7,
  });
  await openDocument();
  fireEvent.change(screen.getByLabelText("扫描范围"), {
    target: { value: "custom" },
  });
  fireEvent.change(screen.getByLabelText("扫描页码"), {
    target: { value: "1-2" },
  });
  fireEvent.click(screen.getByRole("button", { name: "开始扫描" }));
  await waitFor(() =>
    expect(
      mocks.job.mock.calls.filter(
        ([method]) => method === "ocr.recognize_page",
      ),
    ).toHaveLength(2),
  );
  const requests = mocks.job.mock.calls
    .filter(([method]) => method === "ocr.recognize_page")
    .map(([, params]) => params);
  expect(requests).toEqual([
    expect.objectContaining({ documentId: "d", page: 1, expectedRevision: 4 }),
    expect.objectContaining({ documentId: "d", page: 2, expectedRevision: 7 }),
  ]);
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "开始扫描" })).toBeEnabled(),
  );
});

function prepareConcurrentPages(latePage?: number) {
  vi.mocked(openOcrSource).mockResolvedValueOnce({
    totalPages: 8,
    render: async () => "data:image/png;base64,aW1hZ2U=",
    dispose: mocks.dispose,
  });
  const pending = new Map<
    number,
    { finish: () => void; fail: () => void; attach: () => void }
  >();
  mocks.job.mockImplementation((_method, params, onJob, _onEvent, onTiming) => {
    const page = params.page as number;
    return new Promise((resolve, reject) => {
      const attach = () => onJob?.(`page-${page}`);
      pending.set(page, {
        attach,
        finish: () => {
          const saved = {
            ...structuredClone(detail.pages[0]),
            page,
            revision: 1,
            text: `正文${page}`,
          };
          detail.pages.push(saved);
          onTiming?.({ startMs: 25, totalMs: 2000 });
          resolve({
            ...saved,
            timings: {
              setupMs: 10,
              imageMs: 20,
              recognitionMs: 1230,
              structureMs: 0,
              saveMs: 15,
              workerMs: 1275,
              queueMs: 350,
            },
          });
        },
        fail: () => reject(new Error("合成服务失败")),
      });
      if (page !== latePage) attach();
    });
  });
  return pending;
}

it("扫描总进度统一暂停所有页和后续派发，恢复后继续，完成前始终只有一组控制", async () => {
  await openDocument(false, true);
  const pending = prepareConcurrentPages();
  fireEvent.click(screen.getByRole("button", { name: "开始扫描" }));
  await waitFor(() => expect(pending.size).toBe(5));
  await screen.findByRole("dialog");
  expect(screen.getAllByRole("dialog")).toHaveLength(1);
  expect(screen.getAllByRole("button", { name: /^暂停$/ })).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: /^暂停$/ }));
  await screen.findByRole("button", { name: "继续扫描" });
  expect(mocks.pause).toHaveBeenCalledTimes(5);
  await act(async () => {
    for (const number of [2, 3, 4, 5, 6]) pending.get(number)!.finish();
  });
  await waitFor(() =>
    expect(screen.getByLabelText("本文件扫描进度")).toHaveAttribute(
      "value",
      "5",
    ),
  );
  expect(pending.has(7)).toBe(false);
  expect(screen.queryByLabelText("识别进度")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "继续扫描" }));
  await waitFor(() => expect(pending.has(8)).toBe(true));
  await act(async () => {
    pending.get(7)!.finish();
    pending.get(8)!.finish();
  });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(screen.getByRole("button", { name: "开始扫描" })).toBeEnabled();
});

it("默认最多五页并发，乱序完成按完成数量推进，失败不阻塞其他页并显示分段耗时", async () => {
  await openDocument();
  const pending = prepareConcurrentPages();
  fireEvent.click(screen.getByRole("button", { name: "开始扫描" }));
  await waitFor(() => expect([...pending.keys()]).toEqual([2, 3, 4, 5, 6]));
  expect(mocks.job).toHaveBeenCalledTimes(5);
  expect(screen.getByText(/最多 5 页并发/)).toBeInTheDocument();
  await act(async () => {
    pending.get(3)!.finish();
  });
  await waitFor(() => expect(pending.has(7)).toBe(true));
  expect(screen.getByLabelText("识别进度")).toHaveAttribute("value", "1");
  await act(async () => {
    pending.get(2)!.fail();
  });
  await waitFor(() => expect(pending.has(8)).toBe(true));
  expect(screen.getByLabelText("识别进度")).toHaveAttribute("value", "2");
  await act(async () => {
    for (const page of [8, 6, 4, 5, 7]) pending.get(page)!.finish();
  });
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "开始扫描" })).toBeEnabled(),
  );
  expect(detail.pages.map((page) => page.page).sort()).toEqual([
    1, 3, 4, 5, 6, 7, 8,
  ]);
  expect(screen.getByText(/第 2 页：合成服务失败/)).toBeInTheDocument();
  expect(screen.getByText(/成功 6 页 · 失败 1 页/)).toBeInTheDocument();
  fireEvent.click(screen.getByText(/本次识别耗时/));
  const table = screen.getByRole("table", { name: "逐页识别耗时" });
  expect(screen.getByText(/最多同时处理 5/)).toBeInTheDocument();
  expect(table).toHaveTextContent("识别请求及解析");
  expect(table).toHaveTextContent("后台排队");
  expect(table).toHaveTextContent("0.35 秒");
  expect(table).toHaveTextContent("1.23 秒");
  expect(table).toHaveTextContent("0.03 秒");
  vi.mocked(openOcrSource).mockResolvedValueOnce({
    totalPages: 8,
    render: async () => "data:image/png;base64,aW1hZ2U=",
    dispose: mocks.dispose,
  });
  fireEvent.click(screen.getByRole("button", { name: "开始扫描" }));
  await waitFor(() => expect(mocks.job).toHaveBeenCalledTimes(8));
  expect(mocks.job.mock.lastCall?.[1]).toEqual(
    expect.objectContaining({ page: 2, expectedRevision: 0 }),
  );
  await act(async () => {
    pending.get(2)!.finish();
  });
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "开始扫描" })).toBeEnabled(),
  );
  expect(detail.pages.map((page) => page.page).sort()).toEqual([
    1, 2, 3, 4, 5, 6, 7, 8,
  ]);
  expect(screen.getByText(/成功 1 页 · 失败 0 页/)).toBeInTheDocument();
});

it("暂停覆盖全部在途任务，恢复时唤醒全部槽位且不会在暂停时派发新页", async () => {
  await openDocument();
  const pending = prepareConcurrentPages();
  fireEvent.click(screen.getByRole("button", { name: "开始扫描" }));
  await waitFor(() => expect(pending.size).toBe(5));
  fireEvent.click(screen.getByRole("button", { name: "暂停" }));
  await waitFor(() => expect(mocks.pause).toHaveBeenCalledTimes(5));
  for (const page of [2, 3, 4, 5, 6])
    expect(mocks.pause).toHaveBeenCalledWith(`page-${page}`, true);
  await act(async () => {
    for (const page of [2, 3, 4, 5, 6]) pending.get(page)!.finish();
  });
  expect(pending.size).toBe(5);
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "继续" })).toBeEnabled(),
  );
  fireEvent.click(screen.getByRole("button", { name: "继续" }));
  await waitFor(() => expect(pending.size).toBe(7));
  await act(async () => {
    for (const page of [7, 8]) pending.get(page)!.finish();
  });
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "开始扫描" })).toBeEnabled(),
  );
});

it("取消覆盖全部任务及迟到的任务编号，所有在途页退出前不释放文件或开始下一批", async () => {
  await openDocument();
  const pending = prepareConcurrentPages(6);
  fireEvent.click(screen.getByRole("button", { name: "开始扫描" }));
  await waitFor(() => expect(pending.size).toBe(5));
  mocks.dispose.mockClear();
  fireEvent.click(screen.getByRole("button", { name: "暂停" }));
  await waitFor(() => expect(mocks.pause).toHaveBeenCalledTimes(4));
  fireEvent.click(screen.getByRole("button", { name: "取消任务" }));
  await waitFor(() => expect(mocks.cancel).toHaveBeenCalledTimes(4));
  for (const page of [2, 3, 4, 5])
    expect(mocks.cancel).toHaveBeenCalledWith(`page-${page}`);
  await act(async () => {
    pending.get(6)!.attach();
    pending.get(2)!.fail();
  });
  expect(mocks.cancel).toHaveBeenCalledTimes(5);
  expect(mocks.cancel).toHaveBeenCalledWith("page-6");
  expect(mocks.dispose).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "开始扫描" })).toBeDisabled();
  await act(async () => {
    for (const page of [3, 4, 5, 6]) pending.get(page)!.fail();
  });
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "开始扫描" })).toBeEnabled(),
  );
  expect(pending.size).toBe(5);
  expect(detail.pages).toHaveLength(1);
  expect(mocks.dispose).toHaveBeenCalled();
});

it("自定义扫描 2-5 页仅识别范围内页面，不提交首页或末页", async () => {
  detail.document.totalPages = 6;
  await openDocument();
  vi.mocked(openOcrSource).mockResolvedValueOnce({
    totalPages: 6,
    render: mocks.renderSource,
    dispose: mocks.dispose,
  });
  fireEvent.change(screen.getByLabelText("扫描范围"), {
    target: { value: "custom" },
  });
  fireEvent.change(screen.getByLabelText("扫描页码"), {
    target: { value: "2-5页" },
  });
  fireEvent.click(screen.getByRole("button", { name: "开始扫描" }));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "开始扫描" })).toBeEnabled(),
  );
  const requests = mocks.job.mock.calls.filter(
    ([method]) => method === "ocr.recognize_page",
  );
  expect(requests.map(([, params]) => params.page).sort()).toEqual([
    2, 3, 4, 5,
  ]);
  expect(requests.every(([, params]) => params.documentId === "d")).toBe(true);
  expect(detail.pages.map((page) => page.page).sort()).toEqual([1, 2, 3, 4, 5]);
});

it.each(["2-five", "0-2", "2-3", "2-1"])(
  "扫描范围 %s 非法或越界时保留原文且不提交任何识别任务",
  async (range) => {
    await openDocument();
    fireEvent.change(screen.getByLabelText("扫描范围"), {
      target: { value: "custom" },
    });
    fireEvent.change(screen.getByLabelText("扫描页码"), {
      target: { value: range },
    });
    fireEvent.click(screen.getByRole("button", { name: "开始扫描" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/页码/);
    expect(mocks.job).not.toHaveBeenCalled();
    expect(detail.pages).toHaveLength(1);
    expect(
      screen.getByRole("region", { name: "全篇初始原文" }),
    ).toHaveTextContent("原始正文");
  },
);

it("默认分页查看，可切换全篇模式并复制全部已扫描页的初始版本", async () => {
  detail.document.totalPages = 4;
  vi.mocked(openOcrSource).mockResolvedValueOnce({
    totalPages: 4,
    render: mocks.renderSource,
    dispose: mocks.dispose,
  });
  detail.pages[0].text = "人工修改不应进入初始原文复制";
  detail.pages.push({
    ...structuredClone(detail.pages[0]),
    page: 4,
    originalText: "第四页扫描原文",
  });
  const writeText = vi.fn().mockResolvedValue(undefined);
  const previous = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
  try {
    await openDocument(false);
    expect(
      screen.queryByRole("region", { name: "全篇初始原文" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "原文查看" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    fireEvent.click(screen.getByRole("button", { name: "原文查看" }));
    await screen.findByRole("region", { name: "全篇初始原文" });
    fireEvent.click(screen.getByRole("button", { name: "复制全部原文" }));
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(
        "合成扫描件.pdf\n第 1 页\n原始正文\n\n第 4 页\n第四页扫描原文",
      ),
    );
    expect(
      await screen.findByText("已复制所选文件已扫描页的全部原文。"),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "分页查看" }));
    expect(
      screen.queryByRole("region", { name: "全篇初始原文" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "导出文件" })).toBeEnabled();
  } finally {
    if (previous) Object.defineProperty(navigator, "clipboard", previous);
    else Reflect.deleteProperty(navigator, "clipboard");
  }
});

it("文件区默认显示九份文件，支持展开收起，步骤导引在项目信息之前且不显示服务状态栏", async () => {
  const baseCall = mocks.call.getMockImplementation()!;
  mocks.call.mockImplementation((method, params) => {
    if (method === "ocr.documents")
      return {
        documents: Array.from({ length: 11 }, (_, index) => ({
          ...structuredClone(detail.document),
          id: `document-${index + 1}`,
          name: `扫描件-${index + 1}.pdf`,
        })),
      };
    return baseCall(method, params);
  });
  render(
    <MemoryRouter>
      <OcrPage />
    </MemoryRouter>,
  );
  const files = await screen.findByRole("complementary", { name: "项目文件" });
  await waitFor(() =>
    expect(
      within(files).getAllByRole("button", { name: /^扫描件-\d+\.pdf/ }),
    ).toHaveLength(9),
  );
  expect(
    within(files).queryByRole("button", { name: /^扫描件-10\.pdf/ }),
  ).not.toBeInTheDocument();
  const expand = within(files).getByRole("button", {
    name: "展开全部 11 份文件",
  });
  expect(expand).toHaveAttribute("aria-expanded", "false");
  fireEvent.click(expand);
  expect(
    within(files).getAllByRole("button", { name: /^扫描件-\d+\.pdf/ }),
  ).toHaveLength(11);
  const collapse = within(files).getByRole("button", { name: "收起文件" });
  expect(collapse).toHaveAttribute("aria-expanded", "true");
  fireEvent.click(collapse);
  expect(
    within(files).getAllByRole("button", { name: /^扫描件-\d+\.pdf/ }),
  ).toHaveLength(9);
  const steps = screen.getByRole("navigation", { name: "OCR 处理步骤" });
  const project = screen.getByLabelText("选择 OCR 项目");
  expect(
    steps.compareDocumentPosition(project) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  expect(
    screen.queryByText(/全局 AI|全局设置|OCR：已配置|结构恢复可能使用/),
  ).not.toBeInTheDocument();
});

it("自动方向只校正预览，重新扫描提交源图防止二次旋转", async () => {
  detail.pages[0].metadata = {
    autoRotation: 90,
    autoOrientationStatus: "detected",
  };
  mocks.renderSource.mockImplementation(
    async (page: number, rotation = 0) =>
      `data:image/png;base64,${btoa(`page-${page}-rotation-${rotation}`)}`,
  );
  await openDocument();
  expect(screen.queryByText("扫描设置与页面方向")).not.toBeInTheDocument();
  expect(screen.queryByLabelText("当前页方向校正")).not.toBeInTheDocument();
  expect(screen.queryByLabelText("扫描布局")).not.toBeInTheDocument();
  expect(
    screen.queryByRole("checkbox", { name: "重新扫描所选范围内已完成页" }),
  ).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "分页查看" }));
  const preview = await screen.findByRole("img", {
    name: "合成扫描件.pdf 第 1 页",
  });
  await waitFor(() =>
    expect(preview).toHaveAttribute(
      "src",
      `data:image/png;base64,${btoa("page-1-rotation-90")}`,
    ),
  );
  expect(mocks.renderSource).toHaveBeenCalledWith(1, 90);
  fireEvent.change(screen.getByLabelText("扫描范围"), {
    target: { value: "custom" },
  });
  fireEvent.change(screen.getByLabelText("扫描页码"), {
    target: { value: "1" },
  });
  fireEvent.click(screen.getByRole("button", { name: "开始扫描" }));
  await waitFor(() => expect(mocks.job).toHaveBeenCalledTimes(1));
  expect(mocks.job).toHaveBeenCalledWith(
    "ocr.recognize_page",
    expect.objectContaining({
      page: 1,
      imageBase64: btoa("page-1-rotation-0"),
      layout: "full",
    }),
    expect.any(Function),
    expect.any(Function),
    expect.any(Function),
  );
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "开始扫描" })).toBeEnabled(),
  );
});

it("查看原文按页序展示全篇、保留未扫描页，图片翻页不改变全文", async () => {
  detail.document.totalPages = 4;
  vi.mocked(openOcrSource).mockResolvedValueOnce({
    totalPages: 4,
    render: mocks.renderSource,
    dispose: mocks.dispose,
  });
  detail.pages.push({
    ...structuredClone(detail.pages[0]),
    page: 4,
    originalText: "第四页全文内容",
    text: "第四页全文内容",
  });
  detail.pages.reverse();
  await openDocument();
  const fullText = screen.getByRole("region", { name: "全篇初始原文" });
  const headings = within(fullText).getAllByRole("heading", {
    name: /^第 [1-4] 页$/,
  });
  expect(headings.map((heading) => heading.textContent)).toEqual([
    "第 1 页",
    "第 2 页",
    "第 3 页",
    "第 4 页",
  ]);
  expect(fullText).toHaveTextContent("原始正文");
  expect(fullText).toHaveTextContent("第四页全文内容");
  expect(within(fullText).getAllByText(/尚未扫描|尚未识别/)).toHaveLength(2);
  fireEvent.click(screen.getByRole("button", { name: "下一页" }));
  await waitFor(() => expect(screen.getByLabelText("当前页")).toHaveValue("2"));
  expect(
    screen.getByRole("region", { name: "全篇初始原文" }),
  ).toHaveTextContent("原始正文");
  expect(
    screen.getByRole("region", { name: "全篇初始原文" }),
  ).toHaveTextContent("第四页全文内容");
  expect(
    within(fullText).getAllByRole("heading", { name: /^第 [1-4] 页$/ }),
  ).toHaveLength(4);
});

it.each(["single_sheet", "per_document", "individual"])(
  "文件区全选包含收起文件，按勾选范围以 %s 导出且不改变查看文件",
  async (mode) => {
    const baseCall = mocks.call.getMockImplementation()!;
    const docs = Array.from({ length: 12 }, (_, index) => ({
      ...structuredClone(detail.document),
      id: index ? `d-${index + 1}` : "d",
      name: index ? `批次-${index + 1}.pdf` : detail.document.name,
    }));
    mocks.call.mockImplementation((method, params) => {
      if (method === "ocr.documents") return { documents: docs };
      if (method === "ocr.document")
        return {
          ...structuredClone(detail),
          document: docs.find((doc) => doc.id === params.documentId),
        };
      return baseCall(method, params);
    });
    await openDocument();
    const all = screen.getByRole("checkbox", { name: "全选项目文件" });
    fireEvent.click(all);
    expect(all).toBeChecked();
    expect(screen.getByText("已选 12 / 12 份")).toBeInTheDocument();
    // The twelfth file is selected even while its card is collapsed.
    expect(
      screen.queryByRole("checkbox", { name: "选择文件：批次-12.pdf" }),
    ).not.toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("checkbox", { name: "选择文件：批次-2.pdf" }),
    );
    expect(all).toBePartiallyChecked();
    expect(
      screen.getByRole("heading", { name: "已选 11 份文件" }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "导出文件" }));
    const dialog = await screen.findByRole("dialog", { name: "导出文件" });
    expect(
      within(dialog).getByText("本次导出：已选 11 份文件"),
    ).toBeInTheDocument();
    expect(within(dialog).queryByLabelText("导出范围")).not.toBeInTheDocument();
    const radios = within(dialog).getAllByRole("radio");
    fireEvent.click(
      radios.find((radio) => (radio as HTMLInputElement).value === mode)!,
    );
    fireEvent.click(
      within(dialog).getByRole("button", { name: "导出到目标目录" }),
    );
    await waitFor(() =>
      expect(mocks.job).toHaveBeenCalledWith(
        "ocr.export",
        expect.objectContaining({
          mode,
          documentIds: docs
            .filter((doc) => doc.id !== "d-2")
            .map((doc) => doc.id),
        }),
        expect.any(Function),
        expect.any(Function),
      ),
    );
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    fireEvent.click(all);
    fireEvent.click(all);
    expect(all).not.toBeChecked();
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "导出文件" }),
      ).not.toBeInTheDocument(),
    );
  },
);

it("导出对话框取消不选择目录也不派发任务", async () => {
  await openDocument();
  fireEvent.click(screen.getByRole("button", { name: "导出文件" }));
  fireEvent.click(
    within(await screen.findByRole("dialog")).getByRole("button", {
      name: "取消",
    }),
  );
  expect(mocks.pick).not.toHaveBeenCalled();
  expect(mocks.job).not.toHaveBeenCalled();
});

/** 多文件必须使用独立、可变的存储夹具，避免把同一份文档伪装成批量。 */
function batchFixture() {
  const template = structuredClone(detail.pages[0]);
  const records = new Map<string, OcrDocumentDetail>([
    ["d", detail],
    [
      "d2",
      {
        ...structuredClone(detail),
        document: { ...detail.document, id: "d2", name: "第二合同.pdf" },
        pages: [],
        extractions: [],
      },
    ],
    [
      "d3",
      {
        ...structuredClone(detail),
        document: { ...detail.document, id: "d3", name: "未勾选合同.pdf" },
        pages: [],
        extractions: [],
      },
    ],
  ]);
  const baseCall = mocks.call.getMockImplementation()!;
  mocks.call.mockImplementation(async (method, params) => {
    if (method === "ocr.documents")
      return {
        documents: [...records.values()].map((value) =>
          structuredClone(value.document),
        ),
      };
    const record = records.get(params?.documentId);
    if (method === "ocr.document") return structuredClone(record);
    if (method === "ocr.document_prepare") {
      record!.document.totalPages = params.totalPages;
      return structuredClone(record!.document);
    }
    if (method === "ocr.document_delete") {
      records.delete(params.documentId);
      return {};
    }
    if (method === "ocr.extraction_save") {
      const item = {
        ...params,
        id: `extraction-${params.documentId}`,
        createdAt: "2026-10-27",
      };
      record!.extractions.push(item);
      return item;
    }
    if (method === "ocr.page_save") {
      const page = {
        ...structuredClone(params.page),
        revision: params.expectedRevision + 1,
      };
      record!.pages = record!.pages.map((item) =>
        item.page === page.page ? page : item,
      );
      record!.document.revision++;
      return page;
    }
    return baseCall(method, params);
  });
  vi.mocked(openOcrSource).mockImplementation(async (doc) => ({
    totalPages: doc.totalPages,
    render: mocks.renderSource,
    dispose: mocks.dispose,
  }));
  const baseJob = mocks.job.getMockImplementation()!;
  const scanJob = async (
    method: string,
    params: any,
    onJob?: (id: string) => void,
  ) => {
    if (method !== "ocr.recognize_page") return baseJob(method, params, onJob);
    onJob?.(`scan-${params.documentId}-${params.page}`);
    const record = records.get(params.documentId)!;
    const page = {
      ...structuredClone(template),
      page: params.page,
      originalText: `${record.document.name}第${params.page}页原文`,
      text: `${record.document.name}第${params.page}页原文`,
    };
    record.pages = [
      ...record.pages.filter((item) => item.page !== page.page),
      page,
    ];
    return page;
  };
  mocks.job.mockImplementation(scanJob);
  return { records, scanJob };
}
async function selectSecond() {
  fireEvent.click(
    screen.getByRole("checkbox", { name: "选择文件：第二合同.pdf" }),
  );
  await screen.findByRole("heading", { name: "已选 2 份文件" });
  await waitFor(() =>
    expect(screen.getByLabelText("当前查看文件")).toHaveValue("d"),
  );
}

it("多选开始扫描覆盖全部勾选文件，未选文件不派发，已有完成页跳过", async () => {
  const { records } = batchFixture();
  await openDocument(false);
  await selectSecond();
  fireEvent.click(screen.getByRole("button", { name: "开始扫描" }));
  await waitFor(() =>
    expect(
      mocks.job.mock.calls.filter(
        ([method]) => method === "ocr.recognize_page",
      ),
    ).toHaveLength(3),
  );
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "开始扫描" })).toBeEnabled(),
  );
  expect(
    mocks.job.mock.calls.map(([, params]) => [params.documentId, params.page]),
  ).toEqual([
    ["d", 2],
    ["d2", 1],
    ["d2", 2],
  ]);
  expect(records.get("d2")!.pages).toHaveLength(2);
  expect(records.get("d3")!.pages).toHaveLength(0);
  expect(
    screen.getByRole("heading", { name: "已选 2 份文件" }),
  ).toBeInTheDocument();
});

it("一个文件扫描失败仍继续其他所选文件，再扫描只补未完成页", async () => {
  const { scanJob, records } = batchFixture();
  let fail = true;
  mocks.job.mockImplementation(async (method, params, onJob) => {
    if (fail && params.documentId === "d") {
      fail = false;
      throw new Error("合成服务失败");
    }
    return scanJob(method, params, onJob);
  });
  await openDocument(false);
  await selectSecond();
  fireEvent.click(screen.getByRole("button", { name: "开始扫描" }));
  await screen.findByText(/合成服务失败/);
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "开始扫描" })).toBeEnabled(),
  );
  expect(records.get("d2")!.pages).toHaveLength(2);
  const calls = mocks.job.mock.calls.length;
  fireEvent.click(screen.getByRole("button", { name: "开始扫描" }));
  await waitFor(() => expect(mocks.job).toHaveBeenCalledTimes(calls + 1));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "开始扫描" })).toBeEnabled(),
  );
  expect(mocks.job.mock.calls.at(-1)![1]).toMatchObject({
    documentId: "d",
    page: 2,
  });
});

it("批量自定义范围逐份裁剪越界页，仅确认一次覆盖并报告短文件", async () => {
  const { records } = batchFixture();
  records.get("d2")!.document.totalPages = 1;
  await openDocument(false);
  await selectSecond();
  fireEvent.change(screen.getByLabelText("扫描范围"), {
    target: { value: "custom" },
  });
  fireEvent.change(screen.getByLabelText("扫描页码"), {
    target: { value: "1-5" },
  });
  fireEvent.click(screen.getByRole("button", { name: "开始扫描" }));
  await waitFor(() => expect(mocks.job).toHaveBeenCalledTimes(3));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "开始扫描" })).toBeEnabled(),
  );
  expect(mocks.confirm).toHaveBeenCalledTimes(1);
  expect(
    mocks.job.mock.calls.map(([, params]) => [params.documentId, params.page]),
  ).toEqual([
    ["d", 1],
    ["d", 2],
    ["d2", 1],
  ]);
  expect(screen.getAllByRole("status").some(element =>
    element.textContent?.includes("仅扫描本文件存在的页码"),
  )).toBe(true);
});

it("失败页可继续摘录导出，重试只扫实际失败页，不扫成功页或尚未扫描页", async () => {
  const { records, scanJob } = batchFixture();
  let fail = true;
  mocks.job.mockImplementation(async (method, params, onJob) => {
    if (method === "ocr.recognize_page" && params.documentId === "d2" && params.page === 2 && fail) {
      fail = false;
      throw new Error("第二合同页2暂时失败");
    }
    return scanJob(method, params, onJob);
  });
  await openDocument(false);
  await selectSecond();
  fireEvent.change(screen.getByLabelText("扫描范围"), { target: { value: "custom" } });
  fireEvent.change(screen.getByLabelText("扫描页码"), { target: { value: "2" } });
  fireEvent.click(screen.getByRole("button", { name: "开始扫描" }));
  await screen.findByText(/第二合同页2暂时失败/);
  await waitFor(() => expect(screen.getByRole("button", { name: "开始扫描" })).toBeEnabled());
  expect(screen.getByRole("button", { name: "导出文件" })).toBeEnabled();
  fireEvent.click(screen.getByRole("button", { name: "下一步：场景摘录" }));
  await waitFor(() => expect(screen.getByLabelText("摘录场景")).toBeEnabled());
  expect(screen.queryByText(/识别完成，部分页面失败/)).not.toBeInTheDocument();
  expect(screen.getByRole("note", { name: "摘录来源范围" })).toHaveTextContent("已扫描 2 / 4 页");
  fireEvent.change(screen.getByLabelText("摘录场景"), { target: { value: "custom" } });
  await waitFor(() => expect(screen.getByRole("button", { name: "开始摘录" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "1 原文识别" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "开始扫描" })).toBeEnabled());
  fireEvent.change(screen.getByLabelText("扫描页码"), { target: { value: "无效范围" } });
  const calls = mocks.job.mock.calls.length;
  fireEvent.click(screen.getByRole("button", { name: "重试失败页（1）" }));
  await waitFor(() => expect(mocks.job).toHaveBeenCalledTimes(calls + 1));
  await waitFor(() => expect(screen.getByRole("button", { name: "开始扫描" })).toBeEnabled());
  expect(mocks.job.mock.calls.at(-1)![1]).toMatchObject({ documentId: "d2", page: 2 });
  expect(records.get("d2")!.pages.map(page => page.page)).toEqual([2]);
  expect(screen.queryByRole("button", { name: /重试失败页/ })).not.toBeInTheDocument();
});

it("切换到其他单文件不残留扫描错误与计时，切回失败文件仍可单独重试", async () => {
  const { scanJob } = batchFixture();
  mocks.job.mockImplementation(async (method, params, onJob) => {
    if (method === "ocr.recognize_page" && params.documentId === "d") throw new Error("第一合同第2页失败");
    return scanJob(method, params, onJob);
  });
  await openDocument(false);
  fireEvent.click(screen.getByRole("button", { name: "开始扫描" }));
  await screen.findByText(/第一合同第2页失败/);
  await waitFor(() => expect(screen.getByRole("button", { name: "开始扫描" })).toBeEnabled());
  const files = () => within(screen.getByRole("complementary", { name: "项目文件" }));
  fireEvent.click(files().getByRole("button", { name: /^第二合同.pdf/ }));
  await screen.findByRole("heading", { name: "第二合同.pdf" });
  expect(screen.queryByText(/第一合同第2页失败/)).not.toBeInTheDocument();
  expect(screen.queryByText(/识别完成，部分页面失败/)).not.toBeInTheDocument();
  expect(screen.queryByText(/本次识别耗时/)).not.toBeInTheDocument();
  fireEvent.click(files().getByRole("button", { name: /^合成扫描件.pdf/ }));
  await screen.findByRole("heading", { name: "合成扫描件.pdf" });
  expect(screen.getByText(/成功 0 页 · 失败 1 页/)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "重试失败页（1）" })).toBeEnabled();
});

it("预览切换不改变批量范围，全篇模式包含所选文件，卡片点击恢复单文件操作", async () => {
  const { records } = batchFixture();
  records.get("d2")!.pages = [
    { ...structuredClone(detail.pages[0]), originalText: "第二合同独立正文" },
  ];
  await openDocument(false);
  await selectSecond();
  fireEvent.change(screen.getByLabelText("当前查看文件"), {
    target: { value: "d2" },
  });
  await screen.findByRole("img", { name: "第二合同.pdf 第 1 页" });
  expect(screen.getByText("已选 2 / 3 份")).toBeInTheDocument();
  expect(screen.getAllByRole("button", { name: "导出文件" })).toHaveLength(1);
  expect(
    within(screen.getByRole("complementary", { name: "项目文件" })).queryByRole(
      "button",
      { name: "导出文件" },
    ),
  ).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "原文查看" }));
  const text = await screen.findByRole("region", { name: "全篇初始原文" });
  expect(text).toHaveTextContent("原始正文");
  expect(text).toHaveTextContent("第二合同独立正文");
  expect(text).not.toHaveTextContent("未勾选合同");
  fireEvent.click(screen.getByRole("button", { name: "分页查看" }));
  expect(
    screen.getByRole("region", { name: "本页初始原文" }),
  ).toHaveTextContent("第二合同独立正文");
  fireEvent.click(
    within(screen.getByRole("complementary", { name: "项目文件" })).getByRole(
      "button",
      { name: /^第二合同.pdf/ },
    ),
  );
  await waitFor(() =>
    expect(screen.queryByLabelText("当前查看文件")).not.toBeInTheDocument(),
  );
  expect(screen.getByText("已选 1 / 3 份")).toBeInTheDocument();
});

it("卡片删除独立于选择，删除后移除范围并切换到剩余文件", async () => {
  const { records } = batchFixture();
  await openDocument(false);
  await selectSecond();
  fireEvent.click(
    screen.getByRole("button", { name: "删除文件：合成扫描件.pdf" }),
  );
  await waitFor(() => expect(records.has("d")).toBe(false));
  await screen.findByRole("heading", { name: "第二合同.pdf" });
  expect(screen.getByText("已选 1 / 2 份")).toBeInTheDocument();
  expect(screen.queryByLabelText("当前查看文件")).not.toBeInTheDocument();
  expect(mocks.confirm).toHaveBeenCalledTimes(1);
});

it("统一上传区内选择文件夹与文件共用原生拖放区域", async () => {
  await openDocument(false);
  const upload = screen
    .getByRole("button", { name: "导入文件" })
    .closest(".file-drop-input")!;
  const folder = within(upload as HTMLElement).getByRole("button", {
    name: "选择文件夹",
  });
  mocks.pick.mockResolvedValueOnce("C:/合成扫描目录");
  fireEvent.click(folder);
  await waitFor(() =>
    expect(mocks.call).toHaveBeenCalledWith("ocr.document_import", {
      projectId: "p",
      paths: [],
      folder: "C:/合成扫描目录",
    }),
  );
});

it("批量场景摘录逐文件使用同一提示词快照并分开保存结果，跳过未扫描文件", async () => {
  const { records } = batchFixture();
  records.get("d2")!.pages = [
    {
      ...structuredClone(detail.pages[0]),
      originalText: "第二合同证据",
      text: "第二合同证据",
    },
  ];
  await openDocument(false);
  await selectSecond();
  fireEvent.click(
    screen.getByRole("checkbox", { name: "选择文件：未勾选合同.pdf" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "下一步：场景摘录" }));
  const scene = await screen.findByLabelText("摘录场景");
  await waitFor(() => expect(scene).toBeEnabled());
  fireEvent.change(scene, { target: { value: "loan_general" } });
  const prompt = await screen.findByLabelText("条款提取摘录要求");
  await waitFor(() => expect(prompt).toBeEnabled());
  fireEvent.change(prompt, { target: { value: "逐文件摘录并保留来源页码" } });
  fireEvent.click(screen.getByRole("button", { name: "开始摘录" }));
  await waitFor(() => expect(mocks.extract).toHaveBeenCalledTimes(2));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "开始摘录" })).toBeEnabled(),
  );
  expect(
    mocks.extract.mock.calls.map(([params]) => params.document.id),
  ).toEqual(["d", "d2"]);
  expect(
    mocks.extract.mock.calls.every(
      ([params]) => params.stages[0].prompt === "逐文件摘录并保留来源页码",
    ),
  ).toBe(true);
  expect(records.get("d2")!.extractions).toHaveLength(1);
  expect(records.get("d3")!.extractions).toHaveLength(0);
  expect(screen.getByRole("alert")).toHaveTextContent("尚未扫描，已跳过");
  expect(mocks.job).toHaveBeenCalledWith(
    "ocr.export",
    expect.objectContaining({
      extractionsOnly: true,
      extractionIds: ["extraction-d", "extraction-d2"],
      documentIds: ["d", "d2"],
    }),
    expect.any(Function),
    expect.any(Function),
  );
  expect(screen.getByRole("status", { name: "导出结果" })).toHaveTextContent(
    "C:/输出",
  );
});

it("摘录全部失败就近列出逐文件原因和超时建议，保留原文且重试成功后清除旧错误", async () => {
  const { records } = batchFixture();
  records.get("d2")!.pages = [structuredClone(detail.pages[0])];
  mocks.extract.mockRejectedValueOnce(
    new Error("网络请求失败，请检查地址、代理和网络连接。"),
  );
  mocks.extract.mockRejectedValueOnce(
    new Error("网络请求失败，请检查地址、代理和网络连接。"),
  );
  await openDocument(false);
  await selectSecond();
  fireEvent.click(screen.getByRole("button", { name: "下一步：场景摘录" }));
  const scene = await screen.findByLabelText("摘录场景");
  await waitFor(() => expect(scene).toBeEnabled());
  fireEvent.change(scene, { target: { value: "loan_general" } });
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "开始摘录" })).toBeEnabled(),
  );
  fireEvent.click(screen.getByRole("button", { name: "开始摘录" }));
  const failure = await screen.findByRole("alert", {
    name: "场景摘录失败详情",
  });
  expect(failure).toHaveTextContent("合成扫描件.pdf：网络请求失败");
  expect(failure).toHaveTextContent("第二合同.pdf：网络请求失败");
  expect(failure).toHaveTextContent("已扫描的原文仍然保留，无需重新扫描");
  expect(failure).toHaveTextContent("统一 LLM 的连接及请求超时设置");
  expect(
    screen.queryByText("没有生成新的摘录结果，请检查文件扫描状态和错误提示。"),
  ).not.toBeInTheDocument();
  expect(mocks.job).not.toHaveBeenCalled();
  expect(records.get("d")!.pages.length).toBeGreaterThan(0);
  expect(records.get("d2")!.pages.length).toBeGreaterThan(0);
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "开始摘录" })).toBeEnabled(),
  );
  fireEvent.click(screen.getByRole("button", { name: "开始摘录" }));
  await screen.findByRole("status", { name: "导出结果" });
  expect(
    screen.queryByRole("alert", { name: "场景摘录失败详情" }),
  ).not.toBeInTheDocument();
});

it("批量扫描取消不会再派发下一份文件，当前已保存页保留", async () => {
  batchFixture();
  let rejectJob: ((reason: unknown) => void) | undefined;
  mocks.job.mockImplementation(async (_method, _params, onJob) => {
    onJob?.("batch-active");
    await new Promise((_resolve, reject) => {
      rejectJob = reject;
    });
  });
  await openDocument(false);
  await selectSecond();
  fireEvent.click(screen.getByRole("button", { name: "开始扫描" }));
  await screen.findByRole("button", { name: "取消任务" });
  fireEvent.click(screen.getByRole("button", { name: "取消任务" }));
  await waitFor(() =>
    expect(mocks.cancel).toHaveBeenCalledWith("batch-active"),
  );
  await act(async () => rejectJob!(new Error("任务已取消")));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "开始扫描" })).toBeEnabled(),
  );
  expect(mocks.job).toHaveBeenCalledTimes(1);
  expect(detail.pages).toHaveLength(1);
});

it("移除尾部表格目录与编辑器，但保留历史识别表格并继续支持导出", async () => {
  const storedTables = structuredClone(detail.pages[0].tables);
  await openDocument(false);
  expect(
    screen.queryByRole("region", { name: "表格目录" }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("region", { name: "表格编辑器" }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("region", { name: "已识别表格校对" }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("textbox", { name: /表格.*名称/ }),
  ).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "下一页" }));
  await waitFor(() => expect(screen.getByLabelText("当前页")).toHaveValue("2"));
  fireEvent.click(screen.getByRole("button", { name: "导出文件" }));
  fireEvent.click(
    await screen.findByRole("button", { name: "导出到目标目录" }),
  );
  await waitFor(() =>
    expect(mocks.job).toHaveBeenCalledWith(
      "ocr.export",
      expect.objectContaining({ documentIds: ["d"] }),
      expect.any(Function),
      expect.any(Function),
    ),
  );
  expect(detail.pages[0].tables).toEqual(storedTables);
  expect(
    mocks.call.mock.calls.some(([method]) => method === "ocr.page_save"),
  ).toBe(false);
});

it("清空文件一次确认删除项目全部文件，包括未勾选项，保留项目和提示词", async () => {
  const { records } = batchFixture();
  await openDocument(false);
  fireEvent.click(screen.getByRole("button", { name: "清空文件" }));
  await waitFor(() => expect(records.size).toBe(0));
  await waitFor(() =>
    expect(
      screen.queryByRole("complementary", { name: "项目文件" }),
    ).not.toBeInTheDocument(),
  );
  expect(mocks.confirm).toHaveBeenCalledWith(
    expect.objectContaining({
      title: "清空项目内全部 3 份文件？",
      message: expect.stringContaining("包括未勾选文件"),
    }),
  );
  expect(mocks.confirm).toHaveBeenCalledTimes(1);
  expect(
    mocks.call.mock.calls
      .filter(([method]) => method === "ocr.document_delete")
      .map(([, params]) => params.documentId),
  ).toEqual(["d", "d2", "d3"]);
  expect(
    mocks.call.mock.calls.some(([method]) => method === "ocr.project_delete"),
  ).toBe(false);
  expect(screen.getByLabelText("选择 OCR 项目")).toHaveValue("p");
  expect(screen.queryByLabelText("当前查看文件")).not.toBeInTheDocument();
});

it("取消清空文件保留所有文件与勾选状态", async () => {
  const { records } = batchFixture();
  mocks.confirm.mockResolvedValue(false);
  await openDocument(false);
  fireEvent.click(screen.getByRole("button", { name: "清空文件" }));
  await waitFor(() => expect(mocks.confirm).toHaveBeenCalled());
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "清空文件" })).toBeEnabled(),
  );
  expect(records.size).toBe(3);
  expect(
    screen.getByRole("checkbox", { name: "选择文件：合成扫描件.pdf" }),
  ).toBeChecked();
  expect(
    mocks.call.mock.calls.some(([method]) => method === "ocr.document_delete"),
  ).toBe(false);
});

it("清空文件部分失败保留失败文件并继续清理其余文件", async () => {
  const { records } = batchFixture();
  const baseCall = mocks.call.getMockImplementation()!;
  mocks.call.mockImplementation(async (method, params) => {
    if (method === "ocr.document_delete" && params.documentId === "d2")
      throw new Error("文件占用");
    return baseCall(method, params);
  });
  await openDocument(false);
  await selectSecond();
  fireEvent.click(screen.getByRole("button", { name: "清空文件" }));
  await screen.findByText(/第二合同.pdf：文件占用/);
  await waitFor(() => expect([...records.keys()]).toEqual(["d2"]));
  await screen.findByRole("heading", { name: "第二合同.pdf" });
  expect(
    screen.getByRole("checkbox", { name: "选择文件：第二合同.pdf" }),
  ).toBeChecked();
  expect(screen.getByText("已选 1 / 1 份")).toBeInTheDocument();
});

it("翻页按钮相邻，工作区不再显示操作范围卡片", async () => {
  batchFixture();
  await openDocument(false);
  await selectSecond();
  const navigation = screen.getByRole("group", { name: "分页导航" });
  const previous = within(navigation).getByRole("button", { name: "上一页" });
  expect(previous.nextElementSibling).toBe(
    within(navigation).getByRole("button", { name: "下一页" }),
  );
  expect(screen.queryByText(/^操作范围：/)).not.toBeInTheDocument();
  const files = screen.getByRole("complementary", { name: "项目文件" });
  expect(
    within(files).getByText(/扫描、导出和场景摘录均针对勾选文件/),
  ).toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "清空选择" }),
  ).not.toBeInTheDocument();
});

it("未上传时只显示完整拖入区，导入后才显示文件列表和预览工作区", async () => {
  let imported = false;
  const baseCall = mocks.call.getMockImplementation()!;
  mocks.call.mockImplementation(async (method, params) => {
    if (method === "ocr.documents")
      return { documents: imported ? [structuredClone(detail.document)] : [] };
    if (method === "ocr.document_import") imported = true;
    return baseCall(method, params);
  });
  render(
    <MemoryRouter>
      <OcrPage />
    </MemoryRouter>,
  );
  const upload = await screen.findByRole("button", { name: "导入文件" });
  expect(screen.getByText("拖入扫描件或文件夹")).toBeInTheDocument();
  expect(screen.getByText("或点击选择文件，支持多选")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "选择文件夹" })).toBeEnabled();
  expect(
    screen.queryByRole("complementary", { name: "项目文件" }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("heading", { name: "选择需要处理的文件" }),
  ).not.toBeInTheDocument();
  mocks.pick.mockResolvedValueOnce(["C:/扫描件/新文件.pdf"]);
  fireEvent.click(upload);
  await screen.findByRole("complementary", { name: "项目文件" });
  await screen.findByRole("button", { name: "开始扫描" });
  expect(screen.queryByText("拖入扫描件或文件夹")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "导入文件" })).toHaveTextContent(
    "已导入 1 份文件",
  );
});

it("在摘录步骤删除最后一份文件后，回到完整上传区且不显示空列表和空预览", async () => {
  const { records } = batchFixture();
  records.delete("d2");
  records.delete("d3");
  await openDocument(false);
  fireEvent.click(screen.getByRole("button", { name: "下一步：场景摘录" }));
  const scene = await screen.findByLabelText("摘录场景");
  await waitFor(() => expect(scene).toBeEnabled());
  fireEvent.click(
    screen.getByRole("button", { name: "删除文件：合成扫描件.pdf" }),
  );
  await screen.findByText("拖入扫描件或文件夹");
  expect(
    screen.queryByRole("complementary", { name: "项目文件" }),
  ).not.toBeInTheDocument();
  expect(screen.queryByLabelText("摘录场景")).not.toBeInTheDocument();
  expect(screen.queryByRole("main")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "1 原文识别" })).toHaveAttribute(
    "aria-current",
    "step",
  );
});

it("第二步仅保留文件区与提示词表单，切换文件仍留在第二步", async () => {
  batchFixture();
  await openDocument(false);
  fireEvent.click(screen.getByRole("button", { name: "下一步：场景摘录" }));
  const scene = await screen.findByLabelText("摘录场景");
  await waitFor(() => expect(scene).toBeEnabled());
  expect(screen.queryByLabelText("选择 OCR 项目")).not.toBeInTheDocument();
  expect(screen.queryByLabelText("新项目名称")).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "导出文件" }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "返回原文识别" }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("heading", { name: "合成扫描件.pdf" }),
  ).not.toBeInTheDocument();
  fireEvent.click(
    within(screen.getByRole("complementary", { name: "项目文件" })).getByRole(
      "button",
      { name: /^第二合同.pdf/ },
    ),
  );
  await waitFor(() => expect(screen.getByLabelText("摘录场景")).toBeEnabled());
  expect(
    screen.queryByRole("button", { name: "开始扫描" }),
  ).not.toBeInTheDocument();
});

it("保存提示词需要命名，命名场景可重选并在重新打开项目后恢复", async () => {
  await openDocument(false);
  fireEvent.click(screen.getByRole("button", { name: "下一步：场景摘录" }));
  await screen.findByLabelText("摘录场景");
  await waitFor(() => expect(screen.getByLabelText("摘录场景")).toBeEnabled());
  fireEvent.change(screen.getByLabelText("摘录场景"), {
    target: { value: "loan_general" },
  });
  const prompt = await screen.findByLabelText("条款提取摘录要求");
  await waitFor(() => expect(prompt).toBeEnabled());
  fireEvent.change(prompt, {
    target: { value: "只摘录我关注的条款，逐字保留来源" },
  });
  fireEvent.click(screen.getByRole("button", { name: "保存为场景" }));
  const dialog = await screen.findByRole("dialog", { name: "保存为场景" });
  expect(
    within(dialog).getByRole("button", { name: "保存场景" }),
  ).toBeDisabled();
  fireEvent.change(within(dialog).getByLabelText("场景名称"), {
    target: { value: "银行条款专用场景" },
  });
  fireEvent.click(within(dialog).getByRole("button", { name: "保存场景" }));
  await waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
  const saved = savedProject.customScenarios![0];
  expect(saved).toMatchObject({
    name: "银行条款专用场景",
    baseScenarioId: "loan_general",
  });
  expect(saved.stages[0].prompt).toBe("只摘录我关注的条款，逐字保留来源");
  fireEvent.change(screen.getByLabelText("摘录场景"), {
    target: { value: "custom" },
  });
  await screen.findByLabelText("自定义摘录要求");
  await waitFor(() => expect(screen.getByLabelText("摘录场景")).toBeEnabled());
  fireEvent.change(screen.getByLabelText("摘录场景"), {
    target: { value: saved.id },
  });
  expect(await screen.findByLabelText("条款提取摘录要求")).toHaveValue(
    saved.stages[0].prompt,
  );
  cleanup();
  await openDocument(false);
  fireEvent.click(screen.getByRole("button", { name: "下一步：场景摘录" }));
  await screen.findByRole("option", { name: "银行条款专用场景" });
});

it("摘录成功自动将本次结果导出到目标目录，不弹目录选择，也不显示历史结果表", async () => {
  await openDocument(false);
  fireEvent.click(screen.getByRole("button", { name: "下一步：场景摘录" }));
  await screen.findByLabelText("摘录场景");
  await waitFor(() => expect(screen.getByLabelText("摘录场景")).toBeEnabled());
  fireEvent.change(screen.getByLabelText("摘录场景"), {
    target: { value: "loan_general" },
  });
  await screen.findByLabelText("条款提取摘录要求");
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "开始摘录" })).toBeEnabled(),
  );
  fireEvent.click(screen.getByRole("button", { name: "开始摘录" }));
  const result = await screen.findByRole("status", { name: "导出结果" });
  expect(result).toHaveTextContent("导出目录：C:/输出");
  expect(mocks.pick).not.toHaveBeenCalled();
  expect(mocks.call).toHaveBeenCalledWith("ocr.output_directory", {
    projectId: "p",
  });
  expect(mocks.job).toHaveBeenCalledWith(
    "ocr.export",
    expect.objectContaining({
      mode: "single_sheet",
      documentIds: ["d"],
      extractionIds: ["new"],
      extractionsOnly: true,
      outputDir: "C:/输出",
    }),
    expect.any(Function),
    expect.any(Function),
  );
  expect(screen.queryByRole("table")).not.toBeInTheDocument();
});

it("自动导出失败保留摘录，重试导出不重复调用模型", async () => {
  const baseJob = mocks.job.getMockImplementation()!;
  let fail = true;
  mocks.job.mockImplementation(async (method, ...args) => {
    if (method === "ocr.export" && fail) {
      fail = false;
      throw new Error("目标目录暂不可写");
    }
    return baseJob(method, ...args);
  });
  await openDocument(false);
  fireEvent.click(screen.getByRole("button", { name: "下一步：场景摘录" }));
  await screen.findByLabelText("摘录场景");
  await waitFor(() => expect(screen.getByLabelText("摘录场景")).toBeEnabled());
  fireEvent.change(screen.getByLabelText("摘录场景"), {
    target: { value: "loan_general" },
  });
  await screen.findByLabelText("条款提取摘录要求");
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "开始摘录" })).toBeEnabled(),
  );
  fireEvent.click(screen.getByRole("button", { name: "开始摘录" }));
  await screen.findByText("目标目录暂不可写");
  const retry = await screen.findByRole("button", { name: "重试导出" });
  await waitFor(() => expect(retry).toBeEnabled());
  fireEvent.click(retry);
  await screen.findByRole("status", { name: "导出结果" });
  expect(mocks.extract).toHaveBeenCalledTimes(1);
  expect(
    screen.queryByRole("button", { name: "重试导出" }),
  ).not.toBeInTheDocument();
});
