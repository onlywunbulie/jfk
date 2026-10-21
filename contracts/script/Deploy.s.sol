// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {JfkModule} from "../src/JfkModule.sol";
import {JfkSetup} from "../src/JfkSetup.sol";

/**
 * Deploys the two JFK contracts. One deployment serves every group.
 *
 *   forge script script/Deploy.s.sol --rpc-url base_sepolia --account jfk-deployer --broadcast
 *
 * Nothing here is privileged afterwards: the deployer gets no special role in
 * either contract.
 */
contract Deploy is Script {
    function run() external returns (JfkModule module, JfkSetup setup) {
        vm.startBroadcast();
        module = new JfkModule();
        setup = new JfkSetup();
        vm.stopBroadcast();

        console.log("JfkModule:", address(module));
        console.log("JfkSetup: ", address(setup));
    }
}
