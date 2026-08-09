// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  DEFAULT_THEME,
  THEME_STORAGE_KEY,
  contrastRatio,
  parseColor,
  readableInk,
  relativeLuminance,
  restoreSavedTheme,
} from "./theme";

describe("parseColor", () => {
  it("reads both hex lengths and rgb()", () => {
    expect(parseColor("#fff")).toEqual([255, 255, 255]);
    expect(parseColor("#1e6267")).toEqual([30, 98, 103]);
    expect(parseColor(" rgb(30, 98, 103) ")).toEqual([30, 98, 103]);
  });

  it("returns nothing for values it cannot measure", () => {
    for (const value of ["", "transparent", "var(--brand)", "#12345"])
      expect(parseColor(value)).toBeUndefined();
  });
});

describe("relativeLuminance", () => {
  it("spans black to white", () => {
    expect(relativeLuminance("#000000")).toBeCloseTo(0, 5);
    expect(relativeLuminance("#ffffff")).toBeCloseTo(1, 5);
  });
});

describe("contrastRatio", () => {
  it("reaches the 21:1 maximum for black on white", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 2);
  });

  it("is 1 for a colour against itself, whichever way round", () => {
    expect(contrastRatio("#c62828", "#c62828")).toBeCloseTo(1, 5);
    expect(contrastRatio("#ffffff", "#000000")).toBeCloseTo(
      contrastRatio("#000000", "#ffffff") as number,
      5,
    );
  });
});

describe("readableInk", () => {
  /// The bug this exists for: every yellow theme painted white button labels
  /// on a bright yellow brand colour.
  it("puts dark text on the light brand colours", () => {
    for (const brand of ["#f2c200", "#f3c300", "#f0c419", "#e0a800", "#2dd4bf"])
      expect(readableInk(brand)).toBe("#11181b");
  });

  it("puts light text on the dark brand colours", () => {
    for (const brand of ["#1e6267", "#1d4ed8", "#c62828", "#14353a"])
      expect(readableInk(brand)).toBe("#ffffff");
  });

  /// 利落红白 paints the sidebar with a white `--brand-deep`; the theme's own
  /// `--ink-inverse` is also white, so the nav text disappeared entirely.
  it("keeps text off a white background", () => {
    expect(readableInk("#ffffff")).toBe("#11181b");
  });

  it("leaves unmeasurable colours to the stylesheet", () => {
    expect(readableInk("")).toBeUndefined();
    expect(readableInk("var(--brand)")).toBeUndefined();
  });

  it("always picks the higher-contrast option", () => {
    for (const background of [
      "#ffffff",
      "#000000",
      "#808080",
      "#f2c200",
      "#1e6267",
      "#e0a800",
      "#2dd4bf",
      "#ef9a9a",
    ]) {
      const ink = readableInk(background) as string;
      const other = ink === "#ffffff" ? "#11181b" : "#ffffff";
      expect(contrastRatio(background, ink)).toBeGreaterThanOrEqual(
        contrastRatio(background, other) as number,
      );
    }
  });

  it("honours caller-supplied inks", () => {
    expect(readableInk("#ffffff", "#123456", "#fefefe")).toBe("#123456");
  });
});

describe("restoreSavedTheme", () => {
  function root() {
    const element = document.createElement("html");
    document.body.append(element);
    return element;
  }

  it("applies the saved theme so a restart keeps the user's choice", () => {
    localStorage.setItem(THEME_STORAGE_KEY, "yellow-light");
    expect(restoreSavedTheme(root())).toBe("yellow-light");
    localStorage.removeItem(THEME_STORAGE_KEY);
  });

  it("falls back to the default when nothing is stored", () => {
    localStorage.removeItem(THEME_STORAGE_KEY);
    const element = root();
    expect(restoreSavedTheme(element)).toBe(DEFAULT_THEME);
    expect(element.dataset.theme).toBe(DEFAULT_THEME);
  });

  /// A theme already on the element wins: index.html may set it before the
  /// bundle loads, and re-reading storage would undo that.
  it("keeps a theme already present on the element", () => {
    localStorage.setItem(THEME_STORAGE_KEY, "yellow-light");
    const element = root();
    element.dataset.theme = "teal-dark";
    expect(restoreSavedTheme(element)).toBe("teal-dark");
    localStorage.removeItem(THEME_STORAGE_KEY);
  });
});
