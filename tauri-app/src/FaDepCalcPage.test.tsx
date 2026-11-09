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
import { afterEach, expect, it, vi } from "vitest";
import { FaDepCalcPage } from "./FaDepCalcPage";
import { engineCall, jobStart, pickPath, listenJobEvents } from "./api";
import { DEP_MAPPING_ROLES } from "./faSubtoolsUi";
import type { ToolManifest } from "./types";

vi.mock("./api", () => ({
  engineCall: vi.fn(),
  pickPath: vi.fn(),
  jobStart: vi.fn().mockResolvedValue("dep-job"),
  jobCancel: vi.fn(),
  openOutput: vi.fn(),
  listenJobEvents: vi.fn().mockResolvedValue(() => {}),
  listenPositionedFileDrops: vi.fn().mockResolvedValue(() => {}),
}));

afterEach(cleanup);

const depTool: ToolManifest = {
  id: "fa_dep_calc", name: "折旧测算", route: "/tools/fa_dep_calc",
  description: "", version: "test", capabilities: [], migrationStatus: "ready",
};

function mockReview(review: Record<string, unknown>) {
  const mapping = Object.fromEntries(DEP_MAPPING_ROLES.map(([key, label]) => [key, label]));
  mapping.depreciation = "期初累计折旧";
  vi.mocked(engineCall).mockImplementation(async (method) => {
    if (method === "fa.dep_inspect") return {
      headers: [...DEP_MAPPING_ROLES.map(([, label]) => label), "期初累计折旧", "当月折旧"],
      preview: [["机器", "设备", "269327.01", "60598.58", "2020-01-01", "120", "0.05", "24239.43", "36359.15", "2019.95"]],
      sheets: ["2512"], selectedSheet: "2512", suggestedMapping: mapping,
    };
    return review;
  });
  vi.mocked(pickPath).mockResolvedValue("C:/test/assets.xlsx");
}

function clearSource() {
  fireEvent.click(screen.getByRole("button", { name: /1 导入清单/ }));
  fireEvent.click(screen.getByText("清空"));
}

it("uses the shared horizontal steps, gates export, preserves mappings and resets on clear", async () => {
  const mapping = Object.fromEntries(
    DEP_MAPPING_ROLES.map(([key, label]) => [key, label]),
  );
  delete mapping.currentYearDep;
  vi.mocked(engineCall).mockImplementation(async (method) => {
    if (method === "fa.dep_inspect")
      return {
        headers: DEP_MAPPING_ROLES.map(([, label]) => label),
        preview: [
          ["机器", "设备", "100", "10", "2025-01-01", "10", "0.05", "9"],
        ],
        sheets: ["清单"],
        selectedSheet: "清单",
        suggestedMapping: mapping,
      };
    return {
      enabled: false,
      passed: true,
      message: "",
      autoApplied: [],
      fieldReviews: [],
    };
  });
  vi.mocked(pickPath).mockResolvedValue("C:/test/assets.xlsx");
  const tool: ToolManifest = {
    id: "fa_dep_calc",
    name: "折旧测算",
    route: "/tools/fa_dep_calc",
    description: "",
    version: "test",
    capabilities: [],
    migrationStatus: "ready",
  };
  const { container } = render(<FaDepCalcPage tool={tool} />);
  const nav = container.querySelector(".step-indicator")!;
  expect(nav.previousElementSibling).toHaveClass("page-header");
  expect(container.querySelector(".dep-source-card")).toHaveAttribute(
    "data-ui-state",
    "empty",
  );
  expect(nav.querySelectorAll("button")).toHaveLength(3);
  expect(screen.getByRole("button", { name: "2 核对映射" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "3 生成底稿" })).toBeDisabled();
  expect(container.querySelector(".dep-section-kicker")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: /期末清单/ }));
  await waitFor(() => expect(screen.getByText("核对字段映射")).toBeVisible());
  expect(screen.queryByText("导入期末固定资产清单")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "3 生成底稿" })).toBeDisabled();
  const selects = container.querySelectorAll<HTMLSelectElement>(
    ".dt-header-control select",
  );
  fireEvent.change(selects[7], { target: { value: "currentYearDep" } });
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "3 生成底稿" })).toBeEnabled(),
  );
  fireEvent.click(screen.getByRole("button", { name: "3 生成底稿" }));
  expect(screen.getByText("设置并生成折旧底稿")).toBeVisible();
  expect(screen.queryByText("核对字段映射")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "返回核对映射" }));
  expect(
    container.querySelectorAll<HTMLSelectElement>(
      ".dt-header-control select",
    )[7],
  ).toHaveValue("currentYearDep");
  fireEvent.click(screen.getByRole("button", { name: "下一步：生成底稿" }));
  const dateInput = screen.getByLabelText("资产负债表日");
  fireEvent.change(dateInput, { target: { value: "20212315" } });
  expect(screen.getByText("请输入有效日期，例如 2025-12-31。")).toBeVisible();
  expect(
    screen.getByRole("button", { name: "生成折旧测算表" }),
  ).toBeDisabled();
  fireEvent.change(dateInput, { target: { value: "20251231" } });
  expect(
    screen.getByRole("button", { name: "生成折旧测算表" }),
  ).toBeEnabled();
  fireEvent.click(screen.getByRole("button", { name: "生成折旧测算表" }));
  await waitFor(() =>
    expect(jobStart).toHaveBeenCalledWith(
      "fa.dep_export",
      expect.objectContaining({
        mapping: expect.objectContaining({ currentYearDep: "本年折旧" }),
      }),
    ),
  );
  await act(async () => {
    vi.mocked(listenJobEvents).mock.calls[0][0]({
      toolId: "fa_dep_calc",
      jobId: "dep-job",
      phase: "completed",
      current: 1,
      total: 1,
      severity: "success",
      message: "完成",
      outputPaths: ["C:/test/output.xlsx"],
    });
  });
  fireEvent.click(screen.getByRole("button", { name: /导入清单/ }));
  fireEvent.click(screen.getByText("清空"));
  expect(screen.getByRole("button", { name: "1 导入清单" })).toHaveClass(
    "active",
  );
  expect(screen.getByRole("button", { name: "2 核对映射" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "3 生成底稿" })).toBeDisabled();
  expect(container.querySelector(".dep-section-kicker")).toBeNull();
});

it("LLM 变更同步下拉和导出，撤销恢复来源，手工修改后不再声称已生效", async () => {
  vi.mocked(jobStart).mockClear();
  mockReview({ enabled: true, passed: false, message: "折旧测算 LLM 复核完成。",
    autoApplied: [], fieldReviews: [{ role: "depreciation", file_side: "file2",
      suggested_column: "累计折旧", action: "replace", confidence: 0.9 }] });
  render(<FaDepCalcPage tool={depTool} />);
  fireEvent.click(screen.getByRole("button", { name: /期末清单/ }));
  await screen.findByText("已生效");
  expect(screen.getByRole("combobox", { name: "将「累计折旧」映射为字段" })).toHaveValue("depreciation");
  expect(screen.getByRole("combobox", { name: "将「期初累计折旧」映射为字段" })).toHaveValue("");
  expect(screen.getByText("已更新表头下拉框对应的来源列，下方原始列名保持不变。")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "下一步：生成底稿" }));
  fireEvent.click(screen.getByRole("button", { name: "生成折旧测算表" }));
  await waitFor(() => expect(jobStart).toHaveBeenCalledWith("fa.dep_export", expect.objectContaining({
    mapping: expect.objectContaining({ depreciation: "累计折旧" }),
  })));
  // 挂载期间的事件监听器取本次注册的实例。
  await act(async () => {
    vi.mocked(listenJobEvents).mock.calls.at(-1)![0]({
      toolId: "fa_dep_calc", jobId: "dep-job", phase: "completed", current: 1,
      total: 1, severity: "success", message: "完成", outputPaths: [],
    });
  });
  fireEvent.click(screen.getByRole("button", { name: "返回核对映射" }));
  fireEvent.click(screen.getByRole("button", { name: "撤销" }));
  expect(screen.getByRole("combobox", { name: "将「期初累计折旧」映射为字段" })).toHaveValue("depreciation");
  expect(screen.getByRole("combobox", { name: "将「累计折旧」映射为字段" })).toHaveValue("");
  // 再次复核后，人工改回来源列应使该项自动变更记录失效。
  fireEvent.click(screen.getByRole("button", { name: /1 导入清单/ }));
  fireEvent.click(screen.getByRole("button", { name: "重新复核映射" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "重新复核映射" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: /2 核对映射/ }));
  expect(screen.getByText("已生效")).toBeVisible();
  fireEvent.change(screen.getByRole("combobox", { name: "将「期初累计折旧」映射为字段" }), { target: { value: "depreciation" } });
  expect(screen.queryByText("已生效")).not.toBeInTheDocument();
  clearSource();
});

it("被后端拦截的当月折旧建议不改下拉，保留口径冲突说明", async () => {
  mockReview({ enabled: true, passed: false,
    message: "LLM 复核完成：已忽略折旧口径冲突的建议，累计折旧仍按原映射取数；请核对累计余额列。",
    autoApplied: [], fieldReviews: [{ role: "depreciation", action: "review", confidence: 0,
      rejectedByDepreciationScope: true }] });
  render(<FaDepCalcPage tool={depTool} />);
  fireEvent.click(screen.getByRole("button", { name: /期末清单/ }));
  expect(await screen.findByText(/已忽略折旧口径冲突的建议/)).toBeVisible();
  expect(screen.getByRole("combobox", { name: "将「期初累计折旧」映射为字段" })).toHaveValue("depreciation");
  expect(screen.getByRole("combobox", { name: "将「当月折旧」映射为字段" })).toHaveValue("");
  expect(screen.queryByText("已生效")).not.toBeInTheDocument();
  expect(screen.queryByText(/与 LLM 判断一致/)).not.toBeInTheDocument();
  clearSource();
});
