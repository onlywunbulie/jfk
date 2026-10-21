// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Safe} from "@safe/Safe.sol";
import {JfkModule} from "../src/JfkModule.sol";
import {JfkBase, MockUSDC} from "./JfkBase.sol";

/**
 * Drives one group through random sequences of everything members can do:
 * pay in, propose, vote, wait, carry out, leave. It records every dollar in
 * and every dollar out, and flags any money that moves when it shouldn't.
 */
contract GroupHandler is Test {
    JfkModule internal module;
    MockUSDC internal usdc;
    address internal safe;
    address[] internal people;

    uint256 internal constant CONTRIBUTION = 50e6;
    uint256 internal constant VOTING_PERIOD = 3 days;

    // Ghost accounting.
    uint256 public moneyIn;
    uint256 public moneyOut;
    uint256 public outFromSpends;
    uint256 public outFromRefunds;
    uint256 public outFromClosing;
    bool public moneyMovedWithoutAVote;
    bool public spendPaidWrongAmount;
    bool public refundExceededPaidIn;

    uint256[] internal openIds;

    constructor(JfkModule module_, MockUSDC usdc_, address safe_, address[] memory people_) {
        module = module_;
        usdc = usdc_;
        safe = safe_;
        people = people_;
    }

    // --- actions the fuzzer can take -------------------------------------

    function contribute(uint256 who) external {
        address member = _member(who);
        if (member == address(0) || _closed()) return;
        usdc.mint(member, CONTRIBUTION);
        vm.startPrank(member);
        usdc.approve(address(module), CONTRIBUTION);
        uint256 before = _balance();
        module.contribute(safe);
        vm.stopPrank();
        moneyIn += _balance() - before;
    }

    function proposeSpend(uint256 who, uint256 amount) external {
        address member = _member(who);
        if (member == address(0) || _closed()) return;
        amount = bound(amount, 1, 1_000e6);
        vm.prank(member);
        try module.propose(safe, JfkModule.Action.SPEND, abi.encode(makeAddr("vendor"), amount)) returns (uint256 id) {
            openIds.push(id);
        } catch {}
    }

    function proposeRemoval(uint256 who, uint256 target) external {
        address member = _member(who);
        address victim = _member(target);
        if (member == address(0) || victim == address(0) || _closed()) return;
        vm.prank(member);
        try module.propose(safe, JfkModule.Action.REMOVE_MEMBER, abi.encode(victim)) returns (uint256 id) {
            openIds.push(id);
        } catch {}
    }

    function proposeClose(uint256 who) external {
        address member = _member(who);
        if (member == address(0) || _closed()) return;
        vm.prank(member);
        try module.propose(safe, JfkModule.Action.CLOSE_GROUP, "") returns (uint256 id) {
            openIds.push(id);
        } catch {}
    }

    function vote(uint256 who, uint256 pick, uint8 choice) external {
        if (openIds.length == 0) return;
        address member = _anyone(who);
        uint256 id = openIds[pick % openIds.length];
        JfkModule.Choice c = JfkModule.Choice((choice % 3) + 1);
        uint256 before = _balance();
        vm.prank(member);
        try module.vote(safe, id, c) {} catch {}
        if (_balance() != before) moneyMovedWithoutAVote = true;
    }

    /**
     * The whole group agrees. Random single votes alone almost never get a
     * proposal over the line, which would leave the money-moving paths
     * untested; this makes approvals common enough to exercise them.
     */
    function everyoneSaysYes(uint256 pick) external {
        if (openIds.length == 0) return;
        uint256 id = openIds[pick % openIds.length];
        address[] memory owners = Safe(payable(safe)).getOwners();
        uint256 before = _balance();
        for (uint256 i = 0; i < owners.length; i++) {
            vm.prank(owners[i]);
            try module.vote(safe, id, JfkModule.Choice.YES) {} catch {}
        }
        if (_balance() != before) moneyMovedWithoutAVote = true;
    }

    function wait(uint256 secondsAhead) external {
        vm.warp(block.timestamp + bound(secondsAhead, 1 hours, VOTING_PERIOD));
    }

    function leave(uint256 who) external {
        address member = _member(who);
        if (member == address(0)) return;
        uint256 before = _balance();
        vm.prank(member);
        try module.leave(safe) {} catch {}
        if (_balance() != before) moneyMovedWithoutAVote = true;
    }

    function execute(uint256 pick) external {
        if (openIds.length == 0) return;
        uint256 id = openIds[pick % openIds.length];
        JfkModule.Proposal memory p = module.getProposal(safe, id);

        uint256 before = _balance();
        uint256 expectedRefund;
        uint256 victimPaidIn;
        if (p.action == JfkModule.Action.REMOVE_MEMBER) {
            address victim = abi.decode(p.payload, (address));
            expectedRefund = module.refundFor(safe, victim);
            victimPaidIn = module.paidIn(safe, victim);
        }

        try module.execute(safe, id) {
            uint256 out = before - _balance();
            moneyOut += out;
            if (p.action == JfkModule.Action.SPEND) {
                outFromSpends += out;
                (, uint256 amount) = abi.decode(p.payload, (address, uint256));
                if (out != amount) spendPaidWrongAmount = true;
            } else if (p.action == JfkModule.Action.REMOVE_MEMBER) {
                outFromRefunds += out;
                if (out != expectedRefund || out > victimPaidIn) refundExceededPaidIn = true;
            } else if (p.action == JfkModule.Action.CLOSE_GROUP) {
                outFromClosing += out;
            }
        } catch {
            // A refused execution must not move anything.
            if (_balance() != before) moneyMovedWithoutAVote = true;
        }
    }

    /// Someone who isn't in the group pokes at everything.
    function outsiderTriesEverything(uint256 pick) external {
        address outsider = makeAddr("outsider");
        uint256 before = _balance();
        vm.startPrank(outsider);
        try module.contribute(safe) {} catch {}
        try module.leave(safe) {} catch {}
        try module.propose(safe, JfkModule.Action.SPEND, abi.encode(outsider, uint256(1))) {} catch {}
        if (openIds.length > 0) {
            try module.vote(safe, openIds[pick % openIds.length], JfkModule.Choice.YES) {} catch {}
        }
        vm.stopPrank();
        if (_balance() != before) moneyMovedWithoutAVote = true;
    }

    // --- helpers ----------------------------------------------------------

    function _member(uint256 seed) internal view returns (address) {
        address[] memory owners = Safe(payable(safe)).getOwners();
        if (owners.length == 0) return address(0);
        return owners[seed % owners.length];
    }

    function _anyone(uint256 seed) internal view returns (address) {
        return people[seed % people.length];
    }

    function _closed() internal view returns (bool closed) {
        (,,,, closed,,) = module.getGroup(safe);
    }

    function _balance() internal view returns (uint256) {
        return usdc.balanceOf(safe);
    }
}

contract MoneyInvariantTest is JfkBase {
    GroupHandler internal handler;
    address internal safe;

    function setUp() public override {
        super.setUp();
        address[] memory people = members(6);
        safe = createGroup(people);
        handler = new GroupHandler(module, usdc, safe, people);
        targetContract(address(handler));
    }

    /// Every dollar is accounted for: the pot is what came in minus what went out.
    function invariant_thePotIsExactlyInMinusOut() public view {
        assertEq(usdc.balanceOf(safe), handler.moneyIn() - handler.moneyOut());
    }

    /// Money leaves only three ways: an approved spend, a refund, or closing.
    function invariant_moneyOnlyLeavesThreeWays() public view {
        assertEq(handler.moneyOut(), handler.outFromSpends() + handler.outFromRefunds() + handler.outFromClosing());
        assertFalse(handler.moneyMovedWithoutAVote());
    }

    function invariant_aSpendPaysExactlyWhatWasApproved() public view {
        assertFalse(handler.spendPaidWrongAmount());
    }

    function invariant_aRefundNeverExceedsWhatWasPaidIn() public view {
        assertFalse(handler.refundExceededPaidIn());
    }

    /// The emergency exit always needs every member.
    function invariant_directSigningNeedsEveryone() public view {
        Safe s = Safe(payable(safe));
        assertEq(s.getThreshold(), s.getOwners().length);
    }

    /// What members are recorded as having paid in never exceeds the pot's
    /// total takings, so refunds and the closing split are always backed.
    function invariant_paidInIsBackedByWhatCameIn() public view {
        assertLe(module.totalPaidIn(safe), handler.moneyIn());
    }
}
