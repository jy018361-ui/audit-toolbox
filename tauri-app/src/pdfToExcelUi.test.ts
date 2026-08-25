import { describe, expect, it } from "vitest";
import {
  dedupePdfPaths,
  fileStatusLabel,
  fileStatusPill,
  filterPdfPaths,
  isPdfConvertResult,
  isPdfFile,
  pdfFileName,
  summarizeFileResults,
  summarizeFileResultsText,
  type PdfConvertFileResult,
} from "./pdfToExcelUi";

function row(overrides: Partial<PdfConvertFileResult>): PdfConvertFileResult {
  return {
    name: "回函.pdf",
    status: "成功",
    pages: 10,
    textRows: 100,
    tables: 2,
    tableDataRows: 40,
    outputPath: "C:\\回函\\回函.xlsx",
    error: "",
    ...overrides,
  };
}

describe("回函 PDF 转 Excel 纯函数", () => {
  it("识别大小写不敏感的 PDF 文件", () => {
    expect(isPdfFile("回函.PDF")).toBe(true);
    expect(isPdfFile("bank.Confirmation.pdf")).toBe(true);
    expect(isPdfFile("  扫描件.pdf ")).toBe(true);
    expect(isPdfFile("清单.xlsx")).toBe(false);
    expect(isPdfFile("pdf")).toBe(false);
    expect(isPdfFile("回函.pdf.exe")).toBe(false);
  });

  it("去重忽略大小写并保留首次出现的顺序", () => {
    expect(
      dedupePdfPaths([
        "C:\\回函\\A.pdf",
        "C:\\回函\\B.pdf",
        "C:\\回函\\a.pdf",
        "C:\\回函\\A.PDF",
      ]),
    ).toEqual(["C:\\回函\\A.pdf", "C:\\回函\\B.pdf"]);
  });

  it("文件夹展开结果只保留 PDF 并去重", () => {
    expect(
      filterPdfPaths([
        "C:\\回函\\a.pdf",
        "C:\\回函\\b.PDF",
        "C:\\回函\\说明.xlsx",
        "C:\\回函\\B.pdf",
        "C:\\回函\\回函.pdf.exe",
      ]),
    ).toEqual(["C:\\回函\\a.pdf", "C:\\回函\\b.PDF"]);
  });

  it("从完整路径提取文件名，兼容反斜杠与正斜杠", () => {
    expect(pdfFileName("C:\\回函\\子公司\\a.pdf")).toBe("a.pdf");
    expect(pdfFileName("D:/scan/b.PDF")).toBe("b.PDF");
    expect(pdfFileName("a.pdf")).toBe("a.pdf");
  });

  it("汇总成功失败份数与页数、行数、表格合计", () => {
    const summary = summarizeFileResults([
      row({ name: "a.pdf", pages: 298, textRows: 227, tables: 5, tableDataRows: 6785 }),
      row({ name: "b.pdf", pages: 12, textRows: 80, tables: 1, tableDataRows: 25 }),
      row({
        name: "c.pdf",
        status: "失败",
        pages: 0,
        textRows: 0,
        tables: 0,
        tableDataRows: 0,
        outputPath: "",
        error: "文件已加密，无法读取。",
      }),
    ]);
    expect(summary.total).toBe(3);
    expect(summary.successCount).toBe(2);
    expect(summary.failCount).toBe(1);
    expect(summary.totalPages).toBe(310);
    expect(summary.totalTextRows).toBe(307);
    expect(summary.totalTables).toBe(6);
    expect(summary.totalTableDataRows).toBe(6810);
  });

  it("个别行缺少数字字段时汇总按 0 兜底", () => {
    const summary = summarizeFileResults([
      row({ pages: undefined as unknown as number, textRows: undefined as unknown as number }),
    ]);
    expect(summary.totalPages).toBe(0);
    expect(summary.totalTextRows).toBe(0);
    expect(summary.successCount).toBe(1);
  });

  it("状态列显示文本：正常行成功，带错误或失败状态的行失败", () => {
    expect(fileStatusLabel(row({}))).toBe("成功");
    expect(fileStatusLabel(row({ status: "失败", error: "读取失败" }))).toBe("失败");
    // 状态词还是"成功"但带了错误文案：按失败呈现，避免误导。
    expect(fileStatusLabel(row({ error: "导出中断" }))).toBe("失败");
    expect(fileStatusPill(row({}))).toBe("pill ready");
    expect(fileStatusPill(row({ status: "失败", error: "读取失败" }))).toBe("pill danger");
  });

  it("汇总文案包含份数、成败数与合计页数", () => {
    const text = summarizeFileResultsText(
      summarizeFileResults([
        row({ pages: 298 }),
        row({ status: "失败", pages: 0, textRows: 0, tables: 0, tableDataRows: 0, outputPath: "", error: "加密" }),
      ]),
    );
    expect(text).toContain("共 2 份");
    expect(text).toContain("成功 1、失败 1");
    expect(text).toContain("298 页");
  });

  it("校验任务结果形状：files 数组与 manifestPath 缺一不可", () => {
    expect(
      isPdfConvertResult({
        files: [row({})],
        manifestPath: "C:\\回函\\处理清单.xlsx",
        successCount: 1,
        failCount: 0,
        outputPaths: ["C:\\回函\\回函.xlsx"],
      }),
    ).toBe(true);
    expect(isPdfConvertResult(null)).toBe(false);
    expect(isPdfConvertResult({ files: [] })).toBe(false);
    expect(isPdfConvertResult({ files: [], manifestPath: 1 })).toBe(false);
  });
});
