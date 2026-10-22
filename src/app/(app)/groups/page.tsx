import type { Metadata } from "next";
import { requireUser } from "@/lib/auth/session";
import { listGroupsForUser } from "@/modules/groups/service";
import { sumMoney, type Currency } from "@/lib/money";
import { GroupCard } from "@/components/group-card";
import { Card } from "@/components/ui/card";
import { ButtonLink } from "@/components/ui/button";

export const metadata: Metadata = { title: "All groups" };

/**
 * The overview across every group.
 *
 * Reached deliberately — `/` sends you into a single group instead, because
 * that is where the work happens. This screen exists for the moment you want
 * to compare them or start a new one.
 */
export default async function GroupsPage() {
  const user = await requireUser();
  const groups = await listGroupsForUser(user.id);

  // Naira and dollars never add together. Dollars lead: every new group is
  // on-chain in USDC, and naira only remains on groups from before.
  const currencies: Currency[] = groups.some((g) => g.currency === "NGN")
    ? groups.some((g) => g.currency === "USDC") ? ["USDC", "NGN"] : ["NGN"]
    : ["USDC"];
  const totals = currencies.map((currency) =>
    sumMoney(
      groups.filter((g) => g.currency === currency).map((g) => g.balance.total),
      currency,
    ),
  );

  return (
    <main className="animate-rise space-y-8">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-sm text-ink-muted">
            {greeting()}, {user.displayName.split(" ")[0]}
          </p>
          <h1 className="mt-1 text-[2.5rem] leading-none font-semibold tracking-tight">
            {totals.map((t) => t.format({ compact: true })).join(" · ")}
          </h1>
          <p className="mt-2 text-sm text-ink-faint">
            {groups.length === 0
              ? "across all your groups"
              : `across ${groups.length} group${groups.length === 1 ? "" : "s"}`}
          </p>
        </div>

        {groups.length > 0 && (
          <ButtonLink href="/groups/new" size="sm">
            New group
          </ButtonLink>
        )}
      </header>

      {groups.length === 0 ? (
        <Card className="border-dashed text-center">
          <div className="py-10">
            <h2 className="font-medium text-ink">No groups yet</h2>
            <p className="mx-auto mt-1.5 max-w-[34ch] text-sm text-ink-muted">
              A group is where you and your people pool money and decide
              together. Nothing leaves it unless the group votes for it.
            </p>
            <ButtonLink href="/groups/new" className="mt-6">
              Create your first group
            </ButtonLink>
          </div>
        </Card>
      ) : (
        <section className="space-y-3">
          <h2 className="text-sm font-medium tracking-wide text-ink-muted uppercase">
            My groups
          </h2>
          <div className="grid gap-3 lg:grid-cols-2">
            {groups.map((group) => (
              <GroupCard key={group.id} group={group} />
            ))}
          </div>
        </section>
      )}
    </main>
  );
}

function greeting(): string {
  // Server-rendered in the deploy's timezone; good enough until we store the
  // user's own. WAT is UTC+1, so bias the boundaries rather than guess wrong.
  const hour = new Date().getUTCHours() + 1;
  if (hour < 12) return "Good morning";
  if (hour < 17) return "Good afternoon";
  return "Good evening";
}
