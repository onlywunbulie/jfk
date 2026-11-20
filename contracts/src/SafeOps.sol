// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ISafe} from "./interfaces/ISafe.sol";

/**
 * @title SafeOps
 * @notice Everything JfkModule asks a group's Safe to do: pay someone, and
 *         change its owners or modules. One place, so every movement of
 *         money is checked the same way.
 *
 * An external library, linked into JfkModule and RotationLib: it runs in the
 * module's context (delegatecall), so the Safe sees the module as the caller,
 * exactly as before. It exists to keep JfkModule under the contract size
 * limit. Errors and events match JfkModule's, so nothing outside can tell
 * the difference.
 */
library SafeOps {
    /// Safe's linked-list head for owners and modules.
    address internal constant SENTINEL = address(0x1);
    uint256 internal constant MAX_MODULES = 50;

    event Paid(address indexed safe, address indexed recipient, uint256 amount);

    error SafeCallFailed();
    error TransferMismatch();
    error LastMember();
    error NotAMember();
    error ModuleNotEnabled();

    /**
     * Send tokens from the Safe, and prove it: the call must succeed, the
     * token must not report failure, and the Safe's balance must drop by
     * exactly the amount.
     */
    function pay(address safe, IERC20 token, address recipient, uint256 amount) external {
        uint256 before = token.balanceOf(safe);
        (bool success, bytes memory returnData) = ISafe(safe).execTransactionFromModuleReturnData(
            address(token), 0, abi.encodeCall(IERC20.transfer, (recipient, amount)), ISafe.Operation.Call
        );
        if (!success) revert SafeCallFailed();
        if (returnData.length > 0 && !abi.decode(returnData, (bool))) revert SafeCallFailed();
        if (before - token.balanceOf(safe) != amount) revert TransferMismatch();
        emit Paid(safe, recipient, amount);
    }

    /// Add an owner, raising the Safe's threshold so the emergency exit always needs every member.
    function addOwner(address safe, address owner) external {
        uint256 members = ISafe(safe).getOwners().length;
        _call(safe, abi.encodeCall(ISafe.addOwnerWithThreshold, (owner, members + 1)));
    }

    /// Remove an owner, keeping the Safe's threshold at every remaining member.
    function removeOwner(address safe, address owner) external {
        uint256 members = ISafe(safe).getOwners().length;
        if (members == 1) revert LastMember();
        address prev = _previousOwner(safe, owner);
        _call(safe, abi.encodeCall(ISafe.removeOwner, (prev, owner, members - 1)));
    }

    /// Swap one owner's wallet for another, in place.
    function swapOwner(address safe, address oldOwner, address newOwner) external {
        address prev = _previousOwner(safe, oldOwner);
        _call(safe, abi.encodeCall(ISafe.swapOwner, (prev, oldOwner, newOwner)));
    }

    /// Hand the Safe to a new module, switching this one off.
    function switchModule(address safe, address oldModule, address newModule) external {
        if (!ISafe(safe).isModuleEnabled(newModule)) {
            _call(safe, abi.encodeCall(ISafe.enableModule, (newModule)));
        }
        address prev = _previousModule(safe, oldModule);
        _call(safe, abi.encodeCall(ISafe.disableModule, (prev, oldModule)));
    }

    function _call(address safe, bytes memory data) private {
        (bool success,) = ISafe(safe).execTransactionFromModuleReturnData(safe, 0, data, ISafe.Operation.Call);
        if (!success) revert SafeCallFailed();
    }

    /// Safe keeps owners in a linked list; removing one needs its predecessor.
    function _previousOwner(address safe, address owner) private view returns (address) {
        address[] memory owners = ISafe(safe).getOwners();
        address prev = SENTINEL;
        for (uint256 i = 0; i < owners.length; i++) {
            if (owners[i] == owner) return prev;
            prev = owners[i];
        }
        revert NotAMember();
    }

    function _previousModule(address safe, address module) private view returns (address) {
        (address[] memory modules,) = ISafe(safe).getModulesPaginated(SENTINEL, MAX_MODULES);
        address prev = SENTINEL;
        for (uint256 i = 0; i < modules.length; i++) {
            if (modules[i] == module) return prev;
            prev = modules[i];
        }
        revert ModuleNotEnabled();
    }
}
