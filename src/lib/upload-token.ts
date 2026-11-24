import "server-only";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { env } from "@/lib/env";
import type { ImageKind } from "@/lib/shrink-image";

/**
 * One-time upload addresses for a group picture or banner: what Claude gets
 * so it can send a file the user attached straight to Rallied.
 *
 * The token names who may upload, to which group, which image, and until
 * when, signed with Rallied's own secret, so it can't be made or changed by
 * anyone else. It lasts 15 minutes; the upload route also lets each token be
 * used once. Whoever holds it can only set that one image, and the usual
 * rules still apply when it's used (owner or admin, re-encoded).
 */

export const UPLOAD_TOKEN_SECONDS = 15 * 60;

export interface UploadGrant {
  userId: string;
  groupId: string;
  kind: ImageKind;
  /** Seconds since 1970. */
  expiresAt: number;
  /** Unique per token, so each can be used once. */
  nonce: string;
}

const sign = (body: string) => createHmac("sha256", `${env().SESSION_SECRET}:image-upload`).update(body).digest("base64url");

export function issueUploadToken(input: { userId: string; groupId: string; kind: ImageKind }, now: Date = new Date()): string {
  const grant: UploadGrant = {
    ...input,
    expiresAt: Math.floor(now.getTime() / 1000) + UPLOAD_TOKEN_SECONDS,
    nonce: randomBytes(12).toString("base64url"),
  };
  const body = Buffer.from(JSON.stringify(grant)).toString("base64url");
  return `${body}.${sign(body)}`;
}

/** The grant inside a token, or null if it's forged, changed, malformed or expired. */
export function readUploadToken(token: string, now: Date = new Date()): UploadGrant | null {
  const [body, signature, extra] = token.split(".");
  if (!body || !signature || extra !== undefined) return null;
  const expected = Buffer.from(sign(body));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    const grant = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as UploadGrant;
    if (grant.kind !== "avatar" && grant.kind !== "banner") return null;
    if (typeof grant.expiresAt !== "number" || grant.expiresAt < now.getTime() / 1000) return null;
    return grant;
  } catch {
    return null;
  }
}
