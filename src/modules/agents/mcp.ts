import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Money } from "@/lib/money";
import { DEFAULT_GOVERNANCE, type GovernedAction } from "@/lib/db/schema";
import { getGroupDetail, listGroupsForUser, listMembers } from "@/modules/groups/service";
import { contractThresholds } from "@/modules/groups/onchain-setup";
import { listProposals } from "@/modules/governance/service";
import { aiAllowedInGroup, aiOptedOutGroups } from "./connection";

/**
 * Rallied's MCP server, as one signed-in user's AI sees it. Built fresh for
 * each request with that user baked in, so a tool can never be pointed at
 * someone else: every tool goes through the same services as the app, which
 * return nothing for groups the user isn't in.
 *
 * Read-only for now. Drafting proposals and acting come later.
 */
export function buildRalliedServer(userId: string): McpServer {
  const server = new McpServer(
    { name: "rallied", title: "Rallied", version: "0.1.0" },
    {
      instructions:
        "Rallied is a group savings app: friends pool money in USDC on Base, and money only moves when the group votes. " +
        "Use list_groups first to find the user's groups, then get_group or list_proposals with a group_id. " +
        "Amounts are exact; don't round them. Everything here is read-only.",
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

  return server;
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
