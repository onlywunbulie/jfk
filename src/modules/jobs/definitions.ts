import "server-only";
import { Money } from "@/lib/money";
import {
  closeCycle,
  findCyclesToClose,
  findGroupsNeedingCycles,
  openCycleFor,
} from "@/modules/contributions/service";
import {
  collectContribution,
  findDueContributions,
  findRetryableContributions,
} from "@/modules/contributions/collect";
import { reconcileLedger, describeReport } from "@/modules/ledger/reconcile";
import {
  evaluateProposal,
  findProposalsToClose,
} from "@/modules/governance/service";
import { dayKey, hourKey, type JobDefinition } from "./runner";

/**
 * The scheduled jobs, per BLUEPRINT.md §15.
 *
 * Each one is idempotent by construction, not by luck: the work itself is
 * guarded (unique indexes on cycles and contributions, deterministic payment
 * references), so even if the runner's own guard were bypassed nothing would
 * double-charge.
 */

/**
 * Open the current cycle for every active group.
 *
 * Safe to run any number of times a day — the unique index on
 * (group, sequence_no) means only the first call of a period creates anything.
 */
export const openCycles: JobDefinition = {
  name: "open-cycles",
  description: "Create the current contribution cycle for each active group",
  key: (ctx) => `open-cycles:${dayKey(ctx.now)}`,
  async run(ctx) {
    const groups = await findGroupsNeedingCycles();
    const opened: string[] = [];

    for (const group of groups) {
      const result = await openCycleFor(group.id, ctx.now);
      if (result?.created) opened.push(`${group.name} #${result.sequenceNo}`);
    }

    return {
      summary: `Opened ${opened.length} cycle(s) across ${groups.length} group(s)`,
      details: { opened, groupsChecked: groups.length },
    };
  },
};

/**
 * Charge everyone whose contribution is due.
 *
 * The charge itself is not the end: each one leaves the obligation PROCESSING
 * and the webhook settles it. A job run that appears to "do nothing" because
 * every contribution is already processing is working correctly.
 */
export const collectContributions: JobDefinition = {
  name: "collect-contributions",
  description: "Charge saved cards for contributions that are due",
  key: (ctx) => `collect:${dayKey(ctx.now)}`,
  async run(ctx) {
    const due = await findDueContributions(ctx.now);
    const outcomes = { charged: 0, failed: 0, skipped: 0 };
    const failures: string[] = [];

    for (const item of due) {
      const result = await collectContribution(item.id, ctx.now);
      if (result.outcome === "charged") outcomes.charged++;
      else if (result.outcome === "failed") {
        outcomes.failed++;
        failures.push(`${item.id}: ${result.reason}`);
      } else outcomes.skipped++;
    }

    return {
      summary: `${outcomes.charged} charged, ${outcomes.failed} failed, ${outcomes.skipped} skipped of ${due.length} due`,
      details: { ...outcomes, failures },
    };
  },
};

/**
 * Walk the retry ladder.
 *
 * Hourly, because the rungs are 6/24/72 hours and a daily job would stretch
 * them. Only picks up contributions whose `next_retry_at` has actually passed,
 * and only soft declines ever get one.
 */
export const retryFailedCharges: JobDefinition = {
  name: "retry-failed-charges",
  description: "Retry soft-declined contributions whose next attempt is due",
  key: (ctx) => `retry:${hourKey(ctx.now)}`,
  async run(ctx) {
    const retryable = await findRetryableContributions(ctx.now);
    const outcomes = { charged: 0, failed: 0, exhausted: 0 };

    for (const item of retryable) {
      const result = await collectContribution(item.id, ctx.now);
      if (result.outcome === "charged") outcomes.charged++;
      else if (result.outcome === "failed") {
        // No further retry scheduled means the ladder is done.
        if (result.retryAt === null) outcomes.exhausted++;
        else outcomes.failed++;
      }
    }

    return {
      summary: `Retried ${retryable.length}: ${outcomes.charged} charged, ${outcomes.exhausted} gave up`,
      details: outcomes,
    };
  },
};

/**
 * Close cycles past their grace period.
 *
 * Anything unpaid becomes MISSED. For a rotating group that closed fully
 * funded, the result carries the payout that is now due — Phase 6 executes it.
 */
export const closeCycles: JobDefinition = {
  name: "close-cycles",
  description: "Close cycles past their grace period and mark arrears",
  key: (ctx) => `close-cycles:${dayKey(ctx.now)}`,
  async run(ctx) {
    const due = await findCyclesToClose(ctx.now);
    let missed = 0;
    let collected = Money.zero();
    const payoutsDue: string[] = [];

    for (const cycle of due) {
      const result = await closeCycle(cycle.id, ctx.now);
      if (!result) continue;

      missed += result.missed;
      collected = collected.plus(result.collected);
      if (result.payoutDue) payoutsDue.push(result.cycleId);
    }

    return {
      summary: `Closed ${due.length} cycle(s); ${missed} missed; ${collected.format()} collected`,
      details: {
        closed: due.length,
        missed,
        collected: collected.minor,
        // Executed in Phase 6; recorded here so nothing is silently dropped.
        payoutsDue,
      },
    };
  },
};

/**
 * Re-derive every balance from the entries and assert the ledger's invariants.
 *
 * The most important job in the system. A non-clean result means the books can
 * no longer be trusted, so it throws — the run is marked FAILED and shows up
 * rather than passing quietly in a log nobody reads.
 */
export const reconcile: JobDefinition = {
  name: "reconcile-ledger",
  description: "Verify the ledger's invariants and alarm on any drift",
  key: (ctx) => `reconcile:${dayKey(ctx.now)}`,
  async run() {
    const report = await reconcileLedger();

    if (!report.clean) {
      throw new Error(describeReport(report));
    }

    return {
      summary: describeReport(report),
      details: {
        accounts: report.accountsChecked,
        transactions: report.transactionsChecked,
        warnings: report.findings,
      },
    };
  },
};

/**
 * Settle proposals whose voting window has closed.
 *
 * Runs often, because a proposal that has already been decided but still reads
 * "voting" is confusing, and because an approved proposal reserves funds — the
 * sooner that happens, the sooner the group knows what it can still spend.
 */
export const closeProposals: JobDefinition = {
  name: "close-proposals",
  description: "Settle proposals whose voting deadline has passed",
  key: (ctx) => `close-proposals:${hourKey(ctx.now)}`,
  async run(ctx) {
    const due = await findProposalsToClose(ctx.now);
    const outcomes = { approved: 0, rejected: 0, stillOpen: 0 };

    for (const proposal of due) {
      const outcome = await evaluateProposal(proposal.id, ctx.now);
      if (outcome.decision === "approved") outcomes.approved++;
      else if (outcome.decision === "rejected") outcomes.rejected++;
      else outcomes.stillOpen++;
    }

    return {
      summary: `Settled ${due.length}: ${outcomes.approved} approved, ${outcomes.rejected} rejected`,
      details: outcomes,
    };
  },
};

export const ALL_JOBS: JobDefinition[] = [
  openCycles,
  collectContributions,
  retryFailedCharges,
  closeCycles,
  closeProposals,
  reconcile,
];

export function findJob(name: string): JobDefinition | undefined {
  return ALL_JOBS.find((job) => job.name === name);
}
