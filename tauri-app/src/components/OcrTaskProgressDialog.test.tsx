// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { useEffect } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { OcrTaskProgressDialog } from "./OcrTaskProgressDialog";
import { JobDialogProvider } from "./JobDialog";
import {
  registerOcrOperationJob,
  useOcrScanProgressDialog,
  type OcrTaskProgress,
} from "../ocrProgress";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
const task = (changes: Partial<OcrTaskProgress> = {}): OcrTaskProgress => ({
  kind: "task",
  phase: "extracting",
  fileName: "合同.pdf",
  fileIndex: 1,
  fileCount: 2,
  completed: 0,
  total: 2,
  message: "正在核对第 1/3 段",
  paused: false,
  stopping: false,
  controlling: false,
  onPause: vi.fn(),
  onCancel: vi.fn(),
  ...changes,
});

it("等待有动态状态与耗时，分段和文件完成才推进，导出阶段保留同一弹窗", () => {
  vi.useFakeTimers();
  const { rerender } = render(<OcrTaskProgressDialog progress={task()} />);
  const dialog = screen.getByRole("dialog");
  expect(
    screen.getByRole("progressbar", { name: "分段摘录进度" }),
  ).not.toHaveAttribute("value");
  act(() => vi.advanceTimersByTime(5000));
  expect(screen.getByText("已用时 5 秒")).toBeInTheDocument();
  rerender(
    <OcrTaskProgressDialog
      progress={task({ activity: { completed: 1, total: 3 } })}
    />,
  );
  expect(
    screen.getByRole("progressbar", { name: "分段摘录进度" }),
  ).toHaveAttribute("value", "1");
  expect(
    screen.getByRole("progressbar", { name: "文件处理进度" }),
  ).toHaveAttribute("value", "0");
  rerender(
    <OcrTaskProgressDialog
      progress={task({
        phase: "exporting",
        completed: 2,
        message: "正在生成 Excel",
      })}
    />,
  );
  expect(screen.getByRole("dialog")).toBe(dialog);
  expect(
    screen.getByRole("progressbar", { name: "导出进度" }),
  ).not.toHaveAttribute("value");
  expect(screen.getByText("已用时 5 秒")).toBeInTheDocument();
});

function Publish({ progress }: { progress?: OcrTaskProgress }) {
  const { setProgress } = useOcrScanProgressDialog();
  useEffect(() => {
    setProgress(progress);
  }, [progress, setProgress]);
  useEffect(() => () => setProgress(undefined), [setProgress]);
  return null;
}

it("多个分段任务与导出共用一个进度窗，间隙和迟到事件不重新弹出，后台状态延续", () => {
  const worker = (id: string) => ({
    jobId: id,
    toolId: "ocr",
    phase: "running",
    current: 0,
    total: 1,
    message: "单次请求进度",
    severity: "info" as const,
    outputPaths: [],
  });
  const view = (
    jobs: ReturnType<typeof worker>[],
    progress?: OcrTaskProgress,
  ) => (
    <JobDialogProvider jobs={jobs} nameOf={() => "OCR"}>
      <Publish progress={progress} />
    </JobDialogProvider>
  );
  registerOcrOperationJob("task-late");
  const { rerender } = render(view([worker("task-first")], task()));
  expect(screen.getAllByRole("dialog")).toHaveLength(1);
  const dialog = screen.getByRole("dialog");
  expect(screen.queryByText("单次请求进度")).not.toBeInTheDocument();
  rerender(view([], task({ activity: { completed: 1, total: 3 } })));
  expect(screen.getByRole("dialog")).toBe(dialog);
  fireEvent.click(screen.getByRole("button", { name: "后台运行" }));
  rerender(view([worker("task-second")], task({ phase: "saving" })));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  rerender(
    view([worker("task-export")], task({ phase: "exporting", completed: 2 })),
  );
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  fireEvent.click(
    screen.getByRole("button", { name: "展开 OCR 摘录与导出进度" }),
  );
  expect(screen.getByText("正在导出")).toBeInTheDocument();
  rerender(view([worker("task-late")]));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

it("暂停与取消只操作整批任务，取消失败可重试", () => {
  const progress = task();
  const { rerender } = render(<OcrTaskProgressDialog progress={progress} />);
  fireEvent.click(screen.getByRole("button", { name: "暂停" }));
  fireEvent.click(screen.getByRole("button", { name: "取消任务" }));
  expect(progress.onPause).toHaveBeenCalledOnce();
  expect(progress.onCancel).toHaveBeenCalledOnce();
  rerender(
    <OcrTaskProgressDialog
      progress={task({ stopping: true, error: "取消通道失败" })}
    />,
  );
  expect(screen.getByRole("button", { name: "重试取消" })).toBeEnabled();
  expect(screen.getByRole("button", { name: "暂停" })).toBeDisabled();
});
