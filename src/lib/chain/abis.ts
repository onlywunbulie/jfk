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
    ],
    outputs: [],
  },
] as const;

export const jfkModuleAbi = [
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
] as const;
