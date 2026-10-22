import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { CONTRACTS, chain, shortAddress } from "./addresses";

describe("on-chain addresses", () => {
  it("match the deployment record the contract scripts wrote", () => {
    const deployment = JSON.parse(
      readFileSync("contracts/deployments/base-sepolia.json", "utf8"),
    );

    expect(chain.id).toBe(deployment.chainId);
    expect(CONTRACTS.jfkModule).toBe(deployment.contracts.JfkModule);
    expect(CONTRACTS.jfkSetup).toBe(deployment.contracts.JfkSetup);
    expect(CONTRACTS.safeL2Singleton).toBe(deployment.dependencies.SafeL2_v1_4_1);
    expect(CONTRACTS.safeProxyFactory).toBe(deployment.dependencies.SafeProxyFactory_v1_4_1);
    expect(CONTRACTS.usdc).toBe(deployment.dependencies.USDC);
  });

  it("shortens an address for display", () => {
    expect(shortAddress("0x4596A149Ac1D950Ba229b208445Dcb51Fc84182b")).toBe("0x4596…182b");
  });
});
