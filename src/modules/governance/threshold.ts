/**
 * Vote counting. See BLUEPRINT.md §9.
 *
 * Pure functions, no database — the arithmetic that decides whether the group's
 * money moves deserves to be testable in isolation and exhaustively.
 *
 * The rules, stated once:
 *
 *   approval = yes / (yes + no)
 *
 * Abstentions count toward **quorum** but not toward the ratio. That is the
 * fair reading: someone who abstained turned up and declined to take a side,
 * so they prove the vote was seen without tipping it.
 *
 * Thresholds are integers in permille (667 = 66.7%). A float threshold is a
 * rounding argument waiting to happen the first time a vote lands exactly on
 * the line, and that is precisely the moment nobody wants an argument.
 */

export interface VoteTally {
  yes: number;
  no: number;
  abstain: number;
}

export interface ThresholdInput extends VoteTally {
  /** Members eligible when the proposal opened. Snapshotted, never recomputed. */
  eligibleVoters: number;
  /** Approval needed, in permille. 667 = 66.7%. */
  thresholdPermille: number;
  /** Share of eligible voters who must respond, in percent. */
  quorumPct: number;
}

export type ProposalOutcome =
  /** Enough support, enough turnout. Ready to execute. */
  | { decision: "approved"; approvalPermille: number; turnoutPct: number }
  /** Cannot reach the threshold even if everyone left votes yes. */
  | { decision: "rejected"; reason: "threshold_unreachable" | "threshold_missed" | "quorum_missed"; approvalPermille: number; turnoutPct: number }
  /** Still in play. */
  | { decision: "undecided"; approvalPermille: number; turnoutPct: number; needed: NeededToPass };

export interface NeededToPass {
  /** Further yes votes required for the threshold, given current votes. */
  moreYesVotes: number;
  /** Further votes of any kind required for quorum. */
  moreVotesForQuorum: number;
}

/**
 * Count a vote and decide where it stands.
 *
 * `atDeadline` changes the meaning of "not yet decided": while voting is open
 * an incomplete vote is undecided, but once the deadline passes the same
 * numbers are a final answer.
 */
export function evaluate(
  input: ThresholdInput,
  atDeadline = false,
): ProposalOutcome {
  const { yes, no, abstain, eligibleVoters, thresholdPermille, quorumPct } = input;

  const cast = yes + no + abstain;
  const decisive = yes + no;

  const approvalPermille = decisive === 0 ? 0 : Math.round((yes * 1000) / decisive);
  const turnoutPct = eligibleVoters === 0 ? 0 : Math.round((cast * 100) / eligibleVoters);

  const quorumMet = turnoutPct >= quorumPct;
  const thresholdMet = decisive > 0 && approvalPermille >= thresholdPermille;

  /**
   * The vote is final once the deadline passes or everybody has spoken.
   * Handled first so a fully-voted proposal is reported as having *missed*
   * the threshold rather than as having been unreachable — both are
   * rejections, but "unreachable" should mean "we called it early", and
   * telling a group their unanimous 5–5 split was unreachable is just
   * confusing.
   */
  if (atDeadline || cast >= eligibleVoters) {
    if (!quorumMet) {
      return { decision: "rejected", reason: "quorum_missed", approvalPermille, turnoutPct };
    }
    if (!thresholdMet) {
      return { decision: "rejected", reason: "threshold_missed", approvalPermille, turnoutPct };
    }
    return { decision: "approved", approvalPermille, turnoutPct };
  }

  // Votes still outstanding. Only call it early when the arithmetic genuinely
  // cannot be changed by whoever has yet to vote.

  // Passing, and no combination of remaining votes could undo it.
  if (quorumMet && thresholdMet && isMathematicallySettled(input)) {
    return { decision: "approved", approvalPermille, turnoutPct };
  }

  // Failing, and even unanimous support from here could not save it. Calling
  // it now is kinder than a week of false hope.
  if (isThresholdUnreachable(input)) {
    return {
      decision: "rejected",
      reason: "threshold_unreachable",
      approvalPermille,
      turnoutPct,
    };
  }

  return {
    decision: "undecided",
    approvalPermille,
    turnoutPct,
    needed: whatIsNeeded(input),
  };
}

/**
 * True when no combination of the remaining votes could change the result.
 *
 * Guards against approving a proposal that is currently passing but could
 * still be voted down by members who have not spoken.
 */
function isMathematicallySettled(input: ThresholdInput): boolean {
  const { yes, no, abstain, eligibleVoters, thresholdPermille } = input;
  const remaining = Math.max(0, eligibleVoters - (yes + no + abstain));

  if (remaining === 0) return true;

  // Worst case for the proposal: every remaining vote is a no.
  const worstDecisive = yes + no + remaining;
  const worstApproval = worstDecisive === 0 ? 0 : Math.round((yes * 1000) / worstDecisive);

  return worstApproval >= thresholdPermille;
}

/** True when even unanimous support from here cannot reach the threshold. */
function isThresholdUnreachable(input: ThresholdInput): boolean {
  const { yes, no, abstain, eligibleVoters, thresholdPermille } = input;
  const remaining = Math.max(0, eligibleVoters - (yes + no + abstain));

  // Best case: every remaining vote is a yes.
  const bestYes = yes + remaining;
  const bestDecisive = bestYes + no;

  if (bestDecisive === 0) return false;

  const bestApproval = Math.round((bestYes * 1000) / bestDecisive);
  return bestApproval < thresholdPermille;
}

/** What it would take to pass from here — shown live on the proposal. */
export function whatIsNeeded(input: ThresholdInput): NeededToPass {
  const { yes, no, abstain, eligibleVoters, thresholdPermille, quorumPct } = input;

  // Smallest y such that (yes + y) / (yes + y + no) >= threshold.
  let moreYesVotes = 0;
  const remaining = Math.max(0, eligibleVoters - (yes + no + abstain));

  while (moreYesVotes <= remaining) {
    const y = yes + moreYesVotes;
    const decisive = y + no;
    if (decisive > 0 && Math.round((y * 1000) / decisive) >= thresholdPermille) break;
    moreYesVotes++;
  }

  const votesNeededForQuorum = Math.ceil((quorumPct * eligibleVoters) / 100);
  const moreVotesForQuorum = Math.max(0, votesNeededForQuorum - (yes + no + abstain));

  return {
    moreYesVotes: Math.min(moreYesVotes, remaining),
    moreVotesForQuorum,
  };
}

/** 667 → "66.7%", 800 → "80%". */
export function formatPermille(permille: number): string {
  const percent = permille / 10;
  return `${Number.isInteger(percent) ? percent : percent.toFixed(1)}%`;
}
