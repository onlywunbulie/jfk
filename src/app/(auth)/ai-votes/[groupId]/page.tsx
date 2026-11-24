import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { getCurrentUser } from "@/lib/auth/session";
import { Logo } from "@/components/logo";
import { AuthFrame } from "../../auth-frame";
import { prepareAiVotes } from "@/modules/groups/onchain-ai-votes";
import { AiVotesConfirm } from "./confirm";

export const metadata: Metadata = { title: "Voting through your AI" };

const DAY = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "Africa/Lagos" });

/**
 * Claude links here so the user can let it vote for them in one group (or,
 * with ?remove=1, stop that). One wallet confirm; voting in #votes always
 * stays open too.
 */
export default async function AiVotesPage({ params, searchParams }: PageProps<"/ai-votes/[groupId]">) {
  const { groupId } = await params;
  const remove = (await searchParams).remove === "1";
  const user = await getCurrentUser();
  if (!user) redirect(`/sign-in?next=${encodeURIComponent(`/ai-votes/${groupId}${remove ? "?remove=1" : ""}`)}`);

  const prepared = await prepareAiVotes(user.id, groupId, remove ? "remove" : "allow");

  return (
    <AuthFrame>
      <Logo className="mb-12" />
      {!prepared.ok ? (
        <>
          <h1 className="text-[1.75rem] leading-tight font-semibold tracking-tight text-ink">Can&rsquo;t do this</h1>
          <p role="alert" className="mt-3 text-ink-muted">
            {prepared.reason}
          </p>
        </>
      ) : remove ? (
        <AiVotesConfirm
          groupId={groupId}
          mode="remove"
          title={`Stop your AI voting for you in ${prepared.groupName}`}
          lines={["Your AI won’t be able to vote for you here any more. Anything else it does for you, like your automatic dues, stays as it is."]}
        />
      ) : (
        <AiVotesConfirm
          groupId={groupId}
          mode="allow"
          title={`Let your AI vote for you in ${prepared.groupName}`}
          lines={[
            "When you tell your AI how to vote, it casts your vote for you. It’s your one vote, and Base records it as cast by your helper, Rallied’s key.",
            "Your AI should only vote the way you tell it. You can still vote in #votes yourself, and stop this any time.",
            `Until ${DAY.format(prepared.until)}.`,
          ]}
        />
      )}
    </AuthFrame>
  );
}
