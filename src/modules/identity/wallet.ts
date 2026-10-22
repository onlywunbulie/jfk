import "server-only";
import { eq } from "drizzle-orm";
import { generateSiweNonce } from "viem/siwe";
import { isAddress, type Address, type Hex } from "viem";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { chain, shortAddress } from "@/lib/chain/addresses";
import { verifyWalletSignature } from "./wallet-signature";

/**
 * Signing in with a wallet ("Sign in with Ethereum", EIP-4361).
 *
 * The app hands out a one-time nonce, the wallet signs a message containing
 * it, and the server checks that the message is for this site and this
 * network, carries the nonce we issued, and (if it says so) is still in date.
 * Only then does it ask the chain whether the signature is genuine. Proving
 * you control the wallet *is* signing in; there's no password or code.
 */

export function newSignInNonce(): string {
  return generateSiweNonce();
}

export interface SignInMessage {
  domain: string;
  address: Address;
  uri: string | null;
  chainId: number | null;
  nonce: string | null;
  issuedAt: Date | null;
  expirationTime: Date | null;
  notBefore: Date | null;
}

/**
 * Read a sign-in message, leniently.
 *
 * Base Account writes a shorter message than the standard: no "Version"
 * or "Issued At" lines, and the site named without its port. A strict
 * parser rejects that, so this one asks only for what the security checks
 * need (site, address, network, nonce) and reads the rest when present.
 */
export function parseSignInMessage(text: string): SignInMessage | null {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const header =
    /^(?:[a-zA-Z][a-zA-Z0-9+.-]*:\/\/)?(\S+) wants you to sign in with your Ethereum account:$/.exec(
      lines[0] ?? "",
    );
  const address = (lines[1] ?? "").trim();
  if (!header || !isAddress(address, { strict: false })) return null;

  const field = (name: string): string | null => {
    const line = lines.find((l) => l.startsWith(`${name}: `));
    return line ? line.slice(name.length + 2).trim() : null;
  };
  const date = (name: string): Date | null => {
    const value = field(name);
    if (!value) return null;
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  };
  const chainId = field("Chain ID");

  return {
    domain: header[1],
    address: address as Address,
    uri: field("URI"),
    chainId: chainId && /^\d+$/.test(chainId) ? Number(chainId) : null,
    nonce: field("Nonce"),
    issuedAt: date("Issued At"),
    expirationTime: date("Expiration Time"),
    notBefore: date("Not Before"),
  };
}

/**
 * Is the message for the site the person is actually on?
 *
 * The message's site must be this host, with or without the port (Base
 * Account drops it), and its URI, when given, must point at exactly this
 * host. Together they stop a signature made for another site being replayed
 * here.
 */
function isForThisSite(message: SignInMessage, host: string): boolean {
  const hostname = host.split(":")[0];
  if (message.domain !== host && message.domain !== hostname) return false;
  if (message.uri) {
    try {
      if (new URL(message.uri).host !== host) return false;
    } catch {
      return false;
    }
  }
  return true;
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
  const parsed = parseSignInMessage(input.message);
  if (!parsed) return { ok: false, reason: "unreadable_message" };

  // Each check below names the specific failure, so a wallet or a proxy
  // misconfiguration shows up as itself rather than as "sign-in failed".
  if (!isForThisSite(parsed, input.host)) return { ok: false, reason: "wrong_site" };
  if (parsed.chainId !== chain.id) return { ok: false, reason: "wrong_network" };
  if (!input.expectedNonce || parsed.nonce !== input.expectedNonce) {
    return { ok: false, reason: "wrong_nonce" };
  }
  // The nonce is single-use and lives ten minutes, which bounds a message
  // with no dates. When the message does carry dates, they're honoured too.
  const now = input.now ?? new Date();
  if (parsed.expirationTime && parsed.expirationTime <= now) return { ok: false, reason: "expired" };
  if (parsed.notBefore && parsed.notBefore > now) return { ok: false, reason: "expired" };

  const genuine = await verifyWalletSignature({
    address: parsed.address,
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
