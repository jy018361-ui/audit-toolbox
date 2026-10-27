// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import OcrPage from "./OcrPage";
import type { OcrDocumentDetail, OcrProject } from "./ocrTypes";

const mocks = vi.hoisted(() => ({
  call: vi.fn(),
  job: vi.fn(),
  pick: vi.fn(),
  cancel: vi.fn(),
  pause: vi.fn(),
  extract: vi.fn(),
  dispose: vi.fn(),
  nativeDrag: vi.fn(async (_callback: (event: {type: string; paths?: string[]}) => void) => () => {}),
  confirm: vi.fn(),
}));
vi.mock("@/components/ConfirmDialog", () => ({ confirmDialog: mocks.confirm }));
vi.mock("./ocrApi", () => ({ ocrCall: mocks.call, runOcrJob: mocks.job }));
vi.mock("./api", () => ({
  jobCancel: mocks.cancel,
  jobPause: mocks.pause,
  pickPath: mocks.pick,
  listenNativeFileDragEvents: mocks.nativeDrag,
  openOutput: vi.fn(),
}));
vi.mock("./ocrSource", () => ({
  openOcrSource: vi.fn(async () => ({
    totalPages: 2,
    render: async () => "data:image/png;base64,aW1hZ2U=",
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
    detail.pages.push(page);
    return page;
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
async function openDocument() {
  render(
    <MemoryRouter>
      <OcrPage />
    </MemoryRouter>,
  );
  const entry = await screen.findByRole("button", { name: /合成扫描件.pdf/ });
  await waitFor(() => expect(entry).toBeEnabled());
  fireEvent.click(entry);
  await screen.findByRole("region", { name: "本页初始原文" });
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "继续识别" })).toBeEnabled(),
  );
}

it("OCR 复用上传槽，点击选择与原生拖入文件/文件夹走相同导入流程", async () => {
  await openDocument();
  mocks.pick.mockResolvedValueOnce(["C:/扫描件/一.pdf", "C:/扫描件/二.png"]);
  fireEvent.click(screen.getByRole("button", {name: "导入文件"}));
  await waitFor(() => expect(mocks.call).toHaveBeenCalledWith("ocr.document_import", {
    projectId: "p", paths: ["C:/扫描件/一.pdf", "C:/扫描件/二.png"], folder: undefined,
  }));
  await waitFor(() => expect(screen.getByRole("button", {name: "导入文件"})).toBeEnabled());
  const receive = mocks.nativeDrag.mock.calls[0][0];
  await act(async () => receive({type: "enter"}));
  expect(screen.getByRole("button", {name: "导入文件"}).closest(".file-drop-input")).toHaveClass("drag-hover");
  await act(async () => receive({type: "drop", paths: ["C:/扫描目录", "C:/额外.tiff"]}));
  await waitFor(() => expect(mocks.call).toHaveBeenCalledWith("ocr.document_import", {
    projectId: "p", paths: ["C:/扫描目录", "C:/额外.tiff"], folder: undefined,
  }));
  expect(screen.getByRole("button", {name: "导入文件"}).closest(".file-drop-input")).not.toHaveClass("drag-hover");
});

it("OCR 保活隐藏页不导入其他工具收到的文件", async () => {
  await openDocument();
  const upload = screen.getByRole("button", {name: "导入文件"});
  const page = upload.closest(".ocr-page")!;
  page.setAttribute("hidden", "");
  await act(async () => mocks.nativeDrag.mock.calls[0][0]({type: "drop", paths: ["C:/会议.mp4"]}));
  expect(mocks.call).not.toHaveBeenCalledWith("ocr.document_import", expect.anything());
});

it("OCR 可直接导出，不要求选择场景或调用摘录", async () => {
  await openDocument();
  expect(screen.queryByLabelText("摘录场景")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "导出本文件" }));
  await screen.findByRole("button", { name: "合成扫描件.xlsx" });
  expect(mocks.job).toHaveBeenCalledWith(
    "ocr.export",
    expect.objectContaining({ mode: "individual", documentIds: ["d"] }),
    expect.any(Function),
    expect.any(Function),
  );
  expect(mocks.extract).not.toHaveBeenCalled();
});

it("第二步独立显示所有阶段的完整可编辑提示词，并保存实际使用版本", async () => {
  await openDocument();
  fireEvent.click(screen.getByRole("button", { name: "2 判断摘录" }));
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
  fireEvent.click(screen.getByRole("button", { name: "2 判断摘录" }));
  await screen.findByLabelText("摘录场景");
  await waitFor(() => expect(screen.getByLabelText("摘录场景")).toBeEnabled());
  expect(screen.getByText("原文已修改，需要重新摘录")).toBeInTheDocument();
});

it("继续识别只处理未完成页，横向表格默认不拆页", async () => {
  await openDocument();
  fireEvent.click(screen.getByRole("button", { name: "继续识别" }));
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
      screen.getByRole("region", { name: "本页初始原文" }),
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
  fireEvent.click(screen.getByRole("button", { name: "2 判断摘录" }));
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
  fireEvent.click(screen.getByRole("button", { name: "2 判断摘录" }));
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
  fireEvent.click(screen.getByRole("button", { name: "继续识别" }));
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
      screen.getByRole("region", { name: "本页初始原文" }),
    ).toHaveTextContent("原始正文"),
  );
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "继续识别" })).toBeEnabled(),
  );
  expect(detail.pages).toHaveLength(1);
});

it("提示词保存失败时保留当前场景和未保存编辑", async () => {
  await openDocument();
  fireEvent.click(screen.getByRole("button", { name: "2 判断摘录" }));
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
  fireEvent.click(screen.getByRole("button", { name: "2 判断摘录" }));
  await screen.findByLabelText("摘录场景");
  await waitFor(() => expect(screen.getByLabelText("摘录场景")).toBeEnabled());
  expect(screen.getByRole("button", { name: "第 1 页" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "第 2 页" }));
  await waitFor(() => expect(screen.getByLabelText("当前页")).toHaveValue("2"));
  expect(screen.getByText(/本页尚未识别/)).toBeInTheDocument();
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
    expect(screen.getByText(/本页尚未识别/)).toBeInTheDocument();
    expect(detail.document.totalPages).toBe(2);
    expect(mocks.job).not.toHaveBeenCalled();
    expect(mocks.extract).not.toHaveBeenCalled();
  },
);

it("原文只读显示初始识别版本，已有校对内容继续保留但不提供编辑框", async () => {
  detail.pages[0].text = "此前保存的人工校对正文";
  await openDocument();
  expect(
    screen.getByRole("region", { name: "本页初始原文" }),
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
  fireEvent.click(screen.getByRole("button", { name: "下一步：判断摘录" }));
  await screen.findByLabelText("摘录场景");
  expect(
    screen.queryByRole("region", { name: "本页初始原文" }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "继续识别" }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "导入文件" }),
  ).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "返回原文识别" }));
  await screen.findByRole("region", { name: "本页初始原文" });
  expect(screen.queryByLabelText("摘录场景")).not.toBeInTheDocument();
});

it("摘录单元格中的对象按可读内容呈现，不向用户显示 JSON", async () => {
  detail.extractions[0].columns = [{ key: "evidence", label: "证据" }];
  detail.extractions[0].rows = [{ evidence: { text: "合同约定", page: 1 } }];
  await openDocument();
  fireEvent.click(screen.getByRole("button", { name: "2 判断摘录" }));
  await screen.findByLabelText("摘录场景");
  await waitFor(() => expect(screen.getByLabelText("摘录场景")).toBeEnabled());
  await screen.findByText(/内容：合同约定/);
  expect(screen.getByText(/页码：1/)).toBeInTheDocument();
  expect(screen.queryByText(/\{"text"/)).not.toBeInTheDocument();
});

it("取消全文重识别不调用 OCR，不替换原有表格校对", async () => {
  mocks.confirm.mockResolvedValue(false);
  detail.pages[0].tables[0].rows[1][0] = "已人工校对的账号";
  await openDocument();
  fireEvent.click(screen.getByRole("button", { name: "重新识别全文" }));
  await waitFor(() =>
    expect(mocks.confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "重新识别全文？",
        message: expect.stringContaining("替换现有识别正文及表格校对内容"),
      }),
    ),
  );
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "重新识别全文" })).toBeEnabled(),
  );
  expect(mocks.job).not.toHaveBeenCalled();
  expect(detail.pages[0].tables[0].rows[1][0]).toBe("已人工校对的账号");
});

it("确认全文重识别只处理当前文件的全部页面，并携带各页已存修订号", async () => {
  detail.pages[0].revision = 4;
  detail.pages.push({
    ...structuredClone(detail.pages[0]),
    page: 2,
    revision: 7,
  });
  await openDocument();
  fireEvent.click(screen.getByRole("button", { name: "重新识别全文" }));
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
    expect(screen.getByRole("button", { name: "重新识别全文" })).toBeEnabled(),
  );
});
