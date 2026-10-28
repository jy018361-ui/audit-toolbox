// @vitest-environment jsdom
import {
  cleanup,
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

afterEach(cleanup);
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
