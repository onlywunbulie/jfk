import { requireUser } from "@/lib/auth/session";
import { listGroupsForUser } from "@/modules/groups/service";
import { sumMoney } from "@/lib/money";
import { Card } from "@/components/ui/card";
import { Logo } from "@/components/logo";
import { GroupCard } from "@/components/group-card";
import { ButtonLink, Button } from "@/components/ui/button";
import { signOutAction } from "./actions";

export default async function HomePage() {
  const user = await requireUser();
  const groups = await listGroupsForUser(user.id);

  const total = sumMoney(groups.map((group) => group.balance.total));

  return (
    <main className="animate-rise space-y-8">
      <header className="flex items-center justify-between">
        <Logo showWordmark={false} />
        <form action={signOutAction}>
          <Button type="submit" variant="ghost" size="sm">
            Sign out
          </Button>
        </form>
      </header>

      <section>
        <p className="text-sm text-ink-muted">
          {greeting()}, {user.displayName.split(" ")[0]}
        </p>
        <h1 className="mt-1 text-[2.5rem] leading-tight font-semibold tracking-tight">
          {total.format({ compact: true })}
        </h1>
        <p className="text-sm text-ink-faint">
          {groups.length === 0
            ? "across all your groups"
            : `across ${groups.length} group${groups.length === 1 ? "" : "s"}`}
        </p>
      </section>

      {groups.length === 0 ? (
        <Card className="border-dashed text-center" inset>
          <div className="py-6">
            <h2 className="font-medium text-ink">No groups yet</h2>
            <p className="mx-auto mt-1.5 max-w-[28ch] text-sm text-ink-muted">
              A group is where you and your people pool money and decide
              together.
            </p>
            <ButtonLink href="/groups/new" className="mt-5" size="sm">
              Create a group
            </ButtonLink>
          </div>
        </Card>
      ) : (
        <section className="space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-medium tracking-wide text-ink-muted uppercase">
              My groups
            </h2>
            <ButtonLink href="/groups/new" size="sm" variant="ghost">
              New
            </ButtonLink>
          </div>
          {groups.map((group) => (
            <GroupCard key={group.id} group={group} />
          ))}
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
