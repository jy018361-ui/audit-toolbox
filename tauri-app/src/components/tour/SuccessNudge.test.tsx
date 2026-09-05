// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { SuccessNudge } from "./SuccessNudge";
import { saveTourState } from "./tourState";
import { openOutput } from "@/api";
import type { JobEvent } from "@/types";

vi.mock("@/api", () => ({
  openOutput: vi.fn().mockResolvedValue(undefined),
}));

function completedJob(overrides: Partial<JobEvent> = {}): JobEvent {
  return {
    jobId: "job-1",
    toolId: "fa_export",
    phase: "completed",
    current: 1,
    total: 1,
    message: "导出完成",
    severity: "success",
    outputPaths: ["C:\\输出\\底稿.xlsx"],
    ...overrides,
  };
}

const toolNameOf = (toolId: string) =>
  ({ fa_export: "凭证导出" })[toolId] ?? toolId;

/** 显示当前路由路径，用来断言「返回工作台」真的跳回了 "/"。 */
function LocationProbe() {
  const { pathname } = useLocation();
  return <p>当前路径：{pathname}</p>;
}

function renderWithRouter(ui: ReactElement, initialPath = "/tools/fa_export") {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <LocationProbe />
      {ui}
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  vi.clearAllMocks();
});

describe("SuccessNudge", () => {
  it("初始 jobs 为空不显示；出现 completed 任务后显示卡片和按钮", () => {
    const { rerender } = renderWithRouter(
      <SuccessNudge jobs={[]} toolNameOf={toolNameOf} />,
    );
    expect(screen.queryByText("凭证导出已完成")).not.toBeInTheDocument();

    rerender(
      <MemoryRouter initialEntries={["/tools/fa_export"]}>
        <LocationProbe />
        <SuccessNudge
          jobs={[completedJob()]}
          toolNameOf={toolNameOf}
        />
      </MemoryRouter>,
    );
    expect(screen.getByText("凭证导出已完成")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "打开结果" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "返回工作台" }),
    ).toBeInTheDocument();
  });

  it("点「打开结果」用第一个输出路径调用 openOutput", () => {
    const path = "C:\\输出\\底稿.xlsx";
    renderWithRouter(
      <SuccessNudge
        jobs={[completedJob({ outputPaths: [path, "C:\\输出\\附表.xlsx"] })]}
        toolNameOf={toolNameOf}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "打开结果" }));
    expect(openOutput).toHaveBeenCalledTimes(1);
    expect(openOutput).toHaveBeenCalledWith(path);
  });

  it("同一任务重复推送 completed 事件不重复触发", () => {
    const { rerender } = renderWithRouter(
      <SuccessNudge jobs={[completedJob()]} toolNameOf={toolNameOf} />,
    );
    expect(screen.getAllByText("凭证导出已完成")).toHaveLength(1);
    // 事件流里同一 jobId 的事件会整体覆盖（Record 按 key 存），再喂一遍仍只有一张卡。
    rerender(
      <MemoryRouter initialEntries={["/tools/fa_export"]}>
        <LocationProbe />
        <SuccessNudge jobs={[completedJob()]} toolNameOf={toolNameOf} />
      </MemoryRouter>,
    );
    expect(screen.getAllByText("凭证导出已完成")).toHaveLength(1);
  });

  it("两个任务接连完成时显示最新的一个，不排队", () => {
    const { rerender } = renderWithRouter(
      <SuccessNudge jobs={[completedJob()]} toolNameOf={toolNameOf} />,
    );
    rerender(
      <MemoryRouter initialEntries={["/tools/fa_export"]}>
        <LocationProbe />
        <SuccessNudge
          jobs={[
            completedJob(),
            completedJob({ jobId: "job-2", toolId: "wp_merge" }),
          ]}
          toolNameOf={toolNameOf}
        />
      </MemoryRouter>,
    );
    expect(screen.queryByText("凭证导出已完成")).not.toBeInTheDocument();
    expect(screen.getByText("wp_merge已完成")).toBeInTheDocument();
  });

  it("新手模式总开关关闭时不显示", () => {
    saveTourState({ newbieMode: false });
    renderWithRouter(
      <SuccessNudge jobs={[completedJob()]} toolNameOf={toolNameOf} />,
    );
    expect(screen.queryByText("凭证导出已完成")).not.toBeInTheDocument();
  });

  it("没有输出路径时不提供「打开结果」按钮", () => {
    renderWithRouter(
      <SuccessNudge
        jobs={[completedJob({ outputPaths: [] })]}
        toolNameOf={toolNameOf}
      />,
    );
    expect(
      screen.queryByRole("button", { name: "打开结果" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "返回工作台" }),
    ).toBeInTheDocument();
  });

  it("点「返回工作台」跳回工作台路由 /", () => {
    renderWithRouter(
      <SuccessNudge jobs={[completedJob()]} toolNameOf={toolNameOf} />,
    );
    expect(screen.getByText("当前路径：/tools/fa_export")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "返回工作台" }));
    expect(screen.getByText("当前路径：/")).toBeInTheDocument();
  });

  it("右上角 × 可手动关闭", () => {
    renderWithRouter(
      <SuccessNudge jobs={[completedJob()]} toolNameOf={toolNameOf} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "关闭完成提示" }));
    expect(screen.queryByText("凭证导出已完成")).not.toBeInTheDocument();
  });

  it("超时自动消失", async () => {
    renderWithRouter(
      <SuccessNudge
        jobs={[completedJob()]}
        toolNameOf={toolNameOf}
        autoDismissMs={30}
      />,
    );
    expect(screen.getByText("凭证导出已完成")).toBeInTheDocument();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 80));
    });
    expect(screen.queryByText("凭证导出已完成")).not.toBeInTheDocument();
  });
});
