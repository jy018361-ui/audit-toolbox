export const TAX_TEXT_LAYOUT_VERSION = "tax-display-layout-v2";
export type TaxPdfTextItem = { str?: string; transform?: readonly number[]; width?: number; height?: number };
export type TaxPdfTextPosition = { text: string; x: number; y: number; width: number; height: number };

/**
 * PDF.js text transforms are in the original PDF user space, before /Rotate.
 * Apply the scale-1 display viewport to both text axes, not just its baseline.
 * The resulting advance-box bounds use the displayed page's top-left origin;
 * they describe text layout, not the exact painted glyph outline or a cell.
 */
export function taxPdfTextPositions(items: TaxPdfTextItem[], viewportTransform: readonly number[]): TaxPdfTextPosition[] {
  if (viewportTransform?.length !== 6 || !viewportTransform.every(Number.isFinite)) return [];
  const [a, b, c, d, e, f] = viewportTransform;
  if (Math.abs(a * d - b * c) < 1e-12) return [];
  const round = (value: number) => Math.round(value * 1000) / 1000;
  return items.flatMap((item) => {
    const transform = item.transform;
    if (!item.str?.trim() || transform?.length !== 6 || !transform.every(Number.isFinite)
      || !Number.isFinite(item.width) || !Number.isFinite(item.height) || item.width! <= 0 || item.height! <= 0) return [];
    const horizontalLength = Math.hypot(transform[0], transform[1]);
    const verticalLength = Math.hypot(transform[2], transform[3]);
    if (horizontalLength === 0 || verticalLength === 0) return [];
    const advanceX = transform[0] / horizontalLength * item.width!;
    const advanceY = transform[1] / horizontalLength * item.width!;
    const heightX = transform[2] / verticalLength * item.height!;
    const heightY = transform[3] / verticalLength * item.height!;
    const corners = [[0, 0], [advanceX, advanceY], [heightX, heightY], [advanceX + heightX, advanceY + heightY]].map(([dx, dy]) => {
      const x = transform[4] + dx, y = transform[5] + dy;
      return { x: a * x + c * y + e, y: b * x + d * y + f };
    });
    const x = Math.min(...corners.map((point) => point.x)), y = Math.min(...corners.map((point) => point.y));
    const width = Math.max(...corners.map((point) => point.x)) - x, height = Math.max(...corners.map((point) => point.y)) - y;
    if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return [];
    return [{ text: item.str, x: round(x), y: round(y), width: round(width), height: round(height) }];
  });
}

export function hasLegacyTaxPageLayout(text: string): boolean {
  return text.includes("【PDF文字层定位（");
}
