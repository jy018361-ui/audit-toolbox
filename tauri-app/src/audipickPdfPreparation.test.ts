import { beforeEach, describe, expect, it, vi } from "vitest";
import { assessPdfTextLayer, pdfOcrRegions, pdfTextFromItems, preparePdfText, recognizePdfPage, serializePdfPages } from "./audipickPdfPreparation";
const api = vi.hoisted(() => ({ jobStart: vi.fn(), listenJobEvents: vi.fn() }));
vi.mock("./api", () => api);
beforeEach(() => vi.resetAllMocks());
const text = "这是可读取的完整合同文字层".repeat(12);
const pdf = (values: Array<string | Array<{ str: string; hasEOL?: boolean }>>) => ({ numPages: values.length, getPage: async (page: number) => ({ getTextContent: async () => ({ items: Array.isArray(values[page - 1]) ? values[page - 1] : [{ str: values[page - 1] }] }), cleanup: vi.fn() }) });
describe("上传后文字准备", () => {
  it("纯文字 PDF 不依赖 OCR 或 AI 配置，逐页保存", async () => {
    const recognize = vi.fn(); const save = vi.fn(); const progress = vi.fn();
    const result = await preparePdfText(pdf([text, text]), "", { ocrReady: false, recognize, save, progress });
    expect(recognize).not.toHaveBeenCalled();
    expect(save).toHaveBeenCalledTimes(2);
    expect(result.missing).toEqual([]);
    expect(result.text).toContain("---PDF第2页---");
  });
  it("混合 PDF 只识别扫描页，复用少于60字及空白页的已完成结果", async () => {
    const recognize = vi.fn(async (_page: any, _number: number) => "新识别正文");
    const cached = serializePdfPages(new Map([[2, "签字"], [3, ""]]));
    const result = await preparePdfText(pdf([text, "", "", ""]), cached, { ocrReady: true, recognize, save: vi.fn(), progress: vi.fn() });
    expect(recognize).toHaveBeenCalledTimes(1);
    expect(recognize.mock.calls[0][1]).toBe(4);
    expect(result.resumedPages).toBe(2);
  });
  it("中途失败保留已经保存的页，续跑只识别未完成页", async () => {
    let saved = "";
    const recognize = vi.fn().mockResolvedValueOnce("已识别").mockRejectedValueOnce(new Error("额度不足"));
    const options = { ocrReady: true, recognize, save: async (value: string) => { saved = value; }, progress: vi.fn() };
    await expect(preparePdfText(pdf(["", ""]), "", options)).rejects.toThrow("额度不足");
    expect(saved).toContain("已识别");
    recognize.mockResolvedValue("第二页");
    const result = await preparePdfText(pdf(["", ""]), saved, options);
    expect(result.resumedPages).toBe(1);
    expect(result.ocrPages).toBe(1);
  });
  it("未配置时保留文字页，标出缺失页；旧占位符不视为OCR缓存", async () => {
    const save = vi.fn();
    const result = await preparePdfText(pdf([text, ""]), "---PDF第2页---\n【本页文字层过少，需要先配置 OCR 后识别】\n", {
      ocrReady: false, recognize: vi.fn(), save, progress: vi.fn(),
    });
    expect(result.missing).toEqual([2]);
    expect(result.text).not.toContain("需要先配置");
    expect(result.text).toContain(text);
  });

  it("按 PDF.js 文字块重组中文，不再主动插入字间空格", () => {
    expect(pdfTextFromItems([
      { str: "贷" }, { str: "款" }, { str: "人", hasEOL: true }, { str: "有权" }, { str: "提前还款" },
    ])).toBe("贷款人\n有权提前还款");
    expect(pdfTextFromItems([{ str: "Loan" }, { str: "Agreement" }])).toBe("Loan Agreement");
    expect(pdfTextFromItems([{ str: "L" }, { str: "P" }, { str: "R" }, { str: "5" }, { str: "Y" }])).toBe("LPR5Y");
    expect(pdfTextFromItems([{ str: "4" }, { str: "0" }, { str: "0" }])).toBe("400");
  });

  it("有足够文字但隐藏文字层明显乱码时逐页改走 OCR", async () => {
    const broken = `${"贷款人借款人合同约定".repeat(20)} ∴ 冖 ψ Ⅰ ∵ 〓 △ ⊥ ♂ γ`;
    expect(assessPdfTextLayer(broken)).toMatchObject({ usable: false, reason: "garbled" });
    const recognize = vi.fn(async (_page: any, _number: number) => "OCR重新识别后的正常合同正文".repeat(8));
    const result = await preparePdfText(pdf([broken, text]), "", { ocrReady: true, recognize, save: vi.fn(), progress: vi.fn() });
    expect(recognize).toHaveBeenCalledTimes(1);
    expect(recognize.mock.calls[0][1]).toBe(1);
    expect(result.ocrPages).toBe(1);
    expect(result.text).toContain("OCR重新识别后的正常合同正文");
  });

  it("旧缓存仍是乱码文字层时不复用；未配置 OCR 则明确标记缺失页", async () => {
    const broken = `${"借款合同条款".repeat(24)} ∴ 冖 ψ Ⅰ ∵ 〓 △ ⊥ ♂ γ`;
    const cached = serializePdfPages(new Map([[1, broken]]));
    const recognize = vi.fn(async () => text);
    const retried = await preparePdfText(pdf([broken]), cached, { ocrReady: true, recognize, save: vi.fn(), progress: vi.fn() });
    expect(recognize).toHaveBeenCalledOnce();
    expect(retried.resumedPages).toBe(0);
    const unavailable = await preparePdfText(pdf([broken]), cached, { ocrReady: false, recognize: vi.fn(), save: vi.fn(), progress: vi.fn() });
    expect(unavailable.missing).toEqual([1]);
  });

  it("横向双页扫描拆成左、右两个竖页，普通竖页保持整页", () => {
    expect(pdfOcrRegions(2038, 1401)).toEqual([
      { label: "left", x: 0, y: 0, width: 1019, height: 1401 },
      { label: "right", x: 1019, y: 0, width: 1019, height: 1401 },
    ]);
    expect(pdfOcrRegions(1401, 2038)).toEqual([
      { label: "full", x: 0, y: 0, width: 1401, height: 2038 },
    ]);
  });

  it("横向双页即使文字层字符正常也强制拆页 OCR，避免左右栏交错", async () => {
    const recognize = vi.fn(async () => "按左页右页重新识别的正文");
    const widePdf = { numPages: 1, getPage: async () => ({
      getTextContent: async () => ({ items: [{ str: text }] }),
      getViewport: () => ({ width: 840.6, height: 595.3 }),
      cleanup: vi.fn(),
    }) };
    const result = await preparePdfText(widePdf, "", { ocrReady: true, reuseCachedOcr: false, recognize, save: vi.fn(), progress: vi.fn() });
    expect(recognize).toHaveBeenCalledOnce();
    expect(result.scanned).toBe(true);
    expect(result.text).toContain("按左页右页重新识别的正文");
  });

  it("OCR 布局版本升级时不复用旧整页缓存，完成后才能复用新缓存", async () => {
    const cached = serializePdfPages(new Map([[1, "旧版左右页交错但字符看似正常".repeat(10)]]));
    const recognize = vi.fn(async () => "新版分左右页识别正文");
    const refreshed = await preparePdfText(pdf([""]), cached, { ocrReady: true, reuseCachedOcr: false, recognize, save: vi.fn(), progress: vi.fn() });
    expect(recognize).toHaveBeenCalledOnce();
    expect(refreshed.resumedPages).toBe(0);
    recognize.mockClear();
    const resumed = await preparePdfText(pdf([""]), refreshed.text, { ocrReady: true, reuseCachedOcr: true, recognize, save: vi.fn(), progress: vi.fn() });
    expect(recognize).not.toHaveBeenCalled();
    expect(resumed.resumedPages).toBe(1);
  });
});
it("OCR 走共享 worker，处理早到的完成事件并解除订阅", async () => {
  let notify: any; const off = vi.fn();
  api.listenJobEvents.mockImplementation(async (fn) => { notify = fn; return off; });
  api.jobStart.mockImplementation(async () => {
    notify({ jobId: "ocr", phase: "completed", result: { text: "完成" } }); return "ocr";
  });
  expect(await recognizePdfPage({ page: 1 })).toBe("完成");
  expect(api.jobStart).toHaveBeenCalledWith("audipick.ocr_page", { page: 1 });
  expect(off).toHaveBeenCalledOnce();
});
it("OCR 取消拒绝并解除订阅，不当作成功文字", async () => {
  const off = vi.fn(); let notify: any;
  api.listenJobEvents.mockImplementation(async (fn) => { notify = fn; return off; });
  api.jobStart.mockImplementation(async () => { notify({ jobId: "ocr", phase: "cancelled", message: "" }); return "ocr"; });
  await expect(recognizePdfPage({})).rejects.toThrow("已完成页已保存");
  expect(off).toHaveBeenCalledOnce();
});
