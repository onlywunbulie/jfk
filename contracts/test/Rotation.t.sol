// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Safe} from "@safe/Safe.sol";
import {JfkModule} from "../src/JfkModule.sol";
import {JfkSetup} from "../src/JfkSetup.sol";
import {RotationLib} from "../src/RotationLib.sol";
import {JfkBase} from "./JfkBase.sol";

/**
 * Rotating savings, rule by rule, as the group agreed them (see RotationLib):
 * the turn holder gets what came in; misses become public debts owed to
 * whoever was short; miss before your turn and you go to the back; your
 * automatic dues stay on after your turn; cycles roll on by themselves.
 */
contract RotationTest is JfkBase {
    uint32 internal constant ROUND = 28 days;
    uint32 internal constant GRACE = 3 days;

    address[] internal people;
    address internal safe;

    function setUp() public override {
        super.setUp();
        people = members(4);
        safe = createRotating(people);
    }

    function createRotating(address[] memory owners) internal returns (address) {
        bytes memory setupData = abi.encodeCall(
            JfkSetup.setupForRotatingGroup,
            (
                module,
                IERC20(address(usdc)),
                CONTRIBUTION,
                defaultThresholds(),
                QUORUM,
                VOTING_PERIOD,
                PAY_GAP,
                ROUND,
                GRACE,
                uint64(block.timestamp + ROUND)
            )
        );
        bytes memory initializer = abi.encodeCall(
            Safe.setup,
            (owners, owners.length, address(setupHelper), setupData, address(0), address(0), 0, payable(address(0)))
        );
        return address(factory.createProxyWithNonce(address(singleton), initializer, uint256(keccak256("rotating"))));
    }

    function order() internal view returns (address[] memory list) {
        (list,) = module.getOrder(safe);
    }

    function dueNow() internal {
        (,,,, uint64 next,,,,) = module.getRotation(safe);
        if (block.timestamp < next) vm.warp(next);
    }

    function everyonePays() internal {
        address[] memory list = order();
        for (uint256 i = 0; i < list.length; i++) {
            (, bool paid,,) = module.rotationStatus(safe, list[i]);
            if (!paid) contributeAs(safe, list[i]);
        }
    }

    // --- the basics -------------------------------------------------------

    function test_firstOrderIsTheSafesOwnersInOrder() public view {
        address[] memory list = order();
        assertEq(list.length, 4);
        for (uint256 i = 0; i < 4; i++) {
            assertEq(list[i], people[i]);
        }
    }

    function test_fullRoundPaysTheWholePotToTheTurnHolder() public {
        contributeAll(safe, people);
        dueNow();
        module.payTurn(safe);
        assertEq(usdc.balanceOf(people[0]), 4 * CONTRIBUTION);
        assertEq(balanceOf(safe), 0);
    }

    function test_anyoneCanTriggerAPayoutButItOnlyGoesToTheHolder() public {
        contributeAll(safe, people);
        dueNow();
        address stranger = makeAddr("stranger");
        vm.prank(stranger);
        module.payTurn(safe);
        assertEq(usdc.balanceOf(stranger), 0);
        assertEq(usdc.balanceOf(people[0]), 4 * CONTRIBUTION);
    }

    function test_notBeforeItsDue() public {
        contributeAll(safe, people);
        vm.expectRevert(RotationLib.NotDueYet.selector);
        module.payTurn(safe);
    }

    function test_aLatePayerGetsTheGracePeriodBeforeDebtStarts() public {
        contributeAs(safe, people[0]);
        contributeAs(safe, people[1]);
        contributeAs(safe, people[2]);
        dueNow();
        vm.expectRevert(RotationLib.NotDueYet.selector);
        module.payTurn(safe);

        // Pays within the grace period: a full pot, no debt.
        contributeAs(safe, people[3]);
        module.payTurn(safe);
        assertEq(usdc.balanceOf(people[0]), 4 * CONTRIBUTION);
        assertEq(module.debtOf(safe, people[3]), 0);
    }

    function test_cantPayTwiceForOneRound() public {
        contributeAs(safe, people[1]);
        usdc.mint(people[1], CONTRIBUTION);
        vm.startPrank(people[1]);
        usdc.approve(address(module), CONTRIBUTION);
        vm.expectRevert(RotationLib.AlreadyPaid.selector);
        module.contribute(safe);
        vm.stopPrank();
    }

    function test_spendingIsntAllowedInARotatingGroup() public {
        vm.expectRevert(JfkModule.NotForRotatingGroups.selector);
        proposeAs(people[0], safe, JfkModule.Action.SPEND, abi.encode(people[1], CONTRIBUTION));
    }

    // --- rule 1 and 2: pay what's in, misses become debts ---------------

    function test_aMissPaysWhatsInAndRecordsThePublicDebt() public {
        contributeAs(safe, people[0]);
        contributeAs(safe, people[1]);
        contributeAs(safe, people[2]);
        dueNow();
        vm.warp(block.timestamp + GRACE);
        module.payTurn(safe);

        assertEq(usdc.balanceOf(people[0]), 3 * CONTRIBUTION, "what came in");
        assertEq(module.debtOf(safe, people[3]), CONTRIBUTION, "the miss is owed");
        assertEq(module.totalShort(safe), CONTRIBUTION, "and owed to the holder");
    }

    function test_aDebtorsPaymentGoesStraightToWhoeverWasShort() public {
        test_aMissPaysWhatsInAndRecordsThePublicDebt();
        uint256 before = usdc.balanceOf(people[0]);
        contributeAs(safe, people[3]);

        assertEq(usdc.balanceOf(people[0]) - before, CONTRIBUTION, "the short holder is made whole");
        assertEq(module.debtOf(safe, people[3]), 0);
        assertEq(module.totalShort(safe), 0);
        (, bool paid,,) = module.rotationStatus(safe, people[3]);
        assertFalse(paid, "settling a debt isn't this round's dues");
    }

    function test_aFriendCanCoverADebt() public {
        test_aMissPaysWhatsInAndRecordsThePublicDebt();
        address friend = makeAddr("friend");
        usdc.mint(friend, CONTRIBUTION);
        vm.startPrank(friend);
        usdc.approve(address(module), CONTRIBUTION);
        module.coverDebt(safe, people[3], CONTRIBUTION);
        vm.stopPrank();
        assertEq(module.debtOf(safe, people[3]), 0);
        assertEq(usdc.balanceOf(people[0]), 4 * CONTRIBUTION);
    }

    function test_cantCoverMoreThanIsOwed() public {
        test_aMissPaysWhatsInAndRecordsThePublicDebt();
        address friend = makeAddr("friend");
        usdc.mint(friend, 2 * CONTRIBUTION);
        vm.startPrank(friend);
        usdc.approve(address(module), 2 * CONTRIBUTION);
        vm.expectRevert(RotationLib.NoDebt.selector);
        module.coverDebt(safe, people[3], 2 * CONTRIBUTION);
        vm.stopPrank();
    }

    // --- rule 3: miss before your turn and you go to the back -----------

    function test_missingBeforeYourTurnMovesYouToTheBack() public {
        // people[1] is second in line, and misses round 1.
        contributeAs(safe, people[0]);
        contributeAs(safe, people[2]);
        contributeAs(safe, people[3]);
        dueNow();
        vm.warp(block.timestamp + GRACE);
        module.payTurn(safe);

        address[] memory list = order();
        assertEq(list[1], people[2], "the next in line moves up");
        assertEq(list[3], people[1], "the one who missed collects last");
    }

    function test_atYourTurnWhatYouOweComesOutOfYourPot() public {
        // people[0] misses round 1, which is their own turn.
        contributeAs(safe, people[1]);
        contributeAs(safe, people[2]);
        contributeAs(safe, people[3]);
        dueNow();
        vm.warp(block.timestamp + GRACE);
        module.payTurn(safe);

        // They get what the others paid, and owe nothing: they simply didn't pay themselves.
        assertEq(usdc.balanceOf(people[0]), 3 * CONTRIBUTION);
        assertEq(module.debtOf(safe, people[0]), 0);
        assertEq(module.totalShort(safe), 0);
    }

    // --- rule 4: automatic dues stay on after your turn -----------------

    function test_afterYourTurnYouCantSwitchOffAutomaticDues() public {
        // Read the power first: a prank only covers the very next call.
        uint8 collectPower = module.POWER_COLLECT();
        vm.prank(people[0]);
        module.setHelper(safe, makeAddr("rallied"), collectPower, uint64(block.timestamp + 300 days));
        contributeAll(safe, people);
        dueNow();
        module.payTurn(safe);

        vm.startPrank(people[0]);
        vm.expectRevert(JfkModule.HelperLocked.selector);
        module.revokeHelper(safe);
        uint8 votePower = module.POWER_VOTE();
        vm.expectRevert(JfkModule.HelperLocked.selector);
        module.setHelper(safe, makeAddr("rallied"), votePower, uint64(block.timestamp + 300 days));
        vm.stopPrank();
    }

    function test_beforeYourTurnYouCanSwitchThemOff() public {
        uint8 collectPower = module.POWER_COLLECT();
        vm.startPrank(people[1]);
        module.setHelper(safe, makeAddr("rallied"), collectPower, uint64(block.timestamp + 300 days));
        module.revokeHelper(safe);
        vm.stopPrank();
    }

    // --- rule 5: cycles, joining and leaving ----------------------------

    function playCycle() internal {
        for (uint256 i = 0; i < 4; i++) {
            everyonePays();
            dueNow();
            module.payTurn(safe);
        }
    }

    function test_aFullCyclePaysEveryoneOnceAndTheNextStartsBySelf() public {
        playCycle();
        for (uint256 i = 0; i < 4; i++) {
            assertEq(usdc.balanceOf(people[i]), 4 * CONTRIBUTION);
        }
        (, uint32 cycle,, uint32 turn,,,,,) = module.getRotation(safe);
        assertEq(cycle, 2);
        assertEq(turn, 0);
        assertEq(order()[0], people[0], "same order");
    }

    function test_leavingWaitsForTheEndOfTheCycle() public {
        vm.prank(people[2]);
        module.leave(safe);
        assertTrue(Safe(payable(safe)).isOwner(people[2]), "still in this cycle");
        playCycle();
        assertFalse(Safe(payable(safe)).isOwner(people[2]), "gone once it ended");
        assertEq(usdc.balanceOf(people[2]), 4 * CONTRIBUTION, "after collecting their turn");
        assertEq(order().length, 3);
    }

    function test_aNewMemberJoinsAtTheBackOfTheNextCycle() public {
        address newcomer = makeAddr("newcomer");
        uint256 id = proposeAs(people[0], safe, JfkModule.Action.ADD_MEMBER, abi.encode(newcomer));
        voteYes(people, safe, id, 4);
        module.execute(safe, id);

        // Waiting: can't pay in yet, isn't in this cycle's order.
        usdc.mint(newcomer, CONTRIBUTION);
        vm.startPrank(newcomer);
        usdc.approve(address(module), CONTRIBUTION);
        vm.expectRevert(RotationLib.NotInRotation.selector);
        module.contribute(safe);
        vm.stopPrank();

        playCycle();
        address[] memory list = order();
        assertEq(list.length, 5);
        assertEq(list[4], newcomer);
    }

    function test_someoneStillOwingStartsTheNextCycleAtTheBack() public {
        // people[0] collects in round 1, then misses round 2.
        everyonePays();
        dueNow();
        module.payTurn(safe);
        contributeAs(safe, people[1]);
        contributeAs(safe, people[2]);
        contributeAs(safe, people[3]);
        dueNow();
        vm.warp(block.timestamp + GRACE);
        module.payTurn(safe);
        assertEq(module.debtOf(safe, people[0]), CONTRIBUTION);

        // The cycle finishes; they still owe.
        for (uint256 i = 0; i < 2; i++) {
            everyonePays();
            dueNow();
            vm.warp(block.timestamp + GRACE);
            module.payTurn(safe);
        }
        address[] memory list = order();
        assertEq(list[list.length - 1], people[0], "starts the new cycle at the back");
    }

    function test_someoneOwingCanBeVotedOutAtOnceAndTheirDebtStays() public {
        test_aMissPaysWhatsInAndRecordsThePublicDebt();
        uint256 id = proposeAs(people[0], safe, JfkModule.Action.REMOVE_MEMBER, abi.encode(people[3]));
        voteYes(people, safe, id, 3);
        vm.warp(block.timestamp + VOTING_PERIOD);
        module.execute(safe, id);

        assertFalse(Safe(payable(safe)).isOwner(people[3]));
        assertEq(module.debtOf(safe, people[3]), CONTRIBUTION, "still on record");
        assertEq(order().length, 3);
    }

    function test_someoneNotOwingIsVotedOutAtTheEndOfTheCycle() public {
        uint256 id = proposeAs(people[0], safe, JfkModule.Action.REMOVE_MEMBER, abi.encode(people[3]));
        voteYes(people, safe, id, 4);
        module.execute(safe, id);
        assertTrue(Safe(payable(safe)).isOwner(people[3]), "finishes the cycle");
        playCycle();
        assertFalse(Safe(payable(safe)).isOwner(people[3]));
    }

    // --- votes on the order and the amount ------------------------------

    function test_theGroupCanVoteANewOrderForWhoStillCollects() public {
        address[] memory rest = new address[](4);
        rest[0] = people[3];
        rest[1] = people[0];
        rest[2] = people[1];
        rest[3] = people[2];
        uint256 id = proposeAs(people[0], safe, JfkModule.Action.CHANGE_ORDER, abi.encode(rest));
        voteYes(people, safe, id, 4);
        module.execute(safe, id);
        assertEq(order()[0], people[3]);
    }

    function test_aNewOrderMustBeTheSamePeople() public {
        address[] memory rest = new address[](4);
        rest[0] = people[0];
        rest[1] = people[0];
        rest[2] = people[1];
        rest[3] = people[2];
        vm.expectRevert(RotationLib.InvalidOrder.selector);
        proposeAs(people[0], safe, JfkModule.Action.CHANGE_ORDER, abi.encode(rest));
    }

    function test_aNewAmountWaitsForTheNextCycle() public {
        uint256 id = proposeAs(people[0], safe, JfkModule.Action.CHANGE_CONTRIBUTION, abi.encode(2 * CONTRIBUTION));
        voteYes(people, safe, id, 4);
        module.execute(safe, id);
        (, uint256 contribution,,,,,) = module.getGroup(safe);
        assertEq(contribution, CONTRIBUTION, "unchanged mid-cycle");
        playCycle();
        (, contribution,,,,,) = module.getGroup(safe);
        assertEq(contribution, 2 * CONTRIBUTION);
    }

    // --- closing ----------------------------------------------------------

    function test_closingMidRoundGivesThisRoundsPaymentsBack() public {
        contributeAs(safe, people[0]);
        contributeAs(safe, people[1]);
        uint256 id = proposeAs(people[0], safe, JfkModule.Action.CLOSE_GROUP, "");
        voteYes(people, safe, id, 4);
        module.execute(safe, id);
        assertEq(usdc.balanceOf(people[0]), CONTRIBUTION);
        assertEq(usdc.balanceOf(people[1]), CONTRIBUTION);
        assertEq(balanceOf(safe), 0);
    }

    // --- wallets ----------------------------------------------------------

    function test_aReplacedWalletKeepsItsPlaceAndItsDebt() public {
        test_aMissPaysWhatsInAndRecordsThePublicDebt();
        address newWallet = makeAddr("newWallet");
        uint256 id =
            proposeAs(people[0], safe, JfkModule.Action.REPLACE_MEMBER, abi.encode(people[3], newWallet));
        voteYes(people, safe, id, 4);
        vm.warp(block.timestamp + VOTING_PERIOD);
        module.execute(safe, id);
        assertEq(module.debtOf(safe, newWallet), CONTRIBUTION);
        assertEq(module.debtOf(safe, people[3]), 0);
        address[] memory list = order();
        assertEq(list[list.length - 1], newWallet);
    }
}
