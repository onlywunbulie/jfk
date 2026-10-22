/**
 * Put simulated contributions through the full payment pipeline from the
 * command line — no Paystack account, no browser.
 *
 *   pnpm simulate                          one contribution from everyone, every group
 *   pnpm simulate --group "JFK Empire"     just that group
 *   pnpm simulate --email chuka@jfk.test   just that member
 *   pnpm simulate --fail                   simulate declines instead
 *   pnpm simulate --cycles 3               repeat three times
 *
 * Stop `pnpm dev` first: PGlite allows one process at a time.
 */
import { config } from "dotenv";
import { eq } from "drizzle-orm";

config({ path: ".env.local" });
config({ path: ".env" });

const { db } = await import("../src/lib/db/index.js");
const { users, groups, groupMembers } = await import(
  "../src/lib/db/schema/index.js"
);
const { simulateContribution, simulationAvailable } = await import(
  "../src/modules/payments/simulate.js"
);
const { getGroupBalances } = await import("../src/modules/ledger/service.js");
const { reconcileLedger, describeReport } = await import(
  "../src/modules/ledger/reconcile.js"
);

if (!simulationAvailable()) {
  console.error(
    "Simulation is disabled here — either NODE_ENV is production or a live " +
      "Paystack key is configured.",
  );
  process.exit(1);
}

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}
const has = (name: string) => process.argv.includes(`--${name}`);

const groupFilter = flag("group");
const emailFilter = flag("email");
const cycles = Number(flag("cycles") ?? 1);
const shouldFail = has("fail");

const allGroups = await db
  .select({ id: groups.id, name: groups.name })
  .from(groups);

const targets = groupFilter
  ? allGroups.filter((g) => g.name.toLowerCase() === groupFilter.toLowerCase())
  : allGroups;

if (targets.length === 0) {
  console.error(
    `No group matched "${groupFilter}". Available: ${allGroups.map((g) => g.name).join(", ")}`,
  );
  process.exit(1);
}

for (const group of targets) {
  const members = await db
    .select({ id: users.id, name: users.displayName, email: users.email })
    .from(groupMembers)
    .innerJoin(users, eq(users.id, groupMembers.userId))
    .where(eq(groupMembers.groupId, group.id));

  const chosen = emailFilter
    ? members.filter((m) => m.email?.toLowerCase() === emailFilter.toLowerCase())
    : members;

  if (chosen.length === 0) continue;

  const before = await getGroupBalances(group.id);
  console.log(`\n${group.name} — ${before.total.format()} before`);

  for (let cycle = 1; cycle <= cycles; cycle++) {
    for (const member of chosen) {
      const result = await simulateContribution({
        groupId: group.id,
        userId: member.id,
        fail: shouldFail,
      });

      const verb = shouldFail ? "declined" : "paid";
      console.log(
        `  ${member.name.padEnd(14)} ${verb} ${result.charged.format().padStart(12)}` +
          `  → group +${shouldFail ? "₦0.00" : result.net.format()}`,
      );
    }
  }

  const after = await getGroupBalances(group.id);
  console.log(
    `  ${"".padEnd(14)} ${after.total.format()} total ` +
      `(${after.available.format()} available, ${after.reserved.format()} reserved)`,
  );
}

const report = await reconcileLedger();
console.log(`\n${describeReport(report)}\n`);
process.exit(report.clean ? 0 : 1);
