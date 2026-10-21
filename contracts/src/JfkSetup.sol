// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ISafe} from "./interfaces/ISafe.sol";
import {JfkModule} from "./JfkModule.sol";

/**
 * @title JfkSetup
 * @notice Turns a freshly created Safe into a JFK group in the same
 *         transaction that creates it.
 *
 * `Safe.setup` delegatecalls `setupForGroup`, so inside it `address(this)` is
 * the new Safe. Calling the Safe from there satisfies its `authorized` check
 * for enabling a module, and makes the Safe the caller of `registerGroup`.
 * A group therefore never exists, even briefly, without its rules.
 *
 * Called directly rather than by delegatecall, it does nothing useful: it
 * would try to enable a module on itself, which reverts.
 */
contract JfkSetup {
    function setupForGroup(
        JfkModule module,
        IERC20 token,
        uint256 contribution,
        uint16[9] calldata thresholds,
        uint8 quorumPct,
        uint32 votingPeriod
    ) external {
        ISafe(address(this)).enableModule(address(module));
        module.registerGroup(token, contribution, thresholds, quorumPct, votingPeriod);
    }
}
