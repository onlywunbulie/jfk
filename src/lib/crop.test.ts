import { describe, expect, it } from "vitest";
import { clampOffset, cropArea } from "@/lib/crop";

/** Equal to a hundredth of a pixel: the canvas draws fractions, so float dust doesn't matter. */
function expectArea(actual: { x: number; y: number; width: number; height: number }, expected: typeof actual) {
  for (const key of ["x", "y", "width", "height"] as const) expect(actual[key]).toBeCloseTo(expected[key], 2);
}

const photo = { width: 4000, height: 3000 }; // a landscape phone photo
const square = { width: 200, height: 200 };
const banner = { width: 322, height: 112 };

describe("cropArea", () => {
  it("takes the middle square of a landscape photo at zoom 1", () => {
    expectArea(cropArea(photo, square, 1, { x: 0, y: 0 }), { x: 500, y: 0, width: 3000, height: 3000 });
  });

  it("takes a smaller middle area when zoomed in", () => {
    expectArea(cropArea(photo, square, 2, { x: 0, y: 0 }), { x: 1250, y: 750, width: 1500, height: 1500 });
  });

  it("follows a drag: dragging the image right shows more of its left side", () => {
    const area = cropArea(photo, square, 1, { x: 30, y: 0 });
    expect(area.x).toBeCloseTo(500 - 30 * (3000 / 200));
    expect(area.width).toBe(3000);
  });

  it("never leaves a gap, however far it is dragged", () => {
    const area = cropArea(photo, banner, 1, { x: 0, y: 10_000 });
    expect(area.y).toBeGreaterThanOrEqual(0);
    expect(area.y + area.height).toBeLessThanOrEqual(photo.height + 1e-9);
    const left = cropArea(photo, square, 1.5, { x: 10_000, y: -10_000 });
    expect(left.x).toBeCloseTo(0);
    expect(left.y + left.height).toBeCloseTo(photo.height);
  });

  it("keeps the frame's shape", () => {
    const area = cropArea(photo, banner, 1.7, { x: -12, y: 40 });
    expect(area.width / area.height).toBeCloseTo(322 / 112);
  });
});

describe("clampOffset", () => {
  it("leaves no room to drag across the side that exactly fits", () => {
    // A landscape photo in a square frame fills the height exactly at zoom 1.
    expect(clampOffset(photo, square, 1, { x: 5, y: 50 })).toEqual({ x: 5, y: 0 });
  });
});
