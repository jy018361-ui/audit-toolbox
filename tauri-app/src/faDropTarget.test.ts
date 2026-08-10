import { describe, expect, it } from "vitest";
import { faDropSlotAtPosition } from "./faDropTarget";

const rect = (left: number, right: number, top = 100, bottom = 180) => ({
  left,
  right,
  top,
  bottom,
});

describe("faDropSlotAtPosition", () => {
  it("uses the actual begin/end upload bounds at 150% display scaling", () => {
    const slots = [
      ["begin", rect(280, 650)] as const,
      ["end", rect(680, 1050)] as const,
    ];

    // CSS x=620 is the right side of the begin area. Its physical x=930 used
    // to be compared with window.innerWidth / 2 and was misrouted to end.
    expect(faDropSlotAtPosition({ x: 930, y: 210 }, 1.5, slots)).toBe("begin");
    expect(faDropSlotAtPosition({ x: 1020, y: 210 }, 1.5, slots)).toBe("end");
  });

  it("does not assign a file when the pointer is between or outside upload areas", () => {
    const slots = [
      ["begin", rect(280, 650)] as const,
      ["end", rect(680, 1050)] as const,
    ];

    expect(faDropSlotAtPosition({ x: 665, y: 140 }, 1, slots)).toBeNull();
    expect(faDropSlotAtPosition({ x: 500, y: 220 }, 1, slots)).toBeNull();
  });

  it("supports the addition and disposal upload areas without window halves", () => {
    const slots = [
      ["addition", rect(260, 620, 240, 320)] as const,
      ["disposal", rect(650, 1010, 240, 320)] as const,
    ];

    expect(faDropSlotAtPosition({ x: 390, y: 280 }, 1, slots)).toBe("addition");
    expect(faDropSlotAtPosition({ x: 800, y: 280 }, 1, slots)).toBe("disposal");
  });
});
