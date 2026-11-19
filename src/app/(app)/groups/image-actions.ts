"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { z } from "zod";
import { requireUser } from "@/lib/auth/session";
import { LIMITS, rateLimit } from "@/lib/rate-limit";
import { auditIp } from "@/lib/request-ip";
import { removeStoredImage, storeGroupImage } from "@/lib/blob";
import { MAX_STORED_BYTES, isWebp } from "@/lib/shrink-image";
import { getMembership, setGroupImage } from "@/modules/groups/service";

/**
 * Group pictures and banners. The browser has already shrunk the image to a
 * small WebP (lib/shrink-image.ts); everything is checked again here, since
 * anyone can post to an action directly.
 */

type ImageActionResult = { ok: true } | { ok: false; error: string };

const target = z.object({
  groupId: z.string().min(1).max(64),
  kind: z.enum(["avatar", "banner"]),
});

const REFUSED: Record<"not_found" | "not_admin" | "bad_url", string> = {
  not_found: "That group doesn't exist.",
  not_admin: "Only the group's owner and admins can change its picture and banner.",
  bad_url: "That didn't work. Try again.",
};

export async function uploadGroupImageAction(groupId: string, kind: string, form: FormData): Promise<ImageActionResult> {
  const user = await requireUser();
  const parsed = target.safeParse({ groupId, kind });
  if (!parsed.success) return { ok: false, error: "That didn't work. Try again." };

  // Who may change it, before anything is stored.
  const membership = await getMembership(parsed.data.groupId, user.id);
  if (!membership || membership.role === null) return { ok: false, error: REFUSED.not_found };
  if (membership.role !== "OWNER" && membership.role !== "ADMIN") return { ok: false, error: REFUSED.not_admin };

  const limited = await rateLimit(`image:user:${user.id}`, LIMITS.imageUpload.limit, LIMITS.imageUpload.windowSeconds);
  if (!limited.ok) return { ok: false, error: `That's a lot of images at once. Try again in ${Math.ceil(limited.retryAfterSeconds / 60)} minutes.` };

  const file = form.get("image");
  if (!(file instanceof Blob) || file.size === 0) return { ok: false, error: "Pick an image first." };
  if (file.size > MAX_STORED_BYTES) return { ok: false, error: "That image is too large. Try another." };
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!isWebp(bytes)) return { ok: false, error: "That image couldn't be read. Try another." };

  const stored = await storeGroupImage(parsed.data.groupId, parsed.data.kind, bytes);
  if (!stored.ok) {
    return {
      ok: false,
      error: stored.reason === "not_configured" ? "Image uploads aren't set up on this server yet." : "Couldn't save the image just now. Try again.",
    };
  }

  const ip = auditIp(await headers());
  const saved = await setGroupImage(parsed.data.groupId, user.id, parsed.data.kind, stored.url, { ip });
  if (!saved.ok) {
    await removeStoredImage(stored.url);
    return { ok: false, error: REFUSED[saved.reason] };
  }
  await removeStoredImage(saved.previous);
  revalidatePath("/", "layout");
  return { ok: true };
}

/** Back to the first letter, or the empty banner. */
export async function removeGroupImageAction(groupId: string, kind: string): Promise<ImageActionResult> {
  const user = await requireUser();
  const parsed = target.safeParse({ groupId, kind });
  if (!parsed.success) return { ok: false, error: "That didn't work. Try again." };
  const ip = auditIp(await headers());
  const saved = await setGroupImage(parsed.data.groupId, user.id, parsed.data.kind, null, { ip });
  if (!saved.ok) return { ok: false, error: REFUSED[saved.reason] };
  await removeStoredImage(saved.previous);
  revalidatePath("/", "layout");
  return { ok: true };
}
