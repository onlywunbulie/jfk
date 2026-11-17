"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { SEND_STAGE_TEXT, useSendToBase } from "@/lib/chain/use-send-to-base";
import type { Dues as DuesData } from "@/modules/groups/onchain-dues";
import { prepareDuesAction } from "@/app/(app)/dues-actions";

/**
 * Dues, read from Base: what the vault holds, who has paid this period, and
 * the user's own Pay button. Paying sends from the user's wallet straight
 * into the group's vault; Rallied never holds it.
 */
export function Dues({ dues, groupId }: { dues: DuesData; groupId: string }) {
  const router = useRouter();
  const sendToBase = useSendToBase();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [paid, setPaid] = useState(false);

  if (!dues.ok) {
    if (dues.reason !== "unreachable") return null;
    return <p className="text-sm text-ink-muted">Couldn&rsquo;t reach Base for dues just now. Refresh in a moment.</p>;
  }

  async function pay() {
    setError(null);
    setBusy("Getting it ready…");
    try {
      const prepared = await prepareDuesAction(groupId);
      if (!prepared.ok) {
        setError(prepared.error);
        return;
      }
      const sent = await sendToBase({
        calls: prepared.calls,
        wallet: prepared.wallet,
        onStage: (stage, wallet) =>
          setBusy(prepared.calls.length > 1 && wallet === "test" && stage === "confirm" ? "Confirm in your wallet (two steps: allow, then pay)…" : SEND_STAGE_TEXT[wallet][stage]),
      });
      if (!sent.ok) {
        setError(sent.error);
        return;
      }
      setPaid(true);
      router.refresh();
    } finally {
      setBusy(null);
    }
  }

  const youPaid = dues.you.paidThisPeriod ?? (paid ? "Paid just now" : null);

  return (
    <section aria-labelledby="dues-title" className="rounded-[var(--radius-card)] border border-border bg-surface p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h3 id="dues-title" className="text-lg font-semibold text-ink">
          Dues
        </h3>
        <p className="text-sm text-ink-muted tabular-nums">
          Vault holds <span className="text-ink">{dues.vault}</span>
        </p>
      </div>
      <p className="mt-1 text-sm text-ink-muted tabular-nums">{dues.contribution} each, this period</p>

      <ul className="mt-4 divide-y divide-border text-sm">
        {dues.members.map((member) => {
          const status = member.isYou ? youPaid : member.paidThisPeriod;
          return (
            <li key={member.name} className="flex items-baseline justify-between gap-4 py-2">
              <span className="text-ink">{member.name}</span>
              <span className="flex items-baseline gap-3 tabular-nums">
                <span className="text-xs text-ink-faint">{member.paidIn} in total</span>
                <span className={cn("text-xs", status ? "text-inflow" : "text-pending")}>{status ?? "Not paid yet"}</span>
              </span>
            </li>
          );
        })}
      </ul>

      {!youPaid && (
        <div className="mt-4 border-t border-border pt-4">
          <Button type="button" size="sm" loading={busy !== null} onClick={pay}>
            Pay {dues.contribution}
          </Button>
          <p className="mt-2 text-xs text-ink-faint">
            {dues.you.short
              ? `Your wallet is ${dues.you.short} short. On the test network, get free test USDC at faucet.circle.com (Base Sepolia).`
              : "From your wallet straight into the group's vault. Rallied never holds it."}
          </p>
        </div>
      )}

      {busy && (
        <p role="status" className="mt-2 text-xs text-ink-muted">
          {busy}
        </p>
      )}
      {error && (
        <p role="alert" className="mt-2 text-xs text-danger">
          {error}
        </p>
      )}
    </section>
  );
}
