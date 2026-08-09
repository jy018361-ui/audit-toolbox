import { describe, expect, it } from "vitest";
import { TOOL_DEFINITIONS } from "./toolDefinitions";

describe("tool definitions", () => {
  it("registers all nine production tools", () => {
    expect(Object.keys(TOOL_DEFINITIONS)).toHaveLength(9);
  });

  it("uses only allow-listed engine method namespaces", () => {
    const allowed = new Set(["file_list", "wp", "confirmation", "excel_merger", "fa", "ts", "kanzhang", "roll_forward", "audipick"]);
    for (const definition of Object.values(TOOL_DEFINITIONS)) {
      for (const action of definition.actions) {
        expect(allowed.has(action.method.split(".")[0])).toBe(true);
      }
    }
  });

  it("gives every tool a runnable primary action", () => {
    for (const definition of Object.values(TOOL_DEFINITIONS)) {
      expect(definition.actions.some(action => action.tone === "primary")).toBe(true);
    }
  });
});
