import type { Metadata } from "next";
import { requireUser } from "@/lib/auth/session";
import { listPaymentMethods } from "@/modules/payments/service";
import { listGroupsForUser } from "@/modules/groups/service";
import { Card, CardHeader } from "@/components/ui/card";
import { EXPLORER_URL, shortAddress } from "@/lib/chain/addresses";
import { PaymentMethods } from "./payment-methods";

export const metadata: Metadata = { title: "Wallet" };

export default async function WalletPage({
  searchParams,
}: PageProps<"/wallet">) {
  const user = await requireUser();
  const { added } = await searchParams;

  const [methods, groups] = await Promise.all([
    listPaymentMethods(user.id),
    listGroupsForUser(user.id),
  ]);

  return (
    <main className="animate-rise space-y-6">
      <h1 className="text-2xl font-semibold tracking-tight">Wallet</h1>

      {added === "1" && methods.length === 0 && (
        <p className="rounded-xl border border-pending/30 bg-pending-soft px-4 py-3 text-sm text-pending">
          Card setup finished, but the confirmation hasn&rsquo;t arrived yet.
          It usually lands within a few seconds — refresh shortly.
        </p>
      )}

      <Card>
        <CardHeader title="Payment methods" />
        <PaymentMethods methods={methods} />
      </Card>

      <Card>
        <CardHeader title="Profile" />
        <dl className="space-y-3 text-sm">
          <Row label="Name" value={user.displayName} />
          {user.walletAddress && (
            <div className="flex items-baseline justify-between gap-4">
              <dt className="text-ink-muted">Wallet</dt>
              <dd>
                <a
                  href={`${EXPLORER_URL}/address/${user.walletAddress}`}
                  target="_blank"
                  rel="noreferrer"
                  className="font-mono text-ink underline decoration-white/30 underline-offset-4 hover:decoration-white"
                >
                  {shortAddress(user.walletAddress)}
                </a>
              </dd>
            </div>
          )}
          <Row label="Email" value={user.email ?? "Not added"} />
          <Row
            label="Transaction PIN"
            value={user.hasPin ? "Set" : "Not set yet"}
            tone={user.hasPin ? "default" : "pending"}
          />
        </dl>
      </Card>

      <Card>
        <CardHeader title="Groups" />
        {groups.length === 0 ? (
          <p className="text-sm text-ink-muted">You&rsquo;re not in any group yet.</p>
        ) : (
          <dl className="space-y-3 text-sm">
            {groups.map((group) => (
              <Row
                key={group.id}
                label={group.name}
                value={`${group.contributionAmount.format({ compact: true })} ${
                  group.cadence === "MONTHLY" ? "monthly" : "weekly"
                }`}
              />
            ))}
          </dl>
        )}
      </Card>

      <p className="text-xs leading-relaxed text-ink-faint">
        Your personal wallet is a view over your groups and payment methods.
        JFK doesn&rsquo;t hold a personal balance — money goes straight from your
        card into the group&rsquo;s treasury.
      </p>
    </main>
  );
}

function Row({
  label,
  value,
  tone = "default",
}: {
  label: string;
  value: string;
  tone?: "default" | "pending";
}) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="truncate text-ink-muted">{label}</dt>
      <dd className={tone === "pending" ? "text-pending" : "text-ink"}>{value}</dd>
    </div>
  );
}
