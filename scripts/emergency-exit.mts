/**
 * The emergency exit, without Rallied's website or database: prints exactly
 * what every member approves, and what to send once all of them have.
 * Reads Base only, using the same plan the app uses (modules/groups/onchain-exit.ts),
 * so it gives the same transaction.
 *
 *   pnpm exit:plan 0xYourGroupVault
 *
 * See EMERGENCY-EXIT.md for the steps on BaseScan.
 */
import { getAddress, isAddress, zeroAddress } from "viem";

// It needs nothing of Rallied's: no database, no secrets. These only satisfy
// the app's settings check; nothing here reads them. BASE_RPC_URL is optional.
process.env.DATABASE_URL ??= "memory://";
process.env.APP_URL ??= "http://localhost:3000";
process.env.SESSION_SECRET ??= "emergency-exit-needs-no-session-secret";
const { safeAbi } = await import("@/lib/chain/abis");
const { publicClient } = await import("@/lib/chain/client");
const { planExit } = await import("@/modules/groups/onchain-exit");

const vault = process.argv[2];
if (!vault || !isAddress(vault)) {
  console.error("Usage: pnpm exit:plan 0xYourGroupVault");
  process.exitCode = 1;
} else {
  await show(getAddress(vault));
}

async function show(address: `0x${string}`): Promise<void> {

const plan = await planExit(address);
if (!plan) {
  console.log("The vault is empty: there's nothing to pay out.");
  return;
}

const approved = await Promise.all(
  plan.owners.map((owner) => publicClient().readContract({ address: plan.safe, abi: safeAbi, functionName: "approvedHashes", args: [owner, plan.txHash] })),
);
const sorted = [...plan.owners].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1));
const signatures = `0x${sorted.map((owner) => owner.slice(2).toLowerCase().padStart(64, "0") + "0".repeat(64) + "01").join("")}`;

console.log(`\nVault: ${plan.safe}`);
console.log(`Split: ${plan.rule}`);
plan.owners.forEach((owner, i) => {
  console.log(`  ${owner}  ${(Number(plan.amounts[i]) / 1e6).toFixed(2)} USDC  ${approved[i] !== 0n ? "approved" : "not yet"}`);
});

console.log("\n1. Every member approves (BaseScan → the vault → Contract → Write as Proxy → approveHash):");
console.log(`   hashToApprove: ${plan.txHash}`);

console.log("\n2. Once all have, anyone sends execTransaction on the vault with:");
console.log(`   to:             ${plan.to}`);
console.log("   value:          0");
console.log(`   data:           ${plan.data}`);
console.log("   operation:      1");
console.log("   safeTxGas:      0");
console.log("   baseGas:        0");
console.log("   gasPrice:       0");
console.log(`   gasToken:       ${zeroAddress}`);
console.log(`   refundReceiver: ${zeroAddress}`);
console.log(`   signatures:     ${signatures}`);
console.log(`\n${approved.every((value) => value !== 0n) ? "Everyone has approved: step 2 will work now." : "Not everyone has approved yet: step 2 will fail until they do."}\n`);
}
