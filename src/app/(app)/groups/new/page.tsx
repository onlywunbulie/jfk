import type { Metadata } from "next";
import Link from "next/link";
import { requireUser } from "@/lib/auth/session";
import { CreateGroupChat } from "./create-group-chat";

export const metadata: Metadata = { title: "New group" };

export default async function NewGroupPage() {
  await requireUser();

  return (
    <main className="animate-rise space-y-3 lg:-mb-10">
      <div>
        <Link
          href="/groups"
          className="text-sm text-ink-muted transition-colors hover:text-ink"
        >
          ← Groups
        </Link>
      </div>

      {/* The title is handed to the conversation rather than rendered here:
          it heads the chat column, which is what lets the summary card in
          the next column line up with it. */}
      <CreateGroupChat
        heading={
          <>
            <h1 className="text-2xl font-semibold tracking-tight">
              Create a group
            </h1>
            <p className="mt-1.5 text-sm text-ink-muted">
              Answer a few questions and it&rsquo;s set up. Nothing is created
              until you confirm at the end.
            </p>
          </>
        }
      />
    </main>
  );
}
