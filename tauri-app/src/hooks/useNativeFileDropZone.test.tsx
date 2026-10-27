// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { useNativeFileDropZone } from "./useNativeFileDropZone";
import { listenNativeFileDragEvents, type NativeFileDragEvent } from "../api";

vi.mock("../api", () => ({ listenNativeFileDragEvents: vi.fn() }));
afterEach(() => { cleanup(); vi.resetAllMocks(); });

function Zone({ enabled = true, hidden = false, onDrop, onError }: {
  enabled?: boolean; hidden?: boolean;
  onDrop: (paths: string[]) => void | Promise<void>;
  onError?: (reason: unknown) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const { highlight } = useNativeFileDropZone({ containerRef: ref, enabled, onDrop, onError });
  return <section hidden={hidden}><div ref={ref} data-testid="zone" data-highlight={highlight} /></section>;
}

it("原生悬停高亮、离开取消，投递使用当前回调且不重复订阅", async () => {
  let receive!: (event: NativeFileDragEvent) => void;
  const stop = vi.fn();
  vi.mocked(listenNativeFileDragEvents).mockImplementation(async (callback) => { receive = callback; return stop; });
  const first = vi.fn(), latest = vi.fn();
  const view = render(<Zone onDrop={first} />);
  await act(async () => receive({ type: "enter" }));
  expect(screen.getByTestId("zone")).toHaveAttribute("data-highlight", "true");
  await act(async () => receive({ type: "leave" }));
  expect(screen.getByTestId("zone")).toHaveAttribute("data-highlight", "false");
  view.rerender(<Zone onDrop={latest} />);
  await act(async () => receive({ type: "drop", paths: ["C:/单证.pdf"] }));
  expect(first).not.toHaveBeenCalled();
  expect(latest).toHaveBeenCalledExactlyOnceWith(["C:/单证.pdf"]);
  expect(listenNativeFileDragEvents).toHaveBeenCalledTimes(1);
  view.unmount();
  expect(stop).toHaveBeenCalledOnce();
  await act(async () => receive({ type: "drop", paths: ["C:/晚到.pdf"] }));
  expect(latest).toHaveBeenCalledTimes(1);
});

it("忙碌及保活隐藏页不消费原生拖入文件", async () => {
  let receive!: (event: NativeFileDragEvent) => void;
  vi.mocked(listenNativeFileDragEvents).mockImplementation(async (callback) => { receive = callback; return vi.fn(); });
  const onDrop = vi.fn();
  const view = render(<Zone enabled={false} onDrop={onDrop} />);
  await act(async () => receive({ type: "drop", paths: ["C:/a.pdf"] }));
  view.rerender(<Zone hidden onDrop={onDrop} />);
  await act(async () => receive({ type: "drop", paths: ["C:/a.pdf"] }));
  expect(onDrop).not.toHaveBeenCalled();
  view.rerender(<Zone onDrop={onDrop} />);
  await act(async () => receive({ type: "drop", paths: ["C:/b.pdf"] }));
  expect(onDrop).toHaveBeenCalledExactlyOnceWith(["C:/b.pdf"]);
});

it("卸载后才建立的原生监听立即释放，错误交给当前页面", async () => {
  let finish!: (off: () => void) => void;
  vi.mocked(listenNativeFileDragEvents).mockReturnValue(new Promise(resolve => { finish = resolve; }));
  const view = render(<Zone onDrop={vi.fn()} />);
  view.unmount();
  const stop = vi.fn();
  await act(async () => finish(stop));
  expect(stop).toHaveBeenCalledOnce();
  const reason = new Error("原生监听失败");
  vi.mocked(listenNativeFileDragEvents).mockRejectedValue(reason);
  const onError = vi.fn();
  render(<Zone onDrop={vi.fn()} onError={onError} />);
  await act(async () => {});
  expect(onError).toHaveBeenCalledWith(reason);
});
