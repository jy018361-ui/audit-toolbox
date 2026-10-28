import { ocrCall } from "./ocrApi";
import { loadAudipickAssets } from "./audipickAssets";
import type { OcrDocument } from "./ocrTypes";

export type OcrRotation = 0 | 90 | 180 | 270;

export type OcrSource = {
  totalPages: number;
  render: (page: number, rotation?: OcrRotation) => Promise<string>;
  dispose: () => void;
};

function validateRotation(rotation: OcrRotation): void {
  if (![0, 90, 180, 270].includes(rotation)) {
    throw new Error("页面方向只支持 0、90、180 或 270 度。");
  }
}

/** Leave original image bytes intact unless the user explicitly corrects its direction. */
async function rotateImage(url: string, rotation: OcrRotation): Promise<string> {
  validateRotation(rotation);
  if (rotation === 0) return url;
  const image = new Image();
  await new Promise<void>((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () => reject(new Error("无法读取扫描页，请重新导入文件。"));
    image.src = url;
  });
  const width = image.naturalWidth;
  const height = image.naturalHeight;
  if (width <= 0 || height <= 0) throw new Error("扫描页尺寸无效。");
  const canvas = window.document.createElement("canvas");
  const quarterTurn = rotation === 90 || rotation === 270;
  canvas.width = quarterTurn ? height : width;
  canvas.height = quarterTurn ? width : height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("无法创建页面预览。");
  context.fillStyle = "white";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.translate(canvas.width / 2, canvas.height / 2);
  context.rotate(rotation * Math.PI / 180);
  context.drawImage(image, -width / 2, -height / 2);
  return canvas.toDataURL("image/png");
}

/** Render pages independently. All PDF assets are bundled with the application. */
export async function openOcrSource(document: OcrDocument): Promise<OcrSource> {
  if (document.mimeType === "application/pdf") {
    await loadAudipickAssets();
    const { dataBase64 } = await ocrCall<{
      mimeType: string;
      dataBase64: string;
    }>("ocr.document_bytes", { documentId: document.id });
    const pdfjs = window.pdfjsLib;
    if (!pdfjs) throw new Error("PDF 预览组件加载失败，请重试。");
    pdfjs.GlobalWorkerOptions.workerSrc =
      "/audipick-pdfjs/legacy/build/pdf.worker.min.js";
    const task = pdfjs.getDocument({
      data: Uint8Array.from(atob(dataBase64), (character) =>
        character.charCodeAt(0),
      ),
      cMapUrl: "/audipick-pdfjs/cmaps/",
      cMapPacked: true,
      standardFontDataUrl: "/audipick-pdfjs/standard_fonts/",
    });
    const pdf = await task.promise;
    let disposed = false;
    const activePages = new Map<number, number>();
    return {
      totalPages: pdf.numPages,
      async render(number, rotation = 0) {
        if (disposed) throw new Error("文件预览已关闭。");
        validateRotation(rotation);
        activePages.set(number, (activePages.get(number) ?? 0) + 1);
        let page;
        try {
          page = await pdf.getPage(number);
          const viewport = page.getViewport({ scale: 1 });
          const scale = Math.min(
            // Small contract text and ruled cells need more detail than a UI preview.
            // Keep the existing long-edge cap to bound page memory and request size.
            3,
            2600 / Math.max(viewport.width, viewport.height),
          );
          // PDF.js already applies the PDF's own /Rotate metadata by default.
          // A manual correction is added to that direction, never applied twice.
          const target = page.getViewport(rotation === 0 ? { scale } : {
            scale,
            rotation: ((viewport.rotation ?? page.rotate ?? 0) + rotation) % 360,
          });
          const canvas = window.document.createElement("canvas");
          canvas.width = Math.ceil(target.width);
          canvas.height = Math.ceil(target.height);
          const context = canvas.getContext("2d");
          if (!context) throw new Error("无法创建页面预览。");
          await page.render({
            canvasContext: context,
            viewport: target,
            background: "white",
          }).promise;
          return canvas.toDataURL("image/png");
        } finally {
          const remaining = (activePages.get(number) ?? 1) - 1;
          if (remaining === 0) {
            activePages.delete(number);
            page?.cleanup?.();
          } else {
            activePages.set(number, remaining);
          }
        }
      },
      dispose() {
        disposed = true;
        void pdf.destroy();
      },
    };
  }
  if (/tiff|bmp/i.test(document.mimeType)) {
    const { pages } = await ocrCall<{
      pages: { page: number; imageBase64: string }[];
    }>("ocr.image_pages", { documentId: document.id });
    return {
      totalPages: pages.length,
      render: async (page, rotation = 0) => {
        const image = pages.find((item) => item.page === page);
        if (!image) throw new Error("未找到该扫描页。");
        const url = image.imageBase64.startsWith("data:")
          ? image.imageBase64
          : `data:image/png;base64,${image.imageBase64}`;
        return rotateImage(url, rotation);
      },
      dispose() {},
    };
  }
  const { dataBase64, mimeType } = await ocrCall<{
    mimeType: string;
    dataBase64: string;
  }>("ocr.document_bytes", { documentId: document.id });
  const url = `data:${mimeType};base64,${dataBase64}`;
  return { totalPages: 1, render: async (_page, rotation = 0) => rotateImage(url, rotation), dispose() {} };
}
