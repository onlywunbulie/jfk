"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { Route } from "next";
import { useAccount, useConnect, useConnectors, useDisconnect, useSignMessage } from "wagmi";
import { numberToHex } from "viem";
import { createSiweMessage } from "viem/siwe";
import { Button } from "@/components/ui/button";
import { chain } from "@/lib/chain/addresses";
import { BASE_ACCOUNT_ID, TEST_WALLET_ENABLED, TEST_WALLET_ID } from "@/lib/chain/wagmi";
import { finishWalletSignInAction, startWalletSignInAction } from "./wallet-actions";

/**
 * "Continue with Base": the wallet *is* the account.
 *
 * Base Account can connect and sign the sign-in message in a single step;
 * the passkey prompt the member sees covers both. If a wallet doesn't offer
 * that, we connect first and ask for the signature separately.
 *
 * On the test network a browser wallet (MetaMask and the like) is offered as
 * well, because Coinbase won't send on Base Sepolia for newer Base Accounts.
 */
export function WalletSignIn({ returnTo = null }: { returnTo?: string | null }) {
  const router = useRouter();
  const connectors = useConnectors();
  const { connectAsync } = useConnect();
  const { signMessageAsync } = useSignMessage();
  const { isConnected } = useAccount();
  const { disconnect } = useDisconnect();
  // idle → waiting (the Coinbase window is open) → signing (checking the
  // signature) → off into the app; or failed, with a plain reason.
  const [stage, setStage] = useState<"idle" | "waiting" | "signing" | "failed">("idle");
  const [error, setError] = useState<string | null>(null);
  // Which wallet the last attempt used, so the words match the window open.
  const [via, setVia] = useState<"base" | "test">("base");
  // Fetched ahead of the tap. Browsers only allow a pop-up that opens straight
  // from a tap; a server round trip in between gets the Coinbase window
  // blocked. A nonce is single-use, so a fresh one follows every attempt.
  const [nonce, setNonce] = useState<string | null>(null);

  // Being on this page means you're signed out of Rallied. A wallet still
  // connected from an earlier, unfinished attempt would make the next connect
  // fail with "already connected", so let it go first. Never during a
  // sign-in: a browser wallet connects first and signs after, and
  // disconnecting it in between would cancel the signature.
  const attempting = useRef(false);
  useEffect(() => {
    if (isConnected && !attempting.current) disconnect();
  }, [isConnected, disconnect]);

  useEffect(() => {
    if (nonce) return;
    let cancelled = false;
    startWalletSignInAction().then(({ nonce: fresh }) => {
      if (!cancelled) setNonce(fresh);
    });
    return () => {
      cancelled = true;
    };
  }, [nonce]);

  async function signIn(choice: "base" | "test") {
    // The nonce normally arrives within a moment of the page loading.
    if (!nonce) {
      setError("One moment, still getting ready. Tap again.");
      setStage("failed");
      return;
    }
    setVia(choice);
    attempting.current = true;
    const connector = connectors.find((c) => c.id === (choice === "test" ? TEST_WALLET_ID : BASE_ACCOUNT_ID));
    if (!connector) {
      setError("No browser wallet found. Install MetaMask (or another wallet extension), then try again.");
      setStage("failed");
      return;
    }
    setStage("waiting");
    setError(null);
    let finished = false;
    try {
      const result =
        choice === "base"
          ? await connectAsync({
              connector,
              chainId: chain.id,
              withCapabilities: true,
              capabilities: {
                signInWithEthereum: { nonce, chainId: numberToHex(chain.id) },
              },
            })
          : // A browser wallet is asked to move to Base Sepolia (and add it if missing).
            await connectAsync({ connector, chainId: chain.id, withCapabilities: true });

      const account = result.accounts[0];
      let proof = account.capabilities?.signInWithEthereum as
        | { message: string; signature: `0x${string}` }
        | undefined;

      if (!proof) {
        const message = createSiweMessage({
          address: account.address,
          chainId: chain.id,
          domain: window.location.host,
          nonce,
          uri: window.location.origin,
          version: "1",
          statement: "Sign in to Rallied.",
        });
        proof = { message, signature: await signMessageAsync({ message, account: account.address }) };
      }

      setStage("signing");
      const outcome = await finishWalletSignInAction(proof);
      if (!outcome.ok) {
        setError(outcome.error);
        setStage("failed");
        return;
      }
      finished = true;
      // A returning user who came to approve an AI app goes straight back there.
      router.replace(outcome.next === "/" && returnTo ? (returnTo as Route) : outcome.next);
      router.refresh();
    } catch (cause) {
      // Kept for whoever debugs it; the dev server copies this into its log.
      console.error("Wallet sign-in failed", cause);
      setError(describeWalletError(cause, choice));
      setStage("failed");
    } finally {
      attempting.current = false;
      // A failed attempt lets the wallet go, so the next tap starts clean.
      if (!finished) disconnect();
      setNonce(null);
      // On success the button keeps saying "Signing you in…" until the app opens.
      if (!finished) setStage((current) => (current === "signing" || current === "waiting" ? "failed" : current));
    }
  }

  const busy = stage === "waiting" || stage === "signing";

  return (
    <div>
      <Button type="button" size="lg" fullWidth loading={busy && via === "base"} disabled={busy} onClick={() => signIn("base")}>
        {busy && via === "base"
          ? stage === "waiting"
            ? "Confirm in the Coinbase window…"
            : "Signing you in…"
          : stage === "failed" && via === "base"
            ? "Try again"
            : "Continue with Base"}
      </Button>

      {stage === "failed" && error ? (
        <p role="alert" className="mt-3 rounded-[var(--radius-control)] bg-danger-soft px-4 py-3 text-sm text-danger">
          {error}
        </p>
      ) : (
        <p className="mt-3 text-sm text-ink-faint">
          {stage === "waiting"
            ? via === "base"
              ? "A Coinbase window is open. Use Face ID or your fingerprint there."
              : "Confirm in your browser wallet: switch to Base Sepolia if it asks, then sign."
            : "Face ID or fingerprint. No password."}
        </p>
      )}

      {TEST_WALLET_ENABLED && (
        <p className="mt-6 text-sm text-ink-faint">
          Testing?{" "}
          <button
            type="button"
            disabled={busy}
            onClick={() => signIn("test")}
            className="text-ink-muted underline underline-offset-4 hover:text-ink disabled:opacity-50"
          >
            {busy && via === "test" ? (stage === "waiting" ? "Waiting for your wallet…" : "Signing you in…") : "Use a browser wallet"}
          </button>{" "}
          on Base Sepolia, like MetaMask. Only on the test network.
        </p>
      )}
    </div>
  );
}

/** Wallet errors are written for developers; members get one plain line. */
function describeWalletError(cause: unknown, choice: "base" | "test"): string {
  const text = cause instanceof Error ? `${cause.name} ${cause.message}` : String(cause);
  if (choice === "test") {
    if (/reject|denied|cancel/i.test(text)) return "You said no in your wallet. Nothing happened.";
    if (/ProviderNotFound|not found/i.test(text)) return "No browser wallet found. Install MetaMask (or another wallet extension), then try again.";
    if (/chain|network/i.test(text)) return "Your wallet couldn't switch to Base Sepolia. Switch it there yourself, then try again.";
    return "Couldn't reach your browser wallet. Try again.";
  }
  if (/reject|denied|cancel/i.test(text)) return "You closed the Coinbase window before confirming.";
  if (/popup|blocked/i.test(text)) return "Your browser blocked the Coinbase window. Allow pop-ups for this site, then try again.";
  return "Couldn't reach your wallet. Your account is safe.";
}
