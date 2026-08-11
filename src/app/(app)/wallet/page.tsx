import type { Metadata } from "next";
import { requireUser } from "@/lib/auth/session";
import { Card, CardHeader } from "@/components/ui/card";

export const metadata: Metadata = { title: "Wallet" };

export default async function WalletPage() {
  const user = await requireUser();

  return (
    <main className="animate-rise space-y-6">
      <h1 className="text-2xl font-semibold tracking-tight">Wallet</h1>

      <Card>
        <CardHeader title="Profile" />
        <dl className="space-y-3 text-sm">
          <Row label="Name" value={user.displayName} />
          <Row label="Email" value={user.email} />
          <Row
            label="Transaction PIN"
            value={user.hasPin ? "Set" : "Not set yet"}
            tone={user.hasPin ? "default" : "pending"}
          />
        </dl>
      </Card>

      <Card className="border-dashed text-center">
        <div className="py-6">
          <p className="mx-auto max-w-[30ch] text-sm text-ink-muted">
            Payment methods and your contribution history land here once
            payments are wired up.
          </p>
          <p className="mt-3 text-xs text-ink-faint">Phase 3 — Payments</p>
        </div>
      </Card>
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
      <dt className="text-ink-muted">{label}</dt>
      <dd
        className={
          tone === "pending" ? "text-pending" : "truncate text-ink"
        }
      >
        {value}
      </dd>
    </div>
  );
}
