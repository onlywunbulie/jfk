import { createConfig, http, injected } from "wagmi";
import { baseAccount } from "wagmi/connectors";
import { chain } from "./addresses";

/**
 * The browser's connection to Base.
 *
 * The real way in is the Base Account (Coinbase Smart Wallet), secured by a
 * passkey. No seed phrase, no browser extension. Members confirm with
 * whatever unlocks their device: Face ID, a fingerprint, a PIN or their phone.
 *
 * On the test network only, a browser wallet such as MetaMask is offered too.
 * Coinbase currently refuses to send anything on Base Sepolia for newer Base
 * Accounts (base/account-sdk#363), so testing needs another way to sign.
 * It never appears on mainnet.
 */
export const TEST_WALLET_ENABLED = chain.testnet === true;

export const BASE_ACCOUNT_ID = "baseAccount";
export const TEST_WALLET_ID = "injected";

export const wagmiConfig = createConfig({
  chains: [chain],
  connectors: [
    // Telemetry off: members' activity isn't reported to Coinbase's analytics.
    baseAccount({ appName: "Rallied", preference: { telemetry: false } }),
    ...(TEST_WALLET_ENABLED ? [injected({ shimDisconnect: true })] : []),
  ],
  transports: { [chain.id]: http() },
  ssr: true,
});

declare module "wagmi" {
  interface Register {
    config: typeof wagmiConfig;
  }
}
