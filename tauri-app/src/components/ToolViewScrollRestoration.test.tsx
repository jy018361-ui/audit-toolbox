// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Link, MemoryRouter, useNavigate } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import catalog from "../../public/tool-catalog.json";
import { clearToolPageActivityForTests, toolPageIsLive } from "../toolPageActivity";
import { ToolViewScrollRestoration } from "./ToolViewScrollRestoration";

let left = 0;
let top = 0;
let maxTop = Infinity;
const scrollTo = vi.fn((position: ScrollToOptions) => {
  left = position.left ?? 0;
  top = Math.min(position.top ?? 0, maxTop);
});
let resized: ResizeObserverCallback;
const disconnect = vi.fn();

beforeEach(() => {
  left = top = 0;
  maxTop = Infinity;
  scrollTo.mockClear();
  disconnect.mockClear();
  clearToolPageActivityForTests();
  vi.stubGlobal("scrollTo", scrollTo);
  vi.spyOn(window, "scrollX", "get").mockImplementation(() => left);
  vi.spyOn(window, "scrollY", "get").mockImplementation(() => top);
  vi.stubGlobal("ResizeObserver", class {
    constructor(callback: ResizeObserverCallback) { resized = callback; }
    observe = vi.fn();
    disconnect = disconnect;
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function Fixture() {
  const navigate = useNavigate();
  return <>
    <ToolViewScrollRestoration />
    <main id="main-content">
      {catalog.map(tool => <Link key={tool.id} to={tool.route}>{tool.id}</Link>)}
      <Link to="/">工作台</Link>
      <Link to="/settings">设置</Link>
      <Link to="/tools/meeting_minutes/vocabulary">词库</Link>
      <Link to="/tools/meeting_minutes?version=timeline">纪要时间版</Link>
      <button onClick={() => navigate(-1)}>后退</button>
    </main>
  </>;
}

function open(path = "/tools/meeting_minutes") {
  render(<MemoryRouter initialEntries={[path]}><Fixture /></MemoryRouter>);
}

function scroll(topValue: number, leftValue = 0) {
  top = topValue;
  left = leftValue;
  fireEvent.scroll(window);
}

it("所有目录工具分别记住阅读位置，经多个工具往返不会串位", () => {
  open("/");
  catalog.forEach((tool, index) => {
    fireEvent.click(screen.getByRole("link", { name: tool.id }));
    expect(top).toBe(0);
    scroll(300 + index * 17, index);
    expect(toolPageIsLive(tool.id)).toBe(true);
  });
  [...catalog].reverse().forEach((tool) => {
    const index = catalog.indexOf(tool);
    fireEvent.click(screen.getByRole("link", { name: tool.id }));
    expect(top).toBe(300 + index * 17);
    expect(left).toBe(index);
  });
});

it("工作台和设置仍从顶部打开，返回工具与浏览器后退恢复原位置", () => {
  open();
  scroll(940);
  fireEvent.click(screen.getByRole("link", { name: "设置" }));
  expect(top).toBe(0);
  scroll(1500);
  fireEvent.click(screen.getByRole("link", { name: "工作台" }));
  expect(top).toBe(0);
  fireEvent.click(screen.getByRole("button", { name: "后退" }));
  expect(top).toBe(0);
  fireEvent.click(screen.getByRole("button", { name: "后退" }));
  expect(top).toBe(940);
});

it("会议与词库分别记住位置，同页面查询参数变化不强制回顶", () => {
  open();
  scroll(750);
  fireEvent.click(screen.getByRole("link", { name: "词库" }));
  expect(top).toBe(0);
  scroll(240);
  fireEvent.click(screen.getByRole("link", { name: "meeting_minutes" }));
  expect(top).toBe(750);
  scrollTo.mockClear();
  fireEvent.click(screen.getByRole("link", { name: "纪要时间版" }));
  expect(scrollTo).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("link", { name: "词库" }));
  expect(top).toBe(240);
});

it("保存用户主动回到顶部的结果，后续不恢复过时的位置", () => {
  open();
  scroll(900);
  scroll(0);
  fireEvent.click(screen.getByRole("link", { name: "工作台" }));
  fireEvent.click(screen.getByRole("link", { name: "meeting_minutes" }));
  expect(top).toBe(0);
});

it("异步页面暂时过短时在内容展开后恢复，不把截断值存成新位置", () => {
  open();
  scroll(1200);
  fireEvent.click(screen.getByRole("link", { name: "工作台" }));
  maxTop = 100;
  fireEvent.click(screen.getByRole("link", { name: "meeting_minutes" }));
  expect(top).toBe(100);
  fireEvent.scroll(window);
  maxTop = Infinity;
  act(() => resized([], {} as ResizeObserver));
  expect(top).toBe(1200);
  expect(disconnect).toHaveBeenCalled();
});

it("恢复等待期间用户主动滚动后不再强行拉回", () => {
  open();
  scroll(1200);
  fireEvent.click(screen.getByRole("link", { name: "工作台" }));
  maxTop = 100;
  fireEvent.click(screen.getByRole("link", { name: "meeting_minutes" }));
  fireEvent.wheel(window);
  scroll(60);
  expect(disconnect).toHaveBeenCalled();
  maxTop = Infinity;
  act(() => resized([], {} as ResizeObserver));
  expect(top).toBe(60);
  fireEvent.click(screen.getByRole("link", { name: "工作台" }));
  fireEvent.click(screen.getByRole("link", { name: "meeting_minutes" }));
  expect(top).toBe(60);
});

it("仅在会话内记忆，重新挂载不会带入上一次会话的坐标", () => {
  open();
  scroll(850);
  cleanup();
  open();
  expect(top).toBe(0);
});
