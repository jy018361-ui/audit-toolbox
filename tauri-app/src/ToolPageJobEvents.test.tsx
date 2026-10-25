// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExcelMergerPage } from "./ExcelMergerPage";
import FileListDirectoryPage from "./FileListDirectoryPage";
import PdfToExcelPage from "./PdfToExcelPage";
import { FuzzyMatchPage } from "./FuzzyMatchPage";
import type { JobEvent, ToolManifest } from "./types";

const hooks = vi.hoisted(() => ({ listeners: [] as Array<(event: JobEvent) => void> }));
vi.mock("./api", () => ({
  engineCall: vi.fn(),
  jobCancel: vi.fn(async () => true),
  jobStart: vi.fn(async () => "job-1"),
  listenFileDrops: vi.fn(async () => () => undefined),
  listenPositionedFileDrops: vi.fn(async () => () => undefined),
  listenJobEvents: vi.fn(async (cb: (event: JobEvent) => void) => {
    hooks.listeners.push(cb);
    return () => { hooks.listeners = hooks.listeners.filter((listener) => listener !== cb); };
  }),
  openOutput: vi.fn(),
  pickPath: vi.fn(async () => null),
}));

const tool = (id: string, name: string): ToolManifest => ({
  id, name, description: "", route: `/tools/${id}`, version: "test", capabilities: [], migrationStatus: "ready",
});
const event = (toolId: string, phase: string, message: string, result?: unknown, outputPaths: string[] = []): JobEvent => ({
  jobId: "job-1", toolId, phase, current: phase === "completed" ? 1 : 0,
  total: 1, message, severity: phase === "failed" ? "error" : phase === "completed" ? "success" : "info",
  outputPaths, result,
} as JobEvent);
const emit = (next: JobEvent) => act(() => { [...hooks.listeners].forEach((cb) => cb(next)); });
const state = (value: string) => document.querySelector(`[data-job-state="${value}"]`);

beforeEach(async () => {
  hooks.listeners.length = 0;
  const api = await import("./api");
  vi.mocked(api.jobStart).mockResolvedValue("job-1");
  vi.mocked(api.pickPath).mockResolvedValue(null);
  vi.mocked(api.engineCall).mockResolvedValue({});
});
afterEach(() => { cleanup(); sessionStorage.clear(); vi.clearAllMocks(); });

describe("真实工具页任务事件状态", () => {
  it("Excel 右键切换同文件 Sheet：传递精确基准、失败保留原网格、重试后按新列序导出", async () => {
    const api = await import("./api");
    const path = "C:/客户/合并源.xlsx";
    const headers = ["日期", "凭证号", "金额"];
    const detection = { headerRow: 0, headerRowsCount: 1, confidence: 1, needsReview: false };
    const previewFor = (sheet: string) => {
      const targetHeaders = sheet === "新增清单" ? ["金额", "日期", "凭证号"] : headers;
      return {
        template: { path, name: "合并源.xlsx", sheet, headers: targetHeaders, detection, external: false, rawRows: [targetHeaders] },
        rows: ["原表", "新增清单"].map((name) => ({
          path, name: "合并源.xlsx", sheet: name, headers, detection, preview: [], rawRows: [headers],
          matches: headers.map((header) => ({ target: targetHeaders.indexOf(header), confidence: 1, reason: "名称一致" })),
        })),
      };
    };
    let failSwitch = true;
    vi.mocked(api.pickPath).mockResolvedValue([path]);
    vi.mocked(api.engineCall).mockImplementation(async (method, params) => {
      if (method === "excel_merger.inspect") return {
        files: [{ path, name: "合并源.xlsx", size: 100, sheets: ["原表", "新增清单"] }], availableSheets: ["原表", "新增清单"],
      };
      const sheet = (params as { templateSheet?: string }).templateSheet ?? "原表";
      if (sheet === "新增清单" && failSwitch) throw new Error("工作表读取失败，请重试");
      return previewFor(sheet);
    });
    render(<ExcelMergerPage tool={tool("excel_merger", "Excel 批量合并")} />);
    fireEvent.click(screen.getByRole("button", { name: "添加文件" }));
    await screen.findByText("1 个文件");
    fireEvent.click(screen.getByRole("button", { name: "检查文件与 Sheet" }));
    await waitFor(() => expect(api.engineCall).toHaveBeenCalledWith("excel_merger.inspect", expect.anything()));
    fireEvent.click(screen.getByRole("button", { name: "智能匹配并预览" }));
    await screen.findByText("当前基准：合并源.xlsx / 原表");
    const chooseSecond = () => {
      fireEvent.contextMenu(screen.getByLabelText("合并源.xlsx / 新增清单，右键设为基准"));
      fireEvent.click(screen.getByRole("button", { name: "设为基准" }));
    };
    chooseSecond();
    await waitFor(() => expect(document.querySelector(".hmg-error")).toHaveTextContent("工作表读取失败"));
    expect(screen.getByText("当前基准：合并源.xlsx / 原表")).toBeInTheDocument();
    expect(api.engineCall).toHaveBeenLastCalledWith("excel_merger.match_preview", expect.objectContaining({ templatePath: path, templateSheet: "新增清单" }));
    failSwitch = false;
    chooseSecond();
    await screen.findByText("当前基准：合并源.xlsx / 新增清单");
    expect(document.querySelector(".hmg-error")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    fireEvent.click(screen.getByRole("button", { name: "智能匹配并预览" }));
    await screen.findByText("当前基准：合并源.xlsx / 新增清单");
    expect(api.engineCall).toHaveBeenLastCalledWith("excel_merger.match_preview", expect.objectContaining({ templateSheet: "新增清单" }));
    fireEvent.click(screen.getByRole("button", { name: "调整后导出" }));
    await waitFor(() => expect(api.jobStart).toHaveBeenCalledWith("excel_merger.merge", expect.objectContaining({
      headerMatching: expect.objectContaining({ templateHeaders: ["金额", "日期", "凭证号"] }),
    })));
  });

  it("Excel 合并：运行、失败和取消占用结果区，失败结果不能显示成功", async () => {
    const api = await import("./api");
    vi.mocked(api.pickPath).mockResolvedValue(["C:/客户/合并源.xlsx"]);
    vi.mocked(api.engineCall).mockResolvedValue({ files: [{ path: "C:/客户/合并源.xlsx", name: "合并源.xlsx", size: 100, sheets: ["Sheet1"] }], availableSheets: ["Sheet1"] });
    const { container } = render(<ExcelMergerPage tool={tool("excel_merger", "Excel 批量合并")} />);
    fireEvent.click(screen.getByRole("button", { name: "添加文件" }));
    await screen.findByText("1 个文件");
    // 智能表头匹配恒定开启（纵向单表必经确认页）；本用例盯任务事件状态，
    // 切到多 Sheet 工作簿模式走原「开始合并」路径。
    fireEvent.click(screen.getByRole("radio", { name: "合并成一个工作簿（多 Sheet）" }));
    fireEvent.click(screen.getByRole("button", { name: "检查文件与 Sheet" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "开始合并" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "开始合并" }));
    await waitFor(() => expect(api.jobStart).toHaveBeenCalled());
    emit(event("Excel_Merger", "running", "正在合并"));
    expect(state("running")).toBeInTheDocument();
    expect(state("running")?.closest(".merger-progress")).toBeInTheDocument();
    emit(event("Excel_Merger", "failed", "合并失败", { error: { userMessage: "文件被占用" } }));
    expect(state("failed")).toHaveTextContent("合并失败");
    expect(container).toHaveTextContent("文件被占用");
    expect(container.querySelectorAll(".error-box")).toHaveLength(0);
    expect(state("failed")).toHaveTextContent("文件被占用");
    expect(container).not.toHaveTextContent("处理完成");
    emit(event("Excel_Merger", "cancelled", "用户已取消"));
    expect(state("cancelled")).toHaveTextContent("用户已取消");
    emit(event("Excel_Merger", "completed", "合并完成", { outputCount: 1 }));
    expect(state("completed")).toHaveTextContent("合并完成");
    // 结果对象没有 message 时 ResultView 用中性文案，不再代引擎宣称"处理完成"。
    expect(state("completed")?.closest(".merger-progress")).toHaveTextContent("运行结束");
  });

  it("PDF 转 Excel：运行与结果在结果卡内，取消在页首清楚提示", async () => {
    const api = await import("./api");
    vi.mocked(api.pickPath).mockResolvedValue(["C:/客户/函证.pdf"]);
    const { container } = render(<PdfToExcelPage tool={tool("pdf_to_excel", "PDF 转 Excel")} />);
    fireEvent.click(screen.getByRole("button", { name: "选择文件" }));
    await screen.findByText("函证.pdf");
    fireEvent.click(screen.getByRole("button", { name: "开始转换" }));
    await waitFor(() => expect(api.jobStart).toHaveBeenCalled());
    emit(event("pdf_to_excel", "running", "正在转换"));
    expect(state("running")).toBeInTheDocument();
    expect(state("running")?.closest('[data-slot="card"]')).toHaveTextContent("3. 进度与结果");
    const partial = { files: [
      { name: "甲.pdf", status: "成功", pages: 1, textRows: 10, tables: 1, tableDataRows: 2, outputPath: "C:/甲.xlsx", error: "" },
      { name: "乙.pdf", status: "失败", pages: 0, textRows: 0, tables: 0, tableDataRows: 0, outputPath: "", error: "加密文件" },
    ], manifestPath: "C:/处理清单.xlsx", successCount: 1, failCount: 1, outputPaths: ["C:/处理清单.xlsx"] };
    emit(event("pdf_to_excel", "completed", "转换完成", partial, partial.outputPaths));
    expect(container).toHaveTextContent("成功 1、失败 1");
    expect(screen.getByText("加密文件")).toBeInTheDocument();
    // 评审决议：结果横幅改绿色成功层、失败整行浅红底；「打开输出」并入横幅。
    expect(container.querySelector(".pdf-result-callout.pdf-result-toned")).not.toBeNull();
    expect(container.querySelector("tr.pdf-row-failed")).not.toBeNull();
    expect(container.querySelector(".pdf-row-failed .pdf-error-text")?.textContent).toBe("加密文件");
    expect(screen.getByRole("button", { name: "打开输出" }).closest(".pdf-result-callout")).not.toBeNull();
    expect(screen.getByRole("button", { name: "打开输出" })).toHaveAttribute("title", "C:/处理清单.xlsx");
    emit(event("pdf_to_excel", "failed", "转换失败"));
    expect(state("failed")).toHaveTextContent("转换失败");
    emit(event("pdf_to_excel", "cancelled", "已取消"));
    expect(container.querySelector('[data-variant="warning"]')).toHaveTextContent("已取消");
    expect(container).toHaveTextContent("本次转换已停止");
    expect(container.querySelector(".error-box")).toBeNull();
  });

  it("文件夹清单：扫描运行、完成和失败有反馈，取消在页首提示", async () => {
    const api = await import("./api");
    vi.mocked(api.pickPath).mockResolvedValue("C:/客户资料");
    const { container } = render(<FileListDirectoryPage tool={tool("file_list_directory", "文件夹超链接清单")} />);
    fireEvent.click(screen.getByRole("button", { name: "源文件夹 *" }));
    await waitFor(() => expect(api.jobStart).toHaveBeenCalledWith("file_list.scan", { sourceDir: "C:/客户资料" }));
    emit(event("file_list_directory", "running", "正在扫描"));
    expect(state("running")).toBeInTheDocument();
    expect(state("running")?.closest('[data-slot="card"]')).toHaveTextContent("扫描预览");
    const scan = { sourceDir: "C:/客户资料", rootName: "客户资料", fileCount: 1, maxDepth: 0, previewLimit: 50, outputPath: "C:/清单.xlsx", preview: [{ name: "凭证.pdf", relativePath: "凭证.pdf", fullPath: "C:/客户资料/凭证.pdf", levels: [] }] };
    emit(event("file_list_directory", "completed", "扫描完成", scan));
    expect(container).toHaveTextContent("凭证.pdf");
    emit(event("file_list_directory", "failed", "导出失败"));
    expect(state("failed")).toHaveTextContent("导出失败");
    emit(event("file_list_directory", "cancelled", "已取消扫描"));
    expect(container.querySelector('[data-variant="warning"]')).toHaveTextContent("已取消");
    expect(container).toHaveTextContent("本次任务已停止");
  });

  it("模糊匹配：运行、失败、取消、完成后结果处于同一工作流", async () => {
    const api = await import("./api");
    vi.mocked(api.pickPath).mockImplementation(async (_kind, title) => String(title).includes("来源 A") ? "C:/a.xlsx" : "C:/b.xlsx");
    vi.mocked(api.engineCall).mockImplementation(async (method) => method === "fuzzy.inspect" ? { headers: ["名称"], preview: [["甲公司"]], rowCount: 1, sheet: "Sheet1", sheets: ["Sheet1"] } : {});
    const { container } = render(<FuzzyMatchPage tool={tool("fuzzy_match", "两列模糊匹配")} />);
    fireEvent.click(screen.getByRole("button", { name: "选择来源 A 文件" }));
    fireEvent.click(screen.getByRole("button", { name: "选择来源 B 文件" }));
    await waitFor(() => expect(document.querySelectorAll(".dt-header-control select")).toHaveLength(2));
    document.querySelectorAll<HTMLSelectElement>(".dt-header-control select").forEach((select) => fireEvent.change(select, { target: { value: "column" } }));
    fireEvent.click(screen.getByRole("button", { name: "开始匹配" }));
    await waitFor(() => expect(api.jobStart).toHaveBeenCalled());
    emit(event("fuzzy_match", "running", "正在匹配"));
    expect(state("running")).toBeInTheDocument();
    // 评审决议：「预估与启动」并入「匹配设置」卡底部，进度条随迁。
    expect(state("running")?.closest('[data-slot="card"]')).toHaveTextContent("匹配设置");
    emit(event("fuzzy_match", "failed", "匹配失败"));
    expect(state("failed")).toHaveTextContent("匹配失败");
    emit(event("fuzzy_match", "cancelled", "匹配取消"));
    expect(container.querySelector('[data-variant="warning"]')).toHaveTextContent("已取消");
    expect(container).toHaveTextContent("本次任务已停止");
    expect(container.querySelector(".error-box")).toBeNull();
    emit(event("fuzzy_match", "completed", "匹配完成", { summary: { rowsA: 1, rowsB: 1, autoCount: 0, suspectCount: 0, unmatchedCount: 1, invalidCount: 0, elapsedMs: 10 }, rows: [{ aIndex: 0, aValue: "甲公司", matches: [] }] }));
    expect(container).toHaveTextContent("匹配结果");
    expect(container).toHaveTextContent("未匹配");
  });
});
