import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { getCurrentUser } from "@/lib/auth/session";
import { shortAddress } from "@/lib/chain/addresses";
import { Logo } from "@/components/logo";
import { Button } from "@/components/ui/button";
import { AuthFrame } from "../../auth-frame";
import { checkAuthorizeRequest } from "./checks";
import { decideAction } from "./actions";

export const metadata: Metadata = { title: "Connect your AI" };

/**
 * Where an AI app (Claude first) sends the user to approve access. Signed-out
 * users sign in first and come straight back. The screen says plainly what
 * the AI will and won't be able to do, then Allow or Don't allow.
 */
export default async function AuthorizePage({ searchParams }: PageProps<"/oauth/authorize">) {
  const raw = await searchParams;
  const params = Object.fromEntries(
    Object.entries(raw).map(([key, value]) => [key, Array.isArray(value) ? value[0] : value]),
  ) as Record<string, string | undefined>;

  const check = await checkAuthorizeRequest(params);
  if (!check.ok && "sendBack" in check) redirect(check.sendBack.toString());

  if (!check.ok) {
    return (
      <AuthFrame>
        <Logo className="mb-12" />
        <h1 className="text-[1.75rem] leading-tight font-semibold tracking-tight text-ink">Couldn&rsquo;t connect</h1>
        <p role="alert" className="mt-3 text-ink-muted">
          {check.showHere}
        </p>
      </AuthFrame>
    );
  }

  const user = await getCurrentUser();
  if (!user) {
    const here = `/oauth/authorize?${new URLSearchParams(params as Record<string, string>).toString()}`;
    redirect(`/sign-in?next=${encodeURIComponent(here)}`);
  }

  const { client, request } = check;

  return (
    <AuthFrame>
      <Logo className="mb-12" />
      <h1 className="text-[1.75rem] leading-tight font-semibold tracking-tight text-balance text-ink">
        {client.name} wants to help with your Rallied groups
      </h1>
      <p className="mt-3 text-ink-muted">
        Signed in as <span className="text-ink">{user.displayName}</span>
        {user.walletAddress && <span className="font-mono"> · {shortAddress(user.walletAddress)}</span>}
      </p>

      <div className="mt-8 grid gap-6 sm:grid-cols-2">
        <section>
          <h2 className="text-sm text-ink-muted">{client.name} will be able to</h2>
          <ul className="mt-3 space-y-2 text-sm">
            {[
              "See your groups and balances",
              "See members, rules and votes",
              "Prepare drafts for you to send: spends, rule and role changes",
              "Create groups and invite links, and start groups on Base",
              "Pay your dues into your group's vault, once you've allowed it in your wallet",
            ].map((item) => (
              <li key={item} className="flex gap-2">
                <span aria-hidden="true" className="text-inflow">✓</span>
                <span className="text-ink">{item}</span>
              </li>
            ))}
          </ul>
        </section>
        <section>
          <h2 className="text-sm text-ink-muted">It won&rsquo;t be able to</h2>
          <ul className="mt-3 space-y-2 text-sm">
            {["Spend, or send money anywhere but your own dues", "Vote", "Send a draft: only you can, with a tap"].map((item) => (
              <li key={item} className="flex gap-2">
                <span aria-hidden="true" className="text-ink-faint">✗</span>
                <span className="text-ink-muted">{item}</span>
              </li>
            ))}
          </ul>
        </section>
      </div>

      <form action={decideAction} className="mt-10 flex flex-wrap gap-3">
        <input type="hidden" name="client_id" value={request.clientId} />
        <input type="hidden" name="redirect_uri" value={request.redirectUri} />
        <input type="hidden" name="code_challenge" value={request.codeChallenge} />
        <input type="hidden" name="code_challenge_method" value="S256" />
        <input type="hidden" name="response_type" value="code" />
        {request.state && <input type="hidden" name="state" value={request.state} />}
        <Button type="submit" name="decision" value="allow" size="lg">
          Allow
        </Button>
        <Button type="submit" name="decision" value="deny" variant="secondary" size="lg">
          Don&rsquo;t allow
        </Button>
      </form>
      <p className="mt-4 text-sm text-ink-faint">You can disconnect it any time from your profile.</p>
    </AuthFrame>
  );
}
