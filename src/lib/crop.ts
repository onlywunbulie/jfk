import type { CropArea } from "@/lib/shrink-image";

/**
 * The maths behind the crop step: an image laid over a fixed frame, scaled
 * to cover it at zoom 1, zoomed in from there, and dragged around without
 * ever leaving a gap. Pure numbers, so it is tested without a browser.
 *
 * `offset` is how far the image's centre has been dragged from the frame's
 * centre, in screen pixels.
 */

export interface Size {
  width: number;
  height: number;
}
export interface Point {
  x: number;
  y: number;
}

export const MIN_ZOOM = 1;
export const MAX_ZOOM = 3;

/** Screen pixels per image pixel: just covering the frame at zoom 1. */
export function scaleFor(image: Size, frame: Size, zoom: number): number {
  return Math.max(frame.width / image.width, frame.height / image.height) * zoom;
}

/** Keep the image covering the frame: the furthest it may be dragged each way. */
export function clampOffset(image: Size, frame: Size, zoom: number, offset: Point): Point {
  const scale = scaleFor(image, frame, zoom);
  const spareX = Math.max(0, (image.width * scale - frame.width) / 2);
  const spareY = Math.max(0, (image.height * scale - frame.height) / 2);
  return {
    x: Math.min(spareX, Math.max(-spareX, offset.x)),
    y: Math.min(spareY, Math.max(-spareY, offset.y)),
  };
}

/** Where the image sits on screen: its top-left corner and drawn size, relative to the frame. */
export function placement(image: Size, frame: Size, zoom: number, offset: Point): Point & Size {
  const scale = scaleFor(image, frame, zoom);
  const width = image.width * scale;
  const height = image.height * scale;
  return { x: (frame.width - width) / 2 + offset.x, y: (frame.height - height) / 2 + offset.y, width, height };
}

/** The part of the original image inside the frame, in the image's own pixels. */
export function cropArea(image: Size, frame: Size, zoom: number, offset: Point): CropArea {
  const scale = scaleFor(image, frame, zoom);
  const at = placement(image, frame, zoom, clampOffset(image, frame, zoom, offset));
  return {
    x: -at.x / scale,
    y: -at.y / scale,
    width: frame.width / scale,
    height: frame.height / scale,
  };
}
