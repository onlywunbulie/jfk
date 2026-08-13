import "server-only";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { jobRuns } from "@/lib/db/schema";

/**
 * Background jobs.
 *
 * BLUEPRINT.md §15 specifies Inngest. That needs a cloud account and cannot be
 * exercised offline, so jobs are plain functions here with their own
 * idempotency table, runnable three ways: the CLI (`pnpm jobs run <name>`), a
 * secured HTTP route (`/api/cron/<name>`), or Inngest later as a thin trigger.
 * Nothing about the job bodies would change.
 *
 * **Every job must be safe to run twice.** Schedulers double-fire and humans
 * run things by hand; a job that charges cards must treat that as normal.
 */

export interface JobContext {
  /** The logical moment the job is running for. Injectable, so tests can time-travel. */
  now: Date;
}

export interface JobResult {
  /** Short human summary for the log line. */
  summary: string;
  /** Anything worth keeping — counts, ids, failures. */
  details?: Record<string, unknown>;
}

export interface JobDefinition {
  name: string;
  description: string;
  /**
   * Names the logical occurrence, e.g. `collect:2026-03-01`. Two runs sharing
   * a key are the same occurrence, and the second is skipped.
   */
  key: (context: JobContext) => string;
  run: (context: JobContext) => Promise<JobResult>;
}

export type JobOutcome =
  | { status: "completed"; job: string; key: string; result: JobResult }
  | { status: "skipped"; job: string; key: string; reason: string }
  | { status: "failed"; job: string; key: string; error: string };

/**
 * Run a job once for its occurrence.
 *
 * The unique index on `job_key` is the guard: a second concurrent run inserts
 * nothing and exits. A previously *failed* run is allowed to retry, because a
 * job that failed halfway has not finished its work.
 */
export async function runJob(
  definition: JobDefinition,
  context: JobContext = { now: new Date() },
): Promise<JobOutcome> {
  const key = definition.key(context);

  const claimed = await db
    .insert(jobRuns)
    .values({ jobName: definition.name, jobKey: key, status: "RUNNING" })
    .onConflictDoNothing()
    .returning({ id: jobRuns.id });

  if (claimed.length === 0) {
    const [existing] = await db
      .select({ id: jobRuns.id, status: jobRuns.status })
      .from(jobRuns)
      .where(eq(jobRuns.jobKey, key))
      .limit(1);

    if (existing?.status !== "FAILED") {
      return {
        status: "skipped",
        job: definition.name,
        key,
        reason: `already ${existing?.status?.toLowerCase() ?? "claimed"}`,
      };
    }

    // Retry a failed run in place.
    await db
      .update(jobRuns)
      .set({ status: "RUNNING", error: null, startedAt: new Date() })
      .where(eq(jobRuns.id, existing.id));

    return execute(definition, context, existing.id, key);
  }

  return execute(definition, context, claimed[0].id, key);
}

async function execute(
  definition: JobDefinition,
  context: JobContext,
  runId: string,
  key: string,
): Promise<JobOutcome> {
  try {
    const result = await definition.run(context);

    await db
      .update(jobRuns)
      .set({
        status: "COMPLETED",
        finishedAt: new Date(),
        result: serialisable(result) as object,
      })
      .where(eq(jobRuns.id, runId));

    return { status: "completed", job: definition.name, key, result };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    // Left FAILED so the next scheduled run picks it up rather than skipping.
    await db
      .update(jobRuns)
      .set({ status: "FAILED", finishedAt: new Date(), error: message })
      .where(eq(jobRuns.id, runId));

    return { status: "failed", job: definition.name, key, error: message };
  }
}

/** BigInt is not JSON-serialisable, and job results carry money. */
function serialisable(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value, (_key, v) => (typeof v === "bigint" ? v.toString() : v)),
  );
}

/** `2026-03-01` in UTC — the granularity most daily jobs key on. */
export function dayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** `2026-03-01T14` — for jobs that run more than once a day. */
export function hourKey(date: Date): string {
  return date.toISOString().slice(0, 13);
}
