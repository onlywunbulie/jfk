import { describe, expect, it, vi } from "vitest";
import sharp from "sharp";

vi.mock("server-only", () => ({}));
const { toStoredWebp } = await import("@/lib/process-image");

describe("preparing a fetched image for storage", () => {
  it("crops a photo to the banner's exact shape as WebP, dropping its hidden data", async () => {
    // A landscape JPEG carrying EXIF data, as a phone photo would.
    const photo = await sharp({ create: { width: 2000, height: 1500, channels: 3, background: "#4a90d9" } })
      .jpeg()
      .withExif({ IFD0: { Copyright: "secret location" } })
      .toBuffer();
    expect((await sharp(photo).metadata()).exif).toBeDefined();

    const result = await toStoredWebp(photo, "banner");
    if (!result.ok) throw new Error(result.reason);
    const out = await sharp(Buffer.from(result.bytes)).metadata();
    expect([out.format, out.width, out.height]).toEqual(["webp", 966, 336]);
    expect(out.exif).toBeUndefined();
  });

  it("makes a square picture", async () => {
    const tall = await sharp({ create: { width: 300, height: 900, channels: 3, background: "#e4572e" } }).png().toBuffer();
    const result = await toStoredWebp(tall, "avatar");
    if (!result.ok) throw new Error(result.reason);
    const out = await sharp(Buffer.from(result.bytes)).metadata();
    expect([out.width, out.height]).toEqual([256, 256]);
  });

  it("refuses something that isn't an image", async () => {
    expect(await toStoredWebp(Buffer.from("<svg><script>alert(1)</script></svg>"), "avatar")).toEqual({
      ok: false,
      reason: "That file couldn't be opened as an image.",
    });
  });
});
