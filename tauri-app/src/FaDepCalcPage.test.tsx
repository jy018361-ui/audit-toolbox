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
