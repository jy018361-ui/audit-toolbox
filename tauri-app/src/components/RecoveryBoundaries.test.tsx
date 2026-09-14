// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ApplicationErrorBoundary } from "./ApplicationErrorBoundary";
import { ToolRecoveryBoundary } from "./ToolRecoveryBoundary";
import {
  consumeTaskRestore,
  publishTaskRestore,
  subscribeTaskRestoreFailure,
  useTaskRestore,
} from "../restore";

const consoleError = vi
  .spyOn(console, "error")
  .mockImplementation(() => undefined);

afterEach(() => {
  cleanup();
  consumeTaskRestore("generic_tool");
  consoleError.mockClear();
});

function restore() {
  return {
    jobId: "history-1",
    toolId: "generic_tool",
    method: "generic.run",
    params: { inputPath: "C:\\sample.xlsx" },
    missingPaths: [],
    authorizedPathCount: 1,
  };
}

it("隔离任意工具页异常，保留应用外壳并允许重新打开", () => {
  let shouldThrow = true;
  function ToolPage() {
    if (shouldThrow) throw new Error("旧参数触发渲染异常");
    return <p>工具已重新打开</p>;
  }
  render(
    <div>
      <nav>应用导航仍在</nav>
      <ToolRecoveryBoundary
        toolId="generic_tool"
        toolName="示例工具"
        onBackToHistory={vi.fn()}
      >
        <ToolPage />
      </ToolRecoveryBoundary>
    </div>,
  );

  expect(screen.getByText("应用导航仍在")).toBeVisible();
  expect(
    screen.getByRole("heading", { name: "“示例工具”未能恢复" }),
  ).toBeVisible();
  shouldThrow = false;
  fireEvent.click(screen.getByRole("button", { name: "清空本页并重新打开" }));
  expect(screen.getByText("工具已重新打开")).toBeVisible();
});

it("恢复回调失败时通知全局提示，且不会从发布函数向外抛错", async () => {
  const failures: string[] = [];
  const stop = subscribeTaskRestoreFailure((failure) =>
    failures.push(failure.message),
  );
  function RejectingTool() {
    useTaskRestore("generic_tool", async () => {
      throw new Error("存档字段不兼容");
    });
    return <p>应用仍可使用</p>;
  }
  render(<RejectingTool />);

  expect(() => publishTaskRestore(restore())).not.toThrow();
  await waitFor(() => expect(failures).toContain("存档字段不兼容"));
  expect(screen.getByText("应用仍可使用")).toBeVisible();
  stop();
});

it("最外层异常显示恢复操作，不留下白屏", () => {
  function BrokenApp(): null {
    throw new Error("外壳异常");
  }
  render(
    <ApplicationErrorBoundary>
      <BrokenApp />
    </ApplicationErrorBoundary>,
  );
  expect(
    screen.getByRole("heading", { name: "页面加载失败，但应用没有丢失" }),
  ).toBeVisible();
  expect(screen.getByRole("button", { name: "重新加载应用" })).toBeVisible();
});
