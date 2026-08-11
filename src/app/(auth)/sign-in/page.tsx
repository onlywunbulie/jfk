import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { getCurrentUser } from "@/lib/auth/session";
import { Logo } from "@/components/logo";
import { SignInForm } from "./sign-in-form";

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
          Build the empire together
        </h1>
        <p className="mt-2 mb-8 text-ink-muted">
          Contributions, group funds and decisions — for you and your people.
        </p>

        <SignInForm />
      </div>

      <p className="mt-10 text-center text-xs leading-relaxed text-ink-faint">
        JFK is invite-only. Group money moves only when the group votes for it.
      </p>
    </main>
  );
}
