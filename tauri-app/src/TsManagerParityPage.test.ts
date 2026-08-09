import { describe, expect, it } from "vitest";
import { tsManagerParity } from "./TsManagerParityPage";

describe("TS legacy filter semantics", () => {
  it("combines duplicate field rows as OR values and distinct fields as AND filters", () => {
    expect(
      tsManagerParity.groupedFilters([
        { id: 1, field: "Department Name", value: "A", keyword: "", values: [], loading: false },
        { id: 2, field: "Department Name", value: "B", keyword: "", values: [], loading: false },
        { id: 3, field: "Month", value: "01", keyword: "", values: [], loading: false },
      ]),
    ).toEqual([
      { field: "Department Name", values: ["A", "B"] },
      { field: "Month", values: ["01"] },
    ]);
  });

  it("preserves the explicit blank filter token", () => {
    expect(
      tsManagerParity.groupedFilters([
        { id: 1, field: "Department Name", value: "<空白>", keyword: "", values: [], loading: false },
      ]),
    ).toEqual([{ field: "Department Name", values: ["<空白>"] }]);
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
          filters: [],
          exportRawData: false,
          outputPath: "",
        },
        {
          id: 1,
          field: "Department Name",
          value: "",
          keyword: "delivery center",
          values: [],
          loading: false,
        },
      ),
    ).toMatchObject({
      sheet: "Data",
      headerRow: 2,
      field: "Department Name",
      keyword: "delivery center",
    });
  });
});
