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
