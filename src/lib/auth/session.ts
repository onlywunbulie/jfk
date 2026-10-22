import "server-only";
import { cache } from "react";
import { cookies } from "next/headers";
import { and, eq, gt, isNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { sessions, users, SESSION_TTL_DAYS, type User } from "@/lib/db/schema";
import { hashToken } from "./crypto";
import { randomToken } from "@/lib/ids";
import { env } from "@/lib/env";

export const SESSION_COOKIE = "jfk_session";

export type SessionUser = Pick<
  User,
  "id" | "email" | "walletAddress" | "displayName" | "avatarUrl" | "emailVerifiedAt"
> & { hasPin: boolean };

/**
 * Issue a session and set its cookie.
 *
 * The raw token goes to the browser; only its SHA-256 is stored. Called from
 * Server Actions and Route Handlers only — `cookies().set` is unavailable
 * during a Server Component render.
 */
export async function createSession(
  userId: string,
  meta: { ip?: string | null; userAgent?: string | null } = {},
): Promise<void> {
  const token = randomToken(48);
  const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000);

  await db.insert(sessions).values({
    userId,
    tokenHash: hashToken(token),
    ip: meta.ip ?? null,
    userAgent: meta.userAgent ?? null,
    expiresAt,
  });

  const cookieStore = await cookies();
  cookieStore.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: env().NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    expires: expiresAt,
  });
}

/**
 * Resolve the current user, or null.
 *
 * Memoized with React `cache` so the layout, the page, and every Server
 * Component in one render share a single database round trip.
 */
export const getCurrentUser = cache(async (): Promise<SessionUser | null> => {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE)?.value;
  if (!token) return null;

  const [row] = await db
    .select({
      id: users.id,
      email: users.email,
      walletAddress: users.walletAddress,
      displayName: users.displayName,
      avatarUrl: users.avatarUrl,
      emailVerifiedAt: users.emailVerifiedAt,
      pinHash: users.pinHash,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(
      and(
        eq(sessions.tokenHash, hashToken(token)),
        isNull(sessions.revokedAt),
        gt(sessions.expiresAt, new Date()),
      ),
    )
    .limit(1);

  if (!row) return null;

  const { pinHash, ...user } = row;
  return { ...user, hasPin: pinHash !== null };
});

/**
 * The Data Access Layer gate. Any surface that requires a signed-in user calls
 * this rather than checking a role inline — per BLUEPRINT.md §12, authorization
 * lives next to the data, not in the UI.
 *
 * Throws rather than redirects so it is safe to call from Server Actions;
 * route-level redirects belong in the page/layout.
 */
export async function requireUser(): Promise<SessionUser> {
  const user = await getCurrentUser();
  if (!user) throw new UnauthenticatedError();
  return user;
}

export class UnauthenticatedError extends Error {
  constructor() {
    super("Not signed in");
    this.name = "UnauthenticatedError";
  }
}

/** Revoke the current session and clear its cookie. */
export async function destroySession(): Promise<void> {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE)?.value;

  if (token) {
    await db
      .update(sessions)
      .set({ revokedAt: new Date() })
      .where(eq(sessions.tokenHash, hashToken(token)));
  }

  cookieStore.delete(SESSION_COOKIE);
}
