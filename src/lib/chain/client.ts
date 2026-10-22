import "server-only";
import { createPublicClient, http, type PublicClient } from "viem";
import { env } from "@/lib/env";
import { chain } from "./addresses";

let client: PublicClient | undefined;

/**
 * Read-only access to Base from the server. Created on first use, not at
 * module load, because `next build` imports every module (see AGENTS.md).
 */
export function publicClient(): PublicClient {
  client ??= createPublicClient({
    chain,
    transport: http(env().BASE_RPC_URL),
  }) as PublicClient;
  return client;
}
