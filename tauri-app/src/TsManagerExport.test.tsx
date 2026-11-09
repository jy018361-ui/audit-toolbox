// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { jobStart, listenJobEvents, pickPath } from "./api";
import { TsManagerParityPage } from "./TsManagerParityPage";
import type { JobEvent, ToolManifest } from "./types";

vi.mock("./api", () => ({
  engineCall: vi.fn(), jobCancel: vi.fn(), openOutput: vi.fn(),
  jobStart: vi.fn(), pickPath: vi.fn(), listenJobEvents: vi.fn(),
}));
vi.mock("./restore", () => ({ useTaskRestore: vi.fn() }));

const tool: ToolManifest = {
  id: "ts_manager", name: "工时透视", description: "", route: "/tools/ts_manager",
  version: "1.0", capabilities: [], migrationStatus: "ready",
};

beforeEach(() => { vi.resetAllMocks(); });
afterEach(cleanup);

async function openExport() {
  let receive!: (event: JobEvent) => void;
  vi.mocked(listenJobEvents).mockImplementation(async (handler) => {
    receive = handler;
    return () => {};
  });
  vi.mocked(jobStart).mockResolvedValue("inspect-1");
  vi.mocked(pickPath).mockResolvedValueOnce("C:/data/ts.xlsx");
  render(<TsManagerParityPage tool={tool} />);
  const clear = screen.queryByRole("button", { name: "清空" });
  if (clear) fireEvent.click(clear);
  expect(screen.getByRole("button", { name: "3 导出" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "目标文件 *" }));
  await waitFor(() => expect(jobStart).toHaveBeenCalledWith("ts.inspect", expect.anything()));
  await act(async () => receive({
    jobId: "inspect-1", toolId: "ts_manager", phase: "completed", current: 1,
    total: 1, message: "完成", severity: "success", outputPaths: [],
    result: {
      headers: ["Hours"], sheets: ["Data"], selectedSheet: "Data",
      preview: [["2"]], dimensions: { rows: 1, columns: 1 }, defaults: {},
    },
  }));
  fireEvent.click(screen.getByRole("button", { name: "3 导出" }));
  vi.mocked(jobStart).mockClear();
  vi.mocked(pickPath).mockClear();
  return screen.getByRole("button", { name: "导出默认双 Sheet" });
}

describe("TS 点击导出后选择保存位置", () => {
  it("enables export without a path and waits for the save dialog before starting", async () => {
    const button = await openExport();
    expect(button).toBeEnabled();
    let finish!: (path: string) => void;
    vi.mocked(pickPath).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    vi.mocked(jobStart).mockResolvedValue("export-1");
    fireEvent.click(button);
    expect(pickPath).toHaveBeenCalledWith("save", "另存为工时报告（by经理 + by项目）", ["xlsx"], expect.stringMatching(/^工时报告_\d{8}_\d{6}\.xlsx$/));
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(pickPath).toHaveBeenCalledTimes(1);
    expect(jobStart).not.toHaveBeenCalled();
    await act(async () => finish("C:/data/result.xlsx"));
    expect(jobStart).toHaveBeenCalledTimes(1);
    expect(jobStart).toHaveBeenCalledWith("ts.export", expect.objectContaining({
      inputPath: "C:/data/ts.xlsx", outputPath: "C:/data/result.xlsx", pivotMode: "dual_default",
    }));
  });

  it("does not start an export or report an error when the save dialog is cancelled", async () => {
    const button = await openExport();
    vi.mocked(pickPath).mockResolvedValue(null);
    fireEvent.click(button);
    await waitFor(() => expect(button).toBeEnabled());
    expect(jobStart).not.toHaveBeenCalled();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("shows save-dialog errors and allows retrying", async () => {
    const button = await openExport();
    vi.mocked(pickPath).mockRejectedValue(new Error("保存对话框打开失败"));
    fireEvent.click(button);
    await screen.findByText("保存对话框打开失败");
    expect(button).toBeEnabled();
    expect(jobStart).not.toHaveBeenCalled();
  });

  it("uses a path selected beforehand without opening another dialog", async () => {
    const button = await openExport();
    vi.mocked(pickPath).mockResolvedValue("C:/data/preselected.xlsx");
    fireEvent.click(screen.getByRole("button", { name: "选择" }));
    await screen.findByDisplayValue("preselected.xlsx");
    vi.mocked(pickPath).mockClear();
    vi.mocked(jobStart).mockResolvedValue("export-1");
    fireEvent.click(button);
    await waitFor(() => expect(jobStart).toHaveBeenCalledWith("ts.export", expect.objectContaining({
      outputPath: "C:/data/preselected.xlsx", pivotMode: "dual_default",
    })));
    expect(pickPath).not.toHaveBeenCalled();
  });
});
