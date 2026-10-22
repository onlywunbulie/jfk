"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useAccount, useConnect, useConnectors, useDisconnect, useSignMessage } from "wagmi";
import { numberToHex } from "viem";
import { createSiweMessage } from "viem/siwe";
import { Button } from "@/components/ui/button";
import { chain } from "@/lib/chain/addresses";
import { finishWalletSignInAction, startWalletSignInAction } from "./wallet-actions";

/**
 * "Continue with Base": the wallet *is* the account.
 *
 * Base Account can connect and sign the sign-in message in a single step;
 * the passkey prompt the member sees covers both. If a wallet doesn't offer
 * that, we connect first and ask for the signature separately.
 */
export function WalletSignIn() {
  const router = useRouter();
  const connectors = useConnectors();
  const { connectAsync } = useConnect();
  const { signMessageAsync } = useSignMessage();
  const { isConnected } = useAccount();
  const { disconnect } = useDisconnect();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Fetched ahead of the tap. Browsers only allow a pop-up that opens straight
  // from a tap; a server round trip in between gets the Coinbase window
  // blocked. A nonce is single-use, so a fresh one follows every attempt.
  const [nonce, setNonce] = useState<string | null>(null);

  // Being on this page means you're signed out of JFK. A wallet still
  // connected from an earlier, unfinished attempt would make the next connect
  // fail with "already connected", so let it go first.
  useEffect(() => {
    if (isConnected) disconnect();
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

  async function signIn() {
    // The nonce normally arrives within a moment of the page loading.
    if (!nonce) {
      setError("One moment, still getting ready. Tap again.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const connector = connectors[0];

      const result = await connectAsync({
        connector,
        chainId: chain.id,
        withCapabilities: true,
        capabilities: {
          signInWithEthereum: { nonce, chainId: numberToHex(chain.id) },
        },
      });

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
          statement: "Sign in to JFK.",
        });
        proof = { message, signature: await signMessageAsync({ message, account: account.address }) };
      }

      const outcome = await finishWalletSignInAction(proof);
      if (!outcome.ok) {
        setError(outcome.error);
        return;
      }
      router.replace(outcome.next);
      router.refresh();
    } catch (cause) {
      // Kept for whoever debugs it; the dev server copies this into its log.
      console.error("Wallet sign-in failed", cause);
      setError(describeWalletError(cause));
    } finally {
      setBusy(false);
      setNonce(null);
    }
  }

  return (
    <div className="space-y-3">
      <Button type="button" size="lg" fullWidth loading={busy} onClick={signIn}>
        Continue with Base
      </Button>
      <p className="text-center text-xs leading-relaxed text-ink-faint">
        Uses Face ID, your fingerprint or your screen lock. No password, and no
        recovery phrase to write down. A Coinbase window opens to confirm.
      </p>
      {error && (
        <p role="alert" className="text-center text-sm text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

/** Wallet errors are written for developers; members get one plain line. */
function describeWalletError(cause: unknown): string {
  const text = cause instanceof Error ? `${cause.name} ${cause.message}` : String(cause);
  if (/reject|denied|cancel/i.test(text)) return "You closed the confirmation. Tap the button to try again.";
  if (/popup|blocked/i.test(text)) return "Your browser blocked the confirmation window. Allow pop-ups for this site and try again.";
  return "Something went wrong connecting your wallet. Try again.";
}
