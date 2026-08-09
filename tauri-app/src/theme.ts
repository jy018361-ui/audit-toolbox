/**
 * Readable text colours derived from whatever colour a theme actually uses.
 *
 * Each theme used to hand-pair its backgrounds with a foreground, and the
 * pairings drifted: 利落红白 ends up painting the sidebar white on white
 * (`--brand-deep` and `--ink-inverse` are both `#ffffff`), and every yellow
 * theme puts white button labels on a bright yellow `--brand`.  Picking the
 * foreground from the background's measured luminance removes the whole class
 * of mistake and keeps working for themes nobody has written yet.
 */

/// Candidates for text sitting on a theme colour.  Near-black rather than pure
/// black so a light surface does not read as a hard cut-out.
const INK_ON_LIGHT = "#11181b";
const INK_ON_DARK = "#ffffff";

/// Theme background -> the variable holding text drawn on top of it.
const CONTRAST_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ["--brand", "--on-brand"],
  ["--brand-deep", "--on-brand-deep"],
  ["--brand-soft", "--on-brand-soft"],
  ["--accent", "--on-accent"],
];

export function parseColor(value: string): [number, number, number] | undefined {
  const text = String(value ?? "").trim();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(text);
  if (hex) {
    const digits =
      hex[1].length === 3
        ? [...hex[1]].map((digit) => digit + digit).join("")
        : hex[1];
    return [0, 2, 4].map((index) =>
      Number.parseInt(digits.slice(index, index + 2), 16),
    ) as [number, number, number];
  }
  const rgb = /^rgba?\(([^)]+)\)$/i.exec(text);
  if (rgb) {
    const parts = rgb[1]
      .split(/[,\s/]+/)
      .filter(Boolean)
      .slice(0, 3)
      .map(Number);
    if (parts.length === 3 && parts.every((part) => Number.isFinite(part)))
      return parts as [number, number, number];
  }
  return undefined;
}

/** WCAG 2.1 relative luminance; `undefined` when the colour cannot be read. */
export function relativeLuminance(color: string): number | undefined {
  const rgb = parseColor(color);
  if (!rgb) return undefined;
  const [red, green, blue] = rgb.map((value) => {
    const ratio = Math.min(255, Math.max(0, value)) / 255;
    return ratio <= 0.03928 ? ratio / 12.92 : ((ratio + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

/** WCAG contrast ratio, 1 (identical) to 21 (black on white). */
export function contrastRatio(a: string, b: string): number | undefined {
  const first = relativeLuminance(a);
  const second = relativeLuminance(b);
  if (first === undefined || second === undefined) return undefined;
  const [light, dark] =
    first >= second ? [first, second] : [second, first];
  return (light + 0.05) / (dark + 0.05);
}

/**
 * Whichever of the two inks reads better on `background`.
 *
 * Returns `undefined` for a colour we cannot measure — the caller then leaves
 * the stylesheet's own value alone rather than guessing.
 */
export function readableInk(
  background: string,
  onLight: string = INK_ON_LIGHT,
  onDark: string = INK_ON_DARK,
): string | undefined {
  const dark = contrastRatio(background, onLight);
  const light = contrastRatio(background, onDark);
  if (dark === undefined || light === undefined) return undefined;
  return dark >= light ? onLight : onDark;
}

/**
 * Publish `--on-*` variables for the theme currently applied to `root`.
 *
 * Set as inline custom properties so they win over the stylesheet and are
 * recomputed on every theme switch.
 */
export function applyReadableForegrounds(
  root: HTMLElement = document.documentElement,
): void {
  const style = getComputedStyle(root);
  for (const [background, foreground] of CONTRAST_PAIRS) {
    const ink = readableInk(style.getPropertyValue(background));
    if (ink) root.style.setProperty(foreground, ink);
    else root.style.removeProperty(foreground);
  }
}

export const THEME_STORAGE_KEY = "audit-toolbox.theme";
export const DEFAULT_THEME = "green-dark";

/**
 * Put the saved theme on `<html>` before the app renders.
 *
 * The picker lives on the settings page, and so did the only code that restored
 * the saved choice — so a restart came up in the default theme until the user
 * opened settings again, which reads as the preference not having been saved.
 */
export function restoreSavedTheme(
  root: HTMLElement = document.documentElement,
): string {
  let saved = root.dataset.theme;
  if (!saved) {
    try {
      saved = localStorage.getItem(THEME_STORAGE_KEY) ?? undefined;
    } catch {
      /* private mode or a locked-down profile: fall back to the default */
    }
  }
  const theme = saved || DEFAULT_THEME;
  root.dataset.theme = theme;
  applyReadableForegrounds(root);
  return theme;
}
