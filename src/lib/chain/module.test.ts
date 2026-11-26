import { describe, expect, it, vi } from "vitest";
import { CONTRACTS } from "@/lib/chain/addresses";

vi.mock("server-only", () => ({}));

// Which modules each fake vault has switched on.
const enabled = new Map<string, string[]>([
  ["0x00000000000000000000000000000000000000a4", [CONTRACTS.jfkModule]],
  ["0x00000000000000000000000000000000000000a3", [CONTRACTS.jfkModuleV3]],
  ["0x00000000000000000000000000000000000000a2", [CONTRACTS.jfkModuleV2]],
  ["0x00000000000000000000000000000000000000a1", []],
]);
vi.mock("@/lib/chain/client", () => ({
  publicClient: () => ({
    readContract: async ({ address, args }: { address: string; args: [string] }) =>
      (enabled.get(address.toLowerCase()) ?? []).includes(args[0]),
  }),
}));

const { moduleFor } = await import("@/lib/chain/module");

describe("which Rallied contract runs a vault", () => {
  it("finds v4 for a group started from now on", async () => {
    expect(await moduleFor("0x00000000000000000000000000000000000000A4")).toEqual({ address: CONTRACTS.jfkModule, version: 4 });
  });

  it("finds v3 for a group started from 20 to 26 November", async () => {
    expect(await moduleFor("0x00000000000000000000000000000000000000A3")).toEqual({ address: CONTRACTS.jfkModuleV3, version: 3 });
  });

  it("finds v2 for a group started before", async () => {
    expect(await moduleFor("0x00000000000000000000000000000000000000A2")).toEqual({ address: CONTRACTS.jfkModuleV2, version: 2 });
  });

  it("finds nothing for a vault on neither (a v1 group)", async () => {
    expect(await moduleFor("0x00000000000000000000000000000000000000A1")).toBeNull();
  });
});
