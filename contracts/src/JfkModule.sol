// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {ISafe} from "./interfaces/ISafe.sol";

/**
 * @title JfkModule
 * @notice The rules for a JFK savings group, enforced on the group's Safe.
 *
 * Each group's money sits in its own Safe. This module is the only thing
 * allowed to move it day to day, and it only does so when the group's own
 * rules say so: a proposal that reached the group's approval bar, a member
 * being refunded after a vote, or the group closing.
 *
 * Deliberately not upgradeable and with no owner. Nobody, including whoever
 * deployed it, can change the code that holds a group's rules. A fix ships as
 * a new module that each group moves to by its own vote (MIGRATE_MODULE).
 *
 * The Safe's own signing threshold is kept at every member. That is the
 * emergency exit: the friends can always act on the Safe directly, without
 * this module, but only if all of them sign.
 *
 * Votes are cast on-chain, one transaction per vote, so the tally is never in
 * anyone's hands. (An earlier design collected signatures off-chain and
 * submitted them in a batch; whoever submitted could leave out the "no"
 * votes after the deadline. Counting on-chain removes that.)
 *
 * Version 2 adds helpers and collected dues. A member may name one helper:
 * a key that acts for them (Rallied holds it, on behalf of the member's AI),
 * with powers the member picks (propose, vote, collect dues) and an expiry.
 * A helper counts exactly as its member, can never move money itself, and is
 * wiped the moment its member leaves, is removed or changes wallet. A group
 * can vote "every vote needs a human", which turns helper votes off.
 *
 * Collected dues: a member's helper can pull exactly the group's
 * contribution from the member (through the member's own capped approval)
 * into the Safe, at most once per the group's payment gap.
 *
 * Still to come before an audit: rotating payouts and cover-a-friend.
 */
contract JfkModule is ReentrancyGuard {
    using SafeERC20 for IERC20;

    // -----------------------------------------------------------------------
    // Constants
    // -----------------------------------------------------------------------

    uint256 public constant RULE_COUNT = 9;

    /// A spend above this share of the pot (in permille) is a "big amount".
    uint256 public constant LARGE_SPEND_PERMILLE = 200;

    /// Bounds every loop over members.
    uint256 public constant MAX_MEMBERS = 50;

    uint16 public constant MIN_THRESHOLD_PERMILLE = 500;
    uint16 public constant MAX_THRESHOLD_PERMILLE = 1000;
    uint32 public constant MIN_VOTING_PERIOD = 1 hours;
    uint32 public constant MAX_VOTING_PERIOD = 30 days;

    /// Safe's linked-list head for owners and modules.
    address internal constant SENTINEL = address(0x1);

    string public constant VERSION = "2";

    /// What a helper may do for its member. Combine with bitwise or.
    uint8 public constant POWER_PROPOSE = 1;
    uint8 public constant POWER_VOTE = 2;
    uint8 public constant POWER_COLLECT = 4;
    uint8 internal constant ALL_POWERS = 7;

    /// A helper always expires, and never more than a year out.
    uint64 public constant MAX_HELPER_LIFETIME = 366 days;

    /// The least and most time that must pass between two collected payments.
    uint32 public constant MIN_PAY_GAP = 1 days;
    uint32 public constant MAX_PAY_GAP = 31 days;

    // -----------------------------------------------------------------------
    // Types
    // -----------------------------------------------------------------------

    /// What a proposal asks the group to do.
    enum Action {
        SPEND,
        ADD_MEMBER,
        REMOVE_MEMBER,
        REPLACE_MEMBER,
        CHANGE_CONTRIBUTION,
        CHANGE_RULES,
        CLOSE_GROUP,
        MIGRATE_MODULE
    }

    /// Which approval bar a proposal uses. SPEND has two, by size.
    enum Rule {
        SPEND_SMALL,
        SPEND_LARGE,
        ADD_MEMBER,
        REMOVE_MEMBER,
        REPLACE_MEMBER,
        CHANGE_CONTRIBUTION,
        CHANGE_RULES,
        CLOSE_GROUP,
        MIGRATE_MODULE
    }

    enum Choice {
        NONE,
        YES,
        NO,
        ABSTAIN
    }

    enum Status {
        NONE,
        OPEN,
        EXECUTED
    }

    enum Decision {
        UNDECIDED,
        APPROVED,
        REJECTED
    }

    struct Group {
        IERC20 token;
        uint256 contribution;
        uint32 votingPeriod;
        uint8 quorumPct;
        bool closed;
        /// "Every vote needs a human": helpers may not vote. Changed by CHANGE_RULES.
        bool humanVotesOnly;
        /// The least time between two collected payments from one member.
        uint32 payGap;
        uint16[RULE_COUNT] thresholds;
        uint256 proposalCount;
    }

    /// A key that acts for one member in one group, within its powers, until it expires.
    struct Helper {
        address key;
        uint8 powers;
        uint64 expiresAt;
    }

    struct Proposal {
        Action action;
        Status status;
        uint16 thresholdPermille;
        uint8 quorumPct;
        uint64 deadline;
        uint32 eligible;
        uint32 yes;
        uint32 no;
        uint32 abstain;
        address proposer;
        bytes payload;
    }

    // -----------------------------------------------------------------------
    // Storage
    // -----------------------------------------------------------------------

    mapping(address safe => Group) internal _groups;

    /// What each member has paid in. Drives refunds and the closing split.
    mapping(address safe => mapping(address member => uint256)) public paidIn;

    mapping(address safe => mapping(uint256 id => Proposal)) internal _proposals;

    /// Who may vote on a proposal: the members at the moment it opened.
    mapping(address safe => mapping(uint256 id => mapping(address => bool))) public eligibleVoter;

    mapping(address safe => mapping(uint256 id => mapping(address => Choice))) public voteOf;

    /// Each member's helper in each group, if they've named one.
    mapping(address safe => mapping(address member => Helper)) internal _helpers;

    /// When each member last paid in, by hand or collected. Spaces out collections.
    mapping(address safe => mapping(address member => uint64)) public lastPaidAt;

    // -----------------------------------------------------------------------
    // Events
    // -----------------------------------------------------------------------

    event GroupRegistered(address indexed safe, address token, uint256 contribution);
    event Contributed(address indexed safe, address indexed member, uint256 amount);
    event ProposalOpened(
        address indexed safe,
        uint256 indexed id,
        Action action,
        address indexed proposer,
        uint16 thresholdPermille,
        uint64 deadline
    );
    event Voted(address indexed safe, uint256 indexed id, address indexed voter, Choice choice);
    event ProposalExecuted(address indexed safe, uint256 indexed id, Action action);
    event Paid(address indexed safe, address indexed recipient, uint256 amount);
    event MemberAdded(address indexed safe, address indexed member);
    event MemberRemoved(address indexed safe, address indexed member, uint256 refund);
    event MemberReplaced(address indexed safe, address indexed oldWallet, address indexed newWallet);
    event MemberLeft(address indexed safe, address indexed member, uint256 forfeited);
    event ContributionChanged(address indexed safe, uint256 amount);
    event RulesChanged(address indexed safe);
    event GroupClosed(address indexed safe, uint256 distributed);
    event ModuleMigrated(address indexed safe, address indexed newModule);
    event HelperSet(address indexed safe, address indexed member, address indexed key, uint8 powers, uint64 expiresAt);
    event HelperRevoked(address indexed safe, address indexed member);
    /// A helper acted: so a group can always tell a member's own act from their helper's.
    event HelperActed(address indexed safe, address indexed member, address indexed key, uint8 power, uint256 proposalId);
    event Collected(address indexed safe, address indexed member, uint256 amount);

    // -----------------------------------------------------------------------
    // Errors
    // -----------------------------------------------------------------------

    error AlreadyRegistered();
    error NotRegistered();
    error ModuleNotEnabled();
    error ThresholdMustBeAllMembers();
    error TooManyMembers();
    error GroupIsClosed();
    error NotAMember();
    error InvalidRules();
    error InvalidAmount();
    error InvalidAddress();
    error AlreadyAMember();
    error LastMember();
    error UnknownProposal();
    error ProposalNotOpen();
    error VotingClosed();
    error NotEligible();
    error AlreadyVoted();
    error InvalidChoice();
    error NotApproved();
    error InsufficientFunds();
    error SafeCallFailed();
    error TransferMismatch();
    error InvalidHelper();
    error NotHelper();
    error HelperExpired();
    error HelperLacksPower();
    error HumanVotesOnly();
    error TooSoon();

    // -----------------------------------------------------------------------
    // Registration
    // -----------------------------------------------------------------------

    /**
     * Called by the group's Safe, normally from inside `Safe.setup` through
     * JfkSetup, so a group is never live without its rules.
     */
    function registerGroup(
        IERC20 token,
        uint256 contribution,
        uint16[RULE_COUNT] calldata thresholds,
        uint8 quorumPct,
        uint32 votingPeriod,
        uint32 payGap
    ) external {
        address safe = msg.sender;
        Group storage group = _groups[safe];
        if (address(group.token) != address(0)) revert AlreadyRegistered();
        if (address(token) == address(0)) revert InvalidAddress();
        if (!ISafe(safe).isModuleEnabled(address(this))) revert ModuleNotEnabled();

        uint256 members = ISafe(safe).getOwners().length;
        if (members > MAX_MEMBERS) revert TooManyMembers();
        if (ISafe(safe).getThreshold() != members) revert ThresholdMustBeAllMembers();
        if (contribution == 0) revert InvalidAmount();
        _validateRules(thresholds, quorumPct, votingPeriod);
        if (payGap < MIN_PAY_GAP || payGap > MAX_PAY_GAP) revert InvalidRules();

        group.token = token;
        group.contribution = contribution;
        group.thresholds = thresholds;
        group.quorumPct = quorumPct;
        group.votingPeriod = votingPeriod;
        group.payGap = payGap;

        emit GroupRegistered(safe, address(token), contribution);
    }

    // -----------------------------------------------------------------------
    // Contributions
    // -----------------------------------------------------------------------

    /**
     * A member pays this cycle's contribution into the Safe themselves. The
     * member must have approved this module to take it. A member may always
     * pay by hand, even early: it's their own money and their own choice.
     */
    function contribute(address safe) external nonReentrant {
        Group storage group = _liveGroup(safe);
        if (!ISafe(safe).isOwner(msg.sender)) revert NotAMember();
        _takeContribution(safe, group, msg.sender);
    }

    /**
     * A member's helper collects their dues: exactly the group's
     * contribution, from the member, into the Safe, through the member's own
     * approval. Only the member's helper with the collect power may do it, so
     * nobody else can charge them, and only once the group's payment gap has
     * passed since they last paid (by hand or collected), so never twice for
     * the same period.
     */
    function collect(address safe, address member) external nonReentrant {
        Group storage group = _liveGroup(safe);
        if (!ISafe(safe).isOwner(member)) revert NotAMember();
        _requireHelper(safe, member, POWER_COLLECT);

        uint64 last = lastPaidAt[safe][member];
        if (last != 0 && block.timestamp < uint256(last) + group.payGap) revert TooSoon();

        uint256 amount = _takeContribution(safe, group, member);
        emit Collected(safe, member, amount);
        emit HelperActed(safe, member, msg.sender, POWER_COLLECT, 0);
    }

    function _takeContribution(address safe, Group storage group, address member) internal returns (uint256 amount) {
        amount = group.contribution;
        uint256 before = group.token.balanceOf(safe);
        group.token.safeTransferFrom(member, safe, amount);
        // Refuses tokens that skim a fee on transfer: the books must match
        // what actually arrived.
        if (group.token.balanceOf(safe) - before != amount) revert TransferMismatch();

        paidIn[safe][member] += amount;
        lastPaidAt[safe][member] = uint64(block.timestamp);
        emit Contributed(safe, member, amount);
    }

    // -----------------------------------------------------------------------
    // Proposals and voting
    // -----------------------------------------------------------------------

    /**
     * Any member may open a proposal. The approval bar, turnout rule and the
     * list of who may vote are all fixed at this moment, so changing the
     * rules or the membership mid-vote cannot move the goalposts.
     */
    function propose(address safe, Action action, bytes calldata payload) external returns (uint256 id) {
        return _propose(safe, msg.sender, action, payload);
    }

    /// A member's helper opens a proposal for them. It counts as the member's.
    function proposeFor(address safe, address member, Action action, bytes calldata payload)
        external
        returns (uint256 id)
    {
        _requireHelper(safe, member, POWER_PROPOSE);
        id = _propose(safe, member, action, payload);
        emit HelperActed(safe, member, msg.sender, POWER_PROPOSE, id);
    }

    function _propose(address safe, address proposer, Action action, bytes calldata payload)
        internal
        returns (uint256 id)
    {
        Group storage group = _liveGroup(safe);
        if (!ISafe(safe).isOwner(proposer)) revert NotAMember();

        Rule rule = _validateProposal(safe, group, action, payload);

        id = ++group.proposalCount;
        Proposal storage proposal = _proposals[safe][id];
        proposal.action = action;
        proposal.status = Status.OPEN;
        proposal.thresholdPermille = group.thresholds[uint256(rule)];
        proposal.quorumPct = group.quorumPct;
        proposal.deadline = uint64(block.timestamp + group.votingPeriod);
        proposal.proposer = proposer;
        proposal.payload = payload;

        address[] memory owners = ISafe(safe).getOwners();
        for (uint256 i = 0; i < owners.length; i++) {
            eligibleVoter[safe][id][owners[i]] = true;
        }
        proposal.eligible = uint32(owners.length);

        emit ProposalOpened(safe, id, action, proposer, proposal.thresholdPermille, proposal.deadline);
    }

    /// One member, one vote, cast before the deadline. Votes can't be changed.
    function vote(address safe, uint256 id, Choice choice) external {
        _vote(safe, id, msg.sender, choice);
    }

    /**
     * A member's helper casts the member's vote. It is the member's one vote,
     * not an extra one: if either has voted, the other can't. Refused when the
     * group has voted that every vote needs a human.
     */
    function voteFor(address safe, address member, uint256 id, Choice choice) external {
        if (_groups[safe].humanVotesOnly) revert HumanVotesOnly();
        _requireHelper(safe, member, POWER_VOTE);
        _vote(safe, id, member, choice);
        emit HelperActed(safe, member, msg.sender, POWER_VOTE, id);
    }

    function _vote(address safe, uint256 id, address voter, Choice choice) internal {
        Proposal storage proposal = _openProposal(safe, id);
        if (block.timestamp >= proposal.deadline) revert VotingClosed();
        if (choice == Choice.NONE) revert InvalidChoice();
        if (!eligibleVoter[safe][id][voter]) revert NotEligible();
        // Someone removed since the vote opened keeps their slot in the count
        // but loses their voice. That can only make passing harder.
        if (!ISafe(safe).isOwner(voter)) revert NotAMember();
        if (voteOf[safe][id][voter] != Choice.NONE) revert AlreadyVoted();

        voteOf[safe][id][voter] = choice;
        if (choice == Choice.YES) proposal.yes++;
        else if (choice == Choice.NO) proposal.no++;
        else proposal.abstain++;

        emit Voted(safe, id, voter, choice);
    }

    // -----------------------------------------------------------------------
    // Helpers
    // -----------------------------------------------------------------------

    /**
     * Name (or replace) your helper in a group: the key that may act for you,
     * what it may do, and when it stops. Only a member can name their own
     * helper; a helper can never name one. It always expires, within a year.
     */
    function setHelper(address safe, address key, uint8 powers, uint64 expiresAt) external {
        _liveGroup(safe);
        if (!ISafe(safe).isOwner(msg.sender)) revert NotAMember();
        if (key == address(0) || key == msg.sender || key == safe || key == address(this) || key == SENTINEL) {
            revert InvalidHelper();
        }
        if (powers == 0 || powers & ~ALL_POWERS != 0) revert InvalidHelper();
        if (expiresAt <= block.timestamp || expiresAt > block.timestamp + MAX_HELPER_LIFETIME) revert InvalidHelper();

        _helpers[safe][msg.sender] = Helper({key: key, powers: powers, expiresAt: expiresAt});
        emit HelperSet(safe, msg.sender, key, powers, expiresAt);
    }

    /// Take your helper away. It stops working at once.
    function revokeHelper(address safe) external {
        if (_helpers[safe][msg.sender].key == address(0)) revert InvalidHelper();
        delete _helpers[safe][msg.sender];
        emit HelperRevoked(safe, msg.sender);
    }

    function getHelper(address safe, address member) external view returns (Helper memory) {
        return _helpers[safe][member];
    }

    /// The caller must be this member's live helper, with this power.
    function _requireHelper(address safe, address member, uint8 power) internal view {
        Helper storage helper = _helpers[safe][member];
        if (helper.key == address(0) || helper.key != msg.sender) revert NotHelper();
        if (block.timestamp >= helper.expiresAt) revert HelperExpired();
        if (helper.powers & power == 0) revert HelperLacksPower();
    }

    /// Wipe a member's helper when they stop being that member, so it can never come back.
    function _forgetHelper(address safe, address member) internal {
        if (_helpers[safe][member].key != address(0)) {
            delete _helpers[safe][member];
            emit HelperRevoked(safe, member);
        }
    }

    /**
     * Carry out an approved proposal. Anyone may call it, so a passed vote
     * can never be held up by one person. If the action can't be carried out
     * right now (say the pot is short), the whole call reverts and the
     * proposal stays open to be tried again before it expires.
     */
    function execute(address safe, uint256 id) external nonReentrant {
        Group storage group = _liveGroup(safe);
        Proposal storage proposal = _openProposal(safe, id);
        if (decision(safe, id) != Decision.APPROVED) revert NotApproved();

        proposal.status = Status.EXECUTED;
        Action action = proposal.action;
        bytes memory payload = proposal.payload;

        if (action == Action.SPEND) {
            (address recipient, uint256 amount) = abi.decode(payload, (address, uint256));
            if (amount > group.token.balanceOf(safe)) revert InsufficientFunds();
            _pay(safe, group.token, recipient, amount);
        } else if (action == Action.ADD_MEMBER) {
            address member = abi.decode(payload, (address));
            _addMember(safe, member);
        } else if (action == Action.REMOVE_MEMBER) {
            address member = abi.decode(payload, (address));
            _removeMember(safe, group, member);
        } else if (action == Action.REPLACE_MEMBER) {
            (address oldWallet, address newWallet) = abi.decode(payload, (address, address));
            _replaceMember(safe, oldWallet, newWallet);
        } else if (action == Action.CHANGE_CONTRIBUTION) {
            uint256 amount = abi.decode(payload, (uint256));
            group.contribution = amount;
            emit ContributionChanged(safe, amount);
        } else if (action == Action.CHANGE_RULES) {
            (uint16[RULE_COUNT] memory thresholds, uint8 quorumPct, uint32 votingPeriod, bool humanVotesOnly) =
                abi.decode(payload, (uint16[9], uint8, uint32, bool)); // 9 == RULE_COUNT: abi.decode needs a literal
            group.thresholds = thresholds;
            group.quorumPct = quorumPct;
            group.votingPeriod = votingPeriod;
            group.humanVotesOnly = humanVotesOnly;
            emit RulesChanged(safe);
        } else if (action == Action.CLOSE_GROUP) {
            _closeGroup(safe, group);
        } else {
            address newModule = abi.decode(payload, (address));
            _migrate(safe, group, newModule);
        }

        emit ProposalExecuted(safe, id, action);
    }

    /**
     * Where a vote stands. Mirrors `evaluate` in the app's governance module
     * exactly, so the screen and the contract always agree:
     *
     *   approval = yes / (yes + no), turnout = everyone who voted / eligible,
     *   both rounded half-up, abstentions counting toward turnout only.
     *
     * Before the deadline, a proposal only passes once no combination of the
     * outstanding votes could undo it. At the deadline, or once everyone has
     * voted, the votes cast are the final answer.
     */
    function decision(address safe, uint256 id) public view returns (Decision) {
        Proposal storage p = _proposals[safe][id];
        if (p.status == Status.NONE) revert UnknownProposal();
        if (p.status == Status.EXECUTED) return Decision.APPROVED;

        uint256 cast = uint256(p.yes) + p.no + p.abstain;
        uint256 decisive = uint256(p.yes) + p.no;
        uint256 approval = decisive == 0 ? 0 : _roundDiv(uint256(p.yes) * 1000, decisive);
        uint256 turnout = p.eligible == 0 ? 0 : _roundDiv(cast * 100, p.eligible);

        bool quorumMet = turnout >= p.quorumPct;
        bool thresholdMet = decisive > 0 && approval >= p.thresholdPermille;

        if (block.timestamp >= p.deadline || cast >= p.eligible) {
            return quorumMet && thresholdMet ? Decision.APPROVED : Decision.REJECTED;
        }

        uint256 remaining = p.eligible - cast;

        // Passing, and still passing even if every outstanding vote is a no.
        if (quorumMet && thresholdMet) {
            uint256 worst = _roundDiv(uint256(p.yes) * 1000, decisive + remaining);
            if (worst >= p.thresholdPermille) return Decision.APPROVED;
        }

        // Failing, and failing even if every outstanding vote is a yes.
        uint256 best = _roundDiv((uint256(p.yes) + remaining) * 1000, decisive + remaining);
        if (best < p.thresholdPermille) return Decision.REJECTED;

        return Decision.UNDECIDED;
    }

    // -----------------------------------------------------------------------
    // Leaving
    // -----------------------------------------------------------------------

    /**
     * A member walks away. No vote needed. What they paid in stays with the
     * group: leaving is choosing not to commit to the round.
     */
    function leave(address safe) external nonReentrant {
        _liveGroup(safe);
        if (!ISafe(safe).isOwner(msg.sender)) revert NotAMember();

        uint256 forfeited = paidIn[safe][msg.sender];
        paidIn[safe][msg.sender] = 0;
        _forgetHelper(safe, msg.sender);
        _removeOwner(safe, msg.sender);

        emit MemberLeft(safe, msg.sender, forfeited);
    }

    // -----------------------------------------------------------------------
    // Views
    // -----------------------------------------------------------------------

    function getGroup(address safe)
        external
        view
        returns (
            address token,
            uint256 contribution,
            uint32 votingPeriod,
            uint8 quorumPct,
            bool closed,
            uint16[RULE_COUNT] memory thresholds,
            uint256 proposalCount
        )
    {
        Group storage g = _groups[safe];
        return (address(g.token), g.contribution, g.votingPeriod, g.quorumPct, g.closed, g.thresholds, g.proposalCount);
    }

    /// The version-2 settings: whether every vote needs a human, and the gap between collections.
    function getGroupSettings(address safe) external view returns (bool humanVotesOnly, uint32 payGap) {
        Group storage g = _groups[safe];
        return (g.humanVotesOnly, g.payGap);
    }

    function getProposal(address safe, uint256 id) external view returns (Proposal memory) {
        return _proposals[safe][id];
    }

    /// The total paid in by everyone currently in the group.
    function totalPaidIn(address safe) public view returns (uint256 total) {
        address[] memory owners = ISafe(safe).getOwners();
        for (uint256 i = 0; i < owners.length; i++) {
            total += paidIn[safe][owners[i]];
        }
    }

    /**
     * What a member would get back if voted out now: their share of the pot
     * in proportion to what they paid in, never more than they paid in. If
     * the group has spent money, they carry their share of that cost.
     */
    function refundFor(address safe, address member) public view returns (uint256) {
        uint256 paid = paidIn[safe][member];
        uint256 total = totalPaidIn(safe);
        if (paid == 0 || total == 0) return 0;
        uint256 share = (_groups[safe].token.balanceOf(safe) * paid) / total;
        return share < paid ? share : paid;
    }

    // -----------------------------------------------------------------------
    // Internals: actions
    // -----------------------------------------------------------------------

    function _addMember(address safe, address member) internal {
        uint256 members = ISafe(safe).getOwners().length;
        if (ISafe(safe).isOwner(member)) revert AlreadyAMember();
        if (members + 1 > MAX_MEMBERS) revert TooManyMembers();

        // Threshold rises with the membership, so the emergency exit always
        // needs every member.
        _safeCall(safe, safe, abi.encodeCall(ISafe.addOwnerWithThreshold, (member, members + 1)));
        emit MemberAdded(safe, member);
    }

    function _removeMember(address safe, Group storage group, address member) internal {
        if (!ISafe(safe).isOwner(member)) revert NotAMember();

        uint256 refund = refundFor(safe, member);
        paidIn[safe][member] = 0;
        _forgetHelper(safe, member);
        _removeOwner(safe, member);
        if (refund > 0) _pay(safe, group.token, member, refund);

        emit MemberRemoved(safe, member, refund);
    }

    function _replaceMember(address safe, address oldWallet, address newWallet) internal {
        if (!ISafe(safe).isOwner(oldWallet)) revert NotAMember();
        if (ISafe(safe).isOwner(newWallet)) revert AlreadyAMember();

        address prev = _previousOwner(safe, oldWallet);
        _safeCall(safe, safe, abi.encodeCall(ISafe.swapOwner, (prev, oldWallet, newWallet)));

        // The person is the same; only their wallet changed. Their payment
        // history moves with them; their helper doesn't (the old wallet named
        // it, and the old wallet may be lost or stolen).
        paidIn[safe][newWallet] = paidIn[safe][oldWallet];
        paidIn[safe][oldWallet] = 0;
        lastPaidAt[safe][newWallet] = lastPaidAt[safe][oldWallet];
        lastPaidAt[safe][oldWallet] = 0;
        _forgetHelper(safe, oldWallet);

        emit MemberReplaced(safe, oldWallet, newWallet);
    }

    /**
     * Everyone takes their share, in proportion to what they paid in. If
     * nobody has paid in (money only arrived some other way), it's split
     * equally. Rounding dust goes to the last member in the Safe's list, so
     * the Safe ends at exactly zero.
     */
    function _closeGroup(address safe, Group storage group) internal {
        group.closed = true;

        address[] memory owners = ISafe(safe).getOwners();
        uint256 balance = group.token.balanceOf(safe);
        uint256 total = totalPaidIn(safe);
        uint256 distributed;

        for (uint256 i = 0; i < owners.length; i++) {
            uint256 share;
            if (i == owners.length - 1) {
                share = balance - distributed;
            } else if (total == 0) {
                share = balance / owners.length;
            } else {
                share = (balance * paidIn[safe][owners[i]]) / total;
            }
            paidIn[safe][owners[i]] = 0;
            distributed += share;
            if (share > 0) _pay(safe, group.token, owners[i], share);
        }

        emit GroupClosed(safe, distributed);
    }

    /**
     * Hand the group to a new version of the module. The money never leaves
     * the Safe. This module stops working for the group the moment the
     * switch is made.
     */
    function _migrate(address safe, Group storage group, address newModule) internal {
        group.closed = true;
        if (!ISafe(safe).isModuleEnabled(newModule)) {
            _safeCall(safe, safe, abi.encodeCall(ISafe.enableModule, (newModule)));
        }
        address prev = _previousModule(safe, address(this));
        _safeCall(safe, safe, abi.encodeCall(ISafe.disableModule, (prev, address(this))));
        emit ModuleMigrated(safe, newModule);
    }

    // -----------------------------------------------------------------------
    // Internals: validation
    // -----------------------------------------------------------------------

    /// Checks a proposal makes sense now, and returns the bar it must clear.
    function _validateProposal(address safe, Group storage group, Action action, bytes calldata payload)
        internal
        view
        returns (Rule)
    {
        if (action == Action.SPEND) {
            (address recipient, uint256 amount) = abi.decode(payload, (address, uint256));
            if (recipient == address(0) || recipient == safe) revert InvalidAddress();
            if (amount == 0) revert InvalidAmount();
            uint256 balance = group.token.balanceOf(safe);
            return amount * 1000 > balance * LARGE_SPEND_PERMILLE ? Rule.SPEND_LARGE : Rule.SPEND_SMALL;
        }
        if (action == Action.ADD_MEMBER) {
            address member = abi.decode(payload, (address));
            _requireUsableAddress(safe, member);
            if (ISafe(safe).isOwner(member)) revert AlreadyAMember();
            return Rule.ADD_MEMBER;
        }
        if (action == Action.REMOVE_MEMBER) {
            address member = abi.decode(payload, (address));
            if (!ISafe(safe).isOwner(member)) revert NotAMember();
            if (ISafe(safe).getOwners().length == 1) revert LastMember();
            return Rule.REMOVE_MEMBER;
        }
        if (action == Action.REPLACE_MEMBER) {
            (address oldWallet, address newWallet) = abi.decode(payload, (address, address));
            if (!ISafe(safe).isOwner(oldWallet)) revert NotAMember();
            _requireUsableAddress(safe, newWallet);
            if (ISafe(safe).isOwner(newWallet)) revert AlreadyAMember();
            return Rule.REPLACE_MEMBER;
        }
        if (action == Action.CHANGE_CONTRIBUTION) {
            if (abi.decode(payload, (uint256)) == 0) revert InvalidAmount();
            return Rule.CHANGE_CONTRIBUTION;
        }
        if (action == Action.CHANGE_RULES) {
            (uint16[RULE_COUNT] memory thresholds, uint8 quorumPct, uint32 votingPeriod,) =
                abi.decode(payload, (uint16[9], uint8, uint32, bool)); // 9 == RULE_COUNT: abi.decode needs a literal
            _validateRules(thresholds, quorumPct, votingPeriod);
            return Rule.CHANGE_RULES;
        }
        if (action == Action.CLOSE_GROUP) {
            return Rule.CLOSE_GROUP;
        }
        address newModule = abi.decode(payload, (address));
        if (newModule == address(0) || newModule == SENTINEL || newModule == address(this) || newModule == safe) {
            revert InvalidAddress();
        }
        return Rule.MIGRATE_MODULE;
    }

    function _validateRules(uint16[RULE_COUNT] memory thresholds, uint8 quorumPct, uint32 votingPeriod)
        internal
        pure
    {
        for (uint256 i = 0; i < RULE_COUNT; i++) {
            if (thresholds[i] < MIN_THRESHOLD_PERMILLE || thresholds[i] > MAX_THRESHOLD_PERMILLE) {
                revert InvalidRules();
            }
        }
        if (quorumPct == 0 || quorumPct > 100) revert InvalidRules();
        if (votingPeriod < MIN_VOTING_PERIOD || votingPeriod > MAX_VOTING_PERIOD) revert InvalidRules();
    }

    function _requireUsableAddress(address safe, address account) internal view {
        if (account == address(0) || account == SENTINEL || account == safe || account == address(this)) {
            revert InvalidAddress();
        }
    }

    function _liveGroup(address safe) internal view returns (Group storage group) {
        group = _groups[safe];
        if (address(group.token) == address(0)) revert NotRegistered();
        if (group.closed) revert GroupIsClosed();
    }

    function _openProposal(address safe, uint256 id) internal view returns (Proposal storage p) {
        p = _proposals[safe][id];
        if (p.status == Status.NONE) revert UnknownProposal();
        if (p.status != Status.OPEN) revert ProposalNotOpen();
    }

    // -----------------------------------------------------------------------
    // Internals: talking to the Safe
    // -----------------------------------------------------------------------

    /**
     * Send tokens from the Safe, and prove it: the call must succeed, the
     * token must not report failure, and the Safe's balance must drop by
     * exactly the amount.
     */
    function _pay(address safe, IERC20 token, address recipient, uint256 amount) internal {
        uint256 before = token.balanceOf(safe);
        (bool success, bytes memory returnData) = ISafe(safe).execTransactionFromModuleReturnData(
            address(token), 0, abi.encodeCall(IERC20.transfer, (recipient, amount)), ISafe.Operation.Call
        );
        if (!success) revert SafeCallFailed();
        if (returnData.length > 0 && !abi.decode(returnData, (bool))) revert SafeCallFailed();
        if (before - token.balanceOf(safe) != amount) revert TransferMismatch();
        emit Paid(safe, recipient, amount);
    }

    /// Remove an owner, keeping the Safe's threshold at every remaining member.
    function _removeOwner(address safe, address owner) internal {
        uint256 members = ISafe(safe).getOwners().length;
        if (members == 1) revert LastMember();
        address prev = _previousOwner(safe, owner);
        _safeCall(safe, safe, abi.encodeCall(ISafe.removeOwner, (prev, owner, members - 1)));
    }

    function _safeCall(address safe, address to, bytes memory data) internal {
        (bool success,) = ISafe(safe).execTransactionFromModuleReturnData(to, 0, data, ISafe.Operation.Call);
        if (!success) revert SafeCallFailed();
    }

    /// Safe keeps owners in a linked list; removing one needs its predecessor.
    function _previousOwner(address safe, address owner) internal view returns (address) {
        address[] memory owners = ISafe(safe).getOwners();
        address prev = SENTINEL;
        for (uint256 i = 0; i < owners.length; i++) {
            if (owners[i] == owner) return prev;
            prev = owners[i];
        }
        revert NotAMember();
    }

    function _previousModule(address safe, address module) internal view returns (address) {
        (address[] memory modules,) = ISafe(safe).getModulesPaginated(SENTINEL, MAX_MEMBERS);
        address prev = SENTINEL;
        for (uint256 i = 0; i < modules.length; i++) {
            if (modules[i] == module) return prev;
            prev = modules[i];
        }
        revert ModuleNotEnabled();
    }

    /// Integer division rounded half-up, matching JavaScript's Math.round.
    function _roundDiv(uint256 numerator, uint256 denominator) internal pure returns (uint256) {
        return (numerator * 2 + denominator) / (denominator * 2);
    }
}
