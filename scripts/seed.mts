/**
 * Seed the local database with a realistic group so the UI can be clicked
 * through without signing several people up by hand.
 *
 * Run with `pnpm db:seed`. It prints a session cookie for each user so you can
 * open the app as any of them.
 *
 * Must run under the `react-server` export condition, otherwise the
 * `server-only` package throws on import — see the db:seed script.
 */
import { config } from "dotenv";
import { eq } from "drizzle-orm";

config({ path: ".env.local" });
config({ path: ".env" });

if (process.env.NODE_ENV === "production") {
  console.error("Refusing to seed a production database.");
  process.exit(1);
}

const { db } = await import("../src/lib/db/index.js");
const { users, sessions } = await import("../src/lib/db/schema/index.js");
const { createGroup, createInvite, acceptInvite, grantAdmin } = await import(
  "../src/modules/groups/service.js"
);
const { Money } = await import("../src/lib/money.js");
const { hashToken } = await import("../src/lib/auth/crypto.js");
const { randomToken } = await import("../src/lib/ids.js");

const PEOPLE = [
  { email: "geoffrey@jfk.test", displayName: "Geoffrey Ude" },
  { email: "chuka@jfk.test", displayName: "Chuka Obi" },
  { email: "tunde@jfk.test", displayName: "Tunde Bello" },
  { email: "amaka@jfk.test", displayName: "Amaka Eze" },
];

const created: { name: string; email: string; token: string }[] = [];

for (const person of PEOPLE) {
  const [user] = await db
    .insert(users)
    .values({ ...person, emailVerifiedAt: new Date() })
    .onConflictDoUpdate({
      target: users.email,
      set: { displayName: person.displayName },
    })
    .returning({ id: users.id });

  const token = randomToken(48);
  await db.insert(sessions).values({
    userId: user.id,
    tokenHash: hashToken(token),
    expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    userAgent: "seed",
  });

  created.push({ name: person.displayName, email: person.email, token });
}

const [geoffrey, chuka, tunde, amaka] = await Promise.all(
  PEOPLE.map(async (p) => {
    const [row] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, p.email))
      .limit(1);
    return row.id;
  }),
);

// The example from the blueprint: a treasury group of friends.
const empire = await createGroup(geoffrey, {
  name: "JFK Empire",
  description: "Building the empire, one month at a time.",
  type: "TREASURY",
  contributionAmount: Money.fromMajor(50_000),
  cadence: "MONTHLY",
  dueDay: 1,
});

for (const member of [chuka, tunde, amaka]) {
  const invite = await createInvite(empire.groupId, geoffrey, { maxUses: 1 });
  if (invite.ok) await acceptInvite(invite.code, member);
}

// Two more admins, matching the "3 admins" rule in the worked example.
await grantAdmin(empire.groupId, geoffrey, chuka);
await grantAdmin(empire.groupId, geoffrey, tunde);

// A rotating group, so both engines have data behind them.
const ajo = await createGroup(chuka, {
  name: "Family Ajo",
  type: "ROTATING",
  contributionAmount: Money.fromMajor(20_000),
  cadence: "WEEKLY",
  dueDay: 5,
});

for (const member of [geoffrey, amaka]) {
  const invite = await createInvite(ajo.groupId, chuka, { maxUses: 1 });
  if (invite.ok) await acceptInvite(invite.code, member);
}

// Two months of contributions into JFK Empire, so the ledger has real history.
// Paystack's local-card fee: 1.5% + ₦100, capped at ₦2,000.
const { postContribution, lockFunds } = await import(
  "../src/modules/ledger/operations.js"
);
const { reconcileLedger, describeReport } = await import(
  "../src/modules/ledger/reconcile.js"
);

// Gross-up, matching the default group setting: the member's card carries the
// fee so the treasury receives a clean ₦50,000 per contribution.
const { planCharge } = await import("../src/modules/payments/fees.js");
const empirePlan = planCharge(Money.fromMajor(50_000), true);

const empireMembers = [geoffrey, chuka, tunde, amaka];
for (let cycle = 1; cycle <= 2; cycle += 1) {
  for (const [index, member] of empireMembers.entries()) {
    await postContribution({
      contributionId: `seed-empire-c${cycle}-m${index}`,
      groupId: empire.groupId,
      memberUserId: member,
      charged: empirePlan.charged,
      fee: empirePlan.fee,
      occurredAt: new Date(Date.now() - (3 - cycle) * 30 * 24 * 60 * 60 * 1000),
    });
  }
}

// Lock most of it, the way a treasury group holding for a target would.
await lockFunds({
  groupId: empire.groupId,
  amount: Money.fromMajor(300_000),
  lockId: "seed-empire-lock-1",
  reason: "Locked until the group votes to release",
});

// One week of the rotating group.
const ajoPlan = planCharge(Money.fromMajor(20_000), true);
for (const [index, member] of [chuka, geoffrey, amaka].entries()) {
  await postContribution({
    contributionId: `seed-ajo-c1-m${index}`,
    groupId: ajo.groupId,
    memberUserId: member,
    charged: ajoPlan.charged,
    fee: ajoPlan.fee,
  });
}

const report = await reconcileLedger();
if (!report.clean) {
  console.error(describeReport(report));
  process.exit(1);
}

console.log("\n✓ Seeded 2 groups and 4 users\n");
console.log("  JFK Empire  (treasury, ₦50,000/month, 4 members)");
console.log("  Family Ajo  (rotating, ₦20,000/week, 3 members)");
console.log(`\n✓ ${describeReport(report)}\n`);
console.log("Sign in as anyone by setting this cookie in your browser:\n");
for (const person of created) {
  console.log(`  ${person.name.padEnd(15)} jfk_session=${person.token}`);
}
console.log("");
process.exit(0);
