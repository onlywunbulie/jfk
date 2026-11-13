import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { getCurrentUser } from "@/lib/auth/session";
import { Logo } from "@/components/logo";
import { AuthFrame } from "../auth-frame";
import { WalletSignIn } from "./wallet-sign-in";

export const metadata: Metadata = {
  title: "Sign in",
};

/**
 * Signing in: one heading, one line, one button. Base Account only.
 *
 * `?next=` brings the user back after signing in, but only to the screen
 * where they approve an AI app; any other address is ignored, so a link
 * can't bounce someone off to an arbitrary page.
 */
export default async function SignInPage({ searchParams }: PageProps<"/sign-in">) {
  const { next } = await searchParams;
  const returnTo = typeof next === "string" && next.startsWith("/oauth/authorize?") ? next : null;

  if (await getCurrentUser()) redirect(returnTo ?? "/");

  return (
    <AuthFrame>
      <Logo className="mb-12" />
      <h1 className="text-[1.75rem] leading-tight font-semibold tracking-tight text-balance text-ink">
        Save with friends. Your AI does the work.
      </h1>
      <p className="mt-3 mb-8 text-ink-muted">Nobody holds the money: it only moves when the group says yes.</p>
      <WalletSignIn returnTo={returnTo} />
    </AuthFrame>
  );
}
