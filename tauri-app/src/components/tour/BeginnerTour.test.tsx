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

  it("目标在首屏之外时先滚动到目标，聚光灯定位在视口内", async () => {
    // jsdom 没有 scrollIntoView 也没有真实滚动：mock 它并在调用时
    // 模拟"滚动已完成"的测量结果（目标回到视口内）。
    let outOfViewport = true;
    const scrollIntoViewMock = vi.fn(() => {
      outOfViewport = false;
    });
    Element.prototype.scrollIntoView = scrollIntoViewMock;
    vi.spyOn(
      HTMLElement.prototype,
      "getBoundingClientRect",
    ).mockImplementation(function (this: HTMLElement) {
      if (this.hasAttribute("data-tour")) {
        return outOfViewport
          ? {
              top: 900,
              left: 80,
              right: 320,
              bottom: 948,
              width: 240,
              height: 48,
              x: 80,
              y: 900,
              toJSON: () => ({}),
            } as DOMRect
          : {
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
    });
    const steps: TourStep[] = [
      {
        id: "below",
        title: "视口外步骤",
        body: "x",
        targetSelector: '[data-tour="demo"]',
      },
    ];
    render(
      <BeginnerTour
        steps={steps}
        onFinish={vi.fn()}
        retryIntervalMs={10}
      />,
    );
    // 目标量出来在视口外：先滚动到目标，等下一轮重新测量。
    await waitFor(() =>
      expect(scrollIntoViewMock).toHaveBeenCalledWith({
        block: "center",
        inline: "nearest",
        behavior: "auto",
      }),
    );
    // 滚动生效后聚光灯出现，位置落在视口内，气泡从隐藏转为可见。
    await waitFor(() =>
      expect(document.querySelector(".tour-spotlight")).not.toBeNull(),
    );
    const spotlight = document.querySelector(".tour-spotlight") as HTMLElement;
    const top = parseFloat(spotlight.style.top);
    const left = parseFloat(spotlight.style.left);
    expect(top).toBeGreaterThanOrEqual(0);
    expect(top).toBeLessThan(window.innerHeight);
    expect(left).toBeGreaterThanOrEqual(0);
    expect(left).toBeLessThan(window.innerWidth);
    expect(
      (document.querySelector(".tour-bubble") as HTMLElement).style.visibility,
    ).toBe("visible");
  });

  it("目标比视口还高时：滚动改为顶部对齐，气泡夹回屏幕内可见", async () => {
    // 第四步实测的回归：工具卡片区比视口还高，滚动对齐后顶部越过屏幕
    // 上沿，气泡曾被自己的位移推出屏幕，只剩一个箭头尖挂在角落。
    const scrollIntoViewMock = vi.fn(() => undefined);
    Element.prototype.scrollIntoView = scrollIntoViewMock;
    vi.spyOn(
      HTMLElement.prototype,
      "getBoundingClientRect",
    ).mockImplementation(function (this: HTMLElement) {
      if (this.hasAttribute("data-tour")) {
        return {
          top: -850,
          left: 80,
          right: 1000,
          bottom: 1650,
          width: 920,
          height: 2500,
          x: 80,
          y: -850,
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
    });
    const steps: TourStep[] = [
      {
        id: "tall",
        title: "高个步骤",
        body: "x",
        targetSelector: '[data-tour="demo"]',
      },
    ];
    render(
      <BeginnerTour
        steps={steps}
        onFinish={vi.fn()}
        retryIntervalMs={10}
      />,
    );
    await waitFor(() =>
      expect(scrollIntoViewMock).toHaveBeenCalledWith(
        expect.objectContaining({ block: "start" }),
      ),
    );
    // 等定位完成、气泡从"待命隐藏"转为可见，再断言位置夹在视口内。
    await waitFor(() => {
      const target = document.querySelector(".tour-bubble") as HTMLElement;
      expect(target?.style.visibility).toBe("visible");
    });
    const bubble = document.querySelector(".tour-bubble") as HTMLElement;
    const top = parseFloat(bubble.style.top);
    expect(top).toBeGreaterThanOrEqual(8);
    expect(top).toBeLessThanOrEqual(window.innerHeight - 8);
  });
});

describe("tourState", () => {
  it("保存后读取往返一致", () => {
    saveTourState({ newbieMode: false, workspaceDone: true });
    expect(loadTourState()).toEqual({
      newbieMode: false,
      workspaceDone: true,
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

  it("带双模式的工具导览必讲模式选择，并聚光模式切换区", () => {
    for (const id of ["fa_list", "loan_interest", "fx_audit"]) {
      const script = TOOL_TOUR_SCRIPTS[id];
      expect(script?.mode, `${id} 缺少模式说明`).toBeDefined();
      expect(script!.mode!.length).toBeGreaterThan(10);
    }
    const faSteps = buildToolTourSteps({
      ...kanzhang,
      id: "fa_list",
      name: "FA List 匹配工具",
    });
    const modeStep = faSteps.find((step) => step.id === "mode");
    expect(modeStep?.targetSelector).toBe('[data-tour="tool-mode"]');
    expect(modeStep?.optional).toBe(true);
    expect(modeStep?.body).toContain("两期固定资产清单");
    expect(modeStep?.body).toContain("TB＋JE 变动表");
  });
});

describe("引导焦点圈定（aria-modal 落地）", () => {
  it("Tab / Shift+Tab 在引导层内循环，不会落到背景的「跳过导航」链接上", () => {
    // 模拟应用外壳里排在引导层之前的左上角跳转链接：
    // 没有焦点圈定时，Shift+Tab 会聚焦它并让它在左上角滑入。
    const skipLink = document.createElement("a");
    skipLink.href = "#main-content";
    skipLink.className = "skip-navigation";
    skipLink.textContent = "跳过导航，进入工作区";
    document.body.appendChild(skipLink);

    render(<BeginnerTour steps={baseSteps} onFinish={vi.fn()} />);
    const layer = document.querySelector(".tour-layer") as HTMLElement;
    const next = screen.getByRole("button", { name: "下一步" });
    const skipStep = screen.getByRole("button", { name: "跳过引导" });
    // 首步自动聚焦主按钮。
    expect(document.activeElement).toBe(next);

    // 焦点在层外（跳转链接上）：Tab 被拉回层内第一个按钮。
    skipLink.focus();
    fireEvent.keyDown(window, { key: "Tab" });
    expect(document.activeElement).toBe(skipStep);
    expect(layer.contains(document.activeElement)).toBe(true);

    // 层内首尾循环：首个按钮 Shift+Tab 绕到最后一个。
    fireEvent.keyDown(window, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(next);

    skipLink.remove();
  });
});

describe("目标可见性（keep-alive 遮蔽）", () => {
  it("同名挂点被隐藏页挡在前面时，仍然锁定当前页的可见目标", () => {
    // 排在最前的 0×0 同名挂点模拟 keep-alive 隐藏页；
    // 目标查找必须跳过它取第一个可见匹配，而不是卡在它身上轮询超时。
    vi.spyOn(
      HTMLElement.prototype,
      "getBoundingClientRect",
    ).mockImplementation(function (this: HTMLElement) {
      const zero =
        !this.hasAttribute("data-tour") ||
        this.style.display === "none";
      return {
        top: zero ? 0 : 120,
        left: zero ? 0 : 80,
        right: zero ? 0 : 320,
        bottom: zero ? 0 : 168,
        width: zero ? 0 : 240,
        height: zero ? 0 : 48,
        x: zero ? 0 : 80,
        y: zero ? 0 : 120,
        toJSON: () => ({}),
      } as DOMRect;
    });
    const hidden = document.createElement("div");
    hidden.setAttribute("data-tour", "demo");
    hidden.style.display = "none";
    document.body.insertBefore(hidden, document.body.firstChild);

    render(
      <BeginnerTour
        steps={[
          {
            id: "only",
            title: "被遮挡的步骤",
            body: "x",
            targetSelector: '[data-tour="demo"]',
          },
        ]}
        onFinish={vi.fn()}
      />,
    );
    expect(document.querySelector(".tour-spotlight")).not.toBeNull();
    expect(
      (document.querySelector(".tour-bubble") as HTMLElement).style.visibility,
    ).toBe("visible");
  });
});

describe("buildToolTourSteps 锚点", () => {
  const withScript: ToolManifest = {
    id: "kanzhang",
    name: "看账工具",
    description: "凭证导入、科目筛选、透视与导出",
    route: "/tools/kanzhang",
    version: "2.0",
    capabilities: ["inspect"],
    migrationStatus: "ready",
  };

  it("purpose 与 result 都锚定页头，工具导览全程锁定区域", () => {
    const steps = buildToolTourSteps(withScript);
    expect(steps.find((s) => s.id === "purpose")?.targetSelector).toBe(
      '[data-tour="page-header"]',
    );
    expect(steps.find((s) => s.id === "result")?.targetSelector).toBe(
      '[data-tour="page-header"]',
    );
  });
});
