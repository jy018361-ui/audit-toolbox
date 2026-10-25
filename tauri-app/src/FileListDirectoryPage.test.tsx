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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import FileListDirectoryPage from "./FileListDirectoryPage";
import { jobStart, listenJobEvents } from "./api";
import type { ToolManifest } from "./types";

vi.mock("./api", () => ({
  jobCancel: vi.fn(),
  jobStart: vi.fn(),
  listenJobEvents: vi.fn().mockResolvedValue(() => undefined),
  openOutput: vi.fn(),
  pickPath: vi.fn().mockResolvedValue(null),
}));
vi.mock("./components/ConfirmDialog", () => ({
  confirmDialog: vi.fn().mockResolvedValue(true),
}));

const tool: ToolManifest = {
  id: "file_list_directory",
  name: "文件夹超链接清单",
  description: "",
  route: "/tools/file_list_directory",
  version: "test",
  capabilities: [],
  migrationStatus: "ready",
};

describe("FileListDirectoryPage", () => {
  beforeEach(() => {
    vi.mocked(jobStart).mockReset().mockResolvedValue("job-scan");
    sessionStorage.setItem(
      "audit-toolbox:file-list-directory:v1",
      JSON.stringify({
        sourceDir: "C:\\客户资料",
        outputPath: "C:\\客户资料List.xlsx",
        scan: {
          sourceDir: "C:\\客户资料",
          rootName: "客户资料",
          fileCount: 1,
          maxDepth: 0,
          previewLimit: 50,
          outputPath: "C:\\客户资料List.xlsx",
          preview: [],
        },
      }),
    );
  });

  afterEach(() => {
    cleanup();
    sessionStorage.clear();
  });

  it("uses two steps and generates directly from the output step", async () => {
    const { container } = render(<FileListDirectoryPage tool={tool} />);
    const steps = container.querySelector(".step-indicator");
    expect(steps).not.toBeNull();
    expect(within(steps as HTMLElement).getAllByRole("button")).toHaveLength(2);

    const next = await screen.findByRole("button", {
      name: "下一步：输出文件",
    });
    await waitFor(() => expect(next).toBeEnabled());
    fireEvent.click(next);

    // 步骤条第 2 格与卡题同词（步骤条、新手提示、卡题会出现同名词）
    expect(
      screen.getByText("确认并生成", { selector: "[data-slot='card-title']" }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("输出 Excel 文件")).toHaveValue(
      "客户资料List.xlsx",
    );
    expect(
      screen.queryByDisplayValue("C:\\客户资料List.xlsx"),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "生成文件清单" })).toBeEnabled();
    expect(screen.queryByText("3. 生成文件清单")).not.toBeInTheDocument();
  });

  it("给未扫描状态明确下一步", () => {
    sessionStorage.clear();
    render(<FileListDirectoryPage tool={tool} />);
    expect(screen.getByText("等待扫描文件夹")).toBeVisible();
    expect(screen.getByRole("button", { name: "源文件夹 *" })).toBeEnabled();
    expect(
      within(screen.getByRole("region", { name: "等待扫描文件夹" }))
        .queryByRole("button"),
    ).not.toBeInTheDocument();
  });

  it("记录导出编号后继续使用原订阅，结束立即恢复生成按钮", async () => {
    const before = vi.mocked(listenJobEvents).mock.calls.length;
    render(<FileListDirectoryPage tool={tool} />);
    await waitFor(() => expect(vi.mocked(listenJobEvents).mock.calls.length).toBe(before + 1));
    const callback = vi.mocked(listenJobEvents).mock.calls.at(-1)![0];
    fireEvent.click(await screen.findByRole("button", { name: "下一步：输出文件" }));
    vi.mocked(jobStart).mockResolvedValueOnce("fast-export");
    fireEvent.click(screen.getByRole("button", { name: "生成文件清单" }));
    await waitFor(() => expect(jobStart).toHaveBeenCalledWith("file_list.export", expect.anything()));
    await act(async () => undefined);
    act(() => callback({
      jobId: "fast-export", toolId: "file_list_directory", phase: "completed",
      current: 1, total: 1, message: "清单导出完成", severity: "success",
      outputPaths: ["C:/客户资料List.xlsx"],
    }));
    expect(vi.mocked(listenJobEvents).mock.calls.length).toBe(before + 1);
    expect(screen.getByRole("button", { name: "生成文件清单" })).toBeEnabled();
    expect(screen.getByText("清单导出完成")).toBeVisible();
  });

  it.each(["failed", "cancelled"])("扫描 %s 后首屏显示明确终态与重试方向", async (phase) => {
    sessionStorage.clear();
    render(<FileListDirectoryPage tool={tool} />);
    const { pickPath } = await import("./api");
    vi.mocked(pickPath).mockResolvedValueOnce("C:\\客户资料");
    fireEvent.click(screen.getByRole("button", { name: "源文件夹 *" }));
    await waitFor(() => expect(jobStart).toHaveBeenCalledWith("file_list.scan", { sourceDir: "C:\\客户资料" }));
    await waitFor(() => expect(vi.mocked(listenJobEvents).mock.calls.length).toBeGreaterThan(0));
    const callback = vi.mocked(listenJobEvents).mock.calls.at(-1)?.[0];
    act(() => callback?.({
      jobId: "job-scan",
      toolId: "file_list_directory",
      phase,
      current: 1,
      total: 3,
      message: phase === "failed" ? "目录无访问权限" : "任务已取消",
      severity: phase === "failed" ? "error" : "warning",
      outputPaths: [],
    }));
    expect(screen.getByText(phase === "failed" ? "扫描失败" : "扫描已取消")).toBeVisible();
    expect(screen.getByText(/已选文件夹仍保留，可点击上方/)).toBeVisible();
    expect(screen.queryByText("等待扫描文件夹")).not.toBeInTheDocument();
    if (phase === "cancelled") {
      expect(document.querySelector(".job-progress-error")).toBeNull();
      expect(screen.getAllByText("已取消").find((node) => node.getAttribute("data-variant") === "warning")).toBeInTheDocument();
    }
  });

  /* UI 审核：扫描完成后底部不得再挂「部分完成 100%」横幅；摘要要点明
     子目录深度；屏上预览删去与文件名称、层级逐行重复的「相对路径」列
    （导出 Excel 不受影响），整列为空的层级列自动隐藏。 */
  it("扫描完成后不残留进度横幅，预览表只留层级与文件名称", async () => {
    sessionStorage.clear();
    render(<FileListDirectoryPage tool={tool} />);
    const { pickPath } = await import("./api");
    vi.mocked(pickPath).mockResolvedValueOnce("C:\\客户资料");
    fireEvent.click(screen.getByRole("button", { name: "源文件夹 *" }));
    await waitFor(() => expect(jobStart).toHaveBeenCalledWith("file_list.scan", { sourceDir: "C:\\客户资料" }));
    const callback = vi.mocked(listenJobEvents).mock.calls.at(-1)?.[0];
    act(() => callback?.({
      jobId: "job-scan",
      toolId: "file_list_directory",
      phase: "completed",
      current: 1,
      total: 1,
      message: "扫描完成：2 个文件，最深 1 级目录。",
      severity: "success",
      outputPaths: [],
      result: {
        sourceDir: "C:\\客户资料",
        rootName: "客户资料",
        fileCount: 2,
        maxDepth: 1,
        previewLimit: 50,
        outputPath: "C:\\客户资料List.xlsx",
        preview: [
          {
            name: "银行日记账.xlsx",
            relativePath: "底稿\\银行日记账.xlsx",
            fullPath: "C:\\客户资料\\底稿\\银行日记账.xlsx",
            levels: ["底稿"],
          },
        ],
        skippedPaths: ["C:\\客户资料\\历史归档"],
      },
    }));
    expect(document.querySelector(".job-progress")).toBeNull();
    expect(screen.getByText("2 个文件 · 最深 1 级子目录")).toBeVisible();
    // 「相对路径」列不再出现在屏上表格里
    expect(screen.queryByTitle("底稿\\银行日记账.xlsx")).toBeNull();
    expect(screen.queryByText("相对路径")).toBeNull();
    // 第 2 级文件夹整列为空：该列自动隐藏
    expect(screen.getByText("1级文件夹")).toBeVisible();
    expect(screen.queryByText("2级文件夹")).toBeNull();
    expect(screen.getByTitle("底稿")).toHaveTextContent("底稿");
    expect(screen.getByTitle("银行日记账.xlsx")).toHaveTextContent(
      "银行日记账.xlsx",
    );
  });

  it("导出完成后绿色成功横幅落在生成按钮之后，跳过路径不再顶琥珀部分完成", async () => {
    sessionStorage.clear();
    render(<FileListDirectoryPage tool={tool} />);
    const { pickPath } = await import("./api");
    vi.mocked(pickPath).mockResolvedValueOnce("C:\\客户资料");
    fireEvent.click(screen.getByRole("button", { name: "源文件夹 *" }));
    await waitFor(() => expect(jobStart).toHaveBeenCalledWith("file_list.scan", { sourceDir: "C:\\客户资料" }));
    const callback = vi.mocked(listenJobEvents).mock.calls.at(-1)?.[0];
    // 先给一份扫描结果，才能进入输出步骤
    act(() => callback?.({
      jobId: "job-scan",
      toolId: "file_list_directory",
      phase: "completed",
      current: 1,
      total: 1,
      message: "扫描完成",
      severity: "success",
      outputPaths: [],
      result: {
        sourceDir: "C:\\客户资料",
        rootName: "客户资料",
        fileCount: 1,
        maxDepth: 0,
        previewLimit: 50,
        outputPath: "C:\\客户资料List.xlsx",
        preview: [
          { name: "凭证.pdf", relativePath: "凭证.pdf", fullPath: "C:\\客户资料\\凭证.pdf", levels: [] },
        ],
      },
    }));
    fireEvent.click(await screen.findByRole("button", { name: "下一步：输出文件" }));
    vi.mocked(jobStart).mockResolvedValueOnce("export-job");
    fireEvent.click(screen.getByRole("button", { name: "生成文件清单" }));
    await waitFor(() => expect(jobStart).toHaveBeenCalledWith("file_list.export", expect.anything()));
    await act(async () => undefined);
    act(() => callback?.({
      jobId: "export-job", toolId: "file_list_directory", phase: "completed",
      current: 1, total: 1, message: "处理完成。", severity: "success",
      outputPaths: ["C:/客户资料List.xlsx"],
      result: { fileCount: 3, maxDepth: 0, skippedPaths: ["C:/客户资料/锁定"], outputPaths: ["C:/客户资料List.xlsx"] },
    }));
    // 成功横幅：绿色成功层 + 固定结论，引擎的「处理完成。」套话不再重复
    expect(screen.getByText("清单已生成")).toBeVisible();
    expect(screen.queryByText("处理完成。")).toBeNull();
    expect(screen.getByText(/1 个路径无法访问、已跳过/)).toBeVisible();
    // 任务条不再以「部分完成 100%」与成功结论同框
    expect(document.querySelector(".job-banner.warning")).toBeNull();
    // 结果文件入口仍在「扫描预览」卡内
    expect(screen.getByRole("button", { name: "打开结果：客户资料List.xlsx" })).toBeVisible();
  });
});
