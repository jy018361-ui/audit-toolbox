import { describe, expect, it } from "vitest";
import {
  parseRollForwardCraRatio,
  rollForwardCraWriteRecords,
} from "./rollForwardUi";

describe("Roll Forward legacy CRA write semantics", () => {
  const rows = [
    { subject_code: "C", match_status: "将写入", apply: true },
    { subject_code: "J1", match_status: "需确认", apply: true },
    { subject_code: "K1", match_status: "将写入", apply: false },
  ];

  it("only sends explicitly applied records whose status is 将写入", () => {
    expect(rollForwardCraWriteRecords(rows, true)).toEqual([rows[0]]);
  });

  it("sends no CRA records when company-level writing is disabled", () => {
    expect(rollForwardCraWriteRecords(rows, false)).toEqual([]);
  });

  it("recomputes the numeric ratio after a user edits the displayed text", () => {
    expect(parseRollForwardCraRatio("75%")).toBe(0.75);
    expect(parseRollForwardCraRatio("0.75")).toBe(0.75);
    expect(parseRollForwardCraRatio("75")).toBe(0.75);
    expect(parseRollForwardCraRatio("N/A")).toBeUndefined();
  });
});
