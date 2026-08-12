import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const src = fileURLToPath(new URL("./src", import.meta.url));

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/.next/**"],
    setupFiles: ["./src/test/setup.ts"],

    /**
     * Each DB-backed suite boots its own WASM Postgres, which costs far more
     * memory than a normal test file. Left to its own devices Vitest runs
     * several at once and a worker gets OOM-killed.
     *
     * One fork at a time, one file at a time: the process exits between files
     * so the WASM heap is genuinely reclaimed rather than accumulating.
     */
    pool: "forks",
    poolOptions: { forks: { minForks: 1, maxForks: 1 } },
    fileParallelism: false,

    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
  resolve: {
    alias: {
      "@": src,
      "server-only": `${src}/test/server-only-stub.ts`,
    },
  },
});
