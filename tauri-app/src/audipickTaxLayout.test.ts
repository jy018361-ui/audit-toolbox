import { describe, expect, it } from "vitest";
import { hasLegacyTaxPageLayout, TAX_TEXT_LAYOUT_VERSION, taxPdfTextPositions } from "./audipickTaxLayout";

describe("tax PDF display coordinates", () => {
  it("reproduces the real A106000 90 degree page and keeps its data row horizontal", () => {
    // Actual PDF.js geometry from a local A106000 page; amounts/names are omitted.
    const positions = taxPdfTextPositions([
      { str: "1", transform: [0, 8, -8, 0, 104.45, 74.63], width: 4, height: 8 },
      { str: "2015", transform: [0, 8, -8, 0, 104.45, 201.34], width: 16, height: 8 },
    ], [0, 1, 1, 0, 0, 0]);
    expect(positions[0]).toEqual({ text: "1", x: 74.63, y: 96.45, width: 4, height: 8 });
    expect(positions[1]).toEqual({ text: "2015", x: 201.34, y: 96.45, width: 16, height: 8 });
  });

  it("uses top-left bounding boxes for an unrotated PDF and respects scale and crop translation", () => {
    expect(taxPdfTextPositions([{ str: "项目", transform: [10, 0, 0, 10, 30, 700], width: 20, height: 10 }], [2, 0, 0, -2, -20, 1600])).toEqual([
      { text: "项目", x: 40, y: 180, width: 40, height: 20 },
    ]);
  });

  it("applies the 180 and 270 degree page transforms instead of assuming raw x is the column", () => {
    const item = { str: "表头", transform: [10, 0, 0, 10, 20, 30], width: 40, height: 10 };
    expect(taxPdfTextPositions([item], [-1, 0, 0, 1, 100, 0])).toEqual([{ text: "表头", x: 40, y: 30, width: 40, height: 10 }]);
    expect(taxPdfTextPositions([item], [0, -1, -1, 0, 200, 100])).toEqual([{ text: "表头", x: 160, y: 40, width: 10, height: 40 }]);
  });

  it("does not expose nonfinite, degenerate, or blank text geometry", () => {
    const invalid = [
      { str: " ", transform: [8, 0, 0, 8, 1, 2], width: 4, height: 8 },
      { str: "坏", transform: [8, 0, 0, 8, NaN, 2], width: 4, height: 8 },
      { str: "坏", transform: [0, 0, 0, 8, 1, 2], width: 4, height: 8 },
      { str: "坏", transform: [8, 0, 0, 8, 1, 2], width: 0, height: 8 },
    ];
    expect(taxPdfTextPositions(invalid, [1, 0, 0, -1, 0, 100])).toEqual([]);
    expect(taxPdfTextPositions([], [1, 2])).toEqual([]);
  });

  it("marks v2 coordinates and detects the exact legacy cache label without rejecting plain OCR", () => {
    expect(TAX_TEXT_LAYOUT_VERSION).toBe("tax-display-layout-v2");
    expect(hasLegacyTaxPageLayout("表格\n【PDF文字层定位（单位：PDF点，坐标原点为左下角；仅辅助核对表格位置）】\n[]")).toBe(true);
    expect(hasLegacyTaxPageLayout(`表格\n【PDF文字层定位 v2（${TAX_TEXT_LAYOUT_VERSION}；坐标原点为左上角）】\n[]`)).toBe(false);
    expect(hasLegacyTaxPageLayout("|表头|金额|\n|项目|0.00|")).toBe(false);
  });
});
