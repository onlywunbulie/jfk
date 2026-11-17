import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { DEFAULT_GOVERNANCE, type GovernedAction } from "@/lib/db/schema";
import { createGroup, createInvite, getGroupDetail, listGroupsForUser, listMembers } from "@/modules/groups/service";
import { Money } from "@/lib/money";
import { contractThresholds } from "@/modules/groups/onchain-setup";
import { startGroupOnChain } from "@/modules/groups/onchain";
import { EXPLORER_URL } from "@/lib/chain/addresses";
import { listProposals } from "@/modules/governance/service";
import { aiAllowedInGroup, aiOptedOutGroups } from "./connection";
import { draftRoleChange, draftRuleChange, draftSpend } from "./drafts";
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
        "the user sends it to a vote themselves in Rallied. Nothing you do here moves money or votes.",
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
      const [groups, optedOut] = await Promise.all([listGroupsForUser(userId), aiOptedOutGroups(userId)]);
      return json({
        groups: groups
          .filter((group) => !optedOut.has(group.id))
          .map((group) => ({
          group_id: group.id,
          name: group.name,
          kind: group.type === "ROTATING" ? "rotating savings" : "shared pot",
          your_role: group.role.toLowerCase(),
          members: group.memberCount,
          each_pays: `${money(group.contributionAmount)} every ${group.cadence === "MONTHLY" ? "month" : "week"}`,
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

      return json({
        group_id: group.id,
        name: group.name,
        description: group.description,
        kind: rotating ? "rotating savings" : "shared pot",
        created: group.createdAt.toISOString().slice(0, 10),
        your_role: group.role.toLowerCase(),
        balance: money(group.balance.total),
        each_pays: money(group.contributionAmount),
        how_often: group.cadence === "MONTHLY" ? `monthly, due on day ${group.dueDay}` : `weekly, due on day ${group.dueDay} (1 = Monday)`,
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

  const drafted = (result: Awaited<ReturnType<typeof draftSpend>>, channel: string, what: string) => {
    if (!result.ok) return { isError: true, content: [{ type: "text" as const, text: result.reason }] };
    const link = `${grant.origin}/groups/${result.draft.groupId}/${channel}`;
    return json({
      drafted: what,
      status: "waiting for the user to send it to a vote",
      open_in_rallied: link,
      next: "Tell the user it's ready and share the link. Only they can send it; it does nothing until they do.",
    });
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
        "Confirm the name, kind, amount, how often and due day with the user first. Then offer an invite link.",
      inputSchema: {
        name: z.string().min(1).max(60).describe("The group's name, e.g. 'Detty December'"),
        kind: z.enum(["shared_pot", "rotating_savings"]),
        amount: z.string().regex(/^\d+(\.\d{1,2})?$/).describe("What each member pays each time, in USDC, e.g. '100'"),
        how_often: z.enum(["monthly", "weekly"]),
        due_day: z.number().int().min(1).max(28).describe("Monthly: day of the month, 1 to 28. Weekly: 1 (Monday) to 7 (Sunday)."),
        description: z.string().max(200).optional().describe("Optional: what the group is saving for"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ name, kind, amount, how_often, due_day, description }) => {
      if (!canDraft) return noDraftScope;
      if (how_often === "weekly" && due_day > 7) return refusal("For a weekly group, the due day is 1 (Monday) to 7 (Sunday).");
      const contribution = Money.fromMajor(amount, "USDC");
      if (contribution.minor <= 0n) return refusal("The amount must be more than zero.");

      const { groupId } = await createGroup(userId, {
        name: name.trim(),
        description: description?.trim() || null,
        type: kind === "rotating_savings" ? "ROTATING" : "TREASURY",
        contributionAmount: contribution,
        cadence: how_often === "monthly" ? "MONTHLY" : "WEEKLY",
        dueDay: due_day,
      });
      return json({
        created: name.trim(),
        group_id: groupId,
        open_in_rallied: `${grant.origin}/groups/${groupId}/about`,
        next: "Offer an invite link (invite_link) so friends can join. When the user wants it on Base, use start_on_base; it's best once friends have joined, since anyone joining after needs a vote.",
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
        next: "Share the link with the friends who should join.",
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
        next: "The group can now pay dues into its vault (from #about) and vote on changes. Anyone who joins from now on needs the group's vote.",
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
