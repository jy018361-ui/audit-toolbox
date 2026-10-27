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
  getOcrPromptStages: (scenario: any, overrides?: any) =>
    structuredClone(overrides?.[scenario.id] ?? scenario.defaultPrompts),
  extractOcrScenario: mocks.extract,
}));
let savedProject: OcrProject;
let detail: OcrDocumentDetail;
let pendingSave: ((value?: unknown) => void) | undefined;
let delaySave: boolean;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.confirm.mockResolvedValue(true);
  mocks.renderSource.mockResolvedValue("data:image/png;base64,aW1hZ2U=");
  mocks.openOutput.mockResolvedValue(undefined);
  pendingSave = undefined;
  delaySave = false;
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
      if (delaySave) {
        delaySave = false;
        await new Promise((resolve) => {
          pendingSave = resolve;
        });
      }
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
async function openDocument(showOriginal = true) {
  render(
    <MemoryRouter>
      <OcrPage />
    </MemoryRouter>,
  );
  const entry = await screen.findByRole("button", { name: /合成扫描件.pdf/ });
  await waitFor(() => expect(entry).toBeEnabled());
  fireEvent.click(entry);
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "开始扫描" })).toBeEnabled(),
  );
  if (showOriginal && detail.pages.length) {
    fireEvent.click(screen.getByRole("button", { name: "查看原文" }));
    await screen.findByRole("region", { name: "全篇初始原文" });
  }
}

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
    await screen.findByRole("button", { name: "选择目录并导出" }),
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
  expect(notice.previousElementSibling).toContainElement(
    screen.getByRole("button", { name: "开始扫描" }),
  );
  fireEvent.click(within(notice).getByRole("button", { name: "打开导出目录" }));
  await waitFor(() => expect(mocks.openOutput).toHaveBeenCalledWith("C:/输出"));
});

it("第二步独立显示所有阶段的完整可编辑提示词，并保存实际使用版本", async () => {
  await openDocument();
  fireEvent.click(screen.getByRole("button", { name: "2 场景摘录" }));
  await screen.findByLabelText("摘录场景");
  await waitFor(() => expect(screen.getByLabelText("摘录场景")).toBeEnabled());
  fireEvent.change(screen.getByLabelText("摘录场景"), {
    target: { value: "loan_general" },
  });
  await screen.findByLabelText("条款提取提示词");
  await waitFor(() =>
    expect(screen.getByLabelText("条款提取提示词")).toBeEnabled(),
  );
  expect(screen.getByLabelText("条款提取提示词")).toHaveValue(
    "默认完整提取提示词",
  );
  expect(screen.getByLabelText("分段汇总提示词")).toHaveValue(
    "默认完整汇总提示词",
  );
  fireEvent.change(screen.getByLabelText("条款提取提示词"), {
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
  expect(screen.getByLabelText("条款提取提示词")).toHaveValue(
    "默认完整提取提示词",
  );
});

it("表格保存响应迟到时保留新修改，并按新修订号继续保存", async () => {
  await openDocument();
  delaySave = true;
  fireEvent.change(
    screen.getByRole("textbox", { name: "表格 1 第 2 行第 1 列" }),
    {
      target: { value: "第一次校对" },
    },
  );
  await waitFor(() => expect(pendingSave).toBeDefined(), { timeout: 2000 });
  fireEvent.change(
    screen.getByRole("textbox", { name: "表格 1 第 2 行第 1 列" }),
    {
      target: { value: "第二次校对，不得被旧响应覆盖" },
    },
  );
  pendingSave?.();
  await waitFor(() =>
    expect(detail.pages[0].tables[0].rows[1][0]).toBe(
      "第二次校对，不得被旧响应覆盖",
    ),
  );
  expect(
    screen.getByRole("textbox", { name: "表格 1 第 2 行第 1 列" }),
  ).toHaveValue("第二次校对，不得被旧响应覆盖");
  expect(detail.pages[0].revision).toBe(3);
  expect(detail.pages[0].originalText).toBe("原始正文");
  fireEvent.click(screen.getByRole("button", { name: "2 场景摘录" }));
  await screen.findByLabelText("摘录场景");
  await waitFor(() => expect(screen.getByLabelText("摘录场景")).toBeEnabled());
  expect(screen.getByText("原文已修改，需要重新摘录")).toBeInTheDocument();
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
      undefined,
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

it("可编辑表格并增删行列，保存时保留初始表格与文本前导零", async () => {
  await openDocument();
  fireEvent.change(
    screen.getByRole("textbox", { name: "表格 1 第 2 行第 1 列" }),
    { target: { value: "0001234567890123456789" } },
  );
  fireEvent.click(screen.getByRole("button", { name: "添加行" }));
  fireEvent.click(screen.getByRole("button", { name: "添加列" }));
  fireEvent.click(screen.getByRole("button", { name: "表格 1 删除第 1 行" }));
  await waitFor(
    () =>
      expect(detail.pages[0].tables[0].rows).toEqual([
        ["0001234567890123456789", "100.00", ""],
        ["", "", ""],
      ]),
    { timeout: 2000 },
  );
  expect(detail.pages[0].originalTables[0].rows).toEqual([
    ["账号", "金额"],
    ["001", "100.00"],
  ]);
});

it("保存失败时阻止切页并保留编辑内容", async () => {
  await openDocument();
  mocks.call.mockImplementationOnce(async () => {
    throw new Error("磁盘空间不足");
  });
  fireEvent.change(
    screen.getByRole("textbox", { name: "表格 1 第 2 行第 1 列" }),
    {
      target: { value: "尚未保存的修订" },
    },
  );
  fireEvent.click(screen.getByRole("button", { name: "下一页" }));
  await screen.findByText("磁盘空间不足");
  expect(
    screen.getByRole("textbox", { name: "表格 1 第 2 行第 1 列" }),
  ).toHaveValue("尚未保存的修订");
  expect(screen.getByLabelText("当前页")).toHaveValue("1");
});

it("离开工具页时立即保存尚未触发自动保存的校对", async () => {
  await openDocument();
  fireEvent.change(
    screen.getByRole("textbox", { name: "表格 1 第 2 行第 1 列" }),
    {
      target: { value: "离开页面前刚输入的修订" },
    },
  );
  cleanup();
  await waitFor(() =>
    expect(detail.pages[0].tables[0].rows[1][0]).toBe("离开页面前刚输入的修订"),
  );
});

it("切换场景前保存当前提示词，并在重新选择时恢复项目版本", async () => {
  await openDocument();
  fireEvent.click(screen.getByRole("button", { name: "2 场景摘录" }));
  await screen.findByLabelText("摘录场景");
  await waitFor(() => expect(screen.getByLabelText("摘录场景")).toBeEnabled());
  fireEvent.change(screen.getByLabelText("摘录场景"), {
    target: { value: "loan_general" },
  });
  await screen.findByLabelText("条款提取提示词");
  await waitFor(() =>
    expect(screen.getByLabelText("条款提取提示词")).toBeEnabled(),
  );
  fireEvent.change(screen.getByLabelText("条款提取提示词"), {
    target: { value: "项目专用利率提示词" },
  });
  fireEvent.change(screen.getByLabelText("摘录场景"), {
    target: { value: "custom" },
  });
  await screen.findByLabelText("自定义提示词");
  expect(savedProject.prompts.loan_general[0].prompt).toBe(
    "项目专用利率提示词",
  );
  await waitFor(() => expect(screen.getByLabelText("摘录场景")).toBeEnabled());
  fireEvent.change(screen.getByLabelText("摘录场景"), {
    target: { value: "loan_general" },
  });
  await waitFor(() =>
    expect(screen.getByLabelText("条款提取提示词")).toHaveValue(
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
  await screen.findByLabelText("条款提取提示词");
  await waitFor(() =>
    expect(screen.getByLabelText("条款提取提示词")).toBeEnabled(),
  );
  fireEvent.change(screen.getByLabelText("条款提取提示词"), {
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
  await screen.findByLabelText("条款提取提示词");
  await waitFor(() =>
    expect(screen.getByLabelText("条款提取提示词")).toBeEnabled(),
  );
  fireEvent.change(screen.getByLabelText("条款提取提示词"), {
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
  expect(screen.getByLabelText("条款提取提示词")).toHaveValue(
    "尚未保存的提示词",
  );
});

it("多页逐字证据提供独立页码入口", async () => {
  detail.extractions[0].columns = [{ key: "sourcePage", label: "核实页码" }];
  detail.extractions[0].rows = [{ sourcePage: "1、2" }];
  await openDocument();
  fireEvent.click(screen.getByRole("button", { name: "2 场景摘录" }));
  await screen.findByLabelText("摘录场景");
  await waitFor(() => expect(screen.getByLabelText("摘录场景")).toBeEnabled());
  expect(screen.getByRole("button", { name: "第 1 页" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "第 2 页" }));
  await waitFor(() => expect(screen.getByLabelText("当前页")).toHaveValue("2"));
  expect(
    await screen.findByRole("article", { name: "第 2 页原文" }),
  ).toHaveTextContent("本页尚未扫描");
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
    const entry = await screen.findByRole("button", { name: /合成扫描件.pdf/ });
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
    await screen.findByRole("img", { name: "合成扫描件.pdf 第 2 页" });
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
  fireEvent.click(screen.getByRole("button", { name: "返回原文识别" }));
  await screen.findByRole("region", { name: "全篇初始原文" });
  expect(screen.queryByLabelText("摘录场景")).not.toBeInTheDocument();
});

it("摘录单元格中的对象按可读内容呈现，不向用户显示 JSON", async () => {
  detail.extractions[0].columns = [{ key: "evidence", label: "证据" }];
  detail.extractions[0].rows = [{ evidence: { text: "合同约定", page: 1 } }];
  await openDocument();
  fireEvent.click(screen.getByRole("button", { name: "2 场景摘录" }));
  await screen.findByLabelText("摘录场景");
  await waitFor(() => expect(screen.getByLabelText("摘录场景")).toBeEnabled());
  await screen.findByText(/内容：合同约定/);
  expect(screen.getByText(/页码：1/)).toBeInTheDocument();
  expect(screen.queryByText(/\{"text"/)).not.toBeInTheDocument();
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
        message: expect.stringContaining(
          "替换所选页面现有的识别正文及表格校对内容",
        ),
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

it("原文默认折叠，可展开收起并复制全部已扫描页的初始版本", async () => {
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
    expect(screen.getByRole("button", { name: "查看原文" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    fireEvent.click(screen.getByRole("button", { name: "查看原文" }));
    await screen.findByRole("region", { name: "全篇初始原文" });
    fireEvent.click(screen.getByRole("button", { name: "复制全部原文" }));
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(
        "第 1 页\n原始正文\n\n第 4 页\n第四页扫描原文",
      ),
    );
    expect(
      await screen.findByText("已复制本文件已扫描页的全部原文。"),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "收起原文" }));
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
      within(files).getAllByRole("button", { name: /扫描件-\d+\.pdf/ }),
    ).toHaveLength(9),
  );
  expect(
    within(files).queryByRole("button", { name: /扫描件-10\.pdf/ }),
  ).not.toBeInTheDocument();
  const expand = within(files).getByRole("button", {
    name: "展开全部 11 份文件",
  });
  expect(expand).toHaveAttribute("aria-expanded", "false");
  fireEvent.click(expand);
  expect(
    within(files).getAllByRole("button", { name: /扫描件-\d+\.pdf/ }),
  ).toHaveLength(11);
  const collapse = within(files).getByRole("button", { name: "收起文件" });
  expect(collapse).toHaveAttribute("aria-expanded", "true");
  fireEvent.click(collapse);
  expect(
    within(files).getAllByRole("button", { name: /扫描件-\d+\.pdf/ }),
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
    undefined,
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

it("表格目录按页排列，跨页选择只展开单张表格并保存对应页修改", async () => {
  detail.pages[0].tables.push({
    id: "t2",
    title: "第二明细",
    rows: [["项目"], ["首页第二表"]],
  });
  detail.pages.push({
    ...structuredClone(detail.pages[0]),
    page: 2,
    tables: [
      {
        id: "t3",
        title: "宽表",
        rows: [
          Array.from({ length: 12 }, (_, i) => `字段${i + 1}`),
          Array.from({ length: 12 }, (_, i) => `值${i + 1}`),
        ],
      },
    ],
  });
  await openDocument();
  const directory = screen.getByRole("region", { name: "表格目录" });
  const entries = within(directory).getAllByRole("button");
  expect(
    entries.map((entry) => entry.textContent?.replace(/\s+/g, " ").trim()),
  ).toEqual([
    expect.stringContaining("第 1 页"),
    expect.stringContaining("第 1 页"),
    expect.stringContaining("第 2 页"),
  ]);
  expect(
    within(directory).getByRole("button", {
      name: /第 1 页.*明细表.*2 行.*2 列/,
    }),
  ).toBeInTheDocument();
  expect(
    screen.queryByRole("textbox", { name: "表格 2 名称" }),
  ).not.toBeInTheDocument();
  fireEvent.click(
    within(directory).getByRole("button", {
      name: /第 1 页.*第二明细.*2 行.*1 列/,
    }),
  );
  await screen.findByRole("textbox", { name: "表格 2 名称" });
  expect(
    screen.queryByRole("textbox", { name: "表格 1 名称" }),
  ).not.toBeInTheDocument();
  fireEvent.click(
    within(directory).getByRole("button", {
      name: /第 2 页.*宽表.*2 行.*12 列/,
    }),
  );
  await waitFor(() => expect(screen.getByLabelText("当前页")).toHaveValue("2"));
  expect(screen.getByRole("textbox", { name: "表格 1 名称" })).toHaveValue(
    "宽表",
  );
  expect(
    screen.queryByRole("textbox", { name: "表格 2 名称" }),
  ).not.toBeInTheDocument();
  const cell = screen.getByRole("textbox", { name: "表格 1 第 2 行第 12 列" });
  expect(cell.closest(".ocr-table-scroll")).toBeInTheDocument();
  fireEvent.change(cell, { target: { value: "跨页修订" } });
  await waitFor(
    () =>
      expect(
        detail.pages.find((page) => page.page === 2)?.tables[0].rows[1][11],
      ).toBe("跨页修订"),
    { timeout: 2000 },
  );
  expect(
    detail.pages.find((page) => page.page === 1)?.tables[0].rows[1][0],
  ).toBe("001");
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
    mocks.call.mockImplementation((method, params) =>
      method === "ocr.documents"
        ? { documents: docs }
        : baseCall(method, params),
    );
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
      screen.getByRole("heading", { name: "合成扫描件.pdf" }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "导出所选文件" }));
    const dialog = await screen.findByRole("dialog", { name: "导出文件" });
    expect(within(dialog).getByLabelText("导出范围")).toHaveValue("selected");
    const radios = within(dialog).getAllByRole("radio");
    fireEvent.click(
      radios.find((radio) => (radio as HTMLInputElement).value === mode)!,
    );
    fireEvent.click(
      within(dialog).getByRole("button", { name: "选择目录并导出" }),
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
    fireEvent.click(screen.getByRole("button", { name: "清空选择" }));
    expect(all).not.toBeChecked();
    expect(screen.getByRole("button", { name: "导出所选文件" })).toBeDisabled();
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
