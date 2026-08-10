// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import FileListDirectoryPage from "./FileListDirectoryPage";
import type { ToolManifest } from "./types";

vi.mock("./api", () => ({
  jobCancel: vi.fn(),
  jobStart: vi.fn(),
  listenJobEvents: vi.fn().mockResolvedValue(() => undefined),
  openOutput: vi.fn(),
  pickPath: vi.fn().mockResolvedValue(null),
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

  afterEach(() => sessionStorage.clear());

  it("uses two steps and generates directly from the output step", async () => {
    const { container } = render(<FileListDirectoryPage tool={tool} />);
    const steps = container.querySelector(".step-indicator");
    expect(steps).not.toBeNull();
    expect(within(steps as HTMLElement).getAllByRole("button")).toHaveLength(2);

    const next = await screen.findByRole("button", { name: "下一步：输出文件" });
    await waitFor(() => expect(next).toBeEnabled());
    fireEvent.click(next);

    expect(screen.getByText("2. 确认输出并生成")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "生成文件清单" })).toBeEnabled();
    expect(screen.queryByText("3. 生成文件清单")).not.toBeInTheDocument();
  });
});
