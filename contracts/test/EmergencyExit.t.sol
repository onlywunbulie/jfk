// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Safe} from "@safe/Safe.sol";
import {Enum} from "@safe/common/Enum.sol";
import {MultiSendCallOnly} from "@safe/libraries/MultiSendCallOnly.sol";
import {JfkModule} from "../src/JfkModule.sol";
import {JfkBase} from "./JfkBase.sol";

/// Stands in for a member's smart wallet (a Coinbase Smart Wallet): a contract, so it can't sign like a key.
contract SmartWallet {
    function call(address target, bytes calldata data) external {
        (bool ok,) = target.call(data);
        require(ok, "call failed");
    }
}

/**
 * The emergency exit, rehearsed the way Rallied's members would really use it.
 *
 * Their wallets are smart contracts, and Safe v1.4.1 can't check a contract
 * wallet's off-chain signature (it asks for the old `isValidSignature(bytes,bytes)`,
 * which these wallets don't have). So each member approves the exact recovery
 * transaction on-chain with `approveHash`, from their own wallet, and then
 * anyone carries it out. No Rallied server, no JfkModule: just the Safe and
 * every member.
 */
contract EmergencyExitTest is JfkBase {
    MultiSendCallOnly internal multiSend;
    SmartWallet[] internal wallets;
    address[] internal owners;
    address internal safe;

    function setUp() public override {
        super.setUp();
        multiSend = new MultiSendCallOnly();
        for (uint256 i = 0; i < 3; i++) {
            wallets.push(new SmartWallet());
        }
        // Safe wants approvals listed by owner address, lowest first.
        owners = sorted();
        safe = createGroup(owners);
        contributeAll(safe, owners); // 50 each, 150 in the vault
    }

    function sorted() internal view returns (address[] memory list) {
        list = new address[](wallets.length);
        for (uint256 i = 0; i < wallets.length; i++) {
            list[i] = address(wallets[i]);
        }
        for (uint256 i = 0; i < list.length; i++) {
            for (uint256 j = i + 1; j < list.length; j++) {
                if (list[j] < list[i]) (list[i], list[j]) = (list[j], list[i]);
            }
        }
    }

    /// One transaction that pays every member their share: USDC transfers batched through MultiSendCallOnly.
    function splitEvenly() internal view returns (bytes memory data) {
        uint256 share = balanceOf(safe) / owners.length;
        bytes memory batch;
        for (uint256 i = 0; i < owners.length; i++) {
            bytes memory transfer = abi.encodeCall(IERC20.transfer, (owners[i], share));
            batch = abi.encodePacked(batch, uint8(0), address(usdc), uint256(0), transfer.length, transfer);
        }
        data = abi.encodeCall(MultiSendCallOnly.multiSend, (batch));
    }

    function hashOf(bytes memory data) internal view returns (bytes32) {
        return Safe(payable(safe)).getTransactionHash(
            address(multiSend), 0, data, Enum.Operation.DelegateCall, 0, 0, 0, address(0), address(0), 0
        );
    }

    /// Safe's "approved on-chain" signature for each owner: r = the owner, s = 0, v = 1.
    function approvals() internal view returns (bytes memory sigs) {
        for (uint256 i = 0; i < owners.length; i++) {
            sigs = abi.encodePacked(sigs, bytes32(uint256(uint160(owners[i]))), bytes32(0), uint8(1));
        }
    }

    function approve(address owner, bytes32 txHash) internal {
        SmartWallet(owner).call(safe, abi.encodeCall(Safe.approveHash, (txHash)));
    }

    function exit(bytes memory data) internal {
        Safe(payable(safe)).execTransaction(
            address(multiSend), 0, data, Enum.Operation.DelegateCall, 0, 0, 0, address(0), payable(address(0)), approvals()
        );
    }

    function test_everyMembersSmartWalletApprovingGetsEveryoneTheirMoneyBack() public {
        bytes memory data = splitEvenly();
        bytes32 txHash = hashOf(data);
        for (uint256 i = 0; i < owners.length; i++) {
            approve(owners[i], txHash);
        }

        // Anyone can carry it out once everyone has approved: here, a stranger.
        vm.prank(makeAddr("stranger"));
        exit(data);

        for (uint256 i = 0; i < owners.length; i++) {
            assertEq(usdc.balanceOf(owners[i]), CONTRIBUTION);
        }
        assertEq(balanceOf(safe), 0);
    }

    function test_oneMemberMissingStopsIt() public {
        bytes memory data = splitEvenly();
        bytes32 txHash = hashOf(data);
        approve(owners[0], txHash);
        approve(owners[1], txHash);

        vm.expectRevert(bytes("GS025"));
        exit(data);
        assertEq(balanceOf(safe), 3 * CONTRIBUTION);
    }

    function test_anApprovalOnlyCountsForTheExactTransaction() public {
        bytes memory data = splitEvenly();
        for (uint256 i = 0; i < owners.length; i++) {
            approve(owners[i], hashOf(data));
        }
        // Swap in a different recipient: nobody approved that one.
        bytes memory transfer = abi.encodeCall(IERC20.transfer, (makeAddr("thief"), 150 * USD));
        bytes memory other = abi.encodeCall(
            MultiSendCallOnly.multiSend, (abi.encodePacked(uint8(0), address(usdc), uint256(0), transfer.length, transfer))
        );
        vm.expectRevert(bytes("GS025"));
        exit(other);
    }

    function test_itWorksWithoutTheModule() public {
        // The group voted to move to another module and this one is switched off: the exit doesn't care.
        JfkModule next = new JfkModule();
        uint256 id = proposeAs(owners[0], safe, JfkModule.Action.MIGRATE_MODULE, abi.encode(address(next)));
        voteYes(owners, safe, id, 3);
        module.execute(safe, id);
        assertFalse(Safe(payable(safe)).isModuleEnabled(address(module)));

        bytes memory data = splitEvenly();
        bytes32 txHash = hashOf(data);
        for (uint256 i = 0; i < owners.length; i++) {
            approve(owners[i], txHash);
        }
        exit(data);
        assertEq(balanceOf(safe), 0);
    }
}
