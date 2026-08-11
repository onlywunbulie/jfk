import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/session";
import { TabBar } from "@/components/tab-bar";

/**
 * The authenticated shell.
 *
 * The redirect here is a routing convenience, not the security boundary — per
 * BLUEPRINT.md §12 and the Next.js auth guide, every action and query re-checks
 * authorization at the data layer via `requireUser()`.
 */
export default async function AppLayout({ children }: LayoutProps<"/">) {
  if (!(await getCurrentUser())) redirect("/sign-in");

  return (
    <div className="flex min-h-dvh flex-col">
      <div className="mx-auto w-full max-w-lg flex-1 px-5 pt-8 pb-6">{children}</div>
      <TabBar />
    </div>
  );
}
