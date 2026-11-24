import "server-only";
import { and, asc, count, eq, gt, isNull } from "drizzle-orm";
import { getAddress, type Address, type Hex } from "viem";
import { db } from "@/lib/db";
import {
  DEFAULT_VOTE_DAYS,
  auditLogs,
  governanceRules,
  groupMembers,
  groupSettings,
  groups,
  users,
  type GovernedAction,
} from "@/lib/db/schema";
import { Money, toCurrency } from "@/lib/money";
import { recordAudit } from "@/modules/audit/service";
import { announce } from "@/modules/chat/events";
import { getMembership } from "./service";
import { buildGroupSetup, predictSafeAddress } from "./onchain-setup";
import { cyclePeriodFor } from "@/modules/contributions/schedule";
import { confirmGroupSafe, deploySafe, hasCode, proxyCreationCode } from "@/modules/groups/onchain-chain";

/**
 * Starting a group on-chain: the moment its money stops being an idea and
 * gets a Safe of its own.
 *
 * Members gather first; the owner starts the group once everyone is in. The
 * Safe is created with every member as an owner, so nobody has to be voted in
 * just to fill the group. Anyone who joins after this needs a vote, because
 * that is the contract's rule.
 */

/** Groups one person may start on Base in a day. */
const STARTS_PER_DAY = 3;
const DAY_MS = 86_400_000;

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
        | "too_many_starts"
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

  // Each start spends Rallied's own ETH, and anyone can sign up: a few a day is plenty for a person.
  const [{ starts }] = await db
    .select({ starts: count() })
    .from(auditLogs)
    .where(and(eq(auditLogs.actorId, actorId), eq(auditLogs.action, "group.started_on_chain"), gt(auditLogs.createdAt, new Date(Date.now() - DAY_MS))));
  if (starts >= STARTS_PER_DAY) return { ok: false, reason: "too_many_starts" };

  const [group] = await db
    .select({
      currency: groups.currency,
      safeAddress: groups.safeAddress,
      contribution: groupSettings.contributionAmount,
      quorumPct: groupSettings.quorumPct,
      cadence: groupSettings.cadence,
      intervalWeeks: groupSettings.intervalWeeks,
      dueDay: groupSettings.dueDay,
      type: groups.type,
    })
    .from(groups)
    .innerJoin(groupSettings, eq(groupSettings.groupId, groups.id))
    .where(eq(groups.id, groupId))
    .limit(1);
  if (!group) return { ok: false, reason: "not_found" };
  if (group.safeAddress) return { ok: false, reason: "already_started" };
  const rotating = group.type === "ROTATING";
  if (group.currency !== "USDC") return { ok: false, reason: "not_usdc" };

  const members = await activeMembers(groupId);
  if (members.some((m) => m.walletAddress === null)) {
    return { ok: false, reason: "members_without_wallets" };
  }
  // A rotating group goes on Base in its turn order: the vault's owner order is the first cycle's.
  if (rotating) {
    members.sort((a, b) => (a.rotationPosition ?? Infinity) - (b.rotationPosition ?? Infinity));
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
    cadence: group.cadence,
    intervalWeeks: group.intervalWeeks,
    // The first turn is paid out on the group's first due date.
    rotation: rotating
      ? {
          firstPayoutAt: Math.floor(
            cyclePeriodFor(new Date(), {
              cadence: group.cadence,
              dueDay: group.dueDay,
              graceDays: 0,
              intervalWeeks: group.intervalWeeks,
            }).periodEnd.getTime() / 1000,
          ),
        }
      : undefined,
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
    await announce(groupId, { type: "group_started", safeAddress }, tx);
  });

  return { ok: true, safeAddress, txHash };
}

async function activeMembers(groupId: string) {
  return db
    .select({
      userId: users.id,
      displayName: users.displayName,
      walletAddress: users.walletAddress,
      rotationPosition: groupMembers.rotationPosition,
    })
    .from(groupMembers)
    .innerJoin(users, eq(users.id, groupMembers.userId))
    .where(and(eq(groupMembers.groupId, groupId), eq(groupMembers.status, "ACTIVE")))
    .orderBy(asc(groupMembers.joinedAt));
}
