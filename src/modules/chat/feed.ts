import "server-only";
import { inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { users, type ProposalStatus } from "@/lib/db/schema";
import { getProposal } from "@/modules/governance/service";
import { formatPermille } from "@/modules/governance/threshold";
import { listMessages } from "./service";

/**
 * The chat as the screen draws it: messages and events, with every event
 * filled in with its live state, as plain data that can cross to the browser.
 *
 * A proposal card is read fresh each time, so the tally on it is the tally
 * now, not the tally when it was posted.
 */

export interface ProposalCard {
  id: string;
  title: string;
  amount: string | null;
  proposer: string;
  yes: number;
  no: number;
  abstain: number;
  eligible: number;
  needs: string;
  status: ProposalStatus;
  closesAt: string;
  yourVote: "YES" | "NO" | "ABSTAIN" | null;
  canVote: boolean;
}

export type FeedItem =
  | { id: string; kind: "text"; at: string; authorId: string | null; authorName: string; body: string }
  | { id: string; kind: "proposal"; at: string; proposal: ProposalCard }
  | { id: string; kind: "decided"; at: string; title: string; outcome: "approved" | "rejected" | "expired" }
  | { id: string; kind: "joined"; at: string; name: string }
  | { id: string; kind: "started"; at: string; safeAddress: string };

export async function loadFeed(groupId: string, viewerId: string): Promise<FeedItem[] | null> {
  const messages = await listMessages(groupId, viewerId);
  if (!messages) return null;

  // Names for "joined" events, in one query.
  const joinerIds = messages.flatMap((m) =>
    m.event?.type === "member_joined" ? [m.event.userId] : [],
  );
  const names = new Map(
    joinerIds.length
      ? (
          await db
            .select({ id: users.id, name: users.displayName })
            .from(users)
            .where(inArray(users.id, joinerIds))
        ).map((u) => [u.id, u.name])
      : [],
  );

  // Each proposal is looked up once, however many events mention it.
  const proposalIds = [
    ...new Set(
      messages.flatMap((m) =>
        m.event?.type === "proposal_opened" || m.event?.type === "proposal_decided"
          ? [m.event.proposalId]
          : [],
      ),
    ),
  ];
  const proposals = new Map(
    await Promise.all(
      proposalIds.map(async (id) => [id, await getProposal(id, viewerId)] as const),
    ),
  );

  const feed: FeedItem[] = [];
  for (const m of messages) {
    const at = m.createdAt.toISOString();
    if (m.kind === "TEXT" && m.body) {
      feed.push({
        id: m.id,
        kind: "text",
        at,
        authorId: m.authorId,
        authorName: m.authorName ?? "Someone who left",
        body: m.body,
      });
      continue;
    }

    const event = m.event;
    if (!event) continue;

    if (event.type === "proposal_opened") {
      const p = proposals.get(event.proposalId);
      if (!p) continue;
      feed.push({
        id: m.id,
        kind: "proposal",
        at,
        proposal: {
          id: p.id,
          title: p.title,
          amount: p.amount ? p.amount.format({ compact: true }) : null,
          proposer: p.createdByName,
          yes: p.tally.yes,
          no: p.tally.no,
          abstain: p.tally.abstain,
          eligible: p.eligibleVoterCount,
          needs: formatPermille(p.thresholdPermille),
          status: p.status,
          closesAt: p.closesAt.toISOString(),
          yourVote: p.yourVote,
          canVote: p.canVote,
        },
      });
    } else if (event.type === "proposal_decided") {
      const p = proposals.get(event.proposalId);
      feed.push({ id: m.id, kind: "decided", at, title: p?.title ?? "A proposal", outcome: event.outcome });
    } else if (event.type === "member_joined") {
      feed.push({ id: m.id, kind: "joined", at, name: names.get(event.userId) ?? "Someone" });
    } else if (event.type === "group_started") {
      feed.push({ id: m.id, kind: "started", at, safeAddress: event.safeAddress });
    }
  }
  return feed;
}
