import { createHash } from "node:crypto";
import { and, eq, gt, isNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { oauthClients, oauthCodes, oauthTokens, type OauthClient } from "@/lib/db/schema";
import { hashToken, safeCompare } from "@/lib/auth/crypto";
import { randomToken } from "@/lib/ids";

/**
 * OAuth 2.1 for AI apps (Claude first): how a user's AI gets a token to act
 * for them in Rallied. Authorization code flow with PKCE (S256 only), dynamic
 * client registration, refresh-token rotation. Results over exceptions: every
 * expected failure comes back as `{ ok: false, reason }`.
 *
 * Secrets are stored only as SHA-256 hashes. The raw values exist once: in the
 * response that hands them to the AI app.
 */

/** Read the user's groups. */
export const READ_SCOPE = "groups:read";

/** Preparing drafts (spends, rule and role changes) for the user to send. Never sends anything. */
export const DRAFT_SCOPE = "drafts:write";

/** Everything an approved AI gets today. */
export const GRANTED_SCOPES = `${READ_SCOPE} ${DRAFT_SCOPE}`;

const CODE_TTL_MS = 5 * 60 * 1000; // a sign-in code must be exchanged within 5 minutes
const ACCESS_TTL_MS = 60 * 60 * 1000; // 1 hour
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

const MAX_REDIRECTS = 10;
const MAX_URI_LENGTH = 2000;

// ---------------------------------------------------------------------------
// Clients
// ---------------------------------------------------------------------------

/**
 * Where an AI app may be sent back to: HTTPS anywhere, or plain HTTP only on
 * this computer (for local testing). Fragments are never allowed.
 */
export function isAllowedRedirect(uri: string): boolean {
  if (uri.length > MAX_URI_LENGTH) return false;
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return false;
  }
  if (url.hash) return false;
  if (url.protocol === "https:") return true;
  return url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1");
}

export async function registerClient(input: {
  name: unknown;
  redirectUris: unknown;
}): Promise<{ ok: true; client: OauthClient } | { ok: false; reason: "invalid_redirect_uri" | "invalid_client_metadata" }> {
  const uris = input.redirectUris;
  if (!Array.isArray(uris) || uris.length === 0 || uris.length > MAX_REDIRECTS) {
    return { ok: false, reason: "invalid_redirect_uri" };
  }
  if (!uris.every((uri): uri is string => typeof uri === "string" && isAllowedRedirect(uri))) {
    return { ok: false, reason: "invalid_redirect_uri" };
  }
  const name = typeof input.name === "string" && input.name.trim() ? input.name.trim().slice(0, 80) : "An AI app";

  const [client] = await db.insert(oauthClients).values({ name, redirectUris: uris }).returning();
  return { ok: true, client };
}

export async function getClient(clientId: string): Promise<OauthClient | null> {
  const [client] = await db.select().from(oauthClients).where(eq(oauthClients.id, clientId)).limit(1);
  return client ?? null;
}

// ---------------------------------------------------------------------------
// Sign-in codes
// ---------------------------------------------------------------------------

/** PKCE S256: base64url(sha256(verifier)), compared in constant time. */
export function pkceMatches(verifier: string, challenge: string): boolean {
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return false;
  const computed = createHash("sha256").update(verifier, "ascii").digest("base64url");
  return safeCompare(computed, challenge);
}

/** Made after the user approves. Returns the raw code to send back to the app. */
export async function createAuthorizationCode(input: {
  clientId: string;
  userId: string;
  redirectUri: string;
  codeChallenge: string;
  scope: string;
  now?: Date;
}): Promise<string> {
  const now = input.now ?? new Date();
  const code = randomToken(43);
  await db.insert(oauthCodes).values({
    codeHash: hashToken(code),
    clientId: input.clientId,
    userId: input.userId,
    redirectUri: input.redirectUri,
    codeChallenge: input.codeChallenge,
    scope: input.scope,
    expiresAt: new Date(now.getTime() + CODE_TTL_MS),
  });
  return code;
}

export interface TokenSet {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  scope: string;
}

type TokenFailure = { ok: false; reason: "invalid_grant" };

/**
 * Exchange a sign-in code for tokens. The code must be unused and unexpired,
 * belong to this app and this redirect address, and the app must prove PKCE.
 * Marking it used is atomic, so the same code can never be exchanged twice.
 */
export async function exchangeCode(input: {
  code: string;
  clientId: string;
  redirectUri: string;
  codeVerifier: string;
  now?: Date;
}): Promise<({ ok: true } & TokenSet) | TokenFailure> {
  const now = input.now ?? new Date();
  const [row] = await db
    .update(oauthCodes)
    .set({ usedAt: now })
    .where(and(eq(oauthCodes.codeHash, hashToken(input.code)), isNull(oauthCodes.usedAt), gt(oauthCodes.expiresAt, now)))
    .returning();

  if (!row) return { ok: false, reason: "invalid_grant" };
  if (row.clientId !== input.clientId || row.redirectUri !== input.redirectUri) return { ok: false, reason: "invalid_grant" };
  if (!pkceMatches(input.codeVerifier, row.codeChallenge)) return { ok: false, reason: "invalid_grant" };

  const tokens = mintTokens(now);
  await db.insert(oauthTokens).values({
    clientId: row.clientId,
    userId: row.userId,
    scope: row.scope,
    accessHash: hashToken(tokens.accessToken),
    accessExpiresAt: tokens.accessExpiresAt,
    refreshHash: hashToken(tokens.refreshToken),
    refreshExpiresAt: tokens.refreshExpiresAt,
  });
  return { ok: true, accessToken: tokens.accessToken, refreshToken: tokens.refreshToken, expiresIn: ACCESS_TTL_MS / 1000, scope: row.scope };
}

/**
 * Swap a refresh token for a fresh pair. The old refresh token stops working
 * (rotation), so a stolen one is only good until the real app next refreshes.
 */
export async function refreshTokens(input: {
  refreshToken: string;
  clientId: string;
  now?: Date;
}): Promise<({ ok: true } & TokenSet) | TokenFailure> {
  const now = input.now ?? new Date();
  const tokens = mintTokens(now);
  const [row] = await db
    .update(oauthTokens)
    .set({
      accessHash: hashToken(tokens.accessToken),
      accessExpiresAt: tokens.accessExpiresAt,
      refreshHash: hashToken(tokens.refreshToken),
      refreshExpiresAt: tokens.refreshExpiresAt,
    })
    .where(
      and(
        eq(oauthTokens.refreshHash, hashToken(input.refreshToken)),
        eq(oauthTokens.clientId, input.clientId),
        isNull(oauthTokens.revokedAt),
        gt(oauthTokens.refreshExpiresAt, now),
      ),
    )
    .returning({ scope: oauthTokens.scope });

  if (!row) return { ok: false, reason: "invalid_grant" };
  return { ok: true, accessToken: tokens.accessToken, refreshToken: tokens.refreshToken, expiresIn: ACCESS_TTL_MS / 1000, scope: row.scope };
}

/** Who a bearer token acts for, or null if it's unknown, expired or revoked. */
export async function verifyAccessToken(
  token: string,
  now: Date = new Date(),
): Promise<{ userId: string; clientId: string; scope: string } | null> {
  const [row] = await db
    .update(oauthTokens)
    .set({ lastUsedAt: now })
    .where(and(eq(oauthTokens.accessHash, hashToken(token)), isNull(oauthTokens.revokedAt), gt(oauthTokens.accessExpiresAt, now)))
    .returning({ userId: oauthTokens.userId, clientId: oauthTokens.clientId, scope: oauthTokens.scope });
  return row ?? null;
}

/** Disconnect: every token this user gave AI apps stops working at once. */
export async function revokeAllForUser(userId: string, now: Date = new Date()): Promise<void> {
  await db
    .update(oauthTokens)
    .set({ revokedAt: now })
    .where(and(eq(oauthTokens.userId, userId), isNull(oauthTokens.revokedAt)));
}

function mintTokens(now: Date) {
  return {
    accessToken: `rla_${randomToken(43)}`,
    refreshToken: `rlr_${randomToken(43)}`,
    accessExpiresAt: new Date(now.getTime() + ACCESS_TTL_MS),
    refreshExpiresAt: new Date(now.getTime() + REFRESH_TTL_MS),
  };
}
