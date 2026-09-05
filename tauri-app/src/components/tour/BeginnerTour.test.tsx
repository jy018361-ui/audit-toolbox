// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { BeginnerTour } from "./BeginnerTour";
import type { TourStep } from "./BeginnerTour";
import { buildToolTourSteps } from "./tourSteps";
import { loadTourState, saveTourState } from "./tourState";
import type { ToolManifest } from "../../types";

const baseSteps: TourStep[] = [
  { id: "welcome", title: "欢迎步骤", body: "欢迎语" },
  {
    id: "target",
    title: "目标步骤",
    body: "指到这里",
    targetSelector: '[data-tour="demo"]',
  },
  { id: "done", title: "收尾步骤", body: "结束了" },
];

// jsdom 没有真实布局：data-tour 挂点元素返回固定矩形，其余返回 0 尺寸。
beforeEach(() => {
  window.localStorage.clear();
  // 通用目标挂点：大多数用例的目标步骤指向它。
  const demo = document.createElement("div");
  demo.setAttribute("data-tour", "demo");
  document.body.appendChild(demo);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      if (this.hasAttribute("data-tour")) {
        return {
          top: 120,
          left: 80,
          right: 320,
          bottom: 168,
          width: 240,
          height: 48,
          x: 80,
          y: 120,
          toJSON: () => ({}),
        } as DOMRect;
      }
      return {
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        width: 0,
        height: 0,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      } as DOMRect;
    },
  );
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  document
    .querySelectorAll('[data-tour="demo"], [data-tour="late"]')
    .forEach((el) => el.remove());
});

describe("BeginnerTour", () => {
  it("首步渲染居中欢迎卡，带步骤计数，首步没有上一步", () => {
    render(<BeginnerTour steps={baseSteps} onFinish={vi.fn()} />);
    expect(
      screen.getByRole("dialog", { name: "新手引导：欢迎步骤" }),
    ).toBeInTheDocument();
    expect(screen.getByText("第 1 步 · 共 3 步")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "下一步" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "上一步" }),
    ).not.toBeInTheDocument();
  });

  it("下一步切到目标步骤时出现聚光灯与气泡", () => {
    render(<BeginnerTour steps={baseSteps} onFinish={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "下一步" }));
    expect(screen.getByText("目标步骤")).toBeInTheDocument();
    expect(document.querySelector(".tour-bubble")).not.toBeNull();
    expect(document.querySelector(".tour-spotlight")).not.toBeNull();
    expect(
      screen.getByRole("button", { name: "上一步" }),
    ).toBeInTheDocument();
  });

  it("走到最后一步显示「完成」，点击后以 completed=true 结束", () => {
    const onFinish = vi.fn();
    render(<BeginnerTour steps={baseSteps} onFinish={onFinish} />);
    fireEvent.click(screen.getByRole("button", { name: "下一步" }));
    fireEvent.click(screen.getByRole("button", { name: "下一步" }));
    fireEvent.click(screen.getByRole("button", { name: "完成" }));
    expect(onFinish).toHaveBeenCalledWith(true);
  });

  it("「跳过引导」和 Esc 都以 completed=false 结束", () => {
    const onFinishSkip = vi.fn();
    render(<BeginnerTour steps={baseSteps} onFinish={onFinishSkip} />);
    fireEvent.click(screen.getByRole("button", { name: "跳过引导" }));
    expect(onFinishSkip).toHaveBeenCalledWith(false);

    const onFinishEsc = vi.fn();
    const { unmount } = render(
      <BeginnerTour steps={baseSteps} onFinish={onFinishEsc} />,
    );
    fireEvent.keyDown(window, { key: "Escape" });
    unmount();
    expect(onFinishEsc).toHaveBeenCalledWith(false);
  });

  it("方向键可以翻步", () => {
    render(<BeginnerTour steps={baseSteps} onFinish={vi.fn()} />);
    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(screen.getByText("目标步骤")).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "ArrowLeft" });
    expect(screen.getByText("欢迎步骤")).toBeInTheDocument();
  });

  it("optional 步骤目标缺失时自动跳过", () => {
    const steps: TourStep[] = [
      {
        id: "ghost",
        title: "看不见的步骤",
        body: "x",
        targetSelector: '[data-tour="nope"]',
        optional: true,
      },
      { id: "done", title: "直达收尾", body: "x" },
    ];
    render(<BeginnerTour steps={steps} onFinish={vi.fn()} />);
    expect(screen.getByText("直达收尾")).toBeInTheDocument();
    expect(screen.getByText("第 2 步 · 共 2 步")).toBeInTheDocument();
  });

  it("非 optional 步骤目标缺失时退化为居中卡片而不是报错", async () => {
    const steps: TourStep[] = [
      {
        id: "missing",
        title: "退化的步骤",
        body: "x",
        targetSelector: '[data-tour="nope"]',
      },
    ];
    render(
      <BeginnerTour
        steps={steps}
        onFinish={vi.fn()}
        retryIntervalMs={10}
        retryLimit={2}
      />,
    );
    // 定位期间气泡隐藏待命；确认目标不存在后退化为居中卡片。
    expect(screen.getByText("退化的步骤")).toBeInTheDocument();
    await waitFor(() =>
      expect(document.querySelector(".tour-card")).not.toBeNull(),
    );
    expect(document.querySelector(".tour-bubble")).toBeNull();
  });

  it("目标元素延迟挂载时轮询等待并自动定位", async () => {
    const steps: TourStep[] = [
      {
        id: "late",
        title: "晚到的步骤",
        body: "x",
        targetSelector: '[data-tour="late"]',
      },
    ];
    render(<BeginnerTour steps={steps} onFinish={vi.fn()} />);
    // 初始找不到目标：气泡已挂载但隐藏，不闪现居中卡片。
    const bubble = document.querySelector(".tour-bubble");
    expect(bubble).not.toBeNull();
    expect((bubble as HTMLElement).style.visibility).toBe("hidden");
    await act(async () => {
      const el = document.createElement("div");
      el.setAttribute("data-tour", "late");
      document.body.appendChild(el);
      await new Promise((resolve) => setTimeout(resolve, 200));
    });
    expect((document.querySelector(".tour-bubble") as HTMLElement).style.visibility).toBe("visible");
    expect(document.querySelector(".tour-spotlight")).not.toBeNull();
  });
});

describe("tourState", () => {
  it("保存后读取往返一致", () => {
    saveTourState({
      workspaceDone: true,
      toolDone: { fa_list: true },
      autoToolTours: false,
    });
    expect(loadTourState()).toEqual({
      workspaceDone: true,
      toolDone: { fa_list: true },
      autoToolTours: false,
    });
  });

  it("损坏的存储内容按空状态处理", () => {
    window.localStorage.setItem("audit-toolbox.newbie-tour", "{broken json");
    expect(loadTourState()).toEqual({});
    window.localStorage.setItem("audit-toolbox.newbie-tour", "[]");
    expect(loadTourState()).toEqual({});
  });
});

describe("buildToolTourSteps", () => {
  const tool: ToolManifest = {
    id: "kanzhang",
    name: "看账工具",
    description: "凭证导入、科目筛选、透视与导出",
    route: "/tools/kanzhang",
    version: "2.0",
    capabilities: ["inspect"],
    migrationStatus: "ready",
  };

  it("欢迎步骤带工具名称与描述", () => {
    const steps = buildToolTourSteps(tool);
    expect(steps[0].title).toBe("初识「看账工具」");
    expect(steps[0].body).toContain("凭证导入、科目筛选、透视与导出");
    expect(steps[0].targetSelector).toBeUndefined();
  });

  it("页头步骤必播，步骤条步骤允许缺失跳过", () => {
    const steps = buildToolTourSteps(tool);
    const header = steps.find(
      (step) => step.targetSelector === '[data-tour="page-header"]',
    );
    const indicator = steps.find(
      (step) => step.targetSelector === '[data-tour="step-indicator"]',
    );
    expect(header).toBeDefined();
    expect(header?.optional).toBeFalsy();
    expect(indicator?.optional).toBe(true);
  });
});
