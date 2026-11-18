import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { DEFAULT_GOVERNANCE, type GovernedAction } from "@/lib/db/schema";
import { createGroup, createInvite, getGroupDetail, listGroupsForUser, listMembers } from "@/modules/groups/service";
import { Money } from "@/lib/money";
import { contractThresholds } from "@/modules/groups/onchain-setup";
import { startGroupOnChain } from "@/modules/groups/onchain";
import { readDues } from "@/modules/groups/onchain-dues";
import { autopayStatus, collectDues, stopAutopay } from "@/modules/groups/onchain-autopay";
import { readChainVotes } from "@/modules/groups/onchain-votes";
import { nextAcrossGroups, nextForGroup } from "./next-steps";
import { EXPLORER_URL } from "@/lib/chain/addresses";
import { HOW_OFTEN, everyText } from "@/lib/schedule-text";
import { listProposals } from "@/modules/governance/service";
import { aiAllowedInGroup, aiOptedOutGroups } from "./connection";
import { draftRoleChange, draftRuleChange, draftSpend } from "@/modules/agents/drafts";
import { DRAFT_SCOPE } from "./oauth";

/**
 * Rallied's MCP server, as one signed-in user's AI sees it. Built fresh for
 * each request with that user baked in, so a tool can never be pointed at
 * someone else: every tool goes through the same services as the app, which
 * return nothing for groups the user isn't in.
 *
 * Reading, plus drafting (with the drafts:write scope): a draft lands in the
 * user's Waiting section and does nothing until they send it. No tool moves
 * money or votes.
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
        "Amounts are exact; don't round them. " +
        "The draft_ tools only prepare a draft: confirm the details with the user first, then share the link it returns; " +
        "the user sends it to a vote themselves in Rallied. " +
        "The only money you can move is the user's own dues, into their own group's vault, and only once they've allowed it with set_up_auto_pay. " +
        "When a group is on Base and the user hasn't turned on automatic dues there (get_group shows your_dues.automatic), offer it once, briefly, with the set-up link. " +
        "When the user started a group that isn't on Base yet (vault_on_base is empty), offer once to start it with start_on_base, mentioning that anyone joining afterwards needs a vote. " +
        "You can't spend, send money anywhere else, or vote. " +
        "How to reply: keep it short (one or two lines on what happened, with any link), then offer the result's suggested_next as a numbered list, " +
        "phrased exactly as given so the user can answer with just the number. If they reply with a number, do that option. " +
        "Don't add other suggestions or explain options they didn't ask about.",
    },
  );

  server.registerTool(
    "list_groups",
    {
      title: "List my groups",
      description: "Every Rallied group the user is in: name, kind, members, what each member pays, and the balance.",
      annotations: { readOnlyHint: true },
    },
    async () => {
      const [all, optedOut] = await Promise.all([listGroupsForUser(userId), aiOptedOutGroups(userId)]);
      const groups = all.filter((group) => !optedOut.has(group.id));
      return json({
        suggested_next: await nextAcrossGroups(userId, groups),
        groups: groups
          .map((group) => ({
          group_id: group.id,
          name: group.name,
          kind: group.type === "ROTATING" ? "rotating savings" : "shared pot",
          your_role: group.role.toLowerCase(),
          members: group.memberCount,
          each_pays: `${money(group.contributionAmount)} every ${everyText(group.cadence, group.intervalWeeks)}`,
          balance: money(group.balance.total),
          on_base: group.safeAddress !== null,
        })),
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
              automatic: autopay?.on ? `on, until ${autopay.until}` : "off (set_up_auto_pay turns it on)",
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
          },
          leaving: "a member who leaves gives up what they paid in",
          voted_out: "a member voted out gets back what they paid in",
          closing: "the pot is split by how much each person paid in",
        },
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
              title: vote.title,
              change: vote.change ? `${vote.change.before} → ${vote.change.after}` : vote.detail,
              state: { OPEN: "being voted on", PASSED: "passed, being carried out", DONE: "passed and carried out", FAILED: "didn't pass" }[vote.state],
              closes: vote.closes,
              yes: vote.yes,
              no: vote.no,
              eligible_voters: vote.eligible,
              must_agree: vote.need,
              your_vote: vote.mine?.toLowerCase() ?? (vote.canVote ? "not voted yet" : "not voting"),
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
        "(rule due_day, value 1-28 for monthly groups or 1-7 Monday-Sunday for weekly ones), or how many must vote for a vote to count " +
        "(rule votes_count_share, value a whole percentage). It lands in the user's Waiting section in #edit rules; they send it to a vote.",
      inputSchema: {
        group_id: z.string().min(1).max(64),
        rule: z.enum(["what_everyone_pays", "due_day", "votes_count_share"]),
        value: z.string().min(1).max(20).describe("The new value"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ group_id, rule, value }) => {
      if (!canDraft) return noDraftScope;
      const result = await draftRuleChange({ userId, groupId: group_id, madeBy: grant.appName, rule, value });
      return drafted(result, "edit-rules", `a rule change (${rule.replaceAll("_", " ")} → ${value})`);
    },
  );

  server.registerTool(
    "draft_role_change",
    {
      title: "Draft a role change",
      description:
        "Prepare a change to who looks after a group: make a member an admin, remove an admin, or remove a member. " +
        "It lands in the user's Waiting section in #manage roles; they send it to a vote.",
      inputSchema: {
        group_id: z.string().min(1).max(64),
        change: z.enum(["make_admin", "remove_admin", "remove_member"]),
        member_name: z.string().min(1).max(64).describe("The member's name exactly as get_group shows it"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ group_id, change, member_name }) => {
      if (!canDraft) return noDraftScope;
      const result = await draftRoleChange({ userId, groupId: group_id, madeBy: grant.appName, change, memberName: member_name });
      return drafted(result, "manage-roles", `a role change (${change.replaceAll("_", " ")}: ${member_name})`);
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
        "Confirm the name, kind, amount, how often and due day with the user first. Then offer an invite link.",
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
            relayer_out_of_funds: "Rallied's fee wallet is empty right now. The user can try again later from #about.",
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

/** "USDC 100" or "NGN 50000.50": exact, with the currency's code. */
function money(amount: Money): string {
  return `${amount.currency} ${amount.format({ compact: true, showSymbol: false })}`;
}

function percent(permille: number): string {
  return permille % 10 === 0 ? `${permille / 10}%` : `${(permille / 10).toFixed(1)}%`;
}
