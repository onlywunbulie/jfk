import "server-only";
import { LIMITS, rateLimit } from "@/lib/rate-limit";
import { removeStoredImage, storeGroupImage } from "@/lib/blob";
import { fetchPublicImage } from "@/lib/fetch-image";
import { toStoredWebp } from "@/lib/process-image";
import type { ImageKind } from "@/lib/shrink-image";
import { getMembership, setGroupImage } from "./service";

/**
 * Set a group's picture or banner from a link (Claude passing one on). The
 * same rules as an upload in the app: owners and admins only, checked before
 * anything is fetched; the same rate limit; and the image is fetched safely
 * (lib/fetch-image.ts) and re-encoded (lib/process-image.ts) before it's stored.
 */
export async function setGroupImageFromLink(
  userId: string,
  groupId: string,
  kind: ImageKind,
  link: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const allowed = await mayChangeImages(userId, groupId);
  if (!allowed.ok) return allowed;

  const fetched = await fetchPublicImage(link);
  if (!fetched.ok) return fetched;
  return saveGroupImage(userId, groupId, kind, fetched.bytes);
}

/**
 * The bytes of an image someone sent Rallied directly (Claude uploading a file
 * the user attached). The same rules as a link: owners and admins, the rate
 * limit, re-encoded before it's stored.
 */
export async function setGroupImageFromBytes(
  userId: string,
  groupId: string,
  kind: ImageKind,
  bytes: Buffer,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const allowed = await mayChangeImages(userId, groupId);
  if (!allowed.ok) return allowed;
  return saveGroupImage(userId, groupId, kind, bytes);
}

async function mayChangeImages(userId: string, groupId: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  const membership = await getMembership(groupId, userId);
  if (!membership || membership.role === null) return { ok: false, reason: "That group doesn't exist." };
  if (membership.role !== "OWNER" && membership.role !== "ADMIN") {
    return { ok: false, reason: "Only the group's owner and admins can change its picture and banner." };
  }
  const limited = await rateLimit(`image:user:${userId}`, LIMITS.imageUpload.limit, LIMITS.imageUpload.windowSeconds);
  if (!limited.ok) return { ok: false, reason: `That's a lot of images at once. Try again in ${Math.ceil(limited.retryAfterSeconds / 60)} minutes.` };
  return { ok: true };
}

/** Re-encode, store, swap in, and remove the image it replaces. */
async function saveGroupImage(
  userId: string,
  groupId: string,
  kind: ImageKind,
  input: Buffer,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const processed = await toStoredWebp(input, kind);
  if (!processed.ok) return processed;

  const stored = await storeGroupImage(groupId, kind, processed.bytes);
  if (!stored.ok) {
    return {
      ok: false,
      reason: stored.reason === "not_configured" ? "Image uploads aren't set up on this server yet." : "Couldn't save the image just now. Try again.",
    };
  }
  const saved = await setGroupImage(groupId, userId, kind, stored.url);
  if (!saved.ok) {
    await removeStoredImage(stored.url);
    return { ok: false, reason: "Couldn't save the image just now. Try again." };
  }
  await removeStoredImage(saved.previous);
  return { ok: true };
}
