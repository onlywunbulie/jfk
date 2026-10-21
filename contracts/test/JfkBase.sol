// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Safe} from "@safe/Safe.sol";
import {SafeProxyFactory} from "@safe/proxies/SafeProxyFactory.sol";
import {JfkModule} from "../src/JfkModule.sol";
import {JfkSetup} from "../src/JfkSetup.sol";

/// Six decimals, like USDC. Anyone can mint: it's test money.
contract MockUSDC is ERC20 {
    constructor() ERC20("Test USD Coin", "USDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/**
 * Real Safe contracts (v1.4.1, the audited release), a real proxy factory and
 * the real module, so every test exercises exactly what runs on-chain.
 */
abstract contract JfkBase is Test {
    MockUSDC internal usdc;
    Safe internal singleton;
    SafeProxyFactory internal factory;
    JfkModule internal module;
    JfkSetup internal setupHelper;

    uint256 internal constant USD = 1e6;
    uint256 internal constant CONTRIBUTION = 50 * USD;
    uint32 internal constant VOTING_PERIOD = 3 days;
    uint8 internal constant QUORUM = 60;

    uint256 private saltNonce;

    function setUp() public virtual {
        usdc = new MockUSDC();
        singleton = new Safe();
        factory = new SafeProxyFactory();
        module = new JfkModule();
        setupHelper = new JfkSetup();
    }

    /// The defaults from BLUEPRINT-WEB3.md §6, in `JfkModule.Rule` order.
    function defaultThresholds() internal pure returns (uint16[9] memory t) {
        t[uint256(JfkModule.Rule.SPEND_SMALL)] = 500;
        t[uint256(JfkModule.Rule.SPEND_LARGE)] = 667;
        t[uint256(JfkModule.Rule.ADD_MEMBER)] = 500;
        t[uint256(JfkModule.Rule.REMOVE_MEMBER)] = 667;
        t[uint256(JfkModule.Rule.REPLACE_MEMBER)] = 750;
        t[uint256(JfkModule.Rule.CHANGE_CONTRIBUTION)] = 667;
        t[uint256(JfkModule.Rule.CHANGE_RULES)] = 750;
        t[uint256(JfkModule.Rule.CLOSE_GROUP)] = 800;
        t[uint256(JfkModule.Rule.MIGRATE_MODULE)] = 750;
    }

    function members(uint256 count) internal returns (address[] memory list) {
        list = new address[](count);
        for (uint256 i = 0; i < count; i++) {
            list[i] = makeAddr(string.concat("member", vm.toString(i)));
        }
    }

    /// A Safe with these owners, every-member threshold, and JFK's rules.
    function createGroup(address[] memory owners) internal returns (address) {
        return createGroupWith(owners, defaultThresholds(), QUORUM, VOTING_PERIOD);
    }

    function createGroupWith(address[] memory owners, uint16[9] memory thresholds, uint8 quorum, uint32 period)
        internal
        returns (address)
    {
        bytes memory setupData = abi.encodeCall(
            JfkSetup.setupForGroup, (module, IERC20(address(usdc)), CONTRIBUTION, thresholds, quorum, period)
        );
        bytes memory initializer = abi.encodeCall(
            Safe.setup,
            (owners, owners.length, address(setupHelper), setupData, address(0), address(0), 0, payable(address(0)))
        );
        return address(factory.createProxyWithNonce(address(singleton), initializer, ++saltNonce));
    }

    /// Give a member a contribution's worth of test dollars and pay it in.
    function contributeAs(address safe, address member) internal {
        usdc.mint(member, CONTRIBUTION);
        vm.startPrank(member);
        usdc.approve(address(module), CONTRIBUTION);
        module.contribute(safe);
        vm.stopPrank();
    }

    function contributeAll(address safe, address[] memory list) internal {
        for (uint256 i = 0; i < list.length; i++) {
            contributeAs(safe, list[i]);
        }
    }

    function proposeAs(address member, address safe, JfkModule.Action action, bytes memory payload)
        internal
        returns (uint256 id)
    {
        vm.prank(member);
        id = module.propose(safe, action, payload);
    }

    function voteAs(address member, address safe, uint256 id, JfkModule.Choice choice) internal {
        vm.prank(member);
        module.vote(safe, id, choice);
    }

    function voteYes(address[] memory list, address safe, uint256 id, uint256 count) internal {
        for (uint256 i = 0; i < count; i++) {
            voteAs(list[i], safe, id, JfkModule.Choice.YES);
        }
    }

    function balanceOf(address safe) internal view returns (uint256) {
        return usdc.balanceOf(safe);
    }
}
