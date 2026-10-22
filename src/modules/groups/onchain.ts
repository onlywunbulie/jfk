import "server-only";
import { and, asc, eq, isNull } from "drizzle-orm";
import { getAddress, type Address, type Hex } from "viem";
import { db } from "@/lib/db";
import {
  DEFAULT_VOTE_DAYS,
  governanceRules,
  groupMembers,
  groupSettings,
  groups,
  users,
  type GovernedAction,
} from "@/lib/db/schema";
import { Money, toCurrency } from "@/lib/money";
import { recordAudit } from "@/modules/audit/service";
import { getMembership } from "./service";
import { buildGroupSetup, predictSafeAddress } from "./onchain-setup";
import { confirmGroupSafe, deploySafe, hasCode, proxyCreationCode } from "./onchain-chain";

/**
 * Starting a group on-chain: the moment its money stops being an idea and
 * gets a Safe of its own.
 *
 * Members gather first; the owner starts the group once everyone is in. The
 * Safe is created with every member as an owner, so nobody has to be voted in
 * just to fill the group. Anyone who joins after this needs a vote, because
 * that is the contract's rule.
 */

export interface OnChainMember {
  displayName: string;
  hasWallet: boolean;
  isYou: boolean;
}

export interface OnChainStatus {
  started: boolean;
  safeAddress: string | null;
  isOwner: boolean;
  /** Only USDC groups can go on-chain; Paystack-era naira groups can't. */
  eligible: boolean;
  members: OnChainMember[];
}

export async function getOnChainStatus(groupId: string, viewerId: string): Promise<OnChainStatus | null> {
  const membership = await getMembership(groupId, viewerId);
  if (!membership || membership.role === null) return null;

  const [group] = await db
    .select({ currency: groups.currency, safeAddress: groups.safeAddress })
    .from(groups)
    .where(eq(groups.id, groupId))
    .limit(1);
  if (!group) return null;

  const members = await activeMembers(groupId);
  return {
    started: group.safeAddress !== null,
    safeAddress: group.safeAddress,
    isOwner: membership.role === "OWNER",
    eligible: group.currency === "USDC",
    members: members.map((m) => ({
      displayName: m.displayName,
      hasWallet: m.walletAddress !== null,
      isYou: m.userId === viewerId,
    })),
  };
}

export type StartOnChainResult =
  | { ok: true; safeAddress: Address; txHash: Hex | null }
  | {
      ok: false;
      reason:
        | "not_found"
        | "not_owner"
        | "not_usdc"
        | "already_started"
        | "members_without_wallets"
        | "no_relayer"
        | "relayer_out_of_funds"
        | "reverted"
        | "not_confirmed";
    };

export async function startGroupOnChain(
  groupId: string,
  actorId: string,
  meta: { ip?: string | null } = {},
): Promise<StartOnChainResult> {
  const membership = await getMembership(groupId, actorId);
  if (!membership || membership.role === null) return { ok: false, reason: "not_found" };
  if (membership.role !== "OWNER") return { ok: false, reason: "not_owner" };

  const [group] = await db
    .select({
      currency: groups.currency,
      safeAddress: groups.safeAddress,
      contribution: groupSettings.contributionAmount,
      quorumPct: groupSettings.quorumPct,
    })
    .from(groups)
    .innerJoin(groupSettings, eq(groupSettings.groupId, groups.id))
    .where(eq(groups.id, groupId))
    .limit(1);
  if (!group) return { ok: false, reason: "not_found" };
  if (group.safeAddress) return { ok: false, reason: "already_started" };
  if (group.currency !== "USDC") return { ok: false, reason: "not_usdc" };

  const members = await activeMembers(groupId);
  if (members.some((m) => m.walletAddress === null)) {
    return { ok: false, reason: "members_without_wallets" };
  }
  const wallets = members.map((m) => getAddress(m.walletAddress as string));

  const rules = await db
    .select({ action: governanceRules.action, thresholdPermille: governanceRules.thresholdPermille })
    .from(governanceRules)
    .where(eq(governanceRules.groupId, groupId));
  const governance = Object.fromEntries(
    rules.map((r) => [r.action, r.thresholdPermille]),
  ) as Partial<Record<GovernedAction, number>>;

  const setup = buildGroupSetup({
    groupId,
    memberWallets: wallets,
    contribution: Money.fromMinor(group.contribution, toCurrency(group.currency)),
    governance,
    quorumPct: group.quorumPct,
    votingPeriodSeconds: DEFAULT_VOTE_DAYS * 24 * 60 * 60,
  });
  const safeAddress = predictSafeAddress(setup, await proxyCreationCode());

  // A retried start finds the Safe the first attempt made and records it.
  let txHash: Hex | null = null;
  if (!(await hasCode(safeAddress))) {
    const deployed = await deploySafe(setup);
    if (!deployed.ok) return { ok: false, reason: deployed.reason };
    txHash = deployed.txHash;
  }

  if (!(await confirmGroupSafe(safeAddress, wallets))) return { ok: false, reason: "not_confirmed" };

  await db.transaction(async (tx) => {
    await tx
      .update(groups)
      .set({ safeAddress: safeAddress.toLowerCase(), startedOnChainAt: new Date() })
      .where(and(eq(groups.id, groupId), isNull(groups.safeAddress)));

    await recordAudit(tx, {
      action: "group.started_on_chain",
      actorId,
      actorIp: meta.ip,
      groupId,
      subjectType: "group",
      subjectId: groupId,
      after: { safeAddress, txHash, members: wallets },
    });
  });

  return { ok: true, safeAddress, txHash };
}

async function activeMembers(groupId: string) {
  return db
    .select({
      userId: users.id,
      displayName: users.displayName,
      walletAddress: users.walletAddress,
    })
    .from(groupMembers)
    .innerJoin(users, eq(users.id, groupMembers.userId))
    .where(and(eq(groupMembers.groupId, groupId), eq(groupMembers.status, "ACTIVE")))
    .orderBy(asc(groupMembers.joinedAt));
}
