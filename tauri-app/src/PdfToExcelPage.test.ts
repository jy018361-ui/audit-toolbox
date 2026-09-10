import { describe, expect, it } from "vitest";

import { pdfToExcelStep } from "./PdfToExcelPage";

describe("PDF 转 Excel 步骤状态", () => {
  it("根据文件、任务和结果推进步骤", () => {
    expect(pdfToExcelStep(0, false, false)).toBe(0);
    expect(pdfToExcelStep(2, false, false)).toBe(1);
    expect(pdfToExcelStep(2, true, false)).toBe(2);
    expect(pdfToExcelStep(2, false, true)).toBe(2);
  });
});
