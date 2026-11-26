import "server-only";
import { concat, encodeFunctionData, erc20Abi as standardErc20Abi, getAddress, numberToHex, pad, size, zeroAddress, type Address, type Hex } from "viem";
import { CONTRACTS, shortAddress } from "@/lib/chain/addresses";
import { erc20Abi, jfkDuesAbi, jfkModuleAbi, jfkRotationAbi, multiSendAbi, safeAbi } from "@/lib/chain/abis";
import { publicClient } from "@/lib/chain/client";
import { moduleFor } from "@/lib/chain/module";
import { relayer } from "@/lib/chain/relayer";
import { Money } from "@/lib/money";
import { recordAudit } from "@/modules/audit/service";
import { db } from "@/lib/db";
import { getGroupDetail, listMembers } from "./service";

/**
 * The emergency exit: every member together pays the vault out to
 * themselves, straight through their Safe, without Rallied's contract and
 * without Rallied's database. It exists so Rallied can never trap anyone's
 * money: if Rallied or its contract ever stop working, the group still can.
 *
 * Members' wallets are smart wallets, which Safe v1.4.1 can't take an
 * off-chain signature from, so each member approves the exact transaction
 * on Base (`approveHash`) from their own wallet. Once every owner has, anyone
 * carries it out. Nothing here is stored: the split, the transaction and who
 * has approved are all worked out from Base each time, so every member sees
 * the same thing, and it still works if Rallied's database is gone.
 *
 * The split follows the group's own closing rule: a shared pot by what each
 * paid in; a rotating group refunds this round to whoever paid into it, then
 * shares the rest equally. If Rallied's contract can't be read (the reason
 * to use the exit at all, perhaps), it's split equally.
 */

export interface ExitShare {
  name: string;
  isYou: boolean;
  amount: string;
}

export interface ExitApproval {
  name: string;
  isYou: boolean;
  approved: boolean;
}

export type ExitState =
  | {
      ok: true;
      vault: Address;
      total: string;
      /** How the split was worked out, in a few words. */
      rule: string;
      shares: ExitShare[];
      approvals: ExitApproval[];
      /** The Safe transaction everyone approves. Changes if money moves in or out. */
      txHash: Hex;
      youApproved: boolean;
      ready: boolean;
    }
  | { ok: false; reason: "not_found" | "not_on_base" | "empty" | "unreachable" };

interface Plan {
  safe: Address;
  owners: Address[];
  amounts: bigint[];
  rule: string;
  to: Address;
  data: Hex;
  txHash: Hex;
}

const OPERATION_DELEGATECALL = 1;

export async function readExit(groupId: string, userId: string): Promise<ExitState> {
  const [group, members] = await Promise.all([getGroupDetail(groupId, userId), listMembers(groupId, userId)]);
  if (!group || !members) return { ok: false, reason: "not_found" };
  if (!group.safeAddress) return { ok: false, reason: "not_on_base" };

  try {
    const plan = await planExit(getAddress(group.safeAddress));
    if (!plan) return { ok: false, reason: "empty" };
    const client = publicClient();
    const approved = await Promise.all(
      plan.owners.map((owner) =>
        client.readContract({ address: plan.safe, abi: safeAbi, functionName: "approvedHashes", args: [owner, plan.txHash] }),
      ),
    );

    const me = members.find((m) => m.userId === userId)?.walletAddress?.toLowerCase();
    const byWallet = new Map(members.filter((m) => m.walletAddress).map((m) => [(m.walletAddress as string).toLowerCase(), m.displayName]));
    const nameOf = (owner: Address) => (owner.toLowerCase() === me ? "You" : (byWallet.get(owner.toLowerCase()) ?? shortAddress(owner)));
    const total = plan.amounts.reduce((sum, amount) => sum + amount, 0n);

    return {
      ok: true,
      vault: plan.safe,
      total: usdc(total),
      rule: plan.rule,
      shares: plan.owners.map((owner, i) => ({ name: nameOf(owner), isYou: owner.toLowerCase() === me, amount: usdc(plan.amounts[i]) })),
      approvals: plan.owners.map((owner, i) => ({ name: nameOf(owner), isYou: owner.toLowerCase() === me, approved: approved[i] !== 0n })),
      txHash: plan.txHash,
      youApproved: plan.owners.some((owner, i) => owner.toLowerCase() === me && approved[i] !== 0n),
      ready: approved.every((value) => value !== 0n),
    };
  } catch (cause) {
    console.error("[exit] couldn't read Base", cause);
    return { ok: false, reason: "unreachable" };
  }
}

/** The member's one approval: their wallet calls approveHash on the group's Safe for this exact transaction. */
export async function prepareExitApproval(
  userId: string,
  groupId: string,
): Promise<{ ok: true; call: { to: Address; data: Hex }; wallet: Address } | { ok: false; reason: string }> {
  const state = await readExit(groupId, userId);
  if (!state.ok) return { ok: false, reason: REASONS[state.reason] };
  const members = await listMembers(groupId, userId);
  const wallet = members?.find((m) => m.userId === userId)?.walletAddress;
  if (!wallet || !state.approvals.some((a) => a.isYou)) return { ok: false, reason: "Your wallet isn't one of this group's owners on Base." };
  if (state.youApproved) return { ok: false, reason: "You've already approved this exit." };
  return {
    ok: true,
    wallet: getAddress(wallet),
    call: { to: state.vault, data: encodeFunctionData({ abi: safeAbi, functionName: "approveHash", args: [state.txHash] }) },
  };
}

/**
 * Once every owner has approved, carry it out. Anyone may; Rallied's fee
 * wallet does it here so nobody pays a fee. The Safe itself checks every
 * approval again, so this can never pay out anything they didn't approve.
 */
export async function carryOutExit(userId: string, groupId: string): Promise<{ ok: true; txHash: Hex } | { ok: false; reason: string }> {
  const group = await getGroupDetail(groupId, userId);
  if (!group?.safeAddress) return { ok: false, reason: REASONS.not_found };
  const wallet = relayer();
  if (!wallet) return { ok: false, reason: "Rallied can't send it right now. Any member can, from BaseScan (see the guide)." };
  try {
    const plan = await planExit(getAddress(group.safeAddress));
    if (!plan) return { ok: false, reason: REASONS.empty };
    const client = publicClient();
    const approved = await Promise.all(
      plan.owners.map((owner) => client.readContract({ address: plan.safe, abi: safeAbi, functionName: "approvedHashes", args: [owner, plan.txHash] })),
    );
    if (approved.some((value) => value === 0n)) return { ok: false, reason: "Not everyone has approved this exit yet." };

    const txHash = await wallet.writeContract({
      address: plan.safe,
      abi: safeAbi,
      functionName: "execTransaction",
      args: [plan.to, 0n, plan.data, OPERATION_DELEGATECALL, 0n, 0n, 0n, zeroAddress, zeroAddress, approvalSignatures(plan.owners)],
    });
    const receipt = await client.waitForTransactionReceipt({ hash: txHash, timeout: 60_000 });
    if (receipt.status !== "success") return { ok: false, reason: "Base didn't accept it. Nothing moved; try again." };
    await recordAudit(db, {
      action: "group.emergency_exit",
      actorId: userId,
      groupId,
      subjectType: "group",
      subjectId: groupId,
      after: { txHash, total: plan.amounts.reduce((sum, amount) => sum + amount, 0n).toString() },
    });
    return { ok: true, txHash };
  } catch (cause) {
    console.error("[exit] carrying out failed", cause);
    return { ok: false, reason: "Couldn't send it just now. Nothing moved; try again." };
  }
}

const REASONS = {
  not_found: "You're not in that group.",
  not_on_base: "This group isn't on Base, so there's no vault to empty.",
  empty: "The vault is empty: there's nothing to pay out.",
  unreachable: "Couldn't reach Base just now. Try again in a moment.",
} as const;

// ---------------------------------------------------------------------------
// The plan: worked out from Base alone, the same for every member
// ---------------------------------------------------------------------------

/** Null when the vault holds nothing. */
export async function planExit(safe: Address): Promise<Plan | null> {
  const client = publicClient();
  const [owners, balance, nonce] = await Promise.all([
    client.readContract({ address: safe, abi: safeAbi, functionName: "getOwners" }),
    client.readContract({ address: CONTRACTS.usdc, abi: erc20Abi, functionName: "balanceOf", args: [safe] }),
    client.readContract({ address: safe, abi: safeAbi, functionName: "nonce" }),
  ]);
  if (balance === 0n) return null;

  const { amounts, rule } = await splitFor(safe, [...owners], balance);
  const batch = concat(
    owners.flatMap((owner, i) => {
      if (amounts[i] === 0n) return [];
      const transfer = encodeFunctionData({ abi: standardErc20Abi, functionName: "transfer", args: [owner, amounts[i]] });
      // MultiSend packs each call as: operation (1 byte), to (20), value (32), data length (32), data.
      return [numberToHex(0, { size: 1 }), CONTRACTS.usdc, pad(numberToHex(0n), { size: 32 }), pad(numberToHex(size(transfer)), { size: 32 }), transfer];
    }),
  );
  const data = encodeFunctionData({ abi: multiSendAbi, functionName: "multiSend", args: [batch] });
  const to = CONTRACTS.multiSendCallOnly;
  const txHash = await client.readContract({
    address: safe,
    abi: safeAbi,
    functionName: "getTransactionHash",
    args: [to, 0n, data, OPERATION_DELEGATECALL, 0n, 0n, 0n, zeroAddress, zeroAddress, nonce],
  });
  return { safe, owners: [...owners], amounts, rule, to, data, txHash };
}

/**
 * The group's closing rule, read from Rallied's contract; equal shares if it
 * can't be read. Whatever rounding leaves over goes to the last owner, so
 * the vault ends empty.
 */
async function splitFor(safe: Address, owners: Address[], balance: bigint): Promise<{ amounts: bigint[]; rule: string }> {
  const client = publicClient();
  const equal = (pot: bigint, base: bigint[] = owners.map(() => 0n)) => {
    const each = pot / BigInt(owners.length);
    return base.map((amount, i) => amount + (i === owners.length - 1 ? pot - each * BigInt(owners.length - 1) : each));
  };

  try {
    const contract = await moduleFor(safe);
    if (!contract) throw new Error("no Rallied contract on this vault");

    if (contract.version >= 3) {
      const rotation = await client.readContract({ address: contract.address, abi: jfkRotationAbi, functionName: "getRotation", args: [safe] });
      if (rotation[0]) {
        const group = await client.readContract({ address: contract.address, abi: jfkModuleAbi, functionName: "getGroup", args: [safe] });
        const statuses = await Promise.all(
          owners.map((owner) => client.readContract({ address: contract.address, abi: jfkRotationAbi, functionName: "rotationStatus", args: [safe, owner] })),
        );
        // This round back to whoever paid into it, then the rest equally.
        let left = balance;
        const refunds = statuses.map(([, paidThisRound]) => {
          const refund = paidThisRound && left >= group[1] ? group[1] : 0n;
          left -= refund;
          return refund;
        });
        return { amounts: equal(left, refunds), rule: "This round back to whoever paid into it, then the rest equally." };
      }
    }

    const paid = await Promise.all(
      owners.map((owner) => client.readContract({ address: contract.address, abi: jfkDuesAbi, functionName: "paidIn", args: [safe, owner] })),
    );
    const totalPaid = paid.reduce((sum, amount) => sum + amount, 0n);
    if (totalPaid === 0n) return { amounts: equal(balance), rule: "Equally: nobody has paid in through Rallied yet." };
    let given = 0n;
    const amounts = paid.map((amount, i) => {
      const share = i === owners.length - 1 ? balance - given : (balance * amount) / totalPaid;
      given += share;
      return share;
    });
    return { amounts, rule: "By what each of you has paid in, as when the group closes." };
  } catch {
    return { amounts: equal(balance), rule: "Equally: Rallied's contract couldn't be read." };
  }
}

/** Safe's "approved on-chain" signature for each owner, lowest address first: r = owner, s = 0, v = 1. */
function approvalSignatures(owners: Address[]): Hex {
  const sorted = [...owners].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1));
  return concat(sorted.flatMap((owner) => [pad(owner, { size: 32 }), pad("0x00", { size: 32 }), "0x01"]));
}

const usdc = (minor: bigint) => Money.fromMinor(minor, "USDC").format();
