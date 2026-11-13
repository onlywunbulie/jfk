import type { Metadata } from "next";
import { requireUser } from "@/lib/auth/session";
import { CreateGroupChat } from "./create-group-chat";

export const metadata: Metadata = { title: "New group" };

/**
 * Starting a group, reached only from the rail's +. Fills the main card's
 * body exactly, so the heading, summary and typing box stay pinned and only
 * the conversation scrolls.
 */
export default async function NewGroupPage() {
  await requireUser();

  return (
    <main className="h-full">
      {/* The title is handed to the conversation rather than rendered here:
          it heads the chat column, which is what lets the summary card in
          the next column line up with it. */}
      <CreateGroupChat
        heading={
          <>
            <h1 className="text-2xl font-semibold tracking-tight">Create a group</h1>
            <p className="mt-1.5 text-sm text-ink-muted">
              Answer a few questions and it&rsquo;s set up. Nothing is created until you confirm at the end.
            </p>
          </>
        }
      />
    </main>
  );
}
