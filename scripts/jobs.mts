/**
 * Run scheduled jobs from the command line.
 *
 *   pnpm jobs list                       what exists
 *   pnpm jobs run open-cycles            run one
 *   pnpm jobs run collect-contributions --at 2026-04-01
 *   pnpm jobs tick                       run them all in the right order
 *
 * `--at` sets the logical "now", so a whole month of cycles can be walked
 * through in a few seconds without waiting for real time to pass.
 *
 * Stop `pnpm dev` first: PGlite allows one process at a time.
 */
import { config } from "dotenv";

config({ path: ".env.local" });
config({ path: ".env" });

const { ALL_JOBS, findJob } = await import("../src/modules/jobs/definitions.js");
const { runJob } = await import("../src/modules/jobs/runner.js");

const [command, jobName] = process.argv.slice(2);

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

const at = flag("at");
const now = at ? new Date(at) : new Date();

if (at && Number.isNaN(now.getTime())) {
  console.error(`Could not parse --at "${at}". Try 2026-04-01.`);
  process.exit(1);
}

if (command === "list" || !command) {
  console.log("\nAvailable jobs:\n");
  for (const job of ALL_JOBS) {
    console.log(`  ${job.name.padEnd(24)} ${job.description}`);
  }
  console.log("\n  pnpm jobs run <name> [--at 2026-04-01]");
  console.log("  pnpm jobs tick        run all of them, in order\n");
  process.exit(0);
}

/** The order matters: open cycles before collecting, collect before closing. */
async function tick() {
  console.log(`\nRunning all jobs as at ${now.toISOString()}\n`);
  let failed = false;

  for (const job of ALL_JOBS) {
    const outcome = await runJob(job, { now });
    const label = job.name.padEnd(24);

    if (outcome.status === "completed") {
      console.log(`  ✓ ${label} ${outcome.result.summary}`);
    } else if (outcome.status === "skipped") {
      console.log(`  · ${label} skipped (${outcome.reason})`);
    } else {
      console.log(`  ✗ ${label} ${outcome.error}`);
      failed = true;
    }
  }

  console.log("");
  process.exit(failed ? 1 : 0);
}

if (command === "tick") await tick();

if (command === "run") {
  const definition = jobName ? findJob(jobName) : undefined;
  if (!definition) {
    console.error(
      `Unknown job "${jobName}". Available: ${ALL_JOBS.map((j) => j.name).join(", ")}`,
    );
    process.exit(1);
  }

  const outcome = await runJob(definition, { now });

  if (outcome.status === "completed") {
    console.log(`✓ ${outcome.result.summary}`);
    if (outcome.result.details) {
      console.log(JSON.stringify(outcome.result.details, null, 2));
    }
  } else if (outcome.status === "skipped") {
    console.log(`· skipped: ${outcome.reason}`);
  } else {
    console.error(`✗ ${outcome.error}`);
  }

  process.exit(outcome.status === "failed" ? 1 : 0);
}

console.error(`Unknown command "${command}". Try list, run or tick.`);
process.exit(1);
