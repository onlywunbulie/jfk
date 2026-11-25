import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { getCurrentUser } from "@/lib/auth/session";
import { Logo } from "@/components/logo";
import { AuthFrame } from "../../auth-frame";
import { autopayStatus, prepareAutopay } from "@/modules/groups/onchain-autopay";
import { AutoPayConfirm } from "./confirm";

export const metadata: Metadata = { title: "Automatic dues" };

/**
 * The one page automatic dues needs: Claude links here, the member reads one
 * sentence, confirms in their wallet, and goes back to Claude. No app frame,
 * no menus. `?remove=1` is the same page for taking the permission off Base.
 */
export default async function AutoPayPage({ params, searchParams }: PageProps<"/auto-pay/[groupId]">) {
  const { groupId } = await params;
  const remove = (await searchParams).remove === "1";
  const user = await getCurrentUser();
  if (!user) {
    redirect(`/sign-in?next=${encodeURIComponent(`/auto-pay/${groupId}${remove ? "?remove=1" : ""}`)}`);
  }

  const [prepared, status] = await Promise.all([prepareAutopay(user.id, groupId), autopayStatus(user.id, groupId)]);

  return (
    <AuthFrame>
      <Logo className="mb-12" />
      {!prepared.ok ? (
        <>
          <h1 className="text-[1.75rem] leading-tight font-semibold tracking-tight text-ink">Can&rsquo;t set this up</h1>
          <p role="alert" className="mt-3 text-ink-muted">
            {prepared.reason}
          </p>
        </>
      ) : remove ? (
        <AutoPayConfirm
          mode="remove"
          groupId={groupId}
          title={`Remove automatic dues from Base for ${prepared.summary.groupName}`}
          lines={[
            "Takes Rallied off as your helper in this group, and sets what it may take to zero.",
            "Rallied has already stopped collecting. This removes the permission from Base too.",
          ]}
        />
      ) : (
        <AutoPayConfirm
          mode="set-up"
          groupId={groupId}
          title={`Let Rallied pay your dues in ${prepared.summary.groupName}`}
          lines={[
            `${prepared.summary.amount} every ${prepared.summary.every}, from your wallet straight into the group's vault, until ${prepared.summary.until}.`,
            `Your wallet approves up to ${prepared.summary.approved} for the year. Rallied can only ever take the group's amount, once a period, into this group's vault.`,
            "Stop any time by telling your AI, or here.",
          ]}
          alreadyOn={status?.on === true ? status.until : null}
          renew={status?.on === true && status.renew}
        />
      )}
    </AuthFrame>
  );
}
