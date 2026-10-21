// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {JfkModule} from "../src/JfkModule.sol";
import {JfkBase} from "./JfkBase.sol";

/**
 * The contract's vote counting must agree with the app's, or a group would
 * see "passed" on screen and a refusal on-chain.
 *
 * `appEvaluate` below is a line-by-line port of `evaluate` in
 * src/modules/governance/threshold.ts, written separately from the contract
 * on purpose. The fuzzer drives real votes through a real Safe and checks the
 * two always reach the same answer.
 */
contract TallyFuzzTest is JfkBase {
    address internal vendor = makeAddr("vendor");

    struct Case {
        uint256 size;
        uint256 yes;
        uint256 no;
        uint256 abstain;
        uint16 threshold;
        uint8 quorum;
        bool atDeadline;
    }

    function testFuzz_contractAgreesWithTheApp(
        uint8 groupSize,
        uint8 yesVotes,
        uint8 noVotes,
        uint8 abstainVotes,
        uint8 thresholdPick,
        uint8 quorumPick,
        bool atDeadline
    ) public {
        Case memory c;
        c.size = bound(groupSize, 1, 12);
        c.yes = bound(yesVotes, 0, c.size);
        c.no = bound(noVotes, 0, c.size - c.yes);
        c.abstain = bound(abstainVotes, 0, c.size - c.yes - c.no);
        uint16[6] memory thresholds = [uint16(500), 600, 667, 750, 800, 1000];
        uint8[5] memory quorums = [uint8(40), 50, 60, 75, 100];
        c.threshold = thresholds[thresholdPick % thresholds.length];
        c.quorum = quorums[quorumPick % quorums.length];
        c.atDeadline = atDeadline;

        (address safe, uint256 id) = _castVotes(c);

        assertEq(
            uint256(module.decision(safe, id)),
            uint256(appEvaluate(c)),
            "contract and app disagree"
        );
    }

    function _castVotes(Case memory c) internal returns (address safe, uint256 id) {
        uint16[9] memory rules = defaultThresholds();
        rules[uint256(JfkModule.Rule.SPEND_SMALL)] = c.threshold;
        rules[uint256(JfkModule.Rule.SPEND_LARGE)] = c.threshold;

        address[] memory list = members(c.size);
        safe = createGroupWith(list, rules, c.quorum, VOTING_PERIOD);
        id = proposeAs(list[0], safe, JfkModule.Action.SPEND, abi.encode(vendor, uint256(1)));

        uint256 voter;
        for (uint256 i = 0; i < c.yes; i++) voteAs(list[voter++], safe, id, JfkModule.Choice.YES);
        for (uint256 i = 0; i < c.no; i++) voteAs(list[voter++], safe, id, JfkModule.Choice.NO);
        for (uint256 i = 0; i < c.abstain; i++) voteAs(list[voter++], safe, id, JfkModule.Choice.ABSTAIN);

        if (c.atDeadline) vm.warp(block.timestamp + VOTING_PERIOD);
    }

    /**
     * Turning a "not sure" into a "no" can never turn a rejection into a pass.
     *
     * (Adding a brand-new "no" vote *can* help a proposal pass, by lifting
     * turnout over the minimum. That's a known quirk of turnout rules, and the
     * app has the same behaviour; see the report on this phase. Swapping an
     * abstention for a no keeps turnout fixed, so it isolates the vote itself.)
     */
    function testFuzz_aNoVoteNeverHelps(uint8 groupSize, uint8 yesVotes, uint8 noVotes, uint8 thresholdPick, uint8 quorumPick)
        public
        pure
    {
        Case memory c;
        c.size = bound(groupSize, 2, 12);
        c.yes = bound(yesVotes, 0, c.size - 1);
        c.no = bound(noVotes, 0, c.size - 1 - c.yes);
        c.abstain = 1;
        uint16[6] memory thresholds = [uint16(500), 600, 667, 750, 800, 1000];
        uint8[5] memory quorums = [uint8(40), 50, 60, 75, 100];
        c.threshold = thresholds[thresholdPick % thresholds.length];
        c.quorum = quorums[quorumPick % quorums.length];
        c.atDeadline = true;

        JfkModule.Decision before = appEvaluate(c);
        c.abstain = 0;
        c.no += 1;
        if (before == JfkModule.Decision.REJECTED) {
            assertEq(uint256(appEvaluate(c)), uint256(JfkModule.Decision.REJECTED));
        }
    }
    // ---------------------------------------------------------------------
    // Port of threshold.ts `evaluate`. Keep in step with that file.
    // ---------------------------------------------------------------------

    function appEvaluate(Case memory c) internal pure returns (JfkModule.Decision) {
        uint256 cast = c.yes + c.no + c.abstain;
        uint256 decisive = c.yes + c.no;

        uint256 approvalPermille = decisive == 0 ? 0 : mathRound(c.yes * 1000, decisive);
        uint256 turnoutPct = c.size == 0 ? 0 : mathRound(cast * 100, c.size);

        bool quorumMet = turnoutPct >= c.quorum;
        bool thresholdMet = decisive > 0 && approvalPermille >= c.threshold;

        if (c.atDeadline || cast >= c.size) {
            if (!quorumMet || !thresholdMet) return JfkModule.Decision.REJECTED;
            return JfkModule.Decision.APPROVED;
        }

        if (quorumMet && thresholdMet && isMathematicallySettled(c)) return JfkModule.Decision.APPROVED;
        if (isThresholdUnreachable(c)) return JfkModule.Decision.REJECTED;
        return JfkModule.Decision.UNDECIDED;
    }

    function remainingVotes(Case memory c) internal pure returns (uint256) {
        uint256 cast = c.yes + c.no + c.abstain;
        return c.size > cast ? c.size - cast : 0;
    }

    function isMathematicallySettled(Case memory c) internal pure returns (bool) {
        uint256 remaining = remainingVotes(c);
        if (remaining == 0) return true;
        uint256 worstDecisive = c.yes + c.no + remaining;
        uint256 worstApproval = worstDecisive == 0 ? 0 : mathRound(c.yes * 1000, worstDecisive);
        return worstApproval >= c.threshold;
    }

    function isThresholdUnreachable(Case memory c) internal pure returns (bool) {
        uint256 bestYes = c.yes + remainingVotes(c);
        uint256 bestDecisive = bestYes + c.no;
        if (bestDecisive == 0) return false;
        return mathRound(bestYes * 1000, bestDecisive) < c.threshold;
    }

    /// JavaScript's Math.round for a non-negative fraction a / b.
    function mathRound(uint256 a, uint256 b) internal pure returns (uint256) {
        uint256 whole = a / b;
        uint256 rest = a % b;
        return rest * 2 >= b ? whole + 1 : whole;
    }
}
