import "server-only";
import { encodeFunctionData, getAddress, type Address, type Hex } from "viem";
import { CONTRACTS } from "@/lib/chain/addresses";
import { erc20Abi, jfkDuesAbi, jfkModuleAbi, safeAbi } from "@/lib/chain/abis";
import { publicClient } from "@/lib/chain/client";
import { moduleFor } from "@/lib/chain/module";
import { Money } from "@/lib/money";
import { getGroupDetail, listMembers } from "./service";

/**
 * Dues for a group on Base, read from Base: what's in the vault, what each
 * member has paid in, and whether they've paid for this period.
 *
 * Paying is the member's own two steps, sent together where the wallet
 * allows: let Rallied's contract take exactly this period's contribution
 * from their USDC, then contribute. The contract takes the group's amount
 * and nothing more, so the approval is for exactly that.
 */

export interface DuesMember {
  name: string;
  isYou: boolean;
  /** Everything they've paid in, e.g. "$4.00". */
  paidIn: string;
  /** "Paid 17 Nov" within this period, else null. */
  paidThisPeriod: string | null;
}

export type Dues =
  | {
      ok: true;
      contribution: string;
      vault: string;
      /** The vault in dollars, for comparisons on screen (a "large" spend). */
      vaultDollars: number;
      members: DuesMember[];
      /** The viewer: whether they can pay now, and if not, why. */
      you: { paidThisPeriod: string | null; canPay: boolean; short: string | null };
    }
  | { ok: false; reason: "not_found" | "not_on_base" | "old_contract" | "unreachable" };

const DAY = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "Africa/Lagos" });
const usdc = (minor: bigint) => Money.fromMinor(minor, "USDC").format();

export async function readDues(groupId: string, userId: string): Promise<Dues> {
  const [group, members] = await Promise.all([getGroupDetail(groupId, userId), listMembers(groupId, userId)]);
  if (!group || !members) return { ok: false, reason: "not_found" };
  if (!group.safeAddress) return { ok: false, reason: "not_on_base" };
  const safe = getAddress(group.safeAddress);
  const client = publicClient();

  try {
    const contract = await moduleFor(safe);
    if (!contract) return { ok: false, reason: "old_contract" };

    const withWallets = members.filter((m) => m.walletAddress);
    const wallets = withWallets.map((m) => getAddress(m.walletAddress as string));
    const me = members.find((m) => m.userId === userId)?.walletAddress;
    const dues = { address: contract.address, abi: jfkDuesAbi } as const;

    const [chainGroup, settings, vault, myBalance, paid, last] = await Promise.all([
      client.readContract({ address: contract.address, abi: jfkModuleAbi, functionName: "getGroup", args: [safe] }),
      client.readContract({ address: contract.address, abi: jfkModuleAbi, functionName: "getGroupSettings", args: [safe] }),
      client.readContract({ address: CONTRACTS.usdc, abi: erc20Abi, functionName: "balanceOf", args: [safe] }),
      me ? client.readContract({ address: CONTRACTS.usdc, abi: erc20Abi, functionName: "balanceOf", args: [getAddress(me)] }) : Promise.resolve(0n),
      client.multicall({ allowFailure: false, contracts: wallets.map((w) => ({ ...dues, functionName: "paidIn", args: [safe, w] }) as const) }),
      client.multicall({ allowFailure: false, contracts: wallets.map((w) => ({ ...dues, functionName: "lastPaidAt", args: [safe, w] }) as const) }),
    ]);
    const contribution = chainGroup[1];
    const payGap = BigInt(settings[1]);
    const now = BigInt(Math.floor(Date.now() / 1000));

    const rows = withWallets.map((m, i): DuesMember => {
      const at = last[i];
      return {
        name: m.userId === userId ? "You" : m.displayName,
        isYou: m.userId === userId,
        paidIn: usdc(paid[i]),
        paidThisPeriod: at !== 0n && now < at + payGap ? `Paid ${DAY.format(new Date(Number(at) * 1000))}` : null,
      };
    });
    const mine = rows.find((r) => r.isYou);
    const short = myBalance < contribution ? usdc(contribution - myBalance) : null;

    return {
      ok: true,
      contribution: usdc(contribution),
      vault: usdc(vault),
      vaultDollars: Number(vault) / 1_000_000,
      members: rows,
      you: { paidThisPeriod: mine?.paidThisPeriod ?? null, canPay: Boolean(me) && !short, short },
    };
  } catch (cause) {
    console.error("[dues] couldn't read Base", cause);
    return { ok: false, reason: "unreachable" };
  }
}

export type PreparedDues =
  | { ok: true; calls: { to: Address; data: Hex }[]; wallet: Address; amount: string }
  | { ok: false; reason: string };

export async function prepareDues(userId: string, groupId: string): Promise<PreparedDues> {
  const [group, members] = await Promise.all([getGroupDetail(groupId, userId), listMembers(groupId, userId)]);
  if (!group || !members) return { ok: false, reason: "You're no longer in this group." };
  if (!group.safeAddress) return { ok: false, reason: "This group isn't on Base yet. Start it on Base first." };
  const wallet = members.find((m) => m.userId === userId)?.walletAddress;
  if (!wallet) return { ok: false, reason: "Your account has no wallet. Sign in with your wallet to pay." };

  const safe = getAddress(group.safeAddress);
  const payer = getAddress(wallet);
  const client = publicClient();
  const contract = await moduleFor(safe).catch(() => null);
  if (!contract) return { ok: false, reason: "This group runs on an older Rallied contract that this screen can't pay into." };
  const [isOwner, chainGroup, balance, allowance] = await Promise.all([
    client.readContract({ address: safe, abi: safeAbi, functionName: "isOwner", args: [payer] }),
    client.readContract({ address: contract.address, abi: jfkModuleAbi, functionName: "getGroup", args: [safe] }),
    client.readContract({ address: CONTRACTS.usdc, abi: erc20Abi, functionName: "balanceOf", args: [payer] }),
    client.readContract({ address: CONTRACTS.usdc, abi: erc20Abi, functionName: "allowance", args: [payer, contract.address] }),
  ]);
  if (!isOwner) return { ok: false, reason: "The wallet you're signed in with isn't one of this group's owners on Base." };
  const [, contribution, , , closed] = chainGroup;
  if (closed) return { ok: false, reason: "This group has closed." };
  if (balance < contribution) {
    return {
      ok: false,
      reason: `Your wallet has ${usdc(balance)} and this needs ${usdc(contribution)}. On the test network, get free test USDC at faucet.circle.com (Base Sepolia), then pay.`,
    };
  }

  const calls: { to: Address; data: Hex }[] = [];
  // Approve exactly this period's amount, only when the existing approval doesn't cover it.
  if (allowance < contribution) {
    calls.push({
      to: CONTRACTS.usdc,
      data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [contract.address, contribution] }),
    });
  }
  calls.push({ to: contract.address, data: encodeFunctionData({ abi: jfkDuesAbi, functionName: "contribute", args: [safe] }) });

  return { ok: true, calls, wallet: payer, amount: usdc(contribution) };
}
