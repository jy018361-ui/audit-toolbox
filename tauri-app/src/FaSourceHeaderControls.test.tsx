// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { FaListPage } from "./FaListPage";
import { engineCall, jobStart, pickPath } from "./api";
import { handlers } from "./preview/demo/fa";
import type { ToolManifest } from "./types";

vi.mock("./api", () => ({
  engineCall: vi.fn(), jobStart: vi.fn(async () => "fa-header-job"), jobCancel: vi.fn(),
  pickPath: vi.fn(), openOutput: vi.fn(),
  listenJobEvents: vi.fn(async () => () => {}),
  listenPositionedFileDrops: vi.fn(async () => () => {}),
}));
vi.mock("./restore", () => ({ useTaskRestore: vi.fn() }));
afterEach(cleanup);

it("FA 两期清单在文件名同一标题栏中调整层数，读表与匹配沿用两侧独立参数", async () => {
  vi.mocked(pickPath)
    .mockResolvedValueOnce("C:/data/科技FA存量清单-202412.xlsx")
    .mockResolvedValueOnce("C:/data/2025年12月FA资产清单.xlsx");
  vi.mocked(engineCall).mockImplementation(async (method, params) => {
    if (method === "fa.review") return { enabled: false, passed: true, autoApplied: [], fieldReviews: [] } as never;
    return (handlers[method]?.((params ?? {}) as Record<string, unknown>) ?? {}) as never;
  });
  const tool: ToolManifest = { id: "fa_list", name: "FA List 匹配工具", route: "/tools/fa_list", version: "test", description: "", capabilities: [], migrationStatus: "ready" };
  render(<MemoryRouter><FaListPage tool={tool} /></MemoryRouter>);
  fireEvent.click(screen.getByRole("tab", { name: "两期固定资产清单" }));
  fireEvent.click(screen.getByText("拖放或点击选择年初清单"));
  await screen.findByText("科技FA存量清单-202412.xlsx");
  fireEvent.click(screen.getByText("拖放或点击选择年末清单"));
  const depthInputs = await screen.findAllByLabelText("表头层数");
  expect(depthInputs).toHaveLength(2);
  const beginHeader = depthInputs[0].closest(".preview-source-head")!;
  expect(within(beginHeader as HTMLElement).getByText(/期初文件预览.*科技FA存量清单/)).toBeVisible();
  fireEvent.change(depthInputs[0], { target: { value: "2" } });
  await waitFor(() => expect(engineCall).toHaveBeenCalledWith("fa.inspect", expect.objectContaining({ beginHeaderDepth: 2, endHeaderDepth: 1 }), expect.any(String)));
  await waitFor(() => expect(screen.getAllByLabelText("表头层数")[0]).toHaveValue("2"));
  expect(screen.getAllByLabelText("表头层数")[1]).toHaveValue("1");
  // 两步式：第 1 步以「下一步」进入匹配与导出，「开始匹配」在第 2 步。
  fireEvent.click(screen.getByRole("button", { name: /^下一步$/ }));
  fireEvent.click(await screen.findByRole("button", { name: /^开始匹配$/ }));
  await waitFor(() => expect(jobStart).toHaveBeenCalledWith("fa.match", expect.objectContaining({ beginHeaderDepth: 2, endHeaderDepth: 1 })));
});
