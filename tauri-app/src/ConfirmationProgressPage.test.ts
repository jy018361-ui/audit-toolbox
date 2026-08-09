// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { canGenerateConfirmation, readConfirmationCache, type ConfirmationInspection } from "./ConfirmationProgressPage";

function inspection(overrides: Partial<ConfirmationInspection> = {}): ConfirmationInspection {
  return {
    path: "C:\\work\\confirmations.xlsx",
    headers: [],
    preview: [],
    dimensions: { rows: 0, columns: 0 },
    missingColumns: [],
    requiredColumnsPresent: [],
    statistics: { total: 0, bank: 0, trade: 0, projects: 0, units: 0, baseDates: [] },
    outputDirectory: "C:\\work\\函证统计结果",
    willGenerate: { bank: false, trade: false },
    ...overrides,
  };
}

describe("confirmation progress page state", () => {
  beforeEach(() => sessionStorage.clear());

  it("defaults to the legacy both-report workflow", () => {
    expect(readConfirmationCache()).toEqual({ inputPath: "", mode: "both" });
  });

  it("restores a valid per-window selection and rejects invalid modes", () => {
    sessionStorage.setItem("audit-toolbox:confirmation-progress:v1", JSON.stringify({ inputPath: "a.xlsx", mode: "trade" }));
    expect(readConfirmationCache()).toEqual({ inputPath: "a.xlsx", mode: "trade" });
    sessionStorage.setItem("audit-toolbox:confirmation-progress:v1", JSON.stringify({ inputPath: "a.xlsx", mode: "bad" }));
    expect(readConfirmationCache().mode).toBe("both");
  });

  it("enables generation only for the currently inspected valid file", () => {
    expect(canGenerateConfirmation("C:\\work\\confirmations.xlsx", inspection())).toBe(true);
    expect(canGenerateConfirmation("C:\\work\\other.xlsx", inspection())).toBe(false);
    expect(canGenerateConfirmation("C:\\work\\confirmations.xlsx", inspection({ missingColumns: ["函证编号"] }))).toBe(false);
  });
});
