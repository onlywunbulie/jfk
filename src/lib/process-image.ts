import "server-only";
import sharp from "sharp";
import { IMAGE_SIZES, MAX_STORED_BYTES, isWebp, type ImageKind } from "@/lib/shrink-image";

/**
 * The server's version of what the browser does before an upload
 * (lib/shrink-image.ts): decode, crop from the centre to the exact stored
 * size, and write a fresh WebP. Used for images Rallied fetched itself
 * (a link Claude passed on), which never went through a browser.
 *
 * Re-encoding is the safety step: only pixels survive, so nothing hidden in
 * the original file (location data, an embedded payload) is ever stored.
 * Very large images are refused before decoding (`limitInputPixels`).
 */

const MAX_INPUT_PIXELS = 40_000_000; // about 7,000 × 5,700

export type Processed = { ok: true; bytes: Uint8Array } | { ok: false; reason: string };

export async function toStoredWebp(input: Buffer, kind: ImageKind): Promise<Processed> {
  const { width, height } = IMAGE_SIZES[kind];
  let bytes: Buffer;
  try {
    bytes = await sharp(input, { limitInputPixels: MAX_INPUT_PIXELS, failOn: "error" })
      .rotate() // honour the photo's own orientation, then forget it
      .resize(width, height, { fit: "cover", position: "centre" })
      .webp({ quality: 85 })
      .toBuffer();
  } catch {
    return { ok: false, reason: "That file couldn't be opened as an image." };
  }
  if (!isWebp(bytes)) return { ok: false, reason: "That image couldn't be prepared." };
  if (bytes.length > MAX_STORED_BYTES) return { ok: false, reason: "That image is too detailed to store. Try another." };
  return { ok: true, bytes: new Uint8Array(bytes) };
}
