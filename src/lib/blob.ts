import "server-only";
import { del, put } from "@vercel/blob";
import { env } from "@/lib/env";
import type { ImageKind } from "@/lib/shrink-image";

/**
 * Group pictures and banners on Vercel Blob. Public, because the rail shows
 * them as plain images; the address carries a random suffix, so nobody can
 * guess another group's. Only WebP that `isWebp` has checked ever reaches
 * here (see the upload action).
 *
 * Credentials: on Vercel, a connected store sets BLOB_STORE_ID and the
 * package signs in with Vercel's own short-lived identity (OIDC), no secret
 * to keep. Elsewhere (local), a BLOB_READ_WRITE_TOKEN works instead. The
 * package picks whichever is there; nothing is passed in by hand.
 */

/** Whether any Blob credentials are present, so uploads can say plainly when they aren't. */
function configured(): boolean {
  const { BLOB_READ_WRITE_TOKEN, BLOB_STORE_ID } = env();
  return Boolean(BLOB_READ_WRITE_TOKEN || BLOB_STORE_ID);
}

export type StoreResult = { ok: true; url: string } | { ok: false; reason: "not_configured" | "failed" };

export async function storeGroupImage(groupId: string, kind: ImageKind, bytes: Uint8Array): Promise<StoreResult> {
  if (!configured()) return { ok: false, reason: "not_configured" };
  try {
    const blob = await put(`groups/${groupId}/${kind}.webp`, Buffer.from(bytes), {
      access: "public",
      contentType: "image/webp",
      addRandomSuffix: true,
      // A replaced image gets a new address, so it can be cached for good.
      cacheControlMaxAge: 60 * 60 * 24 * 365,
    });
    return { ok: true, url: blob.url };
  } catch (error) {
    console.error("[blob] upload failed", error instanceof Error ? error.message : error);
    return { ok: false, reason: "failed" };
  }
}

/** Whether an address is one of this app's uploads, rather than anything else a row might hold. */
export function isStoredImage(url: string): boolean {
  try {
    const { protocol, hostname } = new URL(url);
    return protocol === "https:" && hostname.endsWith(".public.blob.vercel-storage.com");
  } catch {
    return false;
  }
}

/** Remove a replaced image. Best effort: a leftover file costs pennies, a failed swap costs the user. */
export async function removeStoredImage(url: string | null): Promise<void> {
  if (!url || !configured() || !isStoredImage(url)) return;
  try {
    await del(url);
  } catch (error) {
    console.error("[blob] delete failed", error instanceof Error ? error.message : error);
  }
}
