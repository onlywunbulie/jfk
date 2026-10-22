"use server";

import { cookies, headers } from "next/headers";
import { z } from "zod";
import { createSession } from "@/lib/auth/session";
import { env } from "@/lib/env";
import { newSignInNonce, signInWithWallet } from "@/modules/identity/wallet";

/**
 * The nonce lives in a short-lived httpOnly cookie, so the message a wallet
 * signs can only be used once, in this browser, within ten minutes.
 */
const NONCE_COOKIE = "jfk_wallet_nonce";

export async function startWalletSignInAction(): Promise<{ nonce: string }> {
  const nonce = newSignInNonce();
  const cookieStore = await cookies();
  cookieStore.set(NONCE_COOKIE, nonce, {
    httpOnly: true,
    secure: env().NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 10 * 60,
  });
  return { nonce };
}

const finishSchema = z.object({
  message: z.string().min(1).max(4_000),
  signature: z.string().regex(/^0x[0-9a-fA-F]+$/),
});

export type FinishWalletSignInResult =
  | { ok: true; next: "/" | "/welcome" }
  | { ok: false; error: string };

export async function finishWalletSignInAction(
  input: z.input<typeof finishSchema>,
): Promise<FinishWalletSignInResult> {
  const parsed = finishSchema.safeParse(input);
  if (!parsed.success) {
    // Sign-in messages and signatures are public data, safe to log.
    console.warn("Wallet sign-in: unexpected shape", {
      issues: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
      keys: input && typeof input === "object" ? Object.keys(input) : typeof input,
      signaturePrefix: typeof input?.signature === "string" ? input.signature.slice(0, 12) : typeof input?.signature,
    });
    return { ok: false, error: "The wallet sent something unexpected. Try again." };
  }

  const cookieStore = await cookies();
  const expectedNonce = cookieStore.get(NONCE_COOKIE)?.value ?? null;
  // Spent the moment it's checked, whatever the outcome.
  cookieStore.delete(NONCE_COOKIE);

  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "";

  const result = await signInWithWallet({
    message: parsed.data.message,
    signature: parsed.data.signature as `0x${string}`,
    host,
    expectedNonce,
  });

  if (!result.ok) {
    console.warn(`Wallet sign-in refused: ${result.reason} host=${host} message=${JSON.stringify(parsed.data.message)} signature=${parsed.data.signature.slice(0, 20)}…(${parsed.data.signature.length} chars)`);
    const error = {
      unreadable_message: "The wallet sent something unexpected. Try again.",
      wrong_site: "That sign-in was meant for a different site.",
      wrong_network: "Your wallet is on a different network. Try again.",
      wrong_nonce: "That sign-in request expired. Try again.",
      expired: "That sign-in request expired. Try again.",
      bad_signature: "We couldn't confirm that wallet is yours. Try again.",
    }[result.reason];
    return { ok: false, error };
  }

  await createSession(result.userId, { userAgent: h.get("user-agent") });
  return { ok: true, next: result.isNewUser ? "/welcome" : "/" };
}
