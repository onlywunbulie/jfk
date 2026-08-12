import type { Metadata } from "next";
import Link from "next/link";
import { requireUser } from "@/lib/auth/session";
import { CreateGroupForm } from "./create-group-form";

export const metadata: Metadata = { title: "New group" };

export default async function NewGroupPage() {
  await requireUser();

  return (
    <main className="animate-rise space-y-7">
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
          You&rsquo;ll be the owner. Everything about the money is decided by the
          group, not by you.
        </p>
      </div>

      <CreateGroupForm />
    </main>
  );
}
