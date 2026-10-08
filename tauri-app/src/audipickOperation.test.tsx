// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  beginAudiPickOperation,
  dismissAudiPickOperation,
  getAudiPickOperations,
  isAudiPickOperationJob,
  setAudiPickOperationPaused,
  stopAudiPickOperation,
  type AudiPickOperationHandle,
} from "./audipickOperation";
import { AudiPickOperationPanel } from "./components/AudiPickOperationPanel";
import { JobDialogProvider } from "./components/JobDialog";
import { SyncBusyDialog } from "./components/SyncBusyDialog";
import { SuccessNudge } from "./components/tour/SuccessNudge";
import type { JobEvent } from "./types";

const api = vi.hoisted(() => ({
  jobPause: vi.fn(async () => true),
  jobCancel: vi.fn(async () => true),
  openOutput: vi.fn(),
  busy: null as null | ((entries: { id: number; method: string }[]) => void),
}));
vi.mock("./api", () => ({
  ...api,
  onSyncBusyChange: (fn: typeof api.busy) => {
    api.busy = fn;
    fn?.([]);
    return () => {
      api.busy = null;
    };
  },
}));
const handles: AudiPickOperationHandle[] = [];
function begin(label = "合同文字识别", controls = true) {
  const handle = beginAudiPickOperation(label, controls);
  handles.push(handle);
  return handle;
}
function job(id: string, phase = "ocr", toolId = "audipick"): JobEvent {
  return {
    jobId: id,
    phase,
    toolId,
    message: "第 1 页",
    current: 1,
    total: 2,
    severity: "info",
    outputPaths: [],
  };
}
afterEach(() => {
  cleanup();
  handles.splice(0).forEach((handle) => {
    handle.finish("cancelled", "测试结束");
    dismissAudiPickOperation(handle.id);
  });
  vi.clearAllMocks();
  vi.useRealTimers();
  window.localStorage.clear();
});

describe("AudiPick 整次操作生命周期", () => {
  it("收起任务栏直接提供暂停、终止和查看详情，展开和收起后保留切换按钮焦点", async () => {
    const handle = begin("合同文字读取 / OCR");
    act(() => handle.update("C320借款合同.pdf：已保存 22/53 页", 22, 53));
    render(<AudiPickOperationPanel />);

    const panel = screen.getByLabelText("AudiPick 后台任务");
    const toggle = screen.getByRole("button", { name: "查看详情" });
    expect(panel.classList.contains("audipick-operation-compact")).toBe(true);
    expect(toggle.getAttribute("aria-controls")).toBe(
      "audipick-operation-details",
    );
    expect(screen.getByRole("button", { name: "暂停" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "终止" })).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "暂停" }));
    });
    expect(screen.getByRole("button", { name: "继续" })).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "继续" }));
    });
    expect(screen.getByRole("button", { name: "暂停" })).toBeTruthy();

    toggle.focus();
    fireEvent.click(toggle);
    const collapse = screen.getByRole("button", { name: "收起" });
    expect(collapse).toBe(toggle);
    expect(document.activeElement).toBe(collapse);
    expect(panel.classList.contains("audipick-operation-expanded")).toBe(true);
    expect(screen.getByText("暂停")).toBeTruthy();

    fireEvent.click(collapse);
    const reopen = screen.getByRole("button", { name: "查看详情" });
    expect(reopen).toBe(toggle);
    expect(document.activeElement).toBe(reopen);
    expect(panel.classList.contains("audipick-operation-compact")).toBe(true);
    expect(screen.getByRole("button", { name: "暂停" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "终止" })).toBeTruthy();
  });

  it("逐页消息保持静默，只在任务阶段变化时更新状态播报", () => {
    const handle = begin("合同文字读取 / OCR");
    render(<AudiPickOperationPanel />);

    const liveStatus = screen.getByRole("status");
    expect(liveStatus.textContent).toBe("处理中");
    act(() => handle.update("C320借款合同.pdf：已保存 22/53 页", 22, 53));
    expect(screen.getByRole("status")).toBe(liveStatus);
    expect(liveStatus.textContent).toBe("处理中");
    expect(screen.getByText(/已保存 22\/53 页/)).not.toBe(liveStatus);

    act(() => handle.finish("completed", "全部页面已保存"));
    expect(screen.getByRole("status").textContent).toBe("已完成");
  });

  it("收起任务栏的终止按钮取消当前 worker 并进入停止状态", async () => {
    const handle = begin("合同文字读取 / OCR");
    handle.attachJob("compact-stop-page");
    render(<AudiPickOperationPanel />);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "终止" }));
    });

    expect(api.jobCancel).toHaveBeenCalledWith("compact-stop-page");
    expect(screen.getByRole("status").textContent).toBe("正在停止");
    expect(
      screen.getByRole("button", { name: "终止" }).hasAttribute("disabled"),
    ).toBe(true);
  });

  it("失败、完成与运行任务并存时批量清理仅保留运行任务", () => {
    const completed = begin("已完成合同");
    const failed = begin("失败合同");
    const running = begin("正在处理合同");
    act(() => {
      completed.finish("completed", "已保存");
      failed.finish("failed", "需要重试");
    });
    render(<AudiPickOperationPanel />);

    fireEvent.click(screen.getByText("清除已结束（2）"));

    expect(getAudiPickOperations().map((item) => item.id)).toEqual([
      running.id,
    ]);
    fireEvent.click(screen.getByText("查看详情"));
    expect(screen.getByLabelText("正在处理合同")).toBeTruthy();
  });

  it("全部任务结束后可一次关闭全部提示", () => {
    const first = begin("合同 A");
    const second = begin("合同 B");
    act(() => {
      first.finish("completed", "已保存");
      second.finish("failed", "需要重试");
    });
    render(<AudiPickOperationPanel />);

    fireEvent.click(screen.getByText("清除已结束（2）"));
    expect(getAudiPickOperations()).toEqual([]);
    expect(screen.queryByLabelText("AudiPick 后台任务")).toBeNull();
  });
  it("默认非模态；后台等待在页间空闲、下一页事件和重新挂载后保持收起", () => {
    const handle = begin();
    handle.attachJob("page-gap-1");
    const tree = (jobs: JobEvent[]) => (
      <JobDialogProvider jobs={jobs} nameOf={(name) => name}>
        <p>合同列表</p>
      </JobDialogProvider>
    );
    const view = render(tree([job("page-gap-1")]));
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByText("查看详情"));
    expect(screen.getByText("暂停")).toBeTruthy();
    fireEvent.click(screen.getByText("收起"));
    act(() => handle.detachJob("page-gap-1"));
    view.rerender(tree([job("page-gap-1", "completed")]));
    expect(screen.getByLabelText("AudiPick 后台任务")).toBeTruthy();
    expect(screen.getByText("暂停")).toBeTruthy();
    act(() => {
      handle.attachJob("page-gap-2");
      handle.update("正在识别第 2 / 2 页", 1, 2);
    });
    view.rerender(tree([job("page-gap-2")]));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByText("暂停")).toBeTruthy();
    view.unmount();
    render(tree([job("page-gap-2")]));
    expect(screen.getByText("查看详情")).toBeTruthy();
  });

  it("OCR 子页完成不庆祝；整次保存成功后只有一条完成提示", () => {
    const handle = begin();
    handle.attachJob("completion-page");
    const view = render(
      <MemoryRouter>
        <AudiPickOperationPanel />
        <SuccessNudge
          jobs={[job("completion-page", "completed")]}
          toolNameOf={() => "AudiPick"}
        />
      </MemoryRouter>,
    );
    expect(screen.queryByText("AudiPick已完成")).toBeNull();
    act(() => {
      handle.detachJob("completion-page");
      handle.finish("completed", "全部 2 页已识别并保存");
    });
    expect(screen.getByRole("status").textContent).toContain("已完成");
    fireEvent.click(screen.getByText("清除已结束（1）"));
    view.rerender(
      <MemoryRouter>
        <AudiPickOperationPanel />
        <SuccessNudge
          jobs={[job("completion-page", "completed")]}
          toolNameOf={() => "AudiPick"}
        />
      </MemoryRouter>,
    );
    expect(screen.queryByText("AudiPick已完成")).toBeNull();
    expect(isAudiPickOperationJob("completion-page")).toBe(true);
  });

  it("失败不会显示完成，保持非模态错误直到用户关闭", () => {
    const handle = begin();
    render(<AudiPickOperationPanel />);
    act(() => handle.finish("failed", "第 2 页额度不足；第 1 页已保存"));
    expect(screen.getByRole("status").textContent).toContain("未完成");
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByText("清除已结束（1）"));
    expect(screen.queryByLabelText("AudiPick 后台任务")).toBeNull();
  });

  it("暂停映射真实 worker；页间继续唤醒等待，不启动新的页", async () => {
    const handle = begin();
    handle.attachJob("pause-page");
    await setAudiPickOperationPaused(handle.id, true);
    expect(api.jobPause).toHaveBeenCalledWith("pause-page", true);
    handle.detachJob("pause-page");
    let passed = false;
    const wait = handle.checkpoint().then(() => {
      passed = true;
    });
    await Promise.resolve();
    expect(passed).toBe(false);
    await setAudiPickOperationPaused(handle.id, false);
    await wait;
    expect(passed).toBe(true);
  });

  it("页间停止阻止下一页，当前页停止调用原生取消；失败控制可重试", async () => {
    const handle = begin();
    handle.attachJob("stop-page");
    api.jobCancel.mockRejectedValueOnce(new Error("正在退出"));
    await stopAudiPickOperation(handle.id);
    expect(api.jobCancel).toHaveBeenCalledWith("stop-page");
    expect(getAudiPickOperations()[0].controlError).toContain("可重试");
    await expect(handle.checkpoint()).rejects.toThrow("已完成页已保存");
    await stopAudiPickOperation(handle.id);
    expect(api.jobCancel).toHaveBeenCalledTimes(2);
  });

  it("暂停失败回滚，不把任务永久留在假暂停", async () => {
    const handle = begin();
    handle.attachJob("pause-fail-page");
    api.jobPause.mockRejectedValueOnce(new Error("失败"));
    await setAudiPickOperationPaused(handle.id, true);
    expect(getAudiPickOperations()[0].paused).toBe(false);
    await expect(handle.checkpoint()).resolves.toBeUndefined();
  });

  it("多个 AudiPick 操作互不取消；普通工具仍打开原进度框", async () => {
    const first = begin("合同 A");
    const second = begin("合同 B");
    first.attachJob("parallel-a");
    second.attachJob("parallel-b");
    render(
      <JobDialogProvider
        jobs={[
          job("parallel-a"),
          job("parallel-b"),
          job("excel", "merge", "Excel_Merger"),
        ]}
        nameOf={(value) => value}
      >
        <p>工作区</p>
      </JobDialogProvider>,
    );
    expect(screen.getByRole("dialog").textContent).toContain("Excel_Merger");
    expect(screen.getByText("AudiPick · 2 项处理中")).toBeTruthy();
    await act(async () => stopAudiPickOperation(first.id));
    expect(api.jobCancel).toHaveBeenCalledWith("parallel-a");
    expect(api.jobCancel).not.toHaveBeenCalledWith("parallel-b");
    await expect(second.checkpoint()).resolves.toBeUndefined();
  });

  it("首个任务不可控时，收起任务栏仍控制后续可控任务", async () => {
    const passive = begin("不可中断的整理", false);
    const controlled = begin("合同文字读取 / OCR", true);
    controlled.attachJob("controllable-page");
    render(<AudiPickOperationPanel />);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "终止" }));
    });

    expect(api.jobCancel).toHaveBeenCalledWith("controllable-page");
    expect(
      getAudiPickOperations().find((item) => item.id === passive.id)?.stopping,
    ).toBe(false);
    expect(
      getAudiPickOperations().find((item) => item.id === controlled.id)
        ?.stopping,
    ).toBe(true);
  });

  it("分段提取空闲间隔不弹同步框；元数据安静；其他工具仍正常等待", () => {
    vi.useFakeTimers();
    const handle = begin("限制性契约提取", false);
    render(
      <>
        <SyncBusyDialog />
        <AudiPickOperationPanel />
      </>,
    );
    act(() => {
      api.busy?.([{ id: 1, method: "audipick.extract" }]);
      vi.advanceTimersByTime(1200);
    });
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByText("查看详情"));
    expect(screen.queryByText("停止")).toBeNull();
    fireEvent.click(screen.getByText("收起"));
    act(() => {
      api.busy?.([]);
      handle.update("正在提取第 2 / 8 段");
      api.busy?.([{ id: 2, method: "audipick.extract" }]);
      vi.advanceTimersByTime(1200);
    });
    expect(screen.queryByRole("dialog")).toBeNull();
    act(() => {
      api.busy?.([{ id: 3, method: "loan.inspect" }]);
      vi.advanceTimersByTime(1200);
    });
    expect(screen.getByRole("dialog").textContent).toContain("读取借款数据");
    act(() => {
      api.busy?.([]);
      handle.finish("completed", "提取结果已保存");
      api.busy?.([
        { id: 4, method: "audipick.config_status" },
        { id: 5, method: "audipick.projects" },
      ]);
      vi.advanceTimersByTime(1200);
    });
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
