import { createConfig, http } from "wagmi";
import { baseAccount } from "wagmi/connectors";
import { chain } from "./addresses";

/**
 * The browser's connection to Base.
 *
 * One wallet only: the Base Account (Coinbase Smart Wallet), secured by a
 * passkey. No seed phrase, no browser extension. Members confirm with Face
 * ID, a fingerprint or their device's screen lock.
 */
export const wagmiConfig = createConfig({
  chains: [chain],
  connectors: [baseAccount({ appName: "JFK" })],
  transports: { [chain.id]: http() },
  ssr: true,
});

declare module "wagmi" {
  interface Register {
    config: typeof wagmiConfig;
  }
}
