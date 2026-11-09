// @vitest-environment jsdom
import {
  cleanup,
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useEffect } from "react";
import { OcrScanProgressDialog } from "./OcrScanProgressDialog";
import { JobDialogProvider } from "./JobDialog";
import { useOcrScanProgressDialog, type OcrScanProgress } from "../ocrProgress";

afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });
const scan = (changes: Partial<OcrScanProgress> = {}): OcrScanProgress => ({
  fileName: "测试贷款合同.pdf",
  fileIndex: 1,
  fileCount: 2,
  phase: "scanning",
  completed: 3,
  total: 20,
  paused: false,
  stopping: false,
  controlling: false,
  pages: [
    { page: 1, state: "completed" },
    { page: 2, state: "failed" },
    { page: 3, state: "completed" },
    { page: 4, state: "running" },
    { page: 5, state: "queued" },
  ],
  onPause: vi.fn(),
  onCancel: vi.fn(),
  ...changes,
});
it("以已处理页数展示扫描进度，仅一组操作，逐页状态按需展开", () => {
  const progress = scan();
  render(<OcrScanProgressDialog progress={progress} />);
  expect(screen.getByRole("progressbar").getAttribute("value")).toBe("3");
  expect(screen.getByRole("progressbar").getAttribute("max")).toBe("20");
  expect(screen.getByText("成功 2 页")).toBeTruthy();
  expect(screen.getByText(/失败 1 页/)).toBeTruthy();
  expect(screen.queryByLabelText("逐页扫描状态")).toBeNull();
  expect(screen.getAllByRole("button", { name: /^暂停$/ })).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "查看逐页状态" }));
  expect(screen.getByLabelText("逐页扫描状态").textContent).toContain("排队中");
  expect(screen.getAllByRole("button", { name: "取消扫描" })).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: /^暂停$/ }));
  fireEvent.click(screen.getByRole("button", { name: "取消扫描" }));
  expect(progress.onPause).toHaveBeenCalledOnce();
  expect(progress.onCancel).toHaveBeenCalledOnce();
});

it("29/30时默认显示真实拖尾第11页，用时持续更新且不自动重试", () => {
  vi.useFakeTimers();
  let now = 100000;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  const onDeferPage = vi.fn();
  const progress = scan({ completed: 29, total: 30, onDeferPage,
    pages: Array.from({ length: 30 }, (_, i) => ({
      page: i + 1, state: i === 10 ? "ocr_request" : "completed",
      startedAt: i === 10 ? 10000 : 0, cancellable: i === 10,
    })),
  });
  const { rerender } = render(<OcrScanProgressDialog progress={progress} />);
  expect(screen.getByLabelText("仍在处理的页面").textContent).toContain("仍在处理：第 11 页");
  expect(screen.getByLabelText("仍在处理的页面").textContent).toContain("等待识别服务返回 · 已用时 90 秒");
  expect(screen.queryByLabelText("逐页扫描状态")).toBeNull();
  now += 4000;
  act(() => vi.advanceTimersByTime(4000));
  expect(screen.getByLabelText("仍在处理的页面").textContent).toContain("已用时 94 秒");
  expect(onDeferPage).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "结束第 11 页等待，稍后补扫" }));
  expect(onDeferPage).toHaveBeenCalledWith(11);
  expect(progress.onCancel).not.toHaveBeenCalled();
  rerender(<OcrScanProgressDialog progress={{ ...progress, pages: progress.pages.map(p => p.page === 11 ? { ...p, cancelling: true } : p) }} />);
  expect((screen.getByRole("button", { name: "结束第 11 页等待，稍后补扫" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "后台运行" }));
  expect(screen.getByRole("button", { name: "展开 OCR 扫描进度" }).textContent).toContain("仍在处理：第 11 页");
});

it("短任务及暂停时不误报长等待，旧版无开始时间仍显示活动页码", () => {
  vi.spyOn(performance, "now").mockReturnValue(10000);
  const progress = scan({ onDeferPage: vi.fn(), pages: [{ page: 7, state: "running", startedAt: 0, cancellable: true }] });
  const { rerender } = render(<OcrScanProgressDialog progress={progress} />);
  expect(screen.queryByText(/部分页面耗时较长/)).toBeNull();
  expect(screen.queryByRole("button", { name: /结束第/ })).toBeNull();
  rerender(<OcrScanProgressDialog progress={{ ...progress, paused: true, pages: [{ ...progress.pages[0], startedAt: -40000 }] }} />);
  expect(screen.queryByText(/部分页面耗时较长/)).toBeNull();
  expect((screen.getByRole("button", { name: /结束第/ }) as HTMLButtonElement).disabled).toBe(true);
  rerender(<OcrScanProgressDialog progress={scan({ pages: [{ page: 11, state: "running" }] })} />);
  expect(screen.getByLabelText("仍在处理的页面").textContent).toContain("第 11 页 · 识别中");
  expect(screen.getByLabelText("仍在处理的页面").textContent).not.toContain("秒");
});
it("未知页数不显示虚假百分比，保存阶段保留弹窗", () => {
  const { rerender } = render(
    <OcrScanProgressDialog
      progress={scan({ phase: "preparing", total: 0, completed: 0, pages: [] })}
    />,
  );
  expect(screen.getByRole("progressbar").hasAttribute("value")).toBe(false);
  expect(screen.getByText("正在确认页数")).toBeTruthy();
  rerender(
    <OcrScanProgressDialog
      progress={scan({ phase: "saving", completed: 20 })}
    />,
  );
  expect(screen.getByRole("dialog")).toBeTruthy();
  expect(screen.getByRole("status").textContent).toBe("正在保存");
});
it("后台运行保留进度，焦点转到任务条，结束后新批次重新展开", async () => {
  const { rerender } = render(<OcrScanProgressDialog progress={scan()} />);
  fireEvent.click(screen.getByRole("button", { name: "后台运行" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  const pill = screen.getByRole("button", { name: "展开 OCR 扫描进度" });
  await waitFor(() => expect(document.activeElement).toBe(pill));
  expect(pill.textContent).toContain("3 / 20 页");
  fireEvent.click(pill);
  expect(screen.getByRole("dialog")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "后台运行" }));
  rerender(<OcrScanProgressDialog />);
  expect(
    screen.queryByRole("button", { name: "展开 OCR 扫描进度" }),
  ).toBeNull();
  rerender(
    <OcrScanProgressDialog
      progress={scan({ fileIndex: 2, fileName: "第二份.pdf" })}
    />,
  );
  expect(screen.getByRole("dialog")).toBeTruthy();
  expect(screen.getByText("第二份.pdf")).toBeTruthy();
});
it("暂停只影响活动页面，取消失败提供重试入口", () => {
  const { rerender } = render(
    <OcrScanProgressDialog progress={scan({ paused: true })} />,
  );
  expect(screen.getByRole("button", { name: "继续扫描" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "查看逐页状态" }));
  expect(screen.getByLabelText("逐页扫描状态").textContent).toContain("已完成");
  rerender(
    <OcrScanProgressDialog
      progress={scan({ stopping: true, error: "取消通道暂时失败" })}
    />,
  );
  expect(screen.getByRole("alert").textContent).toContain("取消通道暂时失败");
  expect(
    (screen.getByRole("button", { name: "重试取消" }) as HTMLButtonElement)
      .disabled,
  ).toBe(false);
  expect(
    (screen.getByRole("button", { name: /^暂停$/ }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
});
function PublishScan({ value }: { value: OcrScanProgress }) {
  const { setProgress } = useOcrScanProgressDialog();
  useEffect(() => {
    setProgress(value);
    return () => setProgress(undefined);
  }, [value, setProgress]);
  return null;
}
it("五个 OCR worker 合为一个扫描视图，任务数变化不造成弹窗重开", () => {
  const value = scan();
  const jobs = Array.from({ length: 5 }, (_, i) => ({
    jobId: `page-${i}`,
    toolId: "ocr",
    phase: "running",
    current: i * 5,
    total: 100,
    message: `worker${i}`,
    severity: "info" as const,
    outputPaths: [],
  }));
  const { rerender } = render(
    <JobDialogProvider jobs={jobs} nameOf={() => "OCR"}>
      <PublishScan value={value} />
    </JobDialogProvider>,
  );
  expect(screen.getAllByRole("dialog")).toHaveLength(1);
  expect(screen.queryByText("5 个任务进行中")).toBeNull();
  expect(screen.queryByText("worker0")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "后台运行" }));
  rerender(
    <JobDialogProvider jobs={jobs.slice(0, 2)} nameOf={() => "OCR"}>
      <PublishScan value={value} />
    </JobDialogProvider>,
  );
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(
    screen.getByRole("button", { name: "展开 OCR 扫描进度" }),
  ).toBeTruthy();
});
