/**
 * Turn a photo someone picked into what Rallied stores: a WebP at a fixed
 * size, of the area they chose in the crop step. Runs in the browser before upload, so a
 * 6 MB phone photo goes up as a few dozen KB, and because the image is
 * redrawn pixel by pixel, nothing else in the original file (location
 * metadata, a hidden payload) comes along.
 *
 * The server still checks what arrives (`isWebp`, the size cap): this is a
 * convenience for the user, not the security boundary.
 */

export type ImageKind = "avatar" | "banner";

/**
 * Output sizes. The banner is the sidebar banner's own shape (322×112),
 * at three times the size so it stays sharp on high-density screens.
 */
export const IMAGE_SIZES: Record<ImageKind, { width: number; height: number }> = {
  avatar: { width: 256, height: 256 },
  banner: { width: 966, height: 336 },
};

/** What can be picked. No SVG or GIF: SVG can carry script, and neither is a photo. */
export const ACCEPTED_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;
/** The largest file accepted before shrinking. */
export const MAX_PICKED_BYTES = 10 * 1024 * 1024;
/** The largest shrunk file the server accepts. A 966×336 WebP is far under this. */
export const MAX_STORED_BYTES = 400 * 1024;

export type ShrinkResult = { ok: true; blob: Blob } | { ok: false; error: string };

/** A file someone picked: an error to show, or null when it can be cropped. */
export function checkPicked(file: File): string | null {
  if (!(ACCEPTED_TYPES as readonly string[]).includes(file.type)) return "Pick a PNG, JPG or WebP image.";
  if (file.size > MAX_PICKED_BYTES) return "That image is over 10 MB. Pick a smaller one.";
  return null;
}

/** The part of the original image to keep, in its own pixels. */
export interface CropArea {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Draw the chosen area at the stored size and encode it as WebP. */
export async function cropToWebp(source: CanvasImageSource, kind: ImageKind, area: CropArea): Promise<ShrinkResult> {
  const { width, height } = IMAGE_SIZES[kind];
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) return { ok: false, error: "This browser can't prepare images. Try another one." };
  context.imageSmoothingQuality = "high";
  context.drawImage(source, area.x, area.y, area.width, area.height, 0, 0, width, height);

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
