// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {Test, console2} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Safe} from "@safe/Safe.sol";
import {JfkModule} from "../src/JfkModule.sol";
import {JfkSetup} from "../src/JfkSetup.sol";
import {JfkBase, MockUSDC} from "./JfkBase.sol";

/**
 * Drives one rotating group through random sequences of what really happens:
 * people pay or don't, time passes, payouts go out, friends cover debts,
 * people leave. It counts every dollar in and out.
 */
contract RotationHandler is Test {
    JfkModule internal module;
    MockUSDC internal usdc;
    address internal safe;
    address[] public people;

    uint256 internal constant CONTRIBUTION = 50e6;

    uint256 public payouts;
    uint256 public covers;
    address public friend = makeAddr("friend");

    constructor(JfkModule module_, MockUSDC usdc_, address safe_, address[] memory people_) {
        module = module_;
        usdc = usdc_;
        safe = safe_;
        people = people_;
    }

    function pay(uint256 who) external {
        address member = people[who % people.length];
        usdc.mint(member, CONTRIBUTION);
        vm.startPrank(member);
        usdc.approve(address(module), CONTRIBUTION);
        try module.contribute(safe) {} catch {}
        vm.stopPrank();
    }

    function wait(uint256 hoursAhead) external {
        vm.warp(block.timestamp + bound(hoursAhead, 1, 40 days / 1 hours) * 1 hours);
    }

    function payTurn() external {
        try module.payTurn(safe) {
            payouts++;
        } catch {}
    }

    function cover(uint256 who) external {
        address debtor = people[who % people.length];
        uint256 owed = module.debtOf(safe, debtor);
        if (owed == 0) return;
        usdc.mint(friend, owed);
        vm.startPrank(friend);
        usdc.approve(address(module), owed);
        module.coverDebt(safe, debtor, owed);
        vm.stopPrank();
        covers++;
    }

    function leave(uint256 who) external {
        address member = people[who % people.length];
        vm.prank(member);
        try module.leave(safe) {} catch {}
    }
}

contract RotationInvariantTest is JfkBase {
    RotationHandler internal handler;
    address internal safe;
    address[] internal people;

    function setUp() public override {
        super.setUp();
        people = members(4);
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
                uint32(28 days),
                uint32(3 days),
                uint64(block.timestamp + 28 days)
            )
        );
        bytes memory initializer = abi.encodeCall(
            Safe.setup,
            (people, people.length, address(setupHelper), setupData, address(0), address(0), 0, payable(address(0)))
        );
        safe = address(factory.createProxyWithNonce(address(singleton), initializer, 1));

        handler = new RotationHandler(module, usdc, safe, people);
        targetContract(address(handler));
    }

    /// Shows each run reached real payouts and debts, so passing means something.
    function afterInvariant() external view {
        console2.log("payouts", handler.payouts(), "debts covered", handler.covers());
    }

    /// Money owed is always owed to someone: every debt matches a shortfall.
    function invariant_debtsEqualWhatIsOwed() public view {
        uint256 debts;
        for (uint256 i = 0; i < people.length; i++) {
            debts += module.debtOf(safe, people[i]);
        }
        assertEq(debts, module.totalShort(safe));
    }

    /// Between payouts, the vault holds exactly this round's payments: nothing more, nothing less.
    function invariant_theVaultHoldsOnlyThisRound() public view {
        (,,,,,,, uint256 roundPot,) = module.getRotation(safe);
        assertEq(usdc.balanceOf(safe), roundPot);
    }

    /**
     * Every dollar is accounted for: it's with a member, the friend who
     * covers debts, or the vault. Never the module, never anyone else.
     */
    function invariant_moneyNeverGoesAnywhereElse() public view {
        uint256 held = usdc.balanceOf(safe) + usdc.balanceOf(handler.friend());
        for (uint256 i = 0; i < people.length; i++) {
            held += usdc.balanceOf(people[i]);
        }
        assertEq(held, usdc.totalSupply());
        assertEq(usdc.balanceOf(address(module)), 0);
    }
}
