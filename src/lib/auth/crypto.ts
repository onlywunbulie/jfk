import { createHash, timingSafeEqual } from "node:crypto";
import { hash as argon2Hash, verify as argon2Verify } from "@node-rs/argon2";

/**
 * Argon2id parameters. OWASP's 2024 baseline (19 MiB, t=2, p=1) — comfortably
 * fast for a login and expensive enough that a leaked PIN hash is not a
 * six-digit brute force away from being useful.
 */
const ARGON2_OPTIONS = {
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

/** Hash a transaction PIN. Slow by design — never use for high-frequency lookups. */
export async function hashSecret(plain: string): Promise<string> {
  return argon2Hash(plain, ARGON2_OPTIONS);
}

/** Verify a PIN against its Argon2id hash. Returns false rather than throwing. */
export async function verifySecret(hash: string, plain: string): Promise<boolean> {
  try {
    return await argon2Verify(hash, plain);
  } catch {
    return false;
  }
}

/**
 * SHA-256, for values that are already high-entropy: session tokens and OTP
 * codes looked up on every request.
 *
 * Argon2 would be wrong here — these are random 192-bit tokens, so there is no
 * dictionary to defend against, and we need the hash to be an indexable
 * lookup key. Their secrecy comes from entropy, not from work factor.
 */
export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/**
 * Constant-time comparison of two hex digests, so a comparison cannot leak
 * how many leading characters matched.
 */
export function safeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
