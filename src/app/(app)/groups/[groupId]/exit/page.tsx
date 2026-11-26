import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { requireUser } from "@/lib/auth/session";
import { getGroupDetail } from "@/modules/groups/service";
import { readExit } from "@/modules/groups/onchain-exit";
import { EXPLORER_URL } from "@/lib/chain/addresses";
import { ChannelIntro, DateDivider, Detail, RallMessage } from "../[channel]/parts";
import { ExitActions } from "./exit-actions";

export const metadata: Metadata = { title: "Emergency exit" };

/** The written guide, for doing it on BaseScan with no Rallied at all. Public, so it outlives Rallied. */
const GUIDE_URL = "https://github.com/onlywunbulie/jfk/blob/master/EMERGENCY-EXIT.md";

const UNAVAILABLE = {
  not_found: null,
  not_on_base: "This group isn't on Base yet, so there's no vault to empty.",
  empty: "The vault is empty: there's nothing to pay out.",
  unreachable: "Couldn't reach Base just now. Try again in a moment.",
} as const;

/**
 * The emergency exit, linked from #rules: every member together pays the
 * vault out to themselves through their Safe, without Rallied's contract.
 * Everything here is read from Base (see modules/groups/onchain-exit.ts).
 */
export default async function ExitPage({ params }: PageProps<"/groups/[groupId]/exit">) {
  const { groupId } = await params;
  const user = await requireUser();
  const group = await getGroupDetail(groupId, user.id);
  if (!group) notFound();
  const exit = await readExit(groupId, user.id);
  if (!exit.ok && exit.reason === "not_found") notFound();

  const approvedCount = exit.ok ? exit.approvals.filter((a) => a.approved).length : 0;
  const footnote = (
    <p className="border-t border-border pt-3 text-xs text-ink-faint">
      {exit.ok && (
        <>
          <a
            href={`${EXPLORER_URL}/address/${exit.vault}`}
            target="_blank"
            rel="noreferrer"
            className="underline decoration-ink-faint/50 underline-offset-4 hover:text-ink"
          >
            BaseScan
          </a>
          {" · "}
        </>
      )}
      <a href={GUIDE_URL} target="_blank" rel="noreferrer" className="underline decoration-ink-faint/50 underline-offset-4 hover:text-ink">
        Doing it without Rallied
      </a>
    </p>
  );

  return (
    <div className="flex min-h-full flex-col justify-end">
      <ChannelIntro title="Emergency exit">
        If Rallied or its contract ever stops working, all of you together can pay {group.name}&rsquo;s vault out to yourselves.
        Nobody can do it alone, and it only pays the split below.
      </ChannelIntro>
      <DateDivider label="Today" />
      <RallMessage time="Read from Base just now" footnote={footnote}>
        {exit.ok ? (
          <>
            <Detail label="The split">
              <ul className="space-y-1 tabular-nums">
                {exit.shares.map((share) => (
                  <li key={share.name}>
                    {share.name} <span className="text-ink-muted">· {share.amount}</span>
                  </li>
                ))}
              </ul>
              <p className="mt-1 text-xs text-ink-muted">
                {exit.total} in all. {exit.rule}
              </p>
            </Detail>
            <Detail label="Approved">
              <p className="tabular-nums">
                {approvedCount} of {exit.approvals.length}
              </p>
              <ul className="mt-1 space-y-1">
                {exit.approvals.map((approval) => (
                  <li key={approval.name}>
                    {approval.name}{" "}
                    <span className={approval.approved ? "text-inflow" : "text-ink-muted"}>
                      · {approval.approved ? "approved" : "waiting"}
                    </span>
                  </li>
                ))}
              </ul>
            </Detail>
            <Detail label="Next">
              <ExitActions groupId={groupId} youApproved={exit.youApproved} ready={exit.ready} />
              <p className="mt-2 text-xs text-ink-muted">
                Approving costs a tiny network fee from your own wallet, so this works even if Rallied can&rsquo;t pay it. The
                amounts are fixed to what&rsquo;s in the vault now: if money comes in or goes out, approvals start again.
              </p>
            </Detail>
          </>
        ) : (
          <p className="text-ink-muted">{UNAVAILABLE[exit.reason]}</p>
        )}
      </RallMessage>
    </div>
  );
}
