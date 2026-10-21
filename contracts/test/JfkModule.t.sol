// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Safe} from "@safe/Safe.sol";
import {Enum} from "@safe/common/Enum.sol";
import {JfkModule} from "../src/JfkModule.sol";
import {JfkSetup} from "../src/JfkSetup.sol";
import {JfkBase} from "./JfkBase.sol";

contract JfkModuleTest is JfkBase {
    address[] internal five;
    address internal safe;
    address internal outsider = makeAddr("outsider");
    address internal vendor = makeAddr("vendor");

    function setUp() public override {
        super.setUp();
        five = members(5);
        safe = createGroup(five);
    }

    // ---------------------------------------------------------------------
    // Setting a group up
    // ---------------------------------------------------------------------

    function test_setupEnablesTheModuleAndRegistersTheRules() public view {
        assertTrue(Safe(payable(safe)).isModuleEnabled(address(module)));
        (address token, uint256 contribution, uint32 period, uint8 quorum, bool closed,, uint256 count) =
            module.getGroup(safe);
        assertEq(token, address(usdc));
        assertEq(contribution, CONTRIBUTION);
        assertEq(period, VOTING_PERIOD);
        assertEq(quorum, QUORUM);
        assertFalse(closed);
        assertEq(count, 0);
    }

    function test_theSafeNeedsEveryMemberToSignDirectly() public view {
        assertEq(Safe(payable(safe)).getThreshold(), 5);
    }

    function test_aGroupCannotBeRegisteredTwice() public {
        vm.prank(safe);
        vm.expectRevert(JfkModule.AlreadyRegistered.selector);
        module.registerGroup(IERC20(address(usdc)), CONTRIBUTION, defaultThresholds(), QUORUM, VOTING_PERIOD);
    }

    function test_registrationRefusesASafeThatDoesNotNeedEveryone() public {
        // A Safe whose direct-signing bar is 3 of 5 would let three members
        // walk around the rules. JFK refuses to run on it.
        bytes memory setupData = abi.encodeCall(
            JfkSetup.setupForGroup, (module, IERC20(address(usdc)), CONTRIBUTION, defaultThresholds(), QUORUM, VOTING_PERIOD)
        );
        bytes memory initializer = abi.encodeCall(
            Safe.setup, (five, 3, address(setupHelper), setupData, address(0), address(0), 0, payable(address(0)))
        );
        vm.expectRevert();
        factory.createProxyWithNonce(address(singleton), initializer, 999);
    }

    function test_registrationRefusesNonsenseRules() public {
        uint16[9] memory tooLow = defaultThresholds();
        tooLow[0] = 499;
        vm.expectRevert();
        createGroupWith(members(3), tooLow, QUORUM, VOTING_PERIOD);

        vm.expectRevert();
        createGroupWith(members(3), defaultThresholds(), 0, VOTING_PERIOD);

        vm.expectRevert();
        createGroupWith(members(3), defaultThresholds(), QUORUM, 10 minutes);
    }

    function test_theSetupHelperDoesNothingWhenCalledDirectly() public {
        vm.expectRevert();
        setupHelper.setupForGroup(module, IERC20(address(usdc)), CONTRIBUTION, defaultThresholds(), QUORUM, VOTING_PERIOD);
    }

    // ---------------------------------------------------------------------
    // Contributions
    // ---------------------------------------------------------------------

    function test_aMemberPaysInAndItIsRecorded() public {
        contributeAs(safe, five[0]);
        assertEq(balanceOf(safe), CONTRIBUTION);
        assertEq(module.paidIn(safe, five[0]), CONTRIBUTION);
        assertEq(module.totalPaidIn(safe), CONTRIBUTION);
    }

    function test_onlyMembersCanPayIn() public {
        usdc.mint(outsider, CONTRIBUTION);
        vm.startPrank(outsider);
        usdc.approve(address(module), CONTRIBUTION);
        vm.expectRevert(JfkModule.NotAMember.selector);
        module.contribute(safe);
        vm.stopPrank();
    }

    function test_payingInWithoutApprovalFails() public {
        usdc.mint(five[0], CONTRIBUTION);
        vm.prank(five[0]);
        vm.expectRevert();
        module.contribute(safe);
    }

    // ---------------------------------------------------------------------
    // Proposals and voting
    // ---------------------------------------------------------------------

    function test_onlyMembersCanPropose() public {
        vm.prank(outsider);
        vm.expectRevert(JfkModule.NotAMember.selector);
        module.propose(safe, JfkModule.Action.SPEND, abi.encode(vendor, 10 * USD));
    }

    function test_aSmallSpendNeedsHalfAndABigOneTwoThirds() public {
        contributeAll(safe, five); // $250 in the pot

        uint256 small = proposeAs(five[0], safe, JfkModule.Action.SPEND, abi.encode(vendor, 50 * USD)); // 20%
        uint256 big = proposeAs(five[0], safe, JfkModule.Action.SPEND, abi.encode(vendor, 51 * USD)); // over 20%

        assertEq(module.getProposal(safe, small).thresholdPermille, 500);
        assertEq(module.getProposal(safe, big).thresholdPermille, 667);
    }

    function test_aPassedSpendPaysTheRecipientExactly() public {
        contributeAll(safe, five);
        uint256 id = proposeAs(five[0], safe, JfkModule.Action.SPEND, abi.encode(vendor, 40 * USD));

        voteYes(five, safe, id, 5);
        module.execute(safe, id);

        assertEq(usdc.balanceOf(vendor), 40 * USD);
        assertEq(balanceOf(safe), 210 * USD);
        assertEq(uint256(module.getProposal(safe, id).status), uint256(JfkModule.Status.EXECUTED));
    }

    function test_anyoneCanCarryOutAPassedProposal() public {
        contributeAll(safe, five);
        uint256 id = proposeAs(five[0], safe, JfkModule.Action.SPEND, abi.encode(vendor, 40 * USD));
        voteYes(five, safe, id, 5);

        vm.prank(outsider);
        module.execute(safe, id);
        assertEq(usdc.balanceOf(vendor), 40 * USD);
    }

    function test_aProposalCannotBeCarriedOutTwice() public {
        contributeAll(safe, five);
        uint256 id = proposeAs(five[0], safe, JfkModule.Action.SPEND, abi.encode(vendor, 40 * USD));
        voteYes(five, safe, id, 5);
        module.execute(safe, id);

        vm.expectRevert(JfkModule.ProposalNotOpen.selector);
        module.execute(safe, id);
    }

    function test_itPassesEarlyOnlyWhenTheOutstandingVotesCannotUndoIt() public {
        contributeAll(safe, five);
        uint256 id = proposeAs(five[0], safe, JfkModule.Action.SPEND, abi.encode(vendor, 40 * USD));

        // 2 yes of 5: if the other three said no it would be 40%. Not yet.
        voteYes(five, safe, id, 2);
        assertEq(uint256(module.decision(safe, id)), uint256(JfkModule.Decision.UNDECIDED));
        vm.expectRevert(JfkModule.NotApproved.selector);
        module.execute(safe, id);

        // 3 yes of 5: even if the last two say no, it stays at 60%. Settled.
        voteAs(five[2], safe, id, JfkModule.Choice.YES);
        assertEq(uint256(module.decision(safe, id)), uint256(JfkModule.Decision.APPROVED));
        module.execute(safe, id);
    }

    function test_atTheDeadlineTheVotesCastAreFinal() public {
        contributeAll(safe, five);
        uint256 id = proposeAs(five[0], safe, JfkModule.Action.SPEND, abi.encode(vendor, 40 * USD));

        // 2 yes, 1 no, 2 silent: 67% approval, 60% turnout. Passes at the deadline.
        voteYes(five, safe, id, 2);
        voteAs(five[2], safe, id, JfkModule.Choice.NO);
        assertEq(uint256(module.decision(safe, id)), uint256(JfkModule.Decision.UNDECIDED));

        vm.warp(block.timestamp + VOTING_PERIOD);
        assertEq(uint256(module.decision(safe, id)), uint256(JfkModule.Decision.APPROVED));
        module.execute(safe, id);
    }

    function test_itFailsWhenTooFewTakePart() public {
        contributeAll(safe, five);
        uint256 id = proposeAs(five[0], safe, JfkModule.Action.SPEND, abi.encode(vendor, 40 * USD));

        // 2 of 5 voted: 40% turnout, under the 60% rule.
        voteYes(five, safe, id, 2);
        vm.warp(block.timestamp + VOTING_PERIOD);
        assertEq(uint256(module.decision(safe, id)), uint256(JfkModule.Decision.REJECTED));
        vm.expectRevert(JfkModule.NotApproved.selector);
        module.execute(safe, id);
    }

    function test_notSureCountsTowardTurnoutButNotTheVote() public {
        contributeAll(safe, five);
        uint256 id = proposeAs(five[0], safe, JfkModule.Action.SPEND, abi.encode(vendor, 40 * USD));

        voteAs(five[0], safe, id, JfkModule.Choice.YES);
        voteAs(five[1], safe, id, JfkModule.Choice.ABSTAIN);
        voteAs(five[2], safe, id, JfkModule.Choice.ABSTAIN);
        vm.warp(block.timestamp + VOTING_PERIOD);

        // 1 yes, 0 no: 100% approval; 3 of 5 took part: 60% turnout.
        assertEq(uint256(module.decision(safe, id)), uint256(JfkModule.Decision.APPROVED));
    }

    function test_itIsCalledEarlyWhenItCanNoLongerPass() public {
        contributeAll(safe, five);
        uint256 id = proposeAs(five[0], safe, JfkModule.Action.SPEND, abi.encode(vendor, 40 * USD));

        voteAs(five[0], safe, id, JfkModule.Choice.NO);
        voteAs(five[1], safe, id, JfkModule.Choice.NO);
        voteAs(five[2], safe, id, JfkModule.Choice.NO);
        // Best case now: 2 yes, 3 no = 40%, under half.
        assertEq(uint256(module.decision(safe, id)), uint256(JfkModule.Decision.REJECTED));
    }

    function test_votingRules() public {
        contributeAll(safe, five);
        uint256 id = proposeAs(five[0], safe, JfkModule.Action.SPEND, abi.encode(vendor, 40 * USD));

        vm.prank(outsider);
        vm.expectRevert(JfkModule.NotEligible.selector);
        module.vote(safe, id, JfkModule.Choice.YES);

        voteAs(five[0], safe, id, JfkModule.Choice.YES);
        vm.prank(five[0]);
        vm.expectRevert(JfkModule.AlreadyVoted.selector);
        module.vote(safe, id, JfkModule.Choice.NO);

        vm.prank(five[1]);
        vm.expectRevert(JfkModule.InvalidChoice.selector);
        module.vote(safe, id, JfkModule.Choice.NONE);

        vm.warp(block.timestamp + VOTING_PERIOD);
        vm.prank(five[1]);
        vm.expectRevert(JfkModule.VotingClosed.selector);
        module.vote(safe, id, JfkModule.Choice.YES);
    }

    function test_someoneWhoJoinsMidVoteCannotVoteOnIt() public {
        contributeAll(safe, five);
        uint256 spend = proposeAs(five[0], safe, JfkModule.Action.SPEND, abi.encode(vendor, 40 * USD));

        address newcomer = makeAddr("newcomer");
        uint256 add = proposeAs(five[0], safe, JfkModule.Action.ADD_MEMBER, abi.encode(newcomer));
        voteYes(five, safe, add, 5);
        module.execute(safe, add);

        vm.prank(newcomer);
        vm.expectRevert(JfkModule.NotEligible.selector);
        module.vote(safe, spend, JfkModule.Choice.YES);
    }

    function test_someoneWhoLeavesMidVoteLosesTheirVoice() public {
        contributeAll(safe, five);
        uint256 id = proposeAs(five[0], safe, JfkModule.Action.SPEND, abi.encode(vendor, 40 * USD));

        vm.prank(five[4]);
        module.leave(safe);

        vm.prank(five[4]);
        vm.expectRevert(JfkModule.NotAMember.selector);
        module.vote(safe, id, JfkModule.Choice.YES);
    }

    function test_aShortPotRevertsAndTheProposalStaysOpen() public {
        contributeAs(safe, five[0]); // $50
        uint256 id = proposeAs(five[0], safe, JfkModule.Action.SPEND, abi.encode(vendor, 100 * USD));
        voteYes(five, safe, id, 5);

        vm.expectRevert(JfkModule.InsufficientFunds.selector);
        module.execute(safe, id);
        assertEq(uint256(module.getProposal(safe, id).status), uint256(JfkModule.Status.OPEN));

        contributeAs(safe, five[1]); // now $100
        module.execute(safe, id);
        assertEq(usdc.balanceOf(vendor), 100 * USD);
    }

    function test_proposalsThatMakeNoSenseAreRefused() public {
        vm.startPrank(five[0]);
        vm.expectRevert(JfkModule.InvalidAmount.selector);
        module.propose(safe, JfkModule.Action.SPEND, abi.encode(vendor, 0));
        vm.expectRevert(JfkModule.InvalidAddress.selector);
        module.propose(safe, JfkModule.Action.SPEND, abi.encode(safe, 1));
        vm.expectRevert(JfkModule.AlreadyAMember.selector);
        module.propose(safe, JfkModule.Action.ADD_MEMBER, abi.encode(five[1]));
        vm.expectRevert(JfkModule.NotAMember.selector);
        module.propose(safe, JfkModule.Action.REMOVE_MEMBER, abi.encode(outsider));
        vm.expectRevert(JfkModule.InvalidAmount.selector);
        module.propose(safe, JfkModule.Action.CHANGE_CONTRIBUTION, abi.encode(uint256(0)));
        vm.stopPrank();
    }

    // ---------------------------------------------------------------------
    // Membership
    // ---------------------------------------------------------------------

    function test_addingAMemberRaisesTheSafeThreshold() public {
        address newcomer = makeAddr("newcomer");
        uint256 id = proposeAs(five[0], safe, JfkModule.Action.ADD_MEMBER, abi.encode(newcomer));
        voteYes(five, safe, id, 5);
        module.execute(safe, id);

        assertTrue(Safe(payable(safe)).isOwner(newcomer));
        assertEq(Safe(payable(safe)).getThreshold(), 6);
    }

    function test_leavingForfeitsWhatYouPaidIn() public {
        contributeAll(safe, five); // $250

        vm.prank(five[4]);
        module.leave(safe);

        assertFalse(Safe(payable(safe)).isOwner(five[4]));
        assertEq(Safe(payable(safe)).getThreshold(), 4);
        assertEq(usdc.balanceOf(five[4]), 0, "nothing comes back");
        assertEq(balanceOf(safe), 250 * USD, "it stays with the group");
        assertEq(module.paidIn(safe, five[4]), 0);
        assertEq(module.totalPaidIn(safe), 200 * USD);
    }

    function test_theLastMemberCannotLeave() public {
        address solo = createGroup(members(1));
        vm.prank(members(1)[0]);
        vm.expectRevert(JfkModule.LastMember.selector);
        module.leave(solo);
    }

    function test_votedOutGetsBackWhatTheyPaidIn() public {
        contributeAll(safe, five); // $250, $50 each

        uint256 id = proposeAs(five[0], safe, JfkModule.Action.REMOVE_MEMBER, abi.encode(five[4]));
        voteYes(five, safe, id, 4);
        module.execute(safe, id);

        assertEq(usdc.balanceOf(five[4]), 50 * USD);
        assertEq(balanceOf(safe), 200 * USD);
        assertFalse(Safe(payable(safe)).isOwner(five[4]));
        assertEq(Safe(payable(safe)).getThreshold(), 4);
    }

    function test_votedOutSharesTheCostOfWhatTheGroupSpent() public {
        contributeAll(safe, five); // $250

        // The group spends $100, so the pot is $150: 60% of what was paid in.
        uint256 spend = proposeAs(five[0], safe, JfkModule.Action.SPEND, abi.encode(vendor, 100 * USD));
        voteYes(five, safe, spend, 5);
        module.execute(safe, spend);

        uint256 remove = proposeAs(five[0], safe, JfkModule.Action.REMOVE_MEMBER, abi.encode(five[4]));
        voteYes(five, safe, remove, 4);
        module.execute(safe, remove);

        // Their $50 carries 60% of its value: $30.
        assertEq(usdc.balanceOf(five[4]), 30 * USD);
        assertEq(balanceOf(safe), 120 * USD);
    }

    function test_aRefundIsNeverMoreThanWhatWasPaidIn() public {
        contributeAll(safe, five); // $250
        usdc.mint(safe, 1_000 * USD); // money that arrived some other way

        uint256 id = proposeAs(five[0], safe, JfkModule.Action.REMOVE_MEMBER, abi.encode(five[4]));
        voteYes(five, safe, id, 4);
        module.execute(safe, id);

        assertEq(usdc.balanceOf(five[4]), 50 * USD);
    }

    function test_replacingAWalletKeepsTheirHistory() public {
        contributeAs(safe, five[0]);
        address newWallet = makeAddr("newWallet");

        uint256 id = proposeAs(five[1], safe, JfkModule.Action.REPLACE_MEMBER, abi.encode(five[0], newWallet));
        voteYes(five, safe, id, 5);
        module.execute(safe, id);

        assertTrue(Safe(payable(safe)).isOwner(newWallet));
        assertFalse(Safe(payable(safe)).isOwner(five[0]));
        assertEq(module.paidIn(safe, newWallet), CONTRIBUTION);
        assertEq(module.paidIn(safe, five[0]), 0);
        assertEq(Safe(payable(safe)).getThreshold(), 5);
    }

    // ---------------------------------------------------------------------
    // Changing the rules
    // ---------------------------------------------------------------------

    function test_changingTheContributionNeedsAVote() public {
        uint256 id = proposeAs(five[0], safe, JfkModule.Action.CHANGE_CONTRIBUTION, abi.encode(75 * USD));
        voteYes(five, safe, id, 5);
        module.execute(safe, id);

        (, uint256 contribution,,,,,) = module.getGroup(safe);
        assertEq(contribution, 75 * USD);
    }

    function test_changingTheRulesAppliesToLaterVotesOnly() public {
        contributeAll(safe, five);
        uint256 before = proposeAs(five[0], safe, JfkModule.Action.SPEND, abi.encode(vendor, 10 * USD));

        uint16[9] memory strict = defaultThresholds();
        strict[uint256(JfkModule.Rule.SPEND_SMALL)] = 1000;
        uint256 change =
            proposeAs(five[0], safe, JfkModule.Action.CHANGE_RULES, abi.encode(strict, uint8(100), uint32(7 days)));
        voteYes(five, safe, change, 5);
        module.execute(safe, change);

        assertEq(module.getProposal(safe, before).thresholdPermille, 500, "goalposts don't move mid-vote");
        uint256 later = proposeAs(five[0], safe, JfkModule.Action.SPEND, abi.encode(vendor, 10 * USD));
        assertEq(module.getProposal(safe, later).thresholdPermille, 1000);
        assertEq(module.getProposal(safe, later).quorumPct, 100);
    }

    // ---------------------------------------------------------------------
    // Closing the group
    // ---------------------------------------------------------------------

    function test_closingSplitsThePotByWhatEachPaidIn() public {
        address[] memory three = members(3);
        address g = createGroup(three);
        contributeAs(g, three[0]);
        contributeAs(g, three[0]);
        contributeAs(g, three[1]); // paid in: 100, 50, 0

        uint256 id = proposeAs(three[0], g, JfkModule.Action.CLOSE_GROUP, "");
        voteYes(three, g, id, 3);
        module.execute(g, id);

        assertEq(usdc.balanceOf(three[0]), 100 * USD);
        assertEq(usdc.balanceOf(three[1]), 50 * USD);
        assertEq(usdc.balanceOf(three[2]), 0);
        assertEq(balanceOf(g), 0);
    }

    function test_closingLeavesExactlyNothingBehind() public {
        address[] memory three = members(3);
        address g = createGroup(three);
        contributeAll(g, three); // $150
        usdc.mint(g, 1); // one base unit that can't split three ways

        uint256 id = proposeAs(three[0], g, JfkModule.Action.CLOSE_GROUP, "");
        voteYes(three, g, id, 3);
        module.execute(g, id);

        assertEq(balanceOf(g), 0);
        assertEq(usdc.balanceOf(three[0]) + usdc.balanceOf(three[1]) + usdc.balanceOf(three[2]), 150 * USD + 1);
    }

    function test_aClosedGroupAcceptsNothingMore() public {
        uint256 id = proposeAs(five[0], safe, JfkModule.Action.CLOSE_GROUP, "");
        voteYes(five, safe, id, 5);
        module.execute(safe, id);

        vm.prank(five[0]);
        vm.expectRevert(JfkModule.GroupIsClosed.selector);
        module.propose(safe, JfkModule.Action.SPEND, abi.encode(vendor, 1));

        usdc.mint(five[0], CONTRIBUTION);
        vm.startPrank(five[0]);
        usdc.approve(address(module), CONTRIBUTION);
        vm.expectRevert(JfkModule.GroupIsClosed.selector);
        module.contribute(safe);
        vm.stopPrank();
    }

    // ---------------------------------------------------------------------
    // Moving to a new module version
    // ---------------------------------------------------------------------

    function test_migratingSwapsModulesWithoutTouchingTheMoney() public {
        contributeAll(safe, five);
        JfkModule next = new JfkModule();

        uint256 id = proposeAs(five[0], safe, JfkModule.Action.MIGRATE_MODULE, abi.encode(address(next)));
        voteYes(five, safe, id, 5);
        module.execute(safe, id);

        assertTrue(Safe(payable(safe)).isModuleEnabled(address(next)));
        assertFalse(Safe(payable(safe)).isModuleEnabled(address(module)));
        assertEq(balanceOf(safe), 250 * USD);

        vm.prank(five[0]);
        vm.expectRevert(JfkModule.GroupIsClosed.selector);
        module.propose(safe, JfkModule.Action.SPEND, abi.encode(vendor, 1));
    }

    // ---------------------------------------------------------------------
    // The emergency exit
    // ---------------------------------------------------------------------

    function test_directSigningNeedsEveryMember() public {
        (address[] memory owners, uint256[] memory keys) = membersWithKeys(3);
        address g = createGroup(owners);
        contributeAll(g, owners);

        bytes memory transfer = abi.encodeCall(IERC20.transfer, (vendor, 150 * USD));
        bytes32 txHash = Safe(payable(g)).getTransactionHash(
            address(usdc), 0, transfer, Enum.Operation.Call, 0, 0, 0, address(0), address(0), 0
        );

        // Two of three is not enough, whatever they sign.
        bytes memory two = signatures(txHash, owners, keys, 2);
        vm.expectRevert(bytes("GS020"));
        Safe(payable(g)).execTransaction(
            address(usdc), 0, transfer, Enum.Operation.Call, 0, 0, 0, address(0), payable(address(0)), two
        );

        // All three together can always recover the money, without JFK.
        bytes memory all = signatures(txHash, owners, keys, 3);
        Safe(payable(g)).execTransaction(
            address(usdc), 0, transfer, Enum.Operation.Call, 0, 0, 0, address(0), payable(address(0)), all
        );
        assertEq(usdc.balanceOf(vendor), 150 * USD);
    }

    // ---------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------

    function membersWithKeys(uint256 count) internal returns (address[] memory list, uint256[] memory keys) {
        list = new address[](count);
        keys = new uint256[](count);
        for (uint256 i = 0; i < count; i++) {
            (list[i], keys[i]) = makeAddrAndKey(string.concat("keyed", vm.toString(i)));
        }
        // Safe wants signatures ordered by signer address.
        for (uint256 i = 0; i < count; i++) {
            for (uint256 j = i + 1; j < count; j++) {
                if (list[j] < list[i]) {
                    (list[i], list[j]) = (list[j], list[i]);
                    (keys[i], keys[j]) = (keys[j], keys[i]);
                }
            }
        }
    }

    function signatures(bytes32 txHash, address[] memory list, uint256[] memory keys, uint256 count)
        internal
        pure
        returns (bytes memory sigs)
    {
        list; // signers are already sorted by address
        for (uint256 i = 0; i < count; i++) {
            (uint8 v, bytes32 r, bytes32 s) = vm.sign(keys[i], txHash);
            sigs = abi.encodePacked(sigs, r, s, v);
        }
    }
}
