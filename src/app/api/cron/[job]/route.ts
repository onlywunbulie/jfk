import { timingSafeEqual } from "node:crypto";
import { env } from "@/lib/env";
import { findJob, ALL_JOBS } from "@/modules/jobs/definitions";
import { runJob } from "@/modules/jobs/runner";

/**
 * HTTP trigger for scheduled jobs.
 *
 * Whatever runs the schedule — Vercel Cron, Inngest, a plain crontab with
 * curl — calls this. The job bodies do not care which.
 *
 * Protected by a shared secret rather than a session: there is no user here.
 * Without `CRON_SECRET` configured the route refuses everything, so a
 * misconfigured deploy fails closed rather than exposing "charge everyone's
 * card" to the internet.
 */
export async function POST(
  request: Request,
  { params }: RouteContext<"/api/cron/[job]">,
): Promise<Response> {
  const authorized = checkSecret(request);
  if (!authorized.ok) {
    return Response.json({ error: authorized.reason }, { status: 401 });
  }

  const { job: jobName } = await params;
  const definition = findJob(jobName);

  if (!definition) {
    return Response.json(
      { error: `Unknown job "${jobName}"`, available: ALL_JOBS.map((j) => j.name) },
      { status: 404 },
    );
  }

  const outcome = await runJob(definition, { now: new Date() });

  // A failed job returns 500 so the scheduler's own retry and alerting fire.
  return Response.json(outcome, {
    status: outcome.status === "failed" ? 500 : 200,
  });
}

function checkSecret(request: Request): { ok: true } | { ok: false; reason: string } {
  const expected = process.env.CRON_SECRET ?? "";

  // Fail closed. An unset secret must never mean "allow anyone".
  if (!expected) return { ok: false, reason: "CRON_SECRET is not configured" };

  const header = request.headers.get("authorization") ?? "";
  const provided = header.startsWith("Bearer ") ? header.slice(7) : header;

  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, reason: "invalid credentials" };
  }

  return { ok: true };
}

/** Listing the jobs is harmless and useful; running them is not. */
export async function GET(): Promise<Response> {
  if (env().NODE_ENV === "production") {
    return Response.json({ error: "method not allowed" }, { status: 405 });
  }
  return Response.json({
    jobs: ALL_JOBS.map((job) => ({
      name: job.name,
      description: job.description,
    })),
  });
}
