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
import { TOOL_TOUR_SCRIPTS } from "./toolTourContent";
import { loadTourState, saveTourState } from "./tourState";
import type { ToolManifest } from "../../types";
import toolCatalogJson from "../../../public/tool-catalog.json";

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
    // 居中卡片步骤没有挖孔，压暗由挡板整屏承担（否则背景全亮）。
    expect(
      document
        .querySelector(".tour-blocker")
        ?.classList.contains("tour-blocker-dimmed"),
    ).toBe(true);
  });

  it("下一步切到目标步骤时出现聚光灯与气泡", () => {
    render(<BeginnerTour steps={baseSteps} onFinish={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "下一步" }));
    expect(screen.getByText("目标步骤")).toBeInTheDocument();
    expect(document.querySelector(".tour-bubble")).not.toBeNull();
    expect(document.querySelector(".tour-spotlight")).not.toBeNull();
    // 有挖孔目标时，整屏压暗交给聚光灯的外阴影，挡板保持透明。
    expect(
      document
        .querySelector(".tour-blocker")
        ?.classList.contains("tour-blocker-dimmed"),
    ).toBe(false);
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
      newbieMode: false,
      workspaceDone: true,
      toolDone: { fa_list: true },
    });
    expect(loadTourState()).toEqual({
      newbieMode: false,
      workspaceDone: true,
      toolDone: { fa_list: true },
    });
  });

  it("损坏的存储内容按空状态处理", () => {
    window.localStorage.setItem("audit-toolbox.newbie-tour.v2", "{broken json");
    expect(loadTourState()).toEqual({});
    window.localStorage.setItem("audit-toolbox.newbie-tour.v2", "[]");
    expect(loadTourState()).toEqual({});
  });
});

describe("buildToolTourSteps", () => {
  const kanzhang: ToolManifest = {
    id: "kanzhang",
    name: "看账工具",
    description: "凭证导入、科目筛选、透视与导出",
    route: "/tools/kanzhang",
    version: "2.0",
    capabilities: ["inspect"],
    migrationStatus: "ready",
  };
  const unknownTool: ToolManifest = {
    ...kanzhang,
    id: "future_tool",
    name: "未来工具",
  };

  it("有剧本的工具用针对性导览：讲用途、聚光上传区、流程可选", () => {
    const steps = buildToolTourSteps(kanzhang);
    expect(steps[0].title).toBe("「看账工具」是做什么的");
    expect(steps[0].body).toContain("序时账");
    const prepare = steps.find((step) => step.id === "prepare");
    expect(prepare?.targetSelector).toBe('[data-tour="tool-upload"]');
    expect(prepare?.body).toContain("凭证编号");
    const flow = steps.find((step) => step.id === "flow");
    expect(flow?.targetSelector).toBe('[data-tour="step-indicator"]');
    expect(flow?.optional).toBe(true);
    expect(steps[steps.length - 1].id).toBe("result");
  });

  it("没有剧本的工具回落到通用模板", () => {
    const steps = buildToolTourSteps(unknownTool);
    expect(steps[0].id).toBe("tool-welcome");
    expect(steps[0].title).toBe("初识「未来工具」");
    expect(steps[0].body).toContain(unknownTool.description);
  });

  it("目录里每个工具都有针对性剧本，文案齐全", () => {
    const catalog = toolCatalogJson as { id: string }[];
    expect(catalog).toHaveLength(18);
    for (const entry of catalog) {
      const script = TOOL_TOUR_SCRIPTS[entry.id];
      expect(script, `${entry.id} 缺少导览剧本`).toBeDefined();
      expect(script.purpose.length, entry.id).toBeGreaterThan(10);
      expect(script.prepare.length, entry.id).toBeGreaterThan(10);
      expect(script.result.length, entry.id).toBeGreaterThan(10);
      for (const [key, text] of Object.entries(script.stepHints ?? {})) {
        expect(key.length, `${entry.id} 步骤 key 为空`).toBeGreaterThan(0);
        expect(text.length, `${entry.id} 的 ${key} 提示过短`).toBeGreaterThan(
          10,
        );
      }
    }
  });

  it("AI/路径选择类工具（无统一上传区）的准备步骤退化为居中卡片", () => {
    expect(TOOL_TOUR_SCRIPTS.audipick.prepareTargeted).toBeFalsy();
    expect(TOOL_TOUR_SCRIPTS.audit_roll_forward.prepareTargeted).toBeFalsy();
  });
});
