import { describe, expect, it } from "vitest";
import { tsManagerParity } from "./TsManagerParityPage";

describe("TS legacy filter semantics", () => {
  it("combines selected values in the same column as OR and distinct columns as AND", () => {
    expect(
      tsManagerParity.activeFilters(
        { Month: ["01"], "Department Name": ["A", "B", "A"] },
        ["Department Name", "Month"],
      ),
    ).toEqual([
      { field: "Department Name", values: ["A", "B"] },
      { field: "Month", values: ["01"] },
    ]);
  });

  it("preserves the explicit blank filter token", () => {
    expect(
      tsManagerParity.activeFilters({
        "Department Name": [tsManagerParity.BLANK_TOKEN],
      }),
    ).toEqual([{ field: "Department Name", values: ["<空白>"] }]);
  });

  it("treats a complete untruncated selection as no filter", () => {
    expect(
      tsManagerParity.nextSelections(
        { Month: ["01"] },
        "Department Name",
        ["A", "B"],
        { total: 2, truncated: false },
      ),
    ).toEqual({ Month: ["01"] });

    expect(
      tsManagerParity.nextSelections(
        {},
        "Department Name",
        ["A", "B"],
        { total: 10, truncated: true },
      ),
    ).toEqual({ "Department Name": ["A", "B"] });
  });

  it("keeps all checked search results as an explicit filter when the full universe is unknown", () => {
    expect(
      tsManagerParity.nextSelections(
        {},
        "Employee Department Name",
        ["Delivery Center A", "Delivery Center B"],
        { total: 2, truncated: false, keyword: "delivery center" },
      ),
    ).toEqual({
      "Employee Department Name": ["Delivery Center A", "Delivery Center B"],
    });
  });

  it("treats a search-time confirmation that covers every distinct value as no filter", () => {
    // 搜索后 total 是命中数（2），但全量口径 fullTotal=2 表明这已是整列全部
    // 取值：全勾等于不筛选，不能再留一个“什么都没筛掉”的条件误导界面。
    expect(
      tsManagerParity.nextSelections(
        { Month: ["01"] },
        "Employee Department Name",
        ["Delivery Center A", "Delivery Center B"],
        {
          total: 2,
          truncated: false,
          keyword: "delivery center",
          fullTotal: 2,
        },
      ),
    ).toEqual({ Month: ["01"] });

    // 全量口径大于勾选数时是真实筛选，必须保留。
    expect(
      tsManagerParity.nextSelections(
        {},
        "Employee Department Name",
        ["Delivery Center A", "Delivery Center B"],
        {
          total: 2,
          truncated: false,
          keyword: "delivery center",
          fullTotal: 66,
        },
      ),
    ).toEqual({
      "Employee Department Name": ["Delivery Center A", "Delivery Center B"],
    });
  });

  it("keeps the sheet catalog while requiring the newly selected sheet to reload", () => {
    expect(
      tsManagerParity.switchSheetInspect(
        {
          sheets: ["Data", "Archive"],
          selectedSheet: "Data",
          headers: ["Hours"],
          preview: [["1"]],
          dimensions: { rows: 1, columns: 1 },
        },
        "Archive",
      ),
    ).toEqual({
      sheets: ["Data", "Archive"],
      selectedSheet: "Archive",
      headers: [],
      preview: [],
      dimensions: undefined,
      defaults: undefined,
    });
  });

  it("passes the typed keyword to the distinct-value lookup", () => {
    expect(
      tsManagerParity.filterLookupParams(
        {
          inputPath: "C:/data/ts.xlsx",
          sheet: "Data",
          headerRow: "2",
          headerDepth: 2,
        },
        "Department Name",
        "delivery center",
      ),
    ).toMatchObject({
      sheet: "Data",
      headerRow: 2,
      headerDepth: 2,
      field: "Department Name",
      keyword: "delivery center",
    });
  });

  it("opens the file dialog in the legacy shared folder until a file has been picked", () => {
    expect(tsManagerParity.pickerStartDirectory(null)).toBe(
      tsManagerParity.LEGACY_DEFAULT_FOLDER,
    );
    expect(tsManagerParity.pickerStartDirectory("   ")).toBe(
      tsManagerParity.LEGACY_DEFAULT_FOLDER,
    );
    expect(tsManagerParity.LEGACY_DEFAULT_FOLDER.startsWith("\\\\")).toBe(true);
    expect(tsManagerParity.LEGACY_DEFAULT_FOLDER.endsWith("\\FY27")).toBe(true);
  });

  it("reopens the dialog where the last picked file lives", () => {
    expect(
      tsManagerParity.parentDirectory("\\\\server\\share\\FY26\\ts.xlsx"),
    ).toBe("\\\\server\\share\\FY26");
    expect(tsManagerParity.parentDirectory("C:/data/ts.xlsx")).toBe("C:/data");
    expect(tsManagerParity.parentDirectory("ts.xlsx")).toBe("");
    expect(
      tsManagerParity.pickerStartDirectory("D:\\Timesheet\\FY27"),
    ).toBe("D:\\Timesheet\\FY27");
  });

  it("enables export once headers are loaded, before choosing a save path", () => {
    expect(tsManagerParity.canStartTsExport([])).toBe(false);
    expect(tsManagerParity.canStartTsExport(["Hours"])).toBe(true);
  });

  it("suggests a timestamped export file name so repeated exports never overwrite", () => {
    expect(
      tsManagerParity.defaultExportFileName(new Date(2026, 10, 7, 9, 5, 3)),
    ).toBe("工时报告_20261107_090503.xlsx");
    expect(
      tsManagerParity.defaultExportFileName(new Date(2026, 0, 2, 23, 59, 59)),
    ).toBe("工时报告_20260102_235959.xlsx");
  });
});
