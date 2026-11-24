import "server-only";
import { and, eq } from "drizzle-orm";
import { decodeAbiParameters, type Hex } from "viem";
import type { Transaction } from "@/lib/db";
import { governanceRules, groupMembers, groupSettings, groups, users, type GovernedAction } from "@/lib/db/schema";

/**
 * After a vote is carried out on Base, Rallied's own records follow what Base
 * now says, so every screen (and Claude) agrees with the chain:
 *
 *  - What everyone pays, the rules and how long votes stay open.
 *  - Who's in the group: added, removed, or moved to a new wallet. Only for
 *    wallets that belong to a Rallied account; anyone else is simply an owner
 *    on Base until they sign in to Rallied.
 *  - A closed group is closed.
 *
 * Runs inside the caller's transaction, after Base confirmed the execution.
 */

/** JfkModule.Action names, as onchain-votes decodes them. */
export type CarriedOutAction =
  | "SPEND"
  | "ADD_MEMBER"
  | "REMOVE_MEMBER"
  | "REPLACE_MEMBER"
  | "CHANGE_CONTRIBUTION"
  | "CHANGE_RULES"
  | "CLOSE_GROUP"
  | "CHANGE_ORDER"
  | "MIGRATE_MODULE";

/**
 * The contract's rule slots that have a Rallied rule behind them (see
 * contractThresholds in onchain-setup.ts). Adding a member, replacing a lost
 * wallet and moving contracts live only on Base.
 */
const SLOT_TO_ACTION: Partial<Record<number, GovernedAction>> = {
  0: "FUND_RELEASE_SMALL",
  1: "FUND_RELEASE_LARGE",
  3: "REMOVE_MEMBER",
  5: "CHANGE_CONTRIBUTION",
  6: "CHANGE_GOVERNANCE",
  7: "DISSOLVE_GROUP",
};

const address = [{ type: "address" }] as const;

export async function applyOnRallied(tx: Transaction, groupId: string, action: CarriedOutAction, payload: Hex): Promise<void> {
  switch (action) {
    case "CHANGE_CONTRIBUTION": {
      const [amount] = decodeAbiParameters([{ type: "uint256" }], payload);
      await tx.update(groupSettings).set({ contributionAmount: amount }).where(eq(groupSettings.groupId, groupId));
      return;
    }
    case "CHANGE_RULES": {
      const [thresholds, quorum, votingPeriod] = decodeAbiParameters(
        [{ type: "uint16[9]" }, { type: "uint8" }, { type: "uint32" }, { type: "bool" }],
        payload,
      );
      await tx
        .update(groupSettings)
        .set({ quorumPct: quorum, defaultVoteDays: Math.max(1, Math.round(votingPeriod / 86_400)) })
        .where(eq(groupSettings.groupId, groupId));
      for (const [slot, governed] of Object.entries(SLOT_TO_ACTION)) {
        const permille = thresholds[Number(slot)];
        await tx
          .insert(governanceRules)
          .values({ groupId, action: governed as GovernedAction, thresholdPermille: permille })
          .onConflictDoUpdate({ target: [governanceRules.groupId, governanceRules.action], set: { thresholdPermille: permille } });
      }
      return;
    }
    case "REMOVE_MEMBER": {
      const [wallet] = decodeAbiParameters(address, payload);
      const user = await userWith(tx, wallet);
      if (!user) return;
      await tx
        .update(groupMembers)
        .set({ status: "REMOVED", exitedAt: new Date(), rotationPosition: null })
        .where(and(eq(groupMembers.groupId, groupId), eq(groupMembers.userId, user)));
      return;
    }
    case "ADD_MEMBER": {
      const [wallet] = decodeAbiParameters(address, payload);
      const user = await userWith(tx, wallet);
      if (!user) return;
      await tx
        .insert(groupMembers)
        .values({ groupId, userId: user, role: "MEMBER", status: "ACTIVE" })
        .onConflictDoUpdate({
          target: [groupMembers.groupId, groupMembers.userId],
          set: { status: "ACTIVE", role: "MEMBER", exitedAt: null },
        });
      return;
    }
    case "REPLACE_MEMBER": {
      const [oldWallet, newWallet] = decodeAbiParameters([...address, ...address], payload);
      const [oldUser, newUser] = await Promise.all([userWith(tx, oldWallet), userWith(tx, newWallet)]);
      if (!oldUser || !newUser || oldUser === newUser) return;
      // The member keeps their place (role, turn, history); only the account behind it changes.
      await tx
        .update(groupMembers)
        .set({ userId: newUser })
        .where(and(eq(groupMembers.groupId, groupId), eq(groupMembers.userId, oldUser)));
      return;
    }
    case "CLOSE_GROUP":
      await tx.update(groups).set({ status: "DISSOLVED" }).where(eq(groups.id, groupId));
      return;
    case "CHANGE_ORDER": {
      const [order] = decodeAbiParameters([{ type: "address[]" }], payload);
      const placed: { memberId: string; position: number }[] = [];
      for (const wallet of order) {
        const userId = await userWith(tx, wallet);
        if (!userId) return;
        const [row] = await tx
          .select({ id: groupMembers.id, position: groupMembers.rotationPosition })
          .from(groupMembers)
          .where(and(eq(groupMembers.groupId, groupId), eq(groupMembers.userId, userId)))
          .limit(1);
        if (!row || row.position === null) return;
        placed.push({ memberId: row.id, position: row.position });
      }
      // The seats these members held, handed out again in the voted order.
      const seats = placed.map((p) => p.position).sort((a, b) => a - b);
      for (let i = 0; i < placed.length; i++) {
        await tx.update(groupMembers).set({ rotationPosition: seats[i] }).where(eq(groupMembers.id, placed[i].memberId));
      }
      return;
    }
    case "SPEND":
    case "MIGRATE_MODULE":
      // Money out shows in #transactions from Base itself; a move takes a new contract version.
      return;
  }
}

async function userWith(tx: Transaction, wallet: string): Promise<string | null> {
  const [row] = await tx.select({ id: users.id }).from(users).where(eq(users.walletAddress, wallet.toLowerCase())).limit(1);
  return row?.id ?? null;
}
