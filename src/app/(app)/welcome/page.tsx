import type { Metadata } from "next";
import { requireUser } from "@/lib/auth/session";
import { shortAddress } from "@/lib/chain/addresses";
import { WelcomeForm } from "./welcome-form";

export const metadata: Metadata = { title: "Welcome" };

/**
 * Where a new wallet lands. Their wallet already exists; all JFK needs is
 * what their friends call them.
 */
export default async function WelcomePage() {
  const user = await requireUser();
  const placeholder = user.walletAddress && user.displayName === shortAddress(user.walletAddress);

  return (
    <main className="animate-rise max-w-md space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">You&rsquo;re in 👋</h1>
        <p className="mt-2 text-sm leading-relaxed text-ink-muted">
          Your wallet is set up and only you can use it. One last thing: what
          should your group call you?
        </p>
      </div>
      <WelcomeForm initialName={placeholder ? "" : user.displayName} />
    </main>
  );
}
