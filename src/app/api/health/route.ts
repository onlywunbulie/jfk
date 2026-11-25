import { timingSafeEqual } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import { formatEther } from "viem";
import { db } from "@/lib/db";
import { jobRuns } from "@/lib/db/schema";
import { publicClient } from "@/lib/chain/client";
import { RELAYER_LOW_WEI, RELAYER_RESERVE_WEI, relayer } from "@/lib/chain/relayer";
import { HELPER_LOW_WEI, helperIsSeparate, helperKey } from "@/lib/chain/helper-key";
import { env } from "@/lib/env";

/**
 * Is Rallied healthy? For an uptime monitor to check every few minutes: 200
 * when everything is fine, 503 (with which check failed) when something
 * needs a person, so the monitor emails you.
 *
 * Checks: the database answers; Base answers; the fee wallet isn't low; the
 * paymaster and the daily job are set up; and the daily dues collection ran
 * in the last day and a half.
 *
 * Anyone sees only pass/fail per check. With `Authorization: Bearer
 * <CRON_SECRET>` it also shows the numbers (the fee wallet's balance).
 */

type Check = { ok: boolean; note: string };

export async function GET(request: Request): Promise<Response> {
  const detailed = hasSecret(request);
  const checks: Record<string, Check> = {};

  checks.database = await attempt(async () => {
    await db.execute(sql`select 1`);
    return { ok: true, note: "answers" };
  });

  checks.base = await attempt(async () => {
    const block = await publicClient().getBlockNumber();
    return { ok: block > 0n, note: "answers" };
  });

  checks.feeWallet = await attempt(async () => {
    const wallet = relayer();
    if (!wallet) return { ok: false, note: "RELAYER_PRIVATE_KEY isn't set" };
    const balance = await publicClient().getBalance({ address: wallet.account.address });
    const amount = detailed ? ` (${formatEther(balance)} ETH)` : "";
    if (balance < RELAYER_RESERVE_WEI) return { ok: false, note: `below its reserve: new groups are paused, top it up${amount}` };
    if (balance < RELAYER_LOW_WEI) return { ok: false, note: `running low: top it up soon${amount}` };
    return { ok: true, note: `enough${amount}` };
  });

  // The helper key pays for each collection and AI vote. Unset, the fee wallet still does that job.
  checks.helperKey = await attempt(async () => {
    if (!helperIsSeparate()) return { ok: true, note: "not set: the fee wallet collects dues and casts AI votes" };
    const wallet = helperKey();
    if (!wallet) return { ok: false, note: "HELPER_PRIVATE_KEY isn't usable" };
    const balance = await publicClient().getBalance({ address: wallet.account.address });
    const amount = detailed ? ` (${formatEther(balance)} ETH)` : "";
    if (balance < HELPER_LOW_WEI) return { ok: false, note: `running low: top it up${amount}` };
    return { ok: true, note: `enough${amount}` };
  });

  checks.paymaster = { ok: Boolean(env().PAYMASTER_URL), note: env().PAYMASTER_URL ? "set up" : "PAYMASTER_URL isn't set" };
  checks.dailyJob = { ok: Boolean(process.env.CRON_SECRET), note: process.env.CRON_SECRET ? "set up" : "CRON_SECRET isn't set" };

  checks.duesCollection = await attempt(async () => {
    const [last] = await db
      .select({ startedAt: jobRuns.startedAt, status: jobRuns.status })
      .from(jobRuns)
      .where(and(eq(jobRuns.jobName, "collect-dues-on-base")))
      .orderBy(desc(jobRuns.startedAt))
      .limit(1);
    if (!last) return { ok: true, note: "hasn't run yet" };
    const hours = (Date.now() - last.startedAt.getTime()) / 3_600_000;
    if (hours > 36) return { ok: false, note: `last ran ${Math.round(hours)} hours ago` };
    if (last.status === "FAILED") return { ok: false, note: "its last run failed" };
    return { ok: true, note: `ran ${Math.round(hours)} hours ago` };
  });

  const healthy = Object.values(checks).every((check) => check.ok);
  return Response.json(
    { healthy, checks },
    { status: healthy ? 200 : 503, headers: { "Cache-Control": "no-store" } },
  );
}

async function attempt(check: () => Promise<Check>): Promise<Check> {
  try {
    return await Promise.race([check(), new Promise<Check>((resolve) => setTimeout(() => resolve({ ok: false, note: "didn't answer in 8 seconds" }), 8_000))]);
  } catch {
    return { ok: false, note: "failed" };
  }
}

function hasSecret(request: Request): boolean {
  const expected = process.env.CRON_SECRET ?? "";
  const provided = (request.headers.get("authorization") ?? "").replace(/^Bearer /, "");
  if (!expected || provided.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
}
