import type { Metadata } from "next";
import Link from "next/link";
import { requireUser } from "@/lib/auth/session";
import { CreateGroupForm } from "./create-group-form";

export const metadata: Metadata = { title: "New group" };

export default async function NewGroupPage() {
  await requireUser();

  return (
    // The wizard is the one screen that reads better narrow: it is a sequence
    // of decisions, not a dashboard, and a 1500px-wide form is unreadable.
    <main className="animate-rise mx-auto max-w-2xl space-y-7">
      <div>
        <Link
          href="/groups"
          className="text-sm text-ink-muted transition-colors hover:text-ink"
        >
          ← Groups
        </Link>
        <h1 className="mt-3 text-2xl font-semibold tracking-tight">
          Create a group
        </h1>
        <p className="mt-1.5 text-sm text-ink-muted">
          You&rsquo;ll be the owner — but not of the money. Set the rules now;
          afterwards the group changes them by vote.
        </p>
      </div>

      <CreateGroupForm />
    </main>
  );
}
