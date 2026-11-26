// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ISafe} from "./interfaces/ISafe.sol";
import {JfkModule} from "./JfkModule.sol";
import {SafeOps} from "./SafeOps.sol";

/**
 * @title RotationLib
 * @notice Rotating savings (Ajo / Esusu) for a JFK group: each round, everyone
 *         pays in, and the whole round's pot goes to one member, in turn.
 *
 * Linked to JfkModule as an external library, so it runs in the module's own
 * context (delegatecall): the module stays under the contract size limit, and
 * this file holds every rotation rule in one place.
 *
 * The rules, as the group agreed them:
 *
 *  1. Each payout goes to the next member in the order, on schedule, and is
 *     whatever came in for that round. Anyone may trigger it once it's due
 *     (Rallied's daily job does), and it can only ever go to that member.
 *     It's due once everyone has paid, or, if someone hasn't, after a grace
 *     period, so nobody's debt starts before their due date has passed.
 *  2. A member who misses a round owes that round's dues. The debt is public
 *     (`debt`), and the payout they missed is recorded as owed to that
 *     round's turn holder (a shortfall). Whatever a debtor pays goes to the
 *     oldest shortfall first, straight to whoever was short.
 *  3. Miss before your own turn, and you move to the back: you collect last,
 *     after everything you owe has had time to come in. At your turn, any
 *     debt left is taken out of your pot and paid to whoever you shorted.
 *  4. Once you've had your turn, your automatic dues stay on until the cycle
 *     ends (enforced in JfkModule's helper functions).
 *  5. A new cycle starts by itself, in the same order, except that anyone
 *     still owing goes to the back. Members leaving, and new members joining,
 *     only take effect between cycles, so every cycle is paid in full by
 *     the people it pays out to. A member who owes can be voted out at once.
 *
 * Invariant (tested): the sum of every `debt`, past members included, equals
 * the sum of open shortfalls. Money owed is always owed to someone.
 */
library RotationLib {
    struct Shortfall {
        address creditor;
        uint256 amount;
    }

    struct State {
        bool on;
        /// The least time between two payouts.
        uint32 roundGap;
        /// How long a payout waits for late payers once it's due.
        uint32 grace;
        /// The earliest the next payout may happen, if everyone has paid.
        uint64 nextPayoutAt;
        /// Payouts made so far, across cycles. The round being paid for is `round + 1`.
        uint32 round;
        /// Which position in `order` collects next.
        uint32 turn;
        uint32 cycle;
        /// What has come in for the current round.
        uint256 roundPot;
        /// A new contribution agreed mid-cycle, applied when the next cycle starts. 0 if none.
        uint256 pendingContribution;
        address[] order;
        address[] joining;
        Shortfall[] shortfalls;
        /// Shortfalls before this index are paid off.
        uint256 shortfallHead;
        mapping(address => bool) inOrder;
        mapping(address => uint32) paidRound;
        mapping(address => uint256) debt;
        mapping(address => bool) collected;
        mapping(address => bool) leaving;
    }

    /// JfkModule.POWER_COLLECT: the power that lets a helper collect dues, i.e. automatic dues.
    uint8 internal constant COLLECT = 4;
    uint32 internal constant MIN_ROUND_GAP = 1 hours;
    uint32 internal constant MAX_ROUND_GAP = 92 days;
    uint32 internal constant MAX_GRACE = 7 days;

    event RotationStarted(address indexed safe, uint32 roundGap, uint32 grace, uint64 firstPayoutAt);
    event TurnPaid(address indexed safe, uint32 round, address indexed holder, uint256 paid, uint256 missing);
    event DebtRecorded(address indexed safe, address indexed member, uint256 amount, uint32 round);
    event DebtRepaid(address indexed safe, address indexed debtor, address indexed creditor, uint256 amount);
    event MovedToBack(address indexed safe, address indexed member);
    event CycleStarted(address indexed safe, uint32 cycle, uint256 members);
    event LeaveScheduled(address indexed safe, address indexed member);
    event OrderChanged(address indexed safe);

    error InvalidRotation();
    error NotInRotation();
    error AlreadyPaid();
    error NotDueYet();
    error InvalidOrder();
    error NoDebt();

    // -------------------------------------------------------------------
    // Setting up
    // -------------------------------------------------------------------

    /// The Safe's owners, in their listed order, are the first cycle's order.
    function start(State storage s, address safe, uint32 roundGap, uint32 grace, uint64 firstPayoutAt) external {
        if (roundGap < MIN_ROUND_GAP || roundGap > MAX_ROUND_GAP) revert InvalidRotation();
        if (grace > MAX_GRACE) revert InvalidRotation();
        if (firstPayoutAt <= block.timestamp || firstPayoutAt > block.timestamp + uint256(roundGap) * 2) {
            revert InvalidRotation();
        }
        address[] memory owners = ISafe(safe).getOwners();
        for (uint256 i = 0; i < owners.length; i++) {
            s.order.push(owners[i]);
            s.inOrder[owners[i]] = true;
        }
        s.on = true;
        s.roundGap = roundGap;
        s.grace = grace;
        s.nextPayoutAt = firstPayoutAt;
        s.cycle = 1;
        emit RotationStarted(safe, roundGap, grace, firstPayoutAt);
        emit CycleStarted(safe, 1, owners.length);
    }

    // -------------------------------------------------------------------
    // Paying in
    // -------------------------------------------------------------------

    /// Refuses a payment that has nowhere to go: from someone waiting to join, or a second one this round.
    function checkCanPay(State storage s, address member) external view {
        if (!s.inOrder[member]) revert NotInRotation();
        if (s.debt[member] == 0 && s.paidRound[member] == s.round + 1) revert AlreadyPaid();
    }

    /**
     * A payment has arrived in the Safe. It settles the member's debt first
     * (paid on to whoever was short); otherwise it's this round's dues.
     */
    function credit(State storage s, address safe, IERC20 token, address member, uint256 amount) external {
        uint256 owed = s.debt[member];
        if (owed > 0) {
            uint256 repay = amount < owed ? amount : owed;
            _repay(s, safe, token, member, repay);
            amount -= repay;
            if (amount == 0) return;
        }
        // Whatever is left over after a debt counts toward this round.
        s.paidRound[member] = s.round + 1;
        s.roundPot += amount;
    }

    /**
     * Someone pays off a member's debt for them (a friend, or the member
     * after they've left). The money is already in the Safe; it goes
     * straight on to whoever was short.
     */
    function cover(State storage s, address safe, IERC20 token, address debtor, uint256 amount) external {
        if (amount == 0 || amount > s.debt[debtor]) revert NoDebt();
        _repay(s, safe, token, debtor, amount);
    }

    // -------------------------------------------------------------------
    // Paying out
    // -------------------------------------------------------------------

    /**
     * Pay the current turn. If that was the cycle's last turn, the next
     * cycle starts at once, so anyone joining can pay their first round in
     * time. Returns who leaves at that point (for the module to take off the
     * Safe) and the contribution from then on (unchanged unless the group
     * voted a new one).
     */
    function payTurn(State storage s, address safe, IERC20 token, uint256 contribution)
        external
        returns (address[] memory leavers, uint256 nextContribution)
    {
        nextContribution = contribution;
        if (s.turn >= s.order.length) revert NotInRotation();
        if (block.timestamp < s.nextPayoutAt) revert NotDueYet();

        uint32 thisRound = s.round + 1;
        address holder = s.order[s.turn];
        uint256 n = s.order.length;

        // Who hasn't paid this round. They owe it now.
        address[] memory late = new address[](n);
        uint256 lateCount;
        for (uint256 i = 0; i < n; i++) {
            address m = s.order[i];
            if (s.paidRound[m] != thisRound) late[lateCount++] = m;
        }
        if (lateCount > 0 && block.timestamp < uint256(s.nextPayoutAt) + s.grace) revert NotDueYet();

        uint256 missing = lateCount * nextContribution;
        for (uint256 i = 0; i < lateCount; i++) {
            s.debt[late[i]] += nextContribution;
            emit DebtRecorded(safe, late[i], nextContribution, thisRound);
        }
        if (missing > 0) s.shortfalls.push(Shortfall({creditor: holder, amount: missing}));

        // The holder's own debt comes out of their pot first.
        uint256 pot = s.roundPot;
        s.roundPot = 0;
        uint256 owed = s.debt[holder];
        if (owed > 0 && pot > 0) {
            uint256 netted = owed < pot ? owed : pot;
            pot -= netted;
            _repay(s, safe, token, holder, netted);
        }
        if (pot > 0) _pay(safe, token, holder, pot);

        s.collected[holder] = true;
        s.turn++;
        s.round = thisRound;
        s.nextPayoutAt = uint64(block.timestamp + s.roundGap);
        emit TurnPaid(safe, thisRound, holder, pot, missing);

        // Anyone who missed and hasn't had their turn yet goes to the back.
        for (uint256 i = 0; i < lateCount; i++) {
            if (!s.collected[late[i]]) _moveToBack(s, safe, late[i]);
        }

        if (s.turn >= s.order.length) (leavers, nextContribution) = _newCycle(s, safe, contribution);
    }

    /**
     * Starts the next cycle when this one has run out of turns some other
     * way (the last members still to collect were voted out).
     */
    function startNextCycleIfDone(State storage s, address safe, uint256 contribution)
        external
        returns (address[] memory leavers, uint256 nextContribution)
    {
        nextContribution = contribution;
        if (s.turn >= s.order.length) (leavers, nextContribution) = _newCycle(s, safe, contribution);
    }

    /// Starts the next cycle: leavers go, joiners come in at the back, anyone still owing goes after them.
    function _newCycle(State storage s, address safe, uint256 contribution)
        private
        returns (address[] memory leavers, uint256 nextContribution)
    {
        nextContribution = s.pendingContribution == 0 ? contribution : s.pendingContribution;
        s.pendingContribution = 0;

        address[] memory old = s.order;
        uint256 leaving;
        for (uint256 i = 0; i < old.length; i++) {
            if (s.leaving[old[i]]) leaving++;
        }
        leavers = new address[](leaving);
        delete s.order;

        uint256 l;
        // Settled stayers first, in their order; then joiners; then anyone still owing.
        for (uint256 i = 0; i < old.length; i++) {
            address m = old[i];
            s.collected[m] = false;
            if (s.leaving[m]) {
                s.leaving[m] = false;
                s.inOrder[m] = false;
                leavers[l++] = m;
            } else if (s.debt[m] == 0) {
                s.order.push(m);
            }
        }
        for (uint256 i = 0; i < s.joining.length; i++) {
            s.order.push(s.joining[i]);
            s.inOrder[s.joining[i]] = true;
        }
        delete s.joining;
        for (uint256 i = 0; i < old.length; i++) {
            address m = old[i];
            if (s.inOrder[m] && s.debt[m] > 0) {
                s.order.push(m);
                emit MovedToBack(safe, m);
            }
        }

        s.turn = 0;
        s.cycle++;
        emit CycleStarted(safe, s.cycle, s.order.length);
    }

    // -------------------------------------------------------------------
    // Membership, between cycles
    // -------------------------------------------------------------------

    /// A new member waits for the next cycle, then joins at the back.
    function addJoiner(State storage s, address member) external {
        s.joining.push(member);
    }

    /**
     * A member asks to leave, or is voted out without owing anything: they
     * finish this cycle (paying in and collecting their turn), then go.
     * Someone waiting to join can leave straight away: returns true then.
     */
    function scheduleLeave(State storage s, address safe, address member) external returns (bool now_) {
        if (_dropJoiner(s, member)) return true;
        if (!s.inOrder[member]) revert NotInRotation();
        s.leaving[member] = true;
        emit LeaveScheduled(safe, member);
        return false;
    }

    /// Whether a removal vote takes effect at once: for someone owing, or still waiting to join.
    function removesNow(State storage s, address member) external view returns (bool) {
        return s.debt[member] > 0 || !s.inOrder[member];
    }

    /// Takes a member out of the rotation now. Their debt stays on record, owed to whoever they shorted.
    function removeNow(State storage s, address member) external {
        if (_dropJoiner(s, member)) return;
        uint256 n = s.order.length;
        for (uint256 i = 0; i < n; i++) {
            if (s.order[i] == member) {
                for (uint256 j = i; j + 1 < n; j++) {
                    s.order[j] = s.order[j + 1];
                }
                s.order.pop();
                if (i < s.turn) s.turn--;
                break;
            }
        }
        s.inOrder[member] = false;
        s.leaving[member] = false;
        s.collected[member] = false;
    }

    /// A member's wallet changed: everything rotation-related moves with them.
    function replace(State storage s, address oldWallet, address newWallet) external {
        for (uint256 i = 0; i < s.order.length; i++) {
            if (s.order[i] == oldWallet) s.order[i] = newWallet;
        }
        for (uint256 i = 0; i < s.joining.length; i++) {
            if (s.joining[i] == oldWallet) s.joining[i] = newWallet;
        }
        for (uint256 i = s.shortfallHead; i < s.shortfalls.length; i++) {
            if (s.shortfalls[i].creditor == oldWallet) s.shortfalls[i].creditor = newWallet;
        }
        s.inOrder[newWallet] = s.inOrder[oldWallet];
        s.paidRound[newWallet] = s.paidRound[oldWallet];
        s.debt[newWallet] = s.debt[oldWallet];
        s.collected[newWallet] = s.collected[oldWallet];
        s.leaving[newWallet] = s.leaving[oldWallet];
        s.inOrder[oldWallet] = false;
        s.paidRound[oldWallet] = 0;
        s.debt[oldWallet] = 0;
        s.collected[oldWallet] = false;
        s.leaving[oldWallet] = false;
    }

    // -------------------------------------------------------------------
    // The order
    // -------------------------------------------------------------------

    /// A new order for everyone still to collect this cycle: the same people, rearranged.
    function checkOrder(State storage s, address[] memory rest) public view {
        uint256 start_ = s.turn;
        if (rest.length != s.order.length - start_ || rest.length == 0) revert InvalidOrder();
        for (uint256 i = 0; i < rest.length; i++) {
            bool found;
            for (uint256 j = start_; j < s.order.length; j++) {
                if (s.order[j] == rest[i]) {
                    found = true;
                    break;
                }
            }
            if (!found) revert InvalidOrder();
            for (uint256 k = 0; k < i; k++) {
                if (rest[k] == rest[i]) revert InvalidOrder();
            }
        }
    }

    function setOrder(State storage s, address safe, address[] memory rest) external {
        checkOrder(s, rest);
        for (uint256 i = 0; i < rest.length; i++) {
            s.order[s.turn + i] = rest[i];
        }
        emit OrderChanged(safe);
    }

    // -------------------------------------------------------------------
    // Closing
    // -------------------------------------------------------------------

    /// The group closes mid-round: everyone who paid this round gets it back.
    function refundRound(State storage s, address safe, IERC20 token, uint256 contribution) external {
        uint32 thisRound = s.round + 1;
        uint256 pot = s.roundPot;
        for (uint256 i = 0; i < s.order.length && pot > 0; i++) {
            address m = s.order[i];
            if (s.paidRound[m] == thisRound) {
                uint256 back = contribution < pot ? contribution : pot;
                pot -= back;
                _pay(safe, token, m, back);
            }
        }
        s.roundPot = 0;
    }

    // -------------------------------------------------------------------
    // Views
    // -------------------------------------------------------------------

    /// Every unpaid shortfall, oldest first.
    function shortfalls(State storage s) external view returns (address[] memory creditors, uint256[] memory amounts) {
        uint256 count = s.shortfalls.length - s.shortfallHead;
        creditors = new address[](count);
        amounts = new uint256[](count);
        for (uint256 i = 0; i < count; i++) {
            Shortfall storage sf = s.shortfalls[s.shortfallHead + i];
            creditors[i] = sf.creditor;
            amounts[i] = sf.amount;
        }
    }

    /// What's owed in total, to everyone still short.
    function totalShort(State storage s) external view returns (uint256 total) {
        for (uint256 i = s.shortfallHead; i < s.shortfalls.length; i++) {
            total += s.shortfalls[i].amount;
        }
    }

    // -------------------------------------------------------------------
    // Internals
    // -------------------------------------------------------------------

    /// Pays a debtor's money, already in the Safe, to the oldest shortfalls first.
    function _repay(State storage s, address safe, IERC20 token, address debtor, uint256 amount) private {
        s.debt[debtor] -= amount;
        while (amount > 0) {
            Shortfall storage sf = s.shortfalls[s.shortfallHead];
            uint256 part = amount < sf.amount ? amount : sf.amount;
            sf.amount -= part;
            amount -= part;
            if (sf.amount == 0) s.shortfallHead++;
            _pay(safe, token, sf.creditor, part);
            emit DebtRepaid(safe, debtor, sf.creditor, part);
        }
    }

    /**
     * Version 4, run just before a payout: puts the first member in line who
     * has automatic dues (a live helper that may collect) at the current
     * turn. Everyone before
     * them in line keeps their order and goes behind everyone after them.
     * Nothing changes if the member up already has them, or if nobody in line
     * does (the turn is then paid as it stands).
     */
    function skipToAutoDues(State storage s, mapping(address => JfkModule.Helper) storage helpers, address safe) external {
        if (s.turn >= s.order.length) revert NotInRotation();
        uint256 first = type(uint256).max;
        for (uint256 i = s.turn; i < s.order.length; i++) {
            JfkModule.Helper storage helper = helpers[s.order[i]];
            if (helper.key != address(0) && helper.powers & COLLECT != 0 && block.timestamp < helper.expiresAt) {
                first = i - s.turn;
                break;
            }
        }
        if (first == 0 || first == type(uint256).max) return;

        uint256 from = s.turn;
        uint256 n = s.order.length;
        address[] memory skipped = new address[](first);
        for (uint256 i = 0; i < first; i++) {
            skipped[i] = s.order[from + i];
        }
        for (uint256 i = from; i + first < n; i++) {
            s.order[i] = s.order[i + first];
        }
        for (uint256 i = 0; i < first; i++) {
            s.order[n - first + i] = skipped[i];
            emit MovedToBack(safe, skipped[i]);
        }
    }

    function _moveToBack(State storage s, address safe, address member) private {
        uint256 n = s.order.length;
        for (uint256 i = s.turn; i < n; i++) {
            if (s.order[i] == member) {
                for (uint256 j = i; j + 1 < n; j++) {
                    s.order[j] = s.order[j + 1];
                }
                s.order[n - 1] = member;
                emit MovedToBack(safe, member);
                return;
            }
        }
    }

    function _dropJoiner(State storage s, address member) private returns (bool) {
        uint256 n = s.joining.length;
        for (uint256 i = 0; i < n; i++) {
            if (s.joining[i] == member) {
                s.joining[i] = s.joining[n - 1];
                s.joining.pop();
                return true;
            }
        }
        return false;
    }

    function _pay(address safe, IERC20 token, address recipient, uint256 amount) private {
        SafeOps.pay(safe, token, recipient, amount);
    }
}
