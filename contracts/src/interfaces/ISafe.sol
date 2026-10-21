// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

/**
 * The parts of a Safe (v1.4.1) that JfkModule uses.
 *
 * Declared here rather than importing Safe itself, so the module's own code
 * stays small and its dependency on Safe is exactly this list.
 */
interface ISafe {
    enum Operation {
        Call,
        DelegateCall
    }

    function execTransactionFromModuleReturnData(
        address to,
        uint256 value,
        bytes memory data,
        Operation operation
    ) external returns (bool success, bytes memory returnData);

    function getOwners() external view returns (address[] memory);

    function isOwner(address owner) external view returns (bool);

    function getThreshold() external view returns (uint256);

    function isModuleEnabled(address module) external view returns (bool);

    function getModulesPaginated(address start, uint256 pageSize)
        external
        view
        returns (address[] memory array, address next);

    // Owner and module management. These are `authorized` on the Safe: they
    // only succeed when the Safe calls itself, which is what a module
    // transaction to the Safe's own address does.
    function enableModule(address module) external;

    function disableModule(address prevModule, address module) external;

    function addOwnerWithThreshold(address owner, uint256 threshold) external;

    function removeOwner(address prevOwner, address owner, uint256 threshold) external;

    function swapOwner(address prevOwner, address oldOwner, address newOwner) external;
}
