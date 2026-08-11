import type { Metadata } from "next";
import { requireUser } from "@/lib/auth/session";
import { ComingSoon } from "@/components/ui/coming-soon";

export const metadata: Metadata = { title: "Groups" };

export default async function GroupsPage() {
  await requireUser();
  return (
    <ComingSoon
      title="Groups"
      description="Create a group, invite your people, and set the contribution rules you all agree on."
      phase="Phase 1 — Groups & Identity"
    />
  );
}
