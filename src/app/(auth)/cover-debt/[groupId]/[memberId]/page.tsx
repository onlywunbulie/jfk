import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { getCurrentUser } from "@/lib/auth/session";
import { Logo } from "@/components/logo";
import { AuthFrame } from "../../../auth-frame";
import { prepareCoverDebt } from "@/modules/groups/onchain-rotation";
import { CoverDebtConfirm } from "./confirm";

export const metadata: Metadata = { title: "Cover a debt" };

/**
 * Claude links here when the user wants to pay off what someone owes in a
 * rotating group (their own debt, or a friend's). One sentence, one wallet
 * confirm, back to Claude.
 */
export default async function CoverDebtPage({ params }: PageProps<"/cover-debt/[groupId]/[memberId]">) {
  const { groupId, memberId } = await params;
  const user = await getCurrentUser();
  if (!user) redirect(`/sign-in?next=${encodeURIComponent(`/cover-debt/${groupId}/${memberId}`)}`);

  const prepared = await prepareCoverDebt(user.id, groupId, memberId);

  return (
    <AuthFrame>
      <Logo className="mb-12" />
      {!prepared.ok ? (
        <>
          <h1 className="text-[1.75rem] leading-tight font-semibold tracking-tight text-ink">Nothing to cover</h1>
          <p role="alert" className="mt-3 text-ink-muted">
            {prepared.reason}
          </p>
        </>
      ) : (
        <CoverDebtConfirm
          groupId={groupId}
          memberId={memberId}
          title={prepared.self ? `Pay off what you owe in ${prepared.groupName}` : `Cover ${prepared.debtorName}'s debt in ${prepared.groupName}`}
          lines={[
            `${prepared.amount} from your wallet, straight to whoever ${prepared.self ? "you" : prepared.debtorName} shorted.`,
            prepared.self
              ? "Once it's paid, you no longer owe anything in this group."
              : `Once it's paid, ${prepared.debtorName} no longer owes anything in this group. It's a gift: Rallied doesn't record it as a loan.`,
          ]}
        />
      )}
    </AuthFrame>
  );
}
