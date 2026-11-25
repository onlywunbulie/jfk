import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { after } from "next/server";
import { z } from "zod";

import { DEFAULT_GOVERNANCE, type GovernedAction } from "@/lib/db/schema";
import { createGroup, createInvite, deleteGroup, getGroupDetail, getMembership, listGroupsForUser, listMembers } from "@/modules/groups/service";
import { Money } from "@/lib/money";
import { contractThresholds } from "@/modules/groups/onchain-setup";
import { startGroupOnChain } from "@/modules/groups/onchain";
import { readDues } from "@/modules/groups/onchain-dues";
import { chainSummaries } from "@/modules/groups/onchain-summary";
import { autopayStatus, collectDues, stopAutopay } from "@/modules/groups/onchain-autopay";
import { readChainVotes } from "@/modules/groups/onchain-votes";
import { prepareCoverDebt, readRotation } from "@/modules/groups/onchain-rotation";
import { setGroupImageFromLink } from "@/modules/groups/images";
import { aiVoteStatus, castVoteForUser } from "@/modules/groups/onchain-ai-votes";
import { chainActionLimit } from "@/lib/rate-limit";
import { issueUploadToken } from "@/lib/upload-token";
import { nextAcrossGroups, nextForGroup } from "./next-steps";
import { EXPLORER_URL } from "@/lib/chain/addresses";
import { HOW_OFTEN, everyText } from "@/lib/schedule-text";
import { listProposals } from "@/modules/governance/service";
import { aiAllowedInGroup, aiOptedOutGroups } from "./connection";
import { DECISIONS, draftGroupChange, draftRoleChange, draftRuleChange, draftSpend } from "@/modules/agents/drafts";
import { DRAFT_SCOPE } from "./oauth";
import { checkGroup, checkUser, listNotifications } from "@/modules/notifications/service";

/**
 * Rallied's MCP server, as one signed-in user's AI sees it. Built fresh for
 * each request with that user baked in, so a tool can never be pointed at
 * someone else: every tool goes through the same services as the app, which
 * return nothing for groups the user isn't in.
 *
 * Reading, plus drafting (with the drafts:write scope): a draft lands in the
 * user's Waiting section and does nothing until they send it. The only money
 * a tool moves is the user's own dues, once they've allowed it; the only vote
 * it casts is the user's own, the way they said, in a group where they've let
 * their AI vote (allow_ai_votes).
 */
export function buildRalliedServer(grant: { userId: string; scope: string; appName: string; origin: string }): McpServer {
  const { userId } = grant;
  const canDraft = grant.scope.split(" ").includes(DRAFT_SCOPE);
  const server = new McpServer(
    { name: "rallied", title: "Rallied", version: "0.1.0" },
    {
      instructions:
        "Rallied is a group savings app: friends pool money in USDC on Base, and money only moves when the group votes. " +
        "Use list_groups first to find the user's groups, then get_group or list_proposals with a group_id. " +
        "For \"what's new\" or a daily check-in, use whats_new. " +
        "Amounts are exact; don't round them. " +
        "The draft_ tools only prepare a draft: confirm the details with the user first, then share the link it returns; " +
        "the user sends it to a vote themselves in Rallied. " +
        "The only money you can move is the user's own dues, into their own group's vault, and only once they've allowed it with set_up_auto_pay. " +
        "When a group is on Base and the user hasn't turned on automatic dues there (get_group shows your_dues.automatic), offer it once, briefly, with the set-up link. " +
        "In a rotating group they're required, not optional: until they're on, remind the user each time the group comes up, with set_up_auto_pay. " +
        "When the user started a group that isn't on Base yet (vault_on_base is empty), offer once to start it with start_on_base, mentioning that anyone joining afterwards needs a vote. " +
        "You can't spend or send money anywhere else. " +
        "You can vote for the user only how they tell you, on the exact vote they mean, in a group where they've let you (allow_ai_votes): " +
        "never pick a side yourself, and if it's unclear, ask. They can always vote in Rallied instead. " +
        "How to reply: keep it short (one or two lines on what happened, with any link), then offer the result's suggested_next as a numbered list, " +
        "phrased exactly as given so the user can answer with just the number. If they reply with a number, do that option. " +
        "Don't add other suggestions or explain options they didn't ask about.",
    },
  );

  server.registerTool(
    "list_groups",
    {
      title: "List my groups",
      description: "Every Rallied group the user is in: name, kind, members, what each member pays, and the balance (for rotating savings, this round and the next payout date instead).",
      annotations: { readOnlyHint: true },
    },
    async () => {
      const [all, optedOut] = await Promise.all([listGroupsForUser(userId), aiOptedOutGroups(userId)]);
      const groups = all.filter((group) => !optedOut.has(group.id));
      // Rotating groups: the round, from Base, instead of a balance (their vault empties every turn).
      const rounds = await chainSummaries(groups.filter((group) => group.type === "ROTATING"), null);
      return json({
        suggested_next: await nextAcrossGroups(userId, groups),
        groups: groups.map((group) => {
          const round = rounds.get(group.id)?.round;
          return {
          group_id: group.id,
          name: group.name,
          kind: group.type === "ROTATING" ? "rotating savings" : "shared pot",
          your_role: group.role.toLowerCase(),
          members: group.memberCount,
          each_pays: `${money(group.contributionAmount)} every ${everyText(group.cadence, group.intervalWeeks)}`,
          ...(round
            ? { this_round: `${round.paidIn} of ${round.fullPot} paid in`, next_payout: round.nextPayoutAt.toISOString().slice(0, 10) }
            : { balance: money(group.balance.total) }),
          on_base: group.safeAddress !== null,
          };
        }),
      });
    },
  );

  server.registerTool(
    "get_group",
    {
      title: "Show a group",
      description:
        "One group in detail: what it's for, its members and admins, what everyone pays and when, and how many must agree for each kind of decision.",
      inputSchema: { group_id: z.string().min(1).max(64).describe("The group_id from list_groups") },
      annotations: { readOnlyHint: true },
    },
    async ({ group_id }) => {
      if (!(await aiAllowedInGroup(userId, group_id))) return notFound();
      const [group, members] = await Promise.all([getGroupDetail(group_id, userId), listMembers(group_id, userId)]);
      if (!group || !members) return notFound();

      const saved = Object.fromEntries(group.governance.map((rule) => [rule.action, rule.thresholdPermille])) as Partial<
        Record<GovernedAction, number>
      >;
      const [smallSpend, largeSpend, addMember, removeMember, replaceWallet, changePay, changeRules, close] =
        contractThresholds(saved);
      const rotating = group.type === "ROTATING";
      // For a group on Base the vault is the balance, and the user's dues are read from it too.
      const [dues, autopay] = group.safeAddress
        ? await Promise.all([readDues(group_id, userId), autopayStatus(userId, group_id)])
        : [null, null];
      // A rotating group on contract v3: the order, this round and who owes what, from Base.
      const rotation = rotating ? await readRotation(group.safeAddress, members) : null;
      const onRotation = rotation?.ok ? rotation : null;
      const nameOfSeat = (seat: { userId: string | null; name: string }) => (seat.userId === userId ? "you" : seat.name);

      return json({
        suggested_next: await nextForGroup(userId, group),
        group_id: group.id,
        name: group.name,
        description: group.description,
        kind: rotating ? "rotating savings" : "shared pot",
        created: group.createdAt.toISOString().slice(0, 10),
        your_role: group.role.toLowerCase(),
        balance: dues?.ok ? dues.vault : money(group.balance.total),
        each_pays: money(group.contributionAmount),
        your_dues: dues?.ok
          ? {
              this_period: dues.you.paidThisPeriod ?? "not paid yet",
              automatic: autopay?.on
                ? autopay.renew
                  ? `on, until ${autopay.until}, but on Rallied's old key: renew once at ${grant.origin}/auto-pay/${group_id} (one wallet confirm)`
                  : `on, until ${autopay.until}`
                : rotating
                  ? "off, and required in a rotating group: set it up now with set_up_auto_pay"
                  : "off (set_up_auto_pay turns it on)",
              ...(autopay?.on && autopay.problem ? { last_problem: autopay.problem } : {}),
            }
          : "the group isn't on Base yet",
        how_often:
          group.cadence === "MONTHLY"
            ? `every month, due on day ${group.dueDay}`
            : `every ${everyText(group.cadence, group.intervalWeeks)}, due on weekday ${group.dueDay} (1 = Monday)`,
        vault_on_base: group.safeAddress,
        members: members.map((member) => ({
          name: member.displayName,
          role: member.role === "OWNER" ? "started the group" : member.role.toLowerCase(),
        })),
        ...(onRotation
          ? {
              payout_order: {
                cycle: onRotation.cycle,
                each_turn: money(group.contributionAmount.times(onRotation.order.length)),
                next_to_collect: onRotation.order[onRotation.turn] ? nameOfSeat(onRotation.order[onRotation.turn]) : null,
                // Everyone still to collect, in order: what draft_group_change(change_order) rearranges.
                still_to_collect: onRotation.order.slice(onRotation.turn).map(nameOfSeat),
                turns: onRotation.order.map((seat, i) => ({
                  turn: i + 1,
                  name: nameOfSeat(seat),
                  collected_this_cycle: seat.collected,
                  paid_this_round: seat.paidThisRound,
                  automatic_dues: seat.autoDues,
                  ...(seat.leaving ? { leaves_when_the_cycle_ends: true } : {}),
                })),
                ...(onRotation.joining.length > 0 ? { joining_next_cycle: onRotation.joining.map(nameOfSeat) } : {}),
                payouts: "automatic, on each due date",
              },
              owing: [...onRotation.order, ...onRotation.joining]
                .filter((seat) => seat.debt > 0n)
                .map((seat) => ({ name: nameOfSeat(seat), owes: Money.fromMinor(seat.debt, "USDC").format() })),
            }
          : {}),
        rules: {
          a_vote_counts_when_this_share_votes: `${group.quorumPct}%`,
          share_that_must_agree: {
            ...(rotating ? {} : { small_spend: percent(smallSpend), large_spend: percent(largeSpend) }),
            adding_a_member: percent(addMember),
            removing_a_member: percent(removeMember),
            replacing_a_lost_wallet: percent(replaceWallet),
            changing_what_everyone_pays: percent(changePay),
            changing_the_rules: percent(changeRules),
            closing_the_group: percent(close),
            adding_or_removing_an_admin: percent(saved.REMOVE_ADMIN ?? DEFAULT_GOVERNANCE.REMOVE_ADMIN),
            ...(onRotation ? { changing_the_payout_order: percent(changeRules) } : {}),
          },
          ...(onRotation
            ? {
                missing_a_round: "you owe it; your next payment goes straight to whoever was short, and if you haven't collected yet you move to the back",
                after_your_turn: "automatic dues stay on until the cycle ends",
                leaving: "a member who leaves finishes the cycle (paying in and collecting their turn), then goes",
                voted_out: "someone owing goes at once and their debt stays on record; anyone else finishes the cycle first",
                closing: "this round's payments go back to whoever paid them; anything else is split equally",
                anyone_can_cover_a_debt: "cover_debt gives the link",
              }
            : {
                leaving: "a member who leaves gives up what they paid in",
                voted_out: "a member voted out gets back what they paid in",
                closing: "the pot is split by how much each person paid in",
              }),
        },
      });
    },
  );

  server.registerTool(
    "whats_new",
    {
      title: "What needs me",
      description:
        "Across all the user's groups, checked on Base now: what needs them (votes to vote on, votes closing soon, dues due, money owed) " +
        "and what happened recently (results, payouts). Made for a daily check-in: tell the user the needs_you items first, then the news, briefly. " +
        "Nothing new is a fine answer; say so in one line.",
      inputSchema: {
        days: z.number().int().min(1).max(14).default(1).describe("How many days of news to include"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ days }) => {
      const now = new Date();
      const [optedOut, run] = await Promise.all([aiOptedOutGroups(userId), checkUser(userId, now)]);
      const since = now.getTime() - days * 24 * 60 * 60 * 1000;
      const link = (url: string) => `${grant.origin}${url}`;
      const needs = run.current.filter((notice) => !optedOut.has(notice.groupId) && NEEDS_YOU.test(notice.key));
      const news = (await listNotifications(userId, 50)).filter(
        (row) => row.createdAt.getTime() >= since && !(row.groupId && optedOut.has(row.groupId)) && !NEEDS_YOU.test(row.key),
      );
      const groups = (await listGroupsForUser(userId)).filter((group) => !optedOut.has(group.id));
      return json({
        checked_at: now.toISOString(),
        needs_you: needs.map((notice) => ({ what: notice.title, detail: notice.body, open: link(notice.url) })),
        news: news.map((row) => ({ when: row.createdAt.toISOString(), what: row.title, detail: row.body, open: link(row.url) })),
        suggested_next: await nextAcrossGroups(userId, groups),
      });
    },
  );

  server.registerTool(
    "list_proposals",
    {
      title: "List a group's proposals",
      description:
        "A group's proposals and votes: what each asks for, the amount, the tally so far, how much must agree, when it closes, and how the user voted.",
      inputSchema: {
        group_id: z.string().min(1).max(64).describe("The group_id from list_groups"),
        only_open: z.boolean().default(true).describe("Only proposals still being voted on"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ group_id, only_open }) => {
      if (!(await aiAllowedInGroup(userId, group_id))) return notFound();
      const group = await getGroupDetail(group_id, userId);
      if (!group) return notFound();
      if (group.safeAddress) {
        const live = await readChainVotes(group_id, userId);
        if (!live.ok) return refusal("Couldn't read this group's votes from Base just now. Try again in a moment.");
        return json({
          suggested_next: await nextForGroup(userId, group),
          votes_on_base: live.votes
            .filter((vote) => !only_open || vote.state === "OPEN" || vote.state === "PASSED")
            .map((vote) => ({
              vote_id: vote.id,
              title: vote.title,
              change: vote.change ? `${vote.change.before} → ${vote.change.after}` : vote.detail,
              state: { OPEN: "being voted on", PASSED: "passed, being carried out", DONE: "passed and carried out", FAILED: "didn't pass" }[vote.state],
              closes: vote.closes,
              yes: vote.yes,
              no: vote.no,
              eligible_voters: vote.eligible,
              must_agree: vote.need,
              your_vote: vote.mine?.toLowerCase() ?? (vote.canVote ? "not voted yet" : "not voting"),
              ...(vote.warning ? { warning: vote.warning } : {}),
            })),
          vote_in_rallied: `${grant.origin}/groups/${group_id}/votes`,
        });
      }
      const proposals = await listProposals(group_id, userId);
      if (!proposals) return notFound();
      return json({
        proposals: proposals
          .filter((proposal) => !only_open || proposal.status === "OPEN")
          .map((proposal) => ({
            title: proposal.title,
            kind: proposal.action.toLowerCase().replaceAll("_", " "),
            amount: proposal.amount ? money(proposal.amount) : null,
            status: proposal.status.toLowerCase(),
            closes: proposal.closesAt.toISOString(),
            votes: proposal.tally,
            eligible_voters: proposal.eligibleVoterCount,
            must_agree: percent(proposal.thresholdPermille),
            your_vote: proposal.yourVote?.toLowerCase() ?? "not voted",
          })),
      });
    },
  );

  // -------------------------------------------------------------------------
  // Drafting: prepares a draft in the user's Waiting section. Never sends.
  // -------------------------------------------------------------------------

  const drafted = async (result: Awaited<ReturnType<typeof draftSpend>>, channel: string, what: string) => {
    if (!result.ok) return { isError: true, content: [{ type: "text" as const, text: result.reason }] };
    const link = `${grant.origin}/groups/${result.draft.groupId}/${channel}`;
    const group = await getGroupDetail(result.draft.groupId, userId);
    return json({
      drafted: what,
      status: "waiting for the user to send it to a vote (only they can; it does nothing until then)",
      open_in_rallied: link,
      suggested_next: group ? await nextForGroup(userId, group, ["Open it to send to a vote"]) : ["Open it to send to a vote"],
    });
  };

  /** The next steps for a group the user is in, by id, with any that should come first. */
  const suggest = async (groupId: string, first: string[] = []) => {
    const group = await getGroupDetail(groupId, userId);
    return group ? nextForGroup(userId, group, first) : first.slice(0, 3);
  };

  const noDraftScope = {
    isError: true,
    content: [
      {
        type: "text" as const,
        text: "This connection can only read. Ask the user to reconnect Rallied in Claude (Settings → Connectors → Rallied → Connect) and Allow drafts.",
      },
    ],
  };

  server.registerTool(
    "draft_spend",
    {
      title: "Draft a spend",
      description:
        "Prepare a spend for a shared-pot group: what it's for, how much, and who gets paid (a member's name, or a wallet address on Base for someone outside the group). " +
        "It lands in the user's Waiting section in #propose a spend; they send it to a vote. Confirm the details with the user before calling this.",
      inputSchema: {
        group_id: z.string().min(1).max(64),
        what: z.string().min(1).max(80).describe("What the money is for, e.g. 'Airbnb deposit for December'"),
        amount: z.string().min(1).max(20).describe("Amount in the group's currency, e.g. '400' or '400.50'"),
        paid_to: z.string().min(1).max(64).describe("A member's name exactly as list_groups/get_group shows it, or a 0x wallet address"),
        receipt_url: z.string().max(500).optional().describe("Optional https link to an invoice, quote or listing"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ group_id, what, amount, paid_to, receipt_url }) => {
      if (!canDraft) return noDraftScope;
      const result = await draftSpend({ userId, groupId: group_id, madeBy: grant.appName, what, amount, paidTo: paid_to, receiptUrl: receipt_url });
      return drafted(result, "propose", `a spend: ${what}`);
    },
  );

  server.registerTool(
    "draft_rule_change",
    {
      title: "Draft a rule change",
      description:
        "Prepare a change to a group's rules: what everyone pays (rule what_everyone_pays, value like '150'), the due day " +
        "(rule due_day, value 1-28 for monthly groups or 1-7 Monday-Sunday for weekly ones), how many must vote for a vote to count " +
        "(rule votes_count_share, value a whole percentage), the share that must agree for one kind of decision " +
        "(rule share_needed with decision, value a percentage from 50 to 100), or how long votes stay open (rule vote_days, value 1-30). " +
        "It lands in the user's Waiting section in #edit rules; they send it to a vote.",
      inputSchema: {
        group_id: z.string().min(1).max(64),
        rule: z.enum(["what_everyone_pays", "due_day", "votes_count_share", "share_needed", "vote_days"]),
        value: z.string().min(1).max(20).describe("The new value"),
        decision: z
          .enum(Object.keys(DECISIONS) as [keyof typeof DECISIONS, ...(keyof typeof DECISIONS)[]])
          .optional()
          .describe("share_needed only: which decision's share to change"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ group_id, rule, value, decision }) => {
      if (!canDraft) return noDraftScope;
      const result = await draftRuleChange({ userId, groupId: group_id, madeBy: grant.appName, rule, value, decision });
      return drafted(result, "edit-rules", `a rule change (${rule.replaceAll("_", " ")} → ${value})`);
    },
  );

  server.registerTool(
    "draft_role_change",
    {
      title: "Draft a change to who's in the group",
      description:
        "Prepare a change to who's in a group or looks after it: make a member an admin, remove an admin, remove a member, " +
        "add someone to a group already on Base (add_member, with their name and wallet; invite links stop working once a group is on Base), " +
        "or move a member who lost their wallet to a new one (replace_wallet, with the member's name and new wallet). " +
        "It lands in the user's Waiting section in #manage roles; they send it to a vote.",
      inputSchema: {
        group_id: z.string().min(1).max(64),
        change: z.enum(["make_admin", "remove_admin", "remove_member", "add_member", "replace_wallet"]),
        member_name: z.string().min(1).max(64).describe("The member's name exactly as get_group shows it; for add_member, the new person's name"),
        wallet: z.string().max(64).optional().describe("add_member: their wallet on Base. replace_wallet: the member's new wallet."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ group_id, change, member_name, wallet }) => {
      if (!canDraft) return noDraftScope;
      const result = await draftRoleChange({ userId, groupId: group_id, madeBy: grant.appName, change, memberName: member_name, wallet });
      return drafted(result, "manage-roles", `a role change (${change.replaceAll("_", " ")}: ${member_name})`);
    },
  );

  server.registerTool(
    "draft_group_change",
    {
      title: "Draft a whole-group decision",
      description:
        "Prepare a decision about the whole group on Base: close it (close_group), sharing the vault out by how much each member paid in; " +
        "or, in a rotating group, rearrange who collects next (change_order, with order: the names of everyone still to collect this cycle, each once, in the new order). " +
        "get_group shows the current order. A new order is voted on with the bar for changing the rules. " +
        "It lands in the user's Waiting section in #propose; they send it to a vote. A group not on Base isn't closed by vote: its starter deletes it (delete_group).",
      inputSchema: {
        group_id: z.string().min(1).max(64),
        change: z.enum(["close_group", "change_order"]),
        order: z
          .array(z.string().min(1).max(60))
          .max(50)
          .optional()
          .describe("change_order only: everyone still to collect this cycle, by name, in the new order"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ group_id, change, order }) => {
      if (!canDraft) return noDraftScope;
      const result = await draftGroupChange({ userId, groupId: group_id, madeBy: grant.appName, change, order });
      return drafted(result, "propose", change === "change_order" ? "a new payout order" : "closing the group");
    },
  );

  server.registerTool(
    "set_group_image",
    {
      title: "Set a group's picture or banner",
      description:
        "Set a group's picture (square; the side rail) or banner (wide; the top of its sidebar) from an https link to a PNG, JPG or WebP image online, up to 10 MB. " +
        "Rallied downloads it, crops it to shape and saves a fresh copy. Only the group's owner and admins can. " +
        "A photo the user attached in this chat has no link you can pass: send it with upload_group_image, or give them the group's add_picture_and_banner link (from create_group), " +
        `or ${grant.origin}/groups/<group_id>/about?group-profile=1.`,
      inputSchema: {
        group_id: z.string().min(1).max(64),
        kind: z.enum(["picture", "banner"]),
        image_url: z.string().url().max(2048).describe("An https link to the image itself"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ group_id, kind, image_url }) => {
      if (!canDraft) return noDraftScope;
      if (!(await aiAllowedInGroup(userId, group_id))) return notFound();
      const result = await setGroupImageFromLink(userId, group_id, kind === "picture" ? "avatar" : "banner", image_url);
      if (!result.ok) return refusal(result.reason);
      return json({
        set: kind,
        see_it: `${grant.origin}/groups/${group_id}/about?group-profile=1`,
        suggested_next: await suggest(group_id),
      });
    },
  );

  server.registerTool(
    "upload_group_image",
    {
      title: "Get an address to upload a group's picture or banner",
      description:
        "For a photo the user attached in this chat: returns a one-time https address (valid 15 minutes, one upload) for one group's picture (square; the side rail) or banner (wide). " +
        "Send the file there with code, e.g. curl -X PUT --data-binary @<path of the attached file> <upload_url>. " +
        "Attached files are usually under /mnt/user-data/uploads/. PNG, JPG or WebP, at most 4.5 MB: shrink a bigger photo first. " +
        "Rallied crops it to shape and saves a fresh copy. Only the group's owner and admins can. " +
        "If your code can't reach the address (no internet access), give the user the add_picture_and_banner link instead.",
      inputSchema: {
        group_id: z.string().min(1).max(64),
        kind: z.enum(["picture", "banner"]),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ group_id, kind }) => {
      if (!canDraft) return noDraftScope;
      if (!(await aiAllowedInGroup(userId, group_id))) return notFound();
      const membership = await getMembership(group_id, userId);
      if (!membership || membership.role === null) return notFound();
      if (membership.role !== "OWNER" && membership.role !== "ADMIN") {
        return refusal("Only the group's owner and admins can change its picture and banner.");
      }
      const token = issueUploadToken({ userId, groupId: group_id, kind: kind === "picture" ? "avatar" : "banner" });
      const uploadUrl = `${grant.origin}/api/upload/group-image/${token}`;
      return json({
        upload_url: uploadUrl,
        how: `curl -X PUT --data-binary @<file> "${uploadUrl}"`,
        expires_in: "15 minutes, one upload",
        largest: "4.5 MB",
        if_it_fails: `${grant.origin}/groups/${group_id}/about?group-profile=1`,
      });
    },
  );

  server.registerTool(
    "delete_group",
    {
      title: "Delete a group that isn't on Base",
      description:
        "Delete one of the user's groups that was never started on Base: it has no vault and no money, so it needs no vote. " +
        "Only its starter can, and only after confirming with the user, since it can't be undone. A group on Base closes by vote instead (draft_group_change).",
      inputSchema: { group_id: z.string().min(1).max(64), confirmed: z.literal(true).describe("The user confirmed they want it deleted") },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    async ({ group_id }) => {
      if (!canDraft) return noDraftScope;
      if (!(await aiAllowedInGroup(userId, group_id))) return notFound();
      const result = await deleteGroup(group_id, userId);
      if (!result.ok) {
        if (result.reason === "not_found") return notFound();
        return refusal(
          result.reason === "not_owner"
            ? "Only the person who started this group can delete it."
            : "This group is on Base, so it can't just be deleted: closing it is a group vote (draft_group_change), which shares the vault out.",
        );
      }
      return json({ deleted: true, suggested_next: await nextAcrossGroups(userId, (await listGroupsForUser(userId)).filter((g) => g.id !== group_id)) });
    },
  );

  // -------------------------------------------------------------------------
  // Setting up: a new group, and invite links. Moves no money.
  // -------------------------------------------------------------------------

  server.registerTool(
    "create_group",
    {
      title: "Create a group",
      description:
        "Start a new Rallied group with the user as its starter, saving in digital dollars (USDC). " +
        "kind: shared_pot (everyone pays into one pot; money leaves only by vote) or rotating_savings (each round's pot goes to one member in turn). " +
        "It moves no money and isn't on Base yet. Put it on Base with start_on_base when the user asks, usually once friends have joined (anyone joining after needs a vote). " +
        "Before creating, ask the user how often everyone pays: every week, every 2 weeks, every 3 weeks or every month " +
        "(every 2 or 3 months isn't available yet; it comes with Rallied's next contract). " +
        "Confirm the name, kind, amount, how often and due day with the user first. " +
        "Also ask whether they have a group picture (square; shows beside the group in the side rail) and a banner (wide; across the top of the group's sidebar). " +
        "Once it's created: for an image that's online, pass its https link to set_group_image. " +
        "For a photo they attached in this chat: if you can run code that reaches the internet, send it with upload_group_image; " +
        "if you can't, or that fails, give them add_picture_and_banner, where they upload it in one step. " +
        "Then offer the suggested next steps.",
      inputSchema: {
        name: z.string().min(1).max(60).describe("The group's name, e.g. 'Detty December'"),
        kind: z.enum(["shared_pot", "rotating_savings"]),
        amount: z.string().regex(/^\d+(\.\d{1,2})?$/).describe("What each member pays each time, in USDC, e.g. '100'"),
        how_often: z
          .enum(["weekly", "every_2_weeks", "every_3_weeks", "monthly"])
          .describe("How often everyone pays. Ask the user; don't assume."),
        due_day: z
          .number()
          .int()
          .min(1)
          .max(28)
          .describe("Monthly: day of the month, 1 to 28. Every 1, 2 or 3 weeks: the weekday, 1 (Monday) to 7 (Sunday)."),
        description: z.string().max(200).optional().describe("Optional: what the group is saving for"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ name, kind, amount, how_often, due_day, description }) => {
      if (!canDraft) return noDraftScope;
      const schedule = HOW_OFTEN.find((option) => option.key === how_often) ?? HOW_OFTEN[3];
      if (schedule.cadence === "WEEKLY" && due_day > 7) return refusal("For a group that pays by the week, the due day is a weekday: 1 (Monday) to 7 (Sunday).");
      const contribution = Money.fromMajor(amount, "USDC");
      if (contribution.minor <= 0n) return refusal("The amount must be more than zero.");

      const { groupId } = await createGroup(userId, {
        name: name.trim(),
        description: description?.trim() || null,
        type: kind === "rotating_savings" ? "ROTATING" : "TREASURY",
        contributionAmount: contribution,
        cadence: schedule.cadence,
        intervalWeeks: schedule.intervalWeeks,
        dueDay: due_day,
      });
      return json({
        created: name.trim(),
        group_id: groupId,
        open_in_rallied: `${grant.origin}/groups/${groupId}/about`,
        // Pictures are picked and uploaded in Rallied: the AI only passes the link on.
        add_picture_and_banner: `${grant.origin}/groups/${groupId}/about?group-profile=1`,
        // Start on Base after friends join (later joiners need a vote), or now if it's just the user.
        suggested_next: [`Invite friends to ${name.trim()}`, `Start ${name.trim()} on Base now (just me for now)`],
      });
    },
  );

  server.registerTool(
    "invite_link",
    {
      title: "Make an invite link",
      description:
        "A link the user can share so friends can join one of their groups. Choose how many people may use it (1 to 20). It expires on its own.",
      inputSchema: {
        group_id: z.string().min(1).max(64),
        uses: z.number().int().min(1).max(20).default(10).describe("How many people may join with this link"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ group_id, uses }) => {
      if (!canDraft) return noDraftScope;
      if (!(await aiAllowedInGroup(userId, group_id))) return notFound();
      let result: Awaited<ReturnType<typeof createInvite>>;
      try {
        result = await createInvite(group_id, userId, { maxUses: uses });
      } catch {
        // The user's role in this group doesn't let them invite.
        return refusal("Only the group's starter and admins can invite people to this group.");
      }
      if (!result.ok) return notFound();
      return json({
        invite_link: `${grant.origin}/join/${result.code}`,
        uses,
        expires: result.expiresAt.toISOString().slice(0, 10),
        suggested_next: await suggest(group_id),
      });
    },
  );

  server.registerTool(
    "start_on_base",
    {
      title: "Start a group on Base",
      description:
        "Give one of the user's groups its own vault on Base, with every current member as an owner. Only the group's starter can do this, once everyone who should be in it has joined: anyone joining later needs a vote. Rallied pays the network fee. Moves no money.",
      inputSchema: { group_id: z.string().min(1).max(64) },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ group_id }) => {
      if (!canDraft) return noDraftScope;
      if (!(await aiAllowedInGroup(userId, group_id))) return notFound();
      const result = await startGroupOnChain(group_id, userId);
      if (!result.ok) {
        if (result.reason === "not_found") return notFound();
        if (result.reason === "already_started") return refusal("This group is already on Base. Its vault is shown in get_group.");
        return refusal(
          {
            not_owner: "Only the person who started this group can put it on Base. Ask them to.",
            not_usdc: "This group was made before Rallied moved on-chain, so it can't go on Base. Create a new group instead.",
            members_without_wallets: "Every member needs to have signed in to Rallied with a wallet first. Ask the ones who haven't to sign in.",
            no_relayer: "Rallied can't pay network fees right now. The user can try again later from #about.",
            relayer_out_of_funds: "Rallied's fee wallet is low, so new groups are paused for now. The user can try again later.",
            too_many_starts: "The user has started three groups on Base today, Rallied's daily limit. Try again tomorrow.",
            reverted: "Base refused to create the vault. Nothing was recorded; try again.",
            not_confirmed: "The vault was created but didn't check out, so Rallied didn't record it. Tell the user to contact Rallied.",
          }[result.reason],
        );
      }
      return json({
        started: true,
        vault: result.safeAddress,
        check_it: `${EXPLORER_URL}/address/${result.safeAddress}`,
        open_in_rallied: `${grant.origin}/groups/${group_id}/about`,
        set_up_auto_pay: `${grant.origin}/auto-pay/${group_id}`,
        note: "Dues and votes can begin. Anyone who joins from now on needs the group's vote.",
        suggested_next: await suggest(group_id),
      });
    },
  );

  server.registerTool(
    "set_up_auto_pay",
    {
      title: "Set up automatic dues",
      description:
        "Let Rallied pay the user's dues in one group automatically, on each due date, for a year. " +
        "The user confirms once in their wallet at the link this returns (it opens straight to the wallet confirm). " +
        "Rallied can then take only the group's amount, once a period, from the user into that group's vault. It can't spend or send money anywhere else.",
      inputSchema: { group_id: z.string().min(1).max(64) },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ group_id }) => {
      if (!canDraft) return noDraftScope;
      if (!(await aiAllowedInGroup(userId, group_id))) return notFound();
      const status = await autopayStatus(userId, group_id);
      if (!status) return refusal("That group isn't on Base yet, or you're not in it. Start it on Base first (start_on_base).");
      return json({
        confirm_here: `${grant.origin}/auto-pay/${group_id}`,
        ...(status.on ? { already_on_until: status.until, note: "Confirming again renews it for a year." } : {}),
        how: "One tap and one wallet confirm at the link. After that, dues are paid on each due date, or when asked.",
        suggested_next: ["I've confirmed it", ...(await suggest(group_id)).filter((step) => !/automatically/.test(step))].slice(0, 3),
      });
    },
  );

  server.registerTool(
    "vote",
    {
      title: "Vote for the user",
      description:
        "Cast the user's own vote on one vote in a group on Base (vote_id from list_proposals): yes, no or abstain. " +
        "Only the way the user told you in this conversation, for that exact vote; never choose for them, and ask if it's unclear. " +
        "It's their one vote, cast by Rallied's key as their helper, and votes can't be changed afterwards. " +
        "If they haven't let you vote for them in this group yet, this says so and gives the link to allow it (allow_ai_votes).",
      inputSchema: {
        group_id: z.string().min(1).max(64),
        vote_id: z.string().min(1).max(40).describe("The vote_id from list_proposals"),
        choice: z.enum(["yes", "no", "abstain"]),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ group_id, vote_id, choice }) => {
      if (!canDraft) return noDraftScope;
      if (!(await aiAllowedInGroup(userId, group_id))) return notFound();
      const slow = await chainActionLimit(userId);
      if (slow) return refusal(slow);
      const cast = await castVoteForUser(userId, group_id, vote_id, choice);
      // If that vote decided it, the group hears the result now.
      if (cast.ok) after(() => checkGroup(group_id).then(() => undefined));
      if (!cast.ok) {
        if (cast.allowAt) {
          return json({
            voted: false,
            why: cast.reason,
            allow_here: `${grant.origin}/ai-votes/${group_id}`,
            or_vote_in_rallied: `${grant.origin}/groups/${group_id}/votes`,
          });
        }
        return refusal(cast.reason);
      }
      return json({
        voted: choice,
        on_base: `${EXPLORER_URL}/tx/${cast.txHash}`,
        suggested_next: await suggest(group_id),
      });
    },
  );

  server.registerTool(
    "allow_ai_votes",
    {
      title: "Let the AI vote for the user, or stop it",
      description:
        "Returns the link where the user lets you vote for them in one group (one wallet confirm, for a year), or with stop: true, where they take that away. " +
        "Their automatic dues are kept either way. They can always vote in Rallied too.",
      inputSchema: {
        group_id: z.string().min(1).max(64),
        stop: z.boolean().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ group_id, stop }) => {
      if (!canDraft) return noDraftScope;
      if (!(await aiAllowedInGroup(userId, group_id))) return notFound();
      const status = await aiVoteStatus(userId, group_id);
      if (!status) return refusal("That group isn't on Base yet, or you're not in it.");
      return json({
        ...(stop ? { stop_here: `${grant.origin}/ai-votes/${group_id}?remove=1` } : { allow_here: `${grant.origin}/ai-votes/${group_id}` }),
        allowed_now: status.allowed,
        how: "One tap and one wallet confirm at the link.",
      });
    },
  );

  server.registerTool(
    "cover_debt",
    {
      title: "Cover a debt in a rotating group",
      description:
        "Pay off what a member owes in a rotating group (get_group shows who owes what), from the user's own wallet: " +
        "the whole amount goes straight to whoever they shorted. It can be the user's own debt, or a friend's. " +
        "This only returns a link: the user sees the exact amount there and confirms in their wallet. Confirm who and how much with the user first.",
      inputSchema: {
        group_id: z.string().min(1).max(64),
        member: z.string().min(1).max(60).describe("The name of the member whose debt to cover, as get_group lists it, or 'me'"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ group_id, member }) => {
      if (!canDraft) return noDraftScope;
      if (!(await aiAllowedInGroup(userId, group_id))) return notFound();
      const members = await listMembers(group_id, userId);
      if (!members) return notFound();
      const wanted = member.trim().toLowerCase();
      const matches = members.filter((m) => (wanted === "me" ? m.userId === userId : m.displayName.trim().toLowerCase() === wanted));
      if (matches.length === 0) return refusal(`No member called ${member.trim()} in this group.`);
      if (matches.length > 1) return refusal(`Two members are called ${member.trim()}, so a name alone can't pick one.`);
      const prepared = await prepareCoverDebt(userId, group_id, matches[0].memberId);
      if (!prepared.ok) return refusal(prepared.reason);
      return json({
        confirm_here: `${grant.origin}/cover-debt/${group_id}/${matches[0].memberId}`,
        amount: prepared.amount,
        covers: prepared.self ? "your own debt" : `${prepared.debtorName}'s debt`,
        how: "One tap and one wallet confirm at the link. It goes straight to whoever was short.",
        suggested_next: ["I've confirmed it", ...(await suggest(group_id))].slice(0, 3),
      });
    },
  );

  server.registerTool(
    "pay_dues",
    {
      title: "Pay the user's dues now",
      description:
        "Pay the user's dues for this period in one group, from their wallet into the group's vault, using the automatic dues they set up. " +
        "If they haven't set it up, this says so and gives the set-up link (or they can pay by hand in the group's #about).",
      inputSchema: { group_id: z.string().min(1).max(64) },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ group_id }) => {
      if (!canDraft) return noDraftScope;
      if (!(await aiAllowedInGroup(userId, group_id))) return notFound();
      const result = await collectDues(userId, group_id, "asked");
      if (result.ok) {
        return json({
          paid: result.amount,
          into: "the group's vault on Base",
          check_it: `${EXPLORER_URL}/tx/${result.txHash}`,
          suggested_next: await suggest(group_id),
        });
      }
      if (result.reason === "not_found") return notFound();
      if (result.reason === "already_paid") return json({ paid: false, already: result.text, suggested_next: await suggest(group_id) });
      const setUp = ["not_set_up", "stopped", "ended", "removed_from_base", "allowance_used_up"].includes(result.reason);
      if (setUp) {
        return json({
          paid: false,
          why: result.text,
          set_up_once: `${grant.origin}/auto-pay/${group_id}`,
          pay_by_hand: `${grant.origin}/groups/${group_id}/about`,
          suggested_next: ["Set it up (one wallet confirm)", "I'll pay by hand this time"],
        });
      }
      return refusal(result.text);
    },
  );

  server.registerTool(
    "stop_auto_pay",
    {
      title: "Stop automatic dues",
      description:
        "Stop Rallied paying the user's dues automatically in one group. It takes effect at once. " +
        "The permission on Base stays until it ends, unless the user also removes it at the link this returns.",
      inputSchema: { group_id: z.string().min(1).max(64) },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ group_id }) => {
      if (!canDraft) return noDraftScope;
      if (!(await aiAllowedInGroup(userId, group_id))) return notFound();
      const group = await getGroupDetail(group_id, userId);
      if (group?.type === "ROTATING") {
        return refusal(
          "Automatic dues are required in a rotating group, so every turn is paid in full; they can't be stopped while you're in it. " +
            "To stop paying, leave the group: you finish this cycle (paying in and collecting your turn), then go.",
        );
      }
      const stopped = await stopAutopay(userId, group_id);
      if (!stopped.ok) return refusal(stopped.reason);
      return json({
        stopped: true,
        was_on: stopped.wasOn,
        note: "Rallied won't collect again in this group unless the user sets it up again.",
        remove_from_base_too: `${grant.origin}/auto-pay/${group_id}?remove=1`,
        suggested_next: ["Remove the permission from Base too", ...(await suggest(group_id)).filter((step) => !/automatically/.test(step))].slice(0, 3),
      });
    },
  );

  return server;
}

/** Notices about something the user should still do, as opposed to news. */
const NEEDS_YOU = /^(vote-opened|vote-closing|dues|debt):/;

function refusal(text: string) {
  return { isError: true, content: [{ type: "text" as const, text }] };
}

function json(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

function notFound() {
  return {
    isError: true,
    content: [{ type: "text" as const, text: "No group with that group_id that you're a member of. Use list_groups to see your groups." }],
  };
}

/** "$100.00" or "₦50,000.50": exact, never rounded, written the way Rallied shows it. */
function money(amount: Money): string {
  return amount.format();
}

function percent(permille: number): string {
  return permille % 10 === 0 ? `${permille / 10}%` : `${(permille / 10).toFixed(1)}%`;
}
