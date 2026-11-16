import type { SessionUser } from "@/lib/auth/session";
import { Button } from "@/components/ui/button";
import { AiConnection } from "@/components/ai-connection";
import { EXPLORER_URL, shortAddress } from "@/lib/chain/addresses";
import { signOutAction } from "@/app/(app)/actions";
import { headers } from "next/headers";
import { getAiConnection } from "@/modules/agents/connection";
import { agentUrls, publicOrigin } from "@/modules/agents/origin";

// Formatted here, on the server, in Lagos time, so the modal shows the same
// thing on every screen and never mismatches when it hydrates.
const TIME_ZONE = "Africa/Lagos";
const shortDate = (date: Date) =>
  new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: TIME_ZONE }).format(date);
const shortDateTime = (date: Date) =>
  new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: TIME_ZONE }).format(date);

/**
 * Everything about the user in one place, shown in the profile modal: who
 * they are, the AI that acts for them across all their groups, and logging
 * out. Rendered on the server and handed to the shell, which shows it when
 * the profile square is tapped.
 */
export async function ProfilePanel({ user }: { user: SessionUser }) {
  const [connection, requestHeaders] = await Promise.all([getAiConnection(user.id), headers()]);
  const mcpUrl = agentUrls(publicOrigin(requestHeaders)).mcp;

  return (
    <div className="space-y-8">
      <header className="flex items-center gap-4">
        <span
          aria-hidden="true"
          className="grid size-14 shrink-0 place-items-center rounded-full bg-overlay text-xl font-semibold text-ink"
        >
          {user.displayName.trim().charAt(0).toUpperCase() || "?"}
        </span>
        <div className="min-w-0">
          <h2 id="profile-title" className="truncate text-lg font-semibold text-ink">
            {user.displayName}
          </h2>
          {user.walletAddress && (
            <a
              href={`${EXPLORER_URL}/address/${user.walletAddress}`}
              target="_blank"
              rel="noreferrer"
              className="font-mono text-sm text-ink-muted underline decoration-ink-faint underline-offset-4 hover:text-ink hover:decoration-ink"
            >
              {shortAddress(user.walletAddress)}
            </a>
          )}
        </div>
      </header>

      <section aria-labelledby="profile-ai">
        <h3 id="profile-ai" className="text-sm font-semibold text-ink">
          Your AI
        </h3>
        <p className="mt-1 mb-4 text-sm text-ink-muted">The AI that acts for you in Rallied, across all your groups.</p>
        <AiConnection
          mcpUrl={mcpUrl}
          connection={
            connection
              ? {
                  appName: connection.appName,
                  connectedOn: shortDate(connection.connectedAt),
                  lastUsed: connection.lastUsedAt ? shortDateTime(connection.lastUsedAt) : null,
                }
              : null
          }
        />
      </section>

      <section aria-labelledby="profile-details">
        <h3 id="profile-details" className="text-sm font-semibold text-ink">
          Details
        </h3>
        <dl className="mt-3 space-y-3 text-sm">
          <Row label="Email" value={user.email ?? "Not added"} />
          <Row label="Transaction PIN" value={user.hasPin ? "Set" : "Not set yet"} tone={user.hasPin ? "default" : "pending"} />
        </dl>
      </section>

      <form action={signOutAction} className="border-t border-border pt-5">
        <Button type="submit" variant="secondary" size="sm">
          Log out
        </Button>
      </form>
    </div>
  );
}

function Row({ label, value, tone = "default" }: { label: string; value: string; tone?: "default" | "pending" }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="text-ink-muted">{label}</dt>
      <dd className={tone === "pending" ? "text-pending" : "text-ink"}>{value}</dd>
    </div>
  );
}
