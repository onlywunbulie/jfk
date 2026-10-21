// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Safe} from "@safe/Safe.sol";
import {SafeProxyFactory} from "@safe/proxies/SafeProxyFactory.sol";
import {JfkModule} from "../src/JfkModule.sol";
import {JfkSetup} from "../src/JfkSetup.sol";

/**
 * End-to-end check on a live network: create a one-person group on the real
 * Safe deployment, pay in $1 of test USDC, propose sending $0.50 back to
 * yourself, vote yes, and carry it out.
 *
 *   JFK_MODULE=0x... JFK_SETUP=0x... \
 *   forge script script/DemoGroup.s.sol --rpc-url base_sepolia --account jfk-deployer --broadcast
 *
 * Needs a little test ETH for fees and at least $1 of Circle's test USDC in
 * the deployer wallet.
 */
contract DemoGroup is Script {
    // Safe v1.4.1 canonical deployments (same address on every chain) and
    // Circle's USDC on Base Sepolia.
    address internal constant SAFE_L2_SINGLETON = 0x29fcB43b46531BcA003ddC8FCB67FFE91900C762;
    address internal constant SAFE_PROXY_FACTORY = 0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67;
    address internal constant USDC = 0x036CbD53842c5426634e7929541eC2318f3dCF7e;

    uint256 internal constant ONE_DOLLAR = 1e6;

    function run() external {
        JfkModule module = JfkModule(vm.envAddress("JFK_MODULE"));
        JfkSetup setup = JfkSetup(vm.envAddress("JFK_SETUP"));

        vm.startBroadcast();
        // The account broadcasting (from --account), whichever context runs this.
        (, address me,) = vm.readCallers();

        address[] memory owners = new address[](1);
        owners[0] = me;

        uint16[9] memory thresholds = [uint16(500), 667, 500, 667, 750, 667, 750, 800, 750];
        bytes memory setupData = abi.encodeCall(
            JfkSetup.setupForGroup, (module, IERC20(USDC), ONE_DOLLAR, thresholds, uint8(60), uint32(1 hours))
        );
        bytes memory initializer = abi.encodeCall(
            Safe.setup, (owners, 1, address(setup), setupData, address(0), address(0), 0, payable(address(0)))
        );
        address safe = address(
            SafeProxyFactory(SAFE_PROXY_FACTORY).createProxyWithNonce(SAFE_L2_SINGLETON, initializer, block.timestamp)
        );

        IERC20(USDC).approve(address(module), ONE_DOLLAR);
        module.contribute(safe);

        uint256 id = module.propose(safe, JfkModule.Action.SPEND, abi.encode(me, ONE_DOLLAR / 2));
        module.vote(safe, id, JfkModule.Choice.YES);
        module.execute(safe, id);

        vm.stopBroadcast();

        console.log("Group Safe:", safe);
        console.log("Pot after the spend (USDC base units):", IERC20(USDC).balanceOf(safe));
    }
}
