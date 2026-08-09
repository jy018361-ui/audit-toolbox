import { describe, expect, it } from "vitest";
import { fileListCanExport, isFileListScan } from "./fileListUi";

describe("file list UI contract", () => {
  it("accepts the Rust scan response", () => {
    expect(isFileListScan({
      sourceDir: "C:\\客户资料", rootName: "客户资料", fileCount: 2,
      maxDepth: 2, previewLimit: 50, outputPath: "C:\\客户资料List.xlsx", preview: [],
    })).toBe(true);
  });

  it("requires both input and output before export", () => {
    expect(fileListCanExport("C:\\source", "C:\\list.xlsx")).toBe(true);
    expect(fileListCanExport("C:\\source", "")).toBe(false);
  });
});

