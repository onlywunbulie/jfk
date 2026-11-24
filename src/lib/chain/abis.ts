/**
 * The slices of each contract's interface the app calls. Written out rather
 * than generated, so it's obvious exactly which functions the app relies on.
 * Signatures match contracts/src and Safe v1.4.1.
 */

export const safeAbi = [
  {
    type: "function",
    name: "setup",
    stateMutability: "nonpayable",
    inputs: [
      { name: "_owners", type: "address[]" },
      { name: "_threshold", type: "uint256" },
      { name: "to", type: "address" },
      { name: "data", type: "bytes" },
      { name: "fallbackHandler", type: "address" },
      { name: "paymentToken", type: "address" },
      { name: "payment", type: "uint256" },
      { name: "paymentReceiver", type: "address" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "getOwners",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address[]" }],
  },
  {
    type: "function",
    name: "isModuleEnabled",
    stateMutability: "view",
    inputs: [{ name: "module", type: "address" }],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function",
    name: "isOwner",
    stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }],
    outputs: [{ type: "bool" }],
  },
] as const;

export const safeProxyFactoryAbi = [
  {
    type: "function",
    name: "createProxyWithNonce",
    stateMutability: "nonpayable",
    inputs: [
      { name: "_singleton", type: "address" },
      { name: "initializer", type: "bytes" },
      { name: "saltNonce", type: "uint256" },
    ],
    outputs: [{ name: "proxy", type: "address" }],
  },
  {
    type: "function",
    name: "proxyCreationCode",
    stateMutability: "pure",
    inputs: [],
    outputs: [{ type: "bytes" }],
  },
] as const;

export const jfkSetupAbi = [
  {
    type: "function",
    name: "setupForGroup",
    stateMutability: "nonpayable",
    inputs: [
      { name: "module", type: "address" },
      { name: "token", type: "address" },
      { name: "contribution", type: "uint256" },
      { name: "thresholds", type: "uint16[9]" },
      { name: "quorumPct", type: "uint8" },
      { name: "votingPeriod", type: "uint32" },
      { name: "payGap", type: "uint32" },
    ],
    outputs: [],
  },
] as const;

export const jfkModuleAbi = [
  {
    type: "function",
    name: "propose",
    stateMutability: "nonpayable",
    inputs: [
      { name: "safe", type: "address" },
      { name: "action", type: "uint8" },
      { name: "payload", type: "bytes" },
    ],
    outputs: [{ name: "id", type: "uint256" }],
  },
  {
    type: "event",
    name: "ProposalOpened",
    inputs: [
      { name: "safe", type: "address", indexed: true },
      { name: "id", type: "uint256", indexed: true },
      { name: "action", type: "uint8", indexed: false },
      { name: "proposer", type: "address", indexed: true },
      { name: "thresholdPermille", type: "uint16", indexed: false },
      { name: "deadline", type: "uint64", indexed: false },
    ],
  },
  {
    type: "function",
    name: "getGroupSettings",
    stateMutability: "view",
    inputs: [{ name: "safe", type: "address" }],
    outputs: [
      { name: "humanVotesOnly", type: "bool" },
      { name: "payGap", type: "uint32" },
    ],
  },
  {
    type: "function",
    name: "VERSION",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "string" }],
  },
  {
    type: "function",
    name: "getGroup",
    stateMutability: "view",
    inputs: [{ name: "safe", type: "address" }],
    outputs: [
      { name: "token", type: "address" },
      { name: "contribution", type: "uint256" },
      { name: "votingPeriod", type: "uint32" },
      { name: "quorumPct", type: "uint8" },
      { name: "closed", type: "bool" },
      { name: "thresholds", type: "uint16[9]" },
      { name: "proposalCount", type: "uint256" },
    ],
  },
  {
    type: "function",
    name: "getProposal",
    stateMutability: "view",
    inputs: [
      { name: "safe", type: "address" },
      { name: "id", type: "uint256" },
    ],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          { name: "action", type: "uint8" },
          { name: "status", type: "uint8" },
          { name: "thresholdPermille", type: "uint16" },
          { name: "quorumPct", type: "uint8" },
          { name: "deadline", type: "uint64" },
          { name: "eligible", type: "uint32" },
          { name: "yes", type: "uint32" },
          { name: "no", type: "uint32" },
          { name: "abstain", type: "uint32" },
          { name: "proposer", type: "address" },
          { name: "payload", type: "bytes" },
        ],
      },
    ],
  },
  {
    type: "function",
    name: "decision",
    stateMutability: "view",
    inputs: [
      { name: "safe", type: "address" },
      { name: "id", type: "uint256" },
    ],
    outputs: [{ name: "", type: "uint8" }],
  },
  {
    type: "function",
    name: "voteOf",
    stateMutability: "view",
    inputs: [
      { name: "safe", type: "address" },
      { name: "id", type: "uint256" },
      { name: "voter", type: "address" },
    ],
    outputs: [{ name: "", type: "uint8" }],
  },
  {
    type: "function",
    name: "eligibleVoter",
    stateMutability: "view",
    inputs: [
      { name: "safe", type: "address" },
      { name: "id", type: "uint256" },
      { name: "voter", type: "address" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "vote",
    stateMutability: "nonpayable",
    inputs: [
      { name: "safe", type: "address" },
      { name: "id", type: "uint256" },
      { name: "choice", type: "uint8" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "execute",
    stateMutability: "nonpayable",
    inputs: [
      { name: "safe", type: "address" },
      { name: "id", type: "uint256" },
    ],
    outputs: [],
  },
  {
    type: "event",
    name: "ProposalExecuted",
    inputs: [
      { name: "safe", type: "address", indexed: true },
      { name: "id", type: "uint256", indexed: true },
      { name: "action", type: "uint8", indexed: false },
    ],
  },
] as const;

/** The ERC-20 slice dues need: balances, the allowance for the module, and approving it. */
export const erc20Abi = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

/** JfkModule's dues: paying in by hand, and what each member has paid and when. */
export const jfkDuesAbi = [
  {
    type: "function",
    name: "contribute",
    stateMutability: "nonpayable",
    inputs: [{ name: "safe", type: "address" }],
    outputs: [],
  },
  {
    type: "function",
    name: "paidIn",
    stateMutability: "view",
    inputs: [
      { name: "safe", type: "address" },
      { name: "member", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "lastPaidAt",
    stateMutability: "view",
    inputs: [
      { name: "safe", type: "address" },
      { name: "member", type: "address" },
    ],
    outputs: [{ name: "", type: "uint64" }],
  },
] as const;

/** JfkModule's money events, for a group's history. Each names the vault first, so one filter finds them all. */
export const jfkMoneyEventsAbi = [
  {
    type: "event",
    name: "Contributed",
    inputs: [
      { name: "safe", type: "address", indexed: true },
      { name: "member", type: "address", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "Paid",
    inputs: [
      { name: "safe", type: "address", indexed: true },
      { name: "recipient", type: "address", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "MemberRemoved",
    inputs: [
      { name: "safe", type: "address", indexed: true },
      { name: "member", type: "address", indexed: true },
      { name: "refund", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "GroupClosed",
    inputs: [
      { name: "safe", type: "address", indexed: true },
      { name: "distributed", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "ProposalExecuted",
    inputs: [
      { name: "safe", type: "address", indexed: true },
      { name: "id", type: "uint256", indexed: true },
      { name: "action", type: "uint8", indexed: false },
    ],
  },
] as const;

/** JfkModule's helpers, as automatic dues use them: name one with the collect power, take it away, read it, collect. */
export const jfkHelperAbi = [
  // Generated from the compiled contract: a helper casting its member's own vote.
  {
    type: "function",
    name: "voteFor",
    inputs: [
      {
        name: "safe",
        type: "address",
      },
      {
        name: "member",
        type: "address",
      },
      {
        name: "id",
        type: "uint256",
      },
      {
        name: "choice",
        type: "uint8",
      },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "setHelper",
    stateMutability: "nonpayable",
    inputs: [
      { name: "safe", type: "address" },
      { name: "key", type: "address" },
      { name: "powers", type: "uint8" },
      { name: "expiresAt", type: "uint64" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "revokeHelper",
    stateMutability: "nonpayable",
    inputs: [{ name: "safe", type: "address" }],
    outputs: [],
  },
  {
    type: "function",
    name: "getHelper",
    stateMutability: "view",
    inputs: [
      { name: "safe", type: "address" },
      { name: "member", type: "address" },
    ],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          { name: "key", type: "address" },
          { name: "powers", type: "uint8" },
          { name: "expiresAt", type: "uint64" },
        ],
      },
    ],
  },
  {
    type: "function",
    name: "collect",
    stateMutability: "nonpayable",
    inputs: [
      { name: "safe", type: "address" },
      { name: "member", type: "address" },
    ],
    outputs: [],
  },
] as const;

/** JfkModule's helper powers. Automatic dues only ever asks for COLLECT. */
export const HELPER_POWER = { PROPOSE: 1, VOTE: 2, COLLECT: 4 } as const;

/**
 * Contract v3: rotating savings. Generated from the compiled contract
 * (contracts/out) so it can't drift from what's deployed. The events are
 * RotationLib's, emitted from JfkModule's address.
 */
export const jfkRotationAbi = [
  {
    type: "function",
    name: "coverDebt",
    inputs: [
      {
        name: "safe",
        type: "address",
      },
      {
        name: "debtor",
        type: "address",
      },
      {
        name: "amount",
        type: "uint256",
      },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "debtOf",
    inputs: [
      {
        name: "safe",
        type: "address",
      },
      {
        name: "member",
        type: "address",
      },
    ],
    outputs: [
      {
        name: "",
        type: "uint256",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "getOrder",
    inputs: [
      {
        name: "safe",
        type: "address",
      },
    ],
    outputs: [
      {
        name: "order",
        type: "address[]",
      },
      {
        name: "joining",
        type: "address[]",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "getRotation",
    inputs: [
      {
        name: "safe",
        type: "address",
      },
    ],
    outputs: [
      {
        name: "on",
        type: "bool",
      },
      {
        name: "cycle",
        type: "uint32",
      },
      {
        name: "round",
        type: "uint32",
      },
      {
        name: "turn",
        type: "uint32",
      },
      {
        name: "nextPayoutAt",
        type: "uint64",
      },
      {
        name: "roundGap",
        type: "uint32",
      },
      {
        name: "grace",
        type: "uint32",
      },
      {
        name: "roundPot",
        type: "uint256",
      },
      {
        name: "pendingContribution",
        type: "uint256",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "payTurn",
    inputs: [
      {
        name: "safe",
        type: "address",
      },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "rotationStatus",
    inputs: [
      {
        name: "safe",
        type: "address",
      },
      {
        name: "member",
        type: "address",
      },
    ],
    outputs: [
      {
        name: "inOrder",
        type: "bool",
      },
      {
        name: "paidThisRound",
        type: "bool",
      },
      {
        name: "collected",
        type: "bool",
      },
      {
        name: "leaving",
        type: "bool",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "totalShort",
    inputs: [
      {
        name: "safe",
        type: "address",
      },
    ],
    outputs: [
      {
        name: "",
        type: "uint256",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "event",
    name: "CycleStarted",
    inputs: [
      {
        name: "safe",
        type: "address",
        indexed: true,
      },
      {
        name: "cycle",
        type: "uint32",
        indexed: false,
      },
      {
        name: "members",
        type: "uint256",
        indexed: false,
      },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "DebtRecorded",
    inputs: [
      {
        name: "safe",
        type: "address",
        indexed: true,
      },
      {
        name: "member",
        type: "address",
        indexed: true,
      },
      {
        name: "amount",
        type: "uint256",
        indexed: false,
      },
      {
        name: "round",
        type: "uint32",
        indexed: false,
      },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "DebtRepaid",
    inputs: [
      {
        name: "safe",
        type: "address",
        indexed: true,
      },
      {
        name: "debtor",
        type: "address",
        indexed: true,
      },
      {
        name: "creditor",
        type: "address",
        indexed: true,
      },
      {
        name: "amount",
        type: "uint256",
        indexed: false,
      },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "LeaveScheduled",
    inputs: [
      {
        name: "safe",
        type: "address",
        indexed: true,
      },
      {
        name: "member",
        type: "address",
        indexed: true,
      },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "MovedToBack",
    inputs: [
      {
        name: "safe",
        type: "address",
        indexed: true,
      },
      {
        name: "member",
        type: "address",
        indexed: true,
      },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "OrderChanged",
    inputs: [
      {
        name: "safe",
        type: "address",
        indexed: true,
      },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "RotationStarted",
    inputs: [
      {
        name: "safe",
        type: "address",
        indexed: true,
      },
      {
        name: "roundGap",
        type: "uint32",
        indexed: false,
      },
      {
        name: "grace",
        type: "uint32",
        indexed: false,
      },
      {
        name: "firstPayoutAt",
        type: "uint64",
        indexed: false,
      },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "TurnPaid",
    inputs: [
      {
        name: "safe",
        type: "address",
        indexed: true,
      },
      {
        name: "round",
        type: "uint32",
        indexed: false,
      },
      {
        name: "holder",
        type: "address",
        indexed: true,
      },
      {
        name: "paid",
        type: "uint256",
        indexed: false,
      },
      {
        name: "missing",
        type: "uint256",
        indexed: false,
      },
    ],
    anonymous: false,
  },
] as const;

/** JfkSetup v3: turns a new Safe into a rotating group. */
export const jfkRotatingSetupAbi = [
  {
    type: "function",
    name: "setupForRotatingGroup",
    inputs: [
      {
        name: "module",
        type: "address",
      },
      {
        name: "token",
        type: "address",
      },
      {
        name: "contribution",
        type: "uint256",
      },
      {
        name: "thresholds",
        type: "uint16[9]",
      },
      {
        name: "quorumPct",
        type: "uint8",
      },
      {
        name: "votingPeriod",
        type: "uint32",
      },
      {
        name: "payGap",
        type: "uint32",
      },
      {
        name: "roundGap",
        type: "uint32",
      },
      {
        name: "grace",
        type: "uint32",
      },
      {
        name: "firstPayoutAt",
        type: "uint64",
      },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
] as const;

/** Contract v3's new vote: rearrange who still has to collect (rotating groups). */
export const CHANGE_ORDER_ACTION = 8;
