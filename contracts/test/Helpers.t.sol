// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {JfkBase} from "./JfkBase.sol";
import {JfkModule} from "../src/JfkModule.sol";

/**
 * Helpers (a key acting for one member, within its powers) and collected
 * dues. The promises being tested:
 *  - a helper counts exactly as its member, never as an extra member;
 *  - only the member's own named key, with the right power, before it expires;
 *  - a helper never moves money and never survives its member leaving;
 *  - a group can turn helper votes off;
 *  - dues are collected only by the member's helper, exactly one
 *    contribution, at most once per payment gap.
 */
contract HelpersTest is JfkBase {
    address[] internal five;
    address internal safe;
    address internal helperKey = makeAddr("helper");
    address internal stranger = makeAddr("stranger");
    address internal vendor = makeAddr("vendor");

    uint8 internal constant PROPOSE = 1;
    uint8 internal constant VOTE = 2;
    uint8 internal constant COLLECT = 4;

    function setUp() public override {
        super.setUp();
        five = members(5);
        safe = createGroup(five);
    }

    function nameHelper(address member, uint8 powers) internal {
        vm.prank(member);
        module.setHelper(safe, helperKey, powers, uint64(block.timestamp + 30 days));
    }

    function proposeSpendFor(address member) internal returns (uint256 id) {
        vm.prank(helperKey);
        id = module.proposeFor(safe, member, JfkModule.Action.SPEND, abi.encode(vendor, 10 * USD));
    }

    // ---------------------------------------------------------------------
    // Naming a helper
    // ---------------------------------------------------------------------

    function test_aMemberNamesTheirHelper() public {
        nameHelper(five[0], PROPOSE | VOTE);
        JfkModule.Helper memory h = module.getHelper(safe, five[0]);
        assertEq(h.key, helperKey);
        assertEq(h.powers, PROPOSE | VOTE);
    }

    function test_onlyAMemberCanNameAHelper() public {
        vm.prank(stranger);
        vm.expectRevert(JfkModule.NotAMember.selector);
        module.setHelper(safe, helperKey, PROPOSE, uint64(block.timestamp + 1 days));
    }

    function test_aHelperMustBeARealSeparateKey() public {
        uint64 soon = uint64(block.timestamp + 1 days);
        vm.startPrank(five[0]);
        vm.expectRevert(JfkModule.InvalidHelper.selector);
        module.setHelper(safe, address(0), PROPOSE, soon);
        vm.expectRevert(JfkModule.InvalidHelper.selector);
        module.setHelper(safe, five[0], PROPOSE, soon); // yourself
        vm.expectRevert(JfkModule.InvalidHelper.selector);
        module.setHelper(safe, safe, PROPOSE, soon);
        vm.expectRevert(JfkModule.InvalidHelper.selector);
        module.setHelper(safe, address(module), PROPOSE, soon);
        vm.stopPrank();
    }

    function test_aHelperNeedsKnownPowersAndAnExpiryWithinAYear() public {
        vm.startPrank(five[0]);
        vm.expectRevert(JfkModule.InvalidHelper.selector);
        module.setHelper(safe, helperKey, 0, uint64(block.timestamp + 1 days));
        vm.expectRevert(JfkModule.InvalidHelper.selector);
        module.setHelper(safe, helperKey, 8, uint64(block.timestamp + 1 days));
        vm.expectRevert(JfkModule.InvalidHelper.selector);
        module.setHelper(safe, helperKey, PROPOSE, uint64(block.timestamp)); // already expired
        vm.expectRevert(JfkModule.InvalidHelper.selector);
        module.setHelper(safe, helperKey, PROPOSE, uint64(block.timestamp + 367 days));
        vm.stopPrank();
    }

    // ---------------------------------------------------------------------
    // Proposing and voting for a member
    // ---------------------------------------------------------------------

    function test_aHelperProposesAsItsMember() public {
        nameHelper(five[0], PROPOSE);
        uint256 id = proposeSpendFor(five[0]);
        assertEq(module.getProposal(safe, id).proposer, five[0], "the member proposed, through their helper");
    }

    function test_aHelperVotesAsItsMember_oneMemberOneVote() public {
        nameHelper(five[0], VOTE);
        uint256 id = proposeAs(five[1], safe, JfkModule.Action.SPEND, abi.encode(vendor, 10 * USD));

        vm.prank(helperKey);
        module.voteFor(safe, five[0], id, JfkModule.Choice.YES);
        assertEq(uint8(module.voteOf(safe, id, five[0])), uint8(JfkModule.Choice.YES));
        assertEq(module.getProposal(safe, id).yes, 1);

        // It was the member's one vote: neither can vote again.
        vm.expectRevert(JfkModule.AlreadyVoted.selector);
        voteAs(five[0], safe, id, JfkModule.Choice.NO);
        vm.prank(helperKey);
        vm.expectRevert(JfkModule.AlreadyVoted.selector);
        module.voteFor(safe, five[0], id, JfkModule.Choice.YES);
    }

    function test_aMemberWhoVotedThemselvesCantBeOutvotedByTheirHelper() public {
        nameHelper(five[0], VOTE);
        uint256 id = proposeAs(five[1], safe, JfkModule.Action.SPEND, abi.encode(vendor, 10 * USD));
        voteAs(five[0], safe, id, JfkModule.Choice.NO);
        vm.prank(helperKey);
        vm.expectRevert(JfkModule.AlreadyVoted.selector);
        module.voteFor(safe, five[0], id, JfkModule.Choice.YES);
    }

    function test_aHelperOnlyHasThePowersItWasGiven() public {
        nameHelper(five[0], VOTE); // no propose
        vm.prank(helperKey);
        vm.expectRevert(JfkModule.HelperLacksPower.selector);
        module.proposeFor(safe, five[0], JfkModule.Action.SPEND, abi.encode(vendor, 10 * USD));
    }

    function test_onlyTheNamedKeyCanActForTheMember() public {
        nameHelper(five[0], PROPOSE | VOTE);
        vm.prank(stranger);
        vm.expectRevert(JfkModule.NotHelper.selector);
        module.proposeFor(safe, five[0], JfkModule.Action.SPEND, abi.encode(vendor, 10 * USD));

        // A helper for one member can't act for another.
        vm.prank(helperKey);
        vm.expectRevert(JfkModule.NotHelper.selector);
        module.proposeFor(safe, five[1], JfkModule.Action.SPEND, abi.encode(vendor, 10 * USD));
    }

    function test_aHelperStopsWorkingWhenItExpires() public {
        nameHelper(five[0], PROPOSE);
        vm.warp(block.timestamp + 30 days);
        vm.prank(helperKey);
        vm.expectRevert(JfkModule.HelperExpired.selector);
        module.proposeFor(safe, five[0], JfkModule.Action.SPEND, abi.encode(vendor, 10 * USD));
    }

    function test_revokingStopsAHelperAtOnce() public {
        nameHelper(five[0], PROPOSE);
        vm.prank(five[0]);
        module.revokeHelper(safe);
        vm.prank(helperKey);
        vm.expectRevert(JfkModule.NotHelper.selector);
        module.proposeFor(safe, five[0], JfkModule.Action.SPEND, abi.encode(vendor, 10 * USD));
    }

    function test_aHelperCantNameOrChangeHelpers() public {
        nameHelper(five[0], PROPOSE | VOTE | COLLECT);
        // The helper isn't a member, so it can't name anyone, itself included.
        vm.prank(helperKey);
        vm.expectRevert(JfkModule.NotAMember.selector);
        module.setHelper(safe, stranger, PROPOSE, uint64(block.timestamp + 1 days));
    }

    function test_aHelperNeverMovesMoneyWithoutAnApprovedVote() public {
        contributeAll(safe, five);
        nameHelper(five[0], PROPOSE | VOTE);
        uint256 id = proposeSpendFor(five[0]);
        vm.prank(helperKey);
        module.voteFor(safe, five[0], id, JfkModule.Choice.YES);

        // One yes of five isn't enough: carrying it out is refused, and the pot is untouched.
        uint256 before = balanceOf(safe);
        vm.expectRevert(JfkModule.NotApproved.selector);
        module.execute(safe, id);
        assertEq(balanceOf(safe), before);
    }

    // ---------------------------------------------------------------------
    // No group can make voting human-only (version 4)
    // ---------------------------------------------------------------------

    function test_noRulesChangeCanTurnHelperVotesOff() public {
        // A rules change still carries the old "every vote needs a human" flag; it's ignored.
        uint256 change = proposeAs(
            five[0], safe, JfkModule.Action.CHANGE_RULES, abi.encode(defaultThresholds(), QUORUM, VOTING_PERIOD, true)
        );
        voteYes(five, safe, change, 5);
        module.execute(safe, change);
        (bool humanVotesOnly,) = module.getGroupSettings(safe);
        assertFalse(humanVotesOnly);

        nameHelper(five[0], PROPOSE | VOTE);
        uint256 id = proposeSpendFor(five[0]);
        vm.prank(helperKey);
        module.voteFor(safe, five[0], id, JfkModule.Choice.YES);
        assertEq(uint8(module.voteOf(safe, id, five[0])), uint8(JfkModule.Choice.YES));
    }

    // ---------------------------------------------------------------------
    // A helper never outlives its member
    // ---------------------------------------------------------------------

    function test_leavingWipesTheHelperForGood() public {
        nameHelper(five[0], PROPOSE);
        vm.prank(five[0]);
        module.leave(safe);
        assertEq(module.getHelper(safe, five[0]).key, address(0));

        // Even if they're voted back in, the old helper doesn't come back.
        uint256 id = proposeAs(five[1], safe, JfkModule.Action.ADD_MEMBER, abi.encode(five[0]));
        voteYes(_without(five, 0), safe, id, 4);
        module.execute(safe, id);
        vm.prank(helperKey);
        vm.expectRevert(JfkModule.NotHelper.selector);
        module.proposeFor(safe, five[0], JfkModule.Action.SPEND, abi.encode(vendor, 10 * USD));
    }

    function test_beingRemovedWipesTheHelper() public {
        nameHelper(five[4], VOTE);
        uint256 id = proposeAs(five[0], safe, JfkModule.Action.REMOVE_MEMBER, abi.encode(five[4]));
        voteYes(five, safe, id, 4);
        module.execute(safe, id);
        assertEq(module.getHelper(safe, five[4]).key, address(0));
    }

    function test_changingWalletDropsTheOldWalletsHelper() public {
        nameHelper(five[4], VOTE);
        address fresh = makeAddr("fresh wallet");
        uint256 id = proposeAs(five[0], safe, JfkModule.Action.REPLACE_MEMBER, abi.encode(five[4], fresh));
        voteYes(five, safe, id, 4);
        module.execute(safe, id);
        assertEq(module.getHelper(safe, five[4]).key, address(0));
        assertEq(module.getHelper(safe, fresh).key, address(0), "the new wallet names its own, if it wants one");
    }

    // ---------------------------------------------------------------------
    // Collected dues
    // ---------------------------------------------------------------------

    function approveDues(address member, uint256 periods) internal {
        usdc.mint(member, CONTRIBUTION * periods);
        vm.prank(member);
        usdc.approve(address(module), CONTRIBUTION * periods);
    }

    function test_aHelperCollectsExactlyOneContribution() public {
        approveDues(five[0], 12);
        nameHelper(five[0], COLLECT);

        vm.prank(helperKey);
        module.collect(safe, five[0]);
        assertEq(balanceOf(safe), CONTRIBUTION);
        assertEq(module.paidIn(safe, five[0]), CONTRIBUTION);
        assertEq(usdc.balanceOf(five[0]), CONTRIBUTION * 11);
    }

    function test_nobodyElseCanCollect() public {
        approveDues(five[0], 12);
        nameHelper(five[0], COLLECT);
        vm.prank(stranger);
        vm.expectRevert(JfkModule.NotHelper.selector);
        module.collect(safe, five[0]);

        // Not even another member.
        vm.prank(five[1]);
        vm.expectRevert(JfkModule.NotHelper.selector);
        module.collect(safe, five[0]);
    }

    function test_collectingNeedsTheCollectPower() public {
        approveDues(five[0], 12);
        nameHelper(five[0], PROPOSE | VOTE);
        vm.prank(helperKey);
        vm.expectRevert(JfkModule.HelperLacksPower.selector);
        module.collect(safe, five[0]);
    }

    function test_atMostOncePerPaymentGap() public {
        approveDues(five[0], 12);
        nameHelper(five[0], COLLECT);
        vm.startPrank(helperKey);
        module.collect(safe, five[0]);

        vm.warp(block.timestamp + PAY_GAP - 1);
        vm.expectRevert(JfkModule.TooSoon.selector);
        module.collect(safe, five[0]);

        vm.warp(block.timestamp + 1);
        module.collect(safe, five[0]);
        vm.stopPrank();
        assertEq(module.paidIn(safe, five[0]), CONTRIBUTION * 2);
    }

    function test_payingByHandCountsForThePeriod() public {
        approveDues(five[0], 12);
        nameHelper(five[0], COLLECT);
        vm.prank(five[0]);
        module.contribute(safe);

        vm.prank(helperKey);
        vm.expectRevert(JfkModule.TooSoon.selector);
        module.collect(safe, five[0]);
    }

    function test_theMembersApprovalCapsWhatCanBeTaken() public {
        approveDues(five[0], 2);
        usdc.mint(five[0], CONTRIBUTION * 10); // more money, but only two contributions approved
        nameHelper(five[0], COLLECT);

        vm.startPrank(helperKey);
        module.collect(safe, five[0]);
        vm.warp(block.timestamp + PAY_GAP);
        module.collect(safe, five[0]);
        vm.warp(block.timestamp + PAY_GAP);
        vm.expectRevert(); // the token refuses: allowance used up
        module.collect(safe, five[0]);
        vm.stopPrank();
        assertEq(balanceOf(safe), CONTRIBUTION * 2);
    }

    function test_collectingFollowsTheGroupsCurrentContribution() public {
        uint256 id = proposeAs(five[0], safe, JfkModule.Action.CHANGE_CONTRIBUTION, abi.encode(75 * USD));
        voteYes(five, safe, id, 5);
        module.execute(safe, id);

        usdc.mint(five[0], 1000 * USD);
        vm.prank(five[0]);
        usdc.approve(address(module), 1000 * USD);
        nameHelper(five[0], COLLECT);
        vm.prank(helperKey);
        module.collect(safe, five[0]);
        assertEq(balanceOf(safe), 75 * USD);
    }

    function test_cantCollectFromSomeoneWhoLeft() public {
        approveDues(five[0], 12);
        nameHelper(five[0], COLLECT);
        vm.prank(five[0]);
        module.leave(safe);
        vm.prank(helperKey);
        vm.expectRevert(JfkModule.NotAMember.selector);
        module.collect(safe, five[0]);
    }

    // ---------------------------------------------------------------------
    // Fuzz: however the attempts are timed, collections stay spaced and exact
    // ---------------------------------------------------------------------

    function testFuzz_collectionsAreSpacedAndExact(uint32[8] memory waits) public {
        approveDues(five[0], 100);
        nameHelper(five[0], COLLECT);
        // Give the helper a year so expiry doesn't cut the test short.
        vm.prank(five[0]);
        module.setHelper(safe, helperKey, COLLECT, uint64(block.timestamp + 365 days));

        uint256 start = block.timestamp;
        uint256 succeeded;
        uint256 lastAt;
        for (uint256 i = 0; i < waits.length; i++) {
            vm.warp(block.timestamp + (waits[i] % 40 days));
            if (block.timestamp >= start + 365 days) break;
            vm.prank(helperKey);
            try module.collect(safe, five[0]) {
                if (succeeded > 0) assertGe(block.timestamp - lastAt, PAY_GAP, "never two collections inside one gap");
                succeeded++;
                lastAt = block.timestamp;
            } catch {}
        }
        assertEq(balanceOf(safe), succeeded * CONTRIBUTION, "exactly one contribution per collection");
        assertEq(module.paidIn(safe, five[0]), succeeded * CONTRIBUTION);
    }

    function _without(address[] memory list, uint256 skip) internal pure returns (address[] memory out) {
        out = new address[](list.length - 1);
        uint256 j;
        for (uint256 i = 0; i < list.length; i++) {
            if (i != skip) out[j++] = list[i];
        }
    }
}
