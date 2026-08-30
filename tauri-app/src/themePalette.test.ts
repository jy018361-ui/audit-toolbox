import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { contrastRatio, readableInk } from "./theme";

const css = readFileSync(new URL("./styles.css", import.meta.url), "utf8");

const themeIds = [
  "classic-dark",
  "yellow-light",
  "blue-white",
  "red-white",
  "yellow-blue",
  "yellow-green",
  "red-yellow-ivory",
  "teal-dark",
] as const;

function variablesFor(theme: string): Record<string, string> {
  const escaped = theme.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const block = new RegExp(
    `\\[data-theme=["']${escaped}["']\\]\\s*\\{([^}]*)\\}`,
    "i",
  ).exec(css)?.[1];
  expect(block, `missing CSS block for ${theme}`).toBeTruthy();
  return Object.fromEntries(
    [...(block ?? "").matchAll(/(--[\w-]+)\s*:\s*(#[\da-f]{3,6})\s*;/gi)].map(
      ([, name, value]) => [name, value.toLowerCase()],
    ),
  );
}

describe("redesigned theme palettes", () => {
  it("leaves the default deep-green palette unchanged", () => {
    expect(variablesFor("green-dark")).toMatchObject({
      "--brand": "#1e6267",
      "--brand-deep": "#14353a",
      "--surface": "#ffffff",
      "--surface-page": "#edf1ee",
    });
  });

  it.each(themeIds)("defines a complete surface and state system for %s", (id) => {
    const tokens = variablesFor(id);
    for (const token of [
      "--brand",
      "--brand-deep",
      "--brand-soft",
      "--ink",
      "--label",
      "--text-muted",
      "--surface",
      "--surface-sunken",
      "--surface-muted",
      "--surface-page",
      "--border",
      "--accent",
      "--accent-foreground",
      "--success-bg",
      "--success-fg",
      "--warning-bg",
      "--warning-fg",
      "--danger-bg",
      "--danger-fg",
    ]) {
      expect(tokens[token], `${id} is missing ${token}`).toMatch(/^#[\da-f]{6}$/);
    }
  });

  it.each(themeIds)("keeps working text readable in %s", (id) => {
    const t = variablesFor(id);
    for (const [foreground, background] of [
      ["--ink", "--surface"],
      ["--ink", "--surface-page"],
      ["--label", "--surface"],
      ["--text-muted", "--surface"],
      ["--text-muted", "--surface-page"],
      ["--brand-link", "--surface"],
      ["--brand-link", "--surface-page"],
      ["--brand-accent", "--brand-deep"],
      ["--on-dark", "--brand-deep"],
      ["--on-dark-muted", "--brand-deep"],
      ["--accent-foreground", "--accent"],
      ["--success-fg", "--success-bg"],
      ["--warning-fg", "--warning-bg"],
      ["--danger-fg", "--danger-bg"],
    ] as const) {
      expect(
        contrastRatio(t[foreground], t[background]),
        `${id}: ${foreground} on ${background}`,
      ).toBeGreaterThanOrEqual(4.5);
    }
  });

  it.each(themeIds)("always has readable primary-button text in %s", (id) => {
    const t = variablesFor(id);
    const foreground = readableInk(t["--brand"]);
    expect(contrastRatio(t["--brand"], foreground as string)).toBeGreaterThanOrEqual(4.5);
  });
});
