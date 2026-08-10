export type FaDropSlot = "begin" | "end" | "addition" | "disposal";

type Point = { x: number; y: number };
type Bounds = Pick<DOMRect, "left" | "right" | "top" | "bottom">;

/**
 * Tauri reports file-drop positions in physical pixels while DOM rectangles
 * use CSS pixels. Convert the pointer before testing the real upload areas;
 * the surrounding window midpoint is unrelated to where those areas render.
 */
export function faDropSlotAtPosition(
  physicalPosition: Point,
  scaleFactor: number,
  slots: ReadonlyArray<readonly [FaDropSlot, Bounds | null]>,
): FaDropSlot | null {
  const scale = Number.isFinite(scaleFactor) && scaleFactor > 0 ? scaleFactor : 1;
  const x = physicalPosition.x / scale;
  const y = physicalPosition.y / scale;

  for (const [slot, bounds] of slots) {
    if (
      bounds &&
      x >= bounds.left &&
      x <= bounds.right &&
      y >= bounds.top &&
      y <= bounds.bottom
    ) {
      return slot;
    }
  }
  return null;
}
