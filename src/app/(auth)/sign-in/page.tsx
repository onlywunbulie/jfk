import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { getCurrentUser } from "@/lib/auth/session";
import { Logo } from "@/components/logo";
import { SignInForm } from "./sign-in-form";
import { WalletSignIn } from "./wallet-sign-in";

export const metadata: Metadata = {
  title: "Sign in · JFK",
};

export default async function SignInPage() {
  if (await getCurrentUser()) redirect("/");

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-sm flex-col justify-center px-6 py-12">
      <div className="animate-rise">
        <Logo className="mb-10" />

        <h1 className="text-2xl font-semibold tracking-tight text-ink">
          Save together. Nobody holds the money.
        </h1>
        <p className="mt-2 mb-8 text-ink-muted">
          Your group&rsquo;s money sits in a shared wallet that only moves when
          the group says yes.
        </p>

        <WalletSignIn />

        {/* The email code is how accounts made before the move on-chain sign
            in. It goes once everyone has a wallet. */}
        <details className="group mt-8">
          <summary className="cursor-pointer list-none text-center text-sm text-ink-muted transition-colors hover:text-ink [&::-webkit-details-marker]:hidden">
            <span className="group-open:hidden">Use an email code instead</span>
            <span className="hidden group-open:inline">Hide email sign-in</span>
          </summary>
          <div className="mt-6">
            <SignInForm />
          </div>
        </details>
      </div>

      <p className="mt-10 text-center text-xs leading-relaxed text-ink-faint">
        JFK runs on Base&rsquo;s test network for now. Nothing here is real
        money yet.
      </p>
    </main>
  );
}
