import "server-only";
import { and, desc, eq, gte, isNull } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  loginCodes,
  users,
  LOGIN_CODE_MAX_ATTEMPTS,
  LOGIN_CODE_RATE_LIMIT_PER_HOUR,
  LOGIN_CODE_TTL_MINUTES,
} from "@/lib/db/schema";
import { hashToken } from "@/lib/auth/crypto";
import { numericCode } from "@/lib/ids";
import { sendLoginCodeEmail } from "@/lib/email";

/**
 * Results are returned as typed unions rather than thrown, so callers must
 * handle failure explicitly (BLUEPRINT.md §13).
 */
export type RequestCodeResult =
  | { ok: true; devCode?: string }
  | { ok: false; reason: "rate_limited"; retryAfterMinutes: number };

export type VerifyCodeResult =
  | { ok: true; userId: string; isNewUser: boolean }
  | { ok: false; reason: "invalid" | "expired" | "too_many_attempts" };

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Issue a login code.
 *
 * Deliberately does not reveal whether the email belongs to an existing
 * account — the response is identical either way, so this endpoint cannot be
 * used to enumerate members.
 */
export async function requestLoginCode(
  rawEmail: string,
  meta: { ip?: string | null } = {},
): Promise<RequestCodeResult> {
  const email = normalizeEmail(rawEmail);
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);

  const recent = await db
    .select({ id: loginCodes.id, createdAt: loginCodes.createdAt })
    .from(loginCodes)
    .where(and(eq(loginCodes.email, email), gte(loginCodes.createdAt, oneHourAgo)))
    .orderBy(desc(loginCodes.createdAt));

  if (recent.length >= LOGIN_CODE_RATE_LIMIT_PER_HOUR) {
    const oldest = recent[recent.length - 1].createdAt;
    const retryAfterMinutes = Math.max(
      1,
      Math.ceil((oldest.getTime() + 60 * 60 * 1000 - Date.now()) / 60_000),
    );
    return { ok: false, reason: "rate_limited", retryAfterMinutes };
  }

  const code = numericCode(6);

  await db.insert(loginCodes).values({
    email,
    codeHash: hashToken(code),
    expiresAt: new Date(Date.now() + LOGIN_CODE_TTL_MINUTES * 60 * 1000),
    requestedIp: meta.ip ?? null,
  });

  const delivery = await sendLoginCodeEmail(email, code);

  // In development with no Resend key, hand the code back so the sign-in
  // screen can show it. Never populated when email is actually configured.
  return { ok: true, devCode: delivery.delivered ? undefined : code };
}

/**
 * Verify a login code and resolve (or create) the user.
 *
 * Creating the account on first successful verification means there is no
 * separate sign-up flow to keep in sync, and no unverified accounts to clean up.
 */
export async function verifyLoginCode(
  rawEmail: string,
  code: string,
): Promise<VerifyCodeResult> {
  const email = normalizeEmail(rawEmail);
  const submitted = code.trim();

  const [candidate] = await db
    .select()
    .from(loginCodes)
    .where(and(eq(loginCodes.email, email), isNull(loginCodes.consumedAt)))
    .orderBy(desc(loginCodes.createdAt))
    .limit(1);

  if (!candidate) return { ok: false, reason: "invalid" };

  if (candidate.attempts >= LOGIN_CODE_MAX_ATTEMPTS) {
    return { ok: false, reason: "too_many_attempts" };
  }

  if (candidate.expiresAt.getTime() <= Date.now()) {
    return { ok: false, reason: "expired" };
  }

  if (candidate.codeHash !== hashToken(submitted)) {
    await db
      .update(loginCodes)
      .set({ attempts: candidate.attempts + 1 })
      .where(eq(loginCodes.id, candidate.id));

    return candidate.attempts + 1 >= LOGIN_CODE_MAX_ATTEMPTS
      ? { ok: false, reason: "too_many_attempts" }
      : { ok: false, reason: "invalid" };
  }

  // Correct code. Consume it and upsert the user in one transaction so a
  // crash cannot leave a consumed code with no account behind it.
  return db.transaction(async (tx) => {
    await tx
      .update(loginCodes)
      .set({ consumedAt: new Date() })
      .where(eq(loginCodes.id, candidate.id));

    const [existing] = await tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, email))
      .limit(1);

    if (existing) {
      await tx
        .update(users)
        .set({ emailVerifiedAt: new Date() })
        .where(eq(users.id, existing.id));
      return { ok: true as const, userId: existing.id, isNewUser: false };
    }

    const [created] = await tx
      .insert(users)
      .values({
        email,
        displayName: defaultDisplayName(email),
        emailVerifiedAt: new Date(),
      })
      .returning({ id: users.id });

    return { ok: true as const, userId: created.id, isNewUser: true };
  });
}

/** A reasonable placeholder until the user sets their own name at onboarding. */
function defaultDisplayName(email: string): string {
  const local = email.split("@")[0] ?? "friend";
  const cleaned = local.replace(/[._-]+/g, " ").trim();
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}
