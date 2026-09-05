// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { StepTourHint } from "./StepTourHint";
import { ToolTourProvider } from "./ToolTourContext";
import { saveTourState } from "./tourState";

const steps = [
  { key: "upload", label: "上传与识别" },
  { key: "confirm", label: "确认输入" },
  { key: "result", label: "查看结果" },
];

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  document.querySelectorAll(".tour-layer").forEach((el) => el.remove());
});

describe("StepTourHint", () => {
  it("首次挂载不弹提示，切换到第二步时弹出该步说明", () => {
    const { rerender } = render(<StepTourHint steps={steps} current={0} />);
    expect(screen.queryByText("确认输入")).not.toBeInTheDocument();
    rerender(<StepTourHint steps={steps} current={1} />);
    expect(screen.getByText("第 2 步 · 共 3 步")).toBeInTheDocument();
    expect(screen.getByText("确认输入")).toBeInTheDocument();
  });

  it("点关闭按钮立即消失", () => {
    const { rerender } = render(<StepTourHint steps={steps} current={0} />);
    rerender(<StepTourHint steps={steps} current={1} />);
    fireEvent.click(screen.getByRole("button", { name: "关闭本步提示" }));
    expect(screen.queryByText("确认输入")).not.toBeInTheDocument();
  });

  it("提示弹出时出现全屏压暗层，点击压暗层等同关闭", () => {
    const { rerender } = render(<StepTourHint steps={steps} current={0} />);
    rerender(<StepTourHint steps={steps} current={1} />);
    expect(screen.getByText("确认输入")).toBeInTheDocument();
    const veil = document.querySelector(".step-hint-veil");
    expect(veil).not.toBeNull();
    fireEvent.click(veil as HTMLElement);
    expect(screen.queryByText("确认输入")).not.toBeInTheDocument();
    expect(document.querySelector(".step-hint-veil")).toBeNull();
  });

  it("超时自动消失", async () => {
    const { rerender } = render(
      <StepTourHint steps={steps} current={0} autoDismissMs={30} />,
    );
    rerender(<StepTourHint steps={steps} current={1} autoDismissMs={30} />);
    expect(screen.getByText("确认输入")).toBeInTheDocument();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 80));
    });
    expect(screen.queryByText("确认输入")).not.toBeInTheDocument();
  });

  it("新手模式总开关关闭时不弹", () => {
    saveTourState({ newbieMode: false });
    const { rerender } = render(<StepTourHint steps={steps} current={0} />);
    rerender(<StepTourHint steps={steps} current={1} />);
    expect(screen.queryByText("确认输入")).not.toBeInTheDocument();
  });

  it("完整引导播放中不叠加提示", () => {
    const veil = document.createElement("div");
    veil.className = "tour-layer";
    document.body.appendChild(veil);
    const { rerender } = render(<StepTourHint steps={steps} current={0} />);
    rerender(<StepTourHint steps={steps} current={1} />);
    expect(screen.queryByText("确认输入")).not.toBeInTheDocument();
  });

  it("最后一步换成完成导向的文案", () => {
    const { rerender } = render(<StepTourHint steps={steps} current={0} />);
    rerender(<StepTourHint steps={steps} current={2} />);
    expect(
      screen.getByText(
        "最后一步：完成它就能看到结果。想改前面的内容，点步骤条随时回去。",
      ),
    ).toBeInTheDocument();
  });

  it("有针对性剧本的工具显示专属步骤提示", () => {
    const depositSteps = [
      { key: "source", label: "上传与识别" },
      { key: "accounts", label: "科目与利率确认" },
    ];
    const { rerender } = render(
      <ToolTourProvider toolId="deposit_interest">
        <StepTourHint steps={depositSteps} current={0} />
      </ToolTourProvider>,
    );
    rerender(
      <ToolTourProvider toolId="deposit_interest">
        <StepTourHint steps={depositSteps} current={1} />
      </ToolTourProvider>,
    );
    expect(screen.getByText(/活期有内置利率/)).toBeInTheDocument();
  });

  it("剧本里没有对应 key 时落到通用提示", () => {
    const fallbackSteps = [
      { key: "a", label: "甲" },
      { key: "b", label: "乙" },
      { key: "c", label: "丙" },
    ];
    const { rerender } = render(
      <ToolTourProvider toolId="deposit_interest">
        <StepTourHint steps={fallbackSteps} current={0} />
      </ToolTourProvider>,
    );
    rerender(
      <ToolTourProvider toolId="deposit_interest">
        <StepTourHint steps={fallbackSteps} current={1} />
      </ToolTourProvider>,
    );
    expect(screen.getByText(/完成这一步的操作后/)).toBeInTheDocument();
  });

  it("弹出时聚光灯挖孔锁定可见的步骤条", () => {
    vi.spyOn(
      HTMLElement.prototype,
      "getBoundingClientRect",
    ).mockImplementation(function (this: HTMLElement) {
      if (this.getAttribute("data-tour") === "step-indicator") {
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
    });
    const indicator = document.createElement("div");
    indicator.setAttribute("data-tour", "step-indicator");
    document.body.appendChild(indicator);

    const { rerender } = render(<StepTourHint steps={steps} current={0} />);
    rerender(<StepTourHint steps={steps} current={1} />);
    const spotlight = document.querySelector(
      ".step-hint-spotlight",
    ) as HTMLElement;
    expect(spotlight).not.toBeNull();
    // 挖孔按步骤条矩形外扩 6px。
    expect(parseFloat(spotlight.style.top)).toBe(114);
    expect(parseFloat(spotlight.style.left)).toBe(74);
    expect(parseFloat(spotlight.style.width)).toBe(252);
    expect(parseFloat(spotlight.style.height)).toBe(60);
    // 有挖孔时挡板保持透明，压暗交给聚光灯外圈。
    expect(
      document.querySelector(".step-hint-veil")?.classList.contains(
        "step-hint-veil-dimmed",
      ),
    ).toBe(false);
    vi.restoreAllMocks();
  });

  it("量不到可见步骤条时不挖孔，挡板整屏压暗兜底", () => {
    // jsdom 无布局：所有元素宽高为 0，相当于步骤条不可见。
    const { rerender } = render(<StepTourHint steps={steps} current={0} />);
    rerender(<StepTourHint steps={steps} current={1} />);
    expect(document.querySelector(".step-hint-spotlight")).toBeNull();
    expect(document.querySelector(".step-hint-veil-dimmed")).not.toBeNull();
  });
});
