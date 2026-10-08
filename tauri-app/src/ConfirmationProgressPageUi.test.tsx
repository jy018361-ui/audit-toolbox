// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import ConfirmationProgressPage from "./ConfirmationProgressPage";
import { engineCall, pickPath, jobStart, listenJobEvents } from "./api";
import type { ToolManifest, JobEvent } from "./types";
vi.mock("./api", () => ({
  engineCall: vi.fn(),
  jobCancel: vi.fn(),
  jobStart: vi.fn(),
  openOutput: vi.fn(),
  pickPath: vi.fn(),
  listenJobEvents: vi.fn(async () => () => undefined),
  listenPositionedFileDrops: vi.fn(async () => () => undefined),
}));
beforeEach(() => {
  sessionStorage.clear();
  vi.mocked(engineCall).mockReset();
  vi.mocked(pickPath).mockReset();
});
afterEach(cleanup);
const tool: ToolManifest = {
  id: "confirmation_progress",
  name: "函证进度",
  description: "",
  route: "/tools/confirmation_progress",
  version: "test",
  capabilities: [],
  migrationStatus: "ready",
};
const inspection = {
  path: "C:\\演示数据\\样例文件.xlsx",
  headers: ["项目名称", "询证项回函结果"],
  preview: [["华东集团", "信息相符"]],
  dimensions: { rows: 1, columns: 2 },
  missingColumns: [],
  requiredColumnsPresent: ["项目名称"],
  statistics: {
    total: 1,
    bank: 1,
    trade: 0,
    projects: 1,
    units: 1,
    baseDates: ["2025-12-31"],
  },
  outputDirectory: "C:\\演示数据",
  willGenerate: { bank: true, trade: true },
};

it("检查前显示真实准备状态和资料要求", () => {
  render(<ConfirmationProgressPage tool={tool} />);
  expect(screen.getByText("待检查数据")).toBeVisible();
  expect(screen.queryByText("已就绪")).not.toBeInTheDocument();
  expect(screen.getByRole("region", { name: "准备函证清单" })).toBeVisible();
  expect(screen.getByRole("button", { name: "检查数据" })).toBeDisabled();
});

/* UI 审计 P2-8：检查动作必须由「检查数据」按钮显式承担——选中文件后
   该按钮立即启用，点击即执行既有检查；「下一步」只负责前进，不连带
   触发检查。 */
it("选择文件后启用「检查数据」，点击执行检查而不是等下一步连带触发", async () => {
  vi.mocked(pickPath).mockResolvedValue("C:\\演示数据\\样例文件.xlsx");
  vi.mocked(engineCall).mockResolvedValue(inspection);
  render(<ConfirmationProgressPage tool={tool} />);
  expect(
    screen.getByRole("button", { name: "下一步：报告范围" }),
  ).toBeDisabled();
  // 拖放按钮嵌在 Field 的 label 里，可访问名计算为空，按文本定位其按钮。
  fireEvent.click(
    screen
      .getByText("拖放或点击选择 Excel 函证清单")
      .closest("button") as HTMLButtonElement,
  );
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "检查数据" })).toBeEnabled(),
  );
  // 已选文件、尚未检查：下一步仍然不放行，检查只能由「检查数据」发起。
  expect(
    screen.getByRole("button", { name: "下一步：报告范围" }),
  ).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "检查数据" }));
  await waitFor(() =>
    expect(engineCall).toHaveBeenCalledWith("confirmation.inspect", {
      inputPath: "C:\\演示数据\\样例文件.xlsx",
      mode: "both",
    }),
  );
  expect(await screen.findByText("字段检查通过")).toBeVisible();
  expect(
    screen.getByRole("button", { name: "下一步：报告范围" }),
  ).toBeEnabled();
});

it("取消报告任务显示取消状态而不渲染失败错误框", async () => {
  let receive: ((event: JobEvent) => void) | undefined;
  vi.mocked(listenJobEvents).mockImplementation(async (callback) => {
    receive = callback;
    return () => undefined;
  });
  vi.mocked(jobStart).mockResolvedValue("confirmation-cancel-test");
  vi.mocked(pickPath).mockResolvedValue(inspection.path);
  vi.mocked(engineCall).mockResolvedValue(inspection);
  const { container } = render(<ConfirmationProgressPage tool={tool} />);
  fireEvent.click(screen.getByText("拖放或点击选择 Excel 函证清单").closest("button") as HTMLButtonElement);
  await waitFor(() => expect(screen.getByRole("button", { name: "检查数据" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "检查数据" }));
  await screen.findByText("字段检查通过");
  fireEvent.click(screen.getByRole("button", { name: "3 生成报告" }));
  fireEvent.click(screen.getByRole("button", { name: "生成进度报告" }));
  await waitFor(() => expect(jobStart).toHaveBeenCalled());
  await act(async () => receive?.({
    jobId: "confirmation-cancel-test", toolId: tool.id,
    phase: "cancelled", current: 1, total: 2,
    message: "已取消报告生成，可调整资料后重试。", severity: "warning", outputPaths: [],
  }));
  expect(container.querySelector('[data-job-state="cancelled"]')).toBeInTheDocument();
  expect(container.querySelector('.error-box')).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "生成进度报告" })).toBeEnabled();
});
