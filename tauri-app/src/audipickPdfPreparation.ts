import { jobStart, listenJobEvents } from "./api";
import type { JobEvent } from "./types";
import type { AudiPickOperationHandle } from "./audipickOperation";

export const PDF_OCR_LAYOUT_VERSION = "split-spread-v2";

export type PdfOcrRegion = {
  label: "full" | "left" | "right";
  x: number;
  y: number;
  width: number;
  height: number;
};

/**
 * PDF.js has already applied the page rotation when it gives us a viewport.
 * A wide rendered page is therefore the reliable signal for the common
 * "two portrait pages scanned as one landscape page" layout. OCR each leaf
 * independently so the engine cannot interleave the left and right columns.
 */
export function pdfOcrRegions(width: number, height: number): PdfOcrRegion[] {
  const safeWidth = Math.max(1, Math.round(width));
  const safeHeight = Math.max(1, Math.round(height));
  if (safeWidth / safeHeight < 1.25) return [{ label: "full", x: 0, y: 0, width: safeWidth, height: safeHeight }];
  const leftWidth = Math.floor(safeWidth / 2);
  return [
    { label: "left", x: 0, y: 0, width: leftWidth, height: safeHeight },
    { label: "right", x: leftWidth, y: 0, width: safeWidth - leftWidth, height: safeHeight },
  ];
}

export function parseSavedPdfPages(text: string): Map<number, string> {
  return new Map([...text.matchAll(/---PDF第(\d+)页---\n([\s\S]*?)(?=---PDF第\d+页---\n|$)/g)]
    .filter((match) => !match[2].includes("需要先配置 OCR"))
    .map((match) => [Number(match[1]), match[2].trimEnd()]));
}
export function serializePdfPages(pages: Map<number, string>): string {
  return [...pages].sort(([a], [b]) => a - b).map(([page, text]) => `---PDF第${page}页---\n${text}\n`).join("");
}

type PdfTextItem = {
  str?: string;
  hasEOL?: boolean;
};

/**
 * PDF.js may expose one Chinese glyph per text item. Joining every item with a
 * space turns a visually normal clause into `贷 款 人` and later breaks exact
 * evidence checks. Preserve real line endings, keep spaces already present in
 * the PDF, and only synthesize a separator between adjacent ASCII words.
 */
export function pdfTextFromItems(items: PdfTextItem[]): string {
  let output = "";
  let previousValue = "";
  for (const item of items) {
    const value = item.str ?? "";
    if (value) {
      const left = output.at(-1) ?? "";
      const right = value[0] ?? "";
      // Separate PDF.js word runs such as "Loan" + "Agreement", but never
      // split single-glyph runs such as "L"+"P"+"R" or "4"+"0"+"0".
      if (previousValue.length > 1 && value.length > 1 && left && !/\s/u.test(left) && !/^\s/u.test(value) && /[A-Za-z0-9]/u.test(left) && /[A-Za-z0-9]/u.test(right)) output += " ";
      output += value;
      previousValue = value;
    }
    if (item.hasEOL && output && !output.endsWith("\n")) output += "\n";
  }
  return output
    .replace(/([\p{Script=Han}])[\t ]+(?=[\p{Script=Han}])/gu, "$1")
    .replace(/[\t ]+([，。；：！？、])/gu, "$1")
    .replace(/([（【《“‘])[\t ]+/gu, "$1")
    .replace(/[\t ]+([）】》”’])/gu, "$1")
    .replace(/[\t ]{2,}/g, " ")
    .trim();
}

export type PdfTextLayerQuality = {
  usable: boolean;
  reason: "ok" | "too-short" | "garbled";
  suspiciousCharacters: number;
};

/**
 * A PDF can render correctly while its hidden text layer contains a broken
 * ToUnicode map. Detect that per page so only damaged pages are rasterized and
 * sent through OCR.
 */
export function assessPdfTextLayer(text: string): PdfTextLayerQuality {
  const trimmed = text.trim();
  if (trimmed.length < 60) return { usable: false, reason: "too-short", suspiciousCharacters: 0 };
  const compact = [...trimmed.normalize("NFKC")].filter((character) => !/\s/u.test(character));
  const allowed = /[\p{Script=Han}A-Za-z0-9\p{P}%‰￥$¥€+\-=×÷≤≥℃°@#&]/u;
  const suspiciousCharacters = compact.filter((character) => !allowed.test(character)).length;
  const replacementCharacters = compact.filter((character) => character === "�" || /[\uE000-\uF8FF]/u.test(character)).length;
  const threshold = Math.max(8, Math.ceil(compact.length * 0.008));
  const garbled = replacementCharacters > 0 || suspiciousCharacters >= threshold;
  return { usable: !garbled, reason: garbled ? "garbled" : "ok", suspiciousCharacters };
}

/** A page is a normal toolbox worker job: global pause/cancel/history remain shared. */
export async function recognizePdfPage(params: Record<string, unknown>, operation?: AudiPickOperationHandle): Promise<string> {
  await operation?.checkpoint();
  let id: string | undefined;
  const early: JobEvent[] = [];
  let finish: (event: JobEvent) => void = () => {};
  const off = await listenJobEvents((event) => {
    if (!id) early.push(event);
    else if (event.jobId === id) finish(event);
  });
  try {
    const result = new Promise<string>((resolve, reject) => {
      finish = (event) => {
        if (event.phase === "completed") {
          const text = (event.result as { text?: unknown })?.text;
          if (typeof text === "string") resolve(text);
          else reject(new Error("OCR 任务没有返回识别文字。"));
        } else if (["failed", "cancelled", "canceled"].includes(event.phase)) {
          reject(new Error(event.phase === "failed" ? event.message : "识别已取消，已完成页已保存，可稍后继续。"));
        }
      };
    });
    id = await jobStart("audipick.ocr_page", params);
    operation?.attachJob(id);
    early.filter((event) => event.jobId === id).forEach(finish);
    return await result;
  } finally { if (id) operation?.detachJob(id); off(); }
}

export async function preparePdfText(pdf: any, storedText: string, options: {
  ocrReady: boolean;
  reuseCachedOcr?: boolean;
  recognize: (page: any, number: number) => Promise<string>;
  save: (text: string) => Promise<void>;
  progress: (completed: number, total: number) => Promise<void>;
  operation?: AudiPickOperationHandle;
}) {
  const pages = parseSavedPdfPages(storedText);
  const missing: number[] = [];
  let scanned = false;
  let ocrPages = 0;
  let resumedPages = 0;
  for (let number = 1; number <= pdf.numPages; number++) {
    await options.operation?.checkpoint();
    await options.progress(number - 1 - missing.length, pdf.numPages);
    const page = await pdf.getPage(number);
    try {
      const content = await page.getTextContent();
      let text = pdfTextFromItems(content.items as PdfTextItem[]);
      const quality = assessPdfTextLayer(text);
      const layoutViewport = page.getViewport?.({ scale: 1 });
      const isTwoPageSpread = layoutViewport
        ? pdfOcrRegions(layoutViewport.width, layoutViewport.height).length > 1
        : false;
      // A clean-looking text layer can still have unusable reading order when
      // two printed pages share one landscape PDF page. Always rasterize that
      // layout so each leaf is OCRed independently.
      if (!quality.usable || isTwoPageSpread) {
        scanned = true;
        const cached = pages.get(number);
        // Short cached pages can only have come from an earlier OCR call. For
        // long pages, reject a legacy cache when it still contains the broken
        // text-layer noise that caused this fallback.
        if (options.reuseCachedOcr !== false && cached !== undefined && (cached.trim().length < 60 || assessPdfTextLayer(cached).usable)) { text = cached; resumedPages++; }
        else if (options.ocrReady) { text = await options.recognize(page, number); ocrPages++; }
        else { missing.push(number); continue; }
      }
      pages.set(number, text);
      // Commit each page before starting another paid OCR call, including text pages.
      await options.save(serializePdfPages(pages));
    } finally { page.cleanup?.(); }
  }
  await options.progress(pdf.numPages - missing.length, pdf.numPages);
  return { text: serializePdfPages(pages), missing, scanned, ocrPages, resumedPages };
}
