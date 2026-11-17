import type { Metadata } from "next";
import { requireUser } from "@/lib/auth/session";
import { shortAddress } from "@/lib/chain/addresses";
import { Logo } from "@/components/logo";
import { AuthFrame } from "../auth-frame";
import { Setup } from "./setup";
import { headers } from "next/headers";
import { agentUrls, publicOrigin } from "@/modules/agents/origin";
import { safeReturnTo } from "@/lib/auth/return-to";

export const metadata: Metadata = { title: "Welcome" };

/**
 * First-time setup, right after a new wallet signs in. Signing in was step 1;
 * here come step 2 (what the group should call them) and step 3 (connect
 * their AI, or later). Outside the app shell, in the same frame as sign-in.
 */
export default async function WelcomePage({ searchParams }: PageProps<"/welcome">) {
  const user = await requireUser();
  // Where they were going before signing up (an invite, a link from Claude).
  const next = safeReturnTo((await searchParams).next) ?? "/";
  // A new wallet's name starts as its short address; don't prefill that.
  const placeholder = user.walletAddress && user.displayName === shortAddress(user.walletAddress);

  return (
    <AuthFrame>
      <Logo className="mb-12" />
      <Setup initialName={placeholder ? "" : user.displayName} mcpUrl={agentUrls(publicOrigin(await headers())).mcp} next={next} />
    </AuthFrame>
  );
}
