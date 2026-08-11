import { requireUser } from "@/lib/auth/session";
import { Money } from "@/lib/money";
import { Card } from "@/components/ui/card";
import { Logo } from "@/components/logo";
import { signOutAction } from "./actions";
import { Button } from "@/components/ui/button";

export default async function HomePage() {
  const user = await requireUser();

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
          {Money.zero().format({ compact: true })}
        </h1>
        <p className="text-sm text-ink-faint">across all your groups</p>
      </section>

      {/* Phase 1 replaces this with real group cards. */}
      <Card className="border-dashed text-center" inset>
        <div className="py-6">
          <h2 className="font-medium text-ink">No groups yet</h2>
          <p className="mx-auto mt-1.5 max-w-[28ch] text-sm text-ink-muted">
            A group is where you and your people pool money and decide together.
          </p>
          <Button className="mt-5" size="sm" disabled>
            Create a group
          </Button>
          <p className="mt-3 text-xs text-ink-faint">Coming in the next phase</p>
        </div>
      </Card>
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
