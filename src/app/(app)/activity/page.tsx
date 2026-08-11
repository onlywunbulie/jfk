import type { Metadata } from "next";
import { requireUser } from "@/lib/auth/session";
import { ComingSoon } from "@/components/ui/coming-soon";

export const metadata: Metadata = { title: "Activity" };

export default async function ActivityPage() {
  await requireUser();
  return (
    <ComingSoon
      title="Activity"
      description="Contributions, proposals and fund releases across every group you belong to."
      phase="Phase 7 — Social & Notifications"
    />
  );
}
