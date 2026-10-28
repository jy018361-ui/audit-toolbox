import { describe, expect, it } from "vitest";
import { TOOL_DEFINITIONS } from "./toolDefinitions";
import catalog from "../public/tool-catalog.json";

describe("tool definitions", () => {
  it("registers every production tool", () => {
    expect(Object.keys(TOOL_DEFINITIONS).sort()).toEqual(catalog.map(tool => tool.id).sort());
  });

  it("uses only allow-listed engine method namespaces", () => {
    const allowed = new Set(["file_list", "wp", "confirmation", "excel_merger", "fa", "ts", "kanzhang", "roll_forward", "audipick", "ocr", "fx", "loan", "deposit", "pdf2excel", "fuzzy", "tbje_check", "meeting", "dataflow_run"]);
    for (const definition of Object.values(TOOL_DEFINITIONS)) {
      for (const action of definition.actions) {
        expect(allowed.has(action.method.split(".")[0])).toBe(true);
      }
    }
  });

  it("gives every tool a runnable primary action", () => {
    for (const [id, definition] of Object.entries(TOOL_DEFINITIONS)) {
      if (catalog.find(tool => tool.id === id)?.capabilities.includes("download")) continue;
      expect(definition.actions.some(action => action.tone === "primary")).toBe(true);
    }
  });
});
