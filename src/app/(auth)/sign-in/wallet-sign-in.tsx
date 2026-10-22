"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useConnect, useConnectors, useSignMessage } from "wagmi";
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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function signIn() {
    setBusy(true);
    setError(null);
    try {
      const connector = connectors[0];
      const { nonce } = await startWalletSignInAction();

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
      setError(describeWalletError(cause));
    } finally {
      setBusy(false);
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
