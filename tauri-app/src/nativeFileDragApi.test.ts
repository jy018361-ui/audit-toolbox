// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
const native = vi.hoisted(() => ({ subscribe: vi.fn() }));
vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({ onDragDropEvent: native.subscribe }) }));
import { listenNativeFileDragEvents } from "./api";
afterEach(() => { delete (window as any).__TAURI_INTERNALS__; vi.clearAllMocks(); });

it("桌面上传直接订阅 WebView 原生拖放，保留实际投递路径", async () => {
  (window as any).__TAURI_INTERNALS__ = {};
  const stop = vi.fn();
  native.subscribe.mockResolvedValue(stop);
  const receive = vi.fn();
  expect(await listenNativeFileDragEvents(receive)).toBe(stop);
  const forward = native.subscribe.mock.calls[0][0];
  forward({ payload: { type: "enter", position: { x: 12, y: 23 } } });
  forward({ payload: { type: "drop", paths: ["C:/会议.WMV"], position: { x: 12, y: 23 } } });
  forward({ payload: { type: "leave" } });
  expect(receive.mock.calls.map(([event]) => event)).toEqual([
    { type: "enter" }, { type: "drop", paths: ["C:/会议.WMV"] }, { type: "leave" },
  ]);
});

it("浏览器预览不注册桌面事件", async () => {
  const off = await listenNativeFileDragEvents(vi.fn());
  expect(native.subscribe).not.toHaveBeenCalled();
  expect(off()).toBeUndefined();
});
