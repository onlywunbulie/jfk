import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { getCurrentUser } from "@/lib/auth/session";
import { Logo } from "@/components/logo";
import { AuthFrame } from "../auth-frame";
import { WalletSignIn } from "./wallet-sign-in";

export const metadata: Metadata = {
  title: "Sign in",
};

/** Signing in: one heading, one line, one button. Base Account only. */
export default async function SignInPage() {
  if (await getCurrentUser()) redirect("/");

  return (
    <AuthFrame>
      <Logo className="mb-12" />
      <h1 className="text-[1.75rem] leading-tight font-semibold tracking-tight text-balance text-ink">
        Save with friends. Your AI does the work.
      </h1>
      <p className="mt-3 mb-8 text-ink-muted">Nobody holds the money: it only moves when the group says yes.</p>
      <WalletSignIn />
    </AuthFrame>
  );
}
