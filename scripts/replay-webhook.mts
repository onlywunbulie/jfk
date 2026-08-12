/**
 * Replay a Paystack webhook against the running dev server.
 *
 * The point is to exercise the real HTTP path — signature verification, the
 * dedupe index, the ledger posting — without waiting on Paystack or ngrok.
 * Send the same event twice and the second must be reported as a duplicate.
 *
 *   pnpm webhook:replay <reference> [amountKobo] [feeKobo] [times]
 */
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { config } from "dotenv";

config({ path: ".env.local" });
config({ path: ".env" });

const [reference, amount = "5086294", fees = "86294", times = "2"] =
  process.argv.slice(2);

if (!reference) {
  console.error(
    "Usage: pnpm webhook:replay <reference> [amountKobo] [feeKobo] [times]",
  );
  process.exit(1);
}

const secret = process.env.PAYSTACK_SECRET_KEY;
if (!secret) {
  console.error("PAYSTACK_SECRET_KEY is not set — the signature would not verify.");
  process.exit(1);
}

/**
 * Prefer the port the dev server actually bound to. Next writes it to
 * `.next/dev/lock`, which is more reliable than APP_URL — if 3000 is taken it
 * quietly moves to 3001, 3002, and so on.
 */
function devServerUrl(): string {
  try {
    const lock = JSON.parse(readFileSync(".next/dev/lock", "utf8")) as {
      appUrl?: string;
    };
    if (lock.appUrl) return lock.appUrl;
  } catch {
    // No dev server running, or no lock file — fall through.
  }
  return process.env.APP_URL ?? "http://localhost:3000";
}

const url = `${devServerUrl()}/api/webhooks/paystack`;
console.log(`→ ${url}\n`);

const body = JSON.stringify({
  event: "charge.success",
  data: {
    id: 302961,
    reference,
    amount: Number(amount),
    fees: Number(fees),
    status: "success",
    gateway_response: "Successful",
    authorization: {
      authorization_code: "AUTH_localfixture",
      signature: "SIG_localfixture",
      last4: "4321",
      brand: "visa",
      bank: "GTBank",
      exp_month: "09",
      exp_year: "2030",
      reusable: true,
    },
  },
});

const signature = createHmac("sha512", secret).update(body, "utf8").digest("hex");

for (let attempt = 1; attempt <= Number(times); attempt++) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-paystack-signature": signature },
    body,
  });
  const json = await response.json().catch(() => null);
  console.log(`delivery ${attempt}: ${response.status} ${JSON.stringify(json)}`);
}

// And prove an unsigned delivery is refused.
const forged = await fetch(url, {
  method: "POST",
  headers: { "Content-Type": "application/json", "x-paystack-signature": "deadbeef" },
  body,
});
console.log(`forged signature: ${forged.status} (expect 401)`);
