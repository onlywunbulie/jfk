/**
 * Turn a photo someone picked into what Rallied stores: a WebP at a fixed
 * size, cropped from the centre. Runs in the browser before upload, so a
 * 6 MB phone photo goes up as a few dozen KB, and because the image is
 * redrawn pixel by pixel, nothing else in the original file (location
 * metadata, a hidden payload) comes along.
 *
 * The server still checks what arrives (`isWebp`, the size cap): this is a
 * convenience for the user, not the security boundary.
 */

export type ImageKind = "avatar" | "banner";

/** Output sizes. The banner is 3:1, a little wider than the sidebar's, so it crops cleanly. */
export const IMAGE_SIZES: Record<ImageKind, { width: number; height: number }> = {
  avatar: { width: 256, height: 256 },
  banner: { width: 960, height: 320 },
};

/** What can be picked. No SVG or GIF: SVG can carry script, and neither is a photo. */
export const ACCEPTED_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;
/** The largest file accepted before shrinking. */
export const MAX_PICKED_BYTES = 10 * 1024 * 1024;
/** The largest shrunk file the server accepts. A 960×320 WebP is far under this. */
export const MAX_STORED_BYTES = 400 * 1024;

export type ShrinkResult = { ok: true; blob: Blob } | { ok: false; error: string };

export async function shrinkImage(file: File, kind: ImageKind): Promise<ShrinkResult> {
  if (!(ACCEPTED_TYPES as readonly string[]).includes(file.type)) {
    return { ok: false, error: "Pick a PNG, JPG or WebP image." };
  }
  if (file.size > MAX_PICKED_BYTES) return { ok: false, error: "That image is over 10 MB. Pick a smaller one." };

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return { ok: false, error: "That file couldn't be opened as an image." };
  }

  const { width, height } = IMAGE_SIZES[kind];
  // Cover: scale until both sides fill the frame, then take the centre.
  const scale = Math.max(width / bitmap.width, height / bitmap.height);
  const sw = width / scale;
  const sh = height / scale;
  const sx = (bitmap.width - sw) / 2;
  const sy = (bitmap.height - sh) / 2;

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) return { ok: false, error: "This browser can't prepare images. Try another one." };
  context.imageSmoothingQuality = "high";
  context.drawImage(bitmap, sx, sy, sw, sh, 0, 0, width, height);
  bitmap.close();

  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/webp", 0.85));
  // Safari before 17 can't write WebP and quietly hands back a PNG.
  if (!blob || blob.type !== "image/webp") {
    return { ok: false, error: "This browser can't save WebP images. Try Chrome, Firefox or a newer Safari." };
  }
  if (blob.size > MAX_STORED_BYTES) return { ok: false, error: "That image is too detailed to store. Try another." };
  return { ok: true, blob };
}

/** The bytes really are a WebP: "RIFF", four length bytes, then "WEBP". For the server. */
export function isWebp(bytes: Uint8Array): boolean {
  const ascii = (from: number, to: number) => String.fromCharCode(...bytes.subarray(from, to));
  return bytes.length > 12 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP";
}
