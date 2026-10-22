import "server-only";
import { eq } from "drizzle-orm";
import { generateSiweNonce, parseSiweMessage, validateSiweMessage } from "viem/siwe";
import type { Hex } from "viem";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { chain, shortAddress } from "@/lib/chain/addresses";
import { verifyWalletSignature } from "./wallet-signature";

/**
 * Signing in with a wallet ("Sign in with Ethereum", EIP-4361).
 *
 * The app hands out a one-time nonce, the wallet signs a standard message
 * containing it, and the server checks four things before trusting it: the
 * message is for this site, for this chain, still in date, and carries the
 * nonce we issued. Only then does it ask the chain whether the signature is
 * genuine. Proving you control the wallet *is* signing in; there's no
 * password or code.
 */

export function newSignInNonce(): string {
  return generateSiweNonce();
}

export type WalletSignInResult =
  | { ok: true; userId: string; isNewUser: boolean; address: string }
  | {
      ok: false;
      reason:
        | "unreadable_message"
        | "wrong_site"
        | "wrong_network"
        | "wrong_nonce"
        | "expired"
        | "bad_signature";
    };

export async function signInWithWallet(input: {
  message: string;
  signature: Hex;
  /** The host the user is actually on, e.g. `localhost:3000`. */
  host: string;
  /** The nonce this browser was given, or null if it has none. */
  expectedNonce: string | null;
  now?: Date;
}): Promise<WalletSignInResult> {
  let parsed;
  try {
    parsed = parseSiweMessage(input.message);
  } catch {
    return { ok: false, reason: "unreadable_message" };
  }
  if (!parsed.address || !parsed.nonce || !parsed.domain) {
    return { ok: false, reason: "unreadable_message" };
  }

  // Each check below names the specific failure, so a wallet or a proxy
  // misconfiguration shows up as itself rather than as "sign-in failed".
  if (parsed.domain !== input.host) return { ok: false, reason: "wrong_site" };
  if (parsed.chainId !== chain.id) return { ok: false, reason: "wrong_network" };
  if (!input.expectedNonce || parsed.nonce !== input.expectedNonce) {
    return { ok: false, reason: "wrong_nonce" };
  }
  const inDate = validateSiweMessage({
    message: parsed,
    domain: input.host,
    nonce: input.expectedNonce,
    time: input.now ?? new Date(),
  });
  if (!inDate) return { ok: false, reason: "expired" };

  const genuine = await verifyWalletSignature({
    message: input.message,
    signature: input.signature,
  });
  if (!genuine) return { ok: false, reason: "bad_signature" };

  const address = parsed.address.toLowerCase();
  const [existing] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.walletAddress, address))
    .limit(1);

  if (existing) return { ok: true, userId: existing.id, isNewUser: false, address };

  // A placeholder name until they choose one on the welcome screen.
  const [created] = await db
    .insert(users)
    .values({ walletAddress: address, displayName: shortAddress(parsed.address) })
    .onConflictDoNothing()
    .returning({ id: users.id });

  if (created) return { ok: true, userId: created.id, isNewUser: true, address };

  // Two sign-ins from the same new wallet raced; the other one created it.
  const [raced] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.walletAddress, address))
    .limit(1);
  return { ok: true, userId: raced.id, isNewUser: false, address };
}

/** The name people see. Trimmed, and never empty. */
export async function setDisplayName(
  userId: string,
  name: string,
): Promise<{ ok: true } | { ok: false; reason: "empty" | "too_long" }> {
  const trimmed = name.trim().replace(/\s+/g, " ");
  if (trimmed.length === 0) return { ok: false, reason: "empty" };
  if (trimmed.length > 40) return { ok: false, reason: "too_long" };

  await db.update(users).set({ displayName: trimmed }).where(eq(users.id, userId));
  return { ok: true };
}
