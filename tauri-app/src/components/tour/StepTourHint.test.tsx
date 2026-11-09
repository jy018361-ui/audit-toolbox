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
  vi.useRealTimers();
  window.localStorage.clear();
  document.querySelectorAll(".tour-layer").forEach((el) => el.remove());
});

describe("StepTourHint", () => {
  it("从有提示步骤返回精简模式的静默步骤时立即移除旧卡片及遮罩", () => {
    const depositSteps = [{ key: "source", label: "上传与识别" }, { key: "accounts", label: "科目与利率确认" }];
    const { rerender } = render(<ToolTourProvider toolId="deposit_interest"><StepTourHint steps={depositSteps} current={0} /></ToolTourProvider>);
    rerender(<ToolTourProvider toolId="deposit_interest"><StepTourHint steps={depositSteps} current={1} /></ToolTourProvider>);
    expect(screen.getByText("科目与利率确认")).toBeInTheDocument();
    rerender(<ToolTourProvider toolId="deposit_interest"><StepTourHint steps={depositSteps} current={0} /></ToolTourProvider>);
    expect(document.querySelector(".step-hint")).toBeNull();
    expect(document.querySelector(".step-hint-veil")).toBeNull();
  });

  it("切到禁用步骤或原步骤被替换后不保留上一条提示", () => {
    const { rerender } = render(<StepTourHint steps={steps} current={0} />);
    rerender(<StepTourHint steps={steps} current={1} />);
    expect(screen.getByText("确认输入")).toBeInTheDocument();
    rerender(<StepTourHint steps={steps.map(step => ({ ...step, disabled: true }))} current={2} />);
    expect(document.querySelector(".step-hint-veil")).toBeNull();
    rerender(<StepTourHint steps={steps} current={1} />);
    expect(screen.getByText("确认输入")).toBeInTheDocument();
    rerender(<StepTourHint steps={[steps[0], { key: "replacement", label: "已更换的流程" }, steps[2]]} current={1} />);
    expect(document.querySelector(".step-hint")).toBeNull();
  });

  it("键盘焦点离开提示卡后恢复自动关闭", () => {
    vi.useFakeTimers();
    const { rerender } = render(<StepTourHint steps={steps} current={0} autoDismissMs={1000} />);
    rerender(<StepTourHint steps={steps} current={1} autoDismissMs={1000} />);
    const close = screen.getByRole("button", { name: "关闭本步提示" });
    act(() => close.focus());
    act(() => vi.advanceTimersByTime(2000));
    expect(screen.getByText("确认输入")).toBeInTheDocument();
    act(() => close.blur());
    act(() => vi.advanceTimersByTime(1001));
    expect(document.querySelector(".step-hint-veil")).toBeNull();
  });

  it("当前步骤失效后重新启用也不重现旧提示", () => {
    const { rerender } = render(<StepTourHint steps={steps} current={0} />);
    rerender(<StepTourHint steps={steps} current={1} />);
    expect(screen.getByText("确认输入")).toBeInTheDocument();
    rerender(<StepTourHint steps={steps.map(step => ({ ...step, disabled: true }))} current={1} />);
    expect(document.querySelector(".step-hint-veil")).toBeNull();
    rerender(<StepTourHint steps={steps} current={1} />);
    expect(document.querySelector(".step-hint")).toBeNull();
  });

  it("鼠标移出时若键盘焦点仍在卡片内，继续暂停自动关闭", () => {
    vi.useFakeTimers();
    const { rerender } = render(<StepTourHint steps={steps} current={0} autoDismissMs={1000} />);
    rerender(<StepTourHint steps={steps} current={1} autoDismissMs={1000} />);
    const card = document.querySelector(".step-hint")!;
    const close = screen.getByRole("button", { name: "关闭本步提示" });
    fireEvent.mouseEnter(card);
    act(() => close.focus());
    fireEvent.mouseLeave(card);
    act(() => vi.advanceTimersByTime(2000));
    expect(screen.getByText("确认输入")).toBeInTheDocument();
    act(() => close.blur());
    act(() => vi.advanceTimersByTime(1001));
    expect(document.querySelector(".step-hint-veil")).toBeNull();
  });

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
        "按页面提示完成测算或导出，再查看结果；修改输入后请重新运行，确保结果与当前设置一致。",
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
    expect(screen.getByText(/市场中枢暂估值/)).toBeInTheDocument();
  });

  it("剧本里没有对应 key 时落到通用提示", () => {
    const fallbackSteps = [
      { key: "a", label: "甲" },
      { key: "b", label: "乙" },
      { key: "c", label: "丙" },
    ];
    const { rerender } = render(
      <ToolTourProvider toolId="ts_manager">
        <StepTourHint steps={fallbackSteps} current={0} />
      </ToolTourProvider>,
    );
    rerender(
      <ToolTourProvider toolId="ts_manager">
        <StepTourHint steps={fallbackSteps} current={1} />
      </ToolTourProvider>,
    );
    expect(screen.getByText(/按页面提示完成当前操作/)).toBeInTheDocument();
  });

  it("会议纪要导览文案覆盖历史查询与结果阅读", () => {
    const meetingSteps = [
      { key: "record", label: "会议记录" },
      { key: "history", label: "历史记录" },
      { key: "result", label: "结果" },
    ];
    const { rerender } = render(
      <ToolTourProvider toolId="meeting_minutes"><StepTourHint steps={meetingSteps} current={0} /></ToolTourProvider>,
    );
    rerender(<ToolTourProvider toolId="meeting_minutes"><StepTourHint steps={meetingSteps} current={1} /></ToolTourProvider>);
    expect(screen.getByText(/历史记录按日期和标题排列，可搜索会议标题/)).toBeInTheDocument();
    rerender(<ToolTourProvider toolId="meeting_minutes"><StepTourHint steps={meetingSteps} current={2} /></ToolTourProvider>);
    expect(screen.getByText(/从转写稿重新生成/)).toBeInTheDocument();
    expect(screen.queryByText(/按页面提示完成当前操作/)).not.toBeInTheDocument();
  });

  it("FA 默认 TB＋JE 模式在科目复核时显示对应提示", () => {
    const faSteps = [{ key: "source", label: "上传与映射" }, { key: "accounts", label: "科目复核" }, { key: "output", label: "预览与导出" }];
    const { rerender } = render(<ToolTourProvider toolId="fa_list"><StepTourHint steps={faSteps} current={0} /></ToolTourProvider>);
    rerender(<ToolTourProvider toolId="fa_list"><StepTourHint steps={faSteps} current={1} /></ToolTourProvider>);
    expect(screen.getByText(/确认哪些科目属于固定资产原值/)).toBeInTheDocument();
    expect(screen.queryByText(/年初、年末清单/)).not.toBeInTheDocument();
  });

  it("精简提示的工具：没写提示的步骤保持安静，写到的照常弹出", () => {
    // 存款利息只保留了「科目与利率确认」一步的提示。
    const depositSteps = [
      { key: "source", label: "上传与识别" },
      { key: "accounts", label: "科目与利率确认" },
    ];
    const { rerender } = render(
      <ToolTourProvider toolId="deposit_interest">
        <StepTourHint steps={depositSteps} current={0} />
      </ToolTourProvider>,
    );
    // 切到 accounts：有专属提示，照常弹出。
    rerender(
      <ToolTourProvider toolId="deposit_interest">
        <StepTourHint steps={depositSteps} current={1} />
      </ToolTourProvider>,
    );
    expect(screen.getByText(/市场中枢暂估值/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "关闭本步提示" }));
    // 再切回 source：该步未写提示，整张卡不出现，也不回退通用文案。
    rerender(
      <ToolTourProvider toolId="deposit_interest">
        <StepTourHint steps={depositSteps} current={0} />
      </ToolTourProvider>,
    );
    expect(screen.queryByText("上传与识别")).not.toBeInTheDocument();
    expect(screen.queryByText(/按页面提示完成当前操作/)).not.toBeInTheDocument();
  });

  it("整工具精简（如折旧测算）任何步骤都不弹提示", () => {
    const depSteps = [
      { key: "source", label: "读取清单" },
      { key: "mapping", label: "核对字段映射" },
    ];
    const { rerender } = render(
      <ToolTourProvider toolId="fa_dep_calc">
        <StepTourHint steps={depSteps} current={0} />
      </ToolTourProvider>,
    );
    rerender(
      <ToolTourProvider toolId="fa_dep_calc">
        <StepTourHint steps={depSteps} current={1} />
      </ToolTourProvider>,
    );
    expect(screen.queryByText(/按页面提示完成当前操作/)).not.toBeInTheDocument();
    expect(screen.queryByText("读取清单")).not.toBeInTheDocument();
    expect(screen.queryByText("核对字段映射")).not.toBeInTheDocument();
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
