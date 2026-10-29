// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { OcrReadingView } from "./OcrReadingView";
import type { OcrDocumentDetail } from "./ocrTypes";

afterEach(cleanup);
const current: OcrDocumentDetail = {
  document: { id: "one", projectId: "project", name: "测试扫描件.pdf", mimeType: "application/pdf", totalPages: 2, revision: 1, status: "completed", sha256: "sample" },
  pages: [1, 2].map(page => ({ page, text: `第${page}页原文`, originalText: `第${page}页原文`, tables: [], originalTables: [], revision: 1, status: "completed", warnings: [] })),
  extractions: [],
};
const props = { documents: [current], current, pageNumber: 1, sourceImage: "data:image/png;base64,c291cmNl", sourceError: "", fullText: false, busy: false, onLocate: vi.fn(), onCopy: vi.fn() };

it("缩放限定50–400%，翻页保留比例且回到左上，切换文件恢复适应宽度", () => {
  const { rerender } = render(<OcrReadingView {...props} />);
  const zoom = () => screen.getByLabelText("扫描件缩放比例");
  const image = screen.getByRole("img");
  expect(zoom()).toHaveTextContent("100%");
  for (let n = 0; n < 14; n++) fireEvent.click(screen.getByRole("button", { name: "放大扫描件" }));
  expect(zoom()).toHaveTextContent("400%");
  expect(screen.getByRole("button", { name: "放大扫描件" })).toBeDisabled();
  expect(image.parentElement).toHaveStyle({ width: "400%" });
  expect(image).toHaveAttribute("src", props.sourceImage);
  const viewport = screen.getByRole("region", { name: "扫描件图片" });
  viewport.scrollLeft = 400; viewport.scrollTop = 700;
  rerender(<OcrReadingView {...props} pageNumber={2} />);
  expect(zoom()).toHaveTextContent("400%");
  expect(viewport.scrollLeft).toBe(0); expect(viewport.scrollTop).toBe(0);
  fireEvent.click(screen.getByRole("button", { name: "适应宽度" }));
  expect(zoom()).toHaveTextContent("100%");
  for (let n = 0; n < 4; n++) fireEvent.click(screen.getByRole("button", { name: "缩小扫描件" }));
  expect(zoom()).toHaveTextContent("50%");
  expect(screen.getByRole("button", { name: "缩小扫描件" })).toBeDisabled();
  rerender(<OcrReadingView {...props} current={{ ...current, document: { ...current.document, id: "two" } }} />);
  expect(zoom()).toHaveTextContent("100%");
  fireEvent.click(screen.getByRole("button", { name: "复制本页原文" }));
  expect(props.onCopy).toHaveBeenLastCalledWith("第1页原文");
});

it("扫描页未加载时禁用缩放，全篇模式仅展示和复制完整原文", () => {
  const { rerender } = render(<OcrReadingView {...props} sourceImage="" sourceError="扫描页加载失败" />);
  for (const name of ["缩小扫描件", "放大扫描件", "适应宽度"])
    expect(screen.getByRole("button", { name })).toBeDisabled();
  expect(screen.getByText("扫描页加载失败")).toBeInTheDocument();
  rerender(<OcrReadingView {...props} fullText />);
  expect(screen.queryByRole("group", { name: "扫描件缩放" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "复制全部原文" }));
  expect(props.onCopy).toHaveBeenLastCalledWith("测试扫描件.pdf\n第 1 页\n第1页原文\n\n第 2 页\n第2页原文");
});

it("原文中的已确认表格原位显示行列及空格，复制仍保留完整来源且不追加尾部表格", () => {
  const rows = [["序号", "名称", "数量", "单价", "金额", "备注"], ["1", "电力", "00123", "0.57", "801.00", ""], ["2", "", "", "", "", ""]];
  const originalText = `合同前文\n${rows.map(row => row.join("\t")).join("\n")}\n合同后文`;
  const sample = { ...current, pages: [{ ...current.pages[0], text: originalText, originalText,
    originalTables: [{ id: "grid", title: "", rows }], tables: [], warnings: [
      "本页含未能安全还原的排版或公式标记，已保留原内容，请对照扫描件核对。",
      "本页涉及公式，请对照扫描件核对上下标、分数线和运算符；识别文字不作为可计算公式。",
      "页面方向判断不充分",
    ] }] };
  const { rerender } = render(<OcrReadingView {...props} current={sample} documents={[sample]} />);
  const table = screen.getByRole("table");
  expect(table.querySelectorAll("tr")).toHaveLength(3);
  expect(table.querySelectorAll("tr")[1].children).toHaveLength(6);
  expect(table.querySelectorAll("tr")[2].children).toHaveLength(6);
  expect(table).toHaveTextContent("00123");
  expect(table.querySelectorAll("tr")[1].lastElementChild).toBeEmptyDOMElement();
  expect(table.querySelector("caption")).toBeNull();
  expect(screen.queryByText(/本页含未能安全还原|本页涉及公式/)).not.toBeInTheDocument();
  expect(screen.getByText("页面方向判断不充分")).toBeInTheDocument();
  expect(screen.getAllByRole("table")).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "复制本页原文" }));
  expect(props.onCopy).toHaveBeenLastCalledWith(originalText);
  rerender(<OcrReadingView {...props} current={sample} documents={[sample]} fullText />);
  expect(screen.getAllByRole("table")).toHaveLength(1);
  // A separately corrected table cannot overwrite the initial original text.
  rerender(<OcrReadingView {...props} current={{ ...sample, pages: [{ ...sample.pages[0], originalText: "未结构化的原文" }] }} documents={[sample]} />);
  expect(screen.queryByRole("table")).not.toBeInTheDocument();
});

it("左键拖动平移原扫描件，抬起或丢失捕获立即停止且右键不移动", () => {
  render(<OcrReadingView {...props} />);
  const viewport = screen.getByRole("region", { name: "扫描件图片" });
  Object.defineProperties(viewport, { clientWidth: { value: 600 }, clientHeight: { value: 400 } });
  let captured = false;
  viewport.setPointerCapture = vi.fn(() => { captured = true; });
  viewport.hasPointerCapture = vi.fn(() => captured);
  viewport.releasePointerCapture = vi.fn(() => { captured = false; });
  function pointer(type: string, x: number, y: number, button = 0, buttons = 1) {
    const event = new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button, buttons });
    Object.defineProperties(event, { pointerId: { value: 5 }, pointerType: { value: "mouse" } });
    fireEvent(viewport, event);
  }
  viewport.scrollLeft = 220; viewport.scrollTop = 300;
  pointer("pointerdown", 300, 200);
  pointer("pointermove", 250, 150);
  expect(viewport.scrollLeft).toBe(270); expect(viewport.scrollTop).toBe(350);
  expect(viewport).toHaveClass("is-panning");
  pointer("pointerup", 250, 150, 0, 0);
  pointer("pointermove", 200, 100, 0, 0);
  expect(viewport.scrollLeft).toBe(270); expect(viewport.scrollTop).toBe(350);
  expect(viewport).not.toHaveClass("is-panning");
  pointer("pointerdown", 300, 200, 2, 2);
  pointer("pointermove", 100, 50, 2, 2);
  expect(viewport.scrollLeft).toBe(270);
  pointer("pointerdown", 300, 200);
  fireEvent(viewport, new Event("lostpointercapture", { bubbles: true }));
  pointer("pointermove", 100, 50);
  expect(viewport.scrollLeft).toBe(270);
  expect(viewport).not.toHaveClass("is-panning");
  expect(screen.getByRole("img")).toHaveAttribute("src", props.sourceImage);
});

it("已识别单列表格及校对表格按行显示，普通正文子串不替换成表格", () => {
  const originalText = "合同前文\n项目\n00123\n原文结尾";
  const corrected = "校对前文\n项目\n00456\n校对结尾";
  const sample = { ...current, pages: [{ ...current.pages[0], text: corrected, originalText,
    originalTables: [{ id: "original", title: "原始单列表", rows: [["项目"], ["00123"]] }],
    tables: [{ id: "corrected", title: "校对单列表", rows: [["项目"], ["00456"]] }] }] };
  const { rerender } = render(<OcrReadingView {...props} current={sample} documents={[sample]} />);
  expect(screen.getByRole("table", { name: "原始单列表" })).toHaveTextContent("00123");
  const detail = screen.getByText("查看此前保存的校对正文（导出和摘录继续使用此版本）").closest("details")!;
  detail.open = true;
  expect(screen.getByRole("table", { name: "校对单列表" })).toHaveTextContent("00456");
  fireEvent.click(screen.getByRole("button", { name: "复制本页原文" }));
  expect(props.onCopy).toHaveBeenLastCalledWith(originalText);
  rerender(<OcrReadingView {...props} current={{ ...sample, pages: [{ ...sample.pages[0],
    originalText: "合同项目\n00123以及其他内容", originalTables: sample.pages[0].originalTables }] }} />);
  expect(screen.queryByRole("table", { name: "原始单列表" })).not.toBeInTheDocument();
});
