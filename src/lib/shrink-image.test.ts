import { describe, expect, it } from "vitest";
import { isWebp } from "@/lib/shrink-image";

const bytes = (text: string) => new TextEncoder().encode(text);

describe("isWebp", () => {
  it("accepts a WebP header and nothing else", () => {
    expect(isWebp(bytes("RIFF\x10\x00\x00\x00WEBPVP8 "))).toBe(true);
    expect(isWebp(bytes("\x89PNG\r\n\x1a\n0000000"))).toBe(false);
    expect(isWebp(bytes("<svg xmlns='http://www.w3.org/2000/svg'>"))).toBe(false);
    expect(isWebp(bytes("RIFF\x10\x00\x00\x00WAVEfmt "))).toBe(false);
    expect(isWebp(bytes("RIFF"))).toBe(false);
  });
});
