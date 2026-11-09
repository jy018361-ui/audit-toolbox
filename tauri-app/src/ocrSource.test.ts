// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { openOcrSource, type OcrRotation } from "./ocrSource";
import type { OcrDocument } from "./ocrTypes";

const mocks = vi.hoisted(() => ({ call: vi.fn(), assets: vi.fn() }));
vi.mock("./ocrApi", () => ({ ocrCall: mocks.call }));
vi.mock("./audipickAssets", () => ({ loadAudipickAssets: mocks.assets }));

const scan = (mimeType: string): OcrDocument => ({
  id: "scan", projectId: "project", name: "扫描件", mimeType,
  totalPages: 1, revision: 0, status: "pending", sha256: "test",
});
const context = {
  fillStyle: "", fillRect: vi.fn(), translate: vi.fn(), rotate: vi.fn(), drawImage: vi.fn(),
};
let imageLoads: string[];

beforeEach(() => {
  vi.clearAllMocks();
  imageLoads = [];
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(context as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockImplementation(function (this: HTMLCanvasElement) {
    return `data:image/png;${this.width}x${this.height}`;
  });
  vi.stubGlobal("Image", class {
    naturalWidth = 800;
    naturalHeight = 1200;
    onload?: () => void;
    onerror?: () => void;
    set src(url: string) { imageLoads.push(url); queueMicrotask(() => this.onload?.()); }
  });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function pdfPage(metadataRotation: number) {
  const page = {
    rotate: metadataRotation,
    getViewport: vi.fn(({ scale, rotation = metadataRotation }: { scale: number; rotation?: number }) => ({
      width: (rotation % 180 === 0 ? 800 : 1200) * scale,
      height: (rotation % 180 === 0 ? 1200 : 800) * scale,
      rotation,
    })),
    render: vi.fn(() => ({ promise: Promise.resolve() })),
    cleanup: vi.fn(),
  };
  const pdf = { numPages: 3, getPage: vi.fn(async () => page), destroy: vi.fn() };
  mocks.call.mockResolvedValue({ dataBase64: "cGRm", mimeType: "application/pdf" });
  vi.stubGlobal("pdfjsLib", { GlobalWorkerOptions: {}, getDocument: () => ({ promise: Promise.resolve(pdf) }) });
  return { page, pdf };
}

it("keeps PDF metadata rotation by default and adds manual correction exactly once", async () => {
  const { page } = pdfPage(90);
  const source = await openOcrSource(scan("application/pdf"));
  await expect(source.render(1)).resolves.toBe("data:image/png;2600x1734");
  expect(page.getViewport.mock.calls[1][0]).toEqual({ scale: 2600 / 1200 });
  await expect(source.render(1, 90)).resolves.toBe("data:image/png;1734x2600");
  expect(page.getViewport.mock.calls[3][0]).toEqual({ scale: 2600 / 1200, rotation: 180 });
  await source.render(1, 270);
  expect(page.getViewport.mock.calls[5][0]).toEqual({ scale: 2600 / 1200, rotation: 0 });
});

it("renders three pages concurrently and cleans up a shared page only when all its renders finish", async () => {
  const { page } = pdfPage(0);
  const finishes: (() => void)[] = [];
  page.render.mockImplementation(() => ({ promise: new Promise<void>((resolve) => finishes.push(resolve)) }));
  const source = await openOcrSource(scan("application/pdf"));
  const first = source.render(1);
  const second = source.render(1, 180);
  const third = source.render(2);
  await vi.waitFor(() => expect(finishes).toHaveLength(3));
  finishes[0]();
  await first;
  expect(page.cleanup).not.toHaveBeenCalled();
  finishes[1]();
  await second;
  expect(page.cleanup).toHaveBeenCalledTimes(1);
  finishes[2]();
  await third;
  expect(page.cleanup).toHaveBeenCalledTimes(2);
});

it.each(["image/png", "image/jpeg", "image/bmp", "image/tiff"])("keeps %s bytes untouched at zero rotation", async (mimeType) => {
  mocks.call.mockResolvedValue(/bmp|tiff/.test(mimeType)
    ? { pages: [{ page: 1, imageBase64: "c2Nhbg==" }] }
    : { mimeType, dataBase64: "c2Nhbg==" });
  const source = await openOcrSource(scan(mimeType));
  const original = `data:${/bmp|tiff/.test(mimeType) ? "image/png" : mimeType};base64,c2Nhbg==`;
  await expect(source.render(1)).resolves.toBe(original);
  await expect(source.render(1, 0)).resolves.toBe(original);
  expect(imageLoads).toEqual([]);
  expect(HTMLCanvasElement.prototype.toDataURL).not.toHaveBeenCalled();
});

it.each<OcrRotation>([90, 180, 270])("rotates raster pixels by %s degrees and swaps dimensions only for quarter turns", async (rotation) => {
  mocks.call.mockResolvedValue({ mimeType: "image/png", dataBase64: "c2Nhbg==" });
  const source = await openOcrSource(scan("image/png"));
  await expect(source.render(1, rotation)).resolves.toBe(rotation === 180 ? "data:image/png;800x1200" : "data:image/png;1200x800");
  expect(context.rotate).toHaveBeenCalledWith(rotation * Math.PI / 180);
  expect(context.drawImage).toHaveBeenCalledWith(expect.anything(), -400, -600);
  expect(context.fillRect).toHaveBeenCalledWith(0, 0, rotation === 180 ? 800 : 1200, rotation === 180 ? 1200 : 800);
});

it.each(["image/bmp", "image/tiff"])("rotates decoded %s pages and preserves prefixed image data", async (mimeType) => {
  mocks.call.mockResolvedValue({ pages: [
    { page: 1, imageBase64: "first" }, { page: 2, imageBase64: "data:image/png;base64,second" },
  ] });
  const source = await openOcrSource(scan(mimeType));
  expect(source.totalPages).toBe(2);
  await expect(source.render(2, 90)).resolves.toBe("data:image/png;1200x800");
  expect(imageLoads).toEqual(["data:image/png;base64,second"]);
  await expect(source.render(3)).rejects.toThrow("未找到该扫描页");
});

it("rejects unsupported angles and rendering after PDF disposal", async () => {
  const { pdf } = pdfPage(0);
  const source = await openOcrSource(scan("application/pdf"));
  await expect(source.render(1, 45 as OcrRotation)).rejects.toThrow("页面方向只支持");
  expect(pdf.getPage).not.toHaveBeenCalled();
  source.dispose();
  await expect(source.render(1)).rejects.toThrow("文件预览已关闭");
  expect(pdf.destroy).toHaveBeenCalledOnce();
});
