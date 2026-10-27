import { ocrCall } from "./ocrApi";
import { loadAudipickAssets } from "./audipickAssets";
import type { OcrDocument } from "./ocrTypes";

export type OcrSource = {
  totalPages: number;
  render: (page: number) => Promise<string>;
  dispose: () => void;
};

/** Render one page at a time. All PDF assets are bundled with the application. */
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
    return {
      totalPages: pdf.numPages,
      async render(number) {
        if (disposed) throw new Error("文件预览已关闭。");
        const page = await pdf.getPage(number);
        try {
          const viewport = page.getViewport({ scale: 1 });
          const scale = Math.min(
            2,
            2600 / Math.max(viewport.width, viewport.height),
          );
          const target = page.getViewport({ scale });
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
          page.cleanup?.();
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
      render: async (page) => {
        const image = pages.find((item) => item.page === page);
        if (!image) throw new Error("未找到该扫描页。");
        return image.imageBase64.startsWith("data:")
          ? image.imageBase64
          : `data:image/png;base64,${image.imageBase64}`;
      },
      dispose() {},
    };
  }
  const { dataBase64, mimeType } = await ocrCall<{
    mimeType: string;
    dataBase64: string;
  }>("ocr.document_bytes", { documentId: document.id });
  const url = `data:${mimeType};base64,${dataBase64}`;
  return { totalPages: 1, render: async () => url, dispose() {} };
}
